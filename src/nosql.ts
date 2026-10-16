/**
 * MongoDB and Redis for the SQL editor, run the way the panel runs SQL: a script of commands, each giving a table of
 * rows. MongoDB takes mongosh-style commands (`db.users.find({ age: { $gt: 30 } }).sort({ name: 1 })`), read by a parser
 * here: nothing is ever run as JavaScript. Redis takes its own commands, one per line (`HGETALL user:1`).
 *
 * Neither database has a read-only transaction to lean on, so read-only is decided here, command by command: MongoDB
 * runs only find/aggregate/count/distinct (aggregate without $out or $merge), Redis only the commands on a list of those
 * that read. A database user that may only read (a MongoDB `read` role, a Redis ACL user without write commands) is the
 * real limit.
 */
import { Binary, BSON, BSONRegExp, Decimal128, Double, Int32, Long, MinKey, MaxKey, MongoClient, ObjectId, Timestamp, UUID } from 'mongodb';
import { Redis } from 'ioredis';
import type { DbConnection, QueryResult, RunOpts, SchemaInfo, SchemaTable } from './databases.js';

const { EJSON } = BSON;

const CONNECT_TIMEOUT_MS = 10_000;

/** An error the panel shows as is; `readOnlyRefusal`: refused because the run was read-only (it writes). */
function refuse(message: string, readOnlyRefusal = false): Error {
  return Object.assign(new Error(message), { readOnlyRefusal });
}

// ---------- reading mongosh's JavaScript literals (without running them) ----------

const IDENT = /[A-Za-z_$][\w$]*/y;

/** A reader of one command: values are JSON-like with mongosh's extras (unquoted keys, ObjectId(...), /regex/, ...). */
class Reader {
  i = 0;
  constructor(readonly s: string) {}

  fail(what: string): never {
    const near = this.s.slice(this.i, this.i + 30).replace(/\s+/g, ' ');
    throw refuse(`cannot read the command: ${what}${near ? ` near "${near}"` : ' at its end'}`);
  }

  skip(): void {
    for (;;) {
      while (this.i < this.s.length && /\s/.test(this.s[this.i]!)) this.i++;
      if (this.s.startsWith('//', this.i)) { const nl = this.s.indexOf('\n', this.i); this.i = nl < 0 ? this.s.length : nl; continue; }
      if (this.s.startsWith('/*', this.i)) { const end = this.s.indexOf('*/', this.i + 2); this.i = end < 0 ? this.s.length : end + 2; continue; }
      return;
    }
  }

  peek(): string { this.skip(); return this.s[this.i] ?? ''; }
  eat(ch: string): boolean { if (this.peek() === ch) { this.i++; return true; } return false; }
  expect(ch: string): void { if (!this.eat(ch)) this.fail(`expected ${ch}`); }
  done(): boolean { return this.peek() === ''; }

  ident(): string | null {
    this.skip();
    IDENT.lastIndex = this.i;
    const m = IDENT.exec(this.s);
    if (!m) return null;
    this.i += m[0].length;
    return m[0];
  }

  string(): string {
    const q = this.s[this.i]!;
    let out = '';
    this.i++;
    while (this.i < this.s.length && this.s[this.i] !== q) {
      const ch = this.s[this.i++]!;
      if (ch !== '\\') { out += ch; continue; }
      const e = this.s[this.i++] ?? '';
      const simple: Record<string, string> = { n: '\n', t: '\t', r: '\r', b: '\b', f: '\f', v: '\v', 0: '\0' };
      if (e in simple) out += simple[e];
      else if (e === 'u') { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 4), 16)); this.i += 4; }
      else if (e === 'x') { out += String.fromCharCode(parseInt(this.s.slice(this.i, this.i + 2), 16)); this.i += 2; }
      else out += e;
    }
    if (this.s[this.i] !== q) this.fail('a string is not closed');
    this.i++;
    return out;
  }

  /** The arguments of a call, after its "(": values up to ")". */
  args(): unknown[] {
    const out: unknown[] = [];
    while (!this.eat(')')) {
      out.push(this.value());
      if (!this.eat(',')) { this.expect(')'); break; }
    }
    return out;
  }

  value(): unknown {
    const ch = this.peek();
    if (ch === '{') return this.object();
    if (ch === '[') {
      this.i++;
      const out: unknown[] = [];
      while (!this.eat(']')) { out.push(this.value()); if (!this.eat(',')) { this.expect(']'); break; } }
      return out;
    }
    if (ch === '"' || ch === '\'') return this.string();
    if (ch === '/') return this.regex();
    if (/[-+\d.]/.test(ch)) return this.number();
    const word = this.ident();
    if (!word) this.fail('expected a value');
    if (word === 'true') return true;
    if (word === 'false') return false;
    if (word === 'null') return null;
    if (word === 'undefined') return undefined;
    if (word === 'NaN') return NaN;
    if (word === 'Infinity') return Infinity;
    if (word === 'MinKey') { if (this.eat('(')) this.expect(')'); return new MinKey(); }
    if (word === 'MaxKey') { if (this.eat('(')) this.expect(')'); return new MaxKey(); }
    const name = word === 'new' ? this.ident() ?? this.fail('expected a type after new') : word;
    if (!this.eat('(')) this.fail(`${name} is not a value here (variables and expressions are not run)`);
    return this.construct(name, this.args(), word === 'new');
  }

  object(): Record<string, unknown> {
    this.expect('{');
    const out: Record<string, unknown> = {};
    while (!this.eat('}')) {
      const ch = this.peek();
      const key = ch === '"' || ch === '\'' ? this.string() : /[-\d]/.test(ch) ? String(this.number()) : this.ident() ?? this.fail('expected a key');
      this.expect(':');
      out[key] = this.value();
      if (!this.eat(',')) { this.expect('}'); break; }
    }
    return out;
  }

  number(): number {
    this.skip();
    const m = /^[-+]?(?:0x[\da-f]+|(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?|Infinity)/i.exec(this.s.slice(this.i));
    if (!m) this.fail('expected a number');
    this.i += m[0].length;
    return Number(m[0]);
  }

  regex(): BSONRegExp {
    let j = this.i + 1;
    let inClass = false;
    while (j < this.s.length) {
      const ch = this.s[j]!;
      if (ch === '\\') { j += 2; continue; }
      if (ch === '[') inClass = true;
      else if (ch === ']') inClass = false;
      else if (ch === '/' && !inClass) break;
      j++;
    }
    if (j >= this.s.length) this.fail('a regular expression is not closed');
    const pattern = this.s.slice(this.i + 1, j);
    const flags = /^[a-z]*/i.exec(this.s.slice(j + 1))![0];
    this.i = j + 1 + flags.length;
    return new BSONRegExp(pattern, flags);
  }

  /** mongosh's type helpers, as the BSON values they make. */
  construct(name: string, a: unknown[], withNew: boolean): unknown {
    const str = (i = 0) => (a[i] === undefined ? undefined : String(a[i]));
    switch (name) {
      case 'ObjectId': case 'ObjectID': return a.length ? new ObjectId(str()) : new ObjectId();
      case 'ISODate': return a.length ? new Date(str()!) : new Date();
      case 'Date': if (!withNew) return new Date().toString(); return a.length ? new Date(a[0] as string | number) : new Date();
      case 'NumberLong': return Long.fromString(str() ?? '0');
      case 'NumberInt': return new Int32(Number(a[0] ?? 0));
      case 'NumberDecimal': case 'Decimal128': return Decimal128.fromString(str() ?? '0');
      case 'Double': return new Double(Number(a[0] ?? 0));
      case 'UUID': return a.length ? new UUID(str()) : new UUID();
      case 'Timestamp': {
        const t = a[0] && typeof a[0] === 'object' ? a[0] as { t: number; i: number } : { t: Number(a[0] ?? 0), i: Number(a[1] ?? 0) };
        return new Timestamp({ t: t.t, i: t.i });
      }
      case 'BinData': return new Binary(Buffer.from(String(a[1] ?? ''), 'base64'), Number(a[0] ?? 0));
      case 'RegExp': return new BSONRegExp(str() ?? '', str(1) ?? '');
      default: return this.fail(`${name}(...) is not known here`);
    }
  }
}

/** A collection's (or the database's) method calls, in order: db.users.find({...}).sort({...}).limit(5). */
export interface MongoCommand { kind: 'db' | 'collection' | 'show'; collection?: string; calls: { name: string; args: unknown[] }[]; show?: string }

/** Reads one mongosh-style command; throws (with what it could not read) for anything else. */
export function parseMongo(text: string): MongoCommand {
  const src = text.trim().replace(/;\s*$/, '');
  const show = /^show\s+(dbs|databases|collections|tables)$/i.exec(src);
  if (show) return { kind: 'show', show: show[1]!.toLowerCase(), calls: [] };
  if (/^use\s+/i.test(src)) throw refuse('pick the database in the console\'s database list instead of `use`');
  const r = new Reader(src);
  if (r.ident() !== 'db') r.fail('a command starts with db. (or show dbs / show collections)');
  let collection: string | undefined;
  const calls: MongoCommand['calls'] = [];
  // db.<name>... : the names up to the first call are the collection (db.a.b.find() is collection "a.b"), unless the
  // first name is itself called: then it is a method of the database (db.getCollectionNames()).
  const path: string[] = [];
  for (;;) {
    if (r.eat('[')) { path.push(String(r.value())); r.expect(']'); continue; }
    if (!r.eat('.')) break;
    const name = r.ident() ?? r.fail('expected a name after .');
    if (r.peek() === '(') {
      r.i++;
      const args = r.args();
      if (!path.length && name === 'getCollection') { path.push(String(args[0])); continue; }
      if (!path.length && !collection) { calls.push({ name, args }); break; }
      collection = path.join('.');
      calls.push({ name, args });
      break;
    }
    path.push(name);
  }
  // .sort(...).limit(...) and the like, after the first call.
  while (r.eat('.')) {
    const name = r.ident() ?? r.fail('expected a method after .');
    r.expect('(');
    calls.push({ name, args: r.args() });
  }
  if (!r.done()) r.fail('unexpected text');
  if (!calls.length) r.fail('expected a method call, as in db.users.find()');
  return collection ? { kind: 'collection', collection, calls } : { kind: 'db', calls };
}

// ---------- MongoDB ----------

const MONGO_READS = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'estimatedDocumentCount', 'count', 'distinct', 'getIndexes', 'indexes', 'stats']);
const MONGO_WRITES = new Set(['insertOne', 'insertMany', 'insert', 'updateOne', 'updateMany', 'update', 'replaceOne', 'deleteOne', 'deleteMany', 'remove',
  'findOneAndUpdate', 'findOneAndReplace', 'findOneAndDelete', 'drop', 'createIndex', 'createIndexes', 'dropIndex', 'dropIndexes', 'renameCollection', 'bulkWrite']);
const CURSOR_STEPS = new Set(['sort', 'skip', 'limit', 'project', 'projection', 'hint', 'collation', 'maxTimeMS', 'comment', 'batchSize', 'toArray', 'pretty', 'count', 'readPref', 'allowDiskUse']);
const DB_READS = new Set(['getCollectionNames', 'getCollectionInfos', 'stats', 'getName', 'version', 'serverStatus', 'hostInfo']);
const DB_WRITES = new Set(['createCollection', 'dropDatabase', 'createView']);

const isMongoUri = (s: string) => /^mongodb(\+srv)?:\/\//i.test(s);

function mongoClient(c: DbConnection, timeoutMs: number): MongoClient {
  // Through an SSH tunnel the server is 127.0.0.1: its certificate is still checked, but not against that name, and the
  // driver talks to that one server rather than looking for the others of a replica set (it could not reach them).
  const tls = c.ssl === 'disable' ? {} : { tls: true, tlsAllowInvalidCertificates: c.ssl !== 'verify-full', ...(c.tunneledFrom && { tlsAllowInvalidHostnames: true }) };
  const auth = c.user ? { auth: { username: c.user, password: c.password || undefined } } : {};
  const uri = isMongoUri(c.host) ? c.host : `mongodb://${c.host.includes(':') && !c.host.startsWith('[') ? `[${c.host}]` : c.host}:${c.port || 27017}/`;
  return new MongoClient(uri, {
    ...tls, ...auth, appName: 'dalang', serverSelectionTimeoutMS: CONNECT_TIMEOUT_MS, connectTimeoutMS: CONNECT_TIMEOUT_MS,
    socketTimeoutMS: timeoutMs + 5000, maxPoolSize: 2, ...(c.tunneledFrom && { directConnection: true }),
  });
}

/** A BSON value as the grid shows it: ids as hex, dates as ISO, numbers as numbers (big ones as text), the rest as JSON. */
function mongoCell(v: unknown, maxCell: number): unknown {
  let out: unknown = v;
  if (v === null || v === undefined) return null;
  if (v instanceof ObjectId) out = v.toHexString();
  else if (v instanceof Date) out = Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  else if (v instanceof Long || v instanceof Decimal128) out = v.toString();
  else if (v instanceof Int32 || v instanceof Double) out = v.valueOf();
  else if (typeof v === 'object') out = JSON.stringify(EJSON.serialize(v, { relaxed: true }));
  return typeof out === 'string' && out.length > maxCell ? `${out.slice(0, maxCell)}…` : out;
}

const bsonType = (v: unknown): string => (v === null || v === undefined ? '' : v instanceof ObjectId ? 'objectId' : v instanceof Date ? 'date'
  : Array.isArray(v) ? 'array' : v instanceof Long ? 'long' : v instanceof Decimal128 ? 'decimal' : typeof v === 'object' ? 'object'
    : typeof v === 'number' ? (Number.isInteger(v) ? 'int' : 'double') : typeof v === 'boolean' ? 'bool' : 'string');

/** Documents as a table: a column per top-level field (in the order they first appear), a row per document. */
function documentsTable(sql: string, docs: Record<string, unknown>[], o: RunOpts, ms: number, truncated: boolean): QueryResult {
  const names: string[] = [];
  const types = new Map<string, string>();
  for (const d of docs) for (const [k, v] of Object.entries(d)) { if (!types.has(k)) { names.push(k); types.set(k, ''); } if (!types.get(k)) types.set(k, bsonType(v)); }
  const cols = names.slice(0, 300);
  return {
    sql, columns: cols.map((n) => ({ name: n, type: types.get(n) ?? '' })), affected: null, truncated, ms,
    rows: docs.map((d) => cols.map((n) => (n in d ? mongoCell(d[n], o.maxCell ?? 20_000) : null))),
  };
}

const valueTable = (sql: string, column: string, values: unknown[], o: RunOpts, ms: number): QueryResult => ({
  sql, columns: [{ name: column, type: bsonType(values.find((v) => v != null)) }], rows: values.map((v) => [mongoCell(v, o.maxCell ?? 20_000)]),
  affected: null, truncated: false, ms,
});
const writeResult = (sql: string, affected: number, ms: number, note?: string): QueryResult => ({ sql, columns: [], rows: [], affected, truncated: false, ms, ...(note && { note }) });

/** What an aggregate pipeline writes ($out, $merge), if anything. */
export const pipelineWrites = (pipeline: unknown) => Array.isArray(pipeline) && pipeline.some((s) => s && typeof s === 'object' && ('$out' in s || '$merge' in s));
/** An aggregate's pipeline and options: `aggregate([stages], options)`, or mongosh's `aggregate(stage, stage, ...)`. */
export const aggregateArgs = (a: unknown[]): { pipeline: object[]; options: object } => Array.isArray(a[0])
  ? { pipeline: [...a[0]], options: a[1] && typeof a[1] === 'object' && !Array.isArray(a[1]) ? a[1] : {} }
  : { pipeline: a.filter((x): x is object => !!x && typeof x === 'object'), options: {} };

async function mongoStatement(client: MongoClient, c: DbConnection, sql: string, o: RunOpts): Promise<QueryResult> {
  const cmd = parseMongo(sql);
  const t0 = Date.now();
  const ms = () => Date.now() - t0;
  const maxCell = o.maxCell ?? 20_000;
  if (cmd.kind === 'show') {
    if (cmd.show === 'dbs' || cmd.show === 'databases') {
      const r = await client.db('admin').admin().listDatabases({ nameOnly: false });
      return documentsTable(sql, r.databases.map((d) => ({ name: d.name, sizeOnDisk: d.sizeOnDisk, empty: d.empty })), o, ms(), false);
    }
    cmd.kind = 'db';
    cmd.calls = [{ name: 'getCollectionNames', args: [] }];
  }
  if (!c.database) throw refuse('pick a database in the console\'s database list first (or write show dbs)');
  const db = client.db(c.database);
  if (cmd.kind === 'db') {
    const [{ name, args }] = cmd.calls as [{ name: string; args: unknown[] }];
    if (DB_WRITES.has(name) && o.readOnly) throw refuse(`db.${name}() writes, and this run is read-only`, true);
    switch (name) {
      case 'getCollectionNames': return valueTable(sql, 'name', (await db.listCollections({}, { nameOnly: true }).toArray()).map((x) => x.name).sort(), o, ms());
      case 'getCollectionInfos': return documentsTable(sql, await db.listCollections((args[0] ?? {}) as object).toArray() as Record<string, unknown>[], o, ms(), false);
      case 'stats': return documentsTable(sql, [await db.command({ dbStats: 1 })], o, ms(), false);
      case 'getName': return valueTable(sql, 'name', [db.databaseName], o, ms());
      case 'version': return valueTable(sql, 'version', [(await db.admin().command({ buildInfo: 1 })).version], o, ms());
      case 'serverStatus': return documentsTable(sql, [await db.admin().command({ serverStatus: 1 })], o, ms(), false);
      case 'hostInfo': return documentsTable(sql, [await db.admin().command({ hostInfo: 1 })], o, ms(), false);
      case 'createCollection': await db.createCollection(String(args[0]), (args[1] ?? {}) as object); return writeResult(sql, 0, ms(), `created ${String(args[0])}`);
      case 'createView': await db.createCollection(String(args[0]), { viewOn: String(args[1]), pipeline: args[2] as object[] }); return writeResult(sql, 0, ms(), `created view ${String(args[0])}`);
      case 'dropDatabase': await db.dropDatabase(); return writeResult(sql, 0, ms(), `dropped ${db.databaseName}`);
      default: throw refuse(`db.${name}() is not supported here (known: ${[...DB_READS, ...DB_WRITES].join(', ')})`);
    }
  }
  const coll = db.collection(cmd.collection!);
  const [first, ...steps] = cmd.calls as [{ name: string; args: any[] }, ...{ name: string; args: any[] }[]];
  const a = first.args;
  if (!MONGO_READS.has(first.name) && !MONGO_WRITES.has(first.name)) {
    throw refuse(`.${first.name}() is not supported here (reads: ${[...MONGO_READS].join(', ')}; writes: ${[...MONGO_WRITES].join(', ')})`);
  }
  if (o.readOnly && (MONGO_WRITES.has(first.name) || (first.name === 'aggregate' && pipelineWrites(aggregateArgs(a).pipeline)))) {
    throw refuse(`${first.name === 'aggregate' ? 'an aggregate with $out or $merge' : `.${first.name}()`} writes, and this run is read-only`, true);
  }
  for (const s of steps) if (!CURSOR_STEPS.has(s.name)) throw refuse(`.${s.name}() after .${first.name}() is not supported here`);
  if (steps.length && first.name !== 'find' && first.name !== 'aggregate') throw refuse(`.${steps[0]!.name}() only follows find() or aggregate()`);
  switch (first.name) {
    case 'find': {
      if (steps.some((s) => s.name === 'count')) return valueTable(sql, 'count', [await coll.countDocuments(a[0] ?? {}, { maxTimeMS: o.timeoutMs })], o, ms());
      let cursor = coll.find(a[0] ?? {}, { ...(a[1] && { projection: a[1] }), maxTimeMS: o.timeoutMs });
      let limit = 0;
      for (const s of steps) {
        if (s.name === 'sort') cursor = cursor.sort(s.args[0]);
        else if (s.name === 'skip') cursor = cursor.skip(Number(s.args[0]));
        else if (s.name === 'limit') limit = Math.abs(Number(s.args[0]));
        else if (s.name === 'project' || s.name === 'projection') cursor = cursor.project(s.args[0]);
        else if (s.name === 'hint') cursor = cursor.hint(s.args[0]);
        else if (s.name === 'collation') cursor = cursor.collation(s.args[0]);
        else if (s.name === 'comment') cursor = cursor.comment(s.args[0]);
        else if (s.name === 'maxTimeMS') cursor = cursor.maxTimeMS(Math.min(Number(s.args[0]), o.timeoutMs));
        else if (s.name === 'allowDiskUse') cursor = cursor.allowDiskUse();
      }
      // At most the row limit, plus one to tell that there was more.
      const docs = await cursor.limit(limit && limit <= o.limit ? limit : o.limit + 1).toArray();
      return documentsTable(sql, docs.slice(0, o.limit), o, ms(), docs.length > o.limit);
    }
    case 'findOne': {
      const doc = await coll.findOne(a[0] ?? {}, { ...(a[1] && { projection: a[1] }), maxTimeMS: o.timeoutMs });
      return documentsTable(sql, doc ? [doc] : [], o, ms(), false);
    }
    case 'aggregate': {
      const { pipeline, options } = aggregateArgs(a);
      const writes = pipelineWrites(pipeline);
      if (!writes) pipeline.push({ $limit: o.limit + 1 });
      const docs = await coll.aggregate(pipeline, { ...options, maxTimeMS: o.timeoutMs }).toArray();
      if (writes) return writeResult(sql, 0, ms(), 'the pipeline wrote its output');
      return documentsTable(sql, docs.slice(0, o.limit), o, ms(), docs.length > o.limit);
    }
    case 'countDocuments': case 'count': return valueTable(sql, 'count', [await coll.countDocuments(a[0] ?? {}, { maxTimeMS: o.timeoutMs })], o, ms());
    case 'estimatedDocumentCount': return valueTable(sql, 'count', [await coll.estimatedDocumentCount({ maxTimeMS: o.timeoutMs })], o, ms());
    case 'distinct': {
      const values = await coll.distinct(String(a[0]), a[1] ?? {}, { maxTimeMS: o.timeoutMs });
      return { ...valueTable(sql, String(a[0]), values.slice(0, o.limit), o, ms()), truncated: values.length > o.limit };
    }
    case 'getIndexes': case 'indexes': return documentsTable(sql, await coll.indexes() as Record<string, unknown>[], o, ms(), false);
    case 'stats': return documentsTable(sql, [await db.command({ collStats: coll.collectionName })], o, ms(), false);
    case 'insertOne': { const r = await coll.insertOne(a[0]); return writeResult(sql, 1, ms(), `inserted _id ${mongoCell(r.insertedId, maxCell)}`); }
    case 'insertMany': case 'insert': {
      const docs = Array.isArray(a[0]) ? a[0] : [a[0]];
      const r = await coll.insertMany(docs, a[1] ?? {});
      return writeResult(sql, r.insertedCount, ms());
    }
    case 'updateOne': case 'updateMany': case 'update': {
      const many = first.name === 'updateMany' || (first.name === 'update' && a[2]?.multi);
      const r = many ? await coll.updateMany(a[0] ?? {}, a[1], a[2] ?? {}) : await coll.updateOne(a[0] ?? {}, a[1], a[2] ?? {});
      return writeResult(sql, r.modifiedCount, ms(), `${r.matchedCount} matched${r.upsertedCount ? `, ${r.upsertedCount} upserted` : ''}`);
    }
    case 'replaceOne': { const r = await coll.replaceOne(a[0] ?? {}, a[1], a[2] ?? {}); return writeResult(sql, r.modifiedCount, ms(), `${r.matchedCount} matched`); }
    case 'deleteOne': return writeResult(sql, (await coll.deleteOne(a[0] ?? {})).deletedCount, ms());
    case 'deleteMany': case 'remove': return writeResult(sql, (await coll.deleteMany(a[0] ?? {})).deletedCount, ms());
    case 'findOneAndUpdate': case 'findOneAndReplace': case 'findOneAndDelete': {
      const opts = { ...(first.name === 'findOneAndDelete' ? a[1] : a[2]) ?? {}, includeResultMetadata: false };
      const doc = first.name === 'findOneAndUpdate' ? await coll.findOneAndUpdate(a[0] ?? {}, a[1], opts)
        : first.name === 'findOneAndReplace' ? await coll.findOneAndReplace(a[0] ?? {}, a[1], opts) : await coll.findOneAndDelete(a[0] ?? {}, opts);
      return documentsTable(sql, doc ? [doc as unknown as Record<string, unknown>] : [], o, ms(), false);
    }
    case 'drop': await coll.drop(); return writeResult(sql, 0, ms(), `dropped ${coll.collectionName}`);
    case 'createIndex': return writeResult(sql, 0, ms(), `index ${await coll.createIndex(a[0], a[1] ?? {})}`);
    case 'createIndexes': return writeResult(sql, 0, ms(), `indexes ${(await coll.createIndexes(a[0], a[1] ?? {})).join(', ')}`);
    case 'dropIndex': await coll.dropIndex(a[0]); return writeResult(sql, 0, ms(), 'index dropped');
    case 'dropIndexes': await coll.dropIndexes(); return writeResult(sql, 0, ms(), 'indexes dropped');
    case 'renameCollection': await coll.rename(String(a[0]), a[1] ?? {}); return writeResult(sql, 0, ms(), `renamed to ${String(a[0])}`);
    case 'bulkWrite': { const r = await coll.bulkWrite(a[0], a[1] ?? {}); return writeResult(sql, r.insertedCount + r.modifiedCount + r.deletedCount + r.upsertedCount, ms()); }
    default: throw refuse(`.${first.name}() is not supported here`);
  }
}

/** Runs a script of mongosh-style commands; a failure carries the results before it (`partial`). */
export async function mongoScript(c: DbConnection, statements: string[], o: RunOpts): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  const client = mongoClient(c, o.timeoutMs);
  const stop = () => { void client.close(true).catch(() => {}); };
  o.signal?.addEventListener('abort', stop, { once: true });
  try {
    await client.connect();
    for (const sql of statements) {
      if (o.signal?.aborted) throw new Error('cancelled');
      results.push(await mongoStatement(client, c, sql, o));
    }
    return results;
  } catch (e) { throw Object.assign(e as Error, { partial: results }); } finally {
    o.signal?.removeEventListener('abort', stop);
    await client.close().catch(() => {});
  }
}

const SAMPLE = 20;
/** Collection fields from a sample of documents: name and the type seen first. */
async function sampleFields(coll: ReturnType<ReturnType<MongoClient['db']>['collection']>, timeoutMs: number): Promise<SchemaTable['columns']> {
  const docs = await coll.find({}, { limit: SAMPLE, maxTimeMS: timeoutMs }).toArray();
  const seen = new Map<string, string>();
  for (const d of docs) for (const [k, v] of Object.entries(d)) if (!seen.get(k)) seen.set(k, bsonType(v));
  return [...seen].map(([name, type]) => ({ name, type, nullable: true, pk: name === '_id' }));
}

/** Databases (as schemas), their collections and views (as tables), and fields read from a sample of documents. */
export async function mongoSchema(c: DbConnection, timeoutMs: number, only?: string, inline = 40): Promise<SchemaInfo> {
  const client = mongoClient(c, timeoutMs);
  try {
    await client.connect();
    const names = only ? [only] : c.database ? [c.database]
      : (await client.db('admin').admin().listDatabases({ nameOnly: true })).databases.map((d) => d.name).filter((n) => !['admin', 'local', 'config'].includes(n));
    const schemas = [];
    let total = 0;
    const lists = await Promise.all(names.map(async (name) => ({ name, colls: (await client.db(name).listCollections({}, { nameOnly: false }).toArray()).filter((x) => !x.name.startsWith('system.')).sort((x, y) => x.name.localeCompare(y.name)) })));
    for (const l of lists) total += l.colls.length;
    for (const { name, colls } of lists) {
      const withFields = !!only || total <= inline;
      const tables: SchemaTable[] = [];
      for (const x of colls) {
        const view = x.type === 'view';
        tables.push({ name: x.name, kind: view ? 'view' : 'table', columns: withFields ? await sampleFields(client.db(name).collection(x.name), timeoutMs).catch(() => []) : [] });
      }
      schemas.push({ name, loaded: withFields, tables });
    }
    return { schemas };
  } finally { await client.close().catch(() => {}); }
}

/** The server's version, and what about its user deserves a warning (roles that reach every database or the server). */
export async function mongoTest(c: DbConnection): Promise<{ version: string; warnings: string[] }> {
  const client = mongoClient(c, 15_000);
  try {
    await client.connect();
    const admin = client.db('admin');
    const { version } = await admin.command({ buildInfo: 1 });
    const warnings: string[] = [];
    try {
      const st = await admin.command({ connectionStatus: 1 });
      const users = st.authInfo?.authenticatedUsers ?? [];
      const roles: { role: string; db: string }[] = st.authInfo?.authenticatedUserRoles ?? [];
      const strong = roles.filter((r) => ['root', '__system', 'clusterAdmin', 'dbAdminAnyDatabase', 'readWriteAnyDatabase', 'userAdminAnyDatabase', 'restore', 'dbOwner', 'userAdmin'].includes(r.role));
      if (!users.length) warnings.push('No user signed in: on this server anyone connecting this way may read and change everything. Read-only here is only what Dalang lets through.');
      else if (strong.length) warnings.push(`This user has ${strong.map((r) => `${r.role}@${r.db}`).join(', ')}: it may change data, users or the server beyond reading. Read-only here is only what Dalang lets through; a user with the read role is the real limit.`);
    } catch { /* no warning without connectionStatus */ }
    return { version: `MongoDB ${version}`, warnings };
  } finally { await client.close().catch(() => {}); }
}

/** A collection's options and indexes, as JSON (MongoDB has no DDL). */
export async function mongoDdl(c: DbConnection, schema: string, name: string): Promise<string> {
  const client = mongoClient(c, 15_000);
  try {
    await client.connect();
    const db = client.db(schema);
    const [info] = await db.listCollections({ name }).toArray();
    if (!info) throw refuse(`no such collection: ${schema}.${name}`);
    const indexes = info.type === 'view' ? [] : await db.collection(name).indexes();
    return `// ${schema}.${name}\n${JSON.stringify(EJSON.serialize({ type: info.type, options: (info as { options?: unknown }).options, indexes }, { relaxed: true }), null, 2)}\n`;
  } finally { await client.close().catch(() => {}); }
}

// ---------- Redis ----------

/** A command line split the way redis-cli does: words, "double quoted" (with \n, \", \xHH) or 'single quoted'. */
export function redisWords(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  while (i < line.length) {
    while (i < line.length && /\s/.test(line[i]!)) i++;
    if (i >= line.length) break;
    let word = '';
    if (line[i] === '"') {
      i++;
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) {
          const e = line[i + 1]!;
          if (e === 'x' && /^[\da-f]{2}$/i.test(line.slice(i + 2, i + 4))) { word += String.fromCharCode(parseInt(line.slice(i + 2, i + 4), 16)); i += 4; continue; }
          word += ({ n: '\n', r: '\r', t: '\t', b: '\b', a: '\x07' } as Record<string, string>)[e] ?? e;
          i += 2;
          continue;
        }
        word += line[i++];
      }
      if (line[i] !== '"') throw refuse('a quoted word is not closed');
      i++;
    } else if (line[i] === '\'') {
      i++;
      while (i < line.length && line[i] !== '\'') { if (line[i] === '\\' && line[i + 1] === '\'') { word += '\''; i += 2; continue; } word += line[i++]; }
      if (line[i] !== '\'') throw refuse('a quoted word is not closed');
      i++;
    } else {
      while (i < line.length && !/\s/.test(line[i]!)) word += line[i++];
    }
    out.push(word);
  }
  return out;
}

/** Commands that only read (with their subcommand where it matters). */
const REDIS_READS = new Set(`GET MGET STRLEN GETRANGE SUBSTR LCS EXISTS TYPE TTL PTTL EXPIRETIME PEXPIRETIME DUMP RANDOMKEY DBSIZE SCAN KEYS
  HGET HMGET HGETALL HKEYS HVALS HLEN HEXISTS HSTRLEN HRANDFIELD HSCAN LRANGE LINDEX LLEN LPOS SMEMBERS SISMEMBER SMISMEMBER SCARD
  SRANDMEMBER SSCAN SINTER SUNION SDIFF SINTERCARD ZRANGE ZRANGEBYSCORE ZRANGEBYLEX ZREVRANGE ZREVRANGEBYSCORE ZREVRANGEBYLEX ZSCORE
  ZMSCORE ZRANK ZREVRANK ZCARD ZCOUNT ZLEXCOUNT ZSCAN ZRANDMEMBER ZINTER ZUNION ZDIFF ZINTERCARD XRANGE XREVRANGE XLEN XREAD XPENDING
  BITCOUNT BITPOS GETBIT BITFIELD_RO PFCOUNT GEOPOS GEODIST GEOHASH GEORADIUS_RO GEORADIUSBYMEMBER_RO GEOSEARCH SORT_RO PING ECHO TIME
  INFO LASTSAVE ROLE MEMORY|USAGE MEMORY|STATS OBJECT|ENCODING OBJECT|FREQ OBJECT|IDLETIME OBJECT|REFCOUNT XINFO|STREAM XINFO|GROUPS
  XINFO|CONSUMERS COMMAND|COUNT COMMAND|INFO COMMAND|DOCS JSON.GET JSON.MGET JSON.TYPE JSON.STRLEN JSON.OBJKEYS JSON.OBJLEN JSON.ARRLEN`.split(/\s+/));
const SUBCOMMANDS = new Set(['MEMORY', 'OBJECT', 'XINFO', 'COMMAND', 'CONFIG', 'CLIENT', 'ACL', 'CLUSTER', 'SCRIPT', 'FUNCTION', 'MODULE', 'DEBUG', 'SLOWLOG', 'LATENCY']);
const commandName = (words: string[]) => {
  const head = (words[0] ?? '').toUpperCase();
  return SUBCOMMANDS.has(head) && words[1] ? `${head}|${words[1].toUpperCase()}` : head;
};
/** Commands that change everything or block the connection: the panel asks first (FLUSH*), nobody runs the rest. */
const REDIS_NEVER = new Set(['SELECT', 'MONITOR', 'SUBSCRIBE', 'PSUBSCRIBE', 'SSUBSCRIBE', 'SYNC', 'PSYNC', 'QUIT', 'RESET', 'SHUTDOWN']);

function redisClient(c: DbConnection, timeoutMs: number, db: number): Redis {
  const opts = {
    lazyConnect: true, connectTimeout: CONNECT_TIMEOUT_MS, commandTimeout: timeoutMs, maxRetriesPerRequest: 0, enableOfflineQueue: false,
    retryStrategy: () => null, db, connectionName: 'dalang',
    ...(c.user && { username: c.user }), ...(c.password && { password: c.password }),
    ...(c.ssl !== 'disable' && { tls: { rejectUnauthorized: c.ssl === 'verify-full', ...(c.tunneledFrom && { servername: c.tunneledFrom }) } }),
  };
  return /^rediss?:\/\//i.test(c.host) ? new Redis(c.host, opts) : new Redis({ host: c.host || 'localhost', port: c.port || 6379, ...opts });
}

/** The database number a connection (or a console) is on: "3", "db3" or empty for 0. */
export const redisDb = (database: string) => Number(/\d+/.exec(database)?.[0] ?? 0);

const text = (v: unknown) => (Buffer.isBuffer(v) ? v.toString('utf8') : v);

/** A reply as a table: pairs (HGETALL, WITHSCORES) as two columns, lists as one, a SCAN's cursor in the note. */
function redisTable(sql: string, words: string[], reply: unknown, ms: number, o: RunOpts): QueryResult {
  const name = commandName(words);
  const maxCell = o.maxCell ?? 20_000;
  const cut = (v: unknown) => { const s = text(v); return typeof s === 'string' && s.length > maxCell ? `${s.slice(0, maxCell)}…` : s ?? null; };
  const table = (columns: string[], rows: unknown[][], note?: string): QueryResult => {
    const truncated = rows.length > o.limit;
    return { sql, columns: columns.map((n) => ({ name: n, type: '' })), rows: rows.slice(0, o.limit).map((r) => r.map((v) => (Array.isArray(v) || (v && typeof v === 'object') ? JSON.stringify(v) : cut(v)))), affected: null, truncated, ms, ...(note && { note }) };
  };
  const pairs = (list: unknown[]) => { const rows: unknown[][] = []; for (let i = 0; i + 1 < list.length; i += 2) rows.push([text(list[i]), text(list[i + 1])]); return rows; };
  const upper = words.map((w) => w.toUpperCase());
  if (name === 'INFO' && typeof reply === 'string') {
    const rows: unknown[][] = [];
    let section = '';
    for (const line of reply.split(/\r?\n/)) {
      if (line.startsWith('#')) section = line.slice(1).trim();
      else if (line.includes(':')) rows.push([section, line.slice(0, line.indexOf(':')), line.slice(line.indexOf(':') + 1)]);
    }
    return table(['section', 'name', 'value'], rows);
  }
  if (/^(H|S|Z)?SCAN$/.test(name) && Array.isArray(reply)) {
    const [cursor, items] = reply as [unknown, unknown[]];
    const note = String(text(cursor)) === '0' ? 'the scan is complete' : `next cursor: ${text(cursor)}`;
    if (name === 'HSCAN') return table(['field', 'value'], pairs(items), note);
    if (name === 'ZSCAN') return table(['member', 'score'], pairs(items), note);
    return table([name === 'SSCAN' ? 'member' : 'key'], items.map((x) => [text(x)]), note);
  }
  if (Array.isArray(reply)) {
    if (name === 'HGETALL' || name === 'CONFIG|GET' || name === 'HRANDFIELD' && upper.includes('WITHVALUES')) return table(['field', 'value'], pairs(reply));
    if (/^Z/.test(name) && upper.includes('WITHSCORES')) return table(['member', 'score'], pairs(reply));
    if (name === 'XRANGE' || name === 'XREVRANGE') return table(['id', 'fields'], (reply as [unknown, unknown[]][]).map(([id, f]) => [text(id), Object.fromEntries(pairs(f))]));
    if (name === 'HMGET' || name === 'MGET') return table([name === 'HMGET' ? 'field' : 'key', 'value'], reply.map((v, i) => [words[i + (name === 'HMGET' ? 2 : 1)], text(v)]));
    return table(['value'], reply.map((v) => [Array.isArray(v) ? v.map(text) : text(v)]));
  }
  // A command that writes answers with a status, a count or the new value: it goes with the other writes' outcomes.
  if (!REDIS_READS.has(name) && !REDIS_READS.has(words[0]!.toUpperCase())) return { sql, columns: [], rows: [], affected: null, truncated: false, ms, note: `reply: ${reply === null ? 'nil' : text(reply)}` };
  return table(['result'], [[reply === null ? null : text(reply)]]);
}

/** Runs a script of Redis commands, one per line, on the console's database; a failure carries the results before it. */
export async function redisScript(c: DbConnection, statements: string[], o: RunOpts): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  const client = redisClient(c, o.timeoutMs, redisDb(c.database));
  client.on('error', () => {}); // reported by the command that fails
  const stop = () => client.disconnect();
  o.signal?.addEventListener('abort', stop, { once: true });
  try {
    await client.connect();
    for (const sql of statements) {
      if (o.signal?.aborted) throw new Error('cancelled');
      const words = redisWords(sql);
      if (!words.length) continue;
      const name = commandName(words);
      if (REDIS_NEVER.has(words[0]!.toUpperCase())) {
        throw refuse(words[0]!.toUpperCase() === 'SELECT' ? 'pick the database in the console\'s database list instead of SELECT' : `${words[0]} is not run here`);
      }
      if (o.readOnly && !REDIS_READS.has(name) && !REDIS_READS.has(words[0]!.toUpperCase())) throw refuse(`${name.replace('|', ' ')} is not a read, and this run is read-only`, true);
      const t0 = Date.now();
      const reply = await client.call(words[0]!, ...words.slice(1));
      results.push(redisTable(sql, words, reply, Date.now() - t0, o));
    }
    return results;
  } catch (e) { throw Object.assign(e as Error, { partial: results }); } finally {
    o.signal?.removeEventListener('abort', stop);
    client.disconnect();
  }
}

const MAX_KEYS = 5000;

/**
 * The databases that hold keys (as schemas, named db0, db1, ...), and with `only` (or a small keyspace) the keys of one
 * as tables, each with its type and time to live. Keys are found with SCAN, never KEYS.
 */
export async function redisSchema(c: DbConnection, timeoutMs: number, only?: string, inline = 400): Promise<SchemaInfo> {
  const client = redisClient(c, timeoutMs, 0);
  client.on('error', () => {});
  try {
    await client.connect();
    const info = String(await client.call('INFO', 'keyspace'));
    const counts = new Map<number, number>();
    for (const m of info.matchAll(/^db(\d+):keys=(\d+)/gm)) counts.set(Number(m[1]), Number(m[2]));
    const own = redisDb(c.database);
    if (!counts.has(own)) counts.set(own, 0);
    const dbs = only ? [redisDb(only)] : [...counts.keys()].sort((x, y) => x - y);
    const total = [...counts.values()].reduce((n, x) => n + x, 0);
    const schemas = [];
    for (const n of dbs) {
      const withKeys = !!only || total <= inline;
      const tables: SchemaTable[] = [];
      if (withKeys) {
        await client.call('SELECT', String(n));
        const keys: string[] = [];
        let cursor = '0';
        do {
          const [next, batch] = await client.call('SCAN', cursor, 'COUNT', '1000') as [string, string[]];
          keys.push(...batch);
          cursor = next;
        } while (cursor !== '0' && keys.length < MAX_KEYS);
        keys.sort();
        const pipe = client.pipeline();
        for (const k of keys.slice(0, MAX_KEYS)) { pipe.type(k); pipe.pttl(k); }
        const replies = (await pipe.exec()) ?? [];
        keys.slice(0, MAX_KEYS).forEach((k, i) => {
          const type = String(replies[i * 2]?.[1] ?? '');
          const ttl = Number(replies[i * 2 + 1]?.[1] ?? -1);
          tables.push({ name: k, kind: 'table', detail: ttl > 0 ? `${type} · ttl ${Math.round(ttl / 1000)}s` : type, columns: [] });
        });
      }
      schemas.push({ name: `db${n}`, loaded: withKeys, tables, size: counts.get(n) ?? 0, ...(withKeys && (counts.get(n) ?? 0) > MAX_KEYS && { more: true }) });
    }
    return { schemas };
  } finally { client.disconnect(); }
}

/** The server's version, and a warning when its user may run every command (or there are no users at all). */
export async function redisTest(c: DbConnection): Promise<{ version: string; warnings: string[] }> {
  const client = redisClient(c, 15_000, redisDb(c.database));
  client.on('error', () => {});
  try {
    await client.connect();
    const info = String(await client.call('INFO', 'server'));
    const version = /redis_version:(\S+)/.exec(info)?.[1] ?? '?';
    const warnings: string[] = [];
    try {
      const who = String(await client.call('ACL', 'WHOAMI'));
      const user = await client.call('ACL', 'GETUSER', who) as unknown[];
      const commands = String(user[user.indexOf('commands') + 1] ?? '');
      if (/\+@all/.test(commands)) warnings.push(`User ${who} may run every command (FLUSHALL, CONFIG SET, ...). Read-only here is only what Dalang lets through; an ACL user without write commands is the real limit.`);
    } catch {
      warnings.push('This server has no ACL users (Redis before 6): every client may run every command. Read-only here is only what Dalang lets through.');
    }
    return { version: `Redis ${version}`, warnings };
  } finally { client.disconnect(); }
}

// ---------- splitting, refusing, warning ----------

/**
 * Where each command of a script starts and ends. MongoDB: at `;` or at a line that starts a new `db.` command, outside
 * strings, comments and brackets. Redis: one command per line; lines starting with # or // are comments.
 */
export function splitNoSql(script: string, driver: 'mongodb' | 'redis'): { from: number; to: number }[] {
  const out: { from: number; to: number }[] = [];
  if (driver === 'redis') {
    let at = 0;
    for (const line of script.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('//')) out.push({ from: at + line.indexOf(t[0]!), to: at + line.trimEnd().length });
      at += line.length + 1;
    }
    return out;
  }
  let start = 0;
  let depth = 0;
  let code = false;
  let i = 0;
  const n = script.length;
  const end = (at: number, next: number) => { if (code) out.push({ from: start, to: at }); start = next; code = false; };
  while (i < n) {
    const ch = script[i]!;
    if (ch === '/' && script[i + 1] === '/') { const nl = script.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
    if (ch === '/' && script[i + 1] === '*') { const close = script.indexOf('*/', i + 2); i = close < 0 ? n : close + 2; continue; }
    if (ch === '"' || ch === '\'' || ch === '`') {
      i++;
      while (i < n && script[i] !== ch) i += script[i] === '\\' ? 2 : 1;
      i++;
      code = true;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { end(i, i + 1); i++; continue; }
    else if (ch === '\n' && depth === 0 && code && NEXT_COMMAND.test(script.slice(i + 1))) { end(i, i + 1); i++; continue; }
    if (!/\s/.test(ch)) code = true;
    i++;
  }
  end(n, n);
  return out.map((r) => tighten(script, r));
}

/** A line that starts a command, after blank and comment lines. */
const NEXT_COMMAND = /^(?:[ \t]*(?:\/\/[^\n]*)?\r?\n)*\s*(db\s*[.[]|show\s|use\s)/;
/** A command's range without the blank and comment-only lines at its start and end. */
function tighten(script: string, r: { from: number; to: number }): { from: number; to: number } {
  let { from, to } = r;
  for (;;) {
    const head = /^(?:\s*\/\/[^\n]*\n|\s+)/.exec(script.slice(from, to));
    if (!head || !head[0].length) break;
    from += head[0].length;
  }
  for (;;) {
    const tail = /(?:\n[ \t]*\/\/[^\n]*|\s+)$/.exec(script.slice(from, to));
    if (!tail || !tail[0].length) break;
    to -= tail[0].length;
  }
  return { from, to };
}

/** Why an agent may not run this, or null: commands that reach the server itself, or run code on it. */
export function noSqlAgentRefusal(statements: string[], driver: 'mongodb' | 'redis'): string | null {
  if (driver === 'redis') {
    const never = new Set(['CONFIG', 'DEBUG', 'SHUTDOWN', 'FLUSHALL', 'FLUSHDB', 'MODULE', 'SCRIPT', 'EVAL', 'EVALSHA', 'EVAL_RO', 'EVALSHA_RO',
      'FUNCTION', 'FCALL', 'FCALL_RO', 'REPLICAOF', 'SLAVEOF', 'MIGRATE', 'CLIENT', 'ACL', 'CLUSTER', 'MONITOR', 'SYNC', 'PSYNC', 'BGSAVE',
      'BGREWRITEAOF', 'SAVE', 'FAILOVER', 'KEYS', 'SWAPDB', 'MOVE', 'LATENCY', 'SLOWLOG']);
    for (const s of statements) {
      const head = (redisWords(s)[0] ?? '').toUpperCase();
      if (never.has(head)) return `refused for agents: ${head}${head === 'KEYS' ? ' (use SCAN with MATCH)' : ' reaches the server itself'}. Ask a human to run it in the SQL editor if it is needed.`;
    }
    return null;
  }
  for (const s of statements) {
    // Server-side JavaScript, whatever the command.
    if (/\$(where|function|accumulator)\b/.test(s)) return 'refused for agents: $where, $function and $accumulator run JavaScript on the server. Ask a human to run it in the SQL editor if it is needed.';
    if (/^\s*db\s*\.\s*dropDatabase\b/.test(s)) return 'refused for agents: dropDatabase. Ask a human to run it in the SQL editor if it is needed.';
  }
  return null;
}

/** Commands that change every document of a collection (or a whole Redis database), to ask about first. */
export function noSqlUnsafe(statements: string[], driver: 'mongodb' | 'redis'): { index: number; sql: string; kind: 'update' | 'delete' | 'truncate'; table: string }[] {
  const out: { index: number; sql: string; kind: 'update' | 'delete' | 'truncate'; table: string }[] = [];
  statements.forEach((sql, index) => {
    if (driver === 'redis') {
      const head = (redisWords(sql)[0] ?? '').toUpperCase();
      if (head === 'FLUSHDB' || head === 'FLUSHALL') out.push({ index, sql, kind: 'truncate', table: head === 'FLUSHALL' ? 'every database' : 'this database' });
      return;
    }
    let cmd: MongoCommand;
    try { cmd = parseMongo(sql); } catch { return; }
    if (cmd.kind === 'show') return;
    if (cmd.kind === 'db') {
      if (cmd.calls[0]?.name === 'dropDatabase') out.push({ index, sql, kind: 'truncate', table: 'the database' });
      return;
    }
    const first = cmd.calls[0]!;
    const empty = (f: unknown) => f === undefined || (f !== null && typeof f === 'object' && !Array.isArray(f) && !Object.keys(f).length);
    if (first.name === 'drop') out.push({ index, sql, kind: 'truncate', table: cmd.collection! });
    else if (['deleteMany', 'remove'].includes(first.name) && empty(first.args[0])) out.push({ index, sql, kind: 'delete', table: cmd.collection! });
    else if (first.name === 'updateMany' && empty(first.args[0])) out.push({ index, sql, kind: 'update', table: cmd.collection! });
  });
  return out;
}


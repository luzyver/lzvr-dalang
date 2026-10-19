/**
 * The SQL editor's database connections and the drivers that run queries on them: PostgreSQL (and what speaks its
 * protocol), MySQL and MariaDB, SQLite files, and (nosql.ts) MongoDB and Redis. Every run opens its own connection and
 * closes it afterwards.
 *
 * Read-only is enforced by the database, never by looking at the SQL: PostgreSQL runs each statement in a `READ ONLY`
 * transaction that is rolled back, MySQL/MariaDB in a session set to `TRANSACTION READ ONLY` (DDL is refused there too),
 * SQLite opens the file read-only. A read-only run gets a fresh connection per statement, so a `COMMIT` or `SET` in one
 * statement cannot loosen the next. A database user with SELECT rights only is safer still.
 */
import { DatabaseSync } from 'node:sqlite';
import mysql from 'mysql2';
import pg from 'pg';
import Cursor from 'pg-cursor';
import {
  mongoBackupRead, mongoDdl, mongoSchema, mongoScript, mongoTest, noSqlAgentRefusal, noSqlBackupPlan, noSqlUnsafe, redisSchema, redisScript,
  redisTest, splitNoSql,
} from './nosql.js';
import { openTunnel, type SshConf } from './ssh-tunnel.js';
import type { Store } from './store.js';
import type { ProjectAccess } from './util.js';

export const DRIVERS = ['postgres', 'mysql', 'mariadb', 'sqlite', 'mongodb', 'redis'] as const;
export type Driver = (typeof DRIVERS)[number];
/** MongoDB and Redis: not SQL (nosql.ts); no row editing, DDL or SQL-only checks. */
export const isNoSql = (d: Driver): d is 'mongodb' | 'redis' => d === 'mongodb' || d === 'redis';
/**
 * What an agent may do on a connection (through the gateway's MCP tools). 'approve': read freely; a script the
 * database refuses as a write waits for an admin, who runs it or not.
 */
export const AGENT_MODES = ['off', 'read-only', 'approve', 'read-write'] as const;
export type AgentMode = (typeof AGENT_MODES)[number];
export const SSL_MODES = ['disable', 'require', 'verify-full'] as const;
export type SslMode = (typeof SSL_MODES)[number];

export interface DbConnection {
  /** Its name in URLs and for agents: lowercase letters, digits, - and _. */
  id: string;
  /** What the panel shows. */
  label: string;
  driver: Driver;
  host: string;
  port: number;
  user: string;
  password: string;
  /** PostgreSQL: the one it opens; with allDatabases, the one it starts in (empty: `postgres`). */
  database: string;
  /**
   * PostgreSQL: every other database on the server opens too, through its own connection (a PostgreSQL connection is
   * bound to one database). Saved before it existed: absent.
   */
  allDatabases?: boolean;
  ssl: SslMode;
  /** SQLite: the database file on this machine. */
  file: string;
  /** Reach the database through an SSH server (its host and port are then as that server sees them). */
  ssh?: SshConf;
  /** Set on the copy a run uses inside a tunnel: the database's own host name, for TLS (it is reached at 127.0.0.1). */
  tunneledFrom?: string;
  /** Who may open it in the panel (as for projects). */
  access: ProjectAccess;
  /** Panel queries are read-only too. */
  readOnly: boolean;
  agent: AgentMode;
}

export interface Column { name: string; type: string }
export interface QueryResult {
  /** The statement as run (trimmed). */
  sql: string;
  columns: Column[];
  rows: unknown[][];
  /** Rows changed by an INSERT/UPDATE/DELETE, or null. */
  affected: number | null;
  /** More rows than `limit` came back; only `limit` are here. */
  truncated: boolean;
  ms: number;
  /** A line about it beside the rows (a Redis SCAN's next cursor, the _id a MongoDB insert gave). */
  note?: string;
}
export interface SchemaColumn { name: string; type: string; nullable: boolean; pk: boolean }
/** `detail`: shown beside it (a Redis key's type and time to live). */
export interface SchemaTable { name: string; kind: 'table' | 'view'; columns: SchemaColumn[]; detail?: string }
/**
 * `loaded`: its tables come with their columns (else ask readSchema for that schema). `size`: how many tables (keys) it
 * has when they are not listed yet; `more`: more than are listed.
 */
export interface SchemaInfo { schemas: { name: string; loaded: boolean; tables: SchemaTable[]; size?: number; more?: boolean }[] }

export interface RunOpts {
  readOnly: boolean;
  /** At most this many rows per statement. */
  limit: number;
  timeoutMs: number;
  /** Longer text values are cut. */
  maxCell?: number;
  /** Aborting it cancels the statement running on the server (PostgreSQL, MySQL/MariaDB; SQLite runs to the end). */
  signal?: AbortSignal;
  /** PostgreSQL: the schema an unqualified name is looked up in first (search_path), before public. */
  schema?: string;
}

/** Calls `cancel` when `signal` aborts, until the returned function is called. */
function onAbort(signal: AbortSignal | undefined, cancel: () => void): () => void {
  if (!signal) return () => {};
  signal.addEventListener('abort', cancel, { once: true });
  return () => signal.removeEventListener('abort', cancel);
}
const CANCELLED = 'cancelled';
const checkAborted = (o: RunOpts) => { if (o.signal?.aborted) throw new Error(CANCELLED); };

const KEY = 'db_connections';
export const DEFAULT_PORT: Record<Driver, number> = { postgres: 5432, mysql: 3306, mariadb: 3306, sqlite: 0, mongodb: 27017, redis: 6379 };
const CONNECT_TIMEOUT_MS = 10_000;
const MAX_STATEMENTS = 100;

export function loadConnections(store: Store): DbConnection[] {
  try {
    const list = JSON.parse(store.getKv(KEY) ?? '[]');
    return Array.isArray(list) ? list : [];
  } catch { return []; }
}
export const saveConnections = (store: Store, list: DbConnection[]) => store.setKv(KEY, JSON.stringify(list));

// ---------- statements ----------

/**
 * Where each statement of a script starts and ends (offsets into it), split on `;` outside strings and comments, the
 * way `driver` reads them: MySQL/MariaDB know `#` comments, backticks and backslash escapes, PostgreSQL dollar quotes
 * and E'...' escapes.
 */
export function splitStatements(script: string, driver: Driver = 'postgres'): { from: number; to: number }[] {
  if (isNoSql(driver)) return splitNoSql(script, driver);
  const my = driver === 'mysql' || driver === 'mariadb';
  const out: { from: number; to: number }[] = [];
  let start = 0;
  let code = false; // the current statement has something besides blanks and comments
  let i = 0;
  const n = script.length;
  const end = (at: number) => { if (code) out.push({ from: start, to: at }); start = at + 1; code = false; };
  while (i < n) {
    const ch = script[i]!;
    const next = script[i + 1];
    if ((ch === '-' && next === '-') || (my && ch === '#')) {
      const nl = script.indexOf('\n', i);
      i = nl < 0 ? n : nl + 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      const close = script.indexOf('*/', i + 2);
      i = close < 0 ? n : close + 2;
      continue;
    }
    if (ch === ';') { end(i); i++; continue; }
    if (!/\s/.test(ch)) code = true;
    if (ch === '\'' || ch === '"' || (my && ch === '`')) {
      const escapes = ch === '\'' && (my || (driver === 'postgres' && /[Ee]/.test(script[i - 1] ?? '') && !/\w/.test(script[i - 2] ?? '')));
      i++;
      while (i < n) {
        if (escapes && script[i] === '\\') { i += 2; continue; }
        if (script[i] === ch) {
          if (script[i + 1] === ch) { i += 2; continue; } // a doubled quote
          break;
        }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '$' && driver === 'postgres') { // $$...$$ or $tag$...$tag$
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i, i + 64));
      if (m && !/\w/.test(script[i - 1] ?? '')) {
        const close = script.indexOf(m[0], i + m[0].length);
        i = close < 0 ? n : close + m[0].length;
        continue;
      }
    }
    i++;
  }
  end(n);
  return out;
}

export const statementsOf = (script: string, driver?: Driver) => splitStatements(script, driver).map((s) => script.slice(s.from, s.to).trim());

// ---------- values ----------

/** A value as JSON can carry it: dates and big numbers as text, bytes as \x hex, long text cut. */
function cell(v: unknown, maxCell: number): unknown {
  if (v === null || v === undefined) return null;
  if (typeof v === 'bigint') return v.toString();
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? String(v) : v.toISOString();
  if (v instanceof Uint8Array) {
    // An unbounded maxCell (a backup) keeps every byte.
    const max = Number.isFinite(maxCell) ? 256 : Infinity;
    const hex = Buffer.from(v.subarray(0, max)).toString('hex');
    return `\\x${hex}${v.length > max ? '…' : ''}`;
  }
  if (typeof v === 'object') v = JSON.stringify(v);
  if (typeof v === 'string' && v.length > maxCell) return `${v.slice(0, maxCell)}…`;
  return v;
}
const cells = (row: unknown[], maxCell: number) => row.map((v) => cell(v, maxCell));

// ---------- PostgreSQL ----------

// Values stay as PostgreSQL prints them (dates, numerics, json...), except booleans and the small number types.
const PG_NUMBERS = new Set([21, 23, 26, 700, 701]); // int2, int4, oid, float4, float8 (int8 stays text: it may not fit)
const pgTypes = {
  getTypeParser: (oid: number) => (oid === 16 ? (v: string) => v === 't' : PG_NUMBERS.has(oid) ? Number : (v: string) => v),
};

function pgClient(c: DbConnection, timeoutMs: number): pg.Client {
  return new pg.Client({
    host: c.host || 'localhost', port: c.port || DEFAULT_PORT.postgres, user: c.user || undefined,
    password: c.password || undefined, database: c.database || (c.allDatabases ? 'postgres' : undefined), application_name: 'dalang',
    ssl: c.ssl === 'disable' ? false : { rejectUnauthorized: c.ssl === 'verify-full', ...(c.tunneledFrom && { servername: c.tunneledFrom }) },
    connectionTimeoutMillis: CONNECT_TIMEOUT_MS, statement_timeout: timeoutMs, query_timeout: timeoutMs + 5000,
    types: pgTypes as never,
  });
}

type PgRead = { rows: unknown[][]; fields: { name: string; dataTypeID: number }[]; affected: number | null };
/** Reads up to `limit + 1` rows of one statement through a cursor, so a huge table is never loaded whole. */
function pgRun(client: pg.Client, sql: string, limit: number): Promise<PgRead> {
  const cursor = client.query(new Cursor(sql, [], { rowMode: 'array' }));
  return new Promise((resolve, reject) => {
    cursor.read(limit + 1, (err, rows, result: any) => {
      if (err) { reject(err); return; }
      const affected = result?.command && result.command !== 'SELECT' && typeof result.rowCount === 'number' ? result.rowCount : null;
      cursor.close(() => resolve({ rows: rows as unknown[][], fields: result?.fields ?? [], affected }));
    });
  });
}

/** PostgreSQL type names for the oids queries return, read once per run when a result has columns. */
async function pgTypeNames(client: pg.Client, oids: number[]): Promise<Map<number, string>> {
  if (!oids.length) return new Map();
  try {
    const r = await client.query({ text: 'SELECT oid::int, format_type(oid, NULL) FROM pg_type WHERE oid = ANY($1)', values: [oids], rowMode: 'array' });
    return new Map(r.rows.map(([oid, name]: unknown[]) => [Number(oid), String(name)]));
  } catch { return new Map(); }
}

async function pgStatement(client: pg.Client, sql: string, o: RunOpts): Promise<QueryResult> {
  const t0 = Date.now();
  const r = await pgRun(client, sql, o.limit);
  const ms = Date.now() - t0;
  const names = await pgTypeNames(client, [...new Set(r.fields.map((f) => f.dataTypeID))]);
  return {
    sql, columns: r.fields.map((f) => ({ name: f.name, type: names.get(f.dataTypeID) ?? String(f.dataTypeID) })),
    rows: r.rows.slice(0, o.limit).map((row) => cells(row, o.maxCell ?? 20_000)), affected: r.affected,
    truncated: r.rows.length > o.limit, ms,
  };
}

/** Cancels what the backend `pid` is running, from a second connection (as the same user, which PostgreSQL allows). */
async function pgCancel(c: DbConnection, pid: number): Promise<void> {
  const k = pgClient(c, 10_000);
  try { await k.connect(); await k.query('SELECT pg_cancel_backend($1)', [pid]); } catch { /* it ended meanwhile */ } finally { await k.end().catch(() => {}); }
}

/** A connected client that is cancelled when `o.signal` aborts; `done()` closes it. */
async function pgOpen(c: DbConnection, o: RunOpts): Promise<{ client: pg.Client; done: () => Promise<void> }> {
  checkAborted(o);
  const client = pgClient(c, o.timeoutMs);
  let stop = () => {};
  const done = async () => { stop(); await client.end().catch(() => {}); };
  try {
    await client.connect();
    stop = onAbort(o.signal, () => { void pgCancel(c, (client as unknown as { processID: number }).processID); });
    if (o.schema) await client.query(`SET search_path TO ${quoteIdent('postgres', o.schema)}, public`);
  } catch (e) { await done(); throw e; }
  return { client, done };
}

async function pgScript(c: DbConnection, statements: string[], o: RunOpts): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  if (o.readOnly) {
    for (const sql of statements) {
      let open: Awaited<ReturnType<typeof pgOpen>> | null = null;
      try {
        open = await pgOpen(c, o);
        await open.client.query('BEGIN TRANSACTION READ ONLY');
        results.push(await pgStatement(open.client, sql, o));
      } catch (e) { throw withResults(e, results, o); } finally { await open?.done(); }
    }
    return results;
  }
  let open: Awaited<ReturnType<typeof pgOpen>> | null = null;
  try {
    open = await pgOpen(c, o);
    for (const sql of statements) { checkAborted(o); results.push(await pgStatement(open.client, sql, o)); }
    return results;
  } catch (e) { throw withResults(e, results, o); } finally { await open?.done(); }
}

// ---------- MySQL / MariaDB ----------

function myConnection(c: DbConnection): mysql.Connection {
  return mysql.createConnection({
    host: c.host || 'localhost', port: c.port || DEFAULT_PORT[c.driver], user: c.user || undefined,
    password: c.password || undefined, database: c.database || undefined,
    ssl: c.ssl === 'disable' ? undefined : { rejectUnauthorized: c.ssl === 'verify-full', ...(c.tunneledFrom && { servername: c.tunneledFrom }) },
    connectTimeout: CONNECT_TIMEOUT_MS, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false,
  });
}

const myConnect = (conn: mysql.Connection) => new Promise<void>((res, rej) => conn.connect((e) => (e ? rej(e) : res())));
const myQuery = (conn: mysql.Connection, sql: string) => new Promise<void>((res, rej) => conn.query(sql, (e) => (e ? rej(e) : res())));

/** mysql2's column type numbers, by their SQL name where the protocol's differs (for the result header). */
const MY_SQL_NAMES: Record<string, string> = {
  TINY: 'tinyint', SHORT: 'smallint', INT24: 'mediumint', LONG: 'int', LONGLONG: 'bigint', NEWDECIMAL: 'decimal',
  VAR_STRING: 'varchar', VARCHAR: 'varchar', STRING: 'char', TINY_BLOB: 'tinyblob', MEDIUM_BLOB: 'mediumblob', LONG_BLOB: 'longblob',
};
const MY_TYPES = Object.fromEntries(Object.entries((mysql as any).Types ?? {}).map(([k, v]) => [v as number, MY_SQL_NAMES[k] ?? k.toLowerCase()]));

/**
 * One statement; stops reading after `limit + 1` rows. Rows past the limit are not waited for: the connection is
 * dropped, so the caller must not use it again (`done.dropped`).
 */
function myStatement(conn: mysql.Connection, sql: string, o: RunOpts): Promise<QueryResult & { dropped?: boolean }> {
  const t0 = Date.now();
  return new Promise((resolve, reject) => {
    let fields: { name: string; type?: number; columnType?: number }[] = [];
    const rows: unknown[][] = [];
    let affected: number | null = null;
    let settled = false;
    const finish = (dropped: boolean) => {
      if (settled) return;
      settled = true;
      resolve({
        sql, columns: fields.map((f) => ({ name: f.name, type: MY_TYPES[f.columnType ?? f.type ?? -1] ?? '' })),
        rows: rows.slice(0, o.limit).map((r) => cells(r, o.maxCell ?? 20_000)), affected, truncated: rows.length > o.limit,
        ms: Date.now() - t0, dropped,
      });
    };
    const q = conn.query({ sql, rowsAsArray: true, timeout: o.timeoutMs });
    q.on('fields', (f: any) => { fields = f ?? []; rows.length = 0; });
    q.on('result', (row: any) => {
      if (settled) return;
      if (Array.isArray(row)) {
        rows.push(row);
        if (rows.length > o.limit) { conn.destroy(); finish(true); }
      } else if (row && typeof row.affectedRows === 'number') affected = row.affectedRows;
    });
    q.on('error', (e: Error) => { if (!settled) { settled = true; reject(e); } });
    q.on('end', () => finish(false));
  });
}

/** Stops what connection `threadId` is running, from a second connection. */
async function myKill(c: DbConnection, threadId: number | null): Promise<void> {
  if (!threadId) return;
  const k = myConnection(c);
  try { await myConnect(k); await myQuery(k, `KILL QUERY ${Number(threadId)}`); } catch { /* it ended meanwhile */ } finally { k.destroy(); }
}

async function myScript(c: DbConnection, statements: string[], o: RunOpts): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  let conn: mysql.Connection | null = null;
  let stop = () => {};
  const close = () => { stop(); if (conn) { const x = conn; conn = null; x.end(() => {}); x.destroy(); } };
  try {
    for (const sql of statements) {
      checkAborted(o);
      if (!conn) {
        const x = myConnection(c);
        conn = x;
        await myConnect(x);
        stop = onAbort(o.signal, () => { void myKill(c, x.threadId); });
        if (o.readOnly) await myQuery(x, 'SET SESSION TRANSACTION READ ONLY');
      }
      const { dropped, ...r } = await myStatement(conn, sql, o);
      results.push(r);
      // A read-only run starts afresh for every statement (a statement may have changed the session); a dropped one must.
      if (dropped || o.readOnly) close();
    }
    return results;
  } catch (e) { throw withResults(e, results, o); } finally { close(); }
}

// ---------- SQLite ----------

function sqliteOpen(c: DbConnection, readOnly: boolean, timeoutMs: number): DatabaseSync {
  if (!c.file) throw new Error('no database file set');
  return new DatabaseSync(c.file, { readOnly, timeout: Math.min(timeoutMs, 10_000), open: true } as any);
}

function sqliteScript(c: DbConnection, statements: string[], o: RunOpts): QueryResult[] {
  const results: QueryResult[] = [];
  const db = sqliteOpen(c, o.readOnly, o.timeoutMs);
  try {
    for (const sql of statements) {
      checkAborted(o);
      const t0 = Date.now();
      const st = db.prepare(sql);
      const cols = st.columns();
      if (!cols.length) {
        const r = st.run();
        results.push({ sql, columns: [], rows: [], affected: Number(r.changes), truncated: false, ms: Date.now() - t0 });
        continue;
      }
      (st as any).setReturnArrays?.(true);
      const rows: unknown[][] = [];
      for (const row of st.iterate() as Iterable<any>) {
        rows.push(Array.isArray(row) ? row : Object.values(row));
        if (rows.length > o.limit) break;
      }
      results.push({
        sql, columns: cols.map((col) => ({ name: col.name, type: col.type ?? '' })),
        rows: rows.slice(0, o.limit).map((r) => cells(r, o.maxCell ?? 20_000)), affected: null, truncated: rows.length > o.limit,
        ms: Date.now() - t0,
      });
    }
    return results;
  } catch (e) { throw withResults(e, results, o); } finally { db.close(); }
}

// ---------- running ----------

/**
 * A failed run: the error, the statement that failed (its index) and the results of those before it. `readOnlyRefusal`:
 * the database refused it because the run was read-only (it tried to write).
 */
export class QueryError extends Error {
  constructor(message: string, readonly results: QueryResult[], readonly index: number, readonly readOnlyRefusal = false) { super(message); }
}

/** PostgreSQL 25006, MySQL/MariaDB 1792 (and 1290, --read-only), SQLite SQLITE_READONLY (8). */
function refusedAsReadOnly(e: { code?: unknown; errno?: unknown; errcode?: unknown; message?: string; readOnlyRefusal?: unknown }): boolean {
  return e.readOnlyRefusal === true || e.code === '25006' || e.errno === 1792 || e.errno === 1290 || e.errcode === 8 || /attempt to write a readonly database/i.test(e.message ?? '');
}

function withResults(e: unknown, results: QueryResult[], o?: RunOpts): QueryError {
  if (e instanceof QueryError) return e;
  const err = e as { message?: string; code?: string };
  const message = o?.signal?.aborted ? 'cancelled' : err.message || err.code || String(e);
  // MongoDB and Redis hand their results so far along with the error.
  const done = (e as { partial?: QueryResult[] }).partial ?? results;
  return new QueryError(message, [...done], done.length, refusedAsReadOnly(err as never));
}

// ---------- through SSH ----------

/** Whether this run goes through an SSH tunnel (not for SQLite, a file on this machine). */
const tunneled = (c: DbConnection) => !!c.ssh?.enabled && c.driver !== 'sqlite';

/**
 * Runs `fn` with the connection reached through its SSH tunnel: a copy pointed at the tunnel's local port (without the
 * SSH settings, so nothing inside opens another). `trustNew`: testing, a server key not trusted yet is accepted and
 * handed to `onKey`.
 */
async function withTunnel<T>(c: DbConnection, fn: (t: DbConnection) => Promise<T>, trustNew = false, onKey?: (key: string) => void): Promise<T> {
  const ssh = c.ssh!;
  if (!ssh.host || !ssh.user) throw new Error('the SSH tunnel needs a host and a user');
  if (/^(mongodb(\+srv)?|rediss?):\/\//i.test(c.host)) throw new Error('through SSH, give the database\'s host and port rather than a URI');
  const t = await openTunnel(ssh, { host: c.host || 'localhost', port: c.port || DEFAULT_PORT[c.driver] }, { trustNew });
  onKey?.(t.hostKey);
  try {
    return await fn({ ...c, host: t.host, port: t.port, ssh: undefined, tunneledFrom: c.host || 'localhost' });
  } finally { await t.close(); }
}

/** Runs every statement of `script` in turn and stops at the first error (a QueryError with the results so far). */
export async function runScript(c: DbConnection, script: string, o: RunOpts): Promise<QueryResult[]> {
  if (tunneled(c)) {
    try { return await withTunnel(c, (t) => runScript(t, script, o)); } catch (e) { throw withResults(e, [], o); }
  }
  const statements = statementsOf(script, c.driver);
  if (!statements.length) throw new QueryError('nothing to run', [], 0);
  if (statements.length > MAX_STATEMENTS) throw new QueryError(`at most ${MAX_STATEMENTS} statements at a time`, [], 0);
  if (c.driver === 'postgres') return pgScript(c, statements, o);
  if (c.driver === 'sqlite') return sqliteScript(c, statements, o);
  if (isNoSql(c.driver)) {
    try { return await (c.driver === 'mongodb' ? mongoScript : redisScript)(c, statements, o); } catch (e) { throw withResults(e, [], o); }
  }
  return myScript(c, statements, o);
}

/** Whether the connection opens databases other than its own. */
export const multiDatabase = (c: DbConnection) => c.driver === 'postgres' && c.allDatabases === true;

/**
 * The connection pointed at database `db` (none, or its own: the connection as it is). PostgreSQL: only where the
 * connection opens every database. MySQL/MariaDB: any (it is the default database a session starts in; the user's
 * grants say which it may use, as they do for `db.table` anyway).
 */
export function onDatabase(c: DbConnection, db?: string): DbConnection {
  if (!db || db === c.database || (multiDatabase(c) && !c.database && db === 'postgres')) return c;
  if (!multiDatabase(c) && !isMy(c.driver) && !isNoSql(c.driver)) throw new Error(`${c.id} opens only its own database`);
  return { ...c, database: db };
}

/** The databases a connection may open: its own, or (allDatabases) those on the server it may connect to. */
export async function listDatabases(c: DbConnection): Promise<string[]> {
  if (tunneled(c) && multiDatabase(c)) return withTunnel(c, listDatabases);
  if (!multiDatabase(c)) return [c.database];
  const [r] = await runScript(c, 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname',
    { readOnly: true, limit: 10_000, timeoutMs: 15_000 });
  const own = c.database || 'postgres';
  const names = r!.rows.map((row) => String(row[0]));
  return names.includes(own) ? names : [own, ...names];
}

/**
 * The server's version, to show that the connection works, and what about its user deserves a warning: rights that
 * reach past the tables (superuser, server files, other sessions). Read-only does not take those away.
 */
export async function testConnection(c: DbConnection): Promise<{ version: string; warnings: string[]; sshHostKey?: string }> {
  // Testing is where an SSH server's key is first seen and shown, to be trusted when the connection is saved.
  if (tunneled(c)) {
    let sshHostKey = '';
    // Any key is accepted here (the one trusted is compared below), so a server whose key changed can be trusted again.
    const r = await withTunnel({ ...c, ssh: { ...c.ssh!, hostKey: '' } }, testConnection, true, (k) => { sshHostKey = k; });
    const was = c.ssh!.hostKey;
    const warnings = was && was !== sshHostKey
      ? [`The SSH server's key changed: it is ${sshHostKey}, and ${was} was trusted. If you did not expect that (a reinstalled server), someone may be in between: do not save.`, ...r.warnings]
      : r.warnings;
    return { ...r, warnings, sshHostKey };
  }
  if (c.driver === 'mongodb') return mongoTest(c);
  if (c.driver === 'redis') return redisTest(c);
  const o: RunOpts = { readOnly: true, limit: 200, timeoutMs: 15_000 };
  const sql = c.driver === 'postgres' ? 'SELECT version()' : c.driver === 'sqlite' ? 'SELECT \'SQLite \' || sqlite_version()' : 'SELECT VERSION()';
  const [r] = await runScript(c, sql, o);
  const v = String(r?.rows[0]?.[0] ?? '');
  const version = c.driver === 'mysql' || c.driver === 'mariadb' ? (/mariadb/i.test(v) ? `MariaDB ${v}` : `MySQL ${v}`) : v;
  const warnings: string[] = [];
  try {
    if (c.driver === 'postgres') {
      const [p] = await runScript(c, `SELECT r.rolsuper, r.rolcreaterole,
        pg_has_role(current_user, 'pg_read_server_files', 'MEMBER') OR pg_has_role(current_user, 'pg_write_server_files', 'MEMBER')
          OR pg_has_role(current_user, 'pg_execute_server_program', 'MEMBER')
        FROM pg_roles r WHERE r.rolname = current_user`, o);
      const [sup, roles, files] = p?.rows[0] ?? [];
      if (sup === true) warnings.push('This user is a superuser: it can read and write server files and run programs on the database server (COPY ... PROGRAM), read-only or not.');
      else if (files === true) warnings.push('This user may read or write server files or run programs on the database server (pg_read_server_files, pg_write_server_files or pg_execute_server_program).');
      if (roles === true && sup !== true) warnings.push('This user may create roles.');
    } else if (c.driver !== 'sqlite') {
      const [g] = await runScript(c, 'SHOW GRANTS', o);
      const grants = (g?.rows ?? []).map((row) => String(row[0])).filter((s) => /\bON \*\.\*/i.test(s));
      if (grants.some((s) => /GRANT ALL PRIVILEGES ON \*\.\*/i.test(s))) warnings.push('This user has ALL PRIVILEGES on every database, server files and other sessions included.');
      else {
        if (grants.some((s) => /\bFILE\b/.test(s))) warnings.push('This user has FILE: it can read and write files on the database server (LOAD_FILE, INTO OUTFILE).');
        if (grants.some((s) => /\bSUPER\b/.test(s))) warnings.push('This user has SUPER: it can change server settings and stop other sessions.');
      }
    }
  } catch { /* no warning without the catalog */ }
  return { version, warnings };
}

// ---------- schema ----------

/** A database with at most this many tables gets its columns with its table list; a bigger one, schema by schema. */
export const INLINE_COLUMNS = 400;
/** The table list stops here (a catalog that size is not browsed by hand). */
const MAX_TABLES = 100_000;
const SYSTEM_SCHEMAS: Record<Driver, string[]> = {
  postgres: ['pg_catalog', 'information_schema', 'pg_toast'],
  mysql: ['mysql', 'information_schema', 'performance_schema', 'sys'],
  mariadb: ['mysql', 'information_schema', 'performance_schema', 'sys'],
  sqlite: [],
  mongodb: [],
  redis: [],
};

/** A string literal for a catalog query (MySQL and MariaDB read backslashes as escapes). */
const catalogLiteral = (driver: Driver, s: string) => `'${(isMy(driver) ? s.replace(/\\/g, '\\\\') : s).replace(/'/g, '\'\'')}'`;

/**
 * Tables and views, from information_schema (or SQLite's own catalog). With `schema`, only that schema, with its
 * columns. Without, every schema: with columns when there are at most INLINE_COLUMNS tables, else names only (each
 * schema `loaded: false`; ask again with `schema` for its columns).
 */
export async function readSchema(c: DbConnection, timeoutMs = 30_000, only?: string): Promise<SchemaInfo> {
  if (tunneled(c)) return withTunnel(c, (t) => readSchema(t, timeoutMs, only));
  if (c.driver === 'mongodb') return mongoSchema(c, timeoutMs, only);
  if (c.driver === 'redis') return redisSchema(c, timeoutMs, only);
  const o: RunOpts = { readOnly: true, limit: MAX_TABLES * 50, timeoutMs, maxCell: 500 };
  if (c.driver === 'sqlite') {
    const db = sqliteOpen(c, true, timeoutMs);
    try {
      if (only && only !== 'main') return { schemas: [] };
      const tables = (db.prepare('SELECT name, type FROM sqlite_master WHERE type IN (\'table\', \'view\') AND name NOT LIKE \'sqlite_%\' ORDER BY name').all() as { name: string; type: string }[]).slice(0, MAX_TABLES);
      const withColumns = !!only || tables.length <= INLINE_COLUMNS;
      return { schemas: [{ name: 'main', loaded: withColumns, tables: tables.map((t) => ({
        name: t.name, kind: t.type === 'view' ? 'view' as const : 'table' as const,
        columns: withColumns ? (db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as any[])
          .map((col) => ({ name: col.name, type: col.type || '', nullable: !col.notnull, pk: col.pk > 0 })) : [],
      })) }] };
    } finally { db.close(); }
  }
  const skip = SYSTEM_SCHEMAS[c.driver].map((s) => `'${s}'`).join(',');
  const my = isMy(c.driver);
  // One schema; else MySQL: only the database named in the connection, if one is.
  const where = only ? `table_schema = ${catalogLiteral(c.driver, only)}` : my && c.database ? 'table_schema = DATABASE()' : `table_schema NOT IN (${skip})`;
  const [tables] = await runScript(c, `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE ${where} ORDER BY table_schema, table_name`, { ...o, limit: MAX_TABLES });
  const bySchema = new Map<string, Map<string, SchemaTable>>();
  for (const [schema, name, type] of tables!.rows as string[][]) {
    if (!bySchema.has(schema!)) bySchema.set(schema!, new Map());
    bySchema.get(schema!)!.set(name!, { name: name!, kind: /view/i.test(type!) ? 'view' : 'table', columns: [] });
  }
  const withColumns = !!only || tables!.rows.length <= INLINE_COLUMNS;
  if (withColumns) {
    const [columns, keys] = await runScript(c, [
      `SELECT table_schema, table_name, column_name, ${my ? 'column_type' : 'data_type'}, is_nullable FROM information_schema.columns WHERE ${where} ORDER BY table_schema, table_name, ordinal_position`,
      my
        ? `SELECT table_schema, table_name, column_name FROM information_schema.key_column_usage WHERE constraint_name = 'PRIMARY' AND ${where}`
        : `SELECT k.table_schema, k.table_name, k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k
             ON k.constraint_name = t.constraint_name AND k.table_schema = t.table_schema AND k.table_name = t.table_name
           WHERE t.constraint_type = 'PRIMARY KEY' AND t.${where}`,
    ].join(';\n'), o);
    const pk = new Set(keys!.rows.map((r) => r.slice(0, 3).join('\u0000')));
    for (const [schema, table, name, type, nullable] of columns!.rows as string[][]) {
      bySchema.get(schema!)?.get(table!)?.columns.push({
        name: name!, type: type!, nullable: nullable === 'YES', pk: pk.has([schema, table, name].join('\u0000')),
      });
    }
  }
  return { schemas: [...bySchema].map(([name, t]) => ({ name, loaded: withColumns, tables: [...t.values()] })) };
}

// ---------- editing rows (the result grid) ----------

/** A change to one row of a table, found by its primary key (column -> value as text, null for NULL). */
export type RowEdit =
  | { kind: 'update'; key: Record<string, string | null>; set: Record<string, string | null> }
  | { kind: 'insert'; values: Record<string, string | null> }
  | { kind: 'delete'; key: Record<string, string | null> };

const isMy = (d: Driver) => d === 'mysql' || d === 'mariadb';
export const quoteIdent = (driver: Driver, name: string) => (isMy(driver) ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`);

/** The statement for one edit, with its values as parameters (never in the SQL text). `one`: it must touch one row. */
function editSql(driver: Driver, ref: string, e: RowEdit, inline = false): { sql: string; params: (string | null)[]; one: boolean } {
  const q = (n: string) => quoteIdent(driver, n);
  const params: (string | null)[] = [];
  // `inline` (the preview): the value as a literal where the parameter would be.
  const p = (v: string | null) => {
    if (inline) return literal(driver, v);
    params.push(v);
    return driver === 'postgres' ? `$${params.length}` : '?';
  };
  const where = (key: Record<string, string | null>) => {
    const parts = Object.entries(key);
    if (!parts.length) throw new Error('a row is changed through its primary key, and none was given');
    return parts.map(([k, v]) => (v === null ? `${q(k)} IS NULL` : `${q(k)} = ${p(v)}`)).join(' AND ');
  };
  if (e.kind === 'update') {
    const set = Object.entries(e.set);
    if (!set.length) throw new Error('an update changes at least one column');
    const assign = set.map(([k, v]) => `${q(k)} = ${p(v)}`).join(', ');
    return { sql: `UPDATE ${ref} SET ${assign} WHERE ${where(e.key)}`, params, one: true };
  }
  if (e.kind === 'delete') return { sql: `DELETE FROM ${ref} WHERE ${where(e.key)}`, params, one: true };
  const cols = Object.entries(e.values);
  if (!cols.length) return { sql: isMy(driver) ? `INSERT INTO ${ref} () VALUES ()` : `INSERT INTO ${ref} DEFAULT VALUES`, params, one: false };
  return { sql: `INSERT INTO ${ref} (${cols.map(([k]) => q(k)).join(', ')}) VALUES (${cols.map(([, v]) => p(v)).join(', ')})`, params, one: false };
}

/** A value as an SQL literal, for showing (MySQL and MariaDB read a backslash in a string as an escape). */
function literal(driver: Driver, v: string | null): string {
  if (v === null) return 'NULL';
  const s = v.replace(/'/g, '\'\'');
  return `'${isMy(driver) ? s.replace(/\\/g, '\\\\') : s}'`;
}

const tableRef = (c: DbConnection, schema: string, table: string) => `${quoteIdent(c.driver, schema)}.${quoteIdent(c.driver, table)}`;

/**
 * The statements `editRows` would run for these edits, with the values written in as literals (it sends them as
 * parameters), for the panel to show before saving.
 */
export function previewEdits(c: DbConnection, schema: string, table: string, edits: RowEdit[]): string[] {
  if (isNoSql(c.driver)) throw new Error('rows are edited in SQL databases only');
  return edits.map((e) => `${editSql(c.driver, tableRef(c, schema, table), e, true).sql};`);
}

/**
 * Applies the edits to `schema.table` in one transaction: all of them or none. An update or delete that does not hit
 * exactly one row undoes everything. Returns how many rows changed.
 */
export async function editRows(c: DbConnection, schema: string, table: string, edits: RowEdit[]): Promise<number> {
  if (tunneled(c)) return withTunnel(c, (t) => editRows(t, schema, table, edits));
  if (isNoSql(c.driver)) throw new Error('rows are edited in SQL databases only');
  const ref = tableRef(c, schema, table);
  const stmts = edits.map((e) => editSql(c.driver, ref, e));
  const check = (i: number, n: number) => {
    if (stmts[i]!.one && n !== 1) throw new Error(`change ${i + 1} matched ${n} rows instead of 1, so nothing was saved (was the row changed or deleted meanwhile?)`);
  };
  let total = 0;
  if (c.driver === 'postgres') {
    const client = pgClient(c, 30_000);
    try {
      await client.connect();
      await client.query('BEGIN');
      for (const [i, s] of stmts.entries()) {
        const r = await client.query(s.sql, s.params);
        check(i, r.rowCount ?? 0);
        total += r.rowCount ?? 0;
      }
      await client.query('COMMIT');
      return total;
    } catch (e) { await client.query('ROLLBACK').catch(() => {}); throw e; } finally { await client.end().catch(() => {}); }
  }
  if (c.driver === 'sqlite') {
    const db = sqliteOpen(c, false, 30_000);
    try {
      db.exec('BEGIN');
      for (const [i, s] of stmts.entries()) {
        const n = Number(db.prepare(s.sql).run(...s.params).changes);
        check(i, n);
        total += n;
      }
      db.exec('COMMIT');
      return total;
    } catch (e) { try { db.exec('ROLLBACK'); } catch { /* not in a transaction */ } throw e; } finally { db.close(); }
  }
  const conn = myConnection(c);
  const run = (sql: string, params: unknown[] = []) => new Promise<number>((res, rej) =>
    conn.query(sql, params, (err, r: any) => (err ? rej(err) : res(Number(r?.affectedRows ?? 0)))));
  try {
    await myConnect(conn);
    await run('START TRANSACTION');
    for (const [i, s] of stmts.entries()) {
      const n = await run(s.sql, s.params);
      check(i, n);
      total += n;
    }
    await run('COMMIT');
    return total;
  } catch (e) { await run('ROLLBACK').catch(() => {}); throw e; } finally { conn.destroy(); }
}

// ---------- DDL ----------

/** The CREATE statement(s) of a table or view: as the server gives them (MySQL, SQLite) or rebuilt from the catalog. */
export async function readDdl(c: DbConnection, schema: string, name: string): Promise<string> {
  if (tunneled(c)) return withTunnel(c, (t) => readDdl(t, schema, name));
  if (c.driver === 'mongodb') return mongoDdl(c, schema, name);
  if (c.driver === 'redis') throw new Error('Redis keys have no DDL');
  const q = (n: string) => quoteIdent(c.driver, n);
  if (c.driver === 'sqlite') {
    const db = sqliteOpen(c, true, 10_000);
    try {
      const rows = db.prepare('SELECT type, sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type = \'table\' DESC, type = \'view\' DESC, name').all(name) as { sql: string }[];
      if (!rows.length) throw new Error(`no such table: ${name}`);
      return `${rows.map((r) => r.sql.trim()).join(';\n\n')};\n`;
    } finally { db.close(); }
  }
  if (isMy(c.driver)) {
    const [r] = await runScript(c, `SHOW CREATE TABLE ${q(schema)}.${q(name)}`, { readOnly: true, limit: 1, timeoutMs: 15_000, maxCell: 1_000_000 });
    return `${String(r?.rows[0]?.[1] ?? '')};\n`;
  }
  const client = pgClient(c, 15_000);
  try {
    await client.connect();
    await client.query('BEGIN TRANSACTION READ ONLY');
    const ask = async (sql: string, values: unknown[]) => (await client.query({ text: sql, values, rowMode: 'array' })).rows as unknown[][];
    const [rel] = await ask('SELECT c.oid::int, c.relkind FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2', [schema, name]);
    if (!rel) throw new Error(`no such table: ${schema}.${name}`);
    const [oid, kind] = rel as [number, string];
    const ref = `${q(schema)}.${q(name)}`;
    if (kind === 'v' || kind === 'm') {
      const [[def]] = await ask('SELECT pg_get_viewdef($1::oid, true)', [oid]) as [[string]];
      return `CREATE ${kind === 'm' ? 'MATERIALIZED ' : ''}VIEW ${ref} AS\n${String(def).trim()}\n`;
    }
    const cols = await ask(`SELECT a.attname, format_type(a.atttypid, a.atttypmod), a.attnotnull, pg_get_expr(d.adbin, d.adrelid), a.attidentity, a.attgenerated
      FROM pg_attribute a LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
      WHERE a.attrelid = $1 AND a.attnum > 0 AND NOT a.attisdropped ORDER BY a.attnum`, [oid]);
    const lines = cols.map(([col, type, notNull, def, identity, generated]) => {
      let line = `  ${q(String(col))} ${type}`;
      if (identity === 'a' || identity === 'd') line += ` GENERATED ${identity === 'a' ? 'ALWAYS' : 'BY DEFAULT'} AS IDENTITY`;
      else if (generated === 's' && def) line += ` GENERATED ALWAYS AS (${def}) STORED`;
      else if (def) line += ` DEFAULT ${def}`;
      return notNull ? `${line} NOT NULL` : line;
    });
    // PostgreSQL 18 also lists NOT NULL as constraints ('n'); the columns already say it.
    const cons = await ask('SELECT conname, pg_get_constraintdef(oid, true) FROM pg_constraint WHERE conrelid = $1 AND contype <> \'n\' ORDER BY contype <> \'p\', conname', [oid]);
    lines.push(...cons.map(([n, def]) => `  CONSTRAINT ${q(String(n))} ${def}`));
    const idx = await ask(`SELECT pg_get_indexdef(i.indexrelid) FROM pg_index i
      WHERE i.indrelid = $1 AND NOT EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = i.indexrelid) ORDER BY 1`, [oid]);
    const [[comment]] = await ask('SELECT obj_description($1::oid, \'pg_class\')', [oid]) as [[string | null]];
    return [`CREATE TABLE ${ref} (\n${lines.join(',\n')}\n);`, ...idx.map(([d]) => `${d};`),
      ...(comment ? [`COMMENT ON TABLE ${ref} IS '${String(comment).replace(/'/g, '\'\'')}';`] : [])].join('\n\n') + '\n';
  } finally { await client.end().catch(() => {}); }
}

// ---------- what agents may not run ----------

/**
 * Statements an agent is refused whatever the connection allows: they reach past the database's tables (server files,
 * programs, server settings, other sessions, other databases). Read-only does not stop all of them, so they are refused
 * before reaching the database. A list cannot be complete; a user without such rights is the real limit.
 */
const AGENT_REFUSED: [RegExp, string][] = [
  [/^\s*copy\b/i, 'COPY (server files and programs)'],
  [/\binto\s+(out|dump)file\b/i, 'INTO OUTFILE / DUMPFILE (server files)'],
  [/^\s*vacuum\b[\s\S]*\binto\b/i, 'VACUUM INTO (writes a file)'],
  [/^\s*(attach|detach)\b/i, 'ATTACH / DETACH (other database files)'],
  [/^\s*load\b/i, 'LOAD (files and extensions)'],
  [/^\s*(kill|shutdown|install\s+plugin|alter\s+system)\b/i, 'server administration'],
  [/^\s*create\s+(or\s+replace\s+)?(extension|language)\b/i, 'CREATE EXTENSION / LANGUAGE'],
  [/\bset\s+(global|persist|persist_only)\b|@@global\./i, 'SET GLOBAL (server settings)'],
  [/\b(pg_read_file|pg_read_binary_file|pg_ls_dir|pg_ls_\w+dir|pg_stat_file|pg_file_write|lo_import|lo_export|dblink\w*|pg_terminate_backend|pg_cancel_backend|pg_reload_conf|pg_rotate_logfile|pg_promote|query_to_xml\w*|cursor_to_xml\w*|load_file|load_extension|sys_exec|sys_eval)\s*\(/i, 'functions that reach files, programs or other sessions'],
];
/** Only while read-only: DO blocks run SQL built from strings, past the checks above. */
const AGENT_REFUSED_READ_ONLY: [RegExp, string][] = [[/^\s*do\b/i, 'DO blocks']];

/** Why an agent may not run this script, or null. */
export function agentRefusal(script: string, driver: Driver, readOnly: boolean): string | null {
  if (isNoSql(driver)) return noSqlAgentRefusal(statementsOf(script, driver), driver);
  const rules = readOnly ? [...AGENT_REFUSED, ...AGENT_REFUSED_READ_ONLY] : AGENT_REFUSED;
  for (const sql of statementsOf(script, driver)) {
    const hit = rules.find(([re]) => re.test(sql));
    if (hit) return `refused for agents: ${hit[1]}. Ask a human to run it in the SQL editor if it is needed.`;
  }
  return null;
}

// ---------- statements that hit every row ----------

/** An UPDATE or DELETE without a WHERE, or a TRUNCATE: it hits every row of `table` (as written in the statement). */
export interface UnsafeStatement { index: number; sql: string; kind: 'update' | 'delete' | 'truncate'; table: string }

/**
 * The statement with string literals, comments and everything inside parentheses blanked out, so only its top level
 * is left to read (a WHERE in a subquery or a string does not count). Quoted identifiers stay. `nested`: what is inside
 * parentheses (and the parentheses) stays too; only strings and comments are blanked.
 */
function topLevel(sql: string, driver: Driver, nested = false): string {
  const my = isMy(driver);
  let out = '';
  let depth = 0;
  let i = 0;
  const n = sql.length;
  const blank = (s: string) => s.replace(/[^\n]/g, ' ');
  const put = (s: string) => { out += depth > 0 && !nested ? blank(s) : s; };
  while (i < n) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    let end = -1;
    if ((ch === '-' && next === '-') || (my && ch === '#')) { const nl = sql.indexOf('\n', i); end = nl < 0 ? n : nl; }
    else if (ch === '/' && next === '*') { const close = sql.indexOf('*/', i + 2); end = close < 0 ? n : close + 2; }
    else if (ch === '\'') {
      const escapes = my || (driver === 'postgres' && /[Ee]/.test(sql[i - 1] ?? '') && !/\w/.test(sql[i - 2] ?? ''));
      let j = i + 1;
      while (j < n) {
        if (escapes && sql[j] === '\\') { j += 2; continue; }
        if (sql[j] === '\'') { if (sql[j + 1] === '\'') { j += 2; continue; } break; }
        j++;
      }
      end = Math.min(j + 1, n);
    } else if (ch === '$' && driver === 'postgres' && !/\w/.test(sql[i - 1] ?? '')) {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i, i + 64));
      if (m) { const close = sql.indexOf(m[0], i + m[0].length); end = close < 0 ? n : close + m[0].length; }
    } else if (ch === '"' || (my && ch === '`')) {
      // A quoted identifier: kept (the table's name may be one).
      let j = i + 1;
      while (j < n) { if (sql[j] === ch) { if (sql[j + 1] === ch) { j += 2; continue; } break; } j++; }
      put(sql.slice(i, Math.min(j + 1, n)));
      i = Math.min(j + 1, n);
      continue;
    }
    if (end >= 0) { out += blank(sql.slice(i, end)); i = end; continue; }
    if (ch === '(') { depth++; out += nested ? ch : ' '; } else if (ch === ')') { depth = Math.max(0, depth - 1); out += nested ? ch : ' '; } else put(ch);
    i++;
  }
  return out;
}

const NAME = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|[\w$]+)(?:\s*\.\s*(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|[\w$]+))*`;
/**
 * A statement's own verb and what follows it. After a WITH it is the first verb at the top level (the CTEs' bodies are
 * blanked out), so the DO UPDATE of an INSERT's ON CONFLICT is not taken for it.
 */
const VERB = /^\s*(?:with\s+(?:recursive\s+)?[\s\S]*?\b(?=(?:update|delete|insert|select|merge|values|replace)\b))?(\w+)\b([\s\S]*)$/i;
const CHANGES_ALL = new Set(['update', 'delete', 'truncate']);
const UPDATE_TABLE = new RegExp(String.raw`^\s*(?:only\s+)?(?:(?:low_priority|ignore)\s+)*(${NAME})`, 'i');
const DELETE_TABLE = new RegExp(String.raw`^\s*(?:(?:low_priority|quick|ignore)\s+)*(?:from\s+)?(?:only\s+)?(${NAME})`, 'i');
const TRUNCATE_TABLE = new RegExp(String.raw`^\s*(?:table\s+)?(?:only\s+)?(${NAME})`, 'i');

/** The statements of a script that hit every row of a table: UPDATE or DELETE without a WHERE, and TRUNCATE. */
export function findUnsafe(script: string, driver: Driver): UnsafeStatement[] {
  if (isNoSql(driver)) return noSqlUnsafe(statementsOf(script, driver), driver);
  const out: UnsafeStatement[] = [];
  statementsOf(script, driver).forEach((sql, index) => {
    const m = VERB.exec(topLevel(sql, driver));
    if (!m || !CHANGES_ALL.has(m[1]!.toLowerCase())) return;
    const kind = m[1]!.toLowerCase() as UnsafeStatement['kind'];
    const rest = m[2]!;
    if (kind !== 'truncate' && /\bwhere\b/i.test(rest)) return;
    const re = kind === 'update' ? UPDATE_TABLE : kind === 'delete' ? DELETE_TABLE : TRUNCATE_TABLE;
    out.push({ index, sql, kind, table: re.exec(rest)?.[1]?.trim() ?? '?' });
  });
  return out;
}

/** How many rows `table` (a name as findUnsafe read it) has now, or null when that cannot be read quickly. */
export async function countRows(c: DbConnection, table: string): Promise<number | null> {
  if (isNoSql(c.driver)) {
    // A collection's documents; a Redis database's keys (FLUSHALL: every database's, not counted).
    if (c.driver === 'redis' && table !== 'this database') return null;
    const sql = c.driver === 'redis' ? 'DBSIZE' : table === 'the database' ? '' : `db.getCollection(${JSON.stringify(table)}).countDocuments({})`;
    if (!sql) return null;
    try { return Number((await runScript(c, sql, { readOnly: true, limit: 1, timeoutMs: 5000 }))[0]?.rows[0]?.[0] ?? NaN); } catch { return null; }
  }
  if (!new RegExp(`^${NAME}$`).test(table)) return null;
  try {
    const [r] = await runScript(c, `SELECT count(*) FROM ${table}`, { readOnly: true, limit: 1, timeoutMs: 5000 });
    return Number(r?.rows[0]?.[0] ?? NaN);
  } catch { return null; }
}

/** "DELETE FROM users without WHERE", for messages. */
export const describeUnsafe = (u: UnsafeStatement) => (u.kind === 'truncate' ? `TRUNCATE ${u.table}` : `${u.kind.toUpperCase()} on ${u.table} without WHERE`);

// ---------- what a write is about to change (backups) ----------

/**
 * A read of the rows one statement of a write is about to change or remove: `read` is a SELECT (MongoDB: the find, as
 * text; `filter`, `sort` and `limit` are what runs: a write of one document reads one). `optional`: a table that is
 * not there does not stop the write (DROP TABLE IF EXISTS).
 */
export interface BackupRead {
  index: number; statement: string; table: string; read: string; optional?: boolean; filter?: object; sort?: object; limit?: number;
}
/** The reads a backup takes, and the statements that change data it cannot read beforehand (described). */
export interface BackupPlan { reads: BackupRead[]; skipped: string[] }
/** What one read kept: rows (SQL) or documents (MongoDB, as canonical Extended JSON). */
export type BackupTable = Omit<BackupRead, 'filter' | 'sort' | 'limit' | 'optional'> & { columns?: string[]; rows?: unknown[][]; documents?: unknown[]; error?: string };

const ALIAS = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|[\w$]+)`;
/** A target of one table, with its alias if any: `[ONLY] name [*] [[AS] alias]`. */
const SINGLE_TARGET = new RegExp(String.raw`^\s*(?:only\s+)?(${NAME})\s*\*?(?:\s+(?:as\s+)?(${ALIAS}))?\s*$`, 'i');
const DROP_TABLE = /^\s*drop\s+table\s+(if\s+exists\s+)?/i;
/**
 * Writes that change rows already there in ways no SELECT before them can single out, by the statement's verb and what
 * follows it: MERGE, REPLACE, upserts (INSERT OR REPLACE, ON CONFLICT DO UPDATE, ON DUPLICATE KEY UPDATE), ALTER ... DROP.
 */
const UNREADABLE: Record<string, RegExp> = {
  merge: /^/, replace: /^/,
  insert: /^\s*or\s+replace\b|\bon\s+(?:conflict\b[\s\S]*\bdo\s+update|duplicate\s+key\s+update)\b/i,
  alter: /^\s*table\b[\s\S]*\bdrop\b/i,
};
/** A table that is not there, as PostgreSQL, MySQL/MariaDB and SQLite say it. */
const NO_SUCH_TABLE = /\brelation\b[\s\S]*\bdoes not exist\b|\btable\b[\s\S]*\bdoesn't exist\b|\bno such table\b/i;

/**
 * The SELECTs that read what a script's UPDATE, DELETE, TRUNCATE and DROP TABLE statements are about to change (the
 * same WHERE, joins and CTEs), and the writes it cannot read that way. Inserts change nothing that was there.
 */
export function planBackup(script: string, driver: Driver): BackupPlan {
  if (isNoSql(driver)) return noSqlBackupPlan(statementsOf(script, driver), driver);
  const my = isMy(driver);
  const reads: BackupRead[] = [];
  const skipped: string[] = [];
  statementsOf(script, driver).forEach((full, index) => {
    const sql = full.replace(/;\s*$/, '');
    // Same length as `sql`, so a position in one is the same in the other.
    const top = topLevel(sql, driver);
    const at = (re: RegExp, from: number, to = top.length) => {
      const g = new RegExp(re.source, 'gi');
      g.lastIndex = from;
      const m = g.exec(top);
      return m && m.index < to ? m.index : -1;
    };
    const first = (...xs: number[]) => Math.min(...xs.filter((x) => x >= 0), top.length);
    const add = (table: string, read: string, optional = false) => reads.push({ index, statement: full, table: table.trim(), read, ...(optional && { optional }) });
    const skip = (why: string) => skipped.push(`statement ${index + 1} (${why}): ${sql.replace(/\s+/g, ' ').slice(0, 120)}`);
    /** `alias.*` for one table (so a join's other columns stay out), else every column. */
    const columns = (target: string) => {
      const m = SINGLE_TARGET.exec(target);
      return m ? `${m[2] ?? m[1]}.*` : '*';
    };
    const drop = DROP_TABLE.exec(top);
    if (drop) {
      const rest = top.slice(drop[0].length).replace(/\b(cascade|restrict)\b/gi, '');
      for (const t of rest.split(',').map((x) => x.trim()).filter(Boolean)) add(t, `SELECT * FROM ${t}`, !!drop[1]);
      return;
    }
    const m = VERB.exec(top);
    if (!m) return;
    const verb = m[1]!.toLowerCase();
    const verbEnd = top.length - m[2]!.length;
    // A WITH before it stays in front of the SELECT.
    const prefix = sql.slice(0, verbEnd - verb.length);
    // PostgreSQL: CTEs that write (WITH d AS (DELETE ... RETURNING *) ...) cannot run in a read-only SELECT.
    if (/^\s*with\b/i.test(top) && /\(\s*(?:insert|update|delete|merge)\b/i.test(topLevel(prefix, driver, true))) {
      skip('a WITH whose queries write: what they change cannot be read beforehand');
      return;
    }
    if (UNREADABLE[verb]?.test(m[2]!)) { skip('an upsert, MERGE, REPLACE or ALTER ... DROP: what it changes cannot be read beforehand'); return; }
    if (!CHANGES_ALL.has(verb)) return;
    const end = first(at(/\breturning\b/, verbEnd));
    if (verb === 'truncate') {
      const optsAt = first(at(/\b(restart|continue|cascade|restrict)\b/, verbEnd));
      const list = sql.slice(verbEnd, optsAt).replace(/^\s*table\b/i, '');
      for (const t of list.split(',').map((x) => x.trim().replace(/^only\s+/i, '').replace(/\s*\*$/, '')).filter(Boolean)) add(t, `SELECT * FROM ${t}`);
      if (/\bcascade\b/i.test(top.slice(optsAt))) skip('CASCADE also empties the tables that refer to it; those are not backed up');
      return;
    }
    if (verb === 'update') {
      const setAt = at(/\bset\b/, verbEnd);
      if (setAt < 0) { skip('no SET found'); return; }
      const target = sql.slice(verbEnd, setAt).replace(/^\s*(?:or\s+(?:rollback|abort|replace|fail|ignore)\s+)?(?:(?:low_priority|ignore)\s+)*/i, '').trim();
      // PostgreSQL and SQLite: UPDATE ... SET ... FROM others.
      const fromAt = my ? -1 : at(/\bfrom\b/, setAt, end);
      const condAt = at(/\b(where|order\s+by|limit)\b/, Math.max(setAt, fromAt), end);
      const from = fromAt >= 0 ? sql.slice(fromAt + 4, condAt >= 0 ? condAt : end).trim() : '';
      const cond = condAt >= 0 ? sql.slice(condAt, end).trim() : '';
      add(SINGLE_TARGET.exec(target)?.[1] ?? target, `${prefix}SELECT ${columns(target)} FROM ${target}${from ? `, ${from}` : ''}${cond ? ` ${cond}` : ''}`);
      return;
    }
    const fromAt = at(/\bfrom\b/, verbEnd, end);
    if (fromAt < 0) { skip('no FROM found'); return; }
    const condAt = at(/\b(where|order\s+by|limit)\b/, fromAt, end);
    const bodyEnd = condAt >= 0 ? condAt : end;
    const usingAt = at(/\busing\b/, fromAt, bodyEnd);
    const cond = condAt >= 0 ? sql.slice(condAt, end).trim() : '';
    const named = sql.slice(verbEnd, fromAt).replace(/^\s*(?:(?:low_priority|quick|ignore)\s+)*/i, '').trim();
    const target = sql.slice(fromAt + 4, usingAt >= 0 ? usingAt : bodyEnd).trim();
    const using = usingAt >= 0 ? sql.slice(usingAt + 5, bodyEnd).trim() : '';
    // MySQL's multi-table forms: DELETE t1, t2 FROM <joins> and DELETE FROM t1, t2 USING <joins>.
    const listed = (list: string) => list.split(',').map((x) => `${x.trim().replace(/\.\*$/, '')}.*`).join(', ');
    let read: string;
    if (named) read = `SELECT ${listed(named)} FROM ${target}`;
    else if (using && my) read = `SELECT ${listed(target)} FROM ${using}`;
    else read = `SELECT ${columns(target)} FROM ${target}${using ? `, ${using}` : ''}`;
    add(named || (SINGLE_TARGET.exec(target)?.[1] ?? target), `${prefix}${read}${cond ? ` ${cond}` : ''}`);
  });
  return { reads, skipped };
}

/**
 * Runs a backup's reads and keeps every row (no value cut). More than `cap` rows in all fails: such a write is too big to
 * back up here. A read that fails fails the backup, unless it is optional.
 */
export async function readBackup(c: DbConnection, plan: BackupPlan, cap: number, timeoutMs: number): Promise<BackupTable[]> {
  if (!plan.reads.length) return [];
  if (tunneled(c)) return withTunnel(c, (t) => readBackup(t, plan, cap, timeoutMs));
  const strip = ({ filter: _f, sort: _s, limit: _l, optional: _o, ...r }: BackupRead) => r;
  if (c.driver === 'mongodb') {
    const docs = await mongoBackupRead(c, plan.reads, cap, timeoutMs);
    return plan.reads.map((r, i) => ({ ...strip(r), documents: docs[i]! }));
  }
  const out: BackupTable[] = [];
  let total = 0;
  for (const r of plan.reads) {
    let res: QueryResult;
    try {
      [res] = await runScript(c, r.read, { readOnly: true, limit: cap - total, timeoutMs, maxCell: Infinity }) as [QueryResult];
    } catch (e) {
      // Only a table that is not there is passed over (DROP TABLE IF EXISTS): a timeout or a lost connection is not.
      if (!r.optional || !NO_SUCH_TABLE.test((e as Error).message)) throw new Error(`reading ${r.table} failed: ${(e as Error).message}`);
      out.push({ ...strip(r), error: (e as Error).message });
      continue;
    }
    total += res.rows.length;
    if (res.truncated) throw new Error(`it would change more than ${cap.toLocaleString('en')} rows`);
    out.push({ ...strip(r), columns: res.columns.map((col) => col.name), rows: res.rows });
  }
  return out;
}

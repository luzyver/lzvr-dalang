/**
 * The SQL editor's database connections and the drivers that run queries on them: PostgreSQL (and what speaks its
 * protocol), MySQL and MariaDB, and SQLite files. Every run opens its own connection and closes it afterwards.
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
import type { Store } from './store.js';
import type { ProjectAccess } from './util.js';

export const DRIVERS = ['postgres', 'mysql', 'mariadb', 'sqlite'] as const;
export type Driver = (typeof DRIVERS)[number];
/** What an agent may do on a connection (through the gateway's MCP tools). */
export const AGENT_MODES = ['off', 'read-only', 'read-write'] as const;
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
}
export interface SchemaColumn { name: string; type: string; nullable: boolean; pk: boolean }
export interface SchemaTable { name: string; kind: 'table' | 'view'; columns: SchemaColumn[] }
export interface SchemaInfo { schemas: { name: string; tables: SchemaTable[] }[] }

export interface RunOpts {
  readOnly: boolean;
  /** At most this many rows per statement. */
  limit: number;
  timeoutMs: number;
  /** Longer text values are cut. */
  maxCell?: number;
}

const KEY = 'db_connections';
export const DEFAULT_PORT: Record<Driver, number> = { postgres: 5432, mysql: 3306, mariadb: 3306, sqlite: 0 };
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
    const hex = Buffer.from(v.subarray(0, 256)).toString('hex');
    return `\\x${hex}${v.length > 256 ? '…' : ''}`;
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
    ssl: c.ssl === 'disable' ? false : { rejectUnauthorized: c.ssl === 'verify-full' },
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

async function pgScript(c: DbConnection, statements: string[], o: RunOpts): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  if (o.readOnly) {
    for (const sql of statements) {
      const client = pgClient(c, o.timeoutMs);
      try {
        await client.connect();
        await client.query('BEGIN TRANSACTION READ ONLY');
        results.push(await pgStatement(client, sql, o));
      } catch (e) { throw withResults(e, results); } finally { await client.end().catch(() => {}); }
    }
    return results;
  }
  const client = pgClient(c, o.timeoutMs);
  try {
    await client.connect();
    for (const sql of statements) results.push(await pgStatement(client, sql, o));
    return results;
  } catch (e) { throw withResults(e, results); } finally { await client.end().catch(() => {}); }
}

// ---------- MySQL / MariaDB ----------

function myConnection(c: DbConnection): mysql.Connection {
  return mysql.createConnection({
    host: c.host || 'localhost', port: c.port || DEFAULT_PORT[c.driver], user: c.user || undefined,
    password: c.password || undefined, database: c.database || undefined,
    ssl: c.ssl === 'disable' ? undefined : { rejectUnauthorized: c.ssl === 'verify-full' },
    connectTimeout: CONNECT_TIMEOUT_MS, dateStrings: true, supportBigNumbers: true, bigNumberStrings: true,
    multipleStatements: false,
  });
}

const myConnect = (conn: mysql.Connection) => new Promise<void>((res, rej) => conn.connect((e) => (e ? rej(e) : res())));
const myQuery = (conn: mysql.Connection, sql: string) => new Promise<void>((res, rej) => conn.query(sql, (e) => (e ? rej(e) : res())));

/** mysql2's column type numbers, by name (for the result header). */
const MY_TYPES = Object.fromEntries(Object.entries((mysql as any).Types ?? {}).map(([k, v]) => [v as number, k.toLowerCase()]));

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

async function myScript(c: DbConnection, statements: string[], o: RunOpts): Promise<QueryResult[]> {
  const results: QueryResult[] = [];
  let conn: mysql.Connection | null = null;
  const close = () => { if (conn) { const x = conn; conn = null; x.end(() => {}); x.destroy(); } };
  try {
    for (const sql of statements) {
      if (!conn) {
        conn = myConnection(c);
        await myConnect(conn);
        if (o.readOnly) await myQuery(conn, 'SET SESSION TRANSACTION READ ONLY');
      }
      const { dropped, ...r } = await myStatement(conn, sql, o);
      results.push(r);
      // A read-only run starts afresh for every statement (a statement may have changed the session); a dropped one must.
      if (dropped || o.readOnly) close();
    }
    return results;
  } catch (e) { throw withResults(e, results); } finally { close(); }
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
  } catch (e) { throw withResults(e, results); } finally { db.close(); }
}

// ---------- running ----------

/** A failed run: the error, the statement that failed (its index) and the results of those before it. */
export class QueryError extends Error {
  constructor(message: string, readonly results: QueryResult[], readonly index: number) { super(message); }
}
function withResults(e: unknown, results: QueryResult[]): QueryError {
  if (e instanceof QueryError) return e;
  const err = e as { message?: string; code?: string };
  return new QueryError(err.message || err.code || String(e), [...results], results.length);
}

/** Runs every statement of `script` in turn and stops at the first error (a QueryError with the results so far). */
export async function runScript(c: DbConnection, script: string, o: RunOpts): Promise<QueryResult[]> {
  const statements = statementsOf(script, c.driver);
  if (!statements.length) throw new QueryError('nothing to run', [], 0);
  if (statements.length > MAX_STATEMENTS) throw new QueryError(`at most ${MAX_STATEMENTS} statements at a time`, [], 0);
  if (c.driver === 'postgres') return pgScript(c, statements, o);
  if (c.driver === 'sqlite') return sqliteScript(c, statements, o);
  return myScript(c, statements, o);
}

/** Whether the connection opens databases other than its own. */
export const multiDatabase = (c: DbConnection) => c.driver === 'postgres' && c.allDatabases === true;

/**
 * The connection pointed at database `db` (none, or its own: the connection as it is). Refused unless the connection
 * opens every database.
 */
export function onDatabase(c: DbConnection, db?: string): DbConnection {
  if (!db || db === c.database || (multiDatabase(c) && !c.database && db === 'postgres')) return c;
  if (!multiDatabase(c)) throw new Error(`${c.id} opens only its own database`);
  return { ...c, database: db };
}

/** The databases a connection may open: its own, or (allDatabases) those on the server it may connect to. */
export async function listDatabases(c: DbConnection): Promise<string[]> {
  if (!multiDatabase(c)) return [c.database];
  const [r] = await runScript(c, 'SELECT datname FROM pg_database WHERE datallowconn AND NOT datistemplate ORDER BY datname',
    { readOnly: true, limit: 10_000, timeoutMs: 15_000 });
  const own = c.database || 'postgres';
  const names = r!.rows.map((row) => String(row[0]));
  return names.includes(own) ? names : [own, ...names];
}

/** The server's version, to show that the connection works. */
export async function testConnection(c: DbConnection): Promise<string> {
  const sql = c.driver === 'postgres' ? 'SELECT version()' : c.driver === 'sqlite' ? 'SELECT \'SQLite \' || sqlite_version()' : 'SELECT VERSION()';
  const [r] = await runScript(c, sql, { readOnly: true, limit: 1, timeoutMs: 15_000 });
  const v = String(r?.rows[0]?.[0] ?? '');
  return c.driver === 'mysql' || c.driver === 'mariadb' ? (/mariadb/i.test(v) ? `MariaDB ${v}` : `MySQL ${v}`) : v;
}

// ---------- schema ----------

const MAX_TABLES = 3000;
const SYSTEM_SCHEMAS: Record<Driver, string[]> = {
  postgres: ['pg_catalog', 'information_schema', 'pg_toast'],
  mysql: ['mysql', 'information_schema', 'performance_schema', 'sys'],
  mariadb: ['mysql', 'information_schema', 'performance_schema', 'sys'],
  sqlite: [],
};

/** Tables and views with their columns, from information_schema (or SQLite's own catalog). */
export async function readSchema(c: DbConnection, timeoutMs = 30_000): Promise<SchemaInfo> {
  const o: RunOpts = { readOnly: true, limit: 100_000, timeoutMs, maxCell: 500 };
  if (c.driver === 'sqlite') {
    const db = sqliteOpen(c, true, timeoutMs);
    try {
      const tables = db.prepare('SELECT name, type FROM sqlite_master WHERE type IN (\'table\', \'view\') AND name NOT LIKE \'sqlite_%\' ORDER BY name').all() as { name: string; type: string }[];
      return { schemas: [{ name: 'main', tables: tables.slice(0, MAX_TABLES).map((t) => ({
        name: t.name, kind: t.type === 'view' ? 'view' as const : 'table' as const,
        columns: (db.prepare(`PRAGMA table_info(${JSON.stringify(t.name)})`).all() as any[])
          .map((col) => ({ name: col.name, type: col.type || '', nullable: !col.notnull, pk: col.pk > 0 })),
      })) }] };
    } finally { db.close(); }
  }
  const skip = SYSTEM_SCHEMAS[c.driver].map((s) => `'${s}'`).join(',');
  const my = c.driver !== 'postgres';
  // MySQL: only the database named in the connection, if one is.
  const where = my && c.database ? 'table_schema = DATABASE()' : `table_schema NOT IN (${skip})`;
  const [tables, columns, keys] = await runScript(c, [
    `SELECT table_schema, table_name, table_type FROM information_schema.tables WHERE ${where} ORDER BY table_schema, table_name`,
    `SELECT table_schema, table_name, column_name, ${my ? 'column_type' : 'data_type'}, is_nullable FROM information_schema.columns WHERE ${where} ORDER BY table_schema, table_name, ordinal_position`,
    my
      ? `SELECT table_schema, table_name, column_name FROM information_schema.key_column_usage WHERE constraint_name = 'PRIMARY' AND ${where}`
      : `SELECT k.table_schema, k.table_name, k.column_name FROM information_schema.table_constraints t JOIN information_schema.key_column_usage k
           ON k.constraint_name = t.constraint_name AND k.table_schema = t.table_schema AND k.table_name = t.table_name
         WHERE t.constraint_type = 'PRIMARY KEY' AND t.${where}`,
  ].join(';\n'), o);
  const pk = new Set(keys!.rows.map((r) => r.slice(0, 3).join('\u0000')));
  const bySchema = new Map<string, Map<string, SchemaTable>>();
  for (const [schema, name, type] of tables!.rows.slice(0, MAX_TABLES) as string[][]) {
    if (!bySchema.has(schema!)) bySchema.set(schema!, new Map());
    bySchema.get(schema!)!.set(name!, { name: name!, kind: /view/i.test(type!) ? 'view' : 'table', columns: [] });
  }
  for (const [schema, table, name, type, nullable] of columns!.rows as string[][]) {
    bySchema.get(schema!)?.get(table!)?.columns.push({
      name: name!, type: type!, nullable: nullable === 'YES', pk: pk.has([schema, table, name].join('\u0000')),
    });
  }
  return { schemas: [...bySchema].map(([name, t]) => ({ name, tables: [...t.values()] })) };
}

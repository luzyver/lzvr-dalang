import { mkdtempSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { type DbConnection, onDatabase, statementsOf } from '../src/databases.js';
import { AUTH } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const opened: { close: () => Promise<unknown> }[] = [];
afterEach(async () => { for (const o of opened.splice(0)) await o.close().catch(() => {}); });

/** A SQLite file with a table of two rows. */
function sampleDb(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'lzvr-db-')), 'app.db');
  const db = new DatabaseSync(file);
  db.exec("CREATE TABLE users (id INTEGER PRIMARY KEY, name TEXT NOT NULL, note TEXT); INSERT INTO users (name, note) VALUES ('ann', NULL), ('bob', 'x');");
  db.close();
  return file;
}

async function boot() {
  const t = setupApp();
  opened.push({ close: () => t.app.close() });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (t.app.server.address() as { port: number }).port;
  const file = sampleDb();
  const put = (id: string, body: object, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method: 'PUT', url: `/api/db/connections/${id}`, headers, payload: { label: id, driver: 'sqlite', file, access: 'all', readOnly: false, agent: 'off', ...body } });
  const query = (id: string, sql: string, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method: 'POST', url: `/api/db/connections/${id}/query`, headers, payload: { sql } });
  const mcp = async (token: string) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers: bearer(token) } }));
    opened.push(client);
    const call = async (name: string, args: Record<string, unknown> = {}) => {
      const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
      return { isError: Boolean(r.isError), text: r.content[0]!.text };
    };
    return { tools: async () => (await client.listTools()).tools.map((x) => x.name), call };
  };
  /** An agent's MCP connection, in a chat whose turn `author` sent. */
  const agent = (author = 'owner') => {
    const p = t.store.createProject('proj', t.root);
    const conv = t.store.createConversation(p.id);
    return mcp(t.dispatcher.issueMcpToken(conv.id, author));
  };
  return { ...t, file, put, query, agent };
}

describe('statements', () => {
  it('splits on ; outside strings, comments and dollar quotes', () => {
    expect(statementsOf("SELECT 'a;b'; -- x;\nSELECT 2 /* ; */;\n\n")).toEqual(["SELECT 'a;b'", '-- x;\nSELECT 2 /* ; */']);
    expect(statementsOf('CREATE FUNCTION f() RETURNS int AS $$ SELECT 1; $$ LANGUAGE sql; SELECT 1', 'postgres')).toHaveLength(2);
    expect(statementsOf("SELECT 'it\\'s; fine' # ;\n; SELECT `a;b`", 'mysql')).toEqual(["SELECT 'it\\'s; fine' # ;", 'SELECT `a;b`']);
    expect(statementsOf('-- only a comment;')).toEqual([]);
  });
});

describe('other databases', () => {
  const pg: DbConnection = {
    id: 'pg', label: 'PG', driver: 'postgres', host: 'h', port: 5432, user: 'u', password: '', database: 'app', ssl: 'disable',
    file: '', access: 'all', readOnly: false, agent: 'off',
  };
  it('opens only its own database unless it opens every one', () => {
    expect(onDatabase(pg)).toBe(pg);
    expect(onDatabase(pg, 'app')).toBe(pg);
    expect(() => onDatabase(pg, 'other')).toThrow(/only its own/);
    const all = { ...pg, allDatabases: true };
    expect(onDatabase(all, 'other').database).toBe('other');
    // No database set: it starts in `postgres`.
    expect(onDatabase({ ...all, database: '' }, 'postgres').database).toBe('');
  });
});

describe('SQL editor connections', () => {
  it('saves a connection and never sends its password back', async () => {
    const t = await boot();
    const r = await t.app.inject({ method: 'PUT', url: '/api/db/connections/pg', headers: AUTH, payload: {
      label: 'PG', driver: 'postgres', host: 'db.local', user: 'app', password: 's3cret-pass', access: 'all', readOnly: false, agent: 'off' } });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ id: 'pg', port: 5432, hasPassword: true });
    const list = await t.app.inject({ url: '/api/db/connections', headers: AUTH });
    expect(list.body).not.toContain('s3cret-pass');
    // An edit without a password keeps the saved one.
    await t.app.inject({ method: 'PUT', url: '/api/db/connections/pg', headers: AUTH, payload: { label: 'PG', driver: 'postgres', host: 'db.local', access: 'all', readOnly: false, agent: 'off' } });
    expect(t.store.getKv('db_connections')).toContain('s3cret-pass');
  });

  it('refuses Dalang\'s own state files, relative paths and bad names', async () => {
    const t = await boot();
    expect((await t.put('x', { file: 'app.db' })).statusCode).toBe(400);
    expect((await t.put('Bad Name', {})).statusCode).toBe(400);
    const own = join(t.cfg.stateDir, 'own.db');
    new DatabaseSync(own).close();
    expect((await t.put('x', { file: own })).json().error).toMatch(/state folder/);
  });

  it('runs queries, keeps read-only connections read-only, and reports where a script failed', async () => {
    const t = await boot();
    await t.put('app', {});
    const r = (await t.query('app', 'SELECT id, name, note FROM users ORDER BY id; UPDATE users SET note = \'y\' WHERE id = 1')).json();
    expect(r.results[0].columns.map((c: { name: string }) => c.name)).toEqual(['id', 'name', 'note']);
    expect(r.results[0].rows).toEqual([[1, 'ann', null], [2, 'bob', 'x']]);
    expect(r.results[1].affected).toBe(1);

    await t.put('app', { readOnly: true });
    const ro = await t.query('app', 'SELECT 1; DELETE FROM users');
    expect(ro.statusCode).toBe(400);
    expect(ro.json()).toMatchObject({ index: 1, results: [{ rows: [[1]] }] });
    expect(ro.json().error).toMatch(/readonly/i);
  });

  it('shows a connection only to whom its access allows', async () => {
    const t = await boot();
    await t.put('adm', { access: 'admin' });
    const dev = await mkUser(t, 'dana', 'dev');
    expect((await t.app.inject({ url: '/api/db/connections', headers: bearer(dev.token) })).json()).toEqual([]);
    expect((await t.query('adm', 'SELECT 1', bearer(dev.token))).statusCode).toBe(404);
    expect((await t.put('adm2', {}, bearer(dev.token))).statusCode).toBe(403);
  });

  it('keeps "every database" to PostgreSQL and refuses another database elsewhere', async () => {
    const t = await boot();
    const r = await t.put('app', { allDatabases: true });
    expect(r.json().allDatabases).toBeUndefined();
    expect((await t.app.inject({ url: '/api/db/connections/app/databases', headers: AUTH })).json()).toEqual({ databases: [''] });
    const q = await t.app.inject({ method: 'POST', url: '/api/db/connections/app/query', headers: AUTH, payload: { sql: 'SELECT 1', database: 'other' } });
    expect(q.statusCode).toBe(400);
    expect(q.json().error).toMatch(/only its own database/);
    const pg = await t.app.inject({ method: 'PUT', url: '/api/db/connections/pg', headers: AUTH, payload: {
      label: 'PG', driver: 'postgres', host: 'db.local', access: 'all', readOnly: false, agent: 'off', allDatabases: true } });
    expect(pg.json()).toMatchObject({ allDatabases: true });
  });

  it('reads tables and columns', async () => {
    const t = await boot();
    await t.put('app', {});
    const s = (await t.app.inject({ url: '/api/db/connections/app/schema', headers: AUTH })).json();
    expect(s.schemas[0].tables[0]).toMatchObject({ name: 'users', kind: 'table' });
    expect(s.schemas[0].tables[0].columns[0]).toMatchObject({ name: 'id', pk: true });
  });
});

describe('SQL editor connections for agents', () => {
  it('gives agents no database tools while every connection is off', async () => {
    const t = await boot();
    await t.put('app', {});
    expect(await (await t.agent()).tools()).not.toContain('db_query');
  });

  it('lets an agent read a read-only connection, refuses its writes and logs both', async () => {
    const t = await boot();
    await t.put('app', { agent: 'read-only' });
    const a = await t.agent();
    expect((await a.call('db_list_connections')).text).toContain('"access": "read-only"');
    const read = await a.call('db_query', { connection: 'app', sql: 'SELECT name FROM users ORDER BY id' });
    expect(JSON.parse(read.text).results[0].rows).toEqual([['ann'], ['bob']]);
    const write = await a.call('db_query', { connection: 'app', sql: 'DROP TABLE users' });
    expect(write.isError).toBe(true);
    const log = (await t.app.inject({ url: '/api/db/connections/app/log', headers: AUTH })).json();
    expect(log.map((e: { ok: boolean }) => e.ok)).toEqual([false, true]);
    expect(log[0]).toMatchObject({ who: 'owner', sql: 'DROP TABLE users' });
  });

  it('lets an agent write on a read-write connection', async () => {
    const t = await boot();
    await t.put('app', { agent: 'read-write' });
    const r = await (await t.agent()).call('db_query', { connection: 'app', sql: "INSERT INTO users (name) VALUES ('cy')" });
    expect(JSON.parse(r.text).results[0].affected).toBe(1);
  });

  it('hides a connection from an agent working for someone who may not open it', async () => {
    const t = await boot();
    await t.put('adm', { agent: 'read-only', access: 'admin' });
    await mkUser(t, 'dana', 'dev');
    expect(await (await t.agent('dana')).tools()).not.toContain('db_query');
    expect(await (await t.agent('owner')).tools()).toContain('db_query');
  });
});

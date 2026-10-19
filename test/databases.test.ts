import { mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { agentRefusal, type DbConnection, findUnsafe, onDatabase, planBackup, previewEdits, statementsOf } from '../src/databases.js';
import { AUTH, until } from './helpers.js';
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
  const agent = (author = 'owner', convId?: string) => {
    const id = convId ?? t.store.createConversation(t.store.createProject('proj', t.root).id).id;
    return mcp(t.dispatcher.issueMcpToken(id, author));
  };
  return { ...t, file, put, query, agent };
}

describe('backup reads', () => {
  const reads = (sql: string, driver: DbConnection['driver'] = 'postgres') => planBackup(sql, driver).reads.map((r) => r.read);
  it('reads what UPDATE, DELETE, TRUNCATE and DROP TABLE are about to change', () => {
    expect(reads("UPDATE users SET note = 'a; WHERE' WHERE id IN (SELECT id FROM x WHERE y) RETURNING *")).toEqual(['SELECT users.* FROM users WHERE id IN (SELECT id FROM x WHERE y)']);
    expect(reads('UPDATE ONLY public.users AS u SET n = o.n FROM other o WHERE o.id = u.id')).toEqual(['SELECT u.* FROM ONLY public.users AS u, other o WHERE o.id = u.id']);
    expect(reads('WITH old AS (SELECT id FROM t) DELETE FROM users u USING old WHERE u.id = old.id')).toEqual(['WITH old AS (SELECT id FROM t) SELECT u.* FROM users u, old WHERE u.id = old.id']);
    expect(reads('UPDATE LOW_PRIORITY a JOIN b ON a.id = b.id SET a.x = 1 WHERE b.y = 2', 'mysql')).toEqual(['SELECT * FROM a JOIN b ON a.id = b.id WHERE b.y = 2']);
    expect(reads('DELETE a FROM a JOIN b ON a.id = b.id WHERE b.y = 2', 'mysql')).toEqual(['SELECT a.* FROM a JOIN b ON a.id = b.id WHERE b.y = 2']);
    expect(reads('DELETE FROM `t` WHERE x = 1 ORDER BY id LIMIT 5', 'mysql')).toEqual(['SELECT `t`.* FROM `t` WHERE x = 1 ORDER BY id LIMIT 5']);
    expect(reads('UPDATE t SET x = 1')).toEqual(['SELECT t.* FROM t']);
    expect(reads('TRUNCATE TABLE a, ONLY b RESTART IDENTITY')).toEqual(['SELECT * FROM a', 'SELECT * FROM b']);
    expect(planBackup('DROP TABLE IF EXISTS a, b CASCADE', 'postgres').reads).toMatchObject([{ read: 'SELECT * FROM a', optional: true }, { read: 'SELECT * FROM b' }]);
    expect(planBackup("INSERT INTO t VALUES (1); SELECT 1", 'postgres')).toEqual({ reads: [], skipped: [] });
    expect(planBackup('INSERT INTO t (id) VALUES (1) ON CONFLICT (id) DO UPDATE SET x = 2', 'postgres').skipped).toHaveLength(1);
  });

  it('reads what MongoDB updates, deletes and drops are about to change, and lists Redis writes as not backed up', () => {
    expect(planBackup('db.users.updateMany({ age: { $gt: 3 } }, { $set: { a: 1 } }); db.users.insertOne({ a: 1 }); db.logs.drop()', 'mongodb').reads)
      .toMatchObject([{ table: 'users', filter: { age: { $gt: 3 } } }, { table: 'logs', filter: {} }]);
    expect(planBackup('GET a\nSET a 1', 'redis')).toMatchObject({ reads: [], skipped: [expect.stringMatching(/Redis commands are not backed up\): SET a 1/)] });
  });
});

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

describe('statements that change every row', () => {
  const kinds = (sql: string, driver: DbConnection['driver'] = 'postgres') => findUnsafe(sql, driver).map((u) => `${u.kind} ${u.table}`);
  it('finds UPDATE and DELETE without a WHERE of their own, and TRUNCATE', () => {
    expect(kinds('DELETE FROM mail_logs')).toEqual(['delete mail_logs']);
    expect(kinds("UPDATE users SET note = 'where'")).toEqual(['update users']);
    expect(kinds('UPDATE users SET n = (SELECT 1 FROM x WHERE y)')).toEqual(['update users']);
    expect(kinds('-- where\nDELETE FROM "public"."t"')).toEqual(['delete "public"."t"']);
    expect(kinds('WITH d AS (SELECT 1) DELETE FROM t USING d')).toEqual(['delete t']);
    expect(kinds('TRUNCATE TABLE ONLY public.t')).toEqual(['truncate public.t']);
    expect(kinds('DELETE LOW_PRIORITY FROM `app`.`t` LIMIT 10', 'mysql')).toEqual(['delete `app`.`t`']);
    expect(kinds('SELECT 1; delete from t2')).toEqual(['delete t2']);
  });
  it('lets a WHERE at the top level through', () => {
    expect(kinds('DELETE FROM t WHERE id = 1')).toEqual([]);
    expect(kinds('UPDATE t SET a = 1 WHERE true')).toEqual([]);
    expect(kinds('WITH d AS (SELECT 1) DELETE FROM t WHERE id IN (SELECT 1)')).toEqual([]);
    expect(kinds('SELECT * FROM t; INSERT INTO t VALUES (1)')).toEqual([]);
  });
});

describe('agent refusals', () => {
  it('refuses what reaches past the tables, in every mode, and DO blocks while read-only', () => {
    for (const sql of ["COPY users TO PROGRAM 'id'", "SELECT pg_read_file('/etc/passwd')", 'SELECT * FROM t INTO OUTFILE \'/tmp/x\'',
      "ATTACH DATABASE '/tmp/x.db' AS x", "VACUUM INTO '/tmp/x.db'", 'SET GLOBAL max_connections = 1', 'SELECT 1; KILL 42',
      "SELECT query_to_xml('select 1', true, true, '')", 'CREATE EXTENSION dblink']) {
      expect(agentRefusal(sql, 'postgres', false), sql).toMatch(/refused for agents/);
    }
    expect(agentRefusal('DO $$ BEGIN END $$', 'postgres', true)).toMatch(/DO blocks/);
    expect(agentRefusal('DO $$ BEGIN END $$', 'postgres', false)).toBeNull();
    expect(agentRefusal("SELECT * FROM users WHERE note = 'copy'; VACUUM", 'postgres', true)).toBeNull();
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

  it('allows Dalang\'s own state files only for owner-only connections', async () => {
    const t = await boot();
    expect((await t.put('x', { file: 'app.db' })).statusCode).toBe(400);
    expect((await t.put('Bad Name', {})).statusCode).toBe(400);
    const own = join(t.cfg.stateDir, 'own.db');
    new DatabaseSync(own).close();
    expect((await t.put('x', { file: own })).json().error).toMatch(/state folder/);
    expect((await t.put('x', { file: own, access: 'admin' })).json().error).toMatch(/state folder/);
    expect((await t.put('x', { file: own, access: 'owner' })).statusCode).toBe(200);
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

  it('edits rows through their primary key, all or nothing, and never on a read-only connection', async () => {
    const t = await boot();
    await t.put('app', {});
    const edit = (edits: object[]) => t.app.inject({ method: 'POST', url: '/api/db/connections/app/edit', headers: AUTH,
      payload: { schema: 'main', table: 'users', edits } });
    const ok = await edit([
      { kind: 'update', key: { id: '1' }, set: { name: "an'n", note: null } },
      { kind: 'insert', values: { name: 'cy' } },
      { kind: 'delete', key: { id: '2' } },
    ]);
    expect(ok.json()).toEqual({ changed: 3 });
    const rows = () => t.query('app', 'SELECT id, name, note FROM users ORDER BY id').then((r) => r.json().results[0].rows);
    expect(await rows()).toEqual([[1, "an'n", null], [3, 'cy', null]]);
    // A key that matches no row undoes the whole batch.
    const bad = await edit([{ kind: 'update', key: { id: '1' }, set: { name: 'x' } }, { kind: 'delete', key: { id: '99' } }]);
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/matched 0 rows/);
    expect((await rows())[0][1]).toBe("an'n");
    await t.put('app', { readOnly: true });
    expect((await edit([{ kind: 'delete', key: { id: '1' } }])).statusCode).toBe(403);
  });

  it('holds a script that changes every row until it is confirmed, with the rows it would touch', async () => {
    const t = await boot();
    await t.put('app', {});
    const ask = (confirmed?: boolean) => t.app.inject({ method: 'POST', url: '/api/db/connections/app/query', headers: AUTH,
      payload: { sql: "SELECT 1; UPDATE users SET note = 'x'", ...(confirmed && { confirmed }) } });
    const held = await ask();
    expect(held.statusCode).toBe(409);
    expect(held.json().unsafe).toMatchObject([{ index: 1, kind: 'update', table: 'users', rows: 2 }]);
    const notes = () => t.query('app', 'SELECT note FROM users ORDER BY id').then((r) => r.json().results[0].rows);
    expect(await notes()).toEqual([[null], ['x']]);
    expect((await ask(true)).statusCode).toBe(200);
    expect(await notes()).toEqual([['x'], ['x']]);
    // A read-only connection refuses it anyway: nothing to confirm.
    await t.put('app', { readOnly: true });
    expect((await ask()).statusCode).toBe(400);
  });

  it('previews the statements of grid edits without running them', async () => {
    const t = await boot();
    await t.put('app', {});
    const r = await t.app.inject({ method: 'POST', url: '/api/db/connections/app/edit', headers: AUTH, payload: {
      schema: 'main', table: 'users', preview: true, edits: [
        { kind: 'update', key: { id: '1' }, set: { name: "o'neil", note: null } },
        { kind: 'insert', values: {} },
        { kind: 'delete', key: { id: '2' } },
      ] } });
    expect(r.json().statements).toEqual([
      'UPDATE "main"."users" SET "name" = \'o\'\'neil\', "note" = NULL WHERE "id" = \'1\';',
      'INSERT INTO "main"."users" DEFAULT VALUES;',
      'DELETE FROM "main"."users" WHERE "id" = \'2\';',
    ]);
    const rows = (await t.query('app', 'SELECT name FROM users ORDER BY id')).json().results[0].rows;
    expect(rows).toEqual([['ann'], ['bob']]);
  });

  it('writes MySQL literals with backslashes escaped', () => {
    const my = { id: 'my', driver: 'mysql' } as DbConnection;
    expect(previewEdits(my, 'app', 'users', [{ kind: 'insert', values: { path: 'C:\\x', note: "it's" } }]))
      .toEqual(["INSERT INTO `app`.`users` (`path`, `note`) VALUES ('C:\\\\x', 'it''s');"]);
  });

  it('shows a table\'s DDL', async () => {
    const t = await boot();
    await t.put('app', {});
    const r = await t.app.inject({ url: '/api/db/connections/app/ddl?schema=main&table=users', headers: AUTH });
    expect(r.json().ddl).toMatch(/^CREATE TABLE users \(id INTEGER PRIMARY KEY/);
  });

  it('lists every table of a big database without columns, and gives a schema\'s columns when asked', async () => {
    const t = await boot();
    const db = new DatabaseSync(t.file);
    for (let i = 0; i < 450; i++) db.exec(`CREATE TABLE t${i} (id INTEGER PRIMARY KEY, v TEXT)`);
    db.close();
    await t.put('app', {});
    const all = (await t.app.inject({ url: '/api/db/connections/app/schema', headers: AUTH })).json();
    expect(all.schemas[0]).toMatchObject({ name: 'main', loaded: false });
    expect(all.schemas[0].tables).toHaveLength(451);
    expect(all.schemas[0].tables[0].columns).toEqual([]);
    const one = (await t.app.inject({ url: '/api/db/connections/app/schema?schema=main', headers: AUTH })).json();
    expect(one.schemas[0].loaded).toBe(true);
    expect(one.schemas[0].tables.find((x: { name: string }) => x.name === 't7').columns[0]).toMatchObject({ name: 'id', pk: true });
  });

  it('reads tables and columns', async () => {
    const t = await boot();
    await t.put('app', {});
    const s = (await t.app.inject({ url: '/api/db/connections/app/schema', headers: AUTH })).json();
    expect(s.schemas[0].tables[0]).toMatchObject({ name: 'users', kind: 'table' });
    expect(s.schemas[0].tables[0].columns[0]).toMatchObject({ name: 'id', pk: true });
  });
});

describe('SQL editor workspaces', () => {
  it('starts with a Default workspace holding every connection, and puts new ones in the first', async () => {
    const t = await boot();
    await t.put('app', {});
    const ws = () => t.app.inject({ url: '/api/db/workspaces', headers: AUTH }).then((r) => r.json());
    expect(await ws()).toEqual([{ id: 'default', name: 'Default', conns: ['app'] }]);
    await t.put('app2', {});
    expect((await ws())[0].conns).toEqual(['app', 'app2']);
  });

  it('adds, renames and removes workspaces, and keeps a connection in several', async () => {
    const t = await boot();
    await t.put('app', {});
    const add = await t.app.inject({ method: 'POST', url: '/api/db/workspaces', headers: AUTH, payload: { name: 'Main Production' } });
    expect(add.json()).toEqual({ id: 'main-production', name: 'Main Production', conns: [] });
    const again = await t.app.inject({ method: 'POST', url: '/api/db/workspaces', headers: AUTH, payload: { name: 'Main production!' } });
    expect(again.json().id).toBe('main-production-2');
    // A connection goes into a second workspace through its own form, and the workspace's list can be set directly.
    await t.put('app', { workspaces: ['default', 'main-production'] });
    let list = (await t.app.inject({ url: '/api/db/workspaces', headers: AUTH })).json();
    expect(list.map((w: { conns: string[] }) => w.conns)).toEqual([['app'], ['app'], []]);
    await t.app.inject({ method: 'PATCH', url: '/api/db/workspaces/main-production-2', headers: AUTH, payload: { name: 'Reports', conns: ['app', 'nope'] } });
    list = (await t.app.inject({ url: '/api/db/workspaces', headers: AUTH })).json();
    expect(list[2]).toEqual({ id: 'main-production-2', name: 'Reports', conns: ['app'] });
    // Removing the connection takes it out of every workspace.
    await t.app.inject({ method: 'DELETE', url: '/api/db/connections/app', headers: AUTH });
    list = (await t.app.inject({ url: '/api/db/workspaces', headers: AUTH })).json();
    expect(list.every((w: { conns: string[] }) => !w.conns.length)).toBe(true);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/db/workspaces/default', headers: AUTH })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/db/workspaces/main-production', headers: AUTH })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/db/workspaces/main-production-2', headers: AUTH })).statusCode).toBe(409);
  });

  it('lets only admins change workspaces', async () => {
    const t = await boot();
    const dev = await mkUser(t, 'dana', 'dev');
    expect((await t.app.inject({ url: '/api/db/workspaces', headers: bearer(dev.token) })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/db/workspaces', headers: bearer(dev.token), payload: { name: 'x' } })).statusCode).toBe(403);
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

  it('holds an agent\'s write for an admin on an approval connection, then runs it and tells the chat', async () => {
    const t = await boot();
    await t.put('app', { agent: 'approve' });
    const p = t.store.createProject('proj', t.root);
    const conv = t.store.createConversation(p.id);
    const a = await t.agent('owner', conv.id);
    expect(await a.tools()).toContain('db_approval');
    expect(JSON.parse((await a.call('db_query', { connection: 'app', sql: 'SELECT count(*) FROM users' })).text).results[0].rows).toEqual([[2]]);
    const held = JSON.parse((await a.call('db_query', { connection: 'app', sql: "UPDATE users SET note = 'z'" })).text);
    expect(held).toMatchObject({ status: 'pending_approval', approval_id: 1 });
    const count = () => t.query('app', "SELECT count(*) FROM users WHERE note = 'z'").then((r) => r.json().results[0].rows[0][0]);
    expect(await count()).toBe(0);
    const pending = (await t.app.inject({ url: '/api/db/approvals', headers: AUTH })).json();
    expect(pending).toMatchObject([{ id: 1, conn: 'app', sql: "UPDATE users SET note = 'z'", who: 'owner', conv: conv.id }]);
    const ok = await t.app.inject({ method: 'POST', url: '/api/db/approvals/1/approve', headers: AUTH });
    expect(ok.json()).toMatchObject({ status: 'approved', decidedBy: 'owner' });
    expect(ok.json().outcome).toMatch(/^2 row\(s\) affected\nBacked up 2 row\(s\)/);
    const backup = JSON.parse(readFileSync(join(t.cfg.stateDir, 'db-backups', 'app', ok.json().backup), 'utf8'));
    expect(backup).toMatchObject({ connection: 'app', approval: 1, rows: 2, tables: [{ table: 'users', columns: ['id', 'name', 'note'], rows: [[1, 'ann', null], [2, 'bob', 'x']] }] });
    expect(await count()).toBe(2);
    expect(JSON.parse((await a.call('db_approval', { approval_id: 1 })).text)).toMatchObject({ status: 'approved' });
    await until(() => [...t.store.listQueue(conv.id), ...t.store.listTurns(conv.id)].some((x) => x.prompt.includes('approved your write')));
    expect((await t.app.inject({ method: 'POST', url: '/api/db/approvals/1/reject', headers: AUTH })).statusCode).toBe(409);
  });

  it('runs an approved write once when approved twice at the same time, and keeps the approvals that wait', async () => {
    const t = await boot();
    await t.put('app', { agent: 'approve' });
    const a = await t.agent();
    await a.call('db_query', { connection: 'app', sql: "INSERT INTO users (name) VALUES ('cy')" });
    await a.call('db_query', { connection: 'app', sql: "INSERT INTO users (name) VALUES ('dee')" });
    const approve = () => t.app.inject({ method: 'POST', url: '/api/db/approvals/1/approve', headers: AUTH });
    const codes = (await Promise.all([approve(), approve()])).map((r) => r.statusCode).sort();
    expect(codes).toEqual([200, 409]);
    expect((await t.query('app', "SELECT count(*) FROM users WHERE name = 'cy'")).json().results[0].rows).toEqual([[1]]);
    const pending = (await t.app.inject({ url: '/api/db/approvals', headers: AUTH })).json();
    expect(pending.map((x: { id: number }) => x.id)).toEqual([2]);
  });

  it('refuses an agent\'s write without WHERE on a read-write connection, and flags it on an approval card', async () => {
    const t = await boot();
    await t.put('app', { agent: 'read-write' });
    const r = await (await t.agent()).call('db_query', { connection: 'app', sql: 'DELETE FROM users' });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/DELETE on users without WHERE/);
    expect((await (await t.agent()).call('db_query', { connection: 'app', sql: 'DELETE FROM users WHERE true' })).isError).toBe(false);
    await t.put('app', { agent: 'approve' });
    await (await t.agent()).call('db_query', { connection: 'app', sql: "UPDATE users SET note = 'z'" });
    const [a] = (await t.app.inject({ url: '/api/db/approvals', headers: AUTH })).json();
    expect(a.unsafe).toEqual(['UPDATE on users without WHERE']);
  });

  it('refuses statements that reach past the tables even on a read-write connection', async () => {
    const t = await boot();
    await t.put('app', { agent: 'read-write' });
    const r = await (await t.agent()).call('db_query', { connection: 'app', sql: "ATTACH DATABASE '/tmp/other.db' AS o" });
    expect(r).toMatchObject({ isError: true });
    expect(r.text).toMatch(/refused for agents/);
  });

  it('backs up what an agent\'s write changes before it runs, and runs nothing when the backup fails', async () => {
    const t = await boot();
    await t.put('app', { agent: 'read-write' });
    const a = await t.agent();
    const r = JSON.parse((await a.call('db_query', { connection: 'app', sql: "UPDATE users SET note = 'y' WHERE name = 'bob'; DELETE FROM users WHERE id = 1" })).text);
    expect(r.backup).toMatch(/^Backed up 2 row\(s\)/);
    const [entry] = (await t.app.inject({ url: '/api/db/connections/app/log', headers: AUTH })).json();
    expect(entry).toMatchObject({ ok: true, backupRows: 2 });
    const file = await t.app.inject({ url: `/api/db/connections/app/backups/${entry.backup}`, headers: AUTH });
    expect(file.json().tables).toMatchObject([{ table: 'users', rows: [[2, 'bob', 'x']] }, { table: 'users', rows: [[1, 'ann', null]] }]);
    expect((await t.app.inject({ url: '/api/db/connections/app/backups/..%2F..%2Flzvr.db', headers: AUTH })).statusCode).toBe(404);
    // An insert changes nothing that was there: no backup.
    expect(JSON.parse((await a.call('db_query', { connection: 'app', sql: "INSERT INTO users (name) VALUES ('cy')" })).text).backup).toBeUndefined();
    expect(readdirSync(join(t.cfg.stateDir, 'db-backups', 'app'))).toHaveLength(1);
    // The backup's read fails (no such column), so the write does not run.
    const bad = await a.call('db_query', { connection: 'app', sql: "UPDATE users SET note = 'q' WHERE nope = 1" });
    expect(bad).toMatchObject({ isError: true });
    expect(bad.text).toMatch(/backup of what this changes failed, so nothing ran/);
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

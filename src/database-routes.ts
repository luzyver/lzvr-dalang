/**
 * The SQL editor (/sql): database connections for the whole panel, not tied to a chat. Admins add and change them;
 * each has an access level like a project's (who may open it in the panel) and an agent mode (whether agents get it
 * through the gateway's MCP tools: read-only, writes after an admin's approval, or read-write). Passwords never go back
 * to the panel.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  AGENT_MODES, agentRefusal, countRows, type DbConnection, DEFAULT_PORT, DRIVERS, editRows, findUnsafe, listDatabases, loadConnections, onDatabase,
  previewEdits, QueryError, type QueryResult, readDdl, readSchema, type RowEdit, runScript, saveConnections, SSL_MODES, testConnection,
} from './databases.js';
import type { Dispatcher } from './dispatcher.js';
import type { Store } from './store.js';
import { type AuthUser, canAccess, PROJECT_ACCESS } from './util.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOG_MAX = 200;
export const PANEL_LIMIT = 500;
const PANEL_TIMEOUT_MS = 120_000;

/** What the panel sees of a connection: everything but the password. */
const view = ({ password, ...c }: DbConnection) => ({ ...c, hasPassword: !!password });

/** One agent query, for the connection's log (admins read it in the SQL editor). */
export interface DbLogEntry {
  at: number; who: string; conv: string | null; database?: string; sql: string; ok: boolean; rows: number; ms: number; error?: string;
}
const logKey = (id: string) => `db_log:${id}`;
export function readDbLog(store: Store, id: string): DbLogEntry[] {
  try { return JSON.parse(store.getKv(logKey(id)) ?? '[]'); } catch { return []; }
}
export function logDbQuery(store: Store, id: string, entry: DbLogEntry): void {
  store.setKv(logKey(id), JSON.stringify([entry, ...readDbLog(store, id)].slice(0, LOG_MAX)));
}

/** A script an agent wanted to write with, on an 'approve' connection, waiting for an admin (or decided). */
export interface DbApproval {
  id: number; conn: string; database?: string; sql: string; who: string; conv: string | null; at: number;
  status: 'pending' | 'approved' | 'rejected' | 'failed'; decidedBy?: string; decidedAt?: number;
  /** What running it gave (or why it failed). */
  outcome?: string;
  /** Its statements that hit every row (UPDATE/DELETE without WHERE, TRUNCATE), described: the card warns about them. */
  unsafe?: string[];
}
const APPROVALS = 'db_approvals';
export function readDbApprovals(store: Store): DbApproval[] {
  try { return JSON.parse(store.getKv(APPROVALS) ?? '[]'); } catch { return []; }
}
/** Keeps every pending one and the last 200 decided. */
function saveDbApprovals(store: Store, list: DbApproval[]): void {
  const decided = list.filter((a) => a.status !== 'pending').slice(-LOG_MAX);
  store.setKv(APPROVALS, JSON.stringify(list.filter((a) => a.status === 'pending' || decided.includes(a))));
}
export function createDbApproval(store: Store, a: Omit<DbApproval, 'id' | 'at' | 'status'>): DbApproval {
  const list = readDbApprovals(store);
  const next: DbApproval = { ...a, id: Math.max(0, ...list.map((x) => x.id)) + 1, at: Date.now(), status: 'pending' };
  saveDbApprovals(store, [...list, next]);
  return next;
}

/** A short account of what a script did, for a chat message and the approval card. */
export const describeResults = (results: QueryResult[]) => results.map((r, i) => `${results.length > 1 ? `${i + 1}. ` : ''}${
  r.columns.length ? `${r.rows.length}${r.truncated ? '+' : ''} row(s)` : r.affected != null ? `${r.affected} row(s) affected` : 'done'}`).join('\n');

interface Body {
  label: string; driver: DbConnection['driver']; host?: string; port?: number; user?: string; database?: string;
  ssl?: DbConnection['ssl']; file?: string; access: DbConnection['access']; readOnly: boolean; agent: DbConnection['agent'];
  allDatabases?: boolean;
  /** Omitted keeps the saved one, '' removes it. */
  password?: string;
}

const BODY = {
  type: 'object', required: ['label', 'driver', 'access', 'readOnly', 'agent'], additionalProperties: false,
  properties: {
    label: { type: 'string', minLength: 1, maxLength: 80 }, driver: { enum: [...DRIVERS] },
    host: { type: 'string', maxLength: 255 }, port: { type: 'integer', minimum: 0, maximum: 65535 },
    user: { type: 'string', maxLength: 255 }, password: { type: 'string', maxLength: 1000 },
    database: { type: 'string', maxLength: 255 }, ssl: { enum: [...SSL_MODES] }, file: { type: 'string', maxLength: 1000 },
    access: { enum: [...PROJECT_ACCESS] }, readOnly: { type: 'boolean' }, agent: { enum: [...AGENT_MODES] },
    allDatabases: { type: 'boolean' },
  },
};
/** `?database=` / `database`: one of the connection's other databases (PostgreSQL with "every database"). */
const DATABASE = { type: 'string', minLength: 1, maxLength: 63 };

const STRINGS = { type: 'object', maxProperties: 500, additionalProperties: { type: ['string', 'null'], maxLength: 1_000_000 } };
const EDIT = {
  type: 'object', required: ['kind'], additionalProperties: false,
  properties: { kind: { enum: ['update', 'insert', 'delete'] }, key: STRINGS, set: STRINGS, values: STRINGS },
};

export function databaseRoutes(app: FastifyInstance, d: { store: Store; stateDir: string; dispatcher: Dispatcher }): void {
  const { store } = d;
  const requireAdmin = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'admin only' });
  };
  /** The connection, if this caller may open it (one they may not does not exist for them). */
  const find = (user: AuthUser, id: string) => loadConnections(store).find((c) => c.id === id && canAccess(user, c.access));

  /** A connection from a form, or an error message. `old` gives the saved password when none is sent. */
  const build = (id: string, b: Body, user: AuthUser, old?: DbConnection): DbConnection | string => {
    if (b.access === 'owner' && user.id !== null) return 'only the owner can make a connection owner-only';
    const c: DbConnection = {
      id, label: b.label.trim(), driver: b.driver, host: b.host?.trim() ?? '', port: b.port || DEFAULT_PORT[b.driver],
      user: b.user?.trim() ?? '', password: b.password === undefined ? old?.password ?? '' : b.password,
      database: b.database?.trim() ?? '', ssl: b.ssl ?? 'disable', file: '', access: b.access, readOnly: b.readOnly,
      // A connection read-only for everyone cannot let agents write, not even after an approval.
      agent: b.readOnly && (b.agent === 'read-write' || b.agent === 'approve') ? 'read-only' : b.agent,
      ...(b.driver === 'postgres' && b.allDatabases && { allDatabases: true }),
    };
    if (b.driver === 'sqlite') {
      const file = b.file?.trim() ?? '';
      if (!isAbsolute(file)) return 'the database file must be an absolute path';
      if (!existsSync(file) || !statSync(file).isFile()) return `no such file: ${file}`;
      // Dalang's own state (sessions, other connections' passwords) stays out of reach.
      const real = realpathSync(file);
      const rel = relative(realpathSync(resolve(d.stateDir)), real);
      if (!rel || (!rel.startsWith('..') && !isAbsolute(rel))) return 'files in Dalang\'s state folder cannot be opened';
      Object.assign(c, { host: '', port: 0, user: '', password: '', database: '', ssl: 'disable', file: real });
    } else if (!c.host) return 'a host is needed';
    return c;
  };

  app.get('/api/db/connections', (req) => loadConnections(store).filter((c) => canAccess(req.user!, c.access)).map(view));

  app.put<{ Params: { id: string }; Body: Body }>('/api/db/connections/:id', { onRequest: requireAdmin, schema: { body: BODY } }, (req, reply) => {
    const { id } = req.params;
    if (!ID.test(id)) return reply.code(400).send({ error: 'name: lowercase letters, digits, - and _ (at most 32)' });
    const list = loadConnections(store);
    const old = list.find((c) => c.id === id);
    if (old && !canAccess(req.user!, old.access)) return reply.code(409).send({ error: `${id} is taken` });
    const next = build(id, req.body, req.user!, old);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    saveConnections(store, old ? list.map((c) => (c === old ? next : c)) : [...list, next]);
    return view(next);
  });

  app.delete<{ Params: { id: string } }>('/api/db/connections/:id', { onRequest: requireAdmin }, (req, reply) => {
    if (!find(req.user!, req.params.id)) return reply.code(404).send({ error: 'not found' });
    saveConnections(store, loadConnections(store).filter((c) => c.id !== req.params.id));
    store.setKv(logKey(req.params.id), '[]');
    return reply.code(204).send();
  });

  // Tries a connection as the form has it (a saved one's password is used when the form leaves it empty).
  app.post<{ Body: Body & { id?: string } }>('/api/db/test', {
    onRequest: requireAdmin,
    schema: { body: { ...BODY, properties: { ...BODY.properties, id: { type: 'string', maxLength: 32 } } } },
  }, async (req, reply) => {
    const { id, ...b } = req.body;
    const old = id ? find(req.user!, id) : undefined;
    const c = build(id || 'test', b, req.user!, old);
    if (typeof c === 'string') return reply.code(400).send({ error: c });
    try { return await testConnection(c); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // The databases a connection opens: only its own, unless it is a PostgreSQL one set to open every database.
  app.get<{ Params: { id: string } }>('/api/db/connections/:id/databases', async (req, reply) => {
    const c = find(req.user!, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    try { return { databases: await listDatabases(c) }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.get<{ Params: { id: string }; Querystring: { database?: string } }>('/api/db/connections/:id/schema', {
    schema: { querystring: { type: 'object', properties: { database: DATABASE } } },
  }, async (req, reply) => {
    const c = find(req.user!, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    try { return await readSchema(onDatabase(c, req.query.database)); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // Runs a script (one or more statements); a failure answers 400 with the results of the statements before it. A script
  // with a statement that hits every row (UPDATE or DELETE without WHERE, TRUNCATE) runs only once `confirmed`: until
  // then it answers 409 with those statements and how many rows their tables have, and runs nothing.
  app.post<{ Params: { id: string }; Body: { sql: string; limit?: number; database?: string; confirmed?: boolean } }>('/api/db/connections/:id/query', {
    schema: { body: { type: 'object', required: ['sql'], additionalProperties: false, properties: {
      sql: { type: 'string', minLength: 1, maxLength: 1_000_000 }, limit: { type: 'integer', minimum: 1, maximum: 10_000 },
      database: DATABASE, confirmed: { type: 'boolean' },
    } } },
  }, async (req, reply) => {
    const c = find(req.user!, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    if (!c.readOnly && !req.body.confirmed) {
      const unsafe = findUnsafe(req.body.sql, c.driver);
      if (unsafe.length) {
        let target: DbConnection;
        try { target = onDatabase(c, req.body.database); } catch (e) { return reply.code(400).send({ error: (e as Error).message, index: 0, results: [] }); }
        const counted = await Promise.all(unsafe.map(async (u) => ({ ...u, rows: await countRows(target, u.table) })));
        return reply.code(409).send({ error: 'this would change every row of a table', unsafe: counted });
      }
    }
    // The panel stopping the request (Cancel, a closed tab) cancels the statement on the server.
    const ac = new AbortController();
    const gone = () => { if (!reply.raw.writableEnded) ac.abort(); };
    reply.raw.on('close', gone);
    try {
      return { readOnly: c.readOnly, results: await runScript(onDatabase(c, req.body.database), req.body.sql, {
        readOnly: c.readOnly, limit: req.body.limit ?? PANEL_LIMIT, timeoutMs: PANEL_TIMEOUT_MS, signal: ac.signal,
      }) };
    } catch (e) {
      const q = e instanceof QueryError ? e : null;
      return reply.code(400).send({ error: (e as Error).message, index: q?.index ?? 0, results: q?.results ?? [] });
    } finally { reply.raw.off('close', gone); }
  });

  // Saves the result grid's changes to one table: every one or none (one transaction). With `preview`, only answers the
  // statements it would run (values written in), and runs nothing.
  app.post<{ Params: { id: string }; Body: { database?: string; schema: string; table: string; edits: RowEdit[]; preview?: boolean } }>('/api/db/connections/:id/edit', {
    schema: { body: { type: 'object', required: ['schema', 'table', 'edits'], additionalProperties: false, properties: {
      database: DATABASE, schema: { type: 'string', minLength: 1, maxLength: 128 }, table: { type: 'string', minLength: 1, maxLength: 128 },
      edits: { type: 'array', minItems: 1, maxItems: 1000, items: EDIT }, preview: { type: 'boolean' },
    } } },
  }, async (req, reply) => {
    const c = find(req.user!, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    if (c.readOnly) return reply.code(403).send({ error: 'this connection is read-only' });
    try {
      if (req.body.preview) return { statements: previewEdits(onDatabase(c, req.body.database), req.body.schema, req.body.table, req.body.edits) };
      return { changed: await editRows(onDatabase(c, req.body.database), req.body.schema, req.body.table, req.body.edits) };
    } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.get<{ Params: { id: string }; Querystring: { database?: string; schema: string; table: string } }>('/api/db/connections/:id/ddl', {
    schema: { querystring: { type: 'object', required: ['schema', 'table'], properties: {
      database: DATABASE, schema: { type: 'string', minLength: 1, maxLength: 128 }, table: { type: 'string', minLength: 1, maxLength: 128 },
    } } },
  }, async (req, reply) => {
    const c = find(req.user!, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    try { return { ddl: await readDdl(onDatabase(c, req.query.database), req.query.schema, req.query.table) }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  app.get<{ Params: { id: string } }>('/api/db/connections/:id/log', { onRequest: requireAdmin }, (req, reply) => {
    if (!find(req.user!, req.params.id)) return reply.code(404).send({ error: 'not found' });
    return readDbLog(store, req.params.id);
  });

  // Writes agents asked for on 'approve' connections. Admins see those of connections they may open.
  const visibleApproval = (user: AuthUser, a: DbApproval) => !!find(user, a.conn);
  app.get<{ Querystring: { status?: string } }>('/api/db/approvals', { onRequest: requireAdmin }, (req) =>
    readDbApprovals(store).filter((a) => a.status === (req.query.status || 'pending') && visibleApproval(req.user!, a)).reverse());

  /** Tells the chat the agent asked from what became of its write, so it can go on. */
  const tellChat = (a: DbApproval, text: string) => {
    if (!a.conv || !store.getConversation(a.conv)) return;
    store.enqueue(a.conv, text, [], '', a.who);
    d.dispatcher.kick(a.conv);
  };
  const where = (a: DbApproval) => `connection "${a.conn}"${a.database ? `, database "${a.database}"` : ''}`;
  const fence = '`'.repeat(3);
  const sqlBlock = (a: DbApproval) => `\n\n${fence}sql\n${a.sql}\n${fence}`;
  const decide = (verb: 'approve' | 'reject') => async (req: { params: { id: string }; user?: AuthUser }, reply: any) => {
    const list = readDbApprovals(store);
    const a = list.find((x) => x.id === Number(req.params.id));
    if (!a || !visibleApproval(req.user!, a)) return reply.code(404).send({ error: 'not found' });
    if (a.status !== 'pending') return reply.code(409).send({ error: `already ${a.status}` });
    const done = (patch: Partial<DbApproval>) => {
      Object.assign(a, { decidedBy: req.user!.name, decidedAt: Date.now(), ...patch });
      saveDbApprovals(store, list);
    };
    if (verb === 'reject') {
      done({ status: 'rejected' });
      tellChat(a, `[SQL editor] An admin rejected your write on ${where(a)}; it did not run. Do not run it again unless you are asked to.${sqlBlock(a)}`);
      return a;
    }
    const c = find(req.user!, a.conn);
    if (!c || c.readOnly || (c.agent !== 'approve' && c.agent !== 'read-write')) {
      return reply.code(409).send({ error: 'this connection no longer lets agents write; reject it instead' });
    }
    const t0 = Date.now();
    const log = (ok: boolean, rows: number, error?: string) => logDbQuery(store, c.id, {
      at: t0, who: `${a.who || 'an agent'} (approved by ${req.user!.name})`, conv: a.conv, ...(a.database && { database: a.database }),
      sql: a.sql.slice(0, 4000), ok, rows, ms: Date.now() - t0, ...(error && { error }),
    });
    try {
      const refused = agentRefusal(a.sql, c.driver, false);
      if (refused) throw new Error(refused);
      const results = await runScript(onDatabase(c, a.database), a.sql, { readOnly: false, limit: 50, timeoutMs: PANEL_TIMEOUT_MS, maxCell: 2000 });
      const outcome = describeResults(results);
      log(true, results.reduce((n, r) => n + r.rows.length, 0));
      done({ status: 'approved', outcome });
      tellChat(a, `[SQL editor] An admin approved your write on ${where(a)} and it ran.${sqlBlock(a)}\n\nResult:\n${outcome}`);
    } catch (e) {
      const msg = (e as Error).message;
      log(false, 0, msg);
      done({ status: 'failed', outcome: msg });
      tellChat(a, `[SQL editor] An admin approved your write on ${where(a)}, but it failed. Statements before the failing one did run.${sqlBlock(a)}\n\nError: ${msg}`);
    }
    return a;
  };
  app.post<{ Params: { id: string } }>('/api/db/approvals/:id/approve', { onRequest: requireAdmin }, decide('approve'));
  app.post<{ Params: { id: string } }>('/api/db/approvals/:id/reject', { onRequest: requireAdmin }, decide('reject'));
}

/**
 * The SQL editor (/sql): database connections for the whole panel, not tied to a chat. Admins add and change them;
 * each has an access level like a project's (who may open it in the panel) and an agent mode (whether agents get it
 * through the gateway's MCP tools, read-only or read-write). Passwords never go back to the panel.
 */
import { existsSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  AGENT_MODES, type DbConnection, DEFAULT_PORT, DRIVERS, listDatabases, loadConnections, onDatabase, QueryError, readSchema,
  runScript, saveConnections, SSL_MODES, testConnection,
} from './databases.js';
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

export function databaseRoutes(app: FastifyInstance, d: { store: Store; stateDir: string }): void {
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
      agent: b.readOnly && b.agent === 'read-write' ? 'read-only' : b.agent,
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
    try { return { version: await testConnection(c) }; } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
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

  // Runs a script (one or more statements); a failure answers 400 with the results of the statements before it.
  app.post<{ Params: { id: string }; Body: { sql: string; limit?: number; database?: string } }>('/api/db/connections/:id/query', {
    schema: { body: { type: 'object', required: ['sql'], additionalProperties: false, properties: {
      sql: { type: 'string', minLength: 1, maxLength: 1_000_000 }, limit: { type: 'integer', minimum: 1, maximum: 10_000 },
      database: DATABASE,
    } } },
  }, async (req, reply) => {
    const c = find(req.user!, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    try {
      return { readOnly: c.readOnly, results: await runScript(onDatabase(c, req.body.database), req.body.sql, { readOnly: c.readOnly, limit: req.body.limit ?? PANEL_LIMIT, timeoutMs: PANEL_TIMEOUT_MS }) };
    } catch (e) {
      const q = e instanceof QueryError ? e : null;
      return reply.code(400).send({ error: (e as Error).message, index: q?.index ?? 0, results: q?.results ?? [] });
    }
  });

  app.get<{ Params: { id: string } }>('/api/db/connections/:id/log', { onRequest: requireAdmin }, (req, reply) => {
    if (!find(req.user!, req.params.id)) return reply.code(404).send({ error: 'not found' });
    return readDbLog(store, req.params.id);
  });
}

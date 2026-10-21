/**
 * The SQL editor (/sql): database connections for the whole panel, not tied to a chat. Admins add and change them;
 * each has an access level like a project's (who may open it in the panel) and an agent mode (whether agents get it
 * through the gateway's MCP tools: read-only, writes after an admin's approval, or read-write). Passwords never go back
 * to the panel.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { FastifyInstance } from 'fastify';
import {
  AGENT_MODES, agentRefusal, countRows, type DbConnection, DEFAULT_PORT, DRIVERS, editRows, findUnsafe, listDatabases, loadConnections, onDatabase,
  planBackup, previewEdits, QueryError, type QueryResult, readBackup, readDdl, readSchema, type RowEdit, runScript, saveConnections, SSL_MODES,
  testConnection,
} from './databases.js';
import type { Dispatcher } from './dispatcher.js';
import { keyProblem, type SshConf } from './ssh-tunnel.js';
import type { Store } from './store.js';
import { type AuthUser, canAccess, PROJECT_ACCESS } from './util.js';

const ID = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const LOG_MAX = 200;
export const PANEL_LIMIT = 500;
const PANEL_TIMEOUT_MS = 120_000;

/** What the panel sees of a connection: everything but the password. */
const view = ({ password, ssh, ...c }: DbConnection) => ({
  ...c, hasPassword: !!password,
  // The SSH tunnel without its password, key or passphrase: only whether they are set.
  ...(ssh && { ssh: { enabled: ssh.enabled, host: ssh.host, port: ssh.port, user: ssh.user, auth: ssh.auth, hostKey: ssh.hostKey,
    hasPassword: !!ssh.password, hasKey: !!ssh.privateKey, hasPassphrase: !!ssh.passphrase } }),
});

/**
 * One agent query, for the connection's log (admins read it in the SQL editor). `backup`: the file the rows it was about
 * to change were kept in (`backupRows` of them).
 */
export interface DbLogEntry {
  at: number; who: string; conv: string | null; database?: string; sql: string; ok: boolean; rows: number; ms: number; error?: string;
  backup?: string; backupRows?: number;
}

// ---------- backups of what an agent's write changes ----------

/** At most this many rows (documents) are kept before one write; a bigger write is refused. */
export const BACKUP_MAX_ROWS = 50_000;
const BACKUP_KEEP = LOG_MAX;
const BACKUP_FILE = /^[0-9TZ-]+-[0-9a-f]{6}\.json$/;
export const backupDir = (stateDir: string, conn: string) => join(stateDir, 'db-backups', conn);

/** A backup taken: its file (none when nothing could be read), how many rows, and the writes it could not cover. */
export interface DbBackup { file?: string; rows: number; skipped: string[] }

/**
 * Before an agent's write runs: reads the rows its UPDATE / DELETE / TRUNCATE / DROP TABLE statements (MongoDB: its
 * updates, deletes and drops) are about to change, and keeps them in a JSON file under the state folder (the newest
 * 200 per connection). Null for a script that changes nothing already there. Throws when they cannot be read (the write
 * must not run then).
 */
export async function backupWrite(stateDir: string, c: DbConnection, meta: { database?: string; sql: string; who: string; conv: string | null; approval?: number }): Promise<DbBackup | null> {
  const plan = planBackup(meta.sql, c.driver);
  if (!plan.reads.length && !plan.skipped.length) return null;
  const tables = await readBackup(c, plan, BACKUP_MAX_ROWS, PANEL_TIMEOUT_MS);
  const rows = tables.reduce((n, t) => n + (t.rows?.length ?? t.documents?.length ?? 0), 0);
  if (!tables.length) return { rows, skipped: plan.skipped };
  const dir = backupDir(stateDir, c.id);
  await mkdir(dir, { recursive: true });
  const file = `${new Date().toISOString().replace(/[:.]/g, '-')}-${randomBytes(3).toString('hex')}.json`;
  await writeFile(join(dir, file), JSON.stringify({
    connection: c.id, driver: c.driver, ...(meta.database && { database: meta.database }), at: Date.now(), who: meta.who, conv: meta.conv,
    ...(meta.approval && { approval: meta.approval }), sql: meta.sql, rows, tables, ...(plan.skipped.length && { notBackedUp: plan.skipped }),
  }, null, 1));
  // The list the panel shows, newest first, read and written in one go (two backups at once must not lose an entry).
  const entry: DbBackupEntry = {
    file, at: Date.now(), who: meta.who, conv: meta.conv, ...(meta.database && { database: meta.database }), ...(meta.approval && { approval: meta.approval }),
    sql: meta.sql.slice(0, 4000), rows, tables: [...new Set(tables.map((t) => t.table))], ...(plan.skipped.length && { notBackedUp: plan.skipped.length }),
  };
  const list = [entry, ...readBackupIndex(dir)];
  writeFileSync(join(dir, BACKUP_INDEX), JSON.stringify(list.slice(0, BACKUP_KEEP)));
  // Names start with the time, so sorting them sorts by age.
  const old = (await readdir(dir)).filter((f) => BACKUP_FILE.test(f)).sort().slice(0, -BACKUP_KEEP);
  await Promise.all(old.map((f) => rm(join(dir, f), { force: true })));
  return { file, rows, skipped: plan.skipped };
}

/** A backup as the panel lists it (the file holds the rows). */
export interface DbBackupEntry {
  file: string; at: number; who: string; conv: string | null; database?: string; approval?: number; sql: string; rows: number;
  tables: string[]; notBackedUp?: number;
}
const BACKUP_INDEX = 'index.json';
function readBackupIndex(dir: string): DbBackupEntry[] {
  try { return JSON.parse(readFileSync(join(dir, BACKUP_INDEX), 'utf8')); } catch { return []; }
}
/** A connection's backups, newest first: those whose file is still there. */
export function listBackups(stateDir: string, conn: string): DbBackupEntry[] {
  const dir = backupDir(stateDir, conn);
  return readBackupIndex(dir).filter((b) => BACKUP_FILE.test(b.file) && existsSync(join(dir, b.file)));
}

/** For the agent and the chat: what was kept, and what was not. */
export const describeBackup = (b: DbBackup | null) => (!b ? '' : [
  b.file ? `Backed up ${b.rows} row(s) it changes first (${b.file}; admins find it under Backups in the connection's menu in the SQL editor).` : '',
  ...b.skipped.map((s) => `Not backed up: ${s}`),
].filter(Boolean).join('\n'));
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
  /** The backup file taken before it ran. */
  backup?: string;
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
/** Changes one approval in the list as stored now: others may have come or been decided meanwhile. */
function updateDbApproval(store: Store, id: number, patch: Partial<DbApproval>): void {
  const list = readDbApprovals(store);
  const a = list.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  saveDbApprovals(store, list);
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
  /** The SSH tunnel; its password, privateKey and passphrase as `password` above. hostKey: the one Test connection showed. */
  ssh?: { enabled: boolean; host?: string; port?: number; user?: string; auth?: 'password' | 'key'; password?: string; privateKey?: string; passphrase?: string; hostKey?: string };
  /** The workspaces it is in (all of them, replacing the old set). Omitted: as it was; a new one goes in the first. */
  workspaces?: string[];
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
    ssh: { type: 'object', required: ['enabled'], additionalProperties: false, properties: {
      enabled: { type: 'boolean' }, host: { type: 'string', maxLength: 255 }, port: { type: 'integer', minimum: 0, maximum: 65535 },
      user: { type: 'string', maxLength: 255 }, auth: { enum: ['password', 'key'] }, password: { type: 'string', maxLength: 1000 },
      privateKey: { type: 'string', maxLength: 20_000 }, passphrase: { type: 'string', maxLength: 1000 }, hostKey: { type: 'string', maxLength: 200 },
    } },
    workspaces: { type: 'array', maxItems: 200, items: { type: 'string', maxLength: 40 } },
  },
};

/**
 * A workspace of the SQL editor: a named set of connections (one connection may be in several). The panel shows one at
 * a time, with its own consoles; who may open a connection is still the connection's own access.
 */
export interface DbWorkspace { id: string; name: string; conns: string[] }
const WORKSPACES = 'db_workspaces';
/** The workspaces; the first time, one named Default with every connection in it. */
export function loadWorkspaces(store: Store): DbWorkspace[] {
  try {
    const list = JSON.parse(store.getKv(WORKSPACES) ?? 'null');
    if (Array.isArray(list) && list.length) return list;
  } catch { /* made again below */ }
  const first = [{ id: 'default', name: 'Default', conns: loadConnections(store).map((c) => c.id) }];
  store.setKv(WORKSPACES, JSON.stringify(first));
  return first;
}
const saveWorkspaces = (store: Store, list: DbWorkspace[]) => store.setKv(WORKSPACES, JSON.stringify(list));
/** Puts connection `id` in exactly the workspaces `ids` (unknown ids are skipped). */
function setMembership(store: Store, id: string, ids: string[]): void {
  saveWorkspaces(store, loadWorkspaces(store).map((w) => {
    const has = w.conns.includes(id);
    const want = ids.includes(w.id);
    return has === want ? w : { ...w, conns: want ? [...w.conns, id] : w.conns.filter((c) => c !== id) };
  }));
}
const WS_NAME = { type: 'string', minLength: 1, maxLength: 60 };
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
      // Dalang's own state (sessions, other connections' passwords) is only available to the owner.
      const real = realpathSync(file);
      const rel = relative(realpathSync(resolve(d.stateDir)), real);
      if ((!rel || (!rel.startsWith('..') && !isAbsolute(rel))) && b.access !== 'owner') return 'files in Dalang\'s state folder cannot be opened';
      Object.assign(c, { host: '', port: 0, user: '', password: '', database: '', ssl: 'disable', file: real });
    } else if (!c.host) return 'a host is needed';
    if (b.driver !== 'sqlite' && (b.ssh || old?.ssh)) {
      const s = b.ssh ?? { enabled: false };
      const was = old?.ssh;
      const ssh: SshConf = {
        enabled: s.enabled, host: (s.host ?? was?.host ?? '').trim(), port: s.port || was?.port || 22, user: (s.user ?? was?.user ?? '').trim(),
        auth: s.auth ?? was?.auth ?? 'password',
        password: s.password === undefined ? was?.password ?? '' : s.password,
        privateKey: s.privateKey === undefined ? was?.privateKey ?? '' : s.privateKey.trim() ? `${s.privateKey.trim()}\n` : '',
        passphrase: s.passphrase === undefined ? was?.passphrase ?? '' : s.passphrase,
        // A key trusted for one server says nothing about another: a new address starts untrusted.
        hostKey: s.hostKey ?? (was && was.host === (s.host ?? was.host).trim() && was.port === (s.port || was.port) ? was.hostKey : ''),
      };
      if (ssh.enabled) {
        if (!ssh.host || !ssh.user) return 'the SSH tunnel needs a host and a user';
        if (/^(mongodb(\+srv)?|rediss?):\/\//i.test(c.host)) return 'through SSH, give the database\'s host and port rather than a URI';
        if (ssh.auth === 'key') {
          if (!ssh.privateKey) return 'the SSH tunnel needs a private key';
          const bad = keyProblem(ssh.privateKey, ssh.passphrase);
          if (bad) return `the SSH private key cannot be read: ${bad}`;
        }
      }
      c.ssh = ssh;
    }
    return c;
  };

  app.get('/api/db/connections', (req) => loadConnections(store).filter((c) => canAccess(req.user!, c.access)).map(view));
  // The connections an agent in this user's chats may use, for the composer's @db list: no more than db_list_connections shows.
  app.get('/api/db/agent-connections', (req) => loadConnections(store).filter((c) => c.agent !== 'off' && canAccess(req.user!, c.access))
    .map((c) => ({ id: c.id, label: c.label, engine: c.driver })));

  app.put<{ Params: { id: string }; Body: Body }>('/api/db/connections/:id', { onRequest: requireAdmin, schema: { body: BODY } }, (req, reply) => {
    const { id } = req.params;
    if (!ID.test(id)) return reply.code(400).send({ error: 'name: lowercase letters, digits, - and _ (at most 32)' });
    const list = loadConnections(store);
    const old = list.find((c) => c.id === id);
    if (old && !canAccess(req.user!, old.access)) return reply.code(409).send({ error: `${id} is taken` });
    const next = build(id, req.body, req.user!, old);
    if (typeof next === 'string') return reply.code(400).send({ error: next });
    saveConnections(store, old ? list.map((c) => (c === old ? next : c)) : [...list, next]);
    if (req.body.workspaces) setMembership(store, id, req.body.workspaces);
    else if (!old) setMembership(store, id, [loadWorkspaces(store)[0]!.id]);
    return view(next);
  });

  app.delete<{ Params: { id: string } }>('/api/db/connections/:id', { onRequest: requireAdmin }, (req, reply) => {
    if (!find(req.user!, req.params.id)) return reply.code(404).send({ error: 'not found' });
    saveConnections(store, loadConnections(store).filter((c) => c.id !== req.params.id));
    setMembership(store, req.params.id, []);
    store.setKv(logKey(req.params.id), '[]');
    return reply.code(204).send();
  });

  // Workspaces: everyone reads them (a connection one may not open stays hidden: the panel lists those it may); admins
  // add, rename and remove them, and say which connections are in each.
  app.get('/api/db/workspaces', () => loadWorkspaces(store));

  app.post<{ Body: { name: string } }>('/api/db/workspaces', {
    onRequest: requireAdmin, schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: WS_NAME } } },
  }, (req, reply) => {
    const list = loadWorkspaces(store);
    const name = req.body.name.trim();
    if (!name) return reply.code(400).send({ error: 'a workspace needs a name' });
    const base = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 30) || 'workspace';
    let id = base;
    for (let n = 2; list.some((w) => w.id === id); n++) id = `${base}-${n}`;
    const w: DbWorkspace = { id, name, conns: [] };
    saveWorkspaces(store, [...list, w]);
    return reply.code(201).send(w);
  });

  app.patch<{ Params: { id: string }; Body: { name?: string; conns?: string[] } }>('/api/db/workspaces/:id', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', additionalProperties: false, properties: {
      name: WS_NAME, conns: { type: 'array', maxItems: 1000, items: { type: 'string', maxLength: 32 } },
    } } },
  }, (req, reply) => {
    const list = loadWorkspaces(store);
    const w = list.find((x) => x.id === req.params.id);
    if (!w) return reply.code(404).send({ error: 'not found' });
    if (req.body.name !== undefined) {
      if (!req.body.name.trim()) return reply.code(400).send({ error: 'a workspace needs a name' });
      w.name = req.body.name.trim();
    }
    if (req.body.conns) {
      // Connections this admin cannot see stay as they were (an admin cannot take out the owner's own ones).
      const known = new Set(loadConnections(store).map((c) => c.id));
      const hidden = w.conns.filter((c) => known.has(c) && !find(req.user!, c));
      w.conns = [...new Set([...hidden, ...req.body.conns.filter((c) => known.has(c) && find(req.user!, c))])];
    }
    saveWorkspaces(store, list);
    return w;
  });

  app.delete<{ Params: { id: string } }>('/api/db/workspaces/:id', { onRequest: requireAdmin }, (req, reply) => {
    const list = loadWorkspaces(store);
    if (!list.some((w) => w.id === req.params.id)) return reply.code(404).send({ error: 'not found' });
    if (list.length === 1) return reply.code(409).send({ error: 'the last workspace stays' });
    saveWorkspaces(store, list.filter((w) => w.id !== req.params.id));
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

  // Every schema's tables (with columns on a small database), or `?schema=` one schema's tables with their columns.
  app.get<{ Params: { id: string }; Querystring: { database?: string; schema?: string } }>('/api/db/connections/:id/schema', {
    schema: { querystring: { type: 'object', properties: { database: DATABASE, schema: { type: 'string', minLength: 1, maxLength: 128 } } } },
  }, async (req, reply) => {
    const c = find(req.user!, req.params.id);
    if (!c) return reply.code(404).send({ error: 'not found' });
    try { return await readSchema(onDatabase(c, req.query.database), 30_000, req.query.schema); } catch (e) { return reply.code(400).send({ error: (e as Error).message }); }
  });

  // Runs a script (one or more statements); a failure answers 400 with the results of the statements before it. A script
  // with a statement that hits every row (UPDATE or DELETE without WHERE, TRUNCATE) runs only once `confirmed`: until
  // then it answers 409 with those statements and how many rows their tables have, and runs nothing.
  app.post<{ Params: { id: string }; Body: { sql: string; limit?: number; database?: string; schema?: string; confirmed?: boolean } }>('/api/db/connections/:id/query', {
    schema: { body: { type: 'object', required: ['sql'], additionalProperties: false, properties: {
      sql: { type: 'string', minLength: 1, maxLength: 1_000_000 }, limit: { type: 'integer', minimum: 1, maximum: 10_000 },
      database: DATABASE, confirmed: { type: 'boolean' },
      // PostgreSQL: the schema unqualified names are looked up in first (the console's schema picker).
      schema: { type: 'string', minLength: 1, maxLength: 128 },
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
        ...(c.driver === 'postgres' && req.body.schema && { schema: req.body.schema }),
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

  // The backups taken before agents' writes on this connection, newest first.
  app.get<{ Params: { id: string } }>('/api/db/connections/:id/backups', { onRequest: requireAdmin }, (req, reply) => {
    if (!find(req.user!, req.params.id)) return reply.code(404).send({ error: 'not found' });
    return listBackups(d.stateDir, req.params.id);
  });

  // One of them (named in the list and the log), as a JSON file.
  app.get<{ Params: { id: string; file: string } }>('/api/db/connections/:id/backups/:file', { onRequest: requireAdmin }, async (req, reply) => {
    if (!find(req.user!, req.params.id) || !BACKUP_FILE.test(req.params.file)) return reply.code(404).send({ error: 'not found' });
    let body: Buffer;
    try { body = await readFile(join(backupDir(d.stateDir, req.params.id), req.params.file)); } catch { return reply.code(404).send({ error: 'not found (only the newest 200 are kept)' }); }
    return reply.type('application/json').header('content-disposition', `attachment; filename="${req.params.id}-${req.params.file}"`).send(body);
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
  // Approvals whose write is running now: another Approve (a second admin, a double click) or a Reject must wait for it.
  const running = new Set<number>();
  const decide = (verb: 'approve' | 'reject') => async (req: { params: { id: string }; user?: AuthUser }, reply: any) => {
    const a = readDbApprovals(store).find((x) => x.id === Number(req.params.id));
    if (!a || !visibleApproval(req.user!, a)) return reply.code(404).send({ error: 'not found' });
    if (running.has(a.id)) return reply.code(409).send({ error: 'already being run' });
    if (a.status !== 'pending') return reply.code(409).send({ error: `already ${a.status}` });
    const done = (patch: Partial<DbApproval>) => {
      Object.assign(a, { decidedBy: req.user!.name, decidedAt: Date.now(), ...patch });
      updateDbApproval(store, a.id, a);
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
    running.add(a.id);
    const t0 = Date.now();
    let backup: DbBackup | null = null;
    // Whether the write itself started (a refusal or a failed backup runs none of it).
    let started = false;
    const log = (ok: boolean, rows: number, error?: string) => logDbQuery(store, c.id, {
      at: t0, who: `${a.who || 'an agent'} (approved by ${req.user!.name})`, conv: a.conv, ...(a.database && { database: a.database }),
      sql: a.sql.slice(0, 4000), ok, rows, ms: Date.now() - t0, ...(error && { error }),
      ...(backup?.file && { backup: backup.file, backupRows: backup.rows }),
    });
    try {
      const refused = agentRefusal(a.sql, c.driver, false);
      if (refused) throw new Error(refused);
      const target = onDatabase(c, a.database);
      try {
        backup = await backupWrite(d.stateDir, target, { ...(a.database && { database: a.database }), sql: a.sql, who: a.who, conv: a.conv, approval: a.id });
      } catch (e) { throw new Error(`the backup of what it changes failed, so it did not run: ${(e as Error).message}`); }
      started = true;
      const results = await runScript(target, a.sql, { readOnly: false, limit: 50, timeoutMs: PANEL_TIMEOUT_MS, maxCell: 2000 });
      const outcome = [describeResults(results), describeBackup(backup)].filter(Boolean).join('\n');
      log(true, results.reduce((n, r) => n + r.rows.length, 0));
      done({ status: 'approved', outcome, ...(backup?.file && { backup: backup.file }) });
      tellChat(a, `[SQL editor] An admin approved your write on ${where(a)} and it ran.${sqlBlock(a)}\n\nResult:\n${outcome}`);
    } catch (e) {
      const msg = (e as Error).message;
      log(false, 0, msg);
      const outcome = [msg, describeBackup(backup)].filter(Boolean).join('\n');
      done({ status: 'failed', outcome, ...(backup?.file && { backup: backup.file }) });
      tellChat(a, `[SQL editor] An admin approved your write on ${where(a)}, but it failed. ${started ? 'Statements before the failing one did run.' : 'None of it ran.'}${sqlBlock(a)}\n\nError: ${outcome}`);
    } finally {
      running.delete(a.id);
    }
    return a;
  };
  app.post<{ Params: { id: string } }>('/api/db/approvals/:id/approve', { onRequest: requireAdmin }, decide('approve'));
  app.post<{ Params: { id: string } }>('/api/db/approvals/:id/reject', { onRequest: requireAdmin }, decide('reject'));
}

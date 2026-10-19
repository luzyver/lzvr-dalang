import type { FastifyInstance } from 'fastify';
import { cbmVersion, type CodeMemory } from './code-memory.js';
import type { Push } from './push.js';
import type { Store } from './store.js';
import { type AuthUser, canAccess } from './util.js';

/**
 * Settings → MCP → Code memory, for the owner only (it names a command this machine runs): the CBM binary and its
 * folders, and every project's index with a button to index it (the only way a project gets indexed), and whether its
 * files changed since.
 */
export function codeMemoryRoutes(app: FastifyInstance, d: { store: Store; codeMemory: CodeMemory }): void {
  const { store, codeMemory: cm } = d;
  const requireOwner = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!req.user || req.user.id !== null) return reply.code(403).send({ error: 'owner only' });
  };
  const view = async () => ({
    ...cm.settings(), active: cm.active, tools: cm.tools().map((t) => `code_${t.name}`),
    projects: await Promise.all(store.listProjects().map(async (p) => ({
      id: p.id, name: p.name, path: p.path, index: cm.state(p.id), changed: await cm.changedSinceIndex(p),
    }))),
  });

  app.get('/api/settings/code-memory', { onRequest: requireOwner }, () => view());

  app.put<{ Body: { enabled: boolean; command: string; cacheDir: string; runtimeDir: string; hooks?: boolean } }>('/api/settings/code-memory', {
    onRequest: requireOwner,
    schema: { body: {
      type: 'object', required: ['enabled', 'command', 'cacheDir', 'runtimeDir'], additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' }, command: { type: 'string', maxLength: 500 },
        cacheDir: { type: 'string', maxLength: 500 }, runtimeDir: { type: 'string', maxLength: 500 }, hooks: { type: 'boolean' },
      },
    } },
  }, async (req, reply) => {
    const b = req.body;
    const next = {
      enabled: b.enabled, command: b.command.trim(), cacheDir: b.cacheDir.trim(), runtimeDir: b.runtimeDir.trim(), hooks: b.hooks ?? true,
    };
    if (next.enabled && !next.command) return reply.code(400).send({ error: 'give the path of the codebase-memory-mcp binary' });
    await cm.save(next);
    return view();
  });

  // Whether the binary runs: its version.
  app.post('/api/settings/code-memory/test', { onRequest: requireOwner }, async (_req, reply) => {
    const { command } = cm.settings();
    if (!command) return reply.code(400).send({ error: 'no binary set' });
    try { return { version: await cbmVersion(command) }; } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });

  // Index a project now; answers at once, the panel polls the list.
  app.post<{ Params: { id: string } }>('/api/settings/code-memory/projects/:id/index', { onRequest: requireOwner }, (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return reply.code(404).send({ error: 'not found' });
    if (!cm.settings().enabled) return reply.code(400).send({ error: 'code memory is off' });
    void cm.index(project);
    return reply.code(202).send({ queued: true });
  });
}

/** A request to index a project's code graph from a user who may not index themselves, until an admin decides. */
export interface IndexRequest {
  id: number; project: string; who: string; at: number;
  status: 'pending' | 'approved' | 'rejected'; decidedBy?: string; decidedAt?: number;
}
const REQUESTS = 'code_memory_requests';
/** Keeps every pending one and the last 100 decided. */
const DECIDED_MAX = 100;

export function readIndexRequests(store: Store): IndexRequest[] {
  try { return JSON.parse(store.getKv(REQUESTS) ?? '[]'); } catch { return []; }
}
function saveIndexRequests(store: Store, list: IndexRequest[]): void {
  const decided = list.filter((r) => r.status !== 'pending').slice(-DECIDED_MAX);
  store.setKv(REQUESTS, JSON.stringify(list.filter((r) => r.status === 'pending' || decided.includes(r))));
}

/**
 * Indexing from the chat, for every user: an admin (or the owner) indexes the projects they may open at once; anyone
 * else asks, and the index runs once an admin approves (Approvals). Indexing takes the machine's cores for a while,
 * which is why it is not anyone's to start.
 */
export function codeIndexRoutes(app: FastifyInstance, d: { store: Store; codeMemory: CodeMemory; push: Push }): void {
  const { store, codeMemory: cm, push } = d;
  const admin = (u: AuthUser) => u.role === 'admin';
  /** The project, if this user may open it. */
  const projectFor = (u: AuthUser, id: string) => { const p = store.getProject(id); return p && canAccess(u, p.access) ? p : null; };
  const pendingFor = (projectId: string) => readIndexRequests(store).find((r) => r.project === projectId && r.status === 'pending') ?? null;

  app.get<{ Params: { id: string } }>('/api/projects/:id/code-memory', async (req, reply) => {
    const p = projectFor(req.user!, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    return {
      enabled: cm.settings().enabled, index: cm.state(p.id), changed: await cm.changedSinceIndex(p),
      pending: pendingFor(p.id), direct: admin(req.user!),
    };
  });

  app.post<{ Params: { id: string } }>('/api/projects/:id/code-memory/index', (req, reply) => {
    const u = req.user!;
    const p = projectFor(u, req.params.id);
    if (!p) return reply.code(404).send({ error: 'not found' });
    if (!cm.settings().enabled) return reply.code(400).send({ error: 'code memory is off' });
    if (admin(u)) {
      void cm.index(p);
      return reply.code(202).send({ status: 'indexing' });
    }
    const open = pendingFor(p.id);
    if (open) return { status: 'pending_approval', request: open };
    const list = readIndexRequests(store);
    const r: IndexRequest = { id: Math.max(0, ...list.map((x) => x.id)) + 1, project: p.id, who: u.name, at: Date.now(), status: 'pending' };
    saveIndexRequests(store, [...list, r]);
    void push.notify({ title: 'Approval needed', body: `${u.name} asks to index the code graph of ${p.name}`, convId: '' });
    return reply.code(202).send({ status: 'pending_approval', request: r });
  });

  // Requests waiting for an admin: those of projects the admin may open.
  app.get('/api/code-memory/requests', async (req, reply) => {
    if (!admin(req.user!)) return reply.code(403).send({ error: 'admin only' });
    return readIndexRequests(store).filter((r) => r.status === 'pending' && projectFor(req.user!, r.project))
      .map((r) => ({ ...r, projectName: store.getProject(r.project)!.name })).reverse();
  });

  const decide = (verb: 'approve' | 'reject') => async (req: { params: { id: string }; user?: AuthUser }, reply: any) => {
    if (!admin(req.user!)) return reply.code(403).send({ error: 'admin only' });
    const list = readIndexRequests(store);
    const r = list.find((x) => x.id === Number(req.params.id));
    const p = r && projectFor(req.user!, r.project);
    if (!r || !p) return reply.code(404).send({ error: 'not found' });
    if (r.status !== 'pending') return reply.code(409).send({ error: `already ${r.status}` });
    if (verb === 'approve') {
      if (!cm.settings().enabled) return reply.code(409).send({ error: 'code memory is off; turn it on first, or reject this' });
      void cm.index(p);
    }
    Object.assign(r, { status: verb === 'approve' ? 'approved' : 'rejected', decidedBy: req.user!.name, decidedAt: Date.now() });
    saveIndexRequests(store, list);
    return r;
  };
  app.post<{ Params: { id: string } }>('/api/code-memory/requests/:id/approve', decide('approve'));
  app.post<{ Params: { id: string } }>('/api/code-memory/requests/:id/reject', decide('reject'));
}

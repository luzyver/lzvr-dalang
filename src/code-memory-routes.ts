import type { FastifyInstance } from 'fastify';
import { cbmVersion, type CodeMemory } from './code-memory.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

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

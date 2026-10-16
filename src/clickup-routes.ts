import type { FastifyInstance } from 'fastify';
import { ClickUp, validTimeZone } from './clickup.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

/** What Settings → ClickUp saves (kv `clickup`). Empty strings mean "not set". */
interface Saved { token: string; workspaceId: string; timeZone: string }

const KEY = 'clickup';
const EMPTY: Saved = { token: '', workspaceId: '', timeZone: '' };

function load(store: Store): Saved {
  try {
    const s = { ...EMPTY, ...JSON.parse(store.getKv(KEY) ?? '{}') };
    return { token: s.token, workspaceId: s.workspaceId, timeZone: s.timeZone }; // drops keys older versions saved
  } catch { return EMPTY; }
}

/** The token is never sent back to the panel, only its last four characters. */
const view = (s: Saved) => ({
  configured: Boolean(s.token), tokenHint: s.token ? `…${s.token.slice(-4)}` : '',
  workspaceId: s.workspaceId, timeZone: s.timeZone,
});

/**
 * The ClickUp client for the current settings, or undefined while no token is saved. Built again only when the
 * settings change, so its cached user and workspace survive between MCP calls.
 */
export function clickupClient(store: Store, fetchImpl?: typeof fetch): () => ClickUp | undefined {
  let last: { raw: string; client: ClickUp | undefined } | null = null;
  return () => {
    const raw = store.getKv(KEY) ?? '';
    if (last?.raw !== raw) {
      const s = load(store);
      let client: ClickUp | undefined;
      try {
        client = s.token ? new ClickUp({
          token: s.token, workspaceId: s.workspaceId || undefined, timeZone: s.timeZone || undefined, fetch: fetchImpl,
        }) : undefined;
      } catch { client = undefined; } // saved settings are checked on save; never let a bad row break /mcp
      last = { raw, client };
    }
    return last.client;
  };
}

/**
 * Settings → ClickUp. The token is the owner's own, so only the owner (main token or owner sign-in) may see or change
 * these settings, not other admins.
 */
export function clickupRoutes(app: FastifyInstance, d: { store: Store; client: () => ClickUp | undefined }): void {
  const { store } = d;
  const requireOwner = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!req.user || req.user.id !== null) return reply.code(403).send({ error: 'owner only' });
  };

  app.get('/api/settings/clickup', { onRequest: requireOwner }, () => view(load(store)));

  // `token`: omitted keeps the saved one, '' removes it (which turns the ClickUp tools off).
  app.put<{ Body: { token?: string; workspaceId: string; timeZone: string } }>('/api/settings/clickup', {
    onRequest: requireOwner,
    schema: { body: {
      type: 'object', required: ['workspaceId', 'timeZone'], additionalProperties: false,
      properties: {
        token: { type: 'string', maxLength: 200 }, workspaceId: { type: 'string', pattern: '^[0-9]{0,20}$' },
        timeZone: { type: 'string', maxLength: 64 },
      },
    } },
  }, (req, reply) => {
    const b = req.body;
    const next: Saved = {
      token: b.token === undefined ? load(store).token : b.token.trim(),
      workspaceId: b.workspaceId.trim(), timeZone: b.timeZone.trim(),
    };
    if (next.timeZone && !validTimeZone(next.timeZone)) return reply.code(400).send({ error: `unknown time zone: ${next.timeZone}` });
    store.setKv(KEY, JSON.stringify(next));
    return view(next);
  });

  // Try the saved settings against ClickUp: who the token is, which workspace, which time zone.
  app.post('/api/settings/clickup/test', { onRequest: requireOwner }, async (_req, reply) => {
    const client = d.client();
    if (!client) return reply.code(400).send({ error: 'no ClickUp token saved' });
    try { return await client.whoami(); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });
}

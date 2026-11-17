import type { FastifyInstance } from 'fastify';
import { ClickUp, validTimeZone } from './clickup.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

/** One person's ClickUp: their personal token, default workspace and time zone. Empty strings mean "not set". */
interface Account { token: string; workspaceId: string; timeZone: string }

/**
 * What Settings → MCP → ClickUp saves (kv `clickup`). `users`: every person's own ClickUp, by their user key (see
 * clickupUserKey), so each one's turns read and send as their own ClickUp user. `send`: the owner's switch for
 * everyone, whoever has the tools also gets clickup_send_message.
 */
interface Saved { send: boolean; users: Record<string, Account> }

const KEY = 'clickup';
const NONE: Account = { token: '', workspaceId: '', timeZone: '' };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
const account = (v: any): Account => ({ token: str(v?.token), workspaceId: str(v?.workspaceId), timeZone: str(v?.timeZone) });
const blank = (a: Account) => !a.token && !a.workspaceId && !a.timeZone;

/** Whose ClickUp a request or turn uses: a panel user's id, 'owner' for the owner (as Store.userKeyOf gives). */
export const clickupUserKey = (u: AuthUser): string => u.id ?? 'owner';

function load(store: Store): Saved {
  try {
    const s = JSON.parse(store.getKv(KEY) ?? '{}');
    const users: Record<string, Account> = {};
    if (s.users && typeof s.users === 'object') for (const [k, v] of Object.entries(s.users)) users[k] = account(v);
    else if (!blank(account(s))) users.owner = account(s); // saved before every user had their own: the one token was the owner's
    return { send: s.send === true, users };
  } catch { return { send: false, users: {} }; }
}

/** The token is never sent back to the panel, only its last four characters. */
const view = (a: Account, send: boolean) => ({
  configured: Boolean(a.token), tokenHint: a.token ? `…${a.token.slice(-4)}` : '',
  workspaceId: a.workspaceId, timeZone: a.timeZone, send,
});

/** Whether whoever has the ClickUp tools may also send messages with them. */
export const clickupSend = (store: Store): boolean => load(store).send;

/** A user who is gone: their token goes with them. */
export function forgetClickUp(store: Store, userKey: string): void {
  const s = load(store);
  if (!(userKey in s.users)) return;
  delete s.users[userKey];
  store.setKv(KEY, JSON.stringify(s));
}

/**
 * The ClickUp client of one person (by user key), or undefined while they have no token saved. Built again only when
 * their settings change, so its cached user and workspace survive between MCP calls.
 */
export function clickupClient(store: Store, fetchImpl?: typeof fetch): (userKey: string) => ClickUp | undefined {
  const last = new Map<string, { raw: string; client: ClickUp | undefined }>();
  return (userKey) => {
    const a = load(store).users[userKey];
    if (!a?.token) { last.delete(userKey); return undefined; }
    const raw = JSON.stringify(a);
    let hit = last.get(userKey);
    if (hit?.raw !== raw) {
      let client: ClickUp | undefined;
      try {
        client = new ClickUp({ token: a.token, workspaceId: a.workspaceId || undefined, timeZone: a.timeZone || undefined, fetch: fetchImpl });
      } catch { client = undefined; } // saved settings are checked on save; never let a bad row break /mcp
      hit = { raw, client };
      last.set(userKey, hit);
    }
    return hit.client;
  };
}

/**
 * Settings → ClickUp. Everyone sees and changes their own token, workspace and time zone, never another person's.
 * Only the owner (main token or owner sign-in) sets `send`.
 */
export function clickupRoutes(app: FastifyInstance, d: { store: Store; client: (userKey: string) => ClickUp | undefined }): void {
  const { store } = d;

  app.get('/api/settings/clickup', (req) => {
    const s = load(store);
    return view(s.users[clickupUserKey(req.user!)] ?? NONE, s.send);
  });

  // `token`: omitted keeps the saved one, '' removes it (which turns the ClickUp tools off for this person).
  app.put<{ Body: { token?: string; workspaceId: string; timeZone: string; send?: boolean } }>('/api/settings/clickup', {
    schema: { body: {
      type: 'object', required: ['workspaceId', 'timeZone'], additionalProperties: false,
      properties: {
        token: { type: 'string', maxLength: 200 }, workspaceId: { type: 'string', pattern: '^[0-9]{0,20}$' },
        timeZone: { type: 'string', maxLength: 64 }, send: { type: 'boolean' },
      },
    } },
  }, (req, reply) => {
    const b = req.body;
    const owner = req.user!.id === null;
    if (b.send !== undefined && !owner) return reply.code(403).send({ error: 'only the owner allows sending' });
    const s = load(store);
    const key = clickupUserKey(req.user!);
    const next: Account = {
      token: b.token === undefined ? s.users[key]?.token ?? '' : b.token.trim(),
      workspaceId: b.workspaceId.trim(), timeZone: b.timeZone.trim(),
    };
    if (next.timeZone && !validTimeZone(next.timeZone)) return reply.code(400).send({ error: `unknown time zone: ${next.timeZone}` });
    if (blank(next)) delete s.users[key]; else s.users[key] = next;
    if (owner) s.send = b.send ?? false;
    store.setKv(KEY, JSON.stringify(s));
    return view(next, s.send);
  });

  // Try the saved settings against ClickUp: who the token is, which workspace, which time zone.
  app.post('/api/settings/clickup/test', async (req, reply) => {
    const client = d.client(clickupUserKey(req.user!));
    if (!client) return reply.code(400).send({ error: 'no ClickUp token saved' });
    try { return await client.whoami(); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });
}

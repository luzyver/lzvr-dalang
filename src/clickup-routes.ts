import type { FastifyInstance } from 'fastify';
import { ClickUp, validTimeZone } from './clickup.js';
import { authorizeUrl, exchangeCode, type Pkce, pkce, registerClient } from './clickup-mcp.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

/**
 * One person's ClickUp: `oauth`, the access token of their connection to ClickUp's own MCP server (see clickup-mcp.ts),
 * through which everything is read and done, and their default workspace and time zone. Empty strings mean "not set".
 */
interface Account { workspaceId: string; timeZone: string; oauth: string }

/**
 * What Settings → MCP → ClickUp saves (kv `clickup`). `users`: every person's own ClickUp, by their user key (see
 * clickupUserKey), so each one's turns read and send as their own ClickUp user. `send`: the owner's switch for
 * everyone, whoever has the tools may also ask to send messages and make changes. `clients`: the OAuth client id ClickUp gave this
 * panel, by the address a sign-in comes back to.
 */
interface Saved { send: boolean; users: Record<string, Account>; clients: Record<string, string> }

const KEY = 'clickup';
const NONE: Account = { workspaceId: '', timeZone: '', oauth: '' };
const str = (v: unknown) => (typeof v === 'string' ? v : '');
/** A personal API token (pk_...) saved before ClickUp went through its MCP server is not read any more, and goes on the next save. */
const account = (v: any): Account => ({ workspaceId: str(v?.workspaceId), timeZone: str(v?.timeZone), oauth: str(v?.oauth) });
const blank = (a: Account) => !a.workspaceId && !a.timeZone && !a.oauth;

/** Whose ClickUp a request or turn uses: a panel user's id, 'owner' for the owner (as Store.userKeyOf gives). */
export const clickupUserKey = (u: AuthUser): string => u.id ?? 'owner';

function load(store: Store): Saved {
  try {
    const s = JSON.parse(store.getKv(KEY) ?? '{}');
    const users: Record<string, Account> = {};
    if (s.users && typeof s.users === 'object') for (const [k, v] of Object.entries(s.users)) users[k] = account(v);
    else if (!blank(account(s))) users.owner = account(s); // saved before every user had their own: the one ClickUp was the owner's
    const clients: Record<string, string> = {};
    if (s.clients && typeof s.clients === 'object') for (const [k, v] of Object.entries(s.clients)) if (typeof v === 'string') clients[k] = v;
    return { send: s.send === true, users, clients };
  } catch { return { send: false, users: {}, clients: {} }; }
}

/** The access token is never sent back to the panel, only that the connection is there. */
const view = (a: Account, send: boolean) => ({ connected: Boolean(a.oauth), workspaceId: a.workspaceId, timeZone: a.timeZone, send });

/** Whether whoever has the ClickUp tools may also send messages with them. */
export const clickupSend = (store: Store): boolean => load(store).send;

/** A user who is gone: their connection goes with them. */
export function forgetClickUp(store: Store, userKey: string): void {
  const s = load(store);
  if (!(userKey in s.users)) return;
  delete s.users[userKey];
  store.setKv(KEY, JSON.stringify(s));
}

/**
 * The ClickUp client of one person (by user key), or undefined while they have not connected ClickUp. Built again only when
 * their settings change, so its cached user and workspace survive between MCP calls.
 */
export function clickupClient(store: Store, fetchImpl?: typeof fetch): (userKey: string) => ClickUp | undefined {
  const last = new Map<string, { raw: string; client: ClickUp | undefined }>();
  return (userKey) => {
    const a = load(store).users[userKey];
    if (!a?.oauth) { last.delete(userKey); return undefined; }
    const raw = JSON.stringify(a);
    let hit = last.get(userKey);
    if (hit?.raw !== raw) {
      let client: ClickUp | undefined;
      try {
        client = new ClickUp({ token: a.oauth, workspaceId: a.workspaceId || undefined, timeZone: a.timeZone || undefined, fetch: fetchImpl });
      } catch { client = undefined; } // saved settings are checked on save; never let a bad row break /mcp
      hit = { raw, client };
      last.set(userKey, hit);
    }
    return hit.client;
  };
}

/** How long a sign-in started in Settings may take to come back. */
const SIGN_IN_MS = 10 * 60_000;

/**
 * Settings → ClickUp. Everyone connects their own ClickUp and sets their own workspace and time zone, never another
 * person's.
 * Only the owner (main token or owner sign-in) sets `send`.
 */
export function clickupRoutes(app: FastifyInstance, d: {
  store: Store; client: (userKey: string) => ClickUp | undefined; origin?: string; fetch?: typeof fetch;
}): void {
  const { store } = d;
  /** Sign-ins started and not back yet, by their `state`: whose it is and what the code is exchanged with. */
  const pending = new Map<string, Pkce & { user: string; clientId: string; redirectUri: string; at: number }>();
  // A personal API token saved before ClickUp went through its MCP server is not read any more: it is dropped.
  if (/"token"/.test(store.getKv(KEY) ?? '')) store.setKv(KEY, JSON.stringify(load(store)));

  app.get('/api/settings/clickup', (req) => {
    const s = load(store);
    return view(s.users[clickupUserKey(req.user!)] ?? NONE, s.send);
  });

  app.put<{ Body: { workspaceId: string; timeZone: string; send?: boolean } }>('/api/settings/clickup', {
    schema: { body: {
      type: 'object', required: ['workspaceId', 'timeZone'], additionalProperties: false,
      properties: {
        workspaceId: { type: 'string', pattern: '^[0-9]{0,20}$' },
        timeZone: { type: 'string', maxLength: 64 }, send: { type: 'boolean' },
      },
    } },
  }, (req, reply) => {
    const b = req.body;
    const owner = req.user!.id === null;
    if (b.send !== undefined && !owner) return reply.code(403).send({ error: 'only the owner allows sending' });
    const s = load(store);
    const key = clickupUserKey(req.user!);
    const next: Account = { workspaceId: b.workspaceId.trim(), timeZone: b.timeZone.trim(), oauth: s.users[key]?.oauth ?? '' };
    if (next.timeZone && !validTimeZone(next.timeZone)) return reply.code(400).send({ error: `unknown time zone: ${next.timeZone}` });
    if (blank(next)) delete s.users[key]; else s.users[key] = next;
    if (owner) s.send = b.send ?? false;
    store.setKv(KEY, JSON.stringify(s));
    return view(next, s.send);
  });

  // Try the connection against ClickUp: who is connected, which workspace, which time zone.
  app.post('/api/settings/clickup/test', async (req, reply) => {
    const client = d.client(clickupUserKey(req.user!));
    if (!client) return reply.code(400).send({ error: 'ClickUp is not connected' });
    try { return await client.whoami(); } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });

  /**
   * Connect ClickUp, step one: the address to open. ClickUp sends the person back to the panel itself (`<origin>/`),
   * whose page hands the code to `finish` with their sign-in, so no route here is open to a caller who is not signed in.
   * The panel's address is LZVR_ORIGIN, else the one the browser says it is on.
   */
  app.post('/api/settings/clickup/oauth/start', async (req, reply) => {
    let origin: URL;
    try { origin = new URL(d.origin ?? String(req.headers.origin ?? '')); } catch { return reply.code(400).send({ error: 'the panel address is unknown; set LZVR_ORIGIN' }); }
    if (origin.protocol !== 'https:' && origin.protocol !== 'http:') return reply.code(400).send({ error: 'the panel address is unknown; set LZVR_ORIGIN' });
    // ClickUp takes a sign-in back over http only on this machine itself; any other address must be https.
    if (origin.protocol === 'http:' && !/^(localhost|127(\.\d+){3}|\[::1\])$/.test(origin.hostname)) {
      return reply.code(400).send({ error: `ClickUp only signs in to an https address, or to http://localhost: the panel is open on ${origin.origin}. Open it on https or on http://localhost:${origin.port || '80'}, or set LZVR_ORIGIN to its https address` });
    }
    const redirectUri = `${origin.origin}/`;
    try {
      let clientId = load(store).clients[redirectUri];
      if (!clientId) {
        clientId = await registerClient(redirectUri, { fetch: d.fetch });
        const s = load(store); // read again: the request above took a while
        s.clients[redirectUri] = clientId;
        store.setKv(KEY, JSON.stringify(s));
      }
      const now = Date.now();
      for (const [k, v] of pending) if (now - v.at > SIGN_IN_MS) pending.delete(k);
      const p = pkce();
      pending.set(p.state, { ...p, user: clickupUserKey(req.user!), clientId, redirectUri, at: now });
      return { url: authorizeUrl(clientId, redirectUri, p) };
    } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
  });

  // Step two: the code ClickUp sent the person back with, exchanged for their access token. Only whoever started it.
  app.post<{ Body: { code: string; state: string } }>('/api/settings/clickup/oauth/finish', {
    schema: { body: {
      type: 'object', required: ['code', 'state'], additionalProperties: false,
      properties: { code: { type: 'string', minLength: 1, maxLength: 4000 }, state: { type: 'string', minLength: 1, maxLength: 200 } },
    } },
  }, async (req, reply) => {
    const key = clickupUserKey(req.user!);
    const p = pending.get(req.body.state);
    if (!p || p.user !== key || Date.now() - p.at > SIGN_IN_MS) return reply.code(400).send({ error: 'this ClickUp sign-in is not known or took too long; connect again' });
    pending.delete(req.body.state); // a code is good once
    let token: string;
    try {
      token = await exchangeCode({ code: req.body.code, clientId: p.clientId, redirectUri: p.redirectUri, verifier: p.verifier }, { fetch: d.fetch });
    } catch (e) { return reply.code(502).send({ error: (e as Error).message }); }
    const s = load(store);
    s.users[key] = { ...(s.users[key] ?? NONE), oauth: token };
    store.setKv(KEY, JSON.stringify(s));
    return view(s.users[key], s.send);
  });

  // Forget the connection, which turns the ClickUp tools off for this person. ClickUp itself keeps the access until
  // the person removes the app there.
  app.delete('/api/settings/clickup/oauth', (req) => {
    const s = load(store);
    const key = clickupUserKey(req.user!);
    const next = { ...(s.users[key] ?? NONE), oauth: '' };
    if (blank(next)) delete s.users[key]; else s.users[key] = next;
    store.setKv(KEY, JSON.stringify(s));
    return view(next, s.send);
  });
}

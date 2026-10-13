import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createWriteStream, mkdirSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { insideRoot } from './paths.js';
import { PANEL_PATHS, panelRoutes } from './panel.js';
import { passkeyRoutes, sessionHash } from './passkeys.js';
import type { Push } from './push.js';
import { LoginError, type Logins } from './login.js';
import { mcpRoutes } from './mcp.js';
import { listSessions } from './sessions.js';
import { type AuthUser, DEFAULT_AUTOPILOT_PROMPT, SANDBOXES, UUID_RE } from './util.js';
import { realWebAuthn, type WebAuthn } from './webauthn.js';
import type { Store } from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on /mcp when the caller is an agent's per-turn token: the conversation that agent runs in. */
    mcpConv?: string;
    /** Who is calling (set for every authenticated request except an agent's /mcp token). */
    user?: AuthUser;
  }
}

const USER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const digest = (s: string) => createHash('sha256').update(s).digest();

/** A filename that is safe on Linux and Windows: no directory part, no reserved/illegal characters or device names. */
function safeName(raw: string): string {
  let n = raw.replace(/[\\/]+/g, '/').split('/').pop() ?? '';
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  n = n.slice(0, 100);
  return n && n !== '.' && n !== '..' ? n : 'file';
}

export function buildApp(
  deps: {
    cfg: Config; store: Store; dispatcher: Dispatcher; push: Push; logins: Logins; webauthn?: WebAuthn;
    maxUploadBytes?: number; authMaxFailures?: number;
  },
): FastifyInstance {
  const { cfg, store, dispatcher, push, logins } = deps;
  const maxUpload = deps.maxUploadBytes ?? 50 * 1024 * 1024;
  const maxFailures = deps.authMaxFailures ?? 10;
  const WINDOW_MS = 60_000;
  const uploads = join(cfg.stateDir, 'uploads');
  mkdirSync(uploads, { recursive: true });

  // With trusted proxy addresses, req.ip is the entry that proxy appended to X-Forwarded-For, so a client cannot pick
  // its own rate-limit identity by sending the header. (`trustProxy: true` would take the client-controlled first entry.)
  const app = Fastify({ trustProxy: cfg.trustProxy.length ? cfg.trustProxy : false });
  app.register(multipart, { limits: { fileSize: maxUpload, files: 1 } });
  const want = digest(cfg.token);

  // Wrong-token attempts per address. The block comes BEFORE the token check, otherwise an
  // attacker could keep guessing and a right guess would still get through.
  const failures = new Map<string, { count: number; resetAt: number }>();

  const noteFailure = (ip: string) => {
    if (failures.size > 10_000) failures.clear(); // bound memory under a spoofed-address flood
    const cur = failures.get(ip);
    if (cur) cur.count++;
    else failures.set(ip, { count: 1, resetAt: Date.now() + WINDOW_MS });
  };

  /**
   * The main token is the owner (always an admin, the break-glass login). Anything else is looked up by the hash of
   * the token: a panel user's personal token, or a session created by a passkey login (which may belong to a user).
   */
  const resolveUser = (token: string, now: number): AuthUser | null => {
    if (timingSafeEqual(digest(token), want)) return { id: null, name: 'owner', role: 'admin', main: true };
    const h = sessionHash(token);
    const asUser = (u: { id: string; name: string; role: 'admin' | 'dev' }): AuthUser => ({ id: u.id, name: u.name, role: u.role, main: false });
    const personal = store.getUserByTokenHash(h);
    if (personal) return asUser(personal);
    const session = store.getSession(h, now);
    if (!session) return null;
    if (session.user_id === null) return { id: null, name: 'owner', role: 'admin', main: false }; // owner signed in by passkey
    const u = store.getUser(session.user_id);
    return u ? asUser(u) : null;
  };

  // Route-level `onRequest`, so a refused caller is turned away before the body is even parsed.
  const requireAdmin = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'admin only' });
  };

  app.addHook('onRequest', async (req, reply) => {
    const path = req.url.split('?')[0]!;
    if (PANEL_PATHS.has(path)) return; // static shell, no secrets

    const now = Date.now();
    const f = failures.get(req.ip);
    if (f && f.resetAt <= now) failures.delete(req.ip);
    else if (f && f.count >= maxFailures) return reply.code(429).header('retry-after', Math.ceil((f.resetAt - now) / 1000)).send({ error: 'too many attempts' });

    if (path.startsWith('/api/auth/')) return; // login endpoints; their handlers report failures via noteFailure

    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const user = m ? resolveUser(m[1]!, now) : null;
    if (user) { req.user = user; return; }

    // An agent's per-turn token opens /mcp and nothing else, and says which conversation the agent is in.
    const agentConv = m && path === '/mcp' ? dispatcher.mcpConversation(m[1]!) : null;
    if (agentConv) { req.mcpConv = agentConv; return; }

    noteFailure(req.ip);
    return reply.code(401).send({ error: 'unauthorized' });
  });

  panelRoutes(app);
  passkeyRoutes(app, { cfg, store, webauthn: deps.webauthn ?? realWebAuthn, noteFailure });
  mcpRoutes(app, { cfg, store, dispatcher, push });

  // Sends that one conversation (via MCP) wants to make into another wait here for a human decision.
  app.get('/api/approvals', { onRequest: requireAdmin }, () => store.listApprovals('pending'));
  const decide = (status: 'approved' | 'rejected') => (req: { params: { id: string } }, reply: any) => {
    const a = store.getApproval(Number(req.params.id));
    if (!a) return notFound(reply);
    if (a.status !== 'pending') return reply.code(409).send({ error: `already ${a.status}` });
    if (status === 'approved') {
      if (!store.getConversation(a.to_conv)) return reply.code(410).send({ error: 'target conversation no longer exists' });
      store.enqueue(a.to_conv, a.prompt, []);
      dispatcher.kick(a.to_conv);
    }
    store.setApprovalStatus(a.id, status);
    return reply.code(204).send();
  };
  app.post<{ Params: { id: string } }>('/api/approvals/:id/approve', { onRequest: requireAdmin }, decide('approved'));
  app.post<{ Params: { id: string } }>('/api/approvals/:id/reject', { onRequest: requireAdmin }, decide('rejected'));

  app.get('/api/push/key', () => ({ publicKey: push.publicKey() }));
  app.post<{ Body: { subscription: { endpoint: string; keys: { p256dh: string; auth: string } } } }>('/api/push/subscribe', {
    schema: { body: {
      type: 'object', required: ['subscription'], additionalProperties: false,
      properties: { subscription: {
        type: 'object', required: ['endpoint', 'keys'],
        properties: {
          endpoint: { type: 'string', minLength: 1 },
          keys: { type: 'object', required: ['p256dh', 'auth'], properties: { p256dh: { type: 'string' }, auth: { type: 'string' } } },
        },
      } },
    } },
  }, (req, reply) => {
    store.addPushSub(req.body.subscription.endpoint, JSON.stringify(req.body.subscription));
    return reply.code(204).send();
  });
  app.post<{ Body: { endpoint: string } }>('/api/push/unsubscribe', {
    schema: { body: { type: 'object', required: ['endpoint'], properties: { endpoint: { type: 'string' } } } },
  }, (req, reply) => {
    store.removePushSub(req.body.endpoint);
    return reply.code(204).send();
  });

  const notFound = (reply: { code(n: number): { send(b: unknown): unknown } }) => reply.code(404).send({ error: 'not found' });

  app.get('/api/accounts', async () => {
    const homes = dispatcher.accounts.homes;
    const logged = await Promise.all(homes.map((h) => logins.isLoggedIn(h)));
    return dispatcher.accounts.list().map((a, i) => ({ ...a, loggedIn: logged[i] ?? null }));
  });
  app.post('/api/accounts/unblock', { onRequest: requireAdmin }, (_req, reply) => {
    dispatcher.accounts.unblockAll();
    return reply.code(204).send();
  });

  // Adding an account links another ChatGPT/Codex login to this machine: admins only (agent tokens cannot reach /api at all).
  app.post<{ Body: { name: string } }>('/api/accounts/login', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false, properties: { name: { type: 'string' } } } },
  }, (req, reply) => {
    try {
      return reply.code(202).send({ id: logins.start(req.body.name) });
    } catch (e) {
      if (e instanceof LoginError) return reply.code(e.code === 'bad-name' ? 400 : 409).send({ error: e.message });
      throw e;
    }
  });
  app.get<{ Params: { id: string } }>('/api/accounts/login/:id', { onRequest: requireAdmin }, (req, reply) =>
    logins.get(req.params.id) ?? notFound(reply));
  app.delete<{ Params: { id: string } }>('/api/accounts/login/:id', { onRequest: requireAdmin }, (req, reply) =>
    logins.cancel(req.params.id) ? reply.code(204).send() : notFound(reply));

  app.get('/api/me', (req) => ({ name: req.user!.name, role: req.user!.role, main: req.user!.main }));

  // --- panel users (admin only). Each gets a personal token, shown once; only its hash is kept. ---
  app.get('/api/users', { onRequest: requireAdmin }, () => store.listUsers());
  app.post<{ Body: { name: string; role: 'admin' | 'dev' } }>('/api/users', {
    onRequest: requireAdmin,
    schema: { body: {
      type: 'object', required: ['name', 'role'], additionalProperties: false,
      properties: { name: { type: 'string' }, role: { enum: ['admin', 'dev'] } },
    } },
  }, (req, reply) => {
    const { name, role } = req.body;
    if (!USER_NAME_RE.test(name)) return reply.code(400).send({ error: 'name must be 1-32 characters: a-z, 0-9, - or _ (starting with a letter or digit)' });
    if (name === 'owner') return reply.code(409).send({ error: '"owner" is reserved for the main access token' });
    const token = randomBytes(32).toString('hex');
    try {
      const u = store.createUser(name, role, sessionHash(token));
      return reply.code(201).send({ id: u.id, name: u.name, role: u.role, token });
    } catch {
      return reply.code(409).send({ error: `a user named "${name}" already exists` });
    }
  });
  app.post<{ Params: { id: string } }>('/api/users/:id/token', { onRequest: requireAdmin }, (req, reply) => {
    if (!store.getUser(req.params.id)) return notFound(reply);
    const token = randomBytes(32).toString('hex');
    store.setUserToken(req.params.id, sessionHash(token));
    return { token };
  });
  app.patch<{ Params: { id: string }; Body: { role: 'admin' | 'dev' } }>('/api/users/:id', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['role'], additionalProperties: false, properties: { role: { enum: ['admin', 'dev'] } } } },
  }, (req, reply) => (store.setUserRole(req.params.id, req.body.role) ? reply.code(204).send() : notFound(reply)));
  app.delete<{ Params: { id: string } }>('/api/users/:id', { onRequest: requireAdmin }, (req, reply) =>
    store.deleteUser(req.params.id) ? reply.code(204).send() : notFound(reply));

  app.get('/api/projects', () => store.listProjects());

  app.post<{ Body: { name: string; path: string; sandbox?: string } }>('/api/projects', {
    onRequest: requireAdmin,
    schema: { body: {
      type: 'object', required: ['name', 'path'], additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
        sandbox: { enum: [...SANDBOXES] },
      },
    } },
  }, (req, reply) => {
    const real = insideRoot(cfg.workspaceRoot, req.body.path);
    if (!real) return reply.code(400).send({ error: 'path must be an existing directory inside WORKSPACE_ROOT' });
    return reply.code(201).send(store.createProject(req.body.name, real, req.body.sandbox));
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { onRequest: requireAdmin }, (req, reply) => {
    for (const c of store.listConversations(req.params.id)) dispatcher.cancel(c.id);
    return store.deleteProject(req.params.id) ? reply.code(204).send() : notFound(reply);
  });

  // Chats only: the project and the other chats stay. Any signed-in user may, as any may create one.
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', (req, reply) => {
    dispatcher.cancel(req.params.id);
    return store.deleteConversation(req.params.id) ? reply.code(204).send() : notFound(reply);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/conversations', (req, reply) =>
    store.getProject(req.params.id) ? store.listConversations(req.params.id) : notFound(reply));

  app.post<{ Params: { id: string }; Body: { threadId?: string } | undefined }>('/api/projects/:id/conversations', (req, reply) => {
    if (!store.getProject(req.params.id)) return notFound(reply);
    const threadId = req.body?.threadId ?? null;
    // Adopting attaches to a Codex session that already exists on this machine, which may be anyone's: admins only.
    if (threadId !== null && req.user?.role !== 'admin') return reply.code(403).send({ error: 'admin only' });
    if (threadId !== null && !UUID_RE.test(threadId)) return reply.code(400).send({ error: 'threadId must be a session UUID' });
    return reply.code(201).send(store.createConversation(req.params.id, threadId));
  });

  app.get('/api/sessions', { onRequest: requireAdmin }, () => {
    const home = dispatcher.accounts.primary();
    return home ? listSessions(home) : [];
  });

  app.put<{ Params: { id: string }; Body: { enabled: boolean; maxTurns?: number; prompt?: string } }>('/api/conversations/:id/autopilot', {
    schema: { body: {
      type: 'object', required: ['enabled'], additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' },
        maxTurns: { type: 'integer', minimum: 1, maximum: 100 },
        prompt: { type: 'string', minLength: 1 },
      },
    } },
  }, (req, reply) => {
    const c = store.getConversation(req.params.id);
    if (!c) return notFound(reply);
    // Anyone may switch autopilot off; turning it on lets the agent keep working unattended, so admins only.
    if (req.body.enabled && req.user?.role !== 'admin') return reply.code(403).send({ error: 'admin only' });
    const { enabled, maxTurns = 20, prompt = DEFAULT_AUTOPILOT_PROMPT } = req.body;
    store.setAutopilot(c.id, enabled, enabled ? maxTurns : 0, prompt);
    if (enabled) dispatcher.startAutopilot(c.id);
    return reply.code(204).send();
  });

  app.get('/api/models', () => dispatcher.models());

  // Pattern starts with a letter/digit so the value can never be read as a CLI flag.
  app.put<{ Params: { id: string }; Body: { model: string } }>('/api/conversations/:id/model', {
    schema: { body: { type: 'object', required: ['model'], additionalProperties: false,
      properties: { model: { type: 'string', pattern: '^([A-Za-z0-9][A-Za-z0-9._:/-]{0,63})?$' } } } },
  }, (req, reply) => {
    if (!store.getConversation(req.params.id)) return notFound(reply);
    store.setModel(req.params.id, req.body.model);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', (req, reply) => {
    const conv = store.getConversation(req.params.id);
    return conv ? { ...conv, turns: store.listTurns(conv.id) } : notFound(reply);
  });

  app.post<{ Params: { id: string }; Body: { prompt: string; attachments?: string[] } }>('/api/conversations/:id/prompts', {
    schema: { body: {
      type: 'object', required: ['prompt'], additionalProperties: false,
      properties: {
        prompt: { type: 'string', minLength: 1 },
        attachments: { type: 'array', items: { type: 'string' } },
      },
    } },
  }, (req, reply) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return notFound(reply);
    const files: string[] = [];
    for (const a of req.body.attachments ?? []) {
      const real = insideRoot(uploads, a);
      if (!real || !statSync(real).isFile()) return reply.code(400).send({ error: `attachment must be an uploaded file: ${a}` });
      files.push(real);
    }
    const queueId = store.enqueue(conv.id, req.body.prompt, files);
    store.setDraft(conv.id, ''); // sent now, so the saved draft must not come back into the composer
    dispatcher.kick(conv.id);
    return reply.code(202).send({ queueId });
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id/queue', (req, reply) =>
    store.getConversation(req.params.id) ? store.listQueue(req.params.id) : notFound(reply));

  app.delete<{ Params: { id: string } }>('/api/queue/:id', (req, reply) =>
    store.deleteQueueItem(Number(req.params.id)) ? reply.code(204).send() : notFound(reply));

  app.post<{ Params: { id: string } }>('/api/conversations/:id/cancel', (req, reply) =>
    store.getConversation(req.params.id) ? { cancelled: dispatcher.cancel(req.params.id) } : notFound(reply));

  app.put<{ Params: { id: string }; Body: { draft: string } }>('/api/conversations/:id/draft', {
    schema: { body: { type: 'object', required: ['draft'], additionalProperties: false, properties: { draft: { type: 'string' } } } },
  }, (req, reply) => {
    if (!store.getConversation(req.params.id)) return notFound(reply);
    store.setDraft(req.params.id, req.body.draft);
    return reply.code(204).send();
  });

  app.post('/api/uploads', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'multipart field "file" required' });
    const dir = join(uploads, randomUUID());
    mkdirSync(dir);
    const dest = join(dir, safeName(part.filename));
    await pipeline(part.file, createWriteStream(dest));
    if (part.file.truncated) { // multipart silently cuts the stream at the limit
      rmSync(dir, { recursive: true, force: true });
      return reply.code(413).send({ error: `file exceeds ${maxUpload} bytes` });
    }
    return reply.code(201).send({ path: dest });
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/conversations/:id/events', (req, reply) => {
    const id = req.params.id;
    if (!store.getConversation(id)) return notFound(reply);
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders(); // otherwise headers wait for the first event and an idle stream looks hung
    const send = (e: { id: number; type: string; payload: string }) => {
      if (res.writableLength > 1_000_000) { res.destroy(); return; } // reader stopped reading; it reconnects with Last-Event-ID
      res.write(`id: ${e.id}\nevent: ${e.type.replace(/[\r\n]/g, ' ')}\ndata: ${e.payload}\n\n`);
    };
    // Replay and subscribe in the same tick so no event can slip between them.
    for (const e of store.eventsAfter(id, after)) send(e);
    const off = dispatcher.subscribe(id, send);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    req.raw.on('close', () => { off(); clearInterval(ping); });
  });

  return app;
}

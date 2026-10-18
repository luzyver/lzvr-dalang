import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance } from 'fastify';
import type { AgentGitPolicy } from './agent-git.js';
import { clickupClient, clickupForAll, clickupRoutes } from './clickup-routes.js';
import { CodeMemory } from './code-memory.js';
import { codeMemoryRoutes } from './code-memory-routes.js';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { git as gitCmd, gitContext, GitError } from './git.js';
import { GitAuth } from './git-auth.js';
import { GitUsers } from './git-users.js';
import { gitAuthRoutes } from './git-auth-routes.js';
import { databaseRoutes } from './database-routes.js';
import { createWorktreeChat, DEFAULT_COMMIT_PROMPT, DEFAULT_MR_PROMPT, dropWorktrees, gitRoutes } from './git-routes.js';
import { insideRoot } from './paths.js';
import { PANEL_PATHS, panelRoutes } from './panel.js';
import { authRoutes, sessionHash } from './auth.js';
import type { Push } from './push.js';
import { LoginError, type Logins } from './login.js';
import { mcpRoutes } from './mcp.js';
import { mcpLaunch, mcpServerRoutes, mcpServersFor } from './mcp-servers.js';
import { otpRoutes, type SendMail } from './otp.js';
import { scheduleRoutes } from './schedules.js';
import { codeRoutes } from './code-routes.js';
import { Terminals, terminalRoutes } from './terminals.js';
import { type AuthUser, type Backend, BACKENDS, canAccess, PROJECT_ACCESS, type ProjectAccess, SANDBOXES } from './util.js';
import { type Store, SUBAGENT_GUIDE, type SubagentPolicy } from './store.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** Set on /mcp when the caller is an agent's per-turn token: the conversation that agent runs in. */
    mcpConv?: string;
    /** With mcpConv: the panel user who sent the prompt of that agent's turn ('owner', a user's name, or '' for none). */
    mcpAuthor?: string;
    /** Who is calling (set for every authenticated request except an agent's /mcp token). */
    user?: AuthUser;
  }
}

const USER_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const digest = (s: string) => createHash('sha256').update(s).digest();

const UPLOAD_IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp',
};

/** A filename that is safe on Linux and Windows: no directory part, no reserved/illegal characters or device names. */
function safeName(raw: string): string {
  let n = raw.replace(/[\\/]+/g, '/').split('/').pop() ?? '';
  n = n.replace(/[\u0000-\u001f<>:"|?*]/g, '_').replace(/[. ]+$/, '');
  if (/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(n)) n = `_${n}`;
  n = n.slice(0, 100);
  return n && n !== '.' && n !== '..' ? n : 'file';
}

/** The part of a long text around the first search term, on one line. */
export function snippet(text: string, terms: string[], width = 220): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= width) return flat;
  const lower = flat.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t)).filter((i) => i >= 0), flat.length);
  const start = at === flat.length ? 0 : Math.max(0, at - Math.floor(width / 4));
  const end = Math.min(flat.length, start + width);
  return `${start > 0 ? '…' : ''}${flat.slice(start, end)}${end < flat.length ? '…' : ''}`;
}

export function buildApp(
  deps: {
    cfg: Config; store: Store; dispatcher: Dispatcher; push: Push; logins: Logins; claudeLogins?: Logins;
    maxUploadBytes?: number; authMaxFailures?: number; sendMail?: SendMail; clickupFetch?: typeof fetch;
    /** Settings → Git for the owner; by default the real git, ssh, gh and glab of the user Dalang runs as. */
    gitAuth?: GitAuth;
    /** Every other panel user's own git setup (tests: fake CLIs); by default under `<STATE_DIR>/git-users`. */
    gitUsers?: GitUsers;
    /** The ssh panel users' setups run (tests: a fake). */
    gitSshCommand?: string[];
    /** The code editor's shells (tests: another shell, or a node-pty that fails to load). */
    terminals?: Terminals;
    /** Code memory (tests: one with a fake CBM); by default one that starts the configured binary when turned on. */
    codeMemory?: CodeMemory;
  },
): FastifyInstance {
  const { cfg, store, dispatcher, push, logins } = deps;
  const backendOf = (v: unknown): Backend => (v === 'claude' ? 'claude' : 'codex');
  /** The accounts and sign-in flow of one backend. Claude's exist only when the server was wired with them. */
  const forBackend = (b: Backend) => (b === 'claude' && deps.claudeLogins
    ? { logins: deps.claudeLogins, accounts: dispatcher.claudeAccounts }
    : { logins, accounts: dispatcher.accounts });
  const loginFlows = () => [logins, deps.claudeLogins].filter((l): l is Logins => !!l);
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
   * the token: a panel user's personal token, or a session created by an email sign-in (which may belong to a user).
   */
  const resolveUser = (token: string, now: number): AuthUser | null => {
    if (timingSafeEqual(digest(token), want)) return { id: null, name: 'owner', role: 'admin', main: true };
    const h = sessionHash(token);
    const asUser = (u: { id: string; name: string; role: 'admin' | 'dev' }): AuthUser => ({ id: u.id, name: u.name, role: u.role, main: false });
    const personal = store.getUserByTokenHash(h);
    if (personal) return asUser(personal);
    const session = store.getSession(h, now);
    if (!session) return null;
    if (session.user_id === null) return { id: null, name: 'owner', role: 'admin', main: false }; // owner signed in by email
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
    if (path === '/api/terminals/socket') return; // a browser WebSocket cannot send the token: its route checks a ticket

    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const user = m ? resolveUser(m[1]!, now) : null;
    if (user) { req.user = user; return; }

    // An agent's per-turn token opens /mcp and nothing else, and says which conversation the agent is in.
    const agentConv = m && path === '/mcp' ? dispatcher.mcpConversation(m[1]!) : null;
    if (agentConv) { req.mcpConv = agentConv; req.mcpAuthor = dispatcher.mcpAuthor(m![1]!); return; }

    // Local development (AUTH_BYPASS): whoever calls is the owner. loadConfig refuses it unless HOST is loopback.
    if (cfg.authBypass) { req.user = { id: null, name: 'owner', role: 'admin', main: false }; return; }

    noteFailure(req.ip);
    return reply.code(401).send({ error: 'unauthorized' });
  });

  // A project the caller may not open does not exist for them: every route about it, one of its chats or something in
  // such a chat (schedule, queued prompt, terminal, approval) answers 404. Lists are filtered where they are made.
  const convProject = (id: string | null | undefined) => (id ? store.getConversation(id)?.project_id : undefined);
  const routeProject = (url: string, p: Record<string, string>): string | undefined => {
    if (url.startsWith('/api/projects/:id')) return p.id;
    if (url.startsWith('/api/conversations/:id')) return convProject(p.id);
    if (url.startsWith('/api/schedules/:id')) return convProject(store.getSchedule(Number(p.id))?.conversation_id);
    if (url.startsWith('/api/queue/:id')) return convProject(store.queueConversation(Number(p.id)));
    if (url.startsWith('/api/approvals/:id')) return convProject(store.getApproval(Number(p.id))?.to_conv);
    if (url.startsWith('/api/terminals/:tid')) return convProject(terminals.convOf(p.tid ?? ''));
    return undefined;
  };
  app.addHook('onRequest', async (req, reply) => {
    if (!req.user || !req.routeOptions.url) return;
    const projectId = routeProject(req.routeOptions.url, req.params as Record<string, string>);
    const project = projectId && store.getProject(projectId);
    if (project && !canAccess(req.user, project.access)) return notFound(reply);
  });
  /** The ids of the projects this caller may open. */
  const openable = (user: AuthUser) => new Set(store.listProjects().filter((p) => canAccess(user, p.access)).map((p) => p.id));

  panelRoutes(app);
  authRoutes(app, { cfg, store });
  otpRoutes(app, { cfg, store, sendMail: deps.sendMail, noteFailure });
  const clickup = clickupClient(store, deps.clickupFetch);
  const codeMemory = deps.codeMemory ?? new CodeMemory(store, { cwd: cfg.stateDir });
  mcpRoutes(app, { cfg, store, dispatcher, push, clickup, clickupForAll: () => clickupForAll(store), codeMemory });
  codeMemoryRoutes(app, { store, codeMemory });
  dispatcher.codeMemory = codeMemory;
  clickupRoutes(app, { store, client: clickup });
  mcpServerRoutes(app, { store });
  databaseRoutes(app, { store, stateDir: cfg.stateDir, dispatcher });
  dispatcher.mcpServersFor = (author) => mcpLaunch(mcpServersFor(store, author));
  const ghCommand = cfg.ghCommand ?? ['gh'];
  const glabCommand = cfg.glabCommand ?? ['glab'];
  const gitUsers = deps.gitUsers ?? new GitUsers({
    baseDir: join(cfg.stateDir, 'git-users'), store, ghCommand, glabCommand, sshCommand: deps.gitSshCommand,
    server: deps.gitAuth ?? new GitAuth({ ghCommand, glabCommand, sshDir: join(homedir(), '.ssh') }),
  });
  // An agent turn works with the git setup of whoever it runs for, and never stops at a login prompt.
  dispatcher.gitEnvFor = (name, projectId) => ({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...gitUsers.forName(name, projectId)?.env });
  gitRoutes(app, { store, dispatcher, cfg, users: gitUsers });
  gitAuthRoutes(app, { users: gitUsers });
  scheduleRoutes(app, { store, dispatcher });
  const terminals = deps.terminals ?? new Terminals();
  codeRoutes(app, { store, dispatcher, terminalAs: async (user) => {
    const mode = terminals.modeFor(user);
    return mode && (await terminals.available()) ? (mode === 'server' ? 'server' : terminals.userName) : null;
  } });
  terminalRoutes(app, { store, dispatcher, terminals, noteFailure });

  // Search the chats: titles, prompts and the agents' answers. Every word has to occur (in any order).
  app.get<{ Querystring: { q: string; project?: string } }>('/api/search', {
    schema: { querystring: { type: 'object', required: ['q'],
      properties: { q: { type: 'string', maxLength: 200 }, project: { type: 'string' } } } },
  }, (req, reply) => {
    const terms = [...new Set(req.query.q.toLowerCase().split(/\s+/).filter(Boolean))].slice(0, 8);
    if (!terms.length) return reply.code(400).send({ error: 'type something to search for' });
    const ok = openable(req.user!);
    return store.search(terms, { projectId: req.query.project || undefined }).filter((hit) => ok.has(hit.project_id))
      .map((hit) => ({ ...hit, text: snippet(hit.text, terms) }));
  });

  // Sends that one conversation (via MCP) wants to make into another wait here for a human decision.
  app.get('/api/approvals', { onRequest: requireAdmin }, (req) => {
    const ok = openable(req.user!);
    return store.listApprovals('pending').filter((a) => ok.has(convProject(a.to_conv) ?? ''));
  });
  const decide = (status: 'approved' | 'rejected') => (req: { params: { id: string } }, reply: any) => {
    const a = store.getApproval(Number(req.params.id));
    if (!a) return notFound(reply);
    if (a.status !== 'pending') return reply.code(409).send({ error: `already ${a.status}` });
    if (status === 'approved') {
      if (!store.getConversation(a.to_conv)) return reply.code(410).send({ error: 'target conversation no longer exists' });
      store.enqueue(a.to_conv, a.prompt, [], '', a.on_behalf, a.from_conv);
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

  app.get<{ Querystring: { backend?: string } }>('/api/accounts', async (req) => {
    const f = forBackend(backendOf(req.query.backend));
    const logged = await Promise.all(f.accounts.homes.map((h) => f.logins.isLoggedIn(h)));
    const backend = backendOf(req.query.backend);
    return f.accounts.list().map((a, i) => ({ ...a, loggedIn: logged[i] ?? null, limits: dispatcher.limitsFor(backend, a.name) }));
  });
  app.put<{ Params: { name: string }; Body: { enabled: boolean; backend?: Backend } }>('/api/accounts/:name/enabled', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, backend: { enum: [...BACKENDS] } } } },
  }, (req, reply) =>
    dispatcher.setEnabled(backendOf(req.body.backend), req.params.name, req.body.enabled) ? reply.code(204).send() : notFound(reply));
  app.get<{ Querystring: { backend?: string } }>('/api/settings/default-model', { onRequest: requireAdmin }, (req) =>
    ({ model: store.getDefaultModel(backendOf(req.query.backend)) }));
  app.put<{ Body: { model: string; backend?: Backend } }>('/api/settings/default-model', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['model'], additionalProperties: false,
      properties: { model: { type: 'string', pattern: '^([A-Za-z0-9][A-Za-z0-9._:/[\\]-]{0,63})?$' }, backend: { enum: [...BACKENDS] } } } },
  }, (req, reply) => {
    store.setDefaultModel(req.body.model, backendOf(req.body.backend));
    return reply.code(204).send();
  });
  app.get<{ Querystring: { backend?: string } }>('/api/settings/default-effort', { onRequest: requireAdmin }, (req) =>
    ({ effort: store.getDefaultEffort(backendOf(req.query.backend)) }));
  app.put<{ Body: { effort: string; backend?: Backend } }>('/api/settings/default-effort', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['effort'], additionalProperties: false,
      properties: { effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] }, backend: { enum: [...BACKENDS] } } } },
  }, (req, reply) => {
    store.setDefaultEffort(req.body.effort, backendOf(req.body.backend));
    return reply.code(204).send();
  });
  // What agents may pick for chats over MCP (create_conversation, set_model): models weakest first, and the highest effort.
  app.get<{ Querystring: { backend?: string } }>('/api/settings/agent-models', { onRequest: requireAdmin }, (req) =>
    ({ models: store.getAgentModels(backendOf(req.query.backend)), maxEffort: store.getAgentMaxEffort(backendOf(req.query.backend)) }));
  app.put<{ Body: { models: string[]; maxEffort: string; backend?: Backend } }>('/api/settings/agent-models', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['models', 'maxEffort'], additionalProperties: false,
      properties: {
        models: { type: 'array', maxItems: 20, uniqueItems: true, items: { type: 'string', pattern: '^[A-Za-z0-9][A-Za-z0-9._:/[\\]-]{0,63}$' } },
        maxEffort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] }, backend: { enum: [...BACKENDS] },
      } } },
  }, (req, reply) => {
    store.setAgentModels(req.body.models, backendOf(req.body.backend));
    store.setAgentMaxEffort(req.body.maxEffort, backendOf(req.body.backend));
    return reply.code(204).send();
  });
  // How far agents may go with sub-agents (see SubagentPolicy).
  app.get('/api/settings/subagents', { onRequest: requireAdmin }, () => ({ ...store.getSubagentPolicy(), defaultGuide: SUBAGENT_GUIDE }));
  app.put<{ Body: Partial<SubagentPolicy> }>('/api/settings/subagents', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', additionalProperties: false,
      properties: {
        maxChildren: { type: 'integer', minimum: 0, maximum: 50 }, maxDepth: { type: 'integer', minimum: 0, maximum: 5 }, autoSend: { type: 'boolean' },
        mode: { enum: ['asked', 'auto'] }, guide: { type: 'string', maxLength: 8000 },
      } } },
  }, (req, reply) => {
    store.setSubagentPolicy({ ...store.getSubagentPolicy(), ...req.body });
    return reply.code(204).send();
  });
  // Whether chat agents may commit and push themselves (see agent-git.ts); the panel's own commit and push always work.
  app.get('/api/settings/agent-git', { onRequest: requireAdmin }, () => store.getAgentGit());
  app.put<{ Body: AgentGitPolicy }>('/api/settings/agent-git', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['commit', 'push'], additionalProperties: false,
      properties: { commit: { type: 'boolean' }, push: { type: 'boolean' } } } },
  }, (req, reply) => {
    store.setAgentGit({ commit: req.body.commit, push: req.body.push });
    return reply.code(204).send();
  });
  // Instructions for "Generate message" (commit) and "Generate MR description" (merge), for Codex and Claude Code alike.
  // Empty = the built-in prompt.
  for (const [path, key, builtIn] of [['commit-prompt', 'commit_prompt', DEFAULT_COMMIT_PROMPT], ['mr-prompt', 'mr_prompt', DEFAULT_MR_PROMPT]] as const) {
    app.get(`/api/settings/${path}`, { onRequest: requireAdmin }, () => ({ prompt: store.getKv(key) ?? '', default: builtIn }));
    app.put<{ Body: { prompt: string } }>(`/api/settings/${path}`, {
      onRequest: requireAdmin,
      schema: { body: { type: 'object', required: ['prompt'], additionalProperties: false, properties: { prompt: { type: 'string', maxLength: 20_000 } } } },
    }, (req, reply) => {
      store.setKv(key, req.body.prompt.trim());
      return reply.code(204).send();
    });
  }
  app.post('/api/accounts/unblock', { onRequest: requireAdmin }, (_req, reply) => {
    dispatcher.accounts.unblockAll();
    dispatcher.claudeAccounts.unblockAll();
    return reply.code(204).send();
  });

  // Adding an account links another ChatGPT/Codex login to this machine: admins only (agent tokens cannot reach /api at all).
  app.post<{ Body: { name: string; backend?: Backend } }>('/api/accounts/login', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false,
      properties: { name: { type: 'string' }, backend: { enum: [...BACKENDS] } } } },
  }, (req, reply) => {
    try {
      return reply.code(202).send({ id: forBackend(backendOf(req.body.backend)).logins.start(req.body.name) });
    } catch (e) {
      if (e instanceof LoginError) return reply.code(e.code === 'bad-name' ? 400 : 409).send({ error: e.message });
      throw e;
    }
  });
  app.delete<{ Params: { name: string }; Querystring: { backend?: string } }>('/api/accounts/:name', { onRequest: requireAdmin }, (req, reply) => {
    try {
      forBackend(backendOf(req.query.backend)).logins.remove(req.params.name);
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof LoginError) return reply.code(e.code === 'not-found' ? 404 : 409).send({ error: e.message });
      throw e;
    }
  });
  app.get<{ Params: { id: string } }>('/api/accounts/login/:id', { onRequest: requireAdmin }, (req, reply) =>
    loginFlows().map((l) => l.get(req.params.id)).find(Boolean) ?? notFound(reply));
  app.post<{ Params: { id: string }; Body: { code: string } }>('/api/accounts/login/:id/code', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['code'], additionalProperties: false,
      properties: { code: { type: 'string', pattern: '^[A-Za-z0-9._#~/+=-]{1,512}$' } } } },
  }, (req, reply) =>
    loginFlows().some((l) => l.sendCode(req.params.id, req.body.code)) ? reply.code(204).send() : notFound(reply));
  app.delete<{ Params: { id: string } }>('/api/accounts/login/:id', { onRequest: requireAdmin }, (req, reply) =>
    loginFlows().some((l) => l.cancel(req.params.id)) ? reply.code(204).send() : notFound(reply));

  app.get('/api/me', (req) => ({ name: req.user!.name, role: req.user!.role, main: req.user!.main }));

  // --- panel users (admin only). They sign in with a code mailed to their email; each also gets a personal API
  // token, shown once (only its hash is kept). ---
  /** '' clears the email; otherwise it must look like one and not be an owner email. */
  const badEmail = (email: string | undefined) => {
    if (email === undefined || email === '') return null;
    if (!EMAIL_RE.test(email) || email.length > 254) return 'enter a valid email address';
    if (cfg.ownerEmails.includes(email.toLowerCase())) return 'this email signs in as the owner (LZVR_OWNER_EMAILS)';
    return null;
  };
  app.get('/api/users', { onRequest: requireAdmin }, () => store.listUsers());
  app.post<{ Body: { name: string; role: 'admin' | 'dev'; email?: string } }>('/api/users', {
    onRequest: requireAdmin,
    schema: { body: {
      type: 'object', required: ['name', 'role'], additionalProperties: false,
      properties: { name: { type: 'string' }, role: { enum: ['admin', 'dev'] }, email: { type: 'string' } },
    } },
  }, (req, reply) => {
    const { name, role } = req.body;
    const email = req.body.email?.trim() ?? '';
    if (!USER_NAME_RE.test(name)) return reply.code(400).send({ error: 'name must be 1-32 characters: a-z, 0-9, - or _ (starting with a letter or digit)' });
    if (name === 'owner') return reply.code(409).send({ error: '"owner" is reserved for the main access token' });
    const emailError = badEmail(email);
    if (emailError) return reply.code(400).send({ error: emailError });
    if (email && store.getUserByEmail(email)) return reply.code(409).send({ error: `another user already has ${email}` });
    const token = randomBytes(32).toString('hex');
    try {
      const u = store.createUser(name, role, sessionHash(token), email || null);
      return reply.code(201).send({ id: u.id, name: u.name, role: u.role, email: u.email, token });
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
  app.patch<{ Params: { id: string }; Body: { role?: 'admin' | 'dev'; email?: string } }>('/api/users/:id', {
    onRequest: requireAdmin,
    schema: { body: {
      type: 'object', minProperties: 1, additionalProperties: false,
      properties: { role: { enum: ['admin', 'dev'] }, email: { type: 'string' } },
    } },
  }, (req, reply) => {
    if (!store.getUser(req.params.id)) return notFound(reply);
    const email = req.body.email?.trim();
    const emailError = badEmail(email);
    if (emailError) return reply.code(400).send({ error: emailError });
    if (email) {
      const other = store.getUserByEmail(email);
      if (other && other.id !== req.params.id) return reply.code(409).send({ error: `another user already has ${email}` });
    }
    if (req.body.role) store.setUserRole(req.params.id, req.body.role);
    if (email !== undefined) store.setUserEmail(req.params.id, email || null);
    return reply.code(204).send();
  });
  // Their own git setup (keys, gh/glab logins) goes with them.
  app.delete<{ Params: { id: string } }>('/api/users/:id', { onRequest: requireAdmin }, (req, reply) => {
    if (!store.deleteUser(req.params.id)) return notFound(reply);
    gitUsers.remove(req.params.id);
    return reply.code(204).send();
  });

  app.get('/api/projects', (req) => store.listProjects().filter((p) => canAccess(req.user!, p.access)));

  // An admin cannot make a project they could not open themselves (they would lose it): 'owner' is the owner's.
  const mayGrant = (user: AuthUser, access: ProjectAccess | undefined) => !access || canAccess(user, access);
  // With `clone`, the folder is made by cloning that repository into `path` (which must not exist yet, or be empty),
  // with the caller's own git setup (their keys and logins).
  app.post<{ Body: { name: string; path: string; sandbox?: string; backend?: Backend; access?: ProjectAccess; clone?: string } }>('/api/projects', {
    onRequest: requireAdmin,
    schema: { body: {
      type: 'object', required: ['name', 'path'], additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
        sandbox: { enum: [...SANDBOXES] }, backend: { enum: [...BACKENDS] }, access: { enum: [...PROJECT_ACCESS] },
        clone: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    } },
  }, async (req, reply) => {
    if (!mayGrant(req.user!, req.body.access)) return reply.code(403).send({ error: `only the owner can limit a project to ${req.body.access}` });
    if (req.body.clone) {
      const url = req.body.clone.trim();
      if (url.startsWith('-') || /^ext::/i.test(url)) return reply.code(400).send({ error: 'not a repository address' });
      const root = realpathSync(cfg.workspaceRoot);
      const target = resolve(root, req.body.path);
      const parent = insideRoot(cfg.workspaceRoot, dirname(target));
      const rel = relative(root, target);
      if (!parent || !rel || rel.startsWith('..') || isAbsolute(rel)) return reply.code(400).send({ error: 'path must be a new folder inside WORKSPACE_ROOT' });
      if (existsSync(target) && readdirSync(target).length) return reply.code(400).send({ error: `${req.body.path} already exists and is not empty` });
      try {
        const clone = () => gitCmd(parent, ['clone', '--', url, target], 600_000);
        const ctx = gitUsers.forUser(req.user!.id);
        await (ctx ? gitContext.run(ctx, clone) : clone());
      } catch (e) {
        if (e instanceof GitError) return reply.code(400).send({ error: `clone failed: ${e.message}` });
        throw e;
      }
    }
    const real = insideRoot(cfg.workspaceRoot, req.body.path);
    if (!real) return reply.code(400).send({ error: 'path must be an existing directory inside WORKSPACE_ROOT' });
    const created = store.createProject(req.body.name, real, req.body.sandbox, req.body.backend, req.body.access);
    return reply.code(201).send(created);
  });

  app.patch<{ Params: { id: string }; Body: { access: ProjectAccess } }>('/api/projects/:id', {
    onRequest: requireAdmin,
    schema: { body: { type: 'object', required: ['access'], additionalProperties: false, properties: { access: { enum: [...PROJECT_ACCESS] } } } },
  }, (req, reply) => {
    if (!mayGrant(req.user!, req.body.access)) return reply.code(403).send({ error: `only the owner can limit a project to ${req.body.access}` });
    return store.setProjectAccess(req.params.id, req.body.access) ? store.getProject(req.params.id) : notFound(reply);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', { onRequest: requireAdmin }, (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return notFound(reply);
    const convs = store.listConversations(project.id);
    for (const c of convs) { dispatcher.cancel(c.id); terminals.killConv(c.id); }
    store.deleteProject(project.id);
    void dropWorktrees(dispatcher, project, convs);
    void codeMemory.forget(project);
    return reply.code(204).send();
  });

  // Chats only: the project and the other chats stay. Any signed-in user may, as any may create one.
  // A chat's own worktree goes with it (uncommitted work there is lost; its branch stays if not merged).
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', (req, reply) => {
    const conv = store.getConversation(req.params.id);
    const project = conv && store.getProject(conv.project_id);
    if (!conv) return notFound(reply);
    dispatcher.cancel(conv.id);
    terminals.killConv(conv.id);
    store.deleteConversation(conv.id);
    if (project) void dropWorktrees(dispatcher, project, [conv]);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/conversations', (req, reply) =>
    store.getProject(req.params.id) ? store.listConversations(req.params.id) : notFound(reply));

  app.post<{ Params: { id: string }; Body: { worktree?: boolean } | undefined }>('/api/projects/:id/conversations', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return notFound(reply);
    if (req.body?.worktree) {
      try {
        return reply.code(201).send(await createWorktreeChat(store, cfg, project));
      } catch (e) {
        if (e instanceof GitError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    }
    return reply.code(201).send(store.createConversation(req.params.id));
  });


  app.get<{ Querystring: { backend?: string } }>('/api/models', (req) => dispatcher.models(backendOf(req.query.backend)));

  // Pattern starts with a letter/digit so the value can never be read as a CLI flag.
  app.put<{ Params: { id: string }; Body: { model: string } }>('/api/conversations/:id/model', {
    schema: { body: { type: 'object', required: ['model'], additionalProperties: false,
      properties: { model: { type: 'string', pattern: '^([A-Za-z0-9][A-Za-z0-9._:/[\\]-]{0,63})?$' } } } },
  }, (req, reply) => {
    if (!store.getConversation(req.params.id)) return notFound(reply);
    store.setModel(req.params.id, req.body.model);
    return reply.code(204).send();
  });

  app.put<{ Params: { id: string }; Body: { effort: string } }>('/api/conversations/:id/effort', {
    schema: { body: { type: 'object', required: ['effort'], additionalProperties: false,
      properties: { effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] } } } },
  }, (req, reply) => {
    if (!store.getConversation(req.params.id)) return notFound(reply);
    store.setEffort(req.params.id, req.body.effort);
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/conversations/:id', (req, reply) => {
    const conv = store.getConversation(req.params.id);
    return conv ? { ...conv, turns: store.listTurns(conv.id) } : notFound(reply);
  });

  // Serve links from agent answers only from this chat's own worktree/project.
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/conversations/:id/files/download', {
    schema: { querystring: { type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } },
  }, (req, reply) => {
    const conv = store.getConversation(req.params.id);
    const project = conv && store.getProject(conv.project_id);
    if (!conv || !project) return notFound(reply);
    const real = insideRoot(conv.worktree ?? project.path, req.query.path);
    if (!real) return notFound(reply);
    let stat;
    try { stat = statSync(real); } catch { return notFound(reply); }
    if (!stat.isFile()) return notFound(reply);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName(real))}`)
      .header('content-length', stat.size)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(real));
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
    const queueId = store.enqueue(conv.id, req.body.prompt, files, req.user!.name);
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

  // A file attached to a prompt, for the thread to show it. Images get their type so the panel can preview them; SVG is
  // left out of that list since it can carry script.
  app.get<{ Params: { dir: string; name: string } }>('/api/uploads/:dir/:name', (req, reply) => {
    const real = insideRoot(uploads, join(req.params.dir, req.params.name));
    if (!real) return notFound(reply);
    let stat;
    try { stat = statSync(real); } catch { return notFound(reply); }
    if (!stat.isFile()) return notFound(reply);
    return reply
      .header('content-type', UPLOAD_IMAGE_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName(real))}`)
      .header('content-length', stat.size)
      .header('cache-control', 'private, max-age=86400')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(real));
  });

  app.get<{ Params: { id: string }; Querystring: { after?: string } }>('/api/conversations/:id/events', (req, reply) => {
    const id = req.params.id;
    if (!store.getConversation(id)) return notFound(reply);
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0) || 0;
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders(); // otherwise headers wait for the first event and an idle stream looks hung
    type Ev = { id: number; type: string; payload: string; created_at: string };
    const write = (e: Ev) => res.write(`id: ${e.id}\nevent: ${e.type.replace(/[\r\n]/g, ' ')}\ndata: ${e.payload}\ntimestamp: ${e.created_at}\n\n`);
    // The history is replayed at the pace the reader takes it (a long chat is megabytes); live events that come
    // meanwhile wait behind it. Only after that does a full buffer mean a reader that stopped reading: it is dropped,
    // and reconnects with Last-Event-ID.
    let replaying = true;
    const held: Ev[] = [];
    const send = (e: Ev) => {
      if (replaying) { held.push(e); return; }
      if (res.writableLength > 1_000_000) { res.destroy(); return; }
      write(e);
    };
    // Subscribe and read the history in the same tick so no event can slip between them.
    const off = dispatcher.subscribe(id, send);
    const history = store.eventsAfter(id, after);
    const ping = setInterval(() => res.write(': ping\n\n'), 15000);
    res.on('close', () => { off(); clearInterval(ping); });
    void (async () => {
      for (const e of history) {
        if (res.destroyed) return;
        if (!write(e)) await new Promise((done) => { res.once('drain', done); res.once('close', done); });
      }
      const last = history.length ? history[history.length - 1]!.id : after;
      replaying = false;
      for (const e of held) if (e.id > last) send(e);
    })();
  });

  return app;
}

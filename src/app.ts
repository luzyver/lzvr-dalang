import { ArchiveCleanup } from './archive-cleanup.js';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { homedir } from 'node:os';
import { dirname, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { pipeline } from 'node:stream/promises';
import multipart from '@fastify/multipart';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import type { AgentGitPolicy } from './agent-git.js';
import type { DesignHookPolicy } from './design-hook.js';
import { CUSTOM_SKILL_NAME, type CustomSkill } from './skills.js';
import { isDocx, TEMPLATE_NAME, templateWorkDir } from './templates.js';
import { clickupApprovalRoutes, forgetClickUpApprovals, isUnresolvedClickUpApproval, readClickUpApprovals } from './clickup-approvals.js';
import { clickupClient, clickupRoutes, clickupSend, forgetClickUp } from './clickup-routes.js';
import { memoryRoutes } from './memory.js';
import type { Config } from './config.js';
import type { Dispatcher } from './dispatcher.js';
import { git as gitCmd, gitContext, GitError } from './git.js';
import { GitAuth } from './git-auth.js';
import { GitUsers } from './git-users.js';
import { gitAuthRoutes } from './git-auth-routes.js';
import { databaseRoutes, readDbApprovals } from './database-routes.js';
import { readSshApprovals } from './ssh-hosts.js';
import { sshRoutes } from './ssh-routes.js';
import { createWorktreeChat, dropWorktrees, gitRoutes } from './git-routes.js';
import { sessionUsage } from './token-usage.js';
import { compactPayload } from './event-view.js';
import { insideRoot } from './paths.js';
import { PANEL_PATHS, panelRoutes } from './panel.js';
import { authRoutes, ownerSessionValid, sessionHash } from './auth.js';
import { MAX_SUBS_PER_USER, pushEndpointOk, type Push } from './push.js';
import { LoginError, type Logins } from './login.js';
import { mcpRoutes } from './mcp.js';
import { mcpLaunch, mcpServerRoutes, mcpServersFor } from './mcp-servers.js';
import { otpRoutes, type SendMail } from './otp.js';
import { scheduleRoutes } from './schedules.js';
import { codeRoutes } from './code-routes.js';
import { Terminals, terminalRoutes } from './terminals.js';
import { type AuthUser, type Backend, BACKENDS, canOpen, PROJECT_ACCESS, type ProjectAccess, SANDBOXES } from './util.js';
import { type Conversation, type Project, type Store, type SubagentPolicy } from './store.js';
import { REVIEWER_GUIDE, type ReviewerPolicy } from './reviewer.js';

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

/** The files of a chat that may be opened as a page (see /api/files/view). */
const VIEWABLE = new Set(['.html', '.htm']);
const VIEW_TICKET_MS = 60_000;
/**
 * For a page an agent wrote: `sandbox` without allow-same-origin puts it in an origin of its own, away from the panel's
 * storage and API; the rest keeps it to what is inline in the file, so it can fetch or send nothing.
 */
const VIEW_CSP = "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox allow-downloads; default-src 'none'; "
  + "script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; media-src data: blob:; font-src data:; "
  + "form-action 'none'; base-uri 'none'; frame-ancestors 'none'";

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
    maxUploadBytes?: number; authMaxFailures?: number; authTrackedAddresses?: number; sendMail?: SendMail; clickupFetch?: typeof fetch;
    /** Settings → Git for the owner; by default the real git, ssh, gh and glab of the user Dalang runs as. */
    gitAuth?: GitAuth;
    /** Every other panel user's own git setup (tests: fake CLIs); by default under `<STATE_DIR>/git-users`. */
    gitUsers?: GitUsers;
    /** The ssh panel users' setups run (tests: a fake). */
    gitSshCommand?: string[];
    /** The code editor's shells (tests: another shell, or a node-pty that fails to load). */
    terminals?: Terminals;
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
  const maxTracked = deps.authTrackedAddresses ?? 10_000;
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
    const now = Date.now();
    const cur = failures.get(ip);
    if (cur && cur.resetAt > now) { cur.count++; return; }
    failures.delete(ip);
    // Bound memory under a flood of addresses: drop the oldest entry that is not blocking anyone, and only when every
    // entry blocks, the oldest one. Clearing the table would also lift the block on whoever keeps guessing.
    if (failures.size >= maxTracked) {
      let drop = failures.keys().next().value as string;
      for (const [k, v] of failures) if (v.resetAt <= now || v.count < maxFailures) { drop = k; break; }
      failures.delete(drop);
    }
    failures.set(ip, { count: 1, resetAt: now + WINDOW_MS });
  };

  /**
   * The main token is the owner (the break-glass login). Anything else is looked up by the hash of
   * the token: a panel user's personal token, or a session created by an email sign-in (which may belong to a user).
   */
  const resolveUser = (token: string, now: number): AuthUser | null => {
    if (timingSafeEqual(digest(token), want)) return { id: null, name: 'owner', main: true };
    const h = sessionHash(token);
    const asUser = (u: { id: string; name: string }): AuthUser => ({ id: u.id, name: u.name, main: false });
    const personal = store.getUserByTokenHash(h);
    if (personal) return asUser(personal);
    const session = store.getSession(h, now);
    if (!session) return null;
    if (session.user_id === null) { // owner signed in by email, while that email is still an owner's
      return ownerSessionValid(cfg, token) ? { id: null, name: 'owner', main: false } : null;
    }
    const u = store.getUser(session.user_id);
    return u ? asUser(u) : null;
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
    if (path === '/api/db/export') return; // nor can a download link: its route checks a ticket too
    if (path === '/api/files/view') return; // nor can a new tab: same

    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    const user = m ? resolveUser(m[1]!, now) : null;
    if (user) { req.user = user; return; }

    // An agent's per-turn token opens /mcp and nothing else, and says which conversation the agent is in.
    const agentConv = m && path === '/mcp' ? dispatcher.mcpConversation(m[1]!) : null;
    if (agentConv) { req.mcpConv = agentConv; req.mcpAuthor = dispatcher.mcpAuthor(m![1]!); return; }

    // Local development (AUTH_BYPASS): whoever calls is the owner. loadConfig refuses it unless HOST is loopback.
    if (cfg.authBypass) { req.user = { id: null, name: 'owner', main: false }; return; }

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
    if (project && !canOpen(req.user, project)) return notFound(reply);
  });
  /** The ids of the projects this caller may open. */
  const openable = (user: AuthUser) => new Set(store.listProjects().filter((p) => canOpen(user, p)).map((p) => p.id));

  panelRoutes(app);
  authRoutes(app, { cfg, store });
  otpRoutes(app, { cfg, store, sendMail: deps.sendMail, noteFailure });
  const clickup = clickupClient(store, deps.clickupFetch);
  mcpRoutes(app, { cfg, store, dispatcher, push, clickup, clickupSend: () => clickupSend(store) });
  memoryRoutes(app, { store, autoMemory: cfg.autoMemory !== false });
  clickupRoutes(app, { store, client: clickup, origin: cfg.origin, fetch: deps.clickupFetch });
  clickupApprovalRoutes(app, { store, stateDir: cfg.stateDir, dispatcher, client: clickup });
  mcpServerRoutes(app, { store });
  databaseRoutes(app, { store, stateDir: cfg.stateDir, dispatcher, noteFailure });
  sshRoutes(app, { store, dispatcher });
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
  // The ticket and its eventual connection share the issuing identity and its expiry.
  const chatAccess = (req: FastifyRequest, convId: string) => {
    const user = req.user!;
    const token = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')?.[1];
    const bypass = cfg.authBypass && (!token || !resolveUser(token, Date.now()));
    const expires = token && store.getSession(sessionHash(token), Date.now())?.expires_at;
    const valid = () => {
      const current = bypass ? user : token && resolveUser(token, Date.now());
      const projectId = convProject(convId);
      const project = projectId && store.getProject(projectId);
      return !!current && current.id === user.id && !!project && canOpen(current, project);
    };
    const watch = (close: () => void) => {
      let timer: NodeJS.Timeout | undefined;
      const check = () => { if (!valid()) close(); };
      const arm = () => {
        if (!expires) return;
        const left = expires - Date.now();
        if (left <= 0) close();
        else timer = setTimeout(arm, Math.min(left, 2_147_483_647)).unref();
      };
      store.accessListeners.add(check);
      arm();
      return () => { store.accessListeners.delete(check); clearTimeout(timer); };
    };
    return { valid, watch };
  };
  terminalRoutes(app, { store, dispatcher, terminals, noteFailure, chatAccess });

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
  app.get('/api/approvals', (req) => {
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
  app.post<{ Params: { id: string } }>('/api/approvals/:id/approve', decide('approved'));
  app.post<{ Params: { id: string } }>('/api/approvals/:id/reject', decide('rejected'));

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
    const { endpoint } = req.body.subscription;
    if (!pushEndpointOk(endpoint)) return reply.code(400).send({ error: 'the push endpoint is not a browser push service the panel sends to' });
    const userKey = req.user!.id ?? 'owner';
    const mine = store.listPushSubs().filter((s) => s.user_key === userKey && s.endpoint !== endpoint);
    for (const old of mine.slice(0, Math.max(0, mine.length - MAX_SUBS_PER_USER + 1))) store.removePushSub(old.endpoint, userKey);
    store.addPushSub(endpoint, JSON.stringify(req.body.subscription), userKey,
      sessionHash((req.headers.authorization ?? '').replace(/^Bearer /, '')));
    return reply.code(204).send();
  });
  app.post<{ Body: { endpoint: string } }>('/api/push/unsubscribe', {
    schema: { body: { type: 'object', required: ['endpoint'], properties: { endpoint: { type: 'string' } } } },
  }, (req, reply) => {
    store.removePushSub(req.body.endpoint, req.user!.id ?? 'owner');
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
    schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false,
      properties: { enabled: { type: 'boolean' }, backend: { enum: [...BACKENDS] } } } },
  }, (req, reply) =>
    dispatcher.setEnabled(backendOf(req.body.backend), req.params.name, req.body.enabled) ? reply.code(204).send() : notFound(reply));
  app.get<{ Querystring: { backend?: string } }>('/api/settings/default-model', (req) =>
    ({ model: store.getDefaultModel(backendOf(req.query.backend)) }));
  app.put<{ Body: { model: string; backend?: Backend } }>('/api/settings/default-model', {
    schema: { body: { type: 'object', required: ['model'], additionalProperties: false,
      properties: { model: { type: 'string', pattern: '^([A-Za-z0-9][A-Za-z0-9._:/[\\]-]{0,63})?$' }, backend: { enum: [...BACKENDS] } } } },
  }, (req, reply) => {
    store.setDefaultModel(req.body.model, backendOf(req.body.backend));
    return reply.code(204).send();
  });
  app.get<{ Querystring: { backend?: string } }>('/api/settings/default-effort', (req) =>
    ({ effort: store.getDefaultEffort(backendOf(req.query.backend)) }));
  app.put<{ Body: { effort: string; backend?: Backend } }>('/api/settings/default-effort', {
    schema: { body: { type: 'object', required: ['effort'], additionalProperties: false,
      properties: { effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] }, backend: { enum: [...BACKENDS] } } } },
  }, (req, reply) => {
    store.setDefaultEffort(req.body.effort, backendOf(req.body.backend));
    return reply.code(204).send();
  });
  // How far agents may go with sub-agents (see SubagentPolicy).
  app.get('/api/settings/subagents', () => store.getSubagentPolicy());
  app.put<{ Body: Partial<SubagentPolicy> }>('/api/settings/subagents', {
    schema: { body: { type: 'object', additionalProperties: false,
      properties: {
        maxChildren: { type: 'integer', minimum: 0, maximum: 50 }, maxDepth: { type: 'integer', minimum: 0, maximum: 5 }, autoSend: { type: 'boolean' },
      } } },
  }, (req, reply) => {
    store.setSubagentPolicy({ ...store.getSubagentPolicy(), ...req.body });
    return reply.code(204).send();
  });
  // The automatic reviewer of a person's chats (see reviewer.ts).
  app.get('/api/settings/reviewer', () => ({ ...store.getReviewerPolicy(), defaultGuide: REVIEWER_GUIDE }));
  app.put<{ Body: Partial<ReviewerPolicy> }>('/api/settings/reviewer', {
    schema: { body: { type: 'object', additionalProperties: false,
      properties: {
        enabled: { type: 'boolean' }, backend: { enum: ['', ...BACKENDS] }, model: { type: 'string', maxLength: 200 },
        effort: { type: 'string', enum: ['', 'low', 'medium', 'high', 'xhigh', 'max'] },
        maxRounds: { type: 'integer', minimum: 1, maximum: 10 }, guide: { type: 'string', maxLength: 8000 },
      } } },
  }, (req, reply) => {
    store.setReviewerPolicy({ ...store.getReviewerPolicy(), ...req.body });
    return reply.code(204).send();
  });
  // Whether chat agents may commit and push themselves (see agent-git.ts); the panel's own commit and push always work.
  app.get('/api/settings/agent-git', () => store.getAgentGit());
  app.put<{ Body: AgentGitPolicy }>('/api/settings/agent-git', {
    schema: { body: { type: 'object', required: ['commit', 'push'], additionalProperties: false,
      properties: { commit: { type: 'boolean' }, push: { type: 'boolean' } } } },
  }, (req, reply) => {
    store.setAgentGit({ commit: req.body.commit, push: req.body.push });
    return reply.code(204).send();
  });
  // Whether turns that may write run Impeccable's design detector after UI edits (see design-hook.ts).
  app.get('/api/settings/design-hook', () => store.getDesignHook());
  app.put<{ Body: DesignHookPolicy }>('/api/settings/design-hook', {
    schema: { body: { type: 'object', required: ['enabled'], additionalProperties: false, properties: { enabled: { type: 'boolean' } } } },
  }, (req, reply) => {
    store.setDesignHook({ enabled: req.body.enabled });
    return reply.code(204).send();
  });
  // Custom skills (skills.ts): written here, run in a chat by typing `/custom <name>`. Any signed-in user may list the names.
  app.get('/api/custom-skills', () => store.getCustomSkills().map(({ name, description }) => ({ name, description })));
  app.get('/api/settings/custom-skills', () => store.getCustomSkills());
  app.put<{ Body: { skills: CustomSkill[] } }>('/api/settings/custom-skills', {
    schema: { body: { type: 'object', required: ['skills'], additionalProperties: false, properties: { skills: { type: 'array', maxItems: 100, items: {
      type: 'object', required: ['name', 'content'], additionalProperties: false,
      properties: { name: { type: 'string', pattern: CUSTOM_SKILL_NAME.source }, description: { type: 'string', maxLength: 300 }, content: { type: 'string', minLength: 1, maxLength: 50_000 } } } } } } },
  }, (req, reply) => {
    const names = req.body.skills.map((s) => s.name.toLowerCase());
    if (new Set(names).size !== names.length) return reply.code(400).send({ error: 'Skill names must be unique' });
    store.setCustomSkills(req.body.skills.map((s) => ({ name: s.name, description: s.description ?? '', content: s.content })));
    return reply.code(204).send();
  });
  // Document templates (templates.ts): a .docx uploaded here, used in a chat by mentioning `@template:<name>`.
  // Any signed-in user may list the names; the file itself is only ever read by the agent.
  const templatesDir = join(cfg.stateDir, 'templates');
  app.get('/api/templates', () => store.getTemplates().map(({ name, description }) => ({ name, description })));
  app.get('/api/settings/templates', () => store.getTemplates().map(({ name, description }) => ({ name, description })));
  // multipart: the fields `name` and `description` come before the field `file`; sending a name again replaces that template.
  app.put('/api/settings/templates', async (req, reply) => {
    const part = await req.file();
    if (!part) return reply.code(400).send({ error: 'multipart field "file" required' });
    const field = (k: string) => { const f = part.fields[k] as { value?: unknown } | undefined; return typeof f?.value === 'string' ? f.value : ''; };
    const name = field('name').trim();
    const description = field('description').trim().slice(0, 300);
    if (!TEMPLATE_NAME.test(name)) return reply.code(400).send({ error: 'name: use letters, digits, "-" and "_"' });
    if (extname(part.filename).toLowerCase() !== '.docx') return reply.code(400).send({ error: 'the template must be a .docx file' });
    const bytes = await part.toBuffer();
    if (part.file.truncated) return reply.code(413).send({ error: `file exceeds ${maxUpload} bytes` });
    if (!isDocx(bytes)) return reply.code(400).send({ error: 'not a valid .docx file' });
    mkdirSync(templatesDir, { recursive: true });
    const file = join(templatesDir, `${name}.docx`);
    const all = store.getTemplates();
    const rest = all.filter((t) => t.name.toLowerCase() !== name.toLowerCase());
    // The same name in other letter case replaces it too: where file names tell case apart, its old file would stay behind.
    // Removed before writing: where they do not, both names are one file.
    for (const t of all) if (!rest.includes(t) && t.file !== file) rmSync(t.file, { force: true });
    writeFileSync(file, bytes);
    store.setTemplates([...rest, { name, description, file }].sort((a, b) => a.name.localeCompare(b.name)));
    return reply.code(204).send();
  });
  app.delete<{ Params: { name: string } }>('/api/settings/templates/:name', (req, reply) => {
    const all = store.getTemplates();
    const t = all.find((x) => x.name.toLowerCase() === req.params.name.toLowerCase());
    if (!t) return notFound(reply);
    rmSync(t.file, { force: true });
    store.setTemplates(all.filter((x) => x !== t));
    return reply.code(204).send();
  });
  app.post('/api/accounts/unblock', (_req, reply) => {
    dispatcher.accounts.unblockAll();
    dispatcher.claudeAccounts.unblockAll();
    return reply.code(204).send();
  });

  // Adding an account links another ChatGPT/Codex login to this machine (agent tokens cannot reach /api at all).
  app.post<{ Body: { name: string; backend?: Backend; relogin?: boolean } }>('/api/accounts/login', {
    schema: { body: { type: 'object', required: ['name'], additionalProperties: false,
      properties: { name: { type: 'string' }, backend: { enum: [...BACKENDS] }, relogin: { type: 'boolean' } } } },
  }, (req, reply) => {
    try {
      const id = forBackend(backendOf(req.body.backend)).logins.start(req.body.name, { relogin: req.body.relogin });
      return reply.code(202).send({ id });
    } catch (e) {
      if (e instanceof LoginError) return reply.code(e.code === 'bad-name' ? 400 : e.code === 'not-found' ? 404 : 409).send({ error: e.message });
      throw e;
    }
  });
  app.delete<{ Params: { name: string }; Querystring: { backend?: string } }>('/api/accounts/:name', (req, reply) => {
    try {
      forBackend(backendOf(req.query.backend)).logins.remove(req.params.name);
      return reply.code(204).send();
    } catch (e) {
      if (e instanceof LoginError) return reply.code(e.code === 'not-found' ? 404 : 409).send({ error: e.message });
      throw e;
    }
  });
  app.get<{ Params: { id: string } }>('/api/accounts/login/:id', (req, reply) =>
    loginFlows().map((l) => l.get(req.params.id)).find(Boolean) ?? notFound(reply));
  app.post<{ Params: { id: string }; Body: { code: string } }>('/api/accounts/login/:id/code', {
    schema: { body: { type: 'object', required: ['code'], additionalProperties: false,
      properties: { code: { type: 'string', pattern: '^[A-Za-z0-9._#~/+=-]{1,512}$' } } } },
  }, (req, reply) =>
    loginFlows().some((l) => l.sendCode(req.params.id, req.body.code)) ? reply.code(204).send() : notFound(reply));
  app.delete<{ Params: { id: string } }>('/api/accounts/login/:id', (req, reply) =>
    loginFlows().some((l) => l.cancel(req.params.id)) ? reply.code(204).send() : notFound(reply));

  app.get('/api/me', (req) => ({ name: req.user!.name, main: req.user!.main }));

  // --- panel users. They sign in with a code mailed to their email; each also gets a personal API
  // token, shown once (only its hash is kept). ---
  /** '' clears the email; otherwise it must look like one and not be an owner email. */
  const badEmail = (email: string | undefined) => {
    if (email === undefined || email === '') return null;
    if (!EMAIL_RE.test(email) || email.length > 254) return 'enter a valid email address';
    if (cfg.ownerEmails.includes(email.toLowerCase())) return 'this email signs in as the owner (LZVR_OWNER_EMAILS)';
    return null;
  };
  app.get('/api/users', () => store.listUsers());
  app.post<{ Body: { name: string; email?: string } }>('/api/users', {
    schema: { body: {
      type: 'object', required: ['name'], additionalProperties: false,
      properties: { name: { type: 'string' }, email: { type: 'string' } },
    } },
  }, (req, reply) => {
    const { name } = req.body;
    const email = req.body.email?.trim() ?? '';
    if (!USER_NAME_RE.test(name)) return reply.code(400).send({ error: 'name must be 1-32 characters: a-z, 0-9, - or _ (starting with a letter or digit)' });
    if (name === 'owner') return reply.code(409).send({ error: '"owner" is reserved for the main access token' });
    const emailError = badEmail(email);
    if (emailError) return reply.code(400).send({ error: emailError });
    if (email && store.getUserByEmail(email)) return reply.code(409).send({ error: `another user already has ${email}` });
    const token = randomBytes(32).toString('hex');
    try {
      const u = store.createUser(name, sessionHash(token), email || null);
      return reply.code(201).send({ id: u.id, name: u.name, email: u.email, token });
    } catch {
      return reply.code(409).send({ error: `a user named "${name}" already exists` });
    }
  });
  app.post<{ Params: { id: string } }>('/api/users/:id/token', (req, reply) => {
    if (!store.getUser(req.params.id)) return notFound(reply);
    const token = randomBytes(32).toString('hex');
    store.setUserToken(req.params.id, sessionHash(token));
    return { token };
  });
  app.patch<{ Params: { id: string }; Body: { email: string } }>('/api/users/:id', {
    schema: { body: {
      type: 'object', required: ['email'], additionalProperties: false,
      properties: { email: { type: 'string' } },
    } },
  }, (req, reply) => {
    if (!store.getUser(req.params.id)) return notFound(reply);
    const email = req.body.email.trim();
    const emailError = badEmail(email);
    if (emailError) return reply.code(400).send({ error: emailError });
    if (email) {
      const other = store.getUserByEmail(email);
      if (other && other.id !== req.params.id) return reply.code(409).send({ error: `another user already has ${email}` });
    }
    store.setUserEmail(req.params.id, email || null);
    return reply.code(204).send();
  });
  // Their own git setup (keys, gh/glab logins), ClickUp token and ClickUp requests go with them.
  app.delete<{ Params: { id: string } }>('/api/users/:id', (req, reply) => {
    if (!store.deleteUser(req.params.id)) return notFound(reply);
    gitUsers.remove(req.params.id);
    forgetClickUp(store, req.params.id);
    forgetClickUpApprovals(store, cfg.stateDir, req.params.id);
    return reply.code(204).send();
  });

  app.get('/api/projects', (req) => store.listProjects().filter((p) => canOpen(req.user!, p)));

  // Nobody can make a project they could not open themselves (they would lose it): 'owner' is the owner's, unless it
  // is shared with them by name.
  const mayGrant = (user: AuthUser, access: ProjectAccess, members: string[]) => canOpen(user, { access, members });
  const LOCKED_OUT = 'only the owner can limit a project to people other than yourself';
  const MEMBERS = { type: 'array', maxItems: 500, items: { type: 'string', maxLength: 64 } } as const;
  /** The ids without repeats, or null when one of them is not a user. */
  const memberIds = (ids: string[] | undefined): string[] | null => {
    const unique = [...new Set(ids ?? [])];
    return unique.every((id) => store.getUser(id)) ? unique : null;
  };
  // With `clone`, the folder is made by cloning that repository into `path` (which must not exist yet, or be empty),
  // with the caller's own git setup (their keys and logins).
  app.post<{ Body: { name: string; path: string; sandbox?: string; access?: ProjectAccess; members?: string[]; clone?: string } }>('/api/projects', {
    schema: { body: {
      type: 'object', required: ['name', 'path'], additionalProperties: false,
      properties: {
        name: { type: 'string', minLength: 1 }, path: { type: 'string', minLength: 1 },
        sandbox: { enum: [...SANDBOXES] }, access: { enum: [...PROJECT_ACCESS] }, members: MEMBERS,
        clone: { type: 'string', minLength: 1, maxLength: 2000 },
      },
    } },
  }, async (req, reply) => {
    const members = memberIds(req.body.members);
    if (!members) return reply.code(400).send({ error: 'members must be ids of users' });
    if (!mayGrant(req.user!, req.body.access ?? 'all', members)) return reply.code(403).send({ error: LOCKED_OUT });
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
    const created = store.createProject(req.body.name, real, req.body.sandbox, req.body.access, members);
    return reply.code(201).send(created);
  });

  // `access`: the level; `members`: the users it is shared with on top of that. One left out stays as it is.
  app.patch<{ Params: { id: string }; Body: { access?: ProjectAccess; members?: string[] } }>('/api/projects/:id', {
    schema: { body: {
      type: 'object', minProperties: 1, additionalProperties: false,
      properties: { access: { enum: [...PROJECT_ACCESS] }, members: MEMBERS },
    } },
  }, (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return notFound(reply);
    const members = req.body.members ? memberIds(req.body.members) : project.members;
    if (!members) return reply.code(400).send({ error: 'members must be ids of users' });
    const access = req.body.access ?? project.access;
    if (!mayGrant(req.user!, access, members)) return reply.code(403).send({ error: LOCKED_OUT });
    store.setProjectAccess(project.id, access, members);
    return store.getProject(project.id);
  });

  app.delete<{ Params: { id: string } }>('/api/projects/:id', (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return notFound(reply);
    const convs = store.listConversations(project.id);
    // Sub-agents its chats started in other projects go too: without their parent they would turn up in the sidebar.
    const elsewhere = convs.flatMap((c) => store.listDescendants(c.id)).filter((c) => c.project_id !== project.id);
    if (!mayRemove(req.user!, elsewhere)) return reply.code(403).send({ error: HIDDEN_AGENTS });
    for (const c of convs) { dispatcher.cancel(c.id); terminals.killConv(c.id); }
    store.deleteProject(project.id);
    void removeChats(elsewhere).catch(e => app.log.error(e));
    void dropWorktrees(dispatcher, project, convs);
    return reply.code(204).send();
  });

  // Deleting a chat takes its sub-agents along, which may run in a project this person may not open: then nothing goes.
  const HIDDEN_AGENTS = 'some of its sub-agents run in a project you may not open';
  const mayRemove = (user: AuthUser, chats: Conversation[]) =>
    chats.every((c) => { const p = store.getProject(c.project_id); return !p || canOpen(user, p); });

  /** Stop and delete these chats, with their worktrees, checkpoints and terminals, whatever projects they are in. */
  const removeChats = (chats: Conversation[], policy: 'manual' | 'archive' = 'manual') => {
    const byProject = new Map<string, Conversation[]>();
    for (const c of chats) {
      dispatcher.cancel(c.id);
      terminals.killConv(c.id);
      store.deleteConversation(c.id);
      byProject.set(c.project_id, [...(byProject.get(c.project_id) || []), c]);
    }
    return Promise.all(Array.from(byProject, async ([id, list]) => {
      const project = store.getProject(id);
      if (project) await dropWorktrees(dispatcher, project, list, policy);
    }));
  };

  const archiveBlocked = (family: Conversation[], includeSender = false) => {
    const ids = new Set(family.map((c) => c.id));
    const unresolved = (a: { conv: string | null; status: string }) =>
      a.conv !== null && ids.has(a.conv) && ['pending', 'executing', 'unknown'].includes(a.status);
    return family.some((c) => c.status === 'running' || dispatcher.isRunning(c.id))
      || store.listApprovals('pending').some((a) => ids.has(a.to_conv) || (includeSender && ids.has(a.from_conv)))
      || readDbApprovals(store).some(unresolved) || readSshApprovals(store).some(unresolved)
      || readClickUpApprovals(store).some((a) => a.conv && ids.has(a.conv) && isUnresolvedClickUpApproval(a));
  };

  const cleanup = new ArchiveCleanup(store, family => archiveBlocked(family, true), (chat, prompt) =>
    dispatcher.ask(chat.backend, prompt, { cwd: store.getProject(chat.project_id)!.path, model: chat.model, effort: 'low', timeoutMs: 60_000 }), async family => { await removeChats(family, 'archive'); });
  let cleanupTimer: NodeJS.Timeout;
  app.addHook('onListen', async () => {
    const tick = () => void cleanup.tick().catch(e => app.log.error(e, 'Archive cleanup failed'));
    cleanupTimer = setInterval(tick, 60_000);
    cleanupTimer.unref();
    tick();
  });
  app.addHook('onClose', async () => { clearInterval(cleanupTimer); cleanup.stop(); });

  // Chats only: the project and the other chats stay. Any signed-in user may, as any may create one.
  // A chat's own worktree goes with it (uncommitted work there is lost; its branch stays if not merged), and so do the
  // sub-agents and reviewers under it, which the sidebar does not list and nothing could reach once it is gone.
  app.delete<{ Params: { id: string } }>('/api/conversations/:id', (req, reply) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return notFound(reply);
    const under = store.listDescendants(conv.id);
    if (!mayRemove(req.user!, under)) return reply.code(403).send({ error: HIDDEN_AGENTS });
    void removeChats([conv, ...under]).catch(e => app.log.error(e));
    return reply.code(204).send();
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/conversations', (req, reply) =>
    store.getProject(req.params.id) ? store.listConversations(req.params.id) : notFound(reply));

  // A new chat runs on the agent of the project's newest chat, so the choice made in the composer carries over. When
  // that agent has no account switched on and the other one does, it runs on the other: a chat nobody could prompt helps no one.
  const chatBackend = (project: Project): Backend =>
    dispatcher.backendFor(store.listConversations(project.id).filter((c) => !c.parent).at(-1)?.backend);

  app.post<{ Params: { id: string }; Body: { worktree?: boolean } | undefined }>('/api/projects/:id/conversations', async (req, reply) => {
    const project = store.getProject(req.params.id);
    if (!project) return notFound(reply);
    const backend = chatBackend(project);
    if (req.body?.worktree) {
      try {
        return reply.code(201).send(await createWorktreeChat(store, cfg, project, { backend }));
      } catch (e) {
        if (e instanceof GitError) return reply.code(400).send({ error: e.message });
        throw e;
      }
    }
    return reply.code(201).send(store.createConversation(req.params.id, backend));
  });


  app.get<{ Querystring: { backend?: string } }>('/api/models', (req) => dispatcher.models(backendOf(req.query.backend)));

  app.put<{ Params: { id: string }; Body: { archived: boolean } }>('/api/conversations/:id/archive', {
    schema: { body: { type: 'object', required: ['archived'], additionalProperties: false,
      properties: { archived: { type: 'boolean' } } } },
  }, (req, reply) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return notFound(reply);
    if (req.body.archived) {
      const family = [conv, ...store.listDescendants(conv.id)];
      if (archiveBlocked(family)) {
        return reply.code(409).send({ error: 'This chat or one of its agents is running or has an unresolved approval.' });
      }
    }
    store.setArchived(conv.id, req.body.archived);
    return reply.code(204).send();
  });

  // Pattern starts with a letter/digit so the value can never be read as a CLI flag.
  app.put<{ Params: { id: string }; Body: { model: string } }>('/api/conversations/:id/model', {
    schema: { body: { type: 'object', required: ['model'], additionalProperties: false,
      properties: { model: { type: 'string', pattern: '^([A-Za-z0-9][A-Za-z0-9._:/[\\]-]{0,63})?$' } } } },
  }, (req, reply) => {
    if (!store.getConversation(req.params.id)) return notFound(reply);
    store.setModel(req.params.id, req.body.model);
    return reply.code(204).send();
  });

  // Another agent CLI from the next turn on, with that CLI's `model` (optional; '' = its default). A new session, told the
  // chat so far. Not while a turn runs: it would record its old session's thread for the new CLI.
  app.put<{ Params: { id: string }; Body: { backend: Backend; model?: string } }>('/api/conversations/:id/backend', {
    schema: { body: { type: 'object', required: ['backend'], additionalProperties: false,
      properties: { backend: { enum: [...BACKENDS] }, model: { type: 'string', pattern: '^([A-Za-z0-9][A-Za-z0-9._:/[\\]-]{0,63})?$' } } } },
  }, (req, reply) => {
    const conv = store.getConversation(req.params.id);
    if (!conv) return notFound(reply);
    if (conv.backend !== req.body.backend && dispatcher.isRunning(conv.id)) {
      return reply.code(409).send({ error: 'a turn is running in this chat: wait for it or stop it first' });
    }
    store.setBackend(conv.id, req.body.backend);
    if (req.body.model !== undefined) store.setModel(conv.id, req.body.model);
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
    return conv ? { ...conv, last_at: store.lastAt(conv.id), turns: store.listTurns(conv.id), agent_turns: store.agentTurns(conv.id), token_usage: store.tokenUsage(conv.id).total, context_usage: store.contextUsage(conv.id) } : notFound(reply);
  });

  // Serve links from agent answers only from this chat's own worktree/project and template folder. The owner may fetch a
  // file anywhere on the machine (an agent often writes its output to /tmp); for anyone else that would reach past the
  // projects they may open, into other chats' files and Dalang's own state.
  const chatFile = (convId: string, path: string, user: AuthUser): string | null => {
    const conv = store.getConversation(convId);
    const project = conv && store.getProject(conv.project_id);
    if (!conv || !project) return null;
    const root = conv.worktree ?? project.path;
    // Files made for the person (an export, a filled template) are outside the project, in the chat's own folder
    // (Dispatcher.filesDir). Templates were filled in a temp folder before that one: a link in an older answer still names it.
    let real = insideRoot(root, path) ?? insideRoot(dispatcher.filesDir(conv.id), path) ?? insideRoot(templateWorkDir(conv.id), path);
    if (!real && user.id === null) {
      try { real = realpathSync(resolve(root, path)); } catch { /* no such file */ }
    }
    try { return real && statSync(real).isFile() ? real : null; } catch { return null; }
  };
  app.get<{ Params: { id: string }; Querystring: { path: string } }>('/api/conversations/:id/files/download', {
    schema: { querystring: { type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } },
  }, (req, reply) => {
    const real = chatFile(req.params.id, req.query.path, req.user!);
    if (!real) return notFound(reply);
    return reply
      .header('content-type', 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName(real))}`)
      .header('content-length', statSync(real).size)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(real));
  });

  // An HTML file of the chat (a report an agent made) shown as a page in a new tab instead of downloaded. A tab cannot
  // send the token, so the panel first asks for a ticket: single use, short-lived. The page is whatever an agent wrote,
  // so it is served sandboxed: its scripts run in an origin of their own, without the panel's storage (where the token
  // is), and may load or send nothing over the network. Only what is inline in the file works.
  const viewTickets = new Map<string, { real: string; exp: number }>();
  app.post<{ Params: { id: string }; Body: { path: string } }>('/api/conversations/:id/files/view', {
    schema: { body: { type: 'object', required: ['path'], additionalProperties: false,
      properties: { path: { type: 'string', minLength: 1, maxLength: 4096 } } } },
  }, (req, reply) => {
    const real = chatFile(req.params.id, req.body.path, req.user!);
    if (!real) return notFound(reply);
    if (!VIEWABLE.has(extname(real).toLowerCase())) return reply.code(415).send({ error: 'only an HTML file can be opened as a page' });
    const now = Date.now();
    for (const [k, v] of viewTickets) if (v.exp <= now) viewTickets.delete(k);
    const ticket = randomBytes(24).toString('base64url');
    viewTickets.set(ticket, { real, exp: now + VIEW_TICKET_MS });
    return { ticket };
  });
  // The auth hook lets this path through: the ticket stands for the token.
  app.get<{ Querystring: { ticket?: string } }>('/api/files/view', (req, reply) => {
    const t = viewTickets.get(req.query.ticket ?? '');
    viewTickets.delete(req.query.ticket ?? '');
    let stat;
    try { stat = t && t.exp > Date.now() ? statSync(t.real) : undefined; } catch { /* removed since */ }
    if (!t || !stat?.isFile()) {
      return reply.code(404).type('text/plain; charset=utf-8').send('This link was already used or has expired. Open the file again from the chat.');
    }
    return reply
      .header('content-type', 'text/html; charset=utf-8')
      .header('content-length', stat.size)
      .header('content-security-policy', VIEW_CSP)
      .header('cache-control', 'private, no-store')
      .header('referrer-policy', 'no-referrer')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(t.real));
  });

  /** Attached files follow their projects' current permissions; a pending upload is private to its uploader. */
  const mayUseUpload = (path: string, user: AuthUser): boolean => {
    if (user.id === null) return true;
    const projects = store.uploadProjects(path);
    if (projects.length) return projects.some((id) => {
      const p = store.getProject(id);
      return p && canOpen(user, p);
    });
    return store.uploadOwner(path) === user.id;
  };

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
      if (!mayUseUpload(real, req.user!)) return notFound(reply);
      files.push(real);
    }
    for (const file of files) store.attachUpload(file, conv.project_id);
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
    store.recordUpload(realpathSync(dest), req.user!.id ?? 'owner');
    return reply.code(201).send({ path: dest });
  });

  // A file attached to a prompt, for the thread to show it. Images get their type so the panel can preview them; SVG is
  // left out of that list since it can carry script.
  app.get<{ Params: { dir: string; name: string } }>('/api/uploads/:dir/:name', (req, reply) => {
    const real = insideRoot(uploads, join(req.params.dir, req.params.name));
    if (!real || !mayUseUpload(real, req.user!)) return notFound(reply);
    let stat;
    try { stat = statSync(real); } catch { return notFound(reply); }
    if (!stat.isFile()) return notFound(reply);
    return reply
      .header('content-type', UPLOAD_IMAGE_TYPES[extname(real).toLowerCase()] ?? 'application/octet-stream')
      .header('content-disposition', `attachment; filename*=UTF-8''${encodeURIComponent(safeName(real))}`)
      .header('content-length', stat.size)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(createReadStream(real));
  });

  // The panel opens a chat with its last turns from here, then follows /events from the last one; older turns come a
  // page at a time. Long tool output is cut (see event-view.ts); /events/:eventId gives one event in full.
  app.get<{ Params: { id: string }; Querystring: { turns?: string; before?: string; focus?: string } }>('/api/conversations/:id/history', (req, reply) => {
    const id = req.params.id;
    if (!store.getConversation(id)) return notFound(reply);
    const num = (v: string | undefined) => (Number(v) > 0 ? Math.floor(Number(v)) : undefined);
    const page = store.historyPage(id, { turns: Math.min(num(req.query.turns) ?? 10, 200), before: num(req.query.before), focus: num(req.query.focus) });
    const usage = store.tokenUsage(id);
    const events = [];
    for (const e of page.events) {
      const payload = compactPayload(e.type, e.payload);
      if (payload === null) continue;
      try {
        const data = JSON.parse(payload);
        if (e.type === 'turn.completed') data.turn_usage = usage.byEvent.get(e.id) ?? null;
        events.push({ id: e.id, type: e.type, data, timestamp: e.created_at });
      } catch { /* not JSON: the stream drops it too */ }
    }
    const last = page.events.length ? page.events[page.events.length - 1]!.id : 0;
    return { events, before: page.first, more: page.more, last };
  });

  app.get<{ Params: { id: string; eventId: string } }>('/api/conversations/:id/events/:eventId', (req, reply) => {
    const e = store.eventOf(req.params.id, Number(req.params.eventId) || 0);
    if (!e) return notFound(reply);
    try { return { id: e.id, type: e.type, data: JSON.parse(e.payload) as unknown, timestamp: e.created_at }; } catch { return notFound(reply); }
  });

  // close() waits for requests still running (an upload, a clone), but a chat's event stream never ends by itself: without
  // ending them here the listener is gone while close() waits on them until the drain fallback exits (nginx answers 502
  // meanwhile). A reader reconnects with Last-Event-ID.
  const streams = new Set<ServerResponse>();
  app.addHook('preClose', async () => { for (const res of streams) res.end(); });

  /** `compact=1`: as the panel's thread takes it, long tool output cut (see event-view.ts). */
  app.get<{ Params: { id: string }; Querystring: { after?: string; compact?: string } }>('/api/conversations/:id/events', (req, reply) => {
    const id = req.params.id;
    if (!store.getConversation(id)) return notFound(reply);
    const after = Number(req.headers['last-event-id'] ?? req.query.after ?? 0) || 0;
    const compact = req.query.compact === '1';
    const usage = compact ? sessionUsage() : null;
    if (usage && after > 0) for (const event of store.usageThrough(id, after)) usage(event);
    reply.hijack();
    const res = reply.raw;
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    res.flushHeaders(); // otherwise headers wait for the first event and an idle stream looks hung
    type Ev = { id: number; type: string; payload: string; created_at: string };
    const write = (e: Ev) => {
      const turnUsage = usage?.(e);
      let payload = compact ? compactPayload(e.type, e.payload) : e.payload;
      if (payload === null) return true; // nothing written, so nothing to wait for
      if (compact && e.type === 'turn.completed') {
        try { payload = JSON.stringify({ ...JSON.parse(payload), turn_usage: turnUsage ?? null }); } catch { /* retain the original payload */ }
      }
      return res.write(`id: ${e.id}\nevent: ${e.type.replace(/[\r\n]/g, ' ')}\ndata: ${payload}\ntimestamp: ${e.created_at}\n\n`);
    };
    // Events arriving during replay are already persisted. The next page reads them with the
    // same cursor, so a slow client never needs its own buffer of pending events.
    let replaying = true;
    const off = dispatcher.subscribe(id, (e) => {
      if (replaying || res.writableEnded || res.destroyed) return;
      if (res.writableLength > 1_000_000) { res.destroy(); return; }
      write(e);
    });
    const ping = setInterval(() => { if (!res.writableEnded && !res.writableNeedDrain) res.write(': ping\n\n'); }, 15000);
    streams.add(res);
    const unwatch = chatAccess(req, id).watch(() => res.end());
    res.on('close', () => { unwatch(); off(); clearInterval(ping); streams.delete(res); });
    void (async () => {
      let cursor = after;
      while (!res.destroyed && !res.writableEnded) {
        const page = store.eventsAfter(id, cursor, 32);
        if (!page.length) { replaying = false; return; }
        for (const e of page) {
          if (res.destroyed || res.writableEnded) return;
          cursor = e.id;
          if (!write(e)) await new Promise<void>((done) => {
            const fin = () => { res.off('drain', fin); res.off('close', fin); done(); };
            res.on('drain', fin); res.on('close', fin);
          });
        }
        if (page.length === 32) await new Promise<void>((done) => setImmediate(done));
      }
    })().catch(() => res.destroy());
  });

  return app;
}

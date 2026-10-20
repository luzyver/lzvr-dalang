import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { basename, join } from 'node:path';
import websocket from '@fastify/websocket';
import type { IPty } from '@lydell/node-pty';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import type { Dispatcher } from './dispatcher.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

type PtyModule = typeof import('@lydell/node-pty');

export interface TermInfo {
  id: string; title: string; createdAt: number; exitCode: number | null;
  /** The account the shell runs as. */
  account: string;
}

interface Term {
  info: TermInfo;
  convId: string;
  /** Runs as the server's own account (the owner's terminals), not as TERMINAL_USER. */
  server: boolean;
  pty: IPty;
  /** The latest output, replayed to a panel that (re)attaches. */
  scrollback: string;
  sockets: Set<WebSocket>;
  idle?: NodeJS.Timeout;
}

const SCROLLBACK = 256 * 1024;
const MAX_PER_CHAT = 8;
const MAX_TOTAL = 32;
const TICKET_MS = 30_000;

/** The shell a terminal starts: TERMINAL_SHELL, else PowerShell on Windows and the user's login shell elsewhere. */
export function defaultShell(env: NodeJS.ProcessEnv = process.env, platform = process.platform): string[] {
  if (env.TERMINAL_SHELL) return [env.TERMINAL_SHELL];
  if (platform === 'win32') return ['powershell.exe', '-NoLogo'];
  const shell = env.SHELL && existsSync(env.SHELL) ? env.SHELL : existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh';
  return ['bash', 'zsh', 'fish'].includes(basename(shell)) ? [shell, '-l'] : [shell];
}

/** The account terminals run as when TERMINAL_USER is set (Linux), from /etc/passwd. */
export interface ShellUser { name: string; uid: number; gid: number; home: string; shell: string }

/** Groups whose members may use sudo on the usual distributions. */
const SUDO_GROUPS = ['sudo', 'wheel', 'admin', 'root'];

/**
 * Look up the account terminals run as, and refuse one that is root or may use sudo: a member (primary or
 * supplementary) of sudo/wheel/admin/root, or named in a sudoers file. `files` is for tests.
 */
export function shellUser(name: string, files?: { passwd: string; group: string; sudoers: string[] }): ShellUser {
  const read = (f: string) => { try { return readFileSync(f, 'utf8'); } catch { return ''; } };
  const sudoersFiles = () => {
    const dir = '/etc/sudoers.d';
    let extra: string[] = [];
    try { extra = readdirSync(dir).map((f) => read(join(dir, f))); } catch { /* none */ }
    return [read('/etc/sudoers'), ...extra];
  };
  const { passwd, group, sudoers } = files ?? { passwd: read('/etc/passwd'), group: read('/etc/group'), sudoers: sudoersFiles() };
  const row = passwd.split('\n').map((l) => l.split(':')).find((f) => f[0] === name && f.length >= 7);
  if (!row) throw new TerminalError(`TERMINAL_USER ${name} does not exist on this server (create it: useradd -m -s /bin/bash ${name})`);
  const user = { name, uid: Number(row[2]), gid: Number(row[3]), home: row[5] || '/', shell: row[6]!.trim() };
  if (!Number.isInteger(user.uid) || user.uid === 0) throw new TerminalError(`TERMINAL_USER ${name} is root: pick an account without root rights`);
  for (const line of group.split('\n')) {
    const [g, , gid, members = ''] = line.split(':');
    if (!g || !SUDO_GROUPS.includes(g)) continue;
    if (Number(gid) === user.gid || members.trim().split(',').includes(name)) {
      throw new TerminalError(`TERMINAL_USER ${name} is in the ${g} group and could use sudo: remove it (gpasswd -d ${name} ${g})`);
    }
  }
  const named = new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s`, 'm');
  if (sudoers.some((text) => named.test(text))) throw new TerminalError(`TERMINAL_USER ${name} is named in sudoers: remove that rule`);
  return user;
}

const SETPRIV = ['/usr/bin/setpriv', '/bin/setpriv'];

/**
 * The command that starts a terminal's shell as `user`: setpriv (util-linux) switches to the account and sets
 * no_new_privs, so nothing started in that shell can ever gain rights again (sudo, su and other setuid programs fail).
 */
export function asUser(user: ShellUser, shell: string[], setpriv: string | null | undefined = SETPRIV.find((p) => existsSync(p))): string[] {
  if (!setpriv) throw new TerminalError('TERMINAL_USER needs setpriv (package util-linux) to drop rights safely');
  const switching = process.getuid?.() !== user.uid;
  return [setpriv, ...(switching ? [`--reuid=${user.uid}`, `--regid=${user.gid}`, '--init-groups'] : []), '--no-new-privs', '--', ...shell];
}

/** The login shell of the terminal account; an account without one (nologin) gets bash. */
export function userShell(user: ShellUser, env: NodeJS.ProcessEnv = process.env): string[] {
  if (env.TERMINAL_SHELL) return [env.TERMINAL_SHELL];
  const shell = /(nologin|false)$/.test(user.shell) || !user.shell ? (existsSync('/bin/bash') ? '/bin/bash' : '/bin/sh') : user.shell;
  return ['bash', 'zsh', 'fish'].includes(basename(shell)) ? [shell, '-l'] : [shell];
}

/**
 * Shells in the code editor, one set per chat, running in that chat's folder. A terminal outlives the browser tab
 * that opened it (a reload re-attaches and replays its recent output) until it is closed, its shell exits and nobody
 * looks at it, or nobody has looked at it for `idleMs`.
 */
export class Terminals {
  #pty: Promise<PtyModule | null> | null = null;
  readonly #terms = new Map<string, Term>();

  /**
   * `user`: the account shells run as (default TERMINAL_USER; Linux only, ignored on Windows and macOS). Unset, they
   * run as the user Dalang runs as.
   */
  constructor(private readonly opts: { shell?: string[]; idleMs?: number; load?: () => Promise<PtyModule>; user?: string } = {}) {}

  /** The account terminals run as, or null for the server's own. */
  get userName(): string | null {
    const name = this.opts.user ?? process.env.TERMINAL_USER;
    return name && process.platform === 'linux' ? name : null;
  }

  /** node-pty is a native module: without a build for this machine the panel works on, only without terminals. */
  #module(): Promise<PtyModule | null> {
    this.#pty ??= (this.opts.load ?? (() => import('@lydell/node-pty')))()
      .then((m) => ((m as { default?: PtyModule }).default ?? m))
      .catch((e) => { console.warn('terminals are off: node-pty could not load', e); return null; });
    return this.#pty;
  }

  async available(): Promise<boolean> { return !!(await this.#module()); }

/** A chat's terminals; `owner: false` leaves out the ones running as the server's account (the owner's). */
  list(convId: string, { owner = true } = {}): TermInfo[] {
    return [...this.#terms.values()].filter((t) => t.convId === convId && (owner || !t.server)).map((t) => t.info);
  }

  /** The chat a terminal belongs to, if the caller may use it (only the owner reaches one running as the server). */
  convOf(id: string, { owner = true } = {}): string | null {
    const t = this.#terms.get(id);
    return t && (owner || !t.server) ? t.convId : null;
  }

  /**
   * Who may open a terminal, and as whom: the owner as the server's own account, admins and devs only as TERMINAL_USER
   * (so never as root); without one they get none. Null when they may not.
   */
  modeFor(user: { id: string | null }): 'server' | 'user' | null {
    if (user.id === null) return 'server';
    return this.userName ? 'user' : null;
  }

  async create(convId: string, o: { cwd: string; env: Record<string, string>; cols: number; rows: number; asServer: boolean }): Promise<TermInfo> {
    const mod = await this.#module();
    if (!mod) throw new TerminalError('terminals are not available on this server (node-pty did not load)');
    if (this.list(convId).length >= MAX_PER_CHAT) throw new TerminalError(`at most ${MAX_PER_CHAT} terminals per chat: close one first`);
    if (this.#terms.size >= MAX_TOTAL) throw new TerminalError('too many terminals are open on this server: close some first');
    let command = this.opts.shell ?? defaultShell();
    let env = o.env;
    const name = o.asServer ? null : this.userName;
    if (!o.asServer && !name) throw new TerminalError('terminals for admins and devs need TERMINAL_USER on the server');
    // Checked on every new terminal, so a change to the account (a group added) counts straight away.
    const user = name ? shellUser(name) : null;
    if (user) {
      command = this.opts.shell ?? userShell(user);
      env = Object.fromEntries(Object.entries(env).filter(([k]) => !/^(XDG_|SUDO_)/.test(k)));
      Object.assign(env, { HOME: user.home, USER: user.name, LOGNAME: user.name, SHELL: command[0]! });
    }
    const shellName = basename(command[0]!).replace(/\.exe$/i, '');
    const [file, ...args] = user ? asUser(user, command) : command;
    const pty = mod.spawn(file!, args, { name: 'xterm-256color', cols: o.cols, rows: o.rows, cwd: o.cwd, env });
    const n = Math.max(0, ...this.list(convId).map((t) => Number(/\d+$/.exec(t.title)?.[0] ?? 0))) + 1;
    const t: Term = {
      info: { id: randomUUID(), title: `${shellName} ${n}`, createdAt: Date.now(), exitCode: null, account: name ?? serverAccount() },
      convId, server: o.asServer, pty, scrollback: '', sockets: new Set(),
    };
    this.#terms.set(t.info.id, t);
    pty.onData((d) => {
      t.scrollback = (t.scrollback + d).slice(-SCROLLBACK);
      this.#send(t, { t: 'o', d });
    });
    pty.onExit(({ exitCode }) => {
      t.info.exitCode = exitCode;
      this.#send(t, { t: 'x', code: exitCode });
      if (!t.sockets.size) this.kill(t.info.id);
    });
    this.#watchIdle(t);
    return t.info;
  }

  #send(t: Term, msg: unknown) {
    const s = JSON.stringify(msg);
    for (const ws of t.sockets) if (ws.readyState === ws.OPEN) ws.send(s);
  }

  #watchIdle(t: Term) {
    clearTimeout(t.idle);
    t.idle = t.sockets.size ? undefined : setTimeout(() => this.kill(t.info.id), this.opts.idleMs ?? 60 * 60_000);
    t.idle?.unref();
  }

  /** Stream a terminal to a panel: its recent output first, then live; what the panel types goes to the shell. */
  attach(id: string, ws: WebSocket): void {
    const t = this.#terms.get(id);
    if (!t) { ws.close(4404, 'terminal closed'); return; }
    t.sockets.add(ws);
    this.#watchIdle(t);
    if (t.scrollback) ws.send(JSON.stringify({ t: 'o', d: t.scrollback }));
    if (t.info.exitCode !== null) ws.send(JSON.stringify({ t: 'x', code: t.info.exitCode }));
    ws.on('message', (raw) => {
      let m: { t?: string; d?: unknown; c?: unknown; r?: unknown };
      try { m = JSON.parse(String(raw)); } catch { return; }
      if (t.info.exitCode !== null) return;
      if (m.t === 'i' && typeof m.d === 'string') t.pty.write(m.d);
      else if (m.t === 'r' && Number.isInteger(m.c) && Number.isInteger(m.r)) {
        const cols = Math.min(Math.max(m.c as number, 2), 500);
        const rows = Math.min(Math.max(m.r as number, 1), 300);
        try { t.pty.resize(cols, rows); } catch { /* exited meanwhile */ }
      }
    });
    ws.on('close', () => {
      t.sockets.delete(ws);
      if (t.info.exitCode !== null && !t.sockets.size) this.kill(id);
      else if (this.#terms.has(id)) this.#watchIdle(t);
    });
  }

  kill(id: string): boolean {
    const t = this.#terms.get(id);
    if (!t) return false;
    this.#terms.delete(id);
    clearTimeout(t.idle);
    if (t.info.exitCode === null) { try { t.pty.kill(); } catch { /* already gone */ } }
    for (const ws of t.sockets) ws.close(4404, 'terminal closed');
    return true;
  }

  killConv(convId: string): void { for (const t of this.list(convId)) this.kill(t.id); }
  killAll(): void { for (const id of [...this.#terms.keys()]) this.kill(id); }
}

export class TerminalError extends Error {}

const serverAccount = () => { try { return userInfo().username; } catch { return 'server'; } };

/**
 * The code editor's terminals: admins only, since a shell can do anything the server's user can. A browser cannot put
 * the token on a WebSocket, so the panel first asks (with its token) for a ticket: single use, valid for 30 seconds,
 * for one terminal; the socket presents that instead.
 */
export function terminalRoutes(app: FastifyInstance, deps: {
  store: Store; dispatcher: Dispatcher; terminals: Terminals; noteFailure: (ip: string) => void;
}): void {
  const { store, dispatcher, terminals } = deps;
  const tickets = new Map<string, { term: string; exp: number }>();
  const notFound = (reply: FastifyReply) => reply.code(404).send({ error: 'not found' });
  const isOwner = (req: { user?: AuthUser }) => req.user?.id === null;
  /** Owner: always (as the server's account). Admins and devs: only with TERMINAL_USER, as that account. */
  const mayUse = async (req: { user?: AuthUser }, reply: FastifyReply) => {
    if (!req.user || !terminals.modeFor(req.user)) {
      return reply.code(403).send({ error: 'terminals are for the owner only here: admins and devs get one once TERMINAL_USER is set on the server' });
    }
  };
  app.addHook('onClose', async () => terminals.killAll());
  const size = (v: unknown, fallback: number, max: number) => (Number.isInteger(v) ? Math.min(Math.max(v as number, 2), max) : fallback);

  /**
   * What a shell gets: the server's environment without its secrets, and (the owner's) the git setup Dalang keeps for
   * them. A shell that runs as TERMINAL_USER uses that account's own git config and keys instead.
   */
  const envFor = (user: AuthUser, projectId: string, asServer: boolean): Record<string, string> => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => !e[0].startsWith('LZVR_') && e[1] !== undefined));
    // Agent turns may never stop at a prompt; a person at a terminal can answer one.
    const { GIT_TERMINAL_PROMPT: _p, GCM_INTERACTIVE: _g, ...git } = asServer ? dispatcher.gitEnvFor?.(user.name, projectId) ?? {} : {};
    return { ...env, ...git, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'dalang' };
  };

  app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  app.register(async (f) => {
    f.get<{ Params: { id: string } }>('/api/conversations/:id/terminals', { onRequest: mayUse }, (req, reply) =>
      store.getConversation(req.params.id) ? terminals.list(req.params.id, { owner: isOwner(req) }) : notFound(reply));

    f.post<{ Params: { id: string }; Body: { cols?: unknown; rows?: unknown } | undefined }>('/api/conversations/:id/terminals', {
      onRequest: mayUse,
    }, async (req, reply) => {
      const conv = store.getConversation(req.params.id);
      const project = conv && store.getProject(conv.project_id);
      if (!conv || !project) return notFound(reply);
      if (project.sandbox === 'read-only' && req.user!.role !== 'admin') return reply.code(403).send({ error: 'read-only project: admin only' });
      const asServer = terminals.modeFor(req.user!) === 'server';
      const cwd = conv.worktree ?? project.path;
      if (!existsSync(cwd)) return reply.code(400).send({ error: 'the chat\'s folder does not exist' });
      try {
        const info = await terminals.create(conv.id, {
          cwd, env: envFor(req.user!, project.id, asServer), cols: size(req.body?.cols, 80, 500), rows: size(req.body?.rows, 24, 300), asServer,
        });
        return reply.code(201).send(info);
      } catch (e) {
        if (e instanceof TerminalError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    });

    f.delete<{ Params: { tid: string } }>('/api/terminals/:tid', { onRequest: mayUse }, (req, reply) =>
      terminals.convOf(req.params.tid, { owner: isOwner(req) }) && terminals.kill(req.params.tid) ? reply.code(204).send() : notFound(reply));

    f.post<{ Params: { tid: string } }>('/api/terminals/:tid/ticket', { onRequest: mayUse }, (req, reply) => {
      if (!terminals.convOf(req.params.tid, { owner: isOwner(req) })) return notFound(reply);
      const now = Date.now();
      for (const [k, v] of tickets) if (v.exp <= now) tickets.delete(k);
      const ticket = randomBytes(24).toString('base64url');
      tickets.set(ticket, { term: req.params.tid, exp: now + TICKET_MS });
      return { ticket };
    });

    // The app's auth hook lets this path through without a token: the ticket is checked here, before the upgrade.
    f.get<{ Querystring: { ticket?: string } }>('/api/terminals/socket', {
      websocket: true,
      preValidation: async (req, reply) => {
        const t = tickets.get(req.query.ticket ?? '');
        tickets.delete(req.query.ticket ?? '');
        if (!t || t.exp <= Date.now()) {
          deps.noteFailure(req.ip);
          return reply.code(401).send({ error: 'unauthorized' });
        }
        (req as { termId?: string }).termId = t.term;
      },
    }, (socket, req) => terminals.attach((req as { termId?: string }).termId!, socket));
  });
}

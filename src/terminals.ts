import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import websocket from '@fastify/websocket';
import type { IPty } from '@lydell/node-pty';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { WebSocket } from 'ws';
import type { Dispatcher } from './dispatcher.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

type PtyModule = typeof import('@lydell/node-pty');

export interface TermInfo { id: string; title: string; createdAt: number; exitCode: number | null }

interface Term {
  info: TermInfo;
  convId: string;
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
export function asUser(user: ShellUser, shell: string[], setpriv = SETPRIV.find((p) => existsSync(p))): string[] {
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

  list(convId: string): TermInfo[] {
    return [...this.#terms.values()].filter((t) => t.convId === convId).map((t) => t.info);
  }

  convOf(id: string): string | null { return this.#terms.get(id)?.convId ?? null; }

  async create(convId: string, o: { cwd: string; env: Record<string, string>; cols: number; rows: number }): Promise<TermInfo> {
    const mod = await this.#module();
    if (!mod) throw new TerminalError('terminals are not available on this server (node-pty did not load)');
    if (this.list(convId).length >= MAX_PER_CHAT) throw new TerminalError(`at most ${MAX_PER_CHAT} terminals per chat: close one first`);
    if (this.#terms.size >= MAX_TOTAL) throw new TerminalError('too many terminals are open on this server: close some first');
    let command = this.opts.shell ?? defaultShell();
    let env = o.env;
    const name = this.userName;
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
      info: { id: randomUUID(), title: `${name ? `${name} · ` : ''}${shellName} ${n}`, createdAt: Date.now(), exitCode: null },
      convId, pty, scrollback: '', sockets: new Set(),
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
  const adminOnly = async (req: { user?: AuthUser }, reply: FastifyReply) => {
    if (req.user?.role !== 'admin') return reply.code(403).send({ error: 'terminals are for admins only' });
  };
  app.addHook('onClose', async () => terminals.killAll());
  const size = (v: unknown, fallback: number, max: number) => (Number.isInteger(v) ? Math.min(Math.max(v as number, 2), max) : fallback);

  /**
   * What a shell gets: the server's environment without its secrets, and the caller's own git setup. A shell that runs
   * as TERMINAL_USER uses that account's own git config and keys instead (Dalang's are not readable to it).
   */
  const envFor = (user: AuthUser, projectId: string): Record<string, string> => {
    const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => !e[0].startsWith('LZVR_') && e[1] !== undefined));
    // Agent turns may never stop at a prompt; a person at a terminal can answer one.
    const { GIT_TERMINAL_PROMPT: _p, GCM_INTERACTIVE: _g, ...git } = terminals.userName ? {} : dispatcher.gitEnvFor?.(user.name, projectId) ?? {};
    return { ...env, ...git, TERM: 'xterm-256color', COLORTERM: 'truecolor', TERM_PROGRAM: 'dalang' };
  };

  app.register(websocket, { options: { maxPayload: 1024 * 1024 } });
  app.register(async (f) => {
    f.get<{ Params: { id: string } }>('/api/conversations/:id/terminals', { onRequest: adminOnly }, (req, reply) =>
      store.getConversation(req.params.id) ? terminals.list(req.params.id) : notFound(reply));

    f.post<{ Params: { id: string }; Body: { cols?: unknown; rows?: unknown } | undefined }>('/api/conversations/:id/terminals', {
      onRequest: adminOnly,
    }, async (req, reply) => {
      const conv = store.getConversation(req.params.id);
      const project = conv && store.getProject(conv.project_id);
      if (!conv || !project) return notFound(reply);
      const cwd = conv.worktree ?? project.path;
      if (!existsSync(cwd)) return reply.code(400).send({ error: 'the chat\'s folder does not exist' });
      try {
        const info = await terminals.create(conv.id, { cwd, env: envFor(req.user!, project.id), cols: size(req.body?.cols, 80, 500), rows: size(req.body?.rows, 24, 300) });
        return reply.code(201).send(info);
      } catch (e) {
        if (e instanceof TerminalError) return reply.code(409).send({ error: e.message });
        throw e;
      }
    });

    f.delete<{ Params: { tid: string } }>('/api/terminals/:tid', { onRequest: adminOnly }, (req, reply) =>
      terminals.kill(req.params.tid) ? reply.code(204).send() : notFound(reply));

    f.post<{ Params: { tid: string } }>('/api/terminals/:tid/ticket', { onRequest: adminOnly }, (req, reply) => {
      if (!terminals.convOf(req.params.tid)) return notFound(reply);
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

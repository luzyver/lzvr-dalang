import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, rmSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { CLAUDE_SHARED_DIRS, linkSessions, SHARED_DIRS, type Accounts } from './accounts.js';
import { killTree } from './runner.js';
import type { Store } from './store.js';
import type { Backend } from './util.js';

// Account names become folder names and show up in the UI, so keep them boring.
const NAME_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;
const STATUS_TTL_MS = 30_000;

export class LoginError extends Error {
  constructor(readonly code: 'bad-name' | 'exists' | 'busy' | 'not-found' | 'primary', message: string) {
    super(message);
  }
}

/** What differs between the CLIs: where the account lives, how to sign in, how to ask if it is signed in. */
const KINDS = {
  codex: { homeEnv: 'CODEX_HOME', loginArgs: ['login', '--device-auth'], statusArgs: ['login', 'status'], kv: 'extra_homes', shared: SHARED_DIRS },
  claude: { homeEnv: 'CLAUDE_CONFIG_DIR', loginArgs: ['auth', 'login'], statusArgs: ['auth', 'status', '--json'], kv: 'extra_claude_homes', shared: CLAUDE_SHARED_DIRS },
} as const;

export interface LoginState {
  id: string;
  name: string;
  status: 'pending' | 'success' | 'failed' | 'cancelled';
  /** What the login command printed (colour codes removed, last 4000 chars). */
  output: string;
  /** Best-effort pick of the sign-in link and the device code from the output; the raw output is always available. */
  url: string | null;
  code: string | null;
  error?: string;
}

interface Opts {
  backend?: Backend;
  command: string[];
  /** Each panel-added account gets `<baseDir>/<name>` as its CODEX_HOME / CLAUDE_CONFIG_DIR. */
  baseDir: string;
  accounts: Accounts;
  store: Store;
  env?: Record<string, string>;
  timeoutMs?: number;
}

/** Runs `codex login --device-auth` for a new account, so accounts can be added from the panel instead of the VM shell. */
export class Logins {
  private states = new Map<string, LoginState>();
  private children = new Map<string, ReturnType<typeof spawn>>();
  private running: string | null = null;
  private statusCache = new Map<string, { value: boolean | null; at: number }>();

  private kind: (typeof KINDS)[Backend];

  constructor(private opts: Opts) {
    this.kind = KINDS[opts.backend ?? 'codex'];
  }

  /** Homes added through the panel in earlier runs. */
  loadExtras(): string[] {
    try { return JSON.parse(this.opts.store.getKv(this.kind.kv) ?? '[]') as string[]; } catch { return []; }
  }

  get(id: string): LoginState | null { return this.states.get(id) ?? null; }

  start(name: string): string {
    if (!NAME_RE.test(name)) throw new LoginError('bad-name', 'name must be 1-32 characters: a-z, 0-9, - or _ (starting with a letter or digit)');
    if (this.running) throw new LoginError('busy', 'another login is already in progress');
    const home = join(this.opts.baseDir, name);
    if (this.opts.accounts.list().some((a) => a.name === name) || existsSync(home)) {
      throw new LoginError('exists', `an account named "${name}" already exists`);
    }
    mkdirSync(home, { recursive: true, mode: 0o700 });

    const id = randomUUID();
    const st: LoginState = { id, name, status: 'pending', output: '', url: null, code: null };
    this.states.set(id, st);
    this.running = id;

    const [cmd, ...pre] = this.opts.command;
    const inherited = Object.entries(process.env).filter(([k]) => !k.startsWith('LZVR_'));
    const child = spawn(cmd!, [...pre, ...this.kind.loginArgs], {
      env: { ...Object.fromEntries(inherited), ...this.opts.env, [this.kind.homeEnv]: home },
      // Claude's login can also finish by pasting the code its sign-in page shows, so it needs stdin.
      stdio: [this.opts.backend === 'claude' ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
    });
    child.stdin?.on('error', () => {}); // the login may already be done
    this.children.set(id, child);

    const settle = (status: LoginState['status'], error?: string) => {
      if (st.status !== 'pending') return;
      st.status = status;
      if (error) st.error = error;
      if (this.running === id) this.running = null;
      this.children.delete(id);
      clearTimeout(timer);
      if (status !== 'success') rmSync(home, { recursive: true, force: true }); // never leave half a login behind
    };

    const timer = setTimeout(() => {
      if (st.status !== 'pending') return;
      killTree(child, 'SIGTERM');
      settle('failed', 'timed out waiting for the login to be completed');
    }, this.opts.timeoutMs ?? 15 * 60_000);
    timer.unref();

    const onData = (b: Buffer) => {
      st.output = (st.output + String(b).replace(ANSI, '')).slice(-4000);
      st.url ??= /https?:\/\/[^\s)"']+/.exec(st.output)?.[0] ?? null;
      st.code ??= /\b[A-Z0-9]{4}-[A-Z0-9]{4,6}\b/.exec(st.output)?.[0] ?? null;
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);

    child.once('error', (e) => settle('failed', e.message));
    child.once('close', (code) => {
      if (st.status !== 'pending') return;
      if (code !== 0) {
        settle('failed', st.output.trim().split('\n').pop() || `login exited with code ${code}`);
        return;
      }
      // Exit 0 is not enough: only accept the account if the CLI itself says this home is logged in.
      void this.check(home).then((ok) => {
        if (st.status !== 'pending') return;
        if (ok !== true) { settle('failed', 'the login did not complete (the CLI reports this account as not logged in)'); return; }
        this.opts.accounts.add(home);
        this.opts.store.setKv(this.kind.kv, JSON.stringify([...new Set([...this.loadExtras(), home])]));
        linkSessions(this.opts.accounts.homes, [...this.kind.shared]); // so a chat can resume on the new account
        this.statusCache.set(home, { value: true, at: Date.now() });
        settle('success');
      });
    });
    return id;
  }

  /**
   * Sign an account out of the gateway and delete its folder (its login included). Only accounts added from the panel.
   * The first account owns the real `sessions` and `memories` folders the others link to, so it can only go last.
   * A turn already running on it is not interrupted and may fail when its folder disappears.
   */
  remove(name: string): void {
    const home = join(this.opts.baseDir, name);
    if (!NAME_RE.test(name) || !this.loadExtras().includes(home) || !this.opts.accounts.homes.includes(home)) {
      throw new LoginError('not-found', `no panel account named "${name}"`);
    }
    if (this.opts.accounts.homes[0] === home && this.opts.accounts.homes.length > 1) {
      throw new LoginError('primary', 'this is the first account and holds the shared sessions: remove the other accounts first');
    }
    this.opts.accounts.remove(home);
    this.opts.store.setKv(this.kind.kv, JSON.stringify(this.loadExtras().filter((h) => h !== home)));
    this.statusCache.delete(home);
    for (const dir of this.kind.shared) { // drop the links first so deleting the folder can never reach the shared data
      const link = join(home, dir);
      try { if (lstatSync(link).isSymbolicLink()) unlinkSync(link); } catch { /* absent, or a junction rmSync handles below */ }
    }
    rmSync(home, { recursive: true, force: true });
  }

  /** Feed the sign-in code to a pending login that is waiting for one (Claude Code). */
  sendCode(id: string, code: string): boolean {
    const child = this.children.get(id);
    if (!child?.stdin || this.states.get(id)?.status !== 'pending') return false;
    child.stdin.write(`${code}
`);
    return true;
  }

  cancel(id: string): boolean {
    const st = this.states.get(id);
    const child = this.children.get(id);
    if (!st || st.status !== 'pending' || !child) return false;
    st.status = 'cancelled';
    if (this.running === id) this.running = null;
    this.children.delete(id);
    killTree(child, 'SIGTERM');
    // the folder goes once the process is gone, so it is not deleted from under a still-running login
    child.once('close', () => rmSync(join(this.opts.baseDir, st.name), { recursive: true, force: true }));
    return true;
  }

  /** The CLI's own login status for one home: true/false, or null when it could not be asked. */
  private check(home: string): Promise<boolean | null> {
    return new Promise((resolve) => {
      const [cmd, ...pre] = this.opts.command;
      let done = false;
      const finish = (v: boolean | null) => { if (!done) { done = true; clearTimeout(t); resolve(v); } };
      const child = spawn(cmd!, [...pre, ...this.kind.statusArgs], {
        env: { ...Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LZVR_'))), ...this.opts.env, [this.kind.homeEnv]: home },
        stdio: ['ignore', 'pipe', 'ignore'],
      });
      let out = '';
      child.stdout.on('data', (d) => { out += d; });
      const t = setTimeout(() => { child.kill(); finish(null); }, 10_000);
      child.once('error', () => finish(null));
      child.once('close', (code) => {
        if (this.opts.backend !== 'claude') return finish(code === 0);
        try { finish((JSON.parse(out) as { loggedIn?: unknown }).loggedIn === true); } catch { finish(null); } // claude prints JSON whatever the exit code
      });
    });
  }

  /** Whether Codex considers this account logged in. Cached briefly because the panel polls. */
  async isLoggedIn(home: string, o: { fresh?: boolean } = {}): Promise<boolean | null> {
    const hit = this.statusCache.get(home);
    if (hit && !o.fresh && Date.now() - hit.at < STATUS_TTL_MS) return hit.value;
    const value = await this.check(home);
    this.statusCache.set(home, { value, at: Date.now() });
    return value;
  }
}

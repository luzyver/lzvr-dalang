import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { forgeOf, type Forge } from './forge.js';
import { pushTarget } from './git.js';
import { killTree } from './runner.js';

/**
 * Settings → Git: the server's own git and forge logins, so they need not be set up in a shell on the VM. Everything runs
 * as the user Dalang runs as and lands where a manual setup would: `git config --global`, `~/.ssh`, and the gh/glab
 * logins kept by those CLIs. Dalang stores no token itself.
 */

/** A host name with an optional port (`github.com`, `gitlab.example.com:8443`, an SSH alias such as `github.com-work`). */
export const HOST_RE = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?(?::\d{1,5})?$/i;
const KEY_NAME_RE = /^[\w.-]{1,64}$/;
/** An SSH alias: a plain host-like name, no port, no wildcards. */
const ALIAS_RE = /^[a-z0-9](?:[a-z0-9._-]{0,251}[a-z0-9])?$/i;
const MARKER = '# Added by Dalang';
const ANSI = /\u001b\[[0-9;?]*[A-Za-z]/g;

export class GitAuthError extends Error {
  constructor(readonly code: 'bad-input' | 'exists' | 'busy' | 'not-found' | 'failed', message: string) {
    super(message);
  }
}

export interface GitAuthOpts {
  /** How to start `gh` / `glab` (the binary and any leading arguments). */
  ghCommand: string[];
  glabCommand: string[];
  /** Where the SSH keys and known_hosts live (`~/.ssh`). */
  sshDir: string;
  gitCommand?: string[];
  /** The ssh to run (binary and leading options); a function when it depends on which keys exist right now. */
  sshCommand?: string[] | (() => string[]);
  sshKeygenCommand?: string[];
  /** Extra environment for every command (tests: GIT_CONFIG_GLOBAL, GH_CONFIG_DIR). */
  env?: Record<string, string> | (() => Record<string, string>);
  /** gh keeps its token in its config folder rather than the OS keyring (a panel user's own login must stay in their folder). */
  ghInsecureStorage?: boolean;
  timeoutMs?: number;
}

export interface ForgeAccount { host: string; user: string; ok: boolean; active: boolean }
export interface ForgeStatus { installed: boolean; accounts: ForgeAccount[]; output: string }
export interface SshKey { name: string; type: string; publicKey: string; comment: string; fingerprint: string | null }

export interface WebLoginState {
  id: string;
  host: string;
  status: 'pending' | 'success' | 'failed' | 'cancelled';
  output: string;
  url: string | null;
  code: string | null;
  error?: string;
}

/** One `Host <alias>` block of `~/.ssh/config` naming a single host (no wildcards): what an SSH remote can point at. */
export interface SshAlias { alias: string; hostName: string; user: string; port: string; identityFile: string; managed: boolean }

/** The single-name `Host` blocks of an ssh config, with the line range each takes (marker comment included). */
export function parseSshConfig(text: string): (SshAlias & { start: number; end: number })[] {
  const lines = text.split(/\r?\n/);
  const out: (SshAlias & { start: number; end: number })[] = [];
  let cur: (SshAlias & { start: number; end: number }) | null = null;
  const close = (i: number) => { if (cur) { cur.end = i; out.push(cur); cur = null; } };
  lines.forEach((raw, i) => {
    const m = /^\s*(\w+)\s*(?:=\s*|\s+)(.*?)\s*$/.exec(raw);
    if (!m || raw.trim().startsWith('#')) return;
    const key = m[1]!.toLowerCase();
    const value = m[2]!.replace(/^"(.*)"$/, '$1');
    if (key === 'host' || key === 'match') {
      // the block ends before the blank lines and comments that lead into the next one
      let end = i;
      while (end > 0 && (!lines[end - 1]!.trim() || lines[end - 1]!.trim().startsWith('#'))) end--;
      close(Math.max(end, cur?.start ?? 0));
      if (key === 'host' && /^[^\s*?!]+$/.test(value)) {
        const managed = lines[i - 1]?.trim() === MARKER;
        cur = { alias: value, hostName: '', user: '', port: '', identityFile: '', managed, start: managed ? i - 1 : i, end: lines.length };
      }
      return;
    }
    if (!cur) return;
    if (key === 'hostname') cur.hostName = value;
    else if (key === 'user') cur.user = value;
    else if (key === 'port') cur.port = value;
    else if (key === 'identityfile' && !cur.identityFile) cur.identityFile = value;
  });
  close(lines.length);
  return out;
}

interface Result { code: number | null; out: string; missing: boolean }

/** `user@host` style lines both CLIs print: `✓ Logged in to github.com account octo (keyring)` (gh), `... as octo (...)` (glab, old gh). */
export function parseAuthStatus(text: string): ForgeAccount[] {
  const accounts: ForgeAccount[] = [];
  for (const line of text.replace(ANSI, '').split(/\r?\n/)) {
    const m = /(Failed to log in to|Logged in to) (\S+?)(?::)? (?:account|as) (\S+)/.exec(line);
    if (m) { accounts.push({ host: m[2]!.toLowerCase(), user: m[3]!, ok: m[1] === 'Logged in to', active: true }); continue; }
    const active = /Active account: (true|false)/.exec(line);
    if (active && accounts.length) accounts[accounts.length - 1]!.active = active[1] === 'true';
  }
  return accounts;
}

/** A git credential helper value that runs a command: `!"C:/Program Files/glab/glab.exe" auth git-credential`. */
export function helperCommand(command: string[], args: string): string {
  return `!${command.map((p) => (/^[\w./:@-]+$/.test(p) ? p : `"${p.replace(/\\/g, '/').replace(/"/g, '\\"')}"`)).join(' ')} ${args}`;
}

export class GitAuth {
  private web = new Map<string, WebLoginState>();
  private webChild: ReturnType<typeof spawn> | null = null;
  private webRunning: string | null = null;

  constructor(private opts: GitAuthOpts) {}

  private env(extra: Record<string, string> = {}): Record<string, string> {
    // Like git and the Merge Request CLI: no gateway secrets, and nothing may wait for an answer on a terminal.
    const inherited = Object.entries(process.env).filter((e): e is [string, string] => !e[0].startsWith('LZVR_') && e[1] !== undefined);
    return { ...Object.fromEntries(inherited), GH_PROMPT_DISABLED: '1', NO_PROMPT: '1', GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...(typeof this.opts.env === 'function' ? this.opts.env() : this.opts.env), ...extra };
  }

  private run(command: string[], args: string[], o: { input?: string; env?: Record<string, string>; timeoutMs?: number } = {}): Promise<Result> {
    const [cmd, ...pre] = command;
    return new Promise((resolve) => {
      let out = '';
      let done = false;
      const finish = (r: Result) => { if (!done) { done = true; clearTimeout(t); resolve(r); } };
      const child = spawn(cmd!, [...pre, ...args], { env: this.env(o.env), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      const t = setTimeout(() => { killTree(child, 'SIGTERM'); finish({ code: null, out: `${out}\ntimed out`, missing: false }); }, o.timeoutMs ?? this.opts.timeoutMs ?? 60_000);
      const onData = (b: Buffer) => { out = (out + String(b).replace(ANSI, '')).slice(-8000); };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      child.stdin.on('error', () => {});
      child.stdin.end(o.input ?? '');
      child.once('error', (e: NodeJS.ErrnoException) => finish({ code: null, out: e.message, missing: e.code === 'ENOENT' }));
      child.once('close', (code) => finish({ code, out, missing: false }));
    });
  }

  private ssh(): string[] {
    const c = this.opts.sshCommand;
    return (typeof c === 'function' ? c() : c) ?? ['ssh'];
  }

  /** How ~/.ssh/config names a key: `~/.ssh/<name>` in the real one, the full path in a panel user's own folder. */
  private keyPath(name: string): string {
    if (resolve(this.opts.sshDir) === resolve(homedir(), '.ssh')) return `~/.ssh/${name}`;
    const full = join(this.opts.sshDir, name).replace(/\\/g, '/');
    return /\s/.test(full) ? `"${full}"` : full;
  }

  private cli(forge: Forge): { command: string[]; name: string } {
    return forge === 'github' ? { command: this.opts.ghCommand, name: 'gh' } : { command: this.opts.glabCommand, name: 'glab' };
  }

  private async must(command: string[], name: string, args: string[], o: Parameters<GitAuth['run']>[2] = {}): Promise<string> {
    const r = await this.run(command, args, o);
    if (r.missing) throw new GitAuthError('failed', `${name} is not installed on the server (or not on PATH)`);
    if (r.code !== 0) throw new GitAuthError('failed', `${name} failed: ${r.out.trim().slice(-1500) || `exit code ${r.code}`}`);
    return r.out;
  }

  private git(args: string[]): Promise<Result> {
    return this.run(this.opts.gitCommand ?? ['git'], args, { timeoutMs: 15_000 });
  }

  // ---- git identity and HTTPS credential helpers -------------------------------------------------------------------

  async identity(): Promise<{ name: string; email: string }> {
    const [name, email] = await Promise.all([this.git(['config', '--global', '--get', 'user.name']), this.git(['config', '--global', '--get', 'user.email'])]);
    return { name: name.code === 0 ? name.out.trim() : '', email: email.code === 0 ? email.out.trim() : '' };
  }

  /**
   * Empty values remove the setting. With `repo`, only that repository's own config (`git config --local`, shared by
   * its worktrees), so its commits get another author than the global one; removing them falls back to the global.
   */
  async setIdentity(name: string, email: string, repo?: string): Promise<void> {
    const scope = repo ? ['-C', repo, 'config', '--local'] : ['config', '--global'];
    for (const [key, value] of [['user.name', name], ['user.email', email]] as const) {
      const r = await this.git(value ? [...scope, key, value] : [...scope, '--unset-all', key]);
      // exit 5: unsetting a key that was not set
      if (r.code !== 0 && !(r.code === 5 && !value)) throw new GitAuthError('failed', `git config failed: ${r.out.trim()}`);
    }
  }

  /** `credential.<url>.helper` entries from the global git config: which HTTPS hosts get their password from a CLI. */
  async credentialHelpers(): Promise<{ scope: string; helper: string }[]> {
    const r = await this.git(['config', '--global', '--get-regexp', '^credential\\.']);
    if (r.code !== 0) return [];
    return r.out.split(/\r?\n/).flatMap((line) => {
      const m = /^credential\.(?:(.+)\.)?helper (.*)$/i.exec(line.trim());
      return m && m[2] ? [{ scope: m[1] ?? '*', helper: m[2] }] : [];
    });
  }

  /** Let git over HTTPS to this host sign in with the forge CLI's login, like `gh auth setup-git`. */
  async setupHttps(forge: Forge, host: string): Promise<void> {
    checkHost(host);
    if (forge === 'github') {
      await this.must(this.opts.ghCommand, 'gh', ['auth', 'setup-git', '--hostname', host]);
      return;
    }
    // glab has no setup-git; write what its interactive login would. The empty entry first drops helpers set more widely.
    const key = `credential.https://${host}.helper`;
    for (const args of [['config', '--global', '--replace-all', key, ''], ['config', '--global', '--add', key, helperCommand(this.opts.glabCommand, 'auth git-credential')]]) {
      const r = await this.git(args);
      if (r.code !== 0) throw new GitAuthError('failed', `git config failed: ${r.out.trim()}`);
    }
  }

  private async dropHttps(host: string): Promise<void> {
    await this.git(['config', '--global', '--unset-all', `credential.https://${host}.helper`]);
  }

  // ---- forge logins --------------------------------------------------------------------------------------------------

  async forgeStatus(forge: Forge): Promise<ForgeStatus> {
    const { command } = this.cli(forge);
    const r = await this.run(command, ['auth', 'status'], { timeoutMs: 30_000 });
    if (r.missing) return { installed: false, accounts: [], output: '' };
    const status = { installed: true, accounts: parseAuthStatus(r.out), output: r.out.trim() };
    this.knownHosts.set(forge, { hosts: new Set(status.accounts.map((a) => a.host)), at: Date.now() });
    return status;
  }

  private knownHosts = new Map<Forge, { hosts: Set<string>; at: number }>();

  /**
   * GitHub or GitLab for a host whose name says neither (`git.example.com`): the one whose CLI is signed in to it.
   * `gh`/`glab auth status` are asked at most every few minutes; null when neither knows the host.
   */
  async forgeForHost(host: string): Promise<Forge | null> {
    const h = host.toLowerCase();
    const named = forgeOf(h);
    if (named) return named;
    for (const forge of ['gitlab', 'github'] as const) {
      const hit = this.knownHosts.get(forge);
      const hosts = hit && Date.now() - hit.at < 5 * 60_000 ? hit.hosts : new Set((await this.forgeStatus(forge)).accounts.map((a) => a.host));
      if (hosts.has(h)) return forge;
    }
    return null;
  }

  /** Sign the CLI in with a personal access token, passed on stdin so it never shows up in a process list. */
  async login(forge: Forge, host: string, token: string, https: boolean): Promise<void> {
    checkHost(host);
    if (!token || /\s/.test(token)) throw new GitAuthError('bad-input', 'the token must not be empty or contain spaces');
    const { command, name } = this.cli(forge);
    const protocol = https ? 'https' : 'ssh';
    const args = forge === 'github'
      ? ['auth', 'login', '--hostname', host, '--with-token', '--git-protocol', protocol, '--skip-ssh-key', ...(this.opts.ghInsecureStorage ? ['--insecure-storage'] : [])]
      : ['auth', 'login', '--hostname', host, '--stdin', '--git-protocol', protocol];
    await this.must(command, name, args, { input: `${token}\n` });
    this.knownHosts.delete(forge); // a host signed in just now must count for forgeForHost at once
    if (https) await this.setupHttps(forge, host);
  }

  async logout(forge: Forge, host: string, user?: string): Promise<void> {
    checkHost(host);
    const { command, name } = this.cli(forge);
    const args = ['auth', 'logout', '--hostname', host];
    if (forge === 'github' && user) args.push('--user', user);
    await this.must(command, name, args);
    const left = (await this.forgeStatus(forge)).accounts.filter((a) => a.host === host);
    if (!left.length) await this.dropHttps(host); // a helper with no login behind it would only fail
  }

  /** Add one of the server's public keys to the signed-in account, so git over SSH works for it. */
  async uploadKey(forge: Forge, host: string, keyName: string, title: string): Promise<string> {
    checkHost(host);
    const key = this.sshKeys().find((k) => k.name === keyName);
    if (!key) throw new GitAuthError('not-found', `no public key named ${keyName} in ${this.opts.sshDir}`);
    const { command, name } = this.cli(forge);
    const file = join(this.opts.sshDir, `${keyName}.pub`);
    const env: Record<string, string> = forge === 'github' ? { GH_HOST: host } : { GITLAB_HOST: host };
    return (await this.must(command, name, ['ssh-key', 'add', file, '--title', title || key.comment || 'dalang'], { env })).trim();
  }

  /**
   * GitHub's browser sign-in: `gh auth login --web` prints a one-time code and a link and waits until it is approved.
   * Without a terminal gh does not open a browser itself. One at a time.
   */
  startWebLogin(host: string, https: boolean): string {
    checkHost(host);
    if (this.webRunning) throw new GitAuthError('busy', 'another sign-in is already in progress');
    const id = randomUUID();
    const st: WebLoginState = { id, host, status: 'pending', output: '', url: null, code: null };
    this.web.set(id, st);
    this.webRunning = id;
    const [cmd, ...pre] = this.opts.ghCommand;
    // admin:public_key lets "Add to account" upload the server's SSH key with the same login.
    const child = spawn(cmd!, [...pre, 'auth', 'login', '--web', '--hostname', host, '--git-protocol', https ? 'https' : 'ssh',
      '--skip-ssh-key', '--scopes', 'admin:public_key', ...(this.opts.ghInsecureStorage ? ['--insecure-storage'] : [])], {
      env: this.env(), stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true, detached: process.platform !== 'win32',
    });
    this.webChild = child;
    const settle = (status: WebLoginState['status'], error?: string) => {
      if (st.status !== 'pending') return;
      st.status = status;
      if (error) st.error = error;
      if (this.webRunning === id) { this.webRunning = null; this.webChild = null; }
      clearTimeout(timer);
    };
    const timer = setTimeout(() => { killTree(child, 'SIGTERM'); settle('failed', 'timed out waiting for the sign-in to be approved'); }, this.opts.timeoutMs ?? 15 * 60_000);
    timer.unref();
    const onData = (b: Buffer) => {
      st.output = (st.output + String(b).replace(ANSI, '')).slice(-4000);
      st.url ??= /https?:\/\/[^\s)"']+/.exec(st.output)?.[0] ?? null;
      st.code ??= /\b[A-Z0-9]{4}-[A-Z0-9]{4}\b/.exec(st.output)?.[0] ?? null;
    };
    child.stdout!.on('data', onData);
    child.stderr!.on('data', onData);
    child.once('error', (e: NodeJS.ErrnoException) => settle('failed', e.code === 'ENOENT' ? 'gh is not installed on the server (or not on PATH)' : e.message));
    child.once('close', (code) => {
      if (st.status !== 'pending') return;
      if (code !== 0) return settle('failed', st.output.trim().split('\n').pop() || `gh exited with code ${code}`);
      this.knownHosts.delete('github');
      if (!https) return settle('success');
      this.setupHttps('github', host).then(() => settle('success'), (e: Error) => settle('failed', e.message));
    });
    return id;
  }

  webLogin(id: string): WebLoginState | null { return this.web.get(id) ?? null; }

  cancelWebLogin(id: string): boolean {
    const st = this.web.get(id);
    if (!st || st.status !== 'pending' || this.webRunning !== id || !this.webChild) return false;
    st.status = 'cancelled';
    killTree(this.webChild, 'SIGTERM');
    this.webRunning = null;
    this.webChild = null;
    return true;
  }

  // ---- SSH -------------------------------------------------------------------------------------------------------------

  /** The public keys in `~/.ssh` (`*.pub`), with their SHA256 fingerprint as GitHub and GitLab show it. */
  sshKeys(): SshKey[] {
    let names: string[];
    try { names = readdirSync(this.opts.sshDir).filter((f) => f.endsWith('.pub')).sort(); } catch { return []; }
    return names.flatMap((f) => {
      let text: string;
      try { text = readFileSync(join(this.opts.sshDir, f), 'utf8').trim(); } catch { return []; }
      const [type, body, ...comment] = text.split(/\s+/);
      if (!type || !body || !/^(ssh-|ecdsa-|sk-)/.test(type)) return [];
      return [{ name: f.slice(0, -4), type, publicKey: `${type} ${body}${comment.length ? ` ${comment.join(' ')}` : ''}`, comment: comment.join(' '), fingerprint: null }];
    });
  }

  async sshKeysWithFingerprints(): Promise<SshKey[]> {
    return Promise.all(this.sshKeys().map(async (k) => {
      const r = await this.run(this.opts.sshKeygenCommand ?? ['ssh-keygen'], ['-l', '-f', join(this.opts.sshDir, `${k.name}.pub`)], { timeoutMs: 10_000 });
      return { ...k, fingerprint: r.code === 0 ? /SHA256:\S+/.exec(r.out)?.[0] ?? null : null };
    }));
  }

  /** A new ed25519 key without a passphrase (nobody would be there to type it). Never overwrites a key. */
  async generateKey(name: string, comment: string): Promise<SshKey> {
    if (!KEY_NAME_RE.test(name) || name.startsWith('.')) throw new GitAuthError('bad-input', 'key name: letters, digits, ., - or _');
    const file = join(this.opts.sshDir, name);
    if (existsSync(file) || existsSync(`${file}.pub`)) throw new GitAuthError('exists', `${file} already exists`);
    mkdirSync(this.opts.sshDir, { recursive: true, mode: 0o700 });
    await this.must(this.opts.sshKeygenCommand ?? ['ssh-keygen'], 'ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-C', comment || 'dalang', '-f', file], { timeoutMs: 30_000 });
    const key = (await this.sshKeysWithFingerprints()).find((k) => k.name === name);
    if (!key) throw new GitAuthError('failed', `ssh-keygen did not write ${file}.pub`);
    return key;
  }

  private get sshConfigPath(): string { return join(this.opts.sshDir, 'config'); }

  private readSshConfig(): string {
    try { return readFileSync(this.sshConfigPath, 'utf8'); } catch { return ''; }
  }

  /** The aliases in `~/.ssh/config`, e.g. `github.com-work` → github.com with its own key: one per account on a forge. */
  sshAliases(): SshAlias[] {
    return parseSshConfig(this.readSshConfig()).map(({ start: _s, end: _e, ...a }) => a);
  }

  /**
   * Append a `Host <alias>` block that reaches `hostName` with one of the server's keys (and only that key, so the
   * forge sees the right account). A remote then reads `git@<alias>:owner/repo.git`.
   */
  addSshAlias(alias: string, hostName: string, keyName: string): SshAlias {
    if (!ALIAS_RE.test(alias)) throw new GitAuthError('bad-input', `not a valid alias: ${alias}`);
    checkHost(hostName);
    const key = this.sshKeys().find((k) => k.name === keyName);
    if (!key || !existsSync(join(this.opts.sshDir, keyName))) throw new GitAuthError('not-found', `no SSH key named ${keyName} in ${this.opts.sshDir}`);
    const text = this.readSshConfig();
    if (parseSshConfig(text).some((a) => a.alias.toLowerCase() === alias.toLowerCase())) {
      throw new GitAuthError('exists', `${alias} is already in ${this.sshConfigPath}`);
    }
    const [name, port] = hostName.split(':');
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const block = [MARKER, `Host ${alias}`, `    HostName ${name}`, ...(port ? [`    Port ${port}`] : []), '    User git',
      `    IdentityFile ${this.keyPath(keyName)}`, '    IdentitiesOnly yes'].join(nl);
    const sep = !text ? '' : text.endsWith(nl + nl) ? '' : text.endsWith(nl) ? nl : nl + nl;
    mkdirSync(this.opts.sshDir, { recursive: true, mode: 0o700 });
    writeFileSync(this.sshConfigPath, `${text}${sep}${block}${nl}`, { mode: 0o600 });
    return this.sshAliases().find((a) => a.alias === alias)!;
  }

  /** Drop one alias block (and the comment Dalang put above it); the rest of the file is left as it is. */
  removeSshAlias(alias: string): void {
    const text = this.readSshConfig();
    const hit = parseSshConfig(text).find((a) => a.alias === alias);
    if (!hit) throw new GitAuthError('not-found', `no alias ${alias} in ${this.sshConfigPath}`);
    const nl = text.includes('\r\n') ? '\r\n' : '\n';
    const lines = text.split(/\r?\n/);
    let end = hit.end;
    while (end < lines.length && !lines[end]!.trim()) end++; // the blank lines after it go too
    lines.splice(hit.start, end - hit.start);
    const out = lines.join(nl);
    writeFileSync(this.sshConfigPath, out && !out.endsWith(nl) ? out + nl : out); // the last block took the final newline along
  }

  /**
   * `ssh -T git@host`: whether the forge accepts one of the server's keys. A host seen for the first time is added to
   * known_hosts (accept-new), so the first `git push` does not stop at the "continue connecting?" question.
   */
  async testSsh(host: string, user = 'git'): Promise<{ ok: boolean; account: string | null; output: string }> {
    checkHost(host);
    if (!/^[\w.-]+$/.test(user)) throw new GitAuthError('bad-input', `not a user name: ${user}`);
    const [name, port] = host.split(':');
    const r = await this.run(this.ssh(), [
      '-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=accept-new', '-o', 'ConnectTimeout=15',
      ...(port ? ['-p', port] : []), '--', `${user}@${name}`,
    ], { timeoutMs: 30_000 });
    if (r.missing) throw new GitAuthError('failed', 'ssh is not installed on the server (or not on PATH)');
    // GitHub answers "Hi octo! You've successfully authenticated" with exit 1 (no shell); GitLab "Welcome to GitLab, @octo!".
    const ok = /successfully authenticated|welcome to gitlab|you've successfully|logged in as/i.test(r.out);
    const account = ok ? /Hi ([^!\s]+)!|Welcome to GitLab, @([^!\s]+)!|logged in as ([^.\s]+)/i.exec(r.out)?.slice(1).find(Boolean) ?? null : null;
    return { ok, account, output: r.out.trim() };
  }

  // ---- what a commit and push in a folder will use -------------------------------------------------------------------

  /**
   * Which identity and credentials a commit and push in `cwd` will use: the author as git resolves it there, the remote
   * the branch goes to, and for that remote the SSH key(s) (`ssh -G`, so ~/.ssh/config aliases count) or the HTTPS
   * credential helper. `check` also asks the forge who that is (`ssh -T`, `gh`/`glab auth status`): slower, network.
   */
  async credentials(cwd: string, o: { forge?: Forge; check?: boolean; env?: Record<string, string> } = {}): Promise<Credentials> {
    const g = async (args: string[]) => {
      const r = await this.run(this.opts.gitCommand ?? ['git'], ['-C', cwd, ...args], { timeoutMs: 15_000, env: o.env });
      return r.code === 0 ? r.out.trim() : null;
    };
    const [ident, scope, localName, localEmail] = await Promise.all([
      this.run(this.opts.gitCommand ?? ['git'], ['-C', cwd, 'var', 'GIT_AUTHOR_IDENT'], { timeoutMs: 15_000, env: o.env }),
      g(['config', '--show-scope', '--get', 'user.email']),
      g(['config', '--local', '--get', 'user.name']),
      g(['config', '--local', '--get', 'user.email']),
    ]);
    const m = /^(.*) <([^>]*)> \d+/.exec(ident.out.trim());
    const out: Credentials = {
      author: ident.code === 0 && m ? { name: m[1]!, email: m[2]!, scope: scope?.split(/\s+/)[0] ?? null } : null,
      ...(ident.code === 0 && m ? {} : { authorError: ident.out.trim().split('\n').pop() || 'git has no author name/email' }),
      localAuthor: { name: localName ?? '', email: localEmail ?? '' },
      remote: null, transport: null,
    };

    const t = await pushTarget(cwd);
    if (!t) return out;
    const url = (await g(['remote', 'get-url', '--push', t.remote])) ?? '';
    out.remote = { name: t.remote, url, branch: `${t.remote}/${t.target.replace(/^refs\/heads\//, '')}` };

    let realHost: string | null = null;
    if (/^https?:\/\//i.test(url)) {
      const u = new URL(url);
      realHost = u.host.toLowerCase();
      const helper = (await g(['config', '--get-urlmatch', 'credential.helper', url])) || null;
      const username = decodeURIComponent(u.username) || (await g(['config', '--get-urlmatch', 'credential.username', url])) || null;
      out.transport = 'https';
      out.https = { host: realHost, scheme: u.protocol === 'http:' ? 'http' : 'https', helper, helperKind: helperKind(helper), username };
    } else {
      const ssh = sshTarget(url);
      if (!ssh) { out.transport = /^[a-z]:[\\/]|^\/|^\.|^file:/i.test(url) ? 'local' : 'other'; return out; }
      const r = await this.run(this.ssh(), ['-G', ...(ssh.port ? ['-p', ssh.port] : []), '--', ssh.user ? `${ssh.user}@${ssh.host}` : ssh.host], { timeoutMs: 10_000 });
      const lines = r.code === 0 ? r.out.split(/\r?\n/) : [];
      const get = (k: string) => lines.filter((l) => l.toLowerCase().startsWith(`${k} `)).map((l) => l.slice(k.length + 1).trim());
      // only the keys that exist: without an IdentityFile, ssh -G lists every default name (id_rsa, id_ed25519, …)
      const expand = (f: string) => f.replace(/^~[\\/]\.ssh(?=[\\/])/, this.opts.sshDir).replace(/^~(?=[\\/])/, dirname(this.opts.sshDir));
      const keys = get('identityfile').filter((f) => existsSync(expand(f))).filter((f, i, a) => a.indexOf(f) === i);
      realHost = (get('hostname')[0] ?? ssh.host).toLowerCase();
      out.transport = 'ssh';
      out.ssh = {
        alias: ssh.host, hostName: realHost, user: get('user')[0] ?? ssh.user ?? '', port: get('port')[0] ?? ssh.port ?? '22', keys,
        identitiesOnly: get('identitiesonly')[0] === 'yes', sshCommand: process.env.GIT_SSH_COMMAND || (await g(['config', 'core.sshCommand'])) || null,
      };
    }

    const forge = o.forge ?? (realHost ? await this.forgeForHost(realHost.replace(/:\d+$/, '')) : null);
    if (forge && realHost) out.forge = { forge, cli: forge === 'github' ? 'gh' : 'glab', host: realHost.replace(/:\d+$/, '') };
    if (!o.check) return out;

    out.check = {};
    if (out.ssh) {
      const s = out.ssh;
      try { out.check.push = await this.testSsh(s.port && s.port !== '22' ? `${s.alias}:${s.port}` : s.alias, s.user || 'git'); }
      catch (e) { out.check.push = { ok: false, account: null, output: (e as Error).message }; }
    }
    if (out.forge) {
      const status = await this.forgeStatus(out.forge.forge);
      const mine = status.accounts.filter((a) => a.host === out.forge!.host);
      out.check.forgeAccount = (mine.find((a) => a.active) ?? mine[0])?.user ?? null;
      out.check.forgeInstalled = status.installed;
    }
    return out;
  }
}

export interface Credentials {
  /** `scope`: where user.email comes from (`local` = this repository overrides the global identity). */
  author: { name: string; email: string; scope: string | null } | null;
  authorError?: string;
  /** What this repository's own config sets ('' = not set, the global value applies). */
  localAuthor: { name: string; email: string };
  remote: { name: string; url: string; branch: string } | null;
  transport: 'ssh' | 'https' | 'local' | 'other' | null;
  ssh?: { alias: string; hostName: string; user: string; port: string; keys: string[]; identitiesOnly: boolean; sshCommand: string | null };
  /** `scheme` http: the password goes over the network unencrypted. */
  https?: { host: string; scheme: 'http' | 'https'; helper: string | null; helperKind: HelperKind; username: string | null };
  forge?: { forge: Forge; cli: 'gh' | 'glab'; host: string };
  check?: { push?: { ok: boolean; account: string | null; output: string }; forgeAccount?: string | null; forgeInstalled?: boolean };
}

type HelperKind = 'gh' | 'glab' | 'manager' | 'store' | 'cache' | 'osxkeychain' | 'other' | null;

/** What kind of credential helper a `credential.helper` value is. */
export function helperKind(helper: string | null): HelperKind {
  if (!helper) return null;
  if (/\bgh(\.exe)?["']?\s+auth\s+git-credential/i.test(helper)) return 'gh';
  if (/\bglab(\.exe)?["']?\s+auth\s+git-credential/i.test(helper)) return 'glab';
  if (/manager/i.test(helper)) return 'manager';
  if (/^store\b/.test(helper)) return 'store';
  if (/^cache\b/.test(helper)) return 'cache';
  if (/osxkeychain/.test(helper)) return 'osxkeychain';
  return 'other';
}

/** The SSH host (maybe an ~/.ssh/config alias), user and port of `git@host:path` or `ssh://user@host:port/path`. */
export function sshTarget(url: string): { host: string; user: string | null; port: string | null } | null {
  const u = /^ssh:\/\/(?:([^@/]+)@)?([^/:]+)(?::(\d+))?\//i.exec(url);
  if (u) return { host: u[2]!, user: u[1] ?? null, port: u[3] ?? null };
  if (/^[a-z]:[\\/]/i.test(url) || /^[a-z][\w+.-]*:\/\//i.test(url)) return null;
  const scp = /^(?:([^@/]+)@)?([^/:]+):(?!\/\/)/.exec(url);
  return scp ? { host: scp[2]!, user: scp[1] ?? null, port: null } : null;
}

function checkHost(host: string): void {
  if (!HOST_RE.test(host)) throw new GitAuthError('bad-input', `not a host name: ${host}`);
}

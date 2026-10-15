import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { GitAuth } from './git-auth.js';
import type { GitContext } from './git.js';
import type { Store } from './store.js';

/**
 * Each panel user's own git setup, apart from the server's. The owner uses the server's (`~/.gitconfig`, `~/.ssh`,
 * the gh/glab logins); everyone else gets `<baseDir>/<user id>/` with their own global git config, ssh keys and
 * known_hosts, and gh/glab logins, and git, gh, glab and ssh are pointed there through the environment whenever
 * Dalang (or an agent turn) works for that user. A user who set nothing up has no credentials at all, so pushes and
 * Merge Requests fail rather than going out with the owner's.
 *
 * Everything still runs as one OS user, so this decides which account is used and who authors a commit; it does not
 * keep one user's files away from another user's agent.
 */
export interface Identity { name: string; email: string }

/** Prompts that came from no panel user (old queue rows) run with no credentials, like a user who set nothing up. */
const NOBODY = '_nobody';
const ID_RE = /^[\w-]{1,64}$/;

export interface GitUsersOpts {
  baseDir: string;
  store: Store;
  ghCommand: string[];
  glabCommand: string[];
  /** The owner's (the server's own setup); built from the commands when omitted. */
  server?: GitAuth;
  /** How to start ssh (tests: a fake). */
  sshCommand?: string[];
  gitCommand?: string[];
}

export class GitUsers {
  readonly server: GitAuth;
  private auths = new Map<string, GitAuth>();

  constructor(private o: GitUsersOpts) {
    this.server = o.server ?? new GitAuth({ ghCommand: o.ghCommand, glabCommand: o.glabCommand, sshDir: join(homedir(), '.ssh') });
  }

  /** The folder of a user's setup, created with an empty git config and ssh config on first use. */
  dir(userId: string): string {
    if (!ID_RE.test(userId)) throw new Error(`bad user id: ${userId}`);
    const d = join(this.o.baseDir, userId);
    if (!existsSync(join(d, 'gitconfig'))) {
      for (const sub of ['ssh', 'gh', 'glab']) mkdirSync(join(d, sub), { recursive: true, mode: 0o700 });
      // The empty helper drops the system-wide ones (Git Credential Manager on Windows): its stored logins are the server's.
      writeFileSync(join(d, 'gitconfig'), '[credential]\n\thelper =\n', { mode: 0o600 });
      writeFileSync(join(d, 'ssh', 'config'), '', { mode: 0o600 });
    }
    return d;
  }

  /**
   * ssh with only this user's keys and known_hosts: `-F` their config, `-i` each of their keys (none: a key that does
   * not exist, so ssh never falls back to the server's ~/.ssh/id_*), no agent keys, and a new host is trusted on first use.
   */
  sshArgs(userId: string): string[] {
    const s = join(this.dir(userId), 'ssh');
    let keys: string[] = [];
    try { keys = readdirSync(s).filter((f) => f.endsWith('.pub') && existsSync(join(s, f.slice(0, -4)))).map((f) => join(s, f.slice(0, -4))); } catch { /* none */ }
    return [...(this.o.sshCommand ?? ['ssh']), '-F', join(s, 'config'), '-o', `UserKnownHostsFile=${join(s, 'known_hosts')}`,
      '-o', 'IdentitiesOnly=yes', '-o', 'StrictHostKeyChecking=accept-new',
      ...(keys.length ? keys.flatMap((k) => ['-i', k]) : ['-i', join(s, '.no-key')])];
  }

  /** The environment that points git, gh, glab and ssh at the user's own setup (no author: see `context`). */
  baseEnv(userId: string): Record<string, string> {
    const d = this.dir(userId);
    return {
      GIT_CONFIG_GLOBAL: join(d, 'gitconfig'), GH_CONFIG_DIR: join(d, 'gh'), GLAB_CONFIG_DIR: join(d, 'glab'),
      // git runs this through a shell: forward slashes and quotes keep Windows paths with spaces intact
      GIT_SSH_COMMAND: this.sshArgs(userId).map((a) => `"${a.replace(/\\/g, '/').replace(/"/g, '\\"')}"`).join(' '),
    };
  }

  /** The Settings → Git & forges backend for a user (null: the owner, i.e. the server's setup). */
  auth(userId: string | null): GitAuth {
    if (userId === null) return this.server;
    let a = this.auths.get(userId);
    if (!a) {
      a = new GitAuth({
        ghCommand: this.o.ghCommand, glabCommand: this.o.glabCommand, gitCommand: this.o.gitCommand,
        sshDir: join(this.dir(userId), 'ssh'), sshCommand: () => this.sshArgs(userId), env: () => this.baseEnv(userId),
        ghInsecureStorage: true,
      });
      this.auths.set(userId, a);
    }
    return a;
  }

  /** The user's own author (their global git config), or null while unset. */
  globalIdentity(userId: string): Identity | null {
    const file = join(this.dir(userId), 'gitconfig');
    const get = (key: string) => {
      try { return execFileSync((this.o.gitCommand ?? ['git'])[0]!, ['config', '--file', file, '--get', key], { encoding: 'utf8', windowsHide: true }).trim(); } catch { return ''; }
    };
    const name = get('user.name');
    const email = get('user.email');
    return name && email ? { name, email } : null;
  }

  private repoKey = (userId: string, projectId: string) => `git_identity:${userId}:${projectId}`;

  /** The author a user set for one project only (kept by Dalang: a repository's own config is shared by everyone). */
  repoIdentity(userId: string, projectId: string): Identity | null {
    try { return JSON.parse(this.o.store.getKv(this.repoKey(userId, projectId)) ?? 'null') as Identity | null; } catch { return null; }
  }

  setRepoIdentity(userId: string, projectId: string, id: Identity | null): void {
    this.o.store.setKv(this.repoKey(userId, projectId), JSON.stringify(id));
  }

  /** Who a user's commits in a project are by: that project's own author for them, else their global one. */
  identity(userId: string, projectId?: string): (Identity & { scope: 'local' | 'global' }) | null {
    const repo = projectId ? this.repoIdentity(userId, projectId) : null;
    if (repo) return { ...repo, scope: 'local' };
    const global = this.globalIdentity(userId);
    return global && { ...global, scope: 'global' };
  }

  /**
   * Everything git needs to work as this user in a project. Their author goes in through GIT_AUTHOR_* / GIT_COMMITTER_*,
   * which beat a repository's own user.name (often the owner's); unset, they are empty and git refuses to commit.
   */
  context(userId: string, projectId?: string): GitContext {
    const id = this.identity(userId, projectId);
    return {
      env: {
        ...this.baseEnv(userId),
        GIT_AUTHOR_NAME: id?.name ?? '', GIT_AUTHOR_EMAIL: id?.email ?? '', GIT_COMMITTER_NAME: id?.name ?? '', GIT_COMMITTER_EMAIL: id?.email ?? '',
      },
      ssh: this.sshArgs(userId),
    };
  }

  /**
   * The context for a panel user (`AuthUser.id`): undefined for the owner, who works with the server's own setup.
   */
  forUser(userId: string | null, projectId?: string): GitContext | undefined {
    return userId === null ? undefined : this.context(userId, projectId);
  }

  /**
   * The context for a queued prompt by its sender's name ('owner', a user's name, or '' when nobody is known): an
   * agent turn works with its sender's setup. A name that is no user any more gets none.
   */
  forName(name: string, projectId?: string): GitContext | undefined {
    if (name === 'owner') return undefined;
    const user = name ? this.o.store.listUsers().find((u) => u.name === name) : undefined;
    return this.context(user?.id ?? NOBODY, projectId);
  }

  /** Forget a deleted user's setup: their keys and logins go with the folder. */
  remove(userId: string): void {
    if (!ID_RE.test(userId)) return;
    this.auths.delete(userId);
    rmSync(join(this.o.baseDir, userId), { recursive: true, force: true });
  }
}

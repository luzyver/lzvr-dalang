import { execFile } from 'node:child_process';
import { GitError, gitContext, gitEnv, withLoginHint } from './git.js';

/** Where a repository is hosted, which decides the CLI that opens the Merge Request: `gh` or `glab`. */
export type Forge = 'github' | 'gitlab';
export const FORGES = ['github', 'gitlab'] as const;

/** The host and repository path (`owner/repo`, no `.git`) of a remote URL, and whether it goes over SSH. */
export function parseRemote(remoteUrl: string): { host: string; path: string; ssh: boolean } | null {
  if (/^[a-z]:[\\/]/i.test(remoteUrl)) return null; // a Windows path, not `host:path`
  const url = /^([\w+.-]+):\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/.exec(remoteUrl);
  const scp = url ? null : /^(?:[^@/]*@)?([^/:]+):(?!\/\/)(.+)$/.exec(remoteUrl);
  const [host, path, ssh] = url ? [url[2]!, url[3]!, /ssh/i.test(url[1]!)] : scp ? [scp[1]!, scp[2]!, true] : [];
  if (!host || !path) return null;
  return { host: host.toLowerCase(), path: path.replace(/\.git\/?$/, '').replace(/^\/+|\/+$/g, ''), ssh: !!ssh };
}

/** GitHub or GitLab from a host name (`github.com`, `gitlab.example.com`), or null. */
export function forgeOf(host: string): Forge | null {
  if (/(^|\.)github\b/i.test(host)) return 'github';
  if (/(^|\.)gitlab\b/i.test(host)) return 'gitlab';
  return null;
}

/**
 * The real host behind an SSH remote. `~/.ssh/config` aliases such as `github.com-work` (one key per account) are
 * common, and neither `gh` nor `glab` knows them; `ssh -G` prints what the alias stands for. The name itself if that fails.
 */
export function sshHostName(alias: string): Promise<string> {
  // The current user's ssh (their own ~/.ssh/config stand-in), so their aliases resolve too.
  const [ssh, ...pre] = gitContext.getStore()?.ssh ?? ['ssh'];
  return new Promise((resolve) => {
    execFile(ssh!, [...pre, '-G', '--', alias], { timeout: 10_000, env: gitEnv() }, (err, out) => {
      const name = err ? null : /^hostname\s+(\S+)/im.exec(String(out))?.[1];
      resolve((name ?? alias).toLowerCase());
    });
  });
}

/** Where the Merge Request goes: the forge and the repository as `host/owner/repo`, from a remote URL. */
export async function remoteRepo(remoteUrl: string, forge?: Forge): Promise<{ forge: Forge; repo: string | null } | null> {
  const r = parseRemote(remoteUrl);
  if (!r) return forge ? { forge, repo: null } : null; // e.g. a local path: let the CLI work it out
  const host = r.ssh ? await sshHostName(r.host) : r.host;
  const f = forge ?? forgeOf(host) ?? forgeOf(r.host);
  return f ? { forge: f, repo: `${host}/${r.path}` } : null;
}

export interface PullRequestOpts {
  forge: Forge;
  /** How to start `gh` / `glab` (the binary and any leading arguments). */
  command: string[];
  cwd: string;
  /** `host/owner/repo`, so the CLI need not recognise the remote itself (it does not know SSH aliases). */
  repo?: string | null;
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** The arguments that open a Merge Request (GitLab) or pull request (GitHub) without asking anything. */
export function pullRequestArgs(o: Omit<PullRequestOpts, 'command' | 'cwd'>): string[] {
  // gh takes `[HOST/]OWNER/REPO`; glab a full URL (its OWNER/REPO form would assume gitlab.com).
  const repo = !o.repo ? [] : o.forge === 'github' ? ['--repo', o.repo] : ['--repo', `https://${o.repo}`];
  return o.forge === 'github'
    ? ['pr', 'create', ...repo, '--head', o.branch, '--base', o.base, '--title', o.title, '--body', o.body]
    : ['mr', 'create', ...repo, '--source-branch', o.branch, '--target-branch', o.base, '--title', o.title, '--description', o.body, '--yes'];
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const lastUrl = (text: string) => [...text.matchAll(URL_RE)].map((m) => m[0]).pop() ?? null;

/**
 * Open the Merge Request with the server's own `gh`/`glab` login. When one is already open for the branch, its address
 * is returned (`existed`) instead of an error.
 */
export function createPullRequest(o: PullRequestOpts): Promise<{ url: string; existed: boolean }> {
  const [cmd, ...pre] = o.command;
  // Like git: the CLI must not see the gateway's secrets, must never wait for an answer on a terminal, and signs in as
  // whoever asked (gitEnv: the panel user's own gh/glab login, or the server's for the owner).
  const name = o.forge === 'github' ? 'gh' : 'glab';
  return new Promise((resolve, reject) => {
    execFile(cmd!, [...pre, ...pullRequestArgs(o)], {
      cwd: o.cwd, timeout: 120_000, maxBuffer: 8e6,
      env: { ...gitEnv(), GH_PROMPT_DISABLED: '1', NO_PROMPT: '1' },
    }, (err, out, stderr) => {
      const text = `${out}\n${stderr}`;
      if (!err) {
        const url = lastUrl(String(out)) ?? lastUrl(text);
        return url ? resolve({ url, existed: false }) : reject(new GitError(`${name} gave no address: ${text.trim().slice(-500)}`));
      }
      const existing = /already exists/i.test(text) ? lastUrl(text) : null;
      if (existing) return resolve({ url: existing, existed: true });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError(`${name} is not installed on the server (or not on PATH)`));
      reject(new GitError(withLoginHint(`${name} failed: ${(String(stderr).trim() || err.message).slice(-1500)}`)));
    });
  });
}

import { execFile } from 'node:child_process';
import { GitError } from './git.js';

/** Where a repository is hosted, which decides the CLI that opens the Merge Request: `gh` or `glab`. */
export type Forge = 'github' | 'gitlab';
export const FORGES = ['github', 'gitlab'] as const;

/** GitHub or GitLab from a remote URL (`git@github.com:o/r.git`, `https://gitlab.example.com/o/r`), or null. */
export function forgeOf(remoteUrl: string): Forge | null {
  const host = /^[\w+.-]+:\/\/(?:[^@/]*@)?([^/:]+)/.exec(remoteUrl)?.[1] ?? /^(?:[^@/]*@)?([^/:]+):/.exec(remoteUrl)?.[1] ?? '';
  if (/(^|\.)github\b/i.test(host)) return 'github';
  if (/(^|\.)gitlab\b/i.test(host)) return 'gitlab';
  return null;
}

export interface PullRequestOpts {
  forge: Forge;
  /** How to start `gh` / `glab` (the binary and any leading arguments). */
  command: string[];
  cwd: string;
  branch: string;
  base: string;
  title: string;
  body: string;
}

/** The arguments that open a Merge Request (GitLab) or pull request (GitHub) without asking anything. */
export function pullRequestArgs(o: Omit<PullRequestOpts, 'command' | 'cwd'>): string[] {
  return o.forge === 'github'
    ? ['pr', 'create', '--head', o.branch, '--base', o.base, '--title', o.title, '--body', o.body]
    : ['mr', 'create', '--source-branch', o.branch, '--target-branch', o.base, '--title', o.title, '--description', o.body, '--yes'];
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const lastUrl = (text: string) => [...text.matchAll(URL_RE)].map((m) => m[0]).pop() ?? null;

/**
 * Open the Merge Request with the server's own `gh`/`glab` login. When one is already open for the branch, its address
 * is returned (`existed`) instead of an error.
 */
export function createPullRequest(o: PullRequestOpts): Promise<{ url: string; existed: boolean }> {
  const [cmd, ...pre] = o.command;
  // Like git: the CLI must not see the gateway's secrets, and must never wait for an answer on a terminal.
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LZVR_')));
  const name = o.forge === 'github' ? 'gh' : 'glab';
  return new Promise((resolve, reject) => {
    execFile(cmd!, [...pre, ...pullRequestArgs(o)], {
      cwd: o.cwd, timeout: 120_000, maxBuffer: 8e6,
      env: { ...env, GH_PROMPT_DISABLED: '1', NO_PROMPT: '1', GIT_TERMINAL_PROMPT: '0' },
    }, (err, out, stderr) => {
      const text = `${out}\n${stderr}`;
      if (!err) {
        const url = lastUrl(String(out)) ?? lastUrl(text);
        return url ? resolve({ url, existed: false }) : reject(new GitError(`${name} gave no address: ${text.trim().slice(-500)}`));
      }
      const existing = /already exists/i.test(text) ? lastUrl(text) : null;
      if (existing) return resolve({ url: existing, existed: true });
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError(`${name} is not installed on the server (or not on PATH)`));
      reject(new GitError(`${name} failed: ${(String(stderr).trim() || err.message).slice(-1500)}`));
    });
  });
}

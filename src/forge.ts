import { execFile } from 'node:child_process';
import { type ForgeAccount, parseAuthStatus } from './git-auth.js';
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

/** Run `gh` / `glab` like createPullRequest does (no secrets, no prompts, the caller's login) and return what it printed. */
export function runForge(forge: Forge, command: string[], args: string[], cwd: string, env: Record<string, string> = {}): Promise<string> {
  const [cmd, ...pre] = command;
  const name = forge === 'github' ? 'gh' : 'glab';
  return new Promise((resolve, reject) => {
    execFile(cmd!, [...pre, ...args], {
      cwd, timeout: 60_000, maxBuffer: 16e6, env: { ...gitEnv(), GH_PROMPT_DISABLED: '1', NO_PROMPT: '1', NO_COLOR: '1', ...env },
    }, (err, out, stderr) => {
      if (!err) return resolve(String(out));
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return reject(new GitError(`${name} is not installed on the server (or not on PATH)`));
      reject(new GitError(withLoginHint(`${name} failed: ${(String(stderr).trim() || err.message).slice(-1500)}`)));
    });
  });
}

const ACCOUNT_TTL_MS = 10 * 60_000;
const accountCache = new Map<string, { env: Record<string, string>; at: number }>();

/**
 * gh uses one active account per host, but a server can be signed in to several (a personal one and a work one). For a
 * GitHub repository this picks the signed-in account that may push to it (the one named like the owner first, then the
 * active one) and returns its token as GH_TOKEN for this one call; nothing when only one account is signed in, or none
 * may push (gh then runs as usual and says why). Remembered for a while per login folder and repository.
 */
export async function githubAccountEnv(command: string[], cwd: string, host: string, repo: string): Promise<Record<string, string>> {
  const key = `${gitEnv().GH_CONFIG_DIR ?? ''}\n${command.join(' ')}\n${host}/${repo}`.toLowerCase();
  const hit = accountCache.get(key);
  if (hit && Date.now() - hit.at < ACCOUNT_TTL_MS) return hit.env;
  const quiet = (args: string[], env?: Record<string, string>) => runForge('github', command, args, cwd, env).catch(() => '');
  const accounts = parseAuthStatus(await quiet(['auth', 'status', '--hostname', host])).filter((a) => a.ok && a.host === host);
  let env: Record<string, string> = {};
  if (accounts.length > 1) {
    const owner = repo.split('/')[0]!.toLowerCase();
    const rank = (a: ForgeAccount) => (a.user.toLowerCase() === owner ? 0 : a.active ? 1 : 2);
    for (const a of [...accounts].sort((x, y) => rank(x) - rank(y))) {
      const token = (await quiet(['auth', 'token', '--hostname', host, '--user', a.user])).trim();
      if (!token) continue;
      // GH_TOKEN covers github.com (and *.ghe.com), GH_ENTERPRISE_TOKEN a GitHub Enterprise Server host.
      const withToken = { GH_TOKEN: token, GH_ENTERPRISE_TOKEN: token };
      const push = (await quiet(['api', '--hostname', host, `repos/${repo}`, '--jq', '.permissions.push'], withToken)).trim();
      if (push === 'true') { env = withToken; break; }
    }
  }
  accountCache.set(key, { env, at: Date.now() });
  return env;
}

/** The token env for `host/owner/repo` (see githubAccountEnv); nothing for GitLab or an unknown repository. */
const accountEnvFor = (forge: Forge, command: string[], cwd: string, fullRepo: string | null | undefined) => {
  const m = fullRepo ? /^([^/]+)\/(.+)$/.exec(fullRepo) : null;
  return forge === 'github' && m ? githubAccountEnv(command, cwd, m[1]!, m[2]!) : Promise.resolve({});
};

/** The parts of a pull request (GitHub) or Merge Request (GitLab) address. */
export function parsePrUrl(url: string): { forge: Forge | null; host: string; repo: string; number: number } | null {
  const gh = /^https?:\/\/([^/]+)\/([^/]+\/[^/]+)\/pull\/(\d+)/.exec(url);
  if (gh) return { forge: 'github', host: gh[1]!.toLowerCase(), repo: gh[2]!, number: Number(gh[3]) };
  const gl = /^https?:\/\/([^/]+)\/(.+?)\/-\/merge_requests\/(\d+)/.exec(url);
  if (gl) return { forge: 'gitlab', host: gl[1]!.toLowerCase(), repo: gl[2]!, number: Number(gl[3]) };
  return null;
}

export type CheckState = 'pass' | 'fail' | 'pending' | 'skipped';

/** Where a pull request / Merge Request stands: open or not, its checks, its review and what reviewers wrote. */
export interface PrStatus {
  url: string;
  title: string;
  state: 'open' | 'draft' | 'merged' | 'closed';
  /** Whether the forge would merge it now (no conflicts, nothing blocking); null when it has not worked that out yet. */
  mergeable: boolean | null;
  review: 'approved' | 'changes_requested' | 'review_required' | null;
  checks: { name: string; state: CheckState; url?: string }[];
  comments: { author: string; body: string; date: string; path?: string; line?: number; kind?: string }[];
}

const checkState = (s: string): CheckState => {
  const v = s.toLowerCase();
  if (/^(success|passed|neutral|manual)$/.test(v)) return 'pass';
  if (/^(failure|failed|error|timed_out|cancelled|canceled|action_required|startup_failure)$/.test(v)) return 'fail';
  if (/^(skipped|stale)$/.test(v)) return 'skipped';
  return 'pending';
};

const json = (text: string): any => {
  try { return JSON.parse(text); } catch { throw new GitError(`unexpected answer: ${text.trim().slice(0, 300)}`); }
};

/** Read a pull request's / Merge Request's state through the forge's CLI. */
export async function prStatus(forge: Forge, command: string[], cwd: string, url: string): Promise<PrStatus> {
  const p = parsePrUrl(url);
  if (!p) throw new GitError(`not a pull request or Merge Request address: ${url}`);
  if (forge === 'github') {
    const env = await githubAccountEnv(command, cwd, p.host, p.repo);
    const fields = 'title,url,state,isDraft,mergeable,reviewDecision,statusCheckRollup,comments,reviews';
    const [view, inline] = await Promise.all([
      runForge(forge, command, ['pr', 'view', url, '--json', fields], cwd, env).then(json),
      runForge(forge, command, ['api', '--hostname', p.host, `repos/${p.repo}/pulls/${p.number}/comments?per_page=100`], cwd, env).then(json).catch(() => []),
    ]);
    const state = view.state === 'MERGED' ? 'merged' : view.state === 'CLOSED' ? 'closed' : view.isDraft ? 'draft' : 'open';
    const review = ({ APPROVED: 'approved', CHANGES_REQUESTED: 'changes_requested', REVIEW_REQUIRED: 'review_required' } as const)[view.reviewDecision as string] ?? null;
    return {
      url: view.url ?? url, title: view.title ?? '', state, review,
      mergeable: view.mergeable === 'MERGEABLE' ? true : view.mergeable === 'CONFLICTING' ? false : null,
      checks: (view.statusCheckRollup ?? []).map((c: any) => (c.__typename === 'StatusContext'
        ? { name: c.context, state: checkState(c.state ?? ''), url: c.targetUrl || undefined }
        : { name: c.name ?? c.workflowName ?? 'check', state: checkState(c.status === 'COMPLETED' ? c.conclusion ?? '' : c.status ?? ''), url: c.detailsUrl || undefined })),
      comments: [
        ...(view.comments ?? []).map((c: any) => ({ author: c.author?.login ?? '', body: c.body ?? '', date: c.createdAt ?? '' })),
        ...(view.reviews ?? []).filter((r: any) => r.body?.trim()).map((r: any) => ({
          author: r.author?.login ?? '', body: r.body, date: r.submittedAt ?? '', kind: String(r.state ?? '').toLowerCase().replace(/_/g, ' '),
        })),
        ...(Array.isArray(inline) ? inline : []).map((c: any) => ({
          author: c.user?.login ?? '', body: c.body ?? '', date: c.created_at ?? '', path: c.path, line: c.line ?? c.original_line ?? undefined,
        })),
      ].sort((a, b) => a.date.localeCompare(b.date)),
    };
  }
  const api = (path: string) => runForge(forge, command, ['api', '--hostname', p.host, path], cwd).then(json);
  const base = `projects/${encodeURIComponent(p.repo)}/merge_requests/${p.number}`;
  const [mr, notes, approvals] = await Promise.all([
    api(base), api(`${base}/notes?sort=asc&per_page=100`).catch(() => []), api(`${base}/approvals`).catch(() => null),
  ]);
  const pipeline = mr.head_pipeline ?? mr.pipeline;
  const jobs = pipeline?.id ? await api(`projects/${encodeURIComponent(p.repo)}/pipelines/${pipeline.id}/jobs?per_page=100`).catch(() => []) : [];
  const state = mr.state === 'merged' ? 'merged' : mr.state === 'closed' ? 'closed' : mr.draft || mr.work_in_progress ? 'draft' : 'open';
  const status = String(mr.detailed_merge_status ?? mr.merge_status ?? '');
  return {
    url: mr.web_url ?? url, title: mr.title ?? '', state,
    mergeable: /^(mergeable|can_be_merged)$/.test(status) ? true : /conflict|cannot_be_merged|not_approved|ci_must_pass|discussions_not_resolved|blocked/.test(status) ? false : null,
    review: approvals ? (approvals.approved ? 'approved' : 'review_required') : null,
    checks: Array.isArray(jobs) && jobs.length
      ? jobs.map((j: any) => ({ name: `${j.stage ? `${j.stage} · ` : ''}${j.name}`, state: checkState(j.status ?? ''), url: j.web_url || undefined }))
      : pipeline ? [{ name: 'pipeline', state: checkState(pipeline.status ?? ''), url: pipeline.web_url || undefined }] : [],
    comments: (Array.isArray(notes) ? notes : []).filter((n: any) => !n.system).map((n: any) => ({
      author: n.author?.username ?? '', body: n.body ?? '', date: n.created_at ?? '',
      path: n.position?.new_path ?? undefined, line: n.position?.new_line ?? undefined,
    })),
  };
}

export type MergeMethod = 'merge' | 'squash' | 'rebase';

/** Merge a pull request / Merge Request on the forge, the way the forge itself would. */
export async function mergePr(forge: Forge, command: string[], cwd: string, url: string, method: MergeMethod): Promise<void> {
  const p = parsePrUrl(url);
  if (!p) throw new GitError(`not a pull request or Merge Request address: ${url}`);
  if (forge === 'github') {
    await runForge(forge, command, ['pr', 'merge', url, `--${method}`], cwd, await githubAccountEnv(command, cwd, p.host, p.repo));
    return;
  }
  await runForge(forge, command, ['mr', 'merge', String(p.number), '--repo', `https://${p.host}/${p.repo}`, '--yes',
    ...(method === 'squash' ? ['--squash'] : method === 'rebase' ? ['--rebase'] : [])], cwd);
}

const URL_RE = /https?:\/\/[^\s"'<>]+/g;
const lastUrl = (text: string) => [...text.matchAll(URL_RE)].map((m) => m[0]).pop() ?? null;

/**
 * Open the Merge Request with the server's own `gh`/`glab` login (on GitHub, the signed-in account that may push to the
 * repository). When one is already open for the branch, its address is returned (`existed`) instead of an error.
 */
export async function createPullRequest(o: PullRequestOpts): Promise<{ url: string; existed: boolean }> {
  const [cmd, ...pre] = o.command;
  // Like git: the CLI must not see the gateway's secrets, must never wait for an answer on a terminal, and signs in as
  // whoever asked (gitEnv: the panel user's own gh/glab login, or the server's for the owner).
  const name = o.forge === 'github' ? 'gh' : 'glab';
  const account = await accountEnvFor(o.forge, o.command, o.cwd, o.repo);
  return new Promise((resolve, reject) => {
    execFile(cmd!, [...pre, ...pullRequestArgs(o)], {
      cwd: o.cwd, timeout: 120_000, maxBuffer: 8e6,
      env: { ...gitEnv(), GH_PROMPT_DISABLED: '1', NO_PROMPT: '1', ...account },
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

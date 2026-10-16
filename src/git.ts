import { AsyncLocalStorage } from 'node:async_hooks';
import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { capDiff, wholeFile } from './diff.js';

export class GitError extends Error {}

/**
 * Whose git setup the commands of the current request use: the environment that points git, gh, glab and ssh at a
 * panel user's own config, keys and logins, and the `ssh` command that goes with it. Unset: the server's own (the owner).
 */
export interface GitContext { env: Record<string, string>; ssh: string[] }
export const gitContext = new AsyncLocalStorage<GitContext>();

/** The environment for a git/gh/glab child process: no gateway secrets, never a prompt, and the current user's setup. */
export function gitEnv(): Record<string, string> {
  const env = Object.fromEntries(Object.entries(process.env).filter((e): e is [string, string] => !e[0].startsWith('LZVR_') && e[1] !== undefined));
  return { ...env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never', ...gitContext.getStore()?.env };
}

const LOGIN_FAILED = /could not read (Username|Password)|Authentication failed|Permission denied \(publickey|terminal prompts disabled|Host key verification failed|auth login|HTTP 401|401 Unauthorized|not logged in/i;

/**
 * A failure because a panel user (not the owner) has no login for that server yet says where to add one: they never
 * fall back to the server's credentials.
 */
export function withLoginHint(message: string): string {
  return gitContext.getStore() && LOGIN_FAILED.test(message)
    ? `${message}\n\nSign in for this server under Settings → Git & forges (your own login: pushes never use the server's).`
    : message;
}

/**
 * Run git in `cwd` without a shell. Repository hooks may run (commit, merge), so like the agent they must not see the
 * gateway's own secrets.
 */
export function git(cwd: string, args: string[], timeoutMs = 60_000, env?: Record<string, string>): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: { ...gitEnv(), ...env }, timeout: timeoutMs, maxBuffer: 32e6 }, (err, out, stderr) => {
      if (err) reject(new GitError(withLoginHint((String(stderr).trim() || err.message).slice(-2000))));
      else resolve(out);
    });
  });
}

export async function isRepo(cwd: string): Promise<boolean> {
  try { return (await git(cwd, ['rev-parse', '--is-inside-work-tree'])).trim() === 'true'; } catch { return false; }
}

/** The checked-out branch, or null on a detached HEAD. */
export async function currentBranch(cwd: string): Promise<string | null> {
  try { return (await git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])).trim() || null; } catch { return null; }
}

/**
 * The branch Merge Requests usually go into: the remote's default branch (`origin/HEAD`), else `main` or `master`.
 * `ref` is what to compare against: the remote-tracking branch when there is one, so a stale local copy does not count.
 */
export async function defaultBranch(cwd: string): Promise<{ name: string; ref: string } | null> {
  const { main: remote } = await remotesOf(cwd);
  const exists = (ref: string) => git(cwd, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);
  if (remote) {
    const head = (await git(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`]).catch(() => '')).trim();
    if (head.startsWith(`${remote}/`)) return { name: head.slice(remote.length + 1), ref: head };
  }
  for (const name of ['main', 'master']) {
    if (remote && (await exists(`refs/remotes/${remote}/${name}`))) return { name, ref: `${remote}/${name}` };
    if (await exists(`refs/heads/${name}`)) return { name, ref: name };
  }
  return null;
}

/** A machine without a git identity cannot commit at all; fall back to one that says where the commit came from. */
async function identity(cwd: string): Promise<string[]> {
  const email = await git(cwd, ['config', 'user.email']).catch(() => '');
  return email.trim() ? [] : ['-c', 'user.name=Dalang', '-c', 'user.email=dalang@localhost'];
}

/** A new branch `branch` from the repo's HEAD, checked out at `dir`. Returns the branch it started from (null if detached). */
export async function addWorktree(repo: string, dir: string, branch: string): Promise<string | null> {
  const base = await currentBranch(repo);
  mkdirSync(dirname(dir), { recursive: true });
  await git(repo, ['worktree', 'add', '-b', branch, dir, 'HEAD']);
  return base;
}

/**
 * Remove a chat's worktree. Its branch goes too, locally and on the remote it was pushed to, but only when everything on
 * it is in what the project folder has checked out; an unmerged branch stays in both places for a human to look at.
 */
export async function removeWorktree(repo: string, dir: string, branch: string | null): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {
    rmSync(dir, { recursive: true, force: true }); // repo gone or already pruned: at least free the folder
    return git(repo, ['worktree', 'prune']).catch(() => '');
  });
  if (!branch) return;
  // Not `branch -d`: once pushed, the branch counts as merged into its own upstream, which says nothing about main.
  const merged = await git(repo, ['merge-base', '--is-ancestor', branch, 'HEAD']).then(() => true, () => false);
  if (!merged) return;
  const cfg = (key: string) => git(repo, ['config', `branch.${branch}.${key}`]).then((v) => v.trim(), () => '');
  const [remote, ref, tip] = await Promise.all([cfg('remote'), cfg('merge'), git(repo, ['rev-parse', branch]).then((v) => v.trim(), () => '')]);
  await git(repo, ['branch', '-D', branch]).catch(() => ''); // its upstream settings go with it, hence read first
  // The lease deletes the remote branch only while it still points where ours did: if someone pushed more to it, it stays.
  if (remote && ref && tip) {
    await git(repo, ['push', `--force-with-lease=${ref}:${tip}`, remote, `:${ref}`], 120_000)
      .catch((e: Error) => console.warn(`kept ${remote}/${ref.replace(/^refs\/heads\//, '')}: ${e.message}`));
  }
}

export interface GitFile {
  path: string;
  /** Two-letter `git status --porcelain` code: index then worktree (`??` untracked). */
  status: string;
  /** The old path of a rename. */
  from?: string;
}

export interface GitStatus {
  repo: true;
  branch: string | null;
  files: GitFile[];
  /** Latest commit on HEAD; `pushed` once its upstream has it. */
  head: { hash: string; subject: string; body: string; pushed: boolean; merge: boolean } | null;
  /** The branch's upstream and how far apart they are, as of the last fetch. Null when it has none (never pushed). */
  upstream: { name: string; ahead: number; behind: number } | null;
  /** Whether there is a remote to push to at all. */
  hasRemote: boolean;
  /** A merge, rebase, cherry-pick or revert that stopped on conflicts and waits to be continued or aborted. */
  operation: Operation | null;
}

export type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert';

/** The two-letter `git status` codes of a file with unresolved conflicts. */
const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
export const isConflict = (f: GitFile) => CONFLICT.has(f.status);

/** What git is in the middle of here, from the files it keeps while an operation waits (per worktree). */
export async function operation(cwd: string): Promise<Operation | null> {
  const names = ['rebase-merge', 'rebase-apply', 'MERGE_HEAD', 'CHERRY_PICK_HEAD', 'REVERT_HEAD'] as const;
  const out = await git(cwd, ['rev-parse', ...names.flatMap((n) => ['--git-path', n])]).catch(() => '');
  const has = out.split('\n').map((p) => p.trim()).filter(Boolean).map((p) => existsSync(resolve(cwd, p)));
  if (has[0] || has[1]) return 'rebase';
  if (has[2]) return 'merge';
  if (has[3]) return 'cherry-pick';
  if (has[4]) return 'revert';
  return null;
}

/** The checked-out branch's upstream (`origin/main`) and the commits each side has that the other lacks. */
export async function upstreamOf(cwd: string, rev = 'HEAD'): Promise<{ name: string; ahead: number; behind: number } | null> {
  const name = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
  if (!name) return null;
  const counts = (await git(cwd, ['rev-list', '--left-right', '--count', `${rev}...@{u}`]).catch(() => '0\t0')).trim().split(/\s+/);
  return { name, ahead: Number(counts[0]) || 0, behind: Number(counts[1]) || 0 };
}

/** Whether `rev` is already on the branch's upstream, so rewriting it would rewrite what others may have. */
async function onUpstream(cwd: string, rev: string): Promise<boolean> {
  return git(cwd, ['merge-base', '--is-ancestor', rev, '@{u}']).then(() => true, () => false);
}

export async function status(cwd: string): Promise<GitStatus | { repo: false }> {
  if (!(await isRepo(cwd))) return { repo: false };
  // -z: paths come raw (no quoting), NUL-separated; a rename is followed by its old path as a separate entry.
  const raw = (await git(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])).split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const e = raw[i]!;
    if (e.length < 4) continue;
    const f: GitFile = { status: e.slice(0, 2), path: e.slice(3) };
    if (/[RC]/.test(f.status[0]!)) f.from = raw[++i];
    files.push(f);
  }
  const log = await git(cwd, ['log', '-1', '--format=%h%x00%p%x00%s%x00%b']).catch(() => '');
  const [hash, parents = '', subject = '', body = ''] = log.replace(/\n$/, '').split('\0');
  const [branch, upstream, remotes, op] = await Promise.all([currentBranch(cwd), upstreamOf(cwd), remotesOf(cwd), operation(cwd)]);
  return {
    repo: true, branch, files, upstream, hasRemote: !!remotes.main, operation: op,
    head: hash ? { hash, subject, body: body.trim(), pushed: !!upstream && (await onUpstream(cwd, 'HEAD')), merge: parents.trim().includes(' ') } : null,
  };
}

/** Unified diff of one file against HEAD (untracked: the whole file as added). */
export async function fileDiff(cwd: string, file: GitFile): Promise<string> {
  if (file.status === '??') { // git has nothing to compare it with (`diff --no-index /dev/null` fails on Windows)
    const full = join(cwd, file.path);
    if (statSync(full).size > 1e6) return '… file too large to show';
    const content = readFileSync(full);
    return content.includes(0) ? '' : wholeFile(content.toString('utf8'), '+'); // binary: no text diff
  }
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  const paths = file.from ? [file.from, file.path] : [file.path];
  return capDiff(hunksOnly(await git(cwd, ['diff', '--no-color', head ? 'HEAD' : '--cached', '--', ...paths])));
}

/** Drop the `diff --git` / `index` / `---` / `+++` header lines: the panel names the file itself. */
const hunksOnly = (out: string) => {
  const at = out.indexOf('\n@@');
  return at === -1 ? (out.startsWith('@@') ? out : '') : out.slice(at + 1).replace(/\n$/, '');
};

/**
 * A short fingerprint of a diff as `fileDiff` gives it (FNV-1a over its UTF-16 code units, as hex). The panel sends the
 * one of the diff it picked hunks in, so a file that changed since is refused instead of staging other hunks.
 * public/js/git.js computes the same.
 */
export function diffFingerprint(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** A unified diff's header (up to the first hunk) and its hunks, each with its `@@` line. */
export function splitHunks(diff: string): { header: string; hunks: string[] } {
  const parts = diff.split(/^(?=@@ )/m);
  const header = parts[0]!.startsWith('@@ ') ? '' : parts.shift()!;
  return { header, hunks: parts };
}

/** A temporary file for git to read (a patch, a list of paths); removed by `done`. */
function tempFile(content: string | Buffer): { path: string; done: () => void } {
  const path = join(tmpdir(), `dalang-${randomBytes(8).toString('hex')}`);
  writeFileSync(path, content);
  return { path, done: () => rmSync(path, { force: true }) };
}

/**
 * Stage only some hunks of a file: its index entry goes back to HEAD, then the chosen hunks of the diff against that
 * are applied to the index alone. The working copy keeps every change. `hunks` count from 0, in the order the diff
 * against HEAD lists them (which is what `fileDiff` shows).
 */
export async function stageHunks(cwd: string, path: string, hunks: number[]): Promise<void> {
  await git(cwd, ['reset', '-q', '--', path]);
  const { header, hunks: all } = splitHunks(await git(cwd, ['diff', '--no-color', '--no-ext-diff', '--', path]));
  const picked = [...new Set(hunks)].sort((a, b) => a - b).map((i) => all[i]).filter((h): h is string => !!h);
  if (!picked.length) return;
  const patch = tempFile(header + picked.join(''));
  try { await git(cwd, ['apply', '--cached', '--recount', '--whitespace=nowarn', patch.path]); } finally { patch.done(); }
}

export interface CommitOpts {
  /** Replace the last commit (its message and, with the staged files, its content) instead of adding one. */
  amend?: boolean;
  /** Files of which only some hunks go in: path → hunk indexes (see stageHunks). */
  hunks?: Record<string, number[]>;
}

/**
 * Stage the given paths (`null`: every change) and commit them. Returns the new commit's short hash, and whether it
 * replaced a commit the remote already had (an amend that must be force-pushed). Amending a commit that is already on
 * the default branch's remote is refused: that would rewrite history others build on.
 */
export async function commit(cwd: string, message: string, paths: string[] | null, opts: CommitOpts = {}): Promise<{ commit: string; rewrote: boolean }> {
  if (await operation(cwd)) throw new GitError('finish or abort the merge or rebase in progress first');
  const rewrote = opts.amend ? await mayRewrite(cwd, 'amend') : false;
  // `git commit` takes the whole index: with named paths, whatever was staged before (by the agent, a terminal, a
  // failed commit) would go in too. So the index starts from HEAD, and only what was picked is staged on top.
  if (paths !== null) {
    const left = ((await status(cwd)) as GitStatus).files.filter(isConflict).map((f) => f.path);
    if (left.length) throw new GitError(`resolve these conflicts first: ${left.join(', ')}`);
    const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
    await git(cwd, head ? ['reset', '-q'] : ['rm', '-r', '-q', '--cached', '--ignore-unmatch', '--', '.']);
  }
  const hunked = Object.keys(opts.hunks ?? {});
  for (const p of hunked) await stageHunks(cwd, p, opts.hunks![p]!);
  const all = paths ?? (hunked.length ? ((await status(cwd)) as GitStatus).files.map((f) => f.path) : ['.']);
  const whole = all.filter((p) => !hunked.includes(p));
  if (whole.length) await git(cwd, ['add', '-A', '--', ...whole]);
  await git(cwd, [...(await identity(cwd)), 'commit', ...(opts.amend ? ['--amend'] : []), '-m', message]);
  return { commit: (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim(), rewrote };
}

/**
 * Whether the last commit may be rewritten (amended or undone): not on a detached HEAD or a merge commit, and, once it
 * is on the remote, never on the default branch. Returns whether it was pushed (then the rewrite has to be force-pushed).
 */
async function mayRewrite(cwd: string, what: 'amend' | 'undo'): Promise<boolean> {
  const branch = await currentBranch(cwd);
  if (!branch) throw new GitError(`detached HEAD: check out a branch to ${what} its last commit`);
  if (!(await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false))) throw new GitError('there is no commit yet');
  const parents = (await git(cwd, ['log', '-1', '--format=%p'])).trim().split(' ').filter(Boolean);
  if (what === 'undo' && !parents.length) throw new GitError('the first commit cannot be undone');
  if (parents.length > 1) throw new GitError(`the last commit is a merge: it is not ${what === 'amend' ? 'amended' : 'undone'} from here`);
  const pushed = await onUpstream(cwd, 'HEAD');
  if (pushed && branch === (await defaultBranch(cwd))?.name) {
    throw new GitError(`the last commit is already on the remote's ${branch}: rewriting the default branch is not done from here`);
  }
  return pushed;
}

/**
 * Take back the last commit: its changes become uncommitted again (`reset --soft`). One that was pushed is only taken
 * back with `force`, and then the remote branch is moved back too (with a lease, so commits pushed since stay safe).
 */
export async function undoCommit(cwd: string, force = false): Promise<{ subject: string; pushed: boolean; push: PushResult | null }> {
  if (await operation(cwd)) throw new GitError('finish or abort the merge or rebase in progress first');
  const pushed = await mayRewrite(cwd, 'undo');
  if (pushed && !force) throw new PushedError('the last commit is already on the remote: undoing it rewrites the remote branch too');
  const subject = (await git(cwd, ['log', '-1', '--format=%s'])).trim();
  await git(cwd, ['reset', '-q', '--soft', 'HEAD~1']);
  return { subject, pushed, push: pushed ? await push(cwd, { force: true }) : null };
}

/** A rewrite of a commit the remote already has, refused until the caller says to go ahead. */
export class PushedError extends GitError {}

export interface PushResult {
  /** Where it went (`origin/main`), or null when the repo has no remote or HEAD is detached. */
  pushed: string | null;
  /** Set when the push itself failed; the commit or merge before it still stands. */
  error?: string;
}

/**
 * Push the checked-out branch: to its upstream when it has one, otherwise to `origin` (or the only remote) under the
 * same name, which then becomes its upstream. Never throws: a failed push is reported, the local commit stays.
 * `force` replaces the remote branch (after an amend or undo), but only while it is where we last saw it: a lease on
 * the remote-tracking branch, so commits someone else pushed in the meantime are never thrown away.
 */
export async function push(cwd: string, opts: { force?: boolean } = {}): Promise<PushResult> {
  const t = await pushTarget(cwd);
  if (!t) return { pushed: null };
  const { branch, remote, target, upstream } = t;
  const seen = opts.force
    ? (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${remote}/${target.replace(/^refs\/heads\//, '')}`]).catch(() => '')).trim()
    : '';
  try {
    await git(cwd, ['push', ...(upstream ? [] : ['-u']), ...(seen ? [`--force-with-lease=${target}:${seen}`] : []), remote, `${branch}:${target}`], 120_000);
    return { pushed: `${remote}/${target.replace(/^refs\/heads\//, '')}` };
  } catch (e) {
    return { pushed: null, error: (e as Error).message };
  }
}

/** Where `push` sends the checked-out branch: its upstream, else the same name on `origin` (or the only remote). */
export async function pushTarget(cwd: string): Promise<{ branch: string; remote: string; target: string; upstream: boolean } | null> {
  const branch = await currentBranch(cwd);
  const { main } = await remotesOf(cwd);
  if (!branch || !main) return null;
  const cfg = (key: string) => git(cwd, ['config', `branch.${branch}.${key}`]).then((v) => v.trim(), () => '');
  const [upstreamRemote, upstreamRef] = await Promise.all([cfg('remote'), cfg('merge')]);
  return { branch, remote: upstreamRemote || main, target: upstreamRef || `refs/heads/${branch}`, upstream: !!upstreamRef };
}

/** The remotes, and the one to use by default: `origin`, else the first. */
async function remotesOf(cwd: string): Promise<{ all: string[]; main: string | undefined }> {
  const all = (await git(cwd, ['remote']).catch(() => '')).split('\n').map((r) => r.trim()).filter(Boolean);
  return { all, main: all.includes('origin') ? 'origin' : all[0] };
}

/**
 * Bring the checked-out branch up to date from its upstream (or the same name on `origin`), fast-forward only: a branch
 * that has gone its own way is left alone rather than merged. Uncommitted changes stay unless the pull would overwrite
 * them, in which case git refuses. Returns where it pulled from and how many commits came in.
 */
export async function pull(cwd: string): Promise<{ from: string; commits: number }> {
  const branch = await currentBranch(cwd);
  if (!branch) throw new GitError('detached HEAD: check out a branch first');
  const { main } = await remotesOf(cwd);
  const cfg = (key: string) => git(cwd, ['config', `branch.${branch}.${key}`]).then((v) => v.trim(), () => '');
  const [upstreamRemote, upstreamRef] = await Promise.all([cfg('remote'), cfg('merge')]);
  const remote = upstreamRemote || main;
  if (!remote) throw new GitError('the repository has no remote to pull from');
  const ref = upstreamRef || `refs/heads/${branch}`;
  const from = `${remote}/${ref.replace(/^refs\/heads\//, '')}`;
  const before = (await git(cwd, ['rev-parse', 'HEAD']).catch(() => '')).trim();
  try {
    await git(cwd, ['pull', '--ff-only', '--no-rebase', remote, ref], 120_000);
  } catch (e) {
    throw new GitError(`pull from ${from} failed: ${(e as Error).message}`);
  }
  const commits = before ? Number((await git(cwd, ['rev-list', '--count', `${before}..HEAD`])).trim()) || 0 : 0;
  return { from, commits };
}

/** Refresh what the remote has (every branch of the default remote). Returns that remote, or null without one. */
export async function fetchRemote(cwd: string): Promise<string | null> {
  const { main } = await remotesOf(cwd);
  if (!main) return null;
  try {
    await git(cwd, ['fetch', '--prune', main], 120_000);
  } catch (e) {
    throw new GitError(`fetch from ${main} failed: ${(e as Error).message}`);
  }
  return main;
}

/** The remote-tracking branch for `name` on the default remote (`origin/main`), when there is one. */
export async function remoteBranch(cwd: string, name: string): Promise<string | null> {
  const { main } = await remotesOf(cwd);
  if (!main) return null;
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/remotes/${main}/${name}`]).then(() => true, () => false)) ? `${main}/${name}` : null;
}

/** Where the checked-out branch syncs from: its upstream, else the same name on the default remote. Null if neither. */
export async function upstreamRef(cwd: string): Promise<string | null> {
  const u = (await git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']).catch(() => '')).trim();
  if (u) return u;
  const branch = await currentBranch(cwd);
  return branch ? remoteBranch(cwd, branch) : null;
}

/** How an operation that may stop on conflicts ended: done (or nothing to do), or waiting with conflicted files. */
export interface OpResult {
  result: 'up-to-date' | 'done' | 'conflicts';
  operation: Operation | null;
  conflicts: string[];
}

const conflicted = async (cwd: string) => ((await status(cwd)) as GitStatus).files.filter(isConflict).map((f) => f.path);

/**
 * Run something that may stop on conflicts (merge, rebase, cherry-pick, revert, stash apply). Stopping there is not a
 * failure: it is reported with the conflicted files, for the panel (or the agent) to resolve. Anything else throws.
 */
async function mayConflict(cwd: string, run: () => Promise<unknown>): Promise<OpResult> {
  try {
    await run();
  } catch (e) {
    const files = await conflicted(cwd);
    if (!files.length) throw e;
    return { result: 'conflicts', operation: await operation(cwd), conflicts: files };
  }
  // Done, but changes put aside for it (--autostash) may have clashed coming back: conflicts with nothing to continue.
  const [op, files] = await Promise.all([operation(cwd), conflicted(cwd)]);
  return op || files.length ? { result: 'conflicts', operation: op, conflicts: files } : { result: 'done', operation: null, conflicts: [] };
}

/** A ref given by the caller, as a commit: refused when it could be read as an option or names nothing. */
async function checkRef(cwd: string, ref: string): Promise<string> {
  const hash = ref.startsWith('-') ? '' : (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')).trim();
  if (!hash) throw new GitError(`no such branch, tag or commit: ${ref}`);
  return hash;
}

/**
 * Bring `onto` into the checked-out branch: merged (a merge commit when they went apart) or rebased onto it (the
 * branch's own commits replayed on top). Uncommitted changes are stashed for the time and put back after.
 */
export async function integrate(cwd: string, onto: string, mode: 'merge' | 'rebase'): Promise<OpResult> {
  if (await operation(cwd)) throw new GitError('finish or abort the operation in progress first');
  if (!(await currentBranch(cwd))) throw new GitError('detached HEAD: check out a branch first');
  await checkRef(cwd, onto);
  if (await git(cwd, ['merge-base', '--is-ancestor', onto, 'HEAD']).then(() => true, () => false)) {
    return { result: 'up-to-date', operation: null, conflicts: [] };
  }
  const id = await identity(cwd);
  return mayConflict(cwd, () => (mode === 'merge'
    ? git(cwd, [...id, 'merge', '--no-edit', '--autostash', onto], 120_000)
    : git(cwd, [...id, 'rebase', '--autostash', onto], 120_000, { GIT_EDITOR: 'true' })));
}

/** In a rebase, "ours" is the branch being rebased onto: what the chat's branch had is "theirs". */
const sides = (op: Operation | null) => (op === 'rebase' ? { mine: '--theirs', theirs: '--ours' } : { mine: '--ours', theirs: '--theirs' });

/**
 * Settle one conflicted file: keep this branch's side (`mine`), take the incoming one (`theirs`), or mark it resolved
 * after editing it by hand, which is refused while conflict markers are left in it.
 */
export async function resolveConflict(cwd: string, path: string, take: 'mine' | 'theirs' | 'resolved'): Promise<void> {
  const file = ((await status(cwd)) as GitStatus).files.find((f) => f.path === path);
  if (!file || !isConflict(file)) throw new GitError(`not a conflicted file: ${path}`);
  if (take === 'resolved') {
    const full = join(cwd, path);
    if (existsSync(full) && /^(<{7}|>{7})( |$)/m.test(readFileSync(full, 'utf8'))) throw new GitError(`${path} still has conflict markers (<<<<<<< … >>>>>>>)`);
  } else {
    const side = sides(await operation(cwd))[take];
    // A side that deleted the file has nothing to check out: taking that side deletes it.
    await git(cwd, ['checkout', side, '--', path]).catch(() => git(cwd, ['rm', '-q', '--cached', '--ignore-unmatch', '--', path]).then(() => rmSync(join(cwd, path), { force: true })));
  }
  await git(cwd, ['add', '-A', '--', path]);
}

/** Go on with the operation once every conflict is resolved. It may stop again (a rebase on its next commit). */
export async function continueOperation(cwd: string): Promise<OpResult> {
  const op = await operation(cwd);
  if (!op) throw new GitError('there is no merge, rebase, cherry-pick or revert in progress');
  const left = await conflicted(cwd);
  if (left.length) throw new GitError(`resolve these first: ${left.join(', ')}`);
  const id = await identity(cwd);
  const noEditor = { GIT_EDITOR: 'true' };
  return mayConflict(cwd, async () => {
    if (op === 'merge') { await git(cwd, [...id, 'commit', '--no-edit'], 60_000, noEditor); return; }
    try {
      await git(cwd, [...id, op, '--continue'], 120_000, noEditor);
    } catch (e) {
      // The resolution left nothing of this commit: drop it and go on with the next one.
      if (!/nothing to commit|no changes|empty/i.test((e as Error).message)) throw e;
      await git(cwd, [...id, op, '--skip'], 120_000, noEditor);
    }
  });
}

/** Give up the operation in progress: everything goes back to how it was before it started. */
export async function abortOperation(cwd: string): Promise<Operation> {
  const op = await operation(cwd);
  if (!op) throw new GitError('there is no merge, rebase, cherry-pick or revert in progress');
  await git(cwd, [op, '--abort'], 120_000);
  return op;
}

/** Apply the change one commit made onto the checked-out branch (`cherry-pick`), or a commit undoing it (`revert`). */
export async function applyCommit(cwd: string, ref: string, how: 'cherry-pick' | 'revert'): Promise<OpResult & { commit?: string }> {
  if (await operation(cwd)) throw new GitError('finish or abort the operation in progress first');
  const hash = await commitOf(cwd, ref);
  if (!hash) throw new GitError(`no such commit: ${ref}`);
  const merge = (await git(cwd, ['log', '-1', '--format=%p', hash])).trim().includes(' ');
  const r = await mayConflict(cwd, async () => git(cwd, [...(await identity(cwd)), how, ...(how === 'revert' ? ['--no-edit'] : []),
    ...(merge ? ['-m', '1'] : []), hash], 120_000, { GIT_EDITOR: 'true' }));
  return r.result === 'done' ? { ...r, commit: (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim() } : r;
}

export interface Stash { index: number; message: string; date: number; files: GitFile[] }

/** The stashes, newest first. They belong to the repository, so every worktree of it sees the same list. */
export async function stashes(cwd: string): Promise<Stash[]> {
  const out = await git(cwd, ['stash', 'list', '-z', '--format=%gd%x1f%gs%x1f%ct']).catch(() => '');
  const list = out.split('\0').filter((r) => r.trim()).map((r) => {
    const [ref = '', message = '', date = '0'] = r.split('\x1f');
    return { index: Number(/\{(\d+)\}/.exec(ref)?.[1] ?? -1), message, date: Number(date), files: [] as GitFile[] };
  }).filter((s) => s.index >= 0);
  for (const s of list) s.files = await stashFiles(cwd, s.index);
  return list;
}

/** What a stash holds: its tracked changes, and the untracked files it took along (as added). */
async function stashFiles(cwd: string, index: number): Promise<GitFile[]> {
  const ref = `stash@{${index}}`;
  const parse = (out: string) => {
    const raw = out.split('\0');
    const files: GitFile[] = [];
    for (let i = 0; i < raw.length; i++) {
      const st = raw[i]!;
      if (!st) continue;
      if (/^[RC]/.test(st)) { files.push({ status: st[0]!, from: raw[i + 1], path: raw[i + 2]! }); i += 2; }
      else files.push({ status: st[0]!, path: raw[++i]! });
    }
    return files;
  };
  const tracked = parse(await git(cwd, ['diff', '--name-status', '-z', '-M', `${ref}^1`, ref]).catch(() => ''));
  const untracked = (await git(cwd, ['ls-tree', '-r', '-z', '--name-only', `${ref}^3`]).catch(() => ''))
    .split('\0').filter(Boolean).map((path) => ({ status: 'A', path }));
  return [...tracked, ...untracked];
}

async function checkStash(cwd: string, index: number): Promise<string> {
  const ref = `stash@{${index}}`;
  if (!Number.isInteger(index) || index < 0 || !(await git(cwd, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false))) {
    throw new GitError(`no such stash: ${index}`);
  }
  return ref;
}

/** Put every uncommitted change (new files too) aside in a stash, leaving the folder as HEAD has it. */
export async function stashPush(cwd: string, message: string): Promise<void> {
  if (await operation(cwd)) throw new GitError('finish or abort the operation in progress first');
  if (!((await status(cwd)) as GitStatus).files.length) throw new GitError('there are no changes to stash');
  await git(cwd, [...(await identity(cwd)), 'stash', 'push', '--include-untracked', ...(message ? ['-m', message] : [])]);
}

/** Bring a stash's changes back; `pop` also drops it, unless they clashed (then it stays, and the conflicts are reported). */
export async function stashApply(cwd: string, index: number, pop: boolean): Promise<OpResult> {
  const ref = await checkStash(cwd, index);
  return mayConflict(cwd, () => git(cwd, ['stash', pop ? 'pop' : 'apply', ref]));
}

export async function stashDrop(cwd: string, index: number): Promise<void> {
  await git(cwd, ['stash', 'drop', await checkStash(cwd, index)]);
}

/** One file's diff in a stash against the commit it was made on (an untracked one: the whole file as added). */
export async function stashFileDiff(cwd: string, index: number, path: string): Promise<string> {
  const ref = await checkStash(cwd, index);
  const file = (await stashFiles(cwd, index)).find((f) => f.path === path);
  if (!file) throw new GitError(`not in this stash: ${path}`);
  const untracked = await git(cwd, ['cat-file', '-e', `${ref}^3:${path}`]).then(() => true, () => false);
  if (untracked) return capDiff(wholeFile(await git(cwd, ['show', `${ref}^3:${path}`]), '+'));
  return capDiff(hunksOnly(await git(cwd, ['diff', '--no-color', '-M', `${ref}^1`, ref, '--', ...(file.from ? [file.from, path] : [path])])));
}

export interface Blame {
  /** The commit behind each line of the file, in order (the zero hash for lines not committed yet). */
  lines: string[];
  commits: Record<string, { author: string; date: number; subject: string }>;
}

export const UNCOMMITTED = '0'.repeat(40);

/** Who last changed each line of a file, as the working copy has it (uncommitted lines included). */
export async function blame(cwd: string, path: string): Promise<Blame> {
  const out = await git(cwd, ['blame', '--porcelain', '--', path], 60_000);
  const lines: string[] = [];
  const commits: Blame['commits'] = {};
  let cur = '';
  for (const l of out.split('\n')) {
    const head = /^([0-9a-f]{40}) \d+ \d+/.exec(l);
    if (head) { cur = head[1]!; commits[cur] ??= { author: '', date: 0, subject: '' }; continue; }
    if (l.startsWith('\t')) { lines.push(cur); continue; }
    const c = commits[cur];
    if (!c) continue;
    if (l.startsWith('author ')) c.author = l.slice(7);
    else if (l.startsWith('author-time ')) c.date = Number(l.slice(12));
    else if (l.startsWith('summary ')) c.subject = l.slice(8);
  }
  return { lines, commits };
}

const LOG_FORMAT = '--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s';
const parseLog = (out: string): LogCommit[] => out.split('\0').filter((r) => r.trim()).map((r) => {
  const [hash = '', parents = '', author = '', date = '0', refs = '', subject = ''] = r.replace(/^\n/, '').split('\x1f');
  return { hash, parents: parents.split(' ').filter(Boolean), author, date: Number(date), refs: refs ? refs.split(', ') : [], subject };
});

/** The commits that changed one file, newest first, following it through renames. */
export async function fileLog(cwd: string, path: string, limit = 100): Promise<LogCommit[]> {
  return parseLog(await git(cwd, ['log', '--follow', '-z', `-n${limit}`, LOG_FORMAT, '--', path]).catch(() => ''));
}

/** Tags, newest first, with the commit each points at. */
export async function tags(cwd: string): Promise<{ name: string; hash: string }[]> {
  const out = await git(cwd, ['for-each-ref', '--sort=-creatordate', '--format=%(refname:short)%1f%(objectname)%1f%(*objectname)', 'refs/tags']).catch(() => '');
  return out.split('\n').filter(Boolean).map((l) => {
    const [name = '', obj = '', peeled = ''] = l.split('\x1f');
    return { name, hash: peeled || obj };
  });
}

/**
 * Tag commit `ref` (annotated when there is a message), and push the tag when asked. Returns how the push went, or
 * null when it was not asked for.
 */
export async function createTag(cwd: string, name: string, ref: string, opts: { message?: string; push?: boolean } = {}): Promise<PushResult | null> {
  const ok = !name.startsWith('-') && (await git(cwd, ['check-ref-format', `refs/tags/${name}`]).then(() => true, () => false));
  if (!ok) throw new GitError(`not a valid tag name: ${name}`);
  if (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]).then(() => true, () => false)) throw new GitError(`a tag named ${name} already exists`);
  const hash = await commitOf(cwd, ref);
  if (!hash) throw new GitError(`no such commit: ${ref}`);
  await git(cwd, [...(await identity(cwd)), 'tag', ...(opts.message ? ['-a', '-m', opts.message] : []), name, hash]);
  if (!opts.push) return null;
  const { main } = await remotesOf(cwd);
  if (!main) return { pushed: null };
  try {
    await git(cwd, ['push', main, `refs/tags/${name}`], 120_000);
    return { pushed: `${main}/${name}` };
  } catch (e) {
    return { pushed: null, error: (e as Error).message };
  }
}

/** Delete a tag here, and on the default remote too when asked. */
export async function deleteTag(cwd: string, name: string, remote: boolean): Promise<PushResult | null> {
  if (name.startsWith('-') || !(await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/tags/${name}`]).then(() => true, () => false))) {
    throw new GitError(`no such tag: ${name}`);
  }
  await git(cwd, ['tag', '-d', '--', name]);
  if (!remote) return null;
  const { main } = await remotesOf(cwd);
  if (!main) return { pushed: null };
  try {
    await git(cwd, ['push', main, `:refs/tags/${name}`], 120_000);
    return { pushed: `${main}/${name}` };
  } catch (e) {
    return { pushed: null, error: (e as Error).message };
  }
}

export interface Comparison {
  base: string;
  head: string;
  /** Commits on `head` that `base` lacks, newest first (at most 300), and how many `base` has that `head` lacks. */
  commits: LogCommit[];
  behind: number;
  /** What merging `head` into `base` would change: the diff from their merge base, as a Merge Request shows it. */
  files: GitFile[];
}

/** Two branches, tags or commits side by side, as a Merge Request from `head` into `base` would see them. */
export async function compare(cwd: string, base: string, head: string): Promise<Comparison> {
  await Promise.all([checkRef(cwd, base), checkRef(cwd, head)]);
  const [log, behind, names] = await Promise.all([
    git(cwd, ['log', '-z', '-n300', LOG_FORMAT, `${base}..${head}`, '--']),
    git(cwd, ['rev-list', '--count', `${head}..${base}`, '--']),
    git(cwd, ['diff', '--name-status', '-z', '-M', `${base}...${head}`, '--']),
  ]);
  const raw = names.split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const st = raw[i]!;
    if (!st) continue;
    if (/^[RC]/.test(st)) { files.push({ status: st[0]!, from: raw[i + 1], path: raw[i + 2]! }); i += 2; }
    else files.push({ status: st[0]!, path: raw[++i]! });
  }
  return { base, head, commits: parseLog(log), behind: Number(behind.trim()) || 0, files };
}

export async function compareFileDiff(cwd: string, base: string, head: string, file: GitFile): Promise<string> {
  await Promise.all([checkRef(cwd, base), checkRef(cwd, head)]);
  const paths = file.from ? [file.from, file.path] : [file.path];
  return capDiff(hunksOnly(await git(cwd, ['diff', '--no-color', '-M', `${base}...${head}`, '--', ...paths])));
}

/**
 * Checkpoints: the whole folder (tracked and untracked files, not ignored ones) as a commit kept under
 * refs/dalang/checkpoints, taken before and after each agent turn. The branch, the index and the files are not
 * touched, so a checkpoint can be taken at any time; restoring one puts the files back as they were then.
 */
const CHECKPOINTS = 'refs/dalang/checkpoints';
const SNAPSHOT_ID = ['-c', 'user.name=Dalang', '-c', 'user.email=dalang@localhost'];

/** The top folder of the repository `cwd` is in: checkpoints always cover all of it, as git's paths are relative to it. */
const topOf = async (cwd: string) => (await git(cwd, ['rev-parse', '--show-toplevel'])).trim();

/** The folder as it is right now, as a commit on top of HEAD (never on a branch). */
export async function snapshot(dir: string): Promise<string> {
  const cwd = await topOf(dir);
  // A copy of the real index, so files git already knows unchanged are not read again.
  const index = join(tmpdir(), `dalang-index-${randomBytes(8).toString('hex')}`);
  try {
    const real = resolve(cwd, (await git(cwd, ['rev-parse', '--git-path', 'index'])).trim());
    if (existsSync(real)) copyFileSync(real, index);
    const env = { GIT_INDEX_FILE: index };
    await git(cwd, ['add', '-A', '--', '.'], 120_000, env);
    const tree = (await git(cwd, ['write-tree'], 60_000, env)).trim();
    const head = (await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => '')).trim();
    return (await git(cwd, [...SNAPSHOT_ID, 'commit-tree', tree, ...(head ? ['-p', head] : []), '-m', 'dalang checkpoint'])).trim();
  } finally {
    rmSync(index, { force: true });
  }
}

const checkpointRef = (convId: string, name: string) => `${CHECKPOINTS}/${convId}/${name}`;

/** Snapshot the folder and keep it as `name` (`<turn>-before`, `<turn>-after`) for this chat. */
export async function saveCheckpoint(cwd: string, convId: string, name: string): Promise<string> {
  const hash = await snapshot(cwd);
  await git(cwd, ['update-ref', checkpointRef(convId, name), hash]);
  return hash;
}

/** A chat's checkpoint by name, or null when it was never taken (or is gone). */
export async function checkpoint(cwd: string, convId: string, name: string): Promise<string | null> {
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${checkpointRef(convId, name)}^{commit}`]).catch(() => '')).trim() || null;
}

/** Forget a chat's checkpoints (when it is deleted); their files then go with git's next garbage collection. */
export async function dropCheckpoints(cwd: string, convId: string): Promise<void> {
  const refs = (await git(cwd, ['for-each-ref', '--format=%(refname)', `${CHECKPOINTS}/${convId}/`]).catch(() => '')).split('\n').filter(Boolean);
  for (const r of refs) await git(cwd, ['update-ref', '-d', r]).catch(() => '');
}

/** The files that differ between two checkpoints (or any two commits), as `name-status` lists them. */
export async function changedBetween(cwd: string, a: string, b: string): Promise<GitFile[]> {
  const raw = (await git(cwd, ['diff', '--name-status', '-z', '-M', a, b, '--'])).split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const st = raw[i]!;
    if (!st) continue;
    if (/^[RC]/.test(st)) { files.push({ status: st[0]!, from: raw[i + 1], path: raw[i + 2]! }); i += 2; }
    else files.push({ status: st[0]!, path: raw[++i]! });
  }
  return files;
}

export async function diffBetween(cwd: string, a: string, b: string, file: GitFile): Promise<string> {
  const paths = file.from ? [file.from, file.path] : [file.path];
  return capDiff(hunksOnly(await git(cwd, ['diff', '--no-color', '-M', a, b, '--', ...paths])));
}

/**
 * Put the folder's files back as checkpoint `hash` has them: changed and deleted files come back, files made since
 * are deleted. HEAD and the index stay; ignored files are left alone. The folder is snapshotted first, and that
 * snapshot is returned so the restore itself can be undone.
 */
export async function restoreSnapshot(dir: string, hash: string): Promise<{ files: number; undo: string }> {
  const cwd = await topOf(dir);
  const undo = await snapshot(cwd);
  const raw = (await git(cwd, ['diff', '--name-status', '-z', '--no-renames', hash, undo, '--'])).split('\0');
  const back: string[] = [];
  const gone: string[] = [];
  for (let i = 0; i < raw.length; i += 2) {
    const st = raw[i];
    const path = raw[i + 1];
    if (!st || !path) continue;
    (st === 'A' ? gone : back).push(path); // A: made since the checkpoint
  }
  for (const p of gone) { try { unlinkSync(join(cwd, p)); } catch { /* already gone */ } }
  if (back.length) {
    const list = tempFile(back.join('\0'));
    try {
      await git(cwd, ['restore', `--source=${hash}`, '--worktree', `--pathspec-from-file=${list.path}`, '--pathspec-file-nul'], 120_000);
    } finally { list.done(); }
  }
  return { files: back.length + gone.length, undo };
}

/** Keep the snapshot taken before a restore, so "undo restore" can find it (and only it). */
export async function keepUndo(cwd: string, convId: string, hash: string): Promise<void> {
  await git(cwd, ['update-ref', checkpointRef(convId, 'undo'), hash]);
}

/**
 * Local branches, and the remote ones that have no local branch of the same name yet (switching to one of those creates
 * it, tracking the remote). With `fetch`, the remote's list is refreshed first; a failed fetch keeps the old one.
 */
export async function branches(cwd: string, fetch = false): Promise<{ current: string | null; local: string[]; remote: string[] }> {
  const { main } = await remotesOf(cwd);
  if (fetch && main) await git(cwd, ['fetch', '--prune', main], 60_000).catch(() => '');
  const refs = async (prefix: string) =>
    (await git(cwd, ['for-each-ref', '--format=%(refname)', prefix]).catch(() => '')).split('\n').map((r) => r.trim()).filter(Boolean);
  const local = (await refs('refs/heads')).map((r) => r.slice('refs/heads/'.length));
  const remote = main
    ? (await refs(`refs/remotes/${main}`)).map((r) => r.slice(`refs/remotes/${main}/`.length)).filter((b) => b !== 'HEAD' && !local.includes(b))
    : [];
  return { current: await currentBranch(cwd), local, remote };
}

/** A name git accepts for a branch (and that cannot be read as an option). */
async function checkBranchName(cwd: string, name: string): Promise<void> {
  const ok = !name.startsWith('-') && (await git(cwd, ['check-ref-format', '--branch', name]).then(() => true, () => false));
  if (!ok) throw new GitError(`not a valid branch name: ${name}`);
}

/**
 * Check out `name`: an existing local branch, or a remote branch of that name (which becomes a local one tracking it).
 * With `create`, a new branch from `from` (default: HEAD) instead. Uncommitted changes come along; git refuses when they
 * would be overwritten, so nothing is lost.
 */
export async function switchBranch(cwd: string, name: string, opts: { create?: boolean; from?: string } = {}): Promise<void> {
  await checkBranchName(cwd, name);
  if (opts.create) {
    if (opts.from) {
      if (opts.from.startsWith('-') || !(await git(cwd, ['rev-parse', '--verify', '--quiet', `${opts.from}^{commit}`]).then(() => true, () => false))) {
        throw new GitError(`no such branch or commit: ${opts.from}`);
      }
    }
    await git(cwd, ['switch', '--no-track', '-c', name, ...(opts.from ? [opts.from] : [])]);
    return;
  }
  const { main } = await remotesOf(cwd);
  const exists = (ref: string) => git(cwd, ['rev-parse', '--verify', '--quiet', ref]).then(() => true, () => false);
  if (await exists(`refs/heads/${name}`)) await git(cwd, ['switch', name]);
  else if (main && (await exists(`refs/remotes/${main}/${name}`))) await git(cwd, ['switch', '--track', '-c', name, `${main}/${name}`]);
  else throw new GitError(`no such branch: ${name}`);
}

/**
 * Rename the checked-out branch `from` to `name`. One that was pushed moves on the remote too: the new name is pushed and
 * tracked, and the old one deleted there while it still points where ours did. Returns how that push went, or null when
 * the branch was never pushed. Once renamed it never throws: a failed push is reported and the next push retries it.
 */
export async function renameBranch(cwd: string, from: string, name: string): Promise<PushResult | null> {
  await checkBranchName(cwd, name);
  if ((await currentBranch(cwd)) !== from) throw new GitError(`${from} is not checked out here`);
  if (await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false)) {
    throw new GitError(`a branch named ${name} already exists`);
  }
  const cfg = (key: string) => git(cwd, ['config', `branch.${from}.${key}`]).then((v) => v.trim(), () => '');
  const [remote, ref, tip] = await Promise.all([cfg('remote'), cfg('merge'), git(cwd, ['rev-parse', from]).then((v) => v.trim(), () => '')]);
  await git(cwd, ['branch', '-m', from, name]); // its upstream settings come along, still naming the old remote branch
  if (!remote || !ref) return null;
  await git(cwd, ['branch', '--unset-upstream', name]).catch(() => '');
  const pushed = await push(cwd);
  if (pushed.pushed && tip) {
    await git(cwd, ['push', `--force-with-lease=${ref}:${tip}`, remote, `:${ref}`], 120_000)
      .catch((e: Error) => console.warn(`kept ${remote}/${ref.replace(/^refs\/heads\//, '')}: ${e.message}`));
  }
  return pushed;
}

/** A branch with commits that are neither in HEAD nor on its upstream: deleting it would lose them. */
export class UnmergedError extends GitError {}

/**
 * Delete a local branch (the remote one stays). Not the checked-out branch, not the default branch, and not one a
 * worktree has checked out (git refuses that itself). A branch whose commits are not in HEAD or on its upstream is
 * refused with an UnmergedError unless `force`.
 */
export async function deleteBranch(cwd: string, name: string, force = false): Promise<void> {
  await checkBranchName(cwd, name);
  const exists = await git(cwd, ['rev-parse', '--verify', '--quiet', `refs/heads/${name}`]).then(() => true, () => false);
  if (!exists) throw new GitError(`no such branch: ${name}`);
  if (name === (await currentBranch(cwd))) throw new GitError(`${name} is checked out: switch to another branch first`);
  if (name === (await defaultBranch(cwd))?.name) throw new GitError(`${name} is the default branch: it is not deleted from here`);
  if (!force) {
    const contains = (ref: string) => git(cwd, ['merge-base', '--is-ancestor', `refs/heads/${name}`, ref]).then(() => true, () => false);
    const upstream = (await git(cwd, ['for-each-ref', '--format=%(upstream)', `refs/heads/${name}`]).catch(() => '')).trim();
    if (!(await contains('HEAD')) && !(upstream && (await contains(upstream)))) {
      throw new UnmergedError(`${name} has commits that are neither in the current branch nor on its remote: they would be lost`);
    }
  }
  await git(cwd, ['branch', '-D', '--', name]);
}

export interface LogCommit {
  hash: string;
  parents: string[];
  author: string;
  /** Unix seconds. */
  date: number;
  /** Branches, tags and HEAD pointing here, as `git log --decorate` names them (`HEAD -> main`, `origin/main`, `tag: v1`). */
  refs: string[];
  subject: string;
}

/**
 * The newest `limit` commits on HEAD and every local and remote branch and tag, children before their parents, so the
 * branches can be drawn as a graph. `more` says whether older ones were left out; `remotes` tells remote branches
 * (`origin/feat/x`) from local ones with a slash in their name (`feat/x`).
 */
export async function log(cwd: string, limit = 150): Promise<{ commits: LogCommit[]; more: boolean; remotes: string[] }> {
  const head = await git(cwd, ['rev-parse', '--verify', '--quiet', 'HEAD']).then(() => true, () => false);
  const commits = parseLog(await git(cwd, ['log', '--topo-order', '-z', `-n${limit + 1}`, LOG_FORMAT,
    ...(head ? ['HEAD'] : []), '--branches', '--remotes', '--tags', '--']).catch(() => ''));
  return { commits: commits.slice(0, limit), more: commits.length > limit, remotes: (await remotesOf(cwd)).all };
}

export interface CommitDetail extends LogCommit {
  /** The message below the subject. */
  body: string;
  /** What the commit changed against its first parent (a root commit: everything is added). `status` is git's letter. */
  files: GitFile[];
}

/** The full hash of commit `ref`, or null when there is none. Only hex is accepted, so it cannot be read as an option. */
async function commitOf(cwd: string, ref: string): Promise<string | null> {
  if (!/^[0-9a-f]{4,64}$/i.test(ref)) return null;
  return (await git(cwd, ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '')).trim() || null;
}

/** `git diff` (or, for a root commit, `diff-tree --root`) of a commit against its first parent. */
const commitDiffArgs = (hash: string, parent: string | undefined, opts: string[]) =>
  parent ? ['diff', '--no-color', '-M', ...opts, parent, hash] : ['diff-tree', '--no-color', '-r', '-M', '--root', '--no-commit-id', ...opts, hash];

/** One commit: who made it, its message and the files it changed. Null when there is no such commit. */
export async function commitDetail(cwd: string, ref: string): Promise<CommitDetail | null> {
  const hash = await commitOf(cwd, ref);
  if (!hash) return null;
  const out = await git(cwd, ['show', '-s', '-z', '--format=%H%x1f%P%x1f%an%x1f%at%x1f%D%x1f%s%x1f%b', hash]);
  const [, parents = '', author = '', date = '0', refs = '', subject = '', body = ''] = out.replace(/\0$/, '').split('\x1f');
  const parent = parents.split(' ').filter(Boolean);
  const raw = (await git(cwd, commitDiffArgs(hash, parent[0], ['--name-status', '-z']))).split('\0');
  const files: GitFile[] = [];
  for (let i = 0; i < raw.length; i++) {
    const st = raw[i]!;
    if (!st) continue;
    if (/^[RC]/.test(st)) { files.push({ status: st[0]!, from: raw[i + 1], path: raw[i + 2]! }); i += 2; }
    else { files.push({ status: st[0]!, path: raw[++i]! }); }
  }
  return { hash, parents: parent, author, date: Number(date), refs: refs ? refs.split(', ') : [], subject, body: body.trim(), files };
}

/** The diff of one file a commit changed (as `commitDetail` lists it), against the commit's first parent. */
export async function commitFileDiff(cwd: string, commit: CommitDetail, file: GitFile): Promise<string> {
  const paths = file.from ? [file.from, file.path] : [file.path];
  return capDiff(hunksOnly(await git(cwd, [...commitDiffArgs(commit.hash, commit.parents[0], ['-p']), '--', ...paths])));
}

/** Put the given files back as they are in HEAD; untracked ones are deleted. */
export async function revert(cwd: string, files: GitFile[]): Promise<void> {
  const untracked = files.filter((f) => f.status === '??').map((f) => f.path);
  const added = files.filter((f) => f.status[0] === 'A').map((f) => f.path); // new in the index: nothing in HEAD to restore
  const tracked = files.filter((f) => f.status !== '??' && f.status[0] !== 'A').flatMap((f) => (f.from ? [f.from, f.path] : [f.path]));
  if (tracked.length) await git(cwd, ['restore', '--source=HEAD', '--staged', '--worktree', '--', ...tracked]);
  if (added.length) await git(cwd, ['rm', '-f', '--', ...added]);
  if (untracked.length) await git(cwd, ['clean', '-f', '--', ...untracked]);
}

/** Throw away every uncommitted change (ignored files stay). */
export async function discardAll(cwd: string): Promise<void> {
  await git(cwd, ['reset', '--hard', 'HEAD']);
  await git(cwd, ['clean', '-fd']);
}

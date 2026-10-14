import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { capDiff, wholeFile } from './diff.js';

export class GitError extends Error {}

/**
 * Run git in `cwd` without a shell. Repository hooks may run (commit, merge), so like the agent they must not see the
 * gateway's own secrets.
 */
export function git(cwd: string, args: string[], timeoutMs = 60_000): Promise<string> {
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => !k.startsWith('LZVR_')));
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], { env: { ...env, GIT_TERMINAL_PROMPT: '0' }, timeout: timeoutMs, maxBuffer: 32e6 }, (err, out, stderr) => {
      if (err) reject(new GitError((String(stderr).trim() || err.message).slice(-2000)));
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
  /** Latest commit on HEAD. */
  head: { hash: string; subject: string } | null;
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
  const log = await git(cwd, ['log', '-1', '--format=%h%x00%s']).catch(() => '');
  const [hash, subject] = log.trim().split('\0');
  return { repo: true, branch: await currentBranch(cwd), files, head: hash ? { hash, subject: subject ?? '' } : null };
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

/** Stage the given paths (all changes when empty) and commit them. Returns the new commit's short hash. */
export async function commit(cwd: string, message: string, paths: string[]): Promise<string> {
  await git(cwd, ['add', '-A', '--', ...(paths.length ? paths : ['.'])]);
  await git(cwd, [...(await identity(cwd)), 'commit', '-m', message]);
  return (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim();
}

export interface PushResult {
  /** Where it went (`origin/main`), or null when the repo has no remote or HEAD is detached. */
  pushed: string | null;
  /** Set when the push itself failed; the commit or merge before it still stands. */
  error?: string;
}

/**
 * Push the checked-out branch: to its upstream when it has one, otherwise to `origin` (or the only remote) under the
 * same name, which then becomes its upstream. Never throws: a failed push is reported, the local commit stays.
 */
export async function push(cwd: string): Promise<PushResult> {
  const branch = await currentBranch(cwd);
  const { main } = await remotesOf(cwd);
  if (!branch || !main) return { pushed: null };
  const cfg = (key: string) => git(cwd, ['config', `branch.${branch}.${key}`]).then((v) => v.trim(), () => '');
  const [upstreamRemote, upstreamRef] = await Promise.all([cfg('remote'), cfg('merge')]);
  const remote = upstreamRemote || main;
  const target = upstreamRef || `refs/heads/${branch}`;
  try {
    await git(cwd, ['push', ...(upstreamRef ? [] : ['-u']), remote, `${branch}:${target}`], 120_000);
    return { pushed: `${remote}/${target.replace(/^refs\/heads\//, '')}` };
  } catch (e) {
    return { pushed: null, error: (e as Error).message };
  }
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

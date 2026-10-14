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
 * Remove a chat's worktree. Its branch goes too when nothing on it is lost (`branch -d` refuses an unmerged branch,
 * which then stays for a human to look at).
 */
export async function removeWorktree(repo: string, dir: string, branch: string | null): Promise<void> {
  await git(repo, ['worktree', 'remove', '--force', dir]).catch(() => {
    rmSync(dir, { recursive: true, force: true }); // repo gone or already pruned: at least free the folder
    return git(repo, ['worktree', 'prune']).catch(() => '');
  });
  if (branch) await git(repo, ['branch', '-d', branch]).catch(() => '');
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

/**
 * Merge `branch` into whatever `repo` has checked out, with `message` as the merge commit's message (git's own
 * "Merge branch ..." when empty). A conflict aborts the merge, so the repo is left as it was. Returns the branch merged into.
 */
export async function merge(repo: string, branch: string, message = ''): Promise<string> {
  const into = await currentBranch(repo);
  if (!into) throw new GitError('the project folder is on a detached HEAD: check out a branch there first');
  try {
    // --cleanup=whitespace keeps `## Heading` lines of a Markdown body, whatever commit.cleanup says.
    const msg = message.trim() ? ['--cleanup=whitespace', '-m', message.trim()] : ['--no-edit'];
    await git(repo, [...(await identity(repo)), 'merge', '--no-ff', ...msg, branch]);
  } catch (e) {
    await git(repo, ['merge', '--abort']).catch(() => '');
    throw new GitError(`merge into ${into} failed and was undone: ${(e as Error).message}`);
  }
  return into;
}

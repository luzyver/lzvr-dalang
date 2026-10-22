import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { createPullRequest, githubAccountEnv, parsePrUrl } from '../src/forge.js';
import { diffFingerprint, saveCheckpoint, splitHunks } from '../src/git.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { setupApp } from './setup-app.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();
const config = (repo: string) => {
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  sh(repo, 'config', 'core.autocrlf', 'false');
};

/**
 * An app whose project folder is a git repo with one commit on `main`, pushed to a bare `origin`, and a second clone
 * of that remote for commits that arrive from elsewhere.
 */
async function project(env: Record<string, string> = {}) {
  const t = setupApp(env);
  const repo = join(t.root, 'proj');
  sh(repo, 'init', '-q', '-b', 'main');
  config(repo);
  writeFileSync(join(repo, 'a.txt'), 'one\ntwo\nthree\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  const bare = join(t.base, 'remote.git');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
  sh(repo, 'remote', 'add', 'origin', bare);
  sh(repo, 'push', '-q', '-u', 'origin', 'main');
  const other = join(t.base, 'other');
  execFileSync('git', ['clone', '-q', bare, other]);
  config(other);
  const commitThere = (file: string, content: string, msg = `there: ${file}`) => {
    writeFileSync(join(other, file), content);
    sh(other, 'add', '.');
    sh(other, 'commit', '-q', '-m', msg);
    sh(other, 'push', '-q');
  };
  const commitHere = (file: string, content: string, msg = `here: ${file}`, dir = repo) => {
    writeFileSync(join(dir, file), content);
    sh(dir, 'add', '.');
    sh(dir, 'commit', '-q', '-m', msg);
  };
  const p = (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'proj', path: 'proj' } })).json();
  const chat = async (worktree = false) =>
    (await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/conversations`, headers: AUTH, payload: { worktree } })).json();
  const conv = await chat();
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, id = conv.id) =>
    t.app.inject({ method, url: `/api/conversations/${id}/git${url}`, headers: AUTH, payload: payload as Record<string, unknown> | undefined });
  const status = async (id = conv.id) => (await call('GET', '', undefined, id)).json();
  return { ...t, repo, bare, other, commitThere, commitHere, project: p, chat, conv, call, status };
}

// Many git runs per test (a remote, a second clone, fetches): slow on a busy machine, so these get more time.
describe('sync and conflicts', { timeout: 60_000 }, () => {
  it('reports ahead and behind, and rebases or merges a branch that went apart from its remote', async () => {
    const t = await project();
    t.commitThere('o.txt', 'o\n');
    t.commitHere('h.txt', 'h\n');
    expect((await t.call('POST', '/fetch')).json()).toEqual({ remote: 'origin' });
    expect((await t.status()).upstream).toEqual({ name: 'origin/main', ahead: 1, behind: 1 });

    const r = (await t.call('POST', '/sync', { from: 'upstream', mode: 'rebase' })).json();
    expect(r).toEqual({ result: 'done', operation: null, conflicts: [], onto: 'origin/main' });
    expect(sh(t.repo, 'log', '--format=%s', '-3')).toBe('here: h.txt\nthere: o.txt\ninit');
    expect((await t.status()).upstream).toEqual({ name: 'origin/main', ahead: 1, behind: 0 });
    expect((await t.call('POST', '/sync', { from: 'upstream', mode: 'merge' })).json().result).toBe('up-to-date');

    t.commitThere('p.txt', 'p\n');
    writeFileSync(join(t.repo, 'wip.txt'), 'uncommitted\n'); // stashed for the time and put back
    const m = (await t.call('POST', '/sync', { from: 'upstream', mode: 'merge' })).json();
    expect(m.result).toBe('done');
    expect(sh(t.repo, 'log', '-1', '--format=%p').split(' ')).toHaveLength(2); // a merge commit
    expect(readFileSync(join(t.repo, 'wip.txt'), 'utf8')).toBe('uncommitted\n');
  });

  it('stops on conflicts, resolves them file by file, and continues or aborts', async () => {
    const t = await project();
    t.commitThere('a.txt', 'one\nTHERE\nthree\n');
    t.commitHere('a.txt', 'one\nHERE\nthree\n');
    t.commitHere('b.txt', 'b\n');
    t.commitThere('b.txt', 'other b\n');

    const r = (await t.call('POST', '/sync', { from: 'upstream', mode: 'merge' })).json();
    expect(r).toMatchObject({ result: 'conflicts', operation: 'merge', conflicts: ['a.txt', 'b.txt'] });
    const s = await t.status();
    expect(s.operation).toBe('merge');
    expect(s.files.filter((f: { status: string }) => f.status === 'AA' || f.status === 'UU')).toHaveLength(2);

    // Commits wait until the conflicts are settled.
    expect((await t.call('POST', '/commit', { message: 'x' })).json().error).toMatch(/in progress/);
    expect((await t.call('POST', '/conflicts/continue')).json().error).toMatch(/resolve these first: a.txt, b.txt/);
    // Marked resolved with the markers still in: refused.
    expect((await t.call('POST', '/conflicts/resolve', { path: 'a.txt', take: 'resolved' })).json().error).toMatch(/conflict markers/);
    expect((await t.call('POST', '/conflicts/resolve', { path: 'a.txt', take: 'mine' })).statusCode).toBe(204);
    writeFileSync(join(t.repo, 'b.txt'), 'both b\n');
    expect((await t.call('POST', '/conflicts/resolve', { path: 'b.txt', take: 'resolved' })).statusCode).toBe(204);
    expect((await t.call('POST', '/conflicts/resolve', { path: 'nope.txt', take: 'mine' })).json().error).toMatch(/not a conflicted file/);

    expect((await t.call('POST', '/conflicts/continue')).json()).toEqual({ result: 'done', operation: null, conflicts: [] });
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('one\nHERE\nthree\n');
    expect(readFileSync(join(t.repo, 'b.txt'), 'utf8')).toBe('both b\n');
    expect((await t.status()).operation).toBeNull();
  });

  it('keeps "mine" the chat branch side in a rebase too, and aborts back to where it was', async () => {
    const t = await project();
    // A rebase: "mine" is still this branch's side, though git calls it "theirs" there.
    t.commitThere('a.txt', 'one\nTHERE AGAIN\nthree\n');
    t.commitHere('a.txt', 'one\nHERE AGAIN\nthree\n');
    const rb = (await t.call('POST', '/sync', { from: 'upstream', mode: 'rebase' })).json();
    expect(rb).toMatchObject({ result: 'conflicts', operation: 'rebase', conflicts: ['a.txt'] });
    expect((await t.call('POST', '/conflicts/abort')).json()).toEqual({ aborted: 'rebase' });
    expect((await t.status()).operation).toBeNull();
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('one\nHERE AGAIN\nthree\n');

    await t.call('POST', '/sync', { from: 'upstream', mode: 'rebase' });
    expect((await t.call('POST', '/conflicts/resolve', { path: 'a.txt', take: 'mine' })).statusCode).toBe(204);
    expect((await t.call('POST', '/conflicts/continue')).json().result).toBe('done');
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('one\nHERE AGAIN\nthree\n');
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('here: a.txt');
    expect(sh(t.repo, 'log', '-2', '--format=%s').split('\n')[1]).toBe('there: a.txt');
  });

  it('brings the base branch into a worktree chat', async () => {
    const t = await project();
    const wt = await t.chat(true);
    t.commitHere('w.txt', 'w\n', 'feat: W', wt.worktree);
    t.commitThere('o.txt', 'o\n');
    await t.call('POST', '/fetch', undefined, wt.id);
    expect((await t.status(wt.id)).mr).toMatchObject({ branch: wt.branch, base: 'main', behind: 1, baseRef: 'origin/main' });
    const r = (await t.call('POST', '/sync', { from: 'base', mode: 'rebase' }, wt.id)).json();
    expect(r).toMatchObject({ result: 'done', onto: 'origin/main' });
    expect(sh(wt.worktree, 'log', '--format=%s', '-3')).toBe('feat: W\nthere: o.txt\ninit');
    expect((await t.status(wt.id)).mr.behind).toBe(0);
    // A worktree chat's own branch has no upstream yet.
    expect((await t.call('POST', '/sync', { from: 'upstream', mode: 'merge' }, wt.id)).json().error).toMatch(/no remote branch/);
  });

  it('cherry-picks and reverts commits from the history', async () => {
    const t = await project();
    sh(t.repo, 'switch', '-q', '-c', 'side');
    t.commitHere('s.txt', 's\n', 'feat: S');
    const side = sh(t.repo, 'rev-parse', 'HEAD');
    sh(t.repo, 'switch', '-q', 'main');
    const pick = (await t.call('POST', `/commits/${side}/cherry-pick`)).json();
    expect(pick).toMatchObject({ result: 'done', commit: expect.any(String) });
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('feat: S');
    const head = sh(t.repo, 'rev-parse', 'HEAD');
    expect((await t.call('POST', `/commits/${head}/revert`)).json().result).toBe('done');
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('Revert "feat: S"');
    expect(existsSync(join(t.repo, 's.txt'))).toBe(false);
    expect((await t.call('POST', '/commits/--help/revert')).json().error).toMatch(/no such commit/);
  });
});

describe('commit, push, amend and undo', { timeout: 60_000 }, () => {
  it('commits without pushing, then pushes on its own', async () => {
    const t = await project();
    writeFileSync(join(t.repo, 'a.txt'), 'changed\n');
    const c = (await t.call('POST', '/commit', { message: 'fix: Local', push: false })).json();
    expect(c.push).toBeNull();
    expect((await t.status()).upstream).toMatchObject({ ahead: 1, behind: 0 });
    expect((await t.status()).head).toMatchObject({ subject: 'fix: Local', pushed: false });
    expect((await t.call('POST', '/push')).json()).toEqual({ push: { pushed: 'origin/main' } });
    expect(sh(t.bare, 'log', '-1', '--format=%s', 'main')).toBe('fix: Local');
    expect((await t.status()).head.pushed).toBe(true);
  });

  it('amends the last commit, force-pushing a feature branch but never the default one', async () => {
    const t = await project();
    sh(t.repo, 'switch', '-q', '-c', 'feat/x');
    writeFileSync(join(t.repo, 'x.txt'), 'x\n');
    await t.call('POST', '/commit', { message: 'feat: X' });
    writeFileSync(join(t.repo, 'y.txt'), 'forgotten\n');
    const r = (await t.call('POST', '/commit', { message: 'feat: X and Y', amend: true })).json();
    expect(r.push).toEqual({ pushed: 'origin/feat/x' });
    expect(sh(t.repo, 'log', '--format=%s', '-2')).toBe('feat: X and Y\ninit');
    expect(sh(t.bare, 'log', '--format=%s', '-2', 'feat/x')).toBe('feat: X and Y\ninit');
    expect(sh(t.repo, 'show', '--name-only', '--format=', 'HEAD').split('\n').sort()).toEqual(['x.txt', 'y.txt']);
    // the message only
    expect((await t.call('POST', '/commit', { message: 'feat: Add x and y', amend: true, paths: [] })).statusCode).toBe(200);
    expect(sh(t.bare, 'log', '-1', '--format=%s', 'feat/x')).toBe('feat: Add x and y');

    sh(t.repo, 'switch', '-q', 'main');
    expect((await t.call('POST', '/commit', { message: 'init again', amend: true, paths: [] })).json().error).toMatch(/default branch/);
    expect((await t.call('POST', '/commit', { message: 'x', paths: [] })).json().error).toMatch(/pick at least one file/);
  });

  it('undoes the last commit, asking before it rewrites the remote', async () => {
    const t = await project();
    writeFileSync(join(t.repo, 'a.txt'), 'local\n');
    await t.call('POST', '/commit', { message: 'fix: Local only', push: false });
    const u = (await t.call('POST', '/undo-commit')).json();
    expect(u).toEqual({ subject: 'fix: Local only', pushed: false, push: null });
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('init');
    expect((await t.status()).files).toEqual([{ status: 'M ', path: 'a.txt' }]); // the change is back, staged

    sh(t.repo, 'switch', '-q', '-c', 'feat/y');
    await t.call('POST', '/commit', { message: 'feat: Y' });
    const refused = await t.call('POST', '/undo-commit', {});
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ pushed: true });
    const forced = (await t.call('POST', '/undo-commit', { force: true })).json();
    expect(forced).toEqual({ subject: 'feat: Y', pushed: true, push: { pushed: 'origin/feat/y' } });
    expect(sh(t.bare, 'log', '-1', '--format=%s', 'feat/y')).toBe('init');

    sh(t.repo, 'stash', '-q');
    sh(t.repo, 'switch', '-q', 'main');
    expect((await t.call('POST', '/undo-commit', { force: true })).json().error).toMatch(/first commit|default branch/);
  });

  it('commits only what was picked, not whatever else was staged before', async () => {
    const t = await project();
    writeFileSync(join(t.repo, 'staged.txt'), 'staged by someone else\n');
    sh(t.repo, 'add', 'staged.txt'); // e.g. the agent ran `git add`
    writeFileSync(join(t.repo, 'a.txt'), 'picked\n');
    await t.call('POST', '/commit', { message: 'feat: Only a', paths: ['a.txt'], push: false });
    expect(sh(t.repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
    expect((await t.status()).files).toEqual([{ status: '??', path: 'staged.txt' }]); // still there, just not committed

    // Rewording (an amend with no files) changes the message only.
    sh(t.repo, 'add', 'staged.txt');
    expect((await t.call('POST', '/commit', { message: 'feat: Change a', amend: true, paths: [], push: false })).statusCode).toBe(200);
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('feat: Change a');
    expect(sh(t.repo, 'show', '--name-only', '--format=', 'HEAD')).toBe('a.txt');
    expect(existsSync(join(t.repo, 'staged.txt'))).toBe(true);
  });

  it('commits only the picked hunks of a file', async () => {
    const t = await project();
    const lines = Array.from({ length: 30 }, (_, i) => `line ${i}`);
    writeFileSync(join(t.repo, 'long.txt'), `${lines.join('\n')}\n`);
    sh(t.repo, 'add', '.');
    sh(t.repo, 'commit', '-q', '-m', 'long');
    const changed = lines.map((l, i) => (i === 1 ? 'FIRST' : i === 28 ? 'LAST' : l));
    writeFileSync(join(t.repo, 'long.txt'), `${changed.join('\n')}\n`);
    writeFileSync(join(t.repo, 'a.txt'), 'other file\n');
    const d = (await t.call('GET', '/diff?path=long.txt')).json().diff as string;
    expect(splitHunks(d).hunks).toHaveLength(2);

    const fp = { 'long.txt': diffFingerprint(d) };
    // The hunks must be picked in the diff as it is now: without saying which diff, or after the file changed, refused.
    expect((await t.call('POST', '/commit', { message: 'x', paths: ['long.txt'], hunks: { 'long.txt': [1] } })).json().error).toMatch(/hunkDiffs/);
    writeFileSync(join(t.repo, 'long.txt'), `${['EARLIER', ...changed.slice(1)].join('\n')}\n`);
    const stale = await t.call('POST', '/commit', { message: 'x', paths: ['long.txt'], hunks: { 'long.txt': [1] }, hunkDiffs: fp });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ stale: 'long.txt', error: expect.stringMatching(/changed since its hunks were picked/) });
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('long');
    writeFileSync(join(t.repo, 'long.txt'), `${changed.join('\n')}\n`);

    const r = await t.call('POST', '/commit', { message: 'only last', paths: ['long.txt', 'a.txt'], hunks: { 'long.txt': [1] }, hunkDiffs: fp, push: false });
    expect(r.statusCode).toBe(200);
    const committed = sh(t.repo, 'show', 'HEAD:long.txt');
    expect(committed).toContain('LAST');
    expect(committed).not.toContain('FIRST');
    expect(sh(t.repo, 'show', 'HEAD:a.txt')).toBe('other file');
    expect(readFileSync(join(t.repo, 'long.txt'), 'utf8')).toContain('FIRST'); // still in the working copy
    expect((await t.status()).files).toEqual([{ status: ' M', path: 'long.txt' }]);

    writeFileSync(join(t.repo, 'new.txt'), 'n\n');
    expect((await t.call('POST', '/commit', { message: 'x', paths: ['new.txt'], hunks: { 'new.txt': [0] }, hunkDiffs: { 'new.txt': '00000000' } })).json().error).toMatch(/committed whole/);
    expect((await t.call('POST', '/commit', { message: 'x', hunks: { 'long.txt': [0] } })).json().error).toMatch(/name the files/);
  });
});

describe('stashes', () => {
  it('stashes every change, lists it with its files, and brings it back', async () => {
    const t = await project();
    writeFileSync(join(t.repo, 'a.txt'), 'changed\n');
    writeFileSync(join(t.repo, 'n.txt'), 'new\n');
    expect((await t.call('POST', '/stashes', { message: 'half done' })).statusCode).toBe(204);
    expect((await t.status()).files).toEqual([]);
    const list = (await t.call('GET', '/stashes')).json();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ index: 0, message: 'On main: half done', files: [{ status: 'M', path: 'a.txt' }, { status: 'A', path: 'n.txt' }] });
    expect((await t.call('GET', '/stashes/0/diff?path=n.txt')).json().diff).toContain('+new');
    expect((await t.call('GET', '/stashes/0/diff?path=a.txt')).json().diff).toContain('+changed');
    expect((await t.call('POST', '/stashes', {})).json().error).toMatch(/no changes/);

    expect((await t.call('POST', '/stashes/0/apply', {})).json().result).toBe('done');
    expect((await t.call('GET', '/stashes')).json()).toHaveLength(1); // apply keeps it
    sh(t.repo, 'checkout', '--', '.');
    sh(t.repo, 'clean', '-fdq');
    expect((await t.call('POST', '/stashes/0/apply', { pop: true })).json().result).toBe('done');
    expect((await t.call('GET', '/stashes')).json()).toEqual([]);
    expect(readFileSync(join(t.repo, 'n.txt'), 'utf8')).toBe('new\n');

    await t.call('POST', '/stashes', {});
    expect((await t.call('POST', '/stashes/0/drop')).statusCode).toBe(204);
    expect((await t.call('POST', '/stashes/3/drop')).json().error).toMatch(/no such stash/);
  });

  it('reports a stash that clashes coming back as conflicts with nothing to continue', async () => {
    const t = await project();
    writeFileSync(join(t.repo, 'a.txt'), 'one\nSTASHED\nthree\n');
    await t.call('POST', '/stashes', {});
    t.commitHere('a.txt', 'one\nCOMMITTED\nthree\n');
    const r = (await t.call('POST', '/stashes/0/apply', { pop: true })).json();
    expect(r).toEqual({ result: 'conflicts', operation: null, conflicts: ['a.txt'] });
    expect((await t.call('GET', '/stashes')).json()).toHaveLength(1); // kept, as it did not come back cleanly
    expect((await t.call('POST', '/conflicts/resolve', { path: 'a.txt', take: 'theirs' })).statusCode).toBe(204);
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('one\nSTASHED\nthree\n');
    expect((await t.status()).files).toEqual([{ status: 'M ', path: 'a.txt' }]);
  });
});

describe('blame, file history, tags and compare', () => {
  it('blames each line and lists the commits of one file', async () => {
    const t = await project();
    t.commitHere('a.txt', 'one\nTWO\nthree\n', 'fix: Two');
    writeFileSync(join(t.repo, 'a.txt'), 'one\nTWO\nthree\nfour\n');
    const b = (await t.call('GET', '/blame?path=a.txt')).json();
    expect(b.lines).toHaveLength(4);
    expect(b.commits[b.lines[0]].subject).toBe('init');
    expect(b.commits[b.lines[1]].subject).toBe('fix: Two');
    expect(b.lines[3]).toBe('0'.repeat(40)); // not committed yet
    expect(b.commits[b.lines[1]].author).toBe('Test');

    const log = (await t.call('GET', '/file-log?path=a.txt')).json();
    expect(log.commits.map((c: { subject: string }) => c.subject)).toEqual(['fix: Two', 'init']);
    expect((await t.call('GET', '/blame?path=../x')).statusCode).toBe(400);
    expect((await t.call('GET', '/blame?path=--help')).statusCode).toBe(400);
    expect((await t.call('GET', '/blame?path=nope.txt')).statusCode).toBe(400);
  });

  it('tags a commit, pushes the tag and deletes it again', async () => {
    const t = await project();
    const head = sh(t.repo, 'rev-parse', 'HEAD');
    const r = (await t.call('POST', '/tags', { name: 'v1.0.0', hash: head, message: 'First release', push: true })).json();
    expect(r).toEqual({ tag: 'v1.0.0', push: { pushed: 'origin/v1.0.0' } });
    expect(sh(t.bare, 'tag', '--list')).toBe('v1.0.0');
    expect(sh(t.repo, 'cat-file', '-t', 'v1.0.0')).toBe('tag'); // annotated
    expect((await t.call('GET', '/tags')).json()).toEqual([{ name: 'v1.0.0', hash: head }]);
    expect((await t.call('POST', '/tags', { name: 'v1.0.0', hash: head })).json().error).toMatch(/already exists/);
    expect((await t.call('POST', '/tags', { name: 'bad..tag', hash: head })).json().error).toMatch(/not a valid tag name/);
    expect((await t.call('POST', '/tags/delete', { name: 'v1.0.0', remote: true })).json()).toEqual({ push: { pushed: 'origin/v1.0.0' } });
    expect(sh(t.bare, 'tag', '--list')).toBe('');
  });

  it('compares two branches as a Merge Request would', async () => {
    const t = await project();
    sh(t.repo, 'switch', '-q', '-c', 'feat/c');
    t.commitHere('c.txt', 'c\n', 'feat: C');
    sh(t.repo, 'switch', '-q', 'main');
    t.commitHere('m.txt', 'm\n', 'chore: M');
    const r = (await t.call('GET', '/compare?base=main&head=feat/c')).json();
    expect(r.commits.map((c: { subject: string }) => c.subject)).toEqual(['feat: C']);
    expect(r.behind).toBe(1);
    expect(r.files).toEqual([{ status: 'A', path: 'c.txt' }]); // not m.txt: only what feat/c brings
    expect((await t.call('GET', '/compare/diff?base=main&head=feat/c&path=c.txt')).json().diff).toContain('+c');
    expect((await t.call('GET', '/compare?base=--all&head=main')).json().error).toMatch(/no such branch/);
  });
});

describe('turn checkpoints', () => {
  it('snapshots the folder around each agent turn and restores either side', async () => {
    const t = await project({ FAKE_WRITE: 'agent.txt=made by the agent\n' });
    writeFileSync(join(t.repo, 'a.txt'), 'mine, before the turn\n');
    await t.app.inject({ method: 'POST', url: `/api/conversations/${t.conv.id}/prompts`, headers: AUTH, payload: { prompt: 'make a file' } });
    await until(() => turnsDone(t.store, t.conv.id, 1));
    const [turn] = t.store.listTurns(t.conv.id);
    expect(sh(t.repo, 'for-each-ref', '--format=%(refname)', 'refs/dalang/').split('\n'))
      .toEqual([`refs/dalang/checkpoints/${t.conv.id}/${turn!.id}-after`, `refs/dalang/checkpoints/${t.conv.id}/${turn!.id}-before`]);

    const list = (await t.call('GET', '/checkpoints')).json();
    expect(list).toMatchObject({ undo: false, checkpoints: [{ turn: turn!.id, prompt: 'make a file', files: [{ status: 'A', path: 'agent.txt' }] }] });
    expect((await t.call('GET', `/checkpoints/${turn!.id}/diff?path=agent.txt`)).json().diff).toContain('+made by the agent');
    expect((await t.call('GET', '/git')).statusCode).toBe(404);
    expect((await t.status()).head.subject).toBe('init'); // HEAD and branches untouched

    writeFileSync(join(t.repo, 'later.txt'), 'after the turn\n');
    expect((await t.call('POST', `/checkpoints/${turn!.id}/restore`, { to: 'before' })).json()).toEqual({ files: 2 });
    expect(existsSync(join(t.repo, 'agent.txt'))).toBe(false);
    expect(existsSync(join(t.repo, 'later.txt'))).toBe(false);
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('mine, before the turn\n'); // the change from before the turn stays

    expect((await t.call('POST', '/checkpoints/undo')).json()).toEqual({ files: 2 });
    expect(readFileSync(join(t.repo, 'agent.txt'), 'utf8')).toBe('made by the agent\n');
    expect(readFileSync(join(t.repo, 'later.txt'), 'utf8')).toBe('after the turn\n');
    expect((await t.call('POST', '/checkpoints/999/restore', { to: 'before' })).statusCode).toBe(404);

    // Deleting the chat drops its checkpoints.
    await t.app.inject({ method: 'DELETE', url: `/api/conversations/${t.conv.id}`, headers: AUTH });
    await until(() => sh(t.repo, 'for-each-ref', 'refs/dalang/') === '');
  });

  it('keeps ignored files out of a checkpoint and leaves the index alone', async () => {
    const t = await project();
    writeFileSync(join(t.repo, '.gitignore'), 'node_modules/\n');
    mkdirSync(join(t.repo, 'node_modules'));
    writeFileSync(join(t.repo, 'node_modules', 'x.js'), 'x');
    writeFileSync(join(t.repo, 'staged.txt'), 's\n');
    sh(t.repo, 'add', 'staged.txt');
    const turn = t.store.startTurn(t.conv.id, 'p');
    const hash = await saveCheckpoint(t.repo, t.conv.id, `${turn}-before`);
    expect(sh(t.repo, 'ls-tree', '-r', '--name-only', hash).split('\n').sort()).toEqual(['.gitignore', 'a.txt', 'staged.txt']);
    expect(sh(t.repo, 'diff', '--cached', '--name-only')).toBe('staged.txt');
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('init');
  });
});

describe('pull request status', () => {
  const fakeGh = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

  it('reads checks, review and comments from the forge, and merges', async () => {
    const t = await project();
    const log = join(t.base, 'gh.log');
    t.cfg.forge = 'github';
    t.cfg.ghCommand = [process.execPath, fakeGh, log];
    const wt = await t.chat(true);
    expect((await t.call('GET', '/pull-request', undefined, wt.id)).statusCode).toBe(404);
    t.commitHere('b.txt', 'b\n', 'feat: Add b', wt.worktree);
    expect((await t.call('POST', '/pull-request', { title: 'feat: Add b' }, wt.id)).statusCode).toBe(200);

    const s = (await t.call('GET', '/pull-request', undefined, wt.id)).json();
    expect(s).toMatchObject({
      forge: 'github', url: 'https://github.com/acme/app/pull/7', state: 'open', mergeable: true, review: 'changes_requested',
      checks: [
        { name: 'test', state: 'fail', url: 'https://ci.example/1' }, { name: 'lint', state: 'pending' }, { name: 'deploy', state: 'pass' },
      ],
    });
    expect(s.comments.map((c: { author: string; body: string }) => `${c.author}: ${c.body}`))
      .toEqual(['ann: Looks close.', 'bob: Please rename x.', 'bob: Off by one here.']);
    expect(s.comments[2]).toMatchObject({ path: 'b.txt', line: 1 });

    const m = (await t.call('POST', '/pull-request/merge', { method: 'squash' }, wt.id)).json();
    expect(m.state).toBe('merged');
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    expect(calls[1].args).toEqual(['pr', 'merge', 'https://github.com/acme/app/pull/7', '--squash']);
  });

  it('opens it as the signed-in GitHub account that may push, not just the active one', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gh-accounts-'));
    const log = join(dir, 'gh.log');
    const command = [process.execPath, fakeGh, log];
    const calls = () => readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    const old = { accounts: process.env.FAKE_GH_ACCOUNTS, writers: process.env.FAKE_GH_WRITERS };
    try {
      // the active account may only read; the other one owns the repository
      process.env.FAKE_GH_ACCOUNTS = 'rezivaapra*,acme';
      process.env.FAKE_GH_WRITERS = 'acme';
      const opts = { forge: 'github' as const, command, cwd: dir, branch: 'x', base: 'main', title: 't', body: '' };
      expect(await githubAccountEnv(command, dir, 'github.com', 'acme/app')).toEqual({ GH_TOKEN: 'tok-acme', GH_ENTERPRISE_TOKEN: 'tok-acme' });
      await createPullRequest({ ...opts, repo: 'github.com/acme/app' });
      expect(calls()[0].token).toBe('tok-acme');

      // nobody may push: gh runs as the active account and says why itself
      process.env.FAKE_GH_WRITERS = '';
      expect(await githubAccountEnv(command, dir, 'github.com', 'other/app')).toEqual({});
      // one account only: never asks for tokens
      process.env.FAKE_GH_ACCOUNTS = 'solo*';
      expect(await githubAccountEnv([...command, 'solo'], dir, 'github.com', 'acme/app')).toEqual({});
      expect(await githubAccountEnv(command, dir, 'github.com', 'acme/app')).toEqual({ GH_TOKEN: 'tok-acme', GH_ENTERPRISE_TOKEN: 'tok-acme' }); // remembered
    } finally {
      for (const [k, v] of [['FAKE_GH_ACCOUNTS', old.accounts], ['FAKE_GH_WRITERS', old.writers]] as const) {
        if (v === undefined) delete process.env[k]; else process.env[k] = v;
      }
    }
  });

  it('reads the parts of a pull request or Merge Request address', () => {
    expect(parsePrUrl('https://github.com/acme/app/pull/7')).toEqual({ forge: 'github', host: 'github.com', repo: 'acme/app', number: 7 });
    expect(parsePrUrl('https://gitlab.example.com/team/sub/app/-/merge_requests/12'))
      .toEqual({ forge: 'gitlab', host: 'gitlab.example.com', repo: 'team/sub/app', number: 12 });
    expect(parsePrUrl('https://example.com/x')).toBeNull();
  });
});

describe('projects from a clone', () => {
  it('clones a repository into a new folder and makes it a project', async () => {
    const t = await project();
    const create = (payload: Record<string, unknown>) => t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload });
    const r = await create({ name: 'cloned', path: 'cloned', clone: t.bare });
    expect(r.statusCode).toBe(201);
    expect(readFileSync(join(t.root, 'cloned', 'a.txt'), 'utf8').replace(/\r/g, '')).toBe('one\ntwo\nthree\n'); // autocrlf may apply
    expect((await create({ name: 'again', path: 'cloned', clone: t.bare })).json().error).toMatch(/not empty/);
    expect((await create({ name: 'out', path: '../outside', clone: t.bare })).json().error).toMatch(/inside WORKSPACE_ROOT/);
    expect((await create({ name: 'bad', path: 'bad', clone: '--upload-pack=x' })).json().error).toMatch(/not a repository/);
    expect((await create({ name: 'missing', path: 'missing', clone: join(t.base, 'nope.git') })).json().error).toMatch(/clone failed/);
  });
});

import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/claude.js';
import { forgeOf, parseRemote, pullRequestArgs, remoteRepo } from '../src/forge.js';
import { cleanMessage, toCommitMessage } from '../src/git-routes.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';
import { setupDispatcher } from './setup.js';

const sh = (cwd: string, ...args: string[]) => execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8' }).trim();

/** An app whose project folder is a git repo with one commit on `main`. */
async function gitProject(sandbox = 'workspace-write') {
  const t = setupApp();
  const repo = join(t.root, 'proj');
  sh(repo, 'init', '-q', '-b', 'main');
  sh(repo, 'config', 'user.email', 'test@example.com');
  sh(repo, 'config', 'user.name', 'Test');
  sh(repo, 'config', 'core.autocrlf', 'false');
  writeFileSync(join(repo, 'a.txt'), 'one\n');
  sh(repo, 'add', '.');
  sh(repo, 'commit', '-q', '-m', 'init');
  const project = (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'proj', path: 'proj', sandbox } })).json();
  const chat = async (worktree: boolean) =>
    t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/conversations`, headers: AUTH, payload: { worktree } });
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method, url, headers, payload: payload as Record<string, unknown> | undefined });
  return { ...t, repo, project, chat, call };
}

describe('worktree chats', () => {
  it('gets its own branch and folder, and the agent runs there', async () => {
    const t = await gitProject();
    const r = await t.chat(true);
    expect(r.statusCode).toBe(201);
    const conv = r.json();
    expect(conv.branch).toBe(`dalang/${conv.id.slice(0, 8)}`);
    expect(conv.base_branch).toBe('main');
    expect(existsSync(join(conv.worktree, 'a.txt'))).toBe(true);
    expect(sh(conv.worktree, 'branch', '--show-current')).toBe(conv.branch);

    await t.call('POST', `/api/conversations/${conv.id}/prompts`, { prompt: 'hi' });
    await until(() => turnsDone(t.store, conv.id, 1));
    // the fake Codex echoes its arguments; -C is the folder it was told to work in
    const args = t.store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload)).find((e) => e.item?.args)?.item.args as string[];
    expect(args[args.indexOf('-C') + 1]).toBe(conv.worktree);
  });

  it('refuses a folder that is not a git repo', async () => {
    const t = setupApp();
    const p = (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'p', path: 'proj' } })).json();
    const r = await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/conversations`, headers: AUTH, payload: { worktree: true } });
    expect(r.statusCode).toBe(400);
    expect(t.store.listConversations(p.id)).toEqual([]);
  });

  it('commits in the worktree and leaves the project branch alone', async () => {
    const t = await gitProject();
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'b.txt'), 'new\n');

    const c = await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'add b' });
    expect(c.statusCode).toBe(200);
    expect(sh(conv.worktree, 'log', '-1', '--format=%s')).toBe('add b');

    const s = (await t.call('GET', `/api/conversations/${conv.id}/git`)).json();
    expect(s.files).toEqual([]);
    expect(s.worktree).toMatchObject({ branch: conv.branch, base: 'main', ahead: 1 });
    expect(existsSync(join(t.repo, 'b.txt'))).toBe(false);
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/merge`)).statusCode).toBe(404); // only via a Merge Request
  });

  it('removes the worktree and the merged branch when the chat is deleted', async () => {
    const t = await gitProject();
    const conv = (await t.chat(true)).json();
    expect((await t.call('GET', `/api/conversations/${conv.id}`)).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/conversations/${conv.id}`, headers: AUTH })).statusCode).toBe(204);
    await until(() => !existsSync(conv.worktree));
    await until(() => sh(t.repo, 'branch', '--list', conv.branch) === '');
  });

  it('keeps an unmerged branch when the chat is deleted', async () => {
    const t = await gitProject();
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'c.txt'), 'x\n');
    await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'wip' });
    await t.app.inject({ method: 'DELETE', url: `/api/conversations/${conv.id}`, headers: AUTH });
    await until(() => !existsSync(conv.worktree));
    expect(sh(t.repo, 'branch', '--list', conv.branch)).toContain(conv.branch);
  });
});

describe('git actions', () => {
  it('lists changes with a diff per file', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(t.repo, 'new.txt'), 'hello\n');
    const s = (await t.call('GET', `/api/conversations/${conv.id}/git`)).json();
    expect(s).toMatchObject({ repo: true, branch: 'main', worktree: null, head: { subject: 'init' } });
    expect(s.files).toEqual([{ status: ' M', path: 'a.txt' }, { status: '??', path: 'new.txt' }]);

    const d = (await t.call('GET', `/api/conversations/${conv.id}/git/diff?path=a.txt`)).json();
    expect(d.diff).toMatch(/^@@/);
    expect(d.diff).toContain('+two');
    const u = (await t.call('GET', `/api/conversations/${conv.id}/git/diff?path=new.txt`)).json();
    expect(u.diff).toContain('+hello');
    expect((await t.call('GET', `/api/conversations/${conv.id}/git/diff?path=../etc/passwd`)).statusCode).toBe(400);
  });

  it('lists the history of every branch, newest first, with their names', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    sh(t.repo, 'switch', '-q', '-c', 'feat/x');
    sh(t.repo, 'commit', '-q', '--allow-empty', '-m', 'on x');
    sh(t.repo, 'switch', '-q', 'main');
    sh(t.repo, 'tag', 'v1');
    sh(t.repo, 'merge', '-q', '--no-ff', '-m', 'merge x', 'feat/x');
    const log = (q = '') => t.call('GET', `/api/conversations/${conv.id}/git/log${q}`).then((r) => r.json());
    const r = await log();
    expect(r.commits.map((c: { subject: string }) => c.subject)).toEqual(['merge x', 'on x', 'init']);
    expect(r.commits[0]).toMatchObject({ refs: ['HEAD -> main'], author: 'Test' });
    expect(r.commits[0].parents).toHaveLength(2);
    expect(r.commits[1].refs).toEqual(['feat/x']);
    expect(r.commits[2].refs).toEqual(['tag: v1']);
    expect(r).toMatchObject({ more: false, remotes: [] });
    expect((await log('?limit=1'))).toMatchObject({ more: true, commits: [{ subject: 'merge x' }] });
  });

  it('shows what one commit changed, file by file', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    const init = sh(t.repo, 'rev-parse', 'HEAD');
    sh(t.repo, 'mv', 'a.txt', 'b.txt');
    writeFileSync(join(t.repo, 'c.txt'), 'new\n');
    sh(t.repo, 'add', '.');
    sh(t.repo, 'commit', '-q', '-m', 'feat: Move a', '-m', 'Because b reads better.');
    const head = sh(t.repo, 'rev-parse', 'HEAD');
    const get = (url: string) => t.call('GET', `/api/conversations/${conv.id}/git/commits/${url}`);

    const c = (await get(head.slice(0, 8))).json();
    expect(c).toMatchObject({ hash: head, parents: [init], subject: 'feat: Move a', body: 'Because b reads better.', author: 'Test' });
    expect(c.files).toEqual([{ status: 'R', from: 'a.txt', path: 'b.txt' }, { status: 'A', path: 'c.txt' }]);
    expect((await get(`${head}/diff?path=c.txt`)).json().diff).toContain('+new');
    expect((await get(`${head}/diff?path=a.txt`)).statusCode).toBe(400); // only paths the commit lists

    const root = (await get(init)).json(); // nothing before it: everything is added
    expect(root.files).toEqual([{ status: 'A', path: 'a.txt' }]);
    expect((await get(`${init}/diff?path=a.txt`)).json().diff).toMatch(/^@@[\s\S]*\+one/);

    expect((await get('deadbeef')).statusCode).toBe(404);
    expect((await get('--all')).statusCode).toBe(404);
  });

  it('reports a folder without git', async () => {
    const t = setupApp();
    const p = (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'p', path: 'proj' } })).json();
    const c = (await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/conversations`, headers: AUTH })).json();
    expect((await t.app.inject({ url: `/api/conversations/${c.id}/git`, headers: AUTH })).json()).toEqual({ repo: false });
  });

  it('commits only the chosen files', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'changed\n');
    writeFileSync(join(t.repo, 'b.txt'), 'b\n');
    const r = await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'only b', paths: ['b.txt'] });
    expect(r.json().commit).toMatch(/^[0-9a-f]+$/);
    expect(sh(t.repo, 'status', '--porcelain')).toBe('M a.txt');
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'x', paths: ['nope.txt'] })).statusCode).toBe(400);
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: '   ' })).statusCode).toBe(400);
  });

  it('reverts single files and discards everything', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'changed\n');
    writeFileSync(join(t.repo, 'b.txt'), 'b\n');
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/revert`, { paths: ['a.txt'] })).statusCode).toBe(204);
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(t.repo, 'b.txt'))).toBe(true);

    writeFileSync(join(t.repo, 'a.txt'), 'again\n');
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/discard`)).statusCode).toBe(204);
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('one\n');
    expect(existsSync(join(t.repo, 'b.txt'))).toBe(false);
  });

  it('lets a dev change files only outside read-only projects', async () => {
    const t = await gitProject('read-only');
    const dev = await mkUser(t, 'dana', 'dev');
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'changed\n');
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`, undefined, bearer(dev.token))).statusCode).toBe(200);
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/discard`, undefined, bearer(dev.token))).statusCode).toBe(403);
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/discard`)).statusCode).toBe(204);
  });

  it('refuses to change files while an agent works in the same folder', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    const other = (await t.chat(false)).json();
    const own = (await t.chat(true)).json();
    t.dispatcher.isRunning = (id: string) => id === conv.id;
    expect((await t.call('POST', `/api/conversations/${other.id}/git/discard`)).statusCode).toBe(409);
    expect((await t.call('POST', `/api/conversations/${own.id}/git/discard`)).statusCode).toBe(204);
  });
});

describe('commit message drafts', () => {
  it('asks the chat agent with the chosen diffs, the repo history and what the chat was asked', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    t.store.startTurn(conv.id, 'please add a second line');
    writeFileSync(join(t.repo, 'a.txt'), 'one\ntwo\n');
    writeFileSync(join(t.repo, 'skip.txt'), 'not this one\n');
    const r = await t.call('POST', `/api/conversations/${conv.id}/git/message`, { paths: ['a.txt'] });
    expect(r.statusCode).toBe(200);
    // the fake Codex answers with the prompt it was given
    const prompt = r.json().message as string;
    expect(prompt).toContain('Recent commits:\ninit');
    expect(prompt).toContain('- please add a second line');
    expect(prompt).toContain('--- M a.txt\n@@');
    expect(prompt).toContain('+two');
    expect(prompt).not.toContain('skip.txt');
    expect(prompt.startsWith('You are an expert at writing Git commits. Write a single-sentence commit subject only.')).toBe(true);
    expect(readFileSync(join(t.repo, 'a.txt'), 'utf8')).toBe('one\ntwo\n'); // nothing was committed or changed
  });

  it('uses the prompt an admin saved, for Codex and Claude Code alike', async () => {
    const t = await gitProject();
    const dev = await mkUser(t, 'dana', 'dev');
    const url = '/api/settings/commit-prompt';
    expect((await t.call('GET', url)).json()).toEqual({ prompt: '', default: expect.stringContaining('Conventional Commit format') });
    expect((await t.app.inject({ method: 'PUT', url, headers: bearer(dev.token), payload: { prompt: 'x' } })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'PUT', url, headers: AUTH, payload: { prompt: '  Write a haiku about the change.  ' } })).statusCode).toBe(204);
    expect((await t.call('GET', url)).json().prompt).toBe('Write a haiku about the change.');

    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'changed\n');
    const prompt = (await t.call('POST', `/api/conversations/${conv.id}/git/message`, {})).json().message as string;
    expect(prompt.startsWith('Write a haiku about the change.')).toBe(true);
    expect(prompt).not.toContain('expert at writing Git commits');
  });

  it('refuses when there is nothing to describe', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/message`, {})).statusCode).toBe(400);
  });

  it('reports a missing account instead of hanging', async () => {
    const t = setupApp({}, { homes: [] });
    const repo = join(t.root, 'proj');
    sh(repo, 'init', '-q');
    writeFileSync(join(repo, 'x.txt'), 'x\n');
    const p = (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'p', path: 'proj' } })).json();
    const c = (await t.app.inject({ method: 'POST', url: `/api/projects/${p.id}/conversations`, headers: AUTH })).json();
    const r = await t.app.inject({ method: 'POST', url: `/api/conversations/${c.id}/git/message`, headers: AUTH, payload: {} });
    expect(r.statusCode).toBe(502);
    expect(r.json().error).toMatch(/no Codex account/);
  });

  it('runs Codex read-only and without keeping a session', async () => {
    const d = setupDispatcher({ FAKE_ECHO_ARGS: '1' });
    const args = JSON.parse(await d.dispatcher.ask('codex', 'x', { cwd: d.dir })) as string[];
    expect(args).toContain('--ephemeral');
    expect(args[args.indexOf('-s') + 1]).toBe('read-only');
    expect(args).not.toContain('resume');
  });

  it('gives Claude Code no tools and no session either', () => {
    const a = buildClaudeArgs({ sandbox: 'read-only', extraArgs: ['--no-session-persistence', '--tools', ''] });
    expect(a).toEqual(expect.arrayContaining(['--permission-mode', 'default', '--no-session-persistence', '--tools', '']));
  });

  it('strips fences and quotes agents wrap the message in', () => {
    expect(cleanMessage('```\nfeat: add b\n\nbody\n```')).toBe('feat: add b\n\nbody');
    expect(cleanMessage('"fix: typo"')).toBe('fix: typo');
    expect(cleanMessage('"a" and "b"')).toBe('"a" and "b"');
  });
});

describe('Merge Request descriptions', () => {
  async function aheadChat() {
    const t = await gitProject();
    const conv = (await t.chat(true)).json();
    t.store.startTurn(conv.id, 'add a b file');
    writeFileSync(join(conv.worktree, 'b.txt'), 'bee\n');
    await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'feat: Add b' });
    return { t, conv };
  }

  it('describes the branch against what it merges into, with the MR prompt', async () => {
    const { t, conv } = await aheadChat();
    const r = await t.call('POST', `/api/conversations/${conv.id}/git/mr-description`);
    expect(r.statusCode).toBe(200);
    const prompt = r.json().description as string; // the fake Codex answers with its prompt
    expect(prompt.startsWith('You are an expert at writing Merge Request descriptions.')).toBe(true);
    expect(prompt).toContain(`merging branch ${conv.branch} into main`);
    expect(prompt).toContain(`Commits on ${conv.branch} (oldest first):\n- feat: Add b`);
    expect(prompt).toContain('- add a b file');
    expect(prompt).toContain('+bee');
    expect(prompt).not.toContain('Recent commits on the target branch:\nfeat: Add b');
  });

  it('needs a worktree chat with something to merge', async () => {
    const t = await gitProject();
    const plain = (await t.chat(false)).json();
    const fresh = (await t.chat(true)).json();
    expect((await t.call('POST', `/api/conversations/${plain.id}/git/mr-description`)).statusCode).toBe(400);
    expect((await t.call('POST', `/api/conversations/${fresh.id}/git/mr-description`)).json().error).toMatch(/nothing to merge/);
  });

  it('uses the saved MR prompt', async () => {
    const { t, conv } = await aheadChat();
    await t.app.inject({ method: 'PUT', url: '/api/settings/mr-prompt', headers: AUTH, payload: { prompt: 'Describe it briefly.' } });
    expect((await t.call('GET', '/api/settings/mr-prompt')).json()).toMatchObject({ prompt: 'Describe it briefly.', default: expect.stringContaining('## Summary') });
    const prompt = (await t.call('POST', `/api/conversations/${conv.id}/git/mr-description`)).json().description as string;
    expect(prompt.startsWith('Describe it briefly.')).toBe(true);
  });

  it('turns a description into a commit message: Title as subject, the rest as body', () => {
    const md = '## Title\n`feat: Add merge descriptions`\n\n## Summary\n- Why it matters\n\n## Changes\n- **`a.ts`**: x';
    expect(toCommitMessage(md)).toBe('feat: Add merge descriptions\n\n## Summary\n- Why it matters\n\n## Changes\n- **`a.ts`**: x');
    expect(toCommitMessage('just text')).toBe('just text');
  });
});

describe('push after commit', () => {
  /** A bare repo next to the project, as its `origin`, with `main` already pushed and tracked. */
  function addRemote(t: Awaited<ReturnType<typeof gitProject>>) {
    const bare = join(t.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    sh(t.repo, 'remote', 'add', 'origin', bare);
    sh(t.repo, 'push', '-q', '-u', 'origin', 'main');
    return bare;
  }

  /** What merging the chat's Merge Request and pulling it into the project folder leaves behind. */
  const mergeByHand = (t: Awaited<ReturnType<typeof gitProject>>, branch: string) => sh(t.repo, 'merge', '-q', '--no-ff', '--no-edit', branch);

  it('pushes a commit to the branch upstream', async () => {
    const t = await gitProject();
    const bare = addRemote(t);
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'two\n');
    const r = (await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'fix: Change a' })).json();
    expect(r.push).toEqual({ pushed: 'origin/main' });
    expect(sh(bare, 'log', '-1', '--format=%s', 'main')).toBe('fix: Change a');
  });

  it('gives a worktree chat its branch on the remote', async () => {
    const t = await gitProject();
    const bare = addRemote(t);
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'b.txt'), 'b\n');
    const c = (await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'feat: Add b' })).json();
    expect(c.push).toEqual({ pushed: `origin/${conv.branch}` });
    expect(sh(bare, 'log', '-1', '--format=%s', conv.branch)).toBe('feat: Add b');
    expect(sh(conv.worktree, 'rev-parse', '--abbrev-ref', '@{u}')).toBe(`origin/${conv.branch}`); // tracked from now on
    expect(sh(bare, 'log', '-1', '--format=%s', 'main')).toBe('init'); // main only changes through a Merge Request
  });

  it('renames a worktree chat branch, here and on the remote', async () => {
    const t = await gitProject();
    const bare = addRemote(t);
    const conv = (await t.chat(true)).json();
    const rename = (name: string) => t.call('POST', `/api/conversations/${conv.id}/git/branch/rename`, { name });
    // never pushed: only the local name changes
    expect((await rename('feat/first')).json()).toEqual({ branch: 'feat/first', push: null });
    expect(sh(conv.worktree, 'branch', '--show-current')).toBe('feat/first');
    writeFileSync(join(conv.worktree, 'b.txt'), 'b\n');
    await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'feat: Add b' });
    expect(sh(bare, 'branch', '--list', 'feat/first')).toContain('feat/first');
    // pushed: the new name goes up and is tracked, the old one is gone from the remote
    expect((await rename('feat/add-b')).json()).toEqual({ branch: 'feat/add-b', push: { pushed: 'origin/feat/add-b' } });
    expect(sh(bare, 'branch', '--list', 'feat/*')).toBe('feat/add-b');
    expect(sh(conv.worktree, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feat/add-b');
    expect((await t.call('GET', `/api/conversations/${conv.id}`)).json().branch).toBe('feat/add-b');
    expect((await rename('main')).statusCode).toBe(400); // taken
    expect((await rename('bad..name')).statusCode).toBe(400);
    const plain = (await t.chat(false)).json();
    expect((await t.call('POST', `/api/conversations/${plain.id}/git/branch/rename`, { name: 'x' })).statusCode).toBe(400);
  });

  it('deletes a merged branch on the remote with the chat, and keeps an unmerged one', async () => {
    const t = await gitProject();
    const bare = addRemote(t);
    const branches = () => sh(bare, 'branch', '--list', 'dalang/*');
    const pushed = async () => {
      const conv = (await t.chat(true)).json();
      writeFileSync(join(conv.worktree, `${conv.id}.txt`), 'x\n');
      await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'feat: Add x' });
      return conv;
    };
    const del = (id: string) => t.app.inject({ method: 'DELETE', url: `/api/conversations/${id}`, headers: AUTH });

    const unmerged = await pushed();
    await del(unmerged.id);
    await until(() => !existsSync(unmerged.worktree));
    await new Promise((r) => setTimeout(r, 300));
    expect(branches()).toContain(unmerged.branch); // on the remote
    expect(sh(t.repo, 'branch', '--list', unmerged.branch)).toContain(unmerged.branch); // and here

    const merged = await pushed();
    mergeByHand(t, merged.branch);
    await del(merged.id);
    await until(() => !branches().includes(merged.branch));
    expect(sh(t.repo, 'branch', '--list', merged.branch)).toBe('');
    expect(branches()).toContain(unmerged.branch);
  });

  it('keeps a merged branch on the remote when someone pushed more to it', async () => {
    const t = await gitProject();
    const bare = addRemote(t);
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'b.txt'), 'b\n');
    await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'feat: Add b' });
    mergeByHand(t, conv.branch);
    // another clone adds a commit to the same remote branch
    const other = join(t.base, 'other');
    execFileSync('git', ['clone', '-q', '-b', conv.branch, bare, other]);
    writeFileSync(join(other, 'c.txt'), 'c\n');
    sh(other, 'add', '.');
    sh(other, '-c', 'user.name=O', '-c', 'user.email=o@o', 'commit', '-q', '-m', 'more');
    sh(other, 'push', '-q');

    await t.app.inject({ method: 'DELETE', url: `/api/conversations/${conv.id}`, headers: AUTH });
    await until(() => sh(t.repo, 'branch', '--list', conv.branch) === '');
    await new Promise((r) => setTimeout(r, 500));
    expect(sh(bare, 'log', '-1', '--format=%s', conv.branch)).toBe('more');
  });

  it('skips the push without a remote', async () => {
    const t = await gitProject();
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'two\n');
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'x' })).json().push).toEqual({ pushed: null });
  });

  it('keeps the commit when the push fails, and says why', async () => {
    const t = await gitProject();
    sh(t.repo, 'remote', 'add', 'origin', join(t.base, 'no-such-remote.git'));
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'a.txt'), 'two\n');
    const r = await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'fix: Keep me' });
    expect(r.statusCode).toBe(200);
    expect(r.json().push).toEqual({ pushed: null, error: expect.any(String) });
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('fix: Keep me');
  });
});

describe('pull and branches', () => {
  /** A project with a bare `origin` and a second clone of it, for commits that arrive from elsewhere. */
  async function cloned() {
    const t = await gitProject();
    const bare = join(t.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    sh(t.repo, 'remote', 'add', 'origin', bare);
    sh(t.repo, 'push', '-q', '-u', 'origin', 'main');
    const other = join(t.base, 'other');
    execFileSync('git', ['clone', '-q', bare, other]);
    const commitThere = (file: string, msg: string) => {
      writeFileSync(join(other, file), `${msg}\n`);
      sh(other, 'add', '.');
      sh(other, '-c', 'user.name=O', '-c', 'user.email=o@o', 'commit', '-q', '-m', msg);
    };
    const conv = (await t.chat(false)).json();
    return { ...t, bare, other, commitThere, conv };
  }

  it('fast-forwards from the remote, and refuses when the branches went apart', async () => {
    const t = await cloned();
    t.commitThere('o.txt', 'feat: From elsewhere');
    sh(t.other, 'push', '-q');
    const r = await t.call('POST', `/api/conversations/${t.conv.id}/git/pull`);
    expect(r.json()).toEqual({ from: 'origin/main', commits: 1 });
    expect(readFileSync(join(t.repo, 'o.txt'), 'utf8')).toBe('feat: From elsewhere\n');
    expect((await t.call('POST', `/api/conversations/${t.conv.id}/git/pull`)).json()).toEqual({ from: 'origin/main', commits: 0 });

    t.commitThere('p.txt', 'feat: There');
    sh(t.other, 'push', '-q');
    writeFileSync(join(t.repo, 'q.txt'), 'here\n');
    sh(t.repo, 'add', '.');
    sh(t.repo, 'commit', '-q', '-m', 'feat: Here');
    const apart = await t.call('POST', `/api/conversations/${t.conv.id}/git/pull`);
    expect(apart.statusCode).toBe(400);
    expect(apart.json().error).toMatch(/pull from origin\/main failed/);
    expect(sh(t.repo, 'log', '-1', '--format=%s')).toBe('feat: Here'); // no merge commit
  });

  it('lists local and remote branches, fetching on request', async () => {
    const t = await cloned();
    sh(t.repo, 'branch', 'local-only');
    sh(t.other, 'checkout', '-q', '-b', 'feature/remote');
    sh(t.other, 'push', '-q', '-u', 'origin', 'feature/remote');
    const list = (fetch: boolean) => t.call('GET', `/api/conversations/${t.conv.id}/git/branches${fetch ? '?fetch=1' : ''}`).then((r) => r.json());
    expect(await list(false)).toEqual({ current: 'main', local: ['local-only', 'main'], remote: [] });
    expect(await list(true)).toEqual({ current: 'main', local: ['local-only', 'main'], remote: ['feature/remote'] });
  });

  it('creates a branch from HEAD, switches back, and checks out a remote one', async () => {
    const t = await cloned();
    const branch = (body: Record<string, unknown>) => t.call('POST', `/api/conversations/${t.conv.id}/git/branch`, body);
    writeFileSync(join(t.repo, 'wip.txt'), 'wip\n'); // uncommitted work comes along

    expect((await branch({ name: 'feature/new', create: true })).json()).toEqual({ branch: 'feature/new' });
    expect(sh(t.repo, 'branch', '--show-current')).toBe('feature/new');
    expect(existsSync(join(t.repo, 'wip.txt'))).toBe(true);
    // not tracking main: its first commit gets its own branch on the remote
    const c = (await t.call('POST', `/api/conversations/${t.conv.id}/git/commit`, { message: 'feat: Wip' })).json();
    expect(c.push).toEqual({ pushed: 'origin/feature/new' });

    expect((await branch({ name: 'main' })).statusCode).toBe(200);
    expect(sh(t.repo, 'branch', '--show-current')).toBe('main');

    t.commitThere('r.txt', 'feat: Remote work');
    sh(t.other, 'push', '-q', 'origin', 'HEAD:refs/heads/feature/remote');
    sh(t.repo, 'fetch', '-q');
    expect((await branch({ name: 'feature/remote' })).statusCode).toBe(200);
    expect(sh(t.repo, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/feature/remote');
  });

  it('refuses bad names, unknown branches and worktree chats', async () => {
    const t = await cloned();
    const branch = (id: string, body: Record<string, unknown>) => t.call('POST', `/api/conversations/${id}/git/branch`, body);
    expect((await branch(t.conv.id, { name: 'bad..name', create: true })).json().error).toMatch(/not a valid branch name/);
    expect((await branch(t.conv.id, { name: '-f', create: true })).json().error).toMatch(/not a valid branch name/);
    expect((await branch(t.conv.id, { name: 'x', create: true, from: '--orphan' })).json().error).toMatch(/no such branch or commit/);
    expect((await branch(t.conv.id, { name: 'nope' })).json().error).toMatch(/no such branch/);
    expect((await branch(t.conv.id, { name: 'main', create: true })).statusCode).toBe(400); // already exists
    const wt = (await t.chat(true)).json();
    expect((await branch(wt.id, { name: 'x', create: true })).json().error).toMatch(/worktree chat/);
    expect(sh(t.repo, 'branch', '--show-current')).toBe('main');
  });

  it('deletes a local branch, asking for force when its commits are nowhere else', async () => {
    const t = await cloned();
    const del = (body: Record<string, unknown>, id = t.conv.id) => t.call('POST', `/api/conversations/${id}/git/branch/delete`, body);
    const has = (b: string) => sh(t.repo, 'branch', '--list', b) !== '';

    sh(t.repo, 'branch', 'merged'); // same commit as main
    expect((await del({ name: 'merged' })).statusCode).toBe(204);
    expect(has('merged')).toBe(false);

    sh(t.repo, 'checkout', '-q', '-b', 'pushed');
    writeFileSync(join(t.repo, 'p.txt'), 'p\n');
    await t.call('POST', `/api/conversations/${t.conv.id}/git/commit`, { message: 'feat: P' }); // pushed: on its upstream
    sh(t.repo, 'checkout', '-q', '-b', 'local-work');
    writeFileSync(join(t.repo, 'l.txt'), 'l\n');
    sh(t.repo, 'add', '.');
    sh(t.repo, 'commit', '-q', '-m', 'feat: Only here');
    sh(t.repo, 'checkout', '-q', 'main');

    expect((await del({ name: 'pushed' })).statusCode).toBe(204);
    expect(sh(t.bare, 'branch', '--list', 'pushed')).toContain('pushed'); // the remote keeps it

    const refused = await del({ name: 'local-work' });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toMatchObject({ unmerged: true, error: expect.stringMatching(/would be lost/) });
    expect(has('local-work')).toBe(true);
    expect((await del({ name: 'local-work', force: true })).statusCode).toBe(204);
    expect(has('local-work')).toBe(false);

    expect((await del({ name: 'main' })).json().error).toMatch(/checked out/);
    sh(t.repo, 'checkout', '-q', '-b', 'side');
    expect((await del({ name: 'main', force: true })).json().error).toMatch(/default branch/);
    expect((await del({ name: 'nope' })).json().error).toMatch(/no such branch/);
    const wt = (await t.chat(true)).json();
    expect((await del({ name: wt.branch, force: true })).statusCode).toBe(400); // checked out in its worktree
    expect(has(wt.branch)).toBe(true);
    expect((await del({ name: 'side' }, wt.id)).json().error).toMatch(/project folder/);
  });
});

describe('Merge Requests on GitHub / GitLab', () => {
  const fakeGh = fileURLToPath(new URL('./fake-gh.mjs', import.meta.url));

  /** A project with a bare `origin`, set up to use the fake `gh`; `log` collects each call. */
  async function forgeProject() {
    const t = await gitProject();
    const bare = join(t.base, 'remote.git');
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', bare]);
    sh(t.repo, 'remote', 'add', 'origin', bare);
    sh(t.repo, 'push', '-q', '-u', 'origin', 'main');
    const log = join(t.base, 'gh.log');
    t.cfg.forge = 'github';
    t.cfg.ghCommand = [process.execPath, fakeGh, log];
    const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
    return { ...t, bare, calls };
  }

  it('pushes the branch and opens one into the branch the chat started from', async () => {
    const t = await forgeProject();
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'b.txt'), 'b\n');
    sh(conv.worktree, 'add', '.');
    sh(conv.worktree, 'commit', '-q', '-m', 'feat: Add b'); // committed by hand: not pushed yet

    const r = await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`, { title: 'feat: Add b', body: '## Summary\n- b' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ url: 'https://github.com/acme/app/pull/7', existed: false, forge: 'github', push: { pushed: `origin/${conv.branch}` } });
    expect(sh(t.bare, 'log', '-1', '--format=%s', conv.branch)).toBe('feat: Add b');
    const [call] = t.calls();
    expect(call.args).toEqual(['pr', 'create', '--head', conv.branch, '--base', 'main', '--title', 'feat: Add b', '--body', '## Summary\n- b']);
    expect(call.leaked).toBeNull();

    const s = (await t.call('GET', `/api/conversations/${conv.id}/git`)).json();
    expect(s.worktree.pr).toBe('https://github.com/acme/app/pull/7');
    // Asked again: the open one is reported, not an error.
    const again = (await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`, {})).json();
    expect(again).toMatchObject({ url: 'https://github.com/acme/app/pull/7', existed: true });
  });

  it('takes the last commit subject as the title when none is given', async () => {
    const t = await forgeProject();
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'b.txt'), 'b\n');
    await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'fix: Subject from commit' });
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`)).statusCode).toBe(200);
    expect(t.calls()[0].args.slice(6, 10)).toEqual(['--title', 'fix: Subject from commit', '--body', '']);
  });

  it('refuses without commits, without a remote, or for an unknown host', async () => {
    const t = await forgeProject();
    const conv = (await t.chat(true)).json();
    const none = await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`, {});
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toMatch(/nothing to propose/);

    sh(conv.worktree, 'commit', '-q', '--allow-empty', '-m', 'empty');
    t.cfg.forge = undefined; // a bare repo path says nothing about GitHub or GitLab
    const unknown = await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`, {});
    expect(unknown.json().error).toMatch(/GIT_FORGE/);

    const plain = (await t.chat(false)).json();
    // a plain chat while the project folder is on the default branch: nothing to open
    expect((await t.call('POST', `/api/conversations/${plain.id}/git/pull-request`, {})).json().error).toMatch(/default branch/);
    expect((await t.call('GET', `/api/conversations/${plain.id}/git`)).json().mr).toBeNull();
    expect(t.calls()).toEqual([]);
  });

  it('opens one from a plain chat on a feature branch into the default branch', async () => {
    const t = await forgeProject();
    const conv = (await t.chat(false)).json();
    sh(t.repo, 'checkout', '-q', '-b', 'feature/x');
    writeFileSync(join(t.repo, 'x.txt'), 'x\n');
    await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'feat: Add x' });

    const s = (await t.call('GET', `/api/conversations/${conv.id}/git`)).json();
    expect(s.worktree).toBeNull();
    expect(s.mr).toEqual({ branch: 'feature/x', base: 'main', ahead: 1, behind: 0, baseRef: 'origin/main', pr: null, usual: 'main', picked: false, baseMissing: false });
    const prompt = (await t.call('POST', `/api/conversations/${conv.id}/git/mr-description`)).json().description as string;
    expect(prompt).toContain('merging branch feature/x into main');
    expect(prompt).toContain('+x');

    const r = await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`, { title: 'feat: Add x' });
    expect(r.json()).toMatchObject({ url: 'https://github.com/acme/app/pull/7', push: { pushed: 'origin/feature/x' } });
    expect(t.calls()[0].args.slice(0, 6)).toEqual(['pr', 'create', '--head', 'feature/x', '--base', 'main']);
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`)).json().mr.pr).toBe('https://github.com/acme/app/pull/7');

    // on another branch the link is not this branch's Merge Request
    sh(t.repo, 'checkout', '-q', '-b', 'feature/y');
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`)).json().mr).toMatchObject({ branch: 'feature/y', pr: null });
  });

  it('opens one into a branch picked for the chat, and goes back to the usual one', async () => {
    const t = await forgeProject();
    sh(t.repo, 'branch', 'develop');
    sh(t.repo, 'push', '-q', 'origin', 'develop');
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'b.txt'), 'b\n');
    sh(conv.worktree, 'add', '.');
    sh(conv.worktree, 'commit', '-q', '-m', 'feat: Add b');
    const put = (base: string) => t.call('PUT', `/api/conversations/${conv.id}/git/mr-base`, { base });

    expect((await put('nope')).json().error).toMatch(/no such branch/);
    expect((await put('develop~1')).json().error).toMatch(/no such branch/); // a revision, not a branch
    expect((await put('@{-1}')).json().error).toMatch(/no such branch/);
    expect((await put(conv.branch)).statusCode).toBe(400);
    expect((await put('develop')).json()).toEqual({ base: 'develop', usual: 'main', picked: true });
    expect((await put('')).json()).toEqual({ base: 'main', usual: 'main', picked: false });
    // before a Merge Request is opened, a picked branch that is gone no longer counts
    sh(t.repo, 'branch', 'gone');
    await put('gone');
    sh(t.repo, 'branch', '-D', 'gone');
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`)).json().mr).toMatchObject({ base: 'main', picked: false, baseMissing: false });
    await put('develop');
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`)).json().mr).toMatchObject({ base: 'develop', baseRef: 'origin/develop', ahead: 1, picked: true });
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/mr-description`)).json().description).toContain(`merging branch ${conv.branch} into develop`);
    await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`, { title: 'feat: Add b' });
    expect(t.calls()[0].args.slice(0, 6)).toEqual(['pr', 'create', '--head', conv.branch, '--base', 'develop']);

    // while it is open its target stays; once merged the next one may go elsewhere
    const open = await put('');
    expect(open.statusCode).toBe(409);
    expect(open.json().error).toMatch(/already open/);
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`)).json().mr).toMatchObject({ base: 'develop', picked: true });
    // nor when its ref is gone here: the forge still has it
    sh(t.repo, 'branch', '-D', 'develop');
    sh(t.repo, 'update-ref', '-d', 'refs/remotes/origin/develop');
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`)).json().mr).toMatchObject({ base: 'develop', picked: true, baseMissing: true });
    appendFileSync(join(t.base, 'gh.log'), `${JSON.stringify({ args: ['pr', 'merge'], merge: true })}\n`);
    expect((await put('')).json()).toEqual({ base: 'main', usual: 'main', picked: false });
  });

  it('opens one from a plain chat on the default branch into a picked branch', async () => {
    const t = await forgeProject();
    sh(t.repo, 'branch', 'develop');
    sh(t.repo, 'push', '-q', 'origin', 'develop');
    const conv = (await t.chat(false)).json();
    writeFileSync(join(t.repo, 'm.txt'), 'm\n');
    await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'fix: On main' });
    const s = (await t.call('GET', `/api/conversations/${conv.id}/git`)).json();
    expect(s.mr).toBeNull();
    expect(s.mrPick).toEqual({ branch: 'main', usual: 'main' });

    expect((await t.call('PUT', `/api/conversations/${conv.id}/git/mr-base`, { base: 'develop' })).json()).toEqual({ base: 'develop', usual: 'main', picked: true });
    expect((await t.call('GET', `/api/conversations/${conv.id}/git`)).json()).toMatchObject({ mr: { branch: 'main', base: 'develop', ahead: 1 }, mrPick: null });
    await t.call('POST', `/api/conversations/${conv.id}/git/pull-request`, { title: 'fix: On main' });
    expect(t.calls()[0].args.slice(0, 6)).toEqual(['pr', 'create', '--head', 'main', '--base', 'develop']);
  });

  it('reads the host and repository from a remote address', () => {
    expect(parseRemote('git@github.com:acme/app.git')).toEqual({ host: 'github.com', path: 'acme/app', ssh: true });
    expect(parseRemote('git@github.com-work:acme/app.git')).toEqual({ host: 'github.com-work', path: 'acme/app', ssh: true });
    expect(parseRemote('ssh://git@gitlab.company.io:2222/team/sub/app.git')).toEqual({ host: 'gitlab.company.io', path: 'team/sub/app', ssh: true });
    expect(parseRemote('https://user@gitlab.com/team/app.git')).toEqual({ host: 'gitlab.com', path: 'team/app', ssh: false });
    expect(parseRemote('/srv/git/app.git')).toBeNull();
    expect(parseRemote('C:\\repos\\app.git')).toBeNull();
    expect(forgeOf('github.example.com')).toBe('github');
    expect(forgeOf('gitlab.company.io')).toBe('gitlab');
    expect(forgeOf('git.example.com')).toBeNull();
  });

  it('finds the forge behind an https remote and passes the repository to the CLI', async () => {
    expect(await remoteRepo('https://github.com/acme/app.git')).toEqual({ forge: 'github', repo: 'github.com/acme/app' });
    expect(await remoteRepo('https://git.example.com/github-mirror/app')).toBeNull(); // only the host counts
    expect(await remoteRepo('https://git.example.com/team/app', 'gitlab')).toEqual({ forge: 'gitlab', repo: 'git.example.com/team/app' });
    expect(await remoteRepo('/srv/git/app.git', 'github')).toEqual({ forge: 'github', repo: null });
    expect(pullRequestArgs({ forge: 'github', repo: 'github.com/acme/app', branch: 'b', base: 'main', title: 't', body: 'd' }))
      .toEqual(['pr', 'create', '--repo', 'github.com/acme/app', '--head', 'b', '--base', 'main', '--title', 't', '--body', 'd']);
    expect(pullRequestArgs({ forge: 'gitlab', repo: 'git.example.com/team/app', branch: 'b', base: 'main', title: 't', body: 'd' }))
      .toEqual(['mr', 'create', '--repo', 'https://git.example.com/team/app', '--source-branch', 'b', '--target-branch', 'main', '--title', 't', '--description', 'd', '--yes']);
  });

  it('resolves an SSH alias such as github.com-work to the host it stands for', async () => {
    // `ssh -G` applies ~/.ssh/config; an alias that is not configured simply comes back as itself
    const r = await remoteRepo('git@github.com-dalang-test-alias:acme/app.git');
    expect(r?.forge).toBe('github');
    expect(r?.repo).toMatch(/^github\.com(-dalang-test-alias)?\/acme\/app$/);
  });
});

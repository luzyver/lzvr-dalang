import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/claude.js';
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
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, headers: Record<string, string> = AUTH) =>
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

  it('commits in the worktree, then merges into the project branch', async () => {
    const t = await gitProject();
    const conv = (await t.chat(true)).json();
    writeFileSync(join(conv.worktree, 'b.txt'), 'new\n');

    expect((await t.call('POST', `/api/conversations/${conv.id}/git/merge`)).statusCode).toBe(409); // uncommitted
    const c = await t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: 'add b' });
    expect(c.statusCode).toBe(200);
    expect(sh(conv.worktree, 'log', '-1', '--format=%s')).toBe('add b');

    const s = (await t.call('GET', `/api/conversations/${conv.id}/git`)).json();
    expect(s.files).toEqual([]);
    expect(s.worktree).toMatchObject({ branch: conv.branch, base: 'main', ahead: 1, into: 'main' });

    const m = await t.call('POST', `/api/conversations/${conv.id}/git/merge`);
    expect(m.json()).toEqual({ into: 'main' });
    expect(readFileSync(join(t.repo, 'b.txt'), 'utf8')).toBe('new\n');
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
    expect(a).toEqual(expect.arrayContaining(['--permission-mode', 'plan', '--no-session-persistence', '--tools', '']));
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
    expect(prompt).toContain(`merging branch ${conv.branch} into the current branch`);
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

  it('merges with the given message, Markdown headings included', async () => {
    const { t, conv } = await aheadChat();
    const message = 'feat: Add b file\n\n## Summary\n- Adds b';
    expect((await t.call('POST', `/api/conversations/${conv.id}/git/merge`, { message })).json()).toEqual({ into: 'main' });
    expect(sh(t.repo, 'log', '-1', '--format=%B')).toBe(message);
  });

  it('turns a description into a commit message: Title as subject, the rest as body', () => {
    const md = '## Title\n`feat: Add merge descriptions`\n\n## Summary\n- Why it matters\n\n## Changes\n- **`a.ts`**: x';
    expect(toCommitMessage(md)).toBe('feat: Add merge descriptions\n\n## Summary\n- Why it matters\n\n## Changes\n- **`a.ts`**: x');
    expect(toCommitMessage('just text')).toBe('just text');
  });
});

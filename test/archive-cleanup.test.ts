import { expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { AUTH, until } from './helpers.js';
import { setupApp } from './setup-app.js';
import { Store } from '../src/store.js';
import { ArchiveCleanup } from '../src/archive-cleanup.js';

function setup() {
  const store = new Store();
  const project = store.createProject('Archive', '/tmp');
  const create = (parent = '') => store.createConversation(project.id, 'codex', parent);
  const root = create();
  const turn = store.startTurn(root.id, 'Please fix the report');
  store.addEvent(turn, 'item.completed', JSON.stringify({ item: { type: 'agent_message', text: 'Fixed the report.' } }));
  store.endTurn(turn, 'completed', null);
  const start = Date.parse(store.lastAt(root.id)!.replace(' ', 'T') + 'Z');
  const ask = vi.fn(async (_prompt: string) => 'DONE');
  const job = new ArchiveCleanup(store, () => false, (_chat, prompt) => ask(prompt),
    chats => { for (const c of chats) store.deleteConversation(c.id); });
  return { store, root, start, create, ask, job };
}

it('reviews archived chats once per day and only accepts a definite completion', async () => {
  const { store, root, start, ask, job } = setup();
  ask.mockResolvedValueOnce('possibly DONE');
  await job.tick(start);
  expect(ask).not.toHaveBeenCalled();
  const day = 86_400_000;
  await job.tick(start + day);
  await job.tick(start + day + 1);
  expect(ask).toHaveBeenCalledTimes(1);
  expect(ask.mock.calls[0]![0]).toContain('Fixed the report.');
  expect(store.getConversation(root.id)).toBeTruthy();
  await job.tick(start + 2 * day);
  expect(store.getConversation(root.id)).toBeNull();
});

it('deletes expired families without AI while preserving queued work', async () => {
  const { store, root, start, create, ask, job } = setup();
  const child = create(root.id);
  const queued = create();
  store.enqueue(queued.id, 'run later', []);
  await job.tick(start + 11 * 86_400_000);
  expect(ask).not.toHaveBeenCalled();
  expect(store.getConversation(queued.id)).toBeTruthy();
  expect(store.getConversation(child.id)).toBeNull();
  expect(store.getConversation(root.id)).toBeNull();
});

it('rechecks descendant work before applying an asynchronous verdict', async () => {
  const { root, create, ask, job, store } = setup();
  store.setArchived(root.id, true);
  ask.mockImplementationOnce(async () => { create(root.id); return 'DONE'; });
  await job.tick(Date.now());
  expect(ask).toHaveBeenCalledOnce();
  expect(store.getConversation(root.id)).toBeTruthy();
});

it('keeps the chat on AI failure at exactly ten days and expires it on the next sweep', async () => {
  const { store, root, start, ask, job } = setup();
  ask.mockRejectedValueOnce(new Error('AI unavailable'));
  await job.tick(start + 10 * 86_400_000);
  expect(ask).toHaveBeenCalledOnce();
  expect(store.getConversation(root.id)).toBeTruthy();
  await job.tick(start + 11 * 86_400_000);
  expect(ask).toHaveBeenCalledOnce();
  expect(store.getConversation(root.id)).toBeNull();
});

it('keeps a cancelled last turn even if it emitted a partial answer before cancellation', async () => {
  const { store, root, start, ask, job } = setup();
  store.endTurn(store.listTurns(root.id)[0]!.id, 'cancelled', null);
  await job.tick(start + 86_400_000);
  expect(store.getConversation(root.id)).toBeTruthy();
  expect(ask).not.toHaveBeenCalled();
});

it('runs cleanup on server startup and removes the archived chat files through the normal deletion path', async () => {
  const { app, store, dispatcher, root } = setupApp({ FAKE_ANSWER: 'DONE' });
  const project = store.createProject('Test', root);
  const chat = store.createConversation(project.id);
  const turn = store.startTurn(chat.id, 'Explain the result.');
  store.addEvent(turn, 'item.completed', JSON.stringify({ item: { type: 'agent_message', text: 'The report is complete.' } }));
  store.endTurn(turn, 'completed', null);
  store.setArchived(chat.id, true);
  const folder = dispatcher.filesDir(chat.id);
  mkdirSync(folder, { recursive: true });
  writeFileSync(join(folder, 'result.txt'), 'test');
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    await until(() => Boolean(store.getKv('archive_cleanup_day')));
    expect(store.getConversation(chat.id)).toBeNull();
    expect(existsSync(folder)).toBe(false);
  } finally { await app.close(); }
});

it.each(['DONE', 'KEEP', 'invalid summary'])('reviews a long history in bounded calls with outcome %s', async outcome => {
  const { ask, store, root, job, start } = setup();
  const turn = store.startTurn(root.id, 'earlier work ' + 'x'.repeat(125_000));
  store.addEvent(turn, 'item.completed', JSON.stringify({ item: { type: 'agent_message', text: 'Final confirmation.' } }));
  store.endTurn(turn, 'completed', null);
  ask.mockImplementation(async prompt => {
    if (prompt.includes('Final confirmation.')) return prompt.includes('the previous task') ? outcome : 'KEEP';
    return outcome === 'invalid summary' ? 'not sure' : JSON.stringify({ open: ['the previous task'], resolved: [] });
  });
  await job.tick(start + 86_400_000);
  expect(ask).toHaveBeenCalled();
  expect(ask.mock.calls.every(([prompt]) => prompt.length <= 60_000)).toBe(true);
  if (outcome !== 'invalid summary') expect(ask.mock.calls.at(-1)![0]).toContain('Final confirmation.');
  expect(Boolean(store.getConversation(root.id))).toBe(outcome !== 'DONE');
});

it('propagates a manual database deletion failure to the caller', async () => {
  const { app, store, root } = setupApp();
  const chat = store.createConversation(store.createProject('Test', root).id);
  vi.spyOn(store, 'deleteConversation').mockImplementation(() => { throw new Error('delete failed'); });
  try {
    const response = await app.inject({ method: 'DELETE', url: '/api/conversations/' + chat.id, headers: AUTH });
    expect(response.statusCode).toBe(500);
    expect(store.getConversation(chat.id)).toBeTruthy();
  } finally { await app.close(); }
});

it('protects an archived family with an outgoing pending request', async () => {
  const { app, store, root } = setupApp({ FAKE_ANSWER: 'DONE' });
  const p = store.createProject('Test', root);
  const chat = store.createConversation(p.id);
  const child = store.createConversation(p.id, 'codex', chat.id);
  const other = store.createConversation(p.id);
  const turn = store.startTurn(chat.id, 'Finish this');
  store.addEvent(turn, 'item.completed', JSON.stringify({ item: { type: 'agent_message', text: 'Finished' } }));
  store.endTurn(turn, 'completed', null);
  store.setArchived(chat.id, true);
  store.createApproval(child.id, other.id, 'Follow up');
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    await until(() => Boolean(store.getKv('archive_cleanup_day')));
    expect(store.getConversation(child.id)).toBeTruthy();
    expect(store.getConversation(chat.id)).toBeTruthy();
  } finally { await app.close(); }
});

it('keeps uncommitted work and remote branches when deleting archived chats', async () => {
  const { app, store, root, base } = setupApp({ FAKE_ANSWER: 'DONE' });
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main');
  git('-c', 'user.email=test@example.test', '-c', 'user.name=test', 'commit', '-q', '--allow-empty', '-m', 'initial');
  const remote = join(base, 'remote.git');
  git('init', '-q', '--bare', remote);
  git('remote', 'add', 'origin', remote);
  const project = store.createProject('Test', root);
  const chats = ['clean', 'dirty'].map(branch => {
    const dir = join(base, branch);
    git('worktree', 'add', '-q', '-b', branch, dir);
    git('-C', dir, 'push', '-qu', 'origin', branch);
    const chat = store.createConversation(project.id);
    store.setWorktree(chat.id, { dir, branch, base: 'main' });
    const turn = store.startTurn(chat.id, 'Finish this');
    store.addEvent(turn, 'item.completed', JSON.stringify({ item: { type: 'agent_message', text: 'Finished' } }));
    store.endTurn(turn, 'completed', null);
    store.setArchived(chat.id, true);
    return chat;
  });
  const file = join(base, 'dirty', 'unfinished.txt');
  writeFileSync(file, 'only copy');
  try {
    await app.listen({ host: '127.0.0.1', port: 0 });
    await until(() => Boolean(store.getKv('archive_cleanup_day')));
    expect(chats.every(c => !store.getConversation(c.id))).toBe(true);
    expect(existsSync(file)).toBe(true);
    expect(existsSync(join(base, 'clean'))).toBe(false);
    expect(git('ls-remote', '--heads', remote)).toContain('refs/heads/clean');
  } finally { await app.close(); }
});

it.each(['before review', 'during review'])('protects a restored cross-project child %s despite a manual root archive', async when => {
  const { store, root, ask, job } = setup();
  const project = store.createProject('Visible project', '/tmp/visible');
  const child = store.createConversation(project.id, 'codex', root.id);
  store.setArchived(root.id, true);
  const restore = () => store.setArchived(child.id, false);
  if (when === 'before review') restore();
  else ask.mockImplementationOnce(async () => { restore(); return 'DONE'; });
  await job.tick(Date.now());
  expect(ask).toHaveBeenCalledTimes(when === 'before review' ? 0 : 1);
  expect(store.getConversation(child.id)).toBeTruthy();
  expect(store.getConversation(root.id)).toBeTruthy();
});

it('counts a descendant draft edit as activity and expires it only after ten more idle days', async () => {
  const { store, root, create, job, ask } = setup();
  const child = create(root.id);
  store.db.exec("UPDATE conversations SET created_at='2020-01-01 00:00:00'; UPDATE turns SET ended_at='2020-01-01 00:01:00'");
  store.setDraft(child.id, 'new unsent work');
  await job.tick(Date.now());
  expect(store.getConversation(child.id)?.draft).toBe('new unsent work');
  expect(ask).not.toHaveBeenCalled();
  await job.tick(Date.now() + 11 * 86_400_000);
  expect(store.getConversation(root.id)).toBeNull();
});

it.each(['user', 'agent', 'unknown', 'scheduled'])('requires a user-attributed turn for explicit clearance (%s)', async source => {
  const { store, root, start, ask, job } = setup();
  const prior = store.listTurns(root.id)[0]!.id;
  const turn = store.startTurn(root.id, 'Cancel the outstanding request.', source === 'agent' ? prior : null);
  const author = source === 'user' || source === 'scheduled' ? 'operator' : undefined;
  store.addEvent(turn, 'user.prompt', JSON.stringify({ author, source: source === 'scheduled' ? source : undefined }));
  store.addEvent(turn, 'item.completed', JSON.stringify({ item: { type: 'agent_message', text: 'Acknowledged.' } }));
  store.endTurn(turn, 'completed', null);
  ask.mockResolvedValue('CLEARED ' + turn);
  await job.tick(start + 86_400_000);
  const prompt = ask.mock.calls[0]![0];
  const records = prompt.split('Transcript segment:\n')[1]!.trim().split('\n').map(line => JSON.parse(line));
  const request = records.find(record => record.role === 'prompt' && record.turn === turn);
  expect(request.source).toBe(source);
  expect(request.author).toBe(author);
  expect(Boolean(store.getConversation(root.id))).toBe(source !== 'user');
});

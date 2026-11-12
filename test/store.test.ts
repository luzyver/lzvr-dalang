import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { Store } from '../src/store.js';

function fresh() {
  const store = new Store();
  const project = store.createProject('p', '/w/p');
  const conv = store.createConversation(project.id);
  return { store, project, conv };
}

describe('Store', () => {
  it('keeps context samples separate from usage and invalidates them on compaction or backend/session switches', () => {
    const { store, conv } = fresh();
    const turn = store.startTurn(conv.id, 'task');
    store.setThread(conv.id, 'session-a');
    const sample = (threadId: string, tokens: number) => store.addEvent(turn, 'context.usage', JSON.stringify({ type: 'context.usage', backend: 'codex', thread_id: threadId, tokens, window: 200_000 }));
    sample('session-a', 120_000);
    expect(store.contextUsage(conv.id)).toEqual({ tokens: 120_000, window: 200_000 });
    store.addEvent(turn, 'context.compacted', JSON.stringify({ type: 'context.compacted', thread_id: 'session-a', native_id: 'boundary-1' }));
    expect(store.contextUsage(conv.id)).toBeNull();
    expect(store.hasContextCompaction(conv.id, 'session-a', 'boundary-1')).toBe(true);
    sample('session-a', 12_000);
    expect(store.contextUsage(conv.id)?.tokens).toBe(12_000);
    store.setThread(conv.id, 'session-b');
    expect(store.contextUsage(conv.id)).toBeNull();
    sample('session-b', 14_000);
    store.setBackend(conv.id, 'claude');
    expect(store.contextUsage(conv.id)).toBeNull();
  });

  it('creates, lists and deletes projects (cascading to conversations)', () => {
    const { store, project, conv } = fresh();
    expect(store.listProjects().map((p) => p.id)).toEqual([project.id]);
    expect(project.sandbox).toBe('workspace-write');
    expect(store.getConversation(conv.id)?.status).toBe('idle');
    store.setReview(conv.id, { request: 'x', base: 'b', rounds: 0, reviewer: '' });
    expect(store.deleteProject(project.id)).toBe(true);
    expect(store.getConversation(conv.id)).toBeNull();
    expect(store.getKv(`review:${conv.id}`)).toBeNull(); // its chats' review state goes with them
    expect(store.deleteProject(project.id)).toBe(false);
  });

  it('updates thread, status and draft', () => {
    const { store, conv } = fresh();
    store.setThread(conv.id, 't1');
    store.setStatus(conv.id, 'running');
    store.setDraft(conv.id, 'hi');
    expect(store.getConversation(conv.id)).toMatchObject({ thread_id: 't1', status: 'running', draft: 'hi' });
  });

  it('pops the queue in FIFO order and parses attachments', () => {
    const { store, conv } = fresh();
    store.enqueue(conv.id, 'one', ['/a']);
    const second = store.enqueue(conv.id, 'two', []);
    expect(store.listQueue(conv.id).map((q) => q.prompt)).toEqual(['one', 'two']);
    expect(store.popQueue(conv.id)).toMatchObject({ prompt: 'one', attachments: ['/a'] });
    expect(store.deleteQueueItem(second)).toBe(true);
    expect(store.popQueue(conv.id)).toBeNull();
  });

  it('stores turns and returns only newer events for a conversation', () => {
    const { store, conv } = fresh();
    const turn = store.startTurn(conv.id, 'p');
    const e1 = store.addEvent(turn, 'a', '{"type":"a"}');
    const e2 = store.addEvent(turn, 'b', '{"type":"b"}');
    store.endTurn(turn, 'completed', { input_tokens: 1 });
    expect(store.eventsAfter(conv.id, 0).map((e) => e.id)).toEqual([e1, e2]);
    expect(store.eventsAfter(conv.id, e1).map((e) => e.type)).toEqual(['b']);
    expect(store.listTurns(conv.id)[0]).toMatchObject({ status: 'completed', usage: '{"input_tokens":1}' });
  });

  it('keeps users, finds them by token hash, and cascades a delete to their sessions', () => {
    const { store } = fresh();
    const u = store.createUser('budi', 'dev', 'hash-1');
    expect(store.getUser(u.id)).toMatchObject({ name: 'budi', role: 'dev' });
    expect(store.getUserByTokenHash('hash-1')!.id).toBe(u.id);
    expect(store.getUserByTokenHash('nope')).toBeNull();
    expect(() => store.createUser('budi', 'admin', 'hash-2')).toThrow(); // unique name
    expect(() => store.createUser('other', 'admin', 'hash-1')).toThrow(); // unique token

    store.createSession('s1', Date.now() + 60_000, u.id);
    expect(store.getSession('s1', Date.now())).toEqual({ user_id: u.id });
    expect(store.listUsers()[0]).toMatchObject({ name: 'budi' });

    store.setUserToken(u.id, 'hash-3'); // rotating drops the old token and every session
    expect(store.getUserByTokenHash('hash-1')).toBeNull();
    expect(store.getUserByTokenHash('hash-3')!.id).toBe(u.id);
    expect(store.getSession('s1', Date.now())).toBeNull();

    store.createSession('s2', Date.now() + 60_000, u.id);
    expect(store.deleteUser(u.id)).toBe(true);
    expect(store.getSession('s2', Date.now())).toBeNull();
    expect(store.deleteUser(u.id)).toBe(false);
  });

  it('adds the user columns to a database created before roles existed', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lzvr-mig-')), 'old.db');
    const old = new DatabaseSync(file);
    old.exec(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, expires_at INTEGER NOT NULL);
              CREATE TABLE passkeys (id TEXT PRIMARY KEY, public_key BLOB NOT NULL, counter INTEGER NOT NULL, transports TEXT);
              INSERT INTO sessions VALUES ('old-session', 99999999999999);
              INSERT INTO passkeys VALUES ('old-pk', x'0102', 1, NULL);`);
    old.close();
    const store = new Store(file);
    expect(store.getSession('old-session', Date.now())).toEqual({ user_id: null }); // still valid, as the owner
    // passkey sign-in is gone, and its table with it
    expect(store.db.prepare("SELECT name FROM sqlite_master WHERE name='passkeys'").get()).toBeUndefined();
  });

  it('has indexes for sub-agents, a project\'s chats and a chat\'s queue, and dates old events once only', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lzvr-idx-')), 'i.db');
    const first = new Store(file);
    const indexes = (first.db.prepare("SELECT name FROM sqlite_master WHERE type='index'").all() as { name: string }[]).map((r) => r.name);
    expect(indexes).toEqual(expect.arrayContaining(['conversations_parent', 'conversations_project', 'queue_conversation']));
    const backfills = () => {
      const run = vi.spyOn(Store.prototype as any, 'run');
      try { new Store(file); return run.mock.calls.filter(([sql]) => String(sql).startsWith('UPDATE events SET created_at')).length; }
      finally { run.mockRestore(); }
    };
    expect(backfills()).toBe(0); // the scan of every event ran with the first start
    first.deleteKv('events_created_at_filled'); // a database from before the flag
    expect(backfills()).toBe(1);
    expect(backfills()).toBe(0);
  });

  it('resetRunning fails stale rows and reports conversations that still have a queue', () => {
    const { store, conv } = fresh();
    store.setStatus(conv.id, 'running');
    store.startTurn(conv.id, 'stale');
    store.enqueue(conv.id, 'next', []);
    expect(store.resetRunning()).toEqual([conv.id]);
    expect(store.getConversation(conv.id)?.status).toBe('failed');
    expect(store.listTurns(conv.id)[0]?.status).toBe('failed');
  });

  it('resetRunning gives each stale turn a closing event so replaying clients stop showing it as live', () => {
    const { store, conv } = fresh();
    const turn = store.startTurn(conv.id, 'stale');
    store.addEvent(turn, 'user.prompt', '{"type":"user.prompt"}');
    store.resetRunning();
    const last = store.eventsAfter(conv.id, 0).at(-1)!;
    expect(last.type).toBe('turn.failed');
    expect(JSON.parse(last.payload).error.message).toMatch(/restarted/);
    store.resetRunning(); // a second reset must not add another
    expect(store.eventsAfter(conv.id, 0)).toHaveLength(2);
  });

  it('queues the prompt a crash cut off again, to resume in its session, once', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'lzvr-crash-')), 'c.db');
    const before = new Store(file);
    const project = before.createProject('p', '/w/p');
    const conv = before.createConversation(project.id);
    before.enqueue(conv.id, 'task', ['a.txt'], 'budi', 'budi', '');
    before.enqueue(conv.id, 'next', []);
    const item = before.popQueue(conv.id)!;
    before.startTurn(conv.id, item.prompt);
    expect(before.listQueue(conv.id).map((q) => q.prompt)).toEqual(['next']); // running, so not shown as waiting
    before.db.close(); // the process dies here
    const after = new Store(file);
    expect(after.resetRunning()).toEqual([conv.id]);
    expect(after.listQueue(conv.id)).toMatchObject([{ prompt: 'task', attachments: ['a.txt'], author: 'budi', resume: true }, { prompt: 'next' }]);
    after.resetRunning();
    expect(after.listQueue(conv.id)).toHaveLength(2);
  });

  it('does not queue again a prompt whose turn ended, that shutdown queued already, or that a crash cut off before', () => {
    const { store, conv } = fresh();
    store.enqueue(conv.id, 'done', []);
    store.popQueue(conv.id);
    store.endRunning(conv.id);
    expect(store.resetRunning()).toEqual([]);
    store.enqueue(conv.id, 'shut down', []);
    store.requeueResume(store.popQueue(conv.id)!);
    store.resetRunning();
    expect(store.listQueue(conv.id).map((q) => q.prompt)).toEqual(['shut down']);
    store.resetRunning();
    store.popQueue(conv.id); // the resumed one runs and the server crashes again: it is not tried a third time
    expect(store.resetRunning()).toEqual([]);
  });
});

describe('chat backend', () => {
  it('is the chat\'s own: a project has none', () => {
    const store = new Store();
    const project = store.createProject('c', '/w/c', 'read-only');
    expect(store.getProject(project.id)).not.toHaveProperty('backend');
    expect(store.createConversation(project.id, 'claude').backend).toBe('claude');
    expect(store.createConversation(project.id).backend).toBe('codex');
  });
});

describe('global defaults per backend', () => {
  it('keeps Codex and Claude Code defaults apart', () => {
    const store = new Store();
    store.setDefaultModel('gpt-x');
    store.setDefaultModel('opus', 'claude');
    store.setDefaultEffort('high', 'claude');
    expect([store.getDefaultModel(), store.getDefaultModel('claude')]).toEqual(['gpt-x', 'opus']);
    expect([store.getDefaultEffort(), store.getDefaultEffort('claude')]).toEqual(['', 'high']);
  });
});

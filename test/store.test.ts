import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { Store } from '../src/store.js';

function fresh() {
  const store = new Store();
  const project = store.createProject('p', '/w/p');
  const conv = store.createConversation(project.id);
  return { store, project, conv };
}

describe('Store', () => {
  it('creates, lists and deletes projects (cascading to conversations)', () => {
    const { store, project, conv } = fresh();
    expect(store.listProjects().map((p) => p.id)).toEqual([project.id]);
    expect(project.sandbox).toBe('workspace-write');
    expect(store.getConversation(conv.id)?.status).toBe('idle');
    expect(store.deleteProject(project.id)).toBe(true);
    expect(store.getConversation(conv.id)).toBeNull();
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

  it('keeps users, finds them by token hash, and cascades a delete to their sessions and passkeys', () => {
    const { store } = fresh();
    const u = store.createUser('budi', 'dev', 'hash-1');
    expect(store.getUser(u.id)).toMatchObject({ name: 'budi', role: 'dev' });
    expect(store.getUserByTokenHash('hash-1')!.id).toBe(u.id);
    expect(store.getUserByTokenHash('nope')).toBeNull();
    expect(() => store.createUser('budi', 'admin', 'hash-2')).toThrow(); // unique name
    expect(() => store.createUser('other', 'admin', 'hash-1')).toThrow(); // unique token

    store.createSession('s1', Date.now() + 60_000, u.id);
    store.addPasskey({ id: 'pk', publicKey: new Uint8Array([1, 2]), counter: 3 }, u.id);
    expect(store.getSession('s1', Date.now())).toEqual({ user_id: u.id });
    expect(store.getPasskey('pk')).toMatchObject({ userId: u.id, counter: 3 });
    expect(store.listUsers()[0]).toMatchObject({ name: 'budi', passkeys: 1 });

    store.setUserToken(u.id, 'hash-3'); // rotating drops the old token and every session
    expect(store.getUserByTokenHash('hash-1')).toBeNull();
    expect(store.getUserByTokenHash('hash-3')!.id).toBe(u.id);
    expect(store.getSession('s1', Date.now())).toBeNull();

    store.createSession('s2', Date.now() + 60_000, u.id);
    expect(store.deleteUser(u.id)).toBe(true);
    expect(store.getSession('s2', Date.now())).toBeNull();
    expect(store.getPasskey('pk')).toBeNull();
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
    expect(store.getPasskey('old-pk')).toMatchObject({ userId: null, counter: 1 });
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
});

describe('project backend', () => {
  it('gives every chat of a project the project\'s backend', () => {
    const store = new Store();
    const claude = store.createProject('c', '/w/c', 'read-only', 'claude');
    expect(store.getProject(claude.id)!.backend).toBe('claude');
    expect(store.createConversation(claude.id).backend).toBe('claude');
    expect(store.createConversation(store.createProject('x', '/w/x').id).backend).toBe('codex');
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

import { beforeAll, describe, expect, it, vi } from 'vitest';

// The panel modules read these browser globals when they load.
vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
vi.stubGlobal('innerWidth', 1440);
vi.stubGlobal('innerHeight', 900);
vi.stubGlobal('addEventListener', () => {});
vi.stubGlobal('history', { replaceState() {} });
vi.stubGlobal('location', { pathname: '/', search: '' });

/* eslint-disable @typescript-eslint/no-explicit-any */
let store: any;
let inbox: any;
beforeAll(async () => {
  // @ts-expect-error The panel modules are plain JavaScript.
  store = await import('../public/js/store.js');
  // @ts-expect-error The panel modules are plain JavaScript.
  inbox = await import('../public/js/inbox.js');
});

const ids = (list: any[]) => list.map((x) => x.conv.id);

describe('chat order and the archive in the panel', () => {
  it('lists chats newest activity first, a chat never started by when it was made, and moves idle ones to the archive', () => {
    store.now.value = Date.parse('2026-11-23T12:00:00Z');
    store.projects.value = [{ id: 'p', name: 'p' }];
    store.convs.value = new Map([['p', [
      { id: 'old', parent: '', status: 'idle', last_at: '2026-11-20 09:00:00', created_at: '2026-11-01 09:00:00' },
      { id: 'recent', parent: '', status: 'idle', last_at: '2026-11-23 08:00:00', created_at: '2026-11-02 09:00:00' },
      { id: 'blank', parent: '', status: 'idle', last_at: null, created_at: '2026-11-23 11:00:00' },
      { id: 'yesterday', parent: '', status: 'idle', last_at: '2026-11-22 10:00:00', created_at: '2026-11-03 09:00:00' },
      { id: 'stale-blank', parent: '', status: 'idle', last_at: null, created_at: '2026-11-10 09:00:00' },
      // An agent that ran lately keeps the chat above it in use.
      { id: 'parent', parent: '', status: 'idle', last_at: '2026-11-15 09:00:00', created_at: '2026-11-15 08:00:00' },
      { id: 'kid', parent: 'parent', status: 'idle', last_at: '2026-11-23 07:00:00', created_at: '2026-11-15 09:00:00' },
    ]]]);

    expect(ids(inbox.allChats.value)).toEqual(['blank', 'recent', 'parent', 'yesterday', 'old', 'stale-blank']);
    expect(ids(inbox.chatLists.value.active)).toEqual(['blank', 'recent', 'parent', 'yesterday']);
    expect(ids(inbox.chatLists.value.archived)).toEqual(['old', 'stale-blank']);
    expect(ids(inbox.byStatus.value.rest)).toEqual(['blank', 'recent', 'parent', 'yesterday']);

    // Two days on, the ones untouched since go too.
    store.now.value = Date.parse('2026-11-25T07:30:00Z');
    expect(ids(inbox.chatLists.value.active)).toEqual(['blank', 'recent']);
  });

  it('keeps a chat in use while it runs or waits for an approval, however long ago it started', () => {
    store.now.value = Date.parse('2026-11-23T12:00:00Z');
    store.projects.value = [{ id: 'p', name: 'p' }];
    store.convs.value = new Map([['p', [
      { id: 'running', parent: '', status: 'running', last_at: '2026-11-01 09:00:00' },
      { id: 'waiting', parent: '', status: 'idle', last_at: '2026-11-01 08:00:00' },
      { id: 'idle', parent: '', status: 'idle', last_at: '2026-11-01 07:00:00' },
    ]]]);
    store.approvals.value = [{ id: 1, to_conv: 'waiting' }];
    try {
      expect(ids(inbox.chatLists.value.active)).toEqual(['running', 'waiting']);
      expect(ids(inbox.chatLists.value.archived)).toEqual(['idle']);
    } finally { store.approvals.value = []; }
  });
});

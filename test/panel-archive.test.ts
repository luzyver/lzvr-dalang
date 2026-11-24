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
      { id: 'recent', parent: '', status: 'idle', last_at: '2026-11-23 10:30:00', created_at: '2026-11-02 09:00:00' },
      { id: 'blank', parent: '', status: 'idle', last_at: null, created_at: '2026-11-23 11:00:00' },
      { id: 'yesterday', parent: '', status: 'idle', last_at: '2026-11-22 10:00:00', created_at: '2026-11-03 09:00:00' },
      { id: 'stale-blank', parent: '', status: 'idle', last_at: null, created_at: '2026-11-10 09:00:00' },
      // An agent that ran lately keeps the chat above it in use.
      { id: 'parent', parent: '', status: 'idle', last_at: '2026-11-15 09:00:00', created_at: '2026-11-15 08:00:00' },
      { id: 'kid', parent: 'parent', status: 'idle', last_at: '2026-11-23 09:00:01', created_at: '2026-11-15 09:00:00' },
    ]]]);

    expect(ids(inbox.allChats.value)).toEqual(['blank', 'recent', 'parent', 'yesterday', 'old', 'stale-blank']);
    expect(ids(inbox.chatLists.value.active)).toEqual(['blank', 'recent', 'parent']);
    expect(ids(inbox.chatLists.value.archived)).toEqual(['yesterday', 'old', 'stale-blank']);
    expect(ids(inbox.byStatus.value.rest)).toEqual(['blank', 'recent', 'parent']);

    // A minute later the parent crosses the three-hour threshold.
    store.now.value = Date.parse('2026-11-23T12:01:00Z');
    expect(ids(inbox.chatLists.value.active)).toEqual(['blank', 'recent']);
  });

  it('archives a recent chat until new activity and gives restored chats a fresh idle period', () => {
    store.now.value = Date.parse('2026-11-23T12:00:00Z');
    const x = { conv: { archived_at: '2026-11-23 11:00:00' }, agents: [], at: '2026-11-23 10:00:00' };
    expect(inbox.isArchived(x)).toBe(true);
    expect(inbox.isArchived({ ...x, at: '2026-11-23 11:01:00' })).toBe(false);
    const restored = { ...x, conv: { restored_at: '2026-11-23 11:00:00' }, at: '2026-11-01 10:00:00' };
    expect(inbox.isArchived(restored)).toBe(false);
    store.now.value += inbox.ARCHIVE_AFTER;
    expect(inbox.isArchived(restored)).toBe(true);
  });

  it('uses descendant drafts and restores in the family archive clock', () => {
    store.now.value = Date.parse('2026-11-23T12:00:00Z');
    const root = { archived_at: '2026-11-22 11:30:00', created_at: '2026-11-01 10:00:00' };
    for (const child of [{ restored_at: '2026-11-23 11:00:00' }, { draft_updated_at: '2026-11-23 11:00:00' }]) {
      const chat = { conv: root, agents: [child], at: inbox.lastActive(root, [child]) };
      expect(inbox.isArchived(chat)).toBe(false);
    }
  });

  it.each(['sending', 'unknown'])('blocks archiving while a descendant has a %s ClickUp approval', (status) => {
    const chat = { id: 'parent', status: 'idle' };
    const child = { id: 'child', status: 'idle' };
    store.clickupApprovals.value = [{ conv: child.id, status }];
    try {
      expect(inbox.canArchive(chat, [child])).toBe(false);
      store.clickupApprovals.value = [];
      expect(inbox.canArchive(chat, [child])).toBe(true);
    } finally { store.clickupApprovals.value = []; }
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

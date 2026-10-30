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
let view: any;
beforeAll(async () => {
  // @ts-expect-error The panel modules are plain JavaScript.
  store = await import('../public/js/store.js');
  // @ts-expect-error The panel modules are plain JavaScript.
  view = await import('../public/js/chat-view.js');
});

describe('unread chats in the panel', () => {
  it("marks a turn watched to its end as read when its details arrive after another chat opened", async () => {
    store.projects.value = [{ id: 'p' }];
    store.convs.value = new Map([['p', [
      { id: 'a', status: 'running', last_at: '2026-10-30 09:00:00' },
      { id: 'b', status: 'idle', last_at: '2026-10-30 08:00:00' },
    ]]]);
    store.seen.value = { a: '2026-10-30 09:00:00', b: '2026-10-30 08:00:00' };
    store.openChat('a');
    view.chat.id.value = 'a';

    // The turn in chat a ends on screen; its details are slow to come back.
    let answer!: (v: unknown) => void;
    vi.stubGlobal('fetch', () => new Promise((resolve) => { answer = resolve; }));
    const refreshed = view.refreshConv('a', true);

    // Chat b opens before they do.
    store.openChat('b');
    view.chat.id.value = 'b';
    const details = { id: 'a', status: 'idle', last_at: '2026-10-30 09:05:00' };
    answer({ ok: true, status: 200, json: async () => details });
    await refreshed;

    expect(store.findConv('a').conv).toMatchObject({ status: 'idle', last_at: '2026-10-30 09:05:00' });
    expect(store.seen.value.a).toBe('2026-10-30 09:05:00');
    expect(view.chat.conv.value?.id).not.toBe('a'); // chat b's view keeps its own details
  });

  it('leaves a chat unread when its turn ended while it was not open', async () => {
    store.openChat('b');
    view.chat.id.value = 'b';
    vi.stubGlobal('fetch', async () => ({ ok: true, status: 200, json: async () => ({ id: 'a', status: 'idle', last_at: '2026-10-30 09:10:00' }) }));
    await view.refreshConv('a');
    expect(store.findConv('a').conv.last_at).toBe('2026-10-30 09:10:00');
    expect(store.seen.value.a).toBe('2026-10-30 09:05:00');
  });

  it('keeps the newer details when two refreshes of a watched turn come back in reverse order', async () => {
    store.openChat('a');
    view.chat.id.value = 'a';
    const answers: Array<(v: unknown) => void> = [];
    vi.stubGlobal('fetch', () => new Promise((resolve) => { answers.push(resolve); }));
    const reply = (last_at: string) => ({ ok: true, status: 200, json: async () => ({ id: 'a', status: 'idle', last_at }) });
    // turn.status and turn.completed each ask for the details; the second answer comes back first.
    const older = view.refreshConv('a', true);
    const newer = view.refreshConv('a', true);
    answers[1]!(reply('2026-10-30 09:20:00'));
    await newer;
    store.openChat('b');
    view.chat.id.value = 'b';
    answers[0]!(reply('2026-10-30 09:15:00'));
    await older;

    expect(store.findConv('a').conv.last_at).toBe('2026-10-30 09:20:00');
    expect(store.seen.value.a).toBe('2026-10-30 09:20:00');
  });
});

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
let family: any;
let inbox: any;
let turns: any;
beforeAll(async () => {
  // @ts-expect-error The panel modules are plain JavaScript.
  store = await import('../public/js/store.js');
  // @ts-expect-error The panel modules are plain JavaScript.
  family = await import('../public/js/chat-family.js');
  // @ts-expect-error The panel modules are plain JavaScript.
  inbox = await import('../public/js/inbox.js');
  // @ts-expect-error The panel modules are plain JavaScript.
  turns = await import('../public/js/agent-turns.js');
});

describe('sub-agents in the panel', () => {
  it('keeps a sub-agent started in another project under the chat that started it', () => {
    store.projects.value = [{ id: 'A', name: 'a' }, { id: 'B', name: 'b' }];
    store.convs.value = new Map([
      ['A', [{ id: 'top', parent: '', status: 'idle', last_at: '2026-11-03 09:00:00' }]],
      ['B', [
        { id: 'sub', parent: 'top', status: 'running', last_at: '2026-11-03 09:01:00' },
        { id: 'leaf', parent: 'sub', status: 'idle', last_at: '2026-11-03 09:02:00' },
        { id: 'own', parent: '', status: 'idle', last_at: '2026-11-03 08:00:00' },
        { id: 'orphan', parent: 'gone', status: 'idle', last_at: '2026-11-03 07:00:00' },
      ]],
    ]);

    expect(inbox.allChats.value.map((x: any) => [x.project.id, x.conv.id, x.agents.map((a: any) => a.id)])).toEqual([
      ['A', 'top', ['sub', 'leaf']],
      ['B', 'own', []],
      ['B', 'orphan', []],
    ]);
    expect(family.rootOf('leaf')).toMatchObject({ project: { id: 'A' }, conv: { id: 'top' } });
    // The running sub-agent in project B makes the chat in project A count as running.
    expect(inbox.byStatus.value.running.map((x: any) => x.conv.id)).toEqual(['top']);
  });

  it('lists an agent under every turn that put it to work, and the ones no turn is known for apart', () => {
    const agents = [{ id: 'sub' }, { id: 'leaf' }, { id: 'rev', role: 'reviewer' }, { id: 'old' }];
    const links = [{ turn: 2, conv: 'sub' }, { turn: 2, conv: 'leaf' }, { turn: 5, conv: 'rev' }, { turn: 7, conv: 'rev' },
      { turn: 7, conv: 'gone' }];
    const by = turns.agentsByTurn(links, agents);
    const ids = (k: number | null) => (by.get(k) || []).map((c: any) => c.id);
    expect([ids(2), ids(5), ids(7), ids(null)]).toEqual([['sub', 'leaf'], ['rev'], ['rev'], ['old']]);
  });

  it('stops at a loop in the parents', () => {
    store.projects.value = [{ id: 'A', name: 'a' }];
    store.convs.value = new Map([['A', [{ id: 'x', parent: 'y' }, { id: 'y', parent: 'x' }]]]);
    expect(family.descendants('x').map((c: any) => c.id)).toEqual(['y']);
    expect(family.rootOf('x')).not.toBeNull();
  });
});

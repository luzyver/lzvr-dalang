import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.js';
import { Store } from '../src/store.js';
import { turnsDone, until } from './helpers.js';

const FAKE_CLAUDE = [process.execPath, fileURLToPath(new URL('./fake-claude.mjs', import.meta.url))];

function setup(env: Record<string, string> = {}, homeNames = ['a']) {
  const dir = mkdtempSync(join(tmpdir(), 'lzvr-claude-'));
  const store = new Store();
  const dispatcher = new Dispatcher(store, { homes: [], claudeHomes: homeNames.map((n) => join(dir, n)), claudeCommand: FAKE_CLAUDE, env });
  const conv = store.createConversation(store.createProject('p', dir).id, 'claude');
  return { store, dispatcher, conv };
}

describe('Dispatcher with the claude backend', () => {
  it('runs a turn through Claude Code and records the session', async () => {
    const { store, dispatcher, conv } = setup();
    store.enqueue(conv.id, 'hello', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]).toMatchObject({ status: 'completed' });
    expect(store.getConversation(conv.id)!.thread_id).toBe('sess-1');
    const events = store.eventsAfter(conv.id, 0);
    expect(events.map((e) => e.type)).toEqual(expect.arrayContaining(['thread.started', 'item.started', 'item.completed', 'turn.completed']));
    expect(events.some((e) => e.payload.includes('echo:hello|a'))).toBe(true);
  });

  it('moves the same turn to the next Claude account at a usage limit', async () => {
    const { store, dispatcher, conv } = setup({ FAKE_LIMIT_HOMES: 'a' }, ['a', 'b']);
    store.enqueue(conv.id, 'hi', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]).toMatchObject({ status: 'completed' });
    const types = store.eventsAfter(conv.id, 0).map((e) => e.type);
    expect(types).toContain('account.switched');
    expect(dispatcher.claudeAccounts.list().find((a) => a.name === 'a')!.blockedUntil).not.toBeNull();
  });

  it('says so when no Claude account exists', async () => {
    const { store, dispatcher, conv } = setup({}, []);
    store.enqueue(conv.id, 'hi', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]).toMatchObject({ status: 'failed' });
    expect(store.eventsAfter(conv.id, 0).some((e) => e.payload.includes('no Claude Code account'))).toBe(true);
  });

  it('skips a switched-off account and keeps the usage the CLI reported', async () => {
    const { store, dispatcher, conv } = setup({}, ['a', 'b']);
    expect(dispatcher.setEnabled('claude', 'a', false)).toBe(true);
    expect(dispatcher.setEnabled('claude', 'nope', false)).toBe(false);
    store.enqueue(conv.id, 'hi', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.eventsAfter(conv.id, 0).some((e) => e.payload.includes('echo:hi|b'))).toBe(true);
    expect(dispatcher.limitsFor('claude', 'b')?.windows).toEqual([{ label: '5h', usedPercent: 12.5, resetsAt: 2000000000 }]);
    expect(store.eventsAfter(conv.id, 0).some((e) => e.type === 'account.limits')).toBe(false); // not shown in the chat
    dispatcher.setEnabled('claude', 'a', true);
    dispatcher.loadDisabled(); // nothing saved as off any more
    expect(dispatcher.claudeAccounts.list().every((x) => x.enabled)).toBe(true);
  });
});

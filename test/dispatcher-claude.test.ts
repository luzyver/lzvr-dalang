import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs';
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
  it('passes the native window to Claude and keeps the session through compaction', async () => {
    const env = { FAKE_CONTEXT: JSON.stringify({ tokens: 90_000, window: 200_000 }) };
    const { store, dispatcher, conv } = setup(env);
    store.enqueue(conv.id, 'first', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.contextUsage(conv.id)).toEqual({ tokens: 90_000, window: 200_000 });
    expect(store.eventsAfter(conv.id, 0).some((e) => e.payload.includes('compact-window:100000'))).toBe(true);
    env.FAKE_CONTEXT = JSON.stringify({ tokens: 12_000, window: 200_000, compacted: true });
    store.enqueue(conv.id, 'second', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    expect(store.contextUsage(conv.id)).toEqual({ tokens: 12_000, window: 200_000 });
    expect(store.getConversation(conv.id)!.thread_id).toBe('sess-1');
    expect(store.eventsAfter(conv.id, 0).filter((e) => e.type === 'context.compacted')).toHaveLength(1);
  });

  it('preserves Claude environment settings when Dalang compaction is opted out', async () => {
    const env = { FAKE_CONTEXT: JSON.stringify({ tokens: 12_000 }), CLAUDE_CODE_AUTO_COMPACT_WINDOW: '250000' };
    const { store, conv, dispatcher: original } = setup(env);
    const dispatcher = new Dispatcher(store, { homes: [], claudeHomes: original.claudeAccounts.homes, claudeCommand: FAKE_CLAUDE, contextCompactTokens: 0, env });
    store.enqueue(conv.id, 'task', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const payloads = store.eventsAfter(conv.id, 0).map((e) => e.payload).join('\n');
    expect(payloads).toContain('compact-window:250000');
    expect(payloads).not.toContain('When compacting context');
  });

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

  it('appends the orchestrator guide to the system prompt when agents decide on sub-agents themselves', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lzvr-claude-'));
    const store = new Store();
    const dispatcher = new Dispatcher(store, { homes: [], claudeHomes: [join(dir, 'a')], claudeCommand: FAKE_CLAUDE, mcpUrl: 'http://127.0.0.1:9876/mcp' });
    const conv = store.createConversation(store.createProject('p', dir).id, 'claude');
    store.setSubagentPolicy({ ...store.getSubagentPolicy(), mode: 'auto' });
    store.enqueue(conv.id, 'hello', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.eventsAfter(conv.id, 0).some((e) => e.payload.includes('|system:You are running inside Dalang'))).toBe(true);
  });

  it('gives a Claude Code turn the code memory hooks and their environment', async () => {
    const { store, dispatcher, conv } = setup();
    const project = store.getProject(conv.project_id)!;
    dispatcher.codeMemory = {
      guide: () => '',
      hooks: (p, backend) => (p.id === project.id && backend === 'claude' ? { args: ['--settings', '{"hooks":{}}'], env: { LZVR_CODE_ROOT: p.path } } : null),
    };
    store.enqueue(conv.id, 'hello', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const texts = store.eventsAfter(conv.id, 0).map((e) => String(JSON.parse(e.payload).item?.text ?? ''));
    expect(texts.some((t) => t.includes(`|settings:{"hooks":{}}|root:${project.path}`))).toBe(true);
  });

  it("offers Dalang's skills: listed in the system prompt (a file, past Windows' command-line limit), their folder readable", async () => {
    const dir = mkdtempSync(join(tmpdir(), 'lzvr-claude-'));
    const skillsDir = join(dir, 'skills');
    mkdirSync(join(skillsDir, 'charts'), { recursive: true });
    writeFileSync(join(skillsDir, 'charts', 'SKILL.md'), '---\nname: charts\ndescription: Draw charts\n---\nbody');
    const store = new Store();
    const dispatcher = new Dispatcher(store, { homes: [], claudeHomes: [join(dir, 'a')], claudeCommand: FAKE_CLAUDE, skillsDir });
    const conv = store.createConversation(store.createProject('p', dir).id, 'claude');
    store.enqueue(conv.id, 'hello', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const texts = store.eventsAfter(conv.id, 0).map((e) => String(JSON.parse(e.payload).item?.text ?? ''));
    expect(texts.some((t) => t.includes('Check them FIRST') && t.includes('- charts (') && t.includes(`|--add-dir=${skillsDir}`))).toBe(true);
    expect(readdirSync(join(dir, 'a')).filter((f) => f.startsWith('dalang-'))).toEqual([]); // the guide file is gone after the turn
  });

  it('moves the same turn to the next Claude account at a usage limit', async () => {
    const { store, dispatcher, conv } = setup({ FAKE_LIMIT_HOMES: 'a' }, ['a', 'b']);
    store.enqueue(conv.id, 'hi', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]).toMatchObject({ status: 'completed' });
    const types = store.eventsAfter(conv.id, 0).map((e) => e.type);
    expect(types).toContain('account.switched');
    // Blocked until the reset Claude Code reported (two hours on), not the default hour.
    const blockedUntil = dispatcher.claudeAccounts.list().find((a) => a.name === 'a')!.blockedUntil!;
    expect(blockedUntil - Date.now()).toBeGreaterThan(110 * 60_000);
    expect(blockedUntil - Date.now()).toBeLessThanOrEqual(2 * 3_600_000);
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

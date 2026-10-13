import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.js';
import { FAKE, turnsDone, until } from './helpers.js';
import { setupDispatcher } from './setup.js';

describe('Dispatcher', () => {
  it('runs a queued prompt and records thread, usage and events', async () => {
    const { store, dispatcher, conv } = setupDispatcher();
    store.enqueue(conv.id, 'hello', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const [turn] = store.listTurns(conv.id);
    expect(turn).toMatchObject({ status: 'completed', prompt: 'hello' });
    expect(turn!.usage).toContain('input_tokens');
    expect(store.getConversation(conv.id)).toMatchObject({ status: 'idle' });
    expect(store.getConversation(conv.id)!.thread_id).toMatch(/^thread-/);
    expect(store.eventsAfter(conv.id, 0).map((e) => e.type)).toContain('turn.completed');
  });

  it('serializes back-to-back prompts in order and resumes the same thread', async () => {
    const { store, dispatcher, conv } = setupDispatcher();
    store.enqueue(conv.id, 'one', []);
    store.enqueue(conv.id, 'two', []);
    dispatcher.kick(conv.id);
    dispatcher.kick(conv.id); // a second kick while busy must not start a second process
    await until(() => turnsDone(store, conv.id, 2));
    const turns = store.listTurns(conv.id);
    expect(turns.map((t) => t.prompt)).toEqual(['one', 'two']);
    expect(turns.every((t) => t.status === 'completed')).toBe(true);
    const threads = store.eventsAfter(conv.id, 0)
      .filter((e) => e.type === 'thread.started')
      .map((e) => (JSON.parse(e.payload) as { thread_id: string }).thread_id);
    expect(threads).toHaveLength(2);
    expect(threads[1]).toBe(threads[0]);
    expect(store.getConversation(conv.id)!.thread_id).toBe(threads[0]);
  });

  it('marks the turn and conversation failed when codex fails', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_MODE: 'fail' });
    store.enqueue(conv.id, 'x', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]!.status).toBe('failed');
    expect(store.getConversation(conv.id)!.status).toBe('failed');
  });

  it('does not wedge the worker when the binary is missing', async () => {
    const { store, dispatcher, conv } = setupDispatcher({}, ['lzvr-no-such-binary']);
    store.enqueue(conv.id, 'a', []);
    store.enqueue(conv.id, 'b', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    expect(store.listTurns(conv.id).map((t) => t.status)).toEqual(['failed', 'failed']);
    expect(store.listQueue(conv.id)).toEqual([]);
  });

  it('cancels the running turn', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_MODE: 'slow' });
    store.enqueue(conv.id, 'x', []);
    dispatcher.kick(conv.id);
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'turn.started'));
    expect(dispatcher.cancel(conv.id)).toBe(true);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]!.status).toBe('cancelled');
    expect(store.getConversation(conv.id)!.status).toBe('idle');
    expect(dispatcher.cancel(conv.id)).toBe(false);
  });

  it('passes images with -i and lists other files in the prompt', async () => {
    const { store, dispatcher, conv, dir } = setupDispatcher();
    const png = join(dir, 'a.png');
    const txt = join(dir, 'notes.txt');
    store.enqueue(conv.id, 'see', [png, txt]);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const ev = store.eventsAfter(conv.id, 0).find((e) => e.type === 'item.completed')!;
    const { item } = JSON.parse(ev.payload) as { item: { text: string; args: string[] } };
    expect(item.args).toContain(png);
    expect(item.args.indexOf('-i')).toBeGreaterThan(-1);
    expect(item.text).toContain('Attached files:');
    expect(item.text).toContain(txt);
    expect(item.text).not.toContain(png);
  });

  it('fails over to the next account on a usage limit and resumes the same thread', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_LIMIT_HOMES: 'a' }, undefined, ['a', 'b']);
    store.enqueue(conv.id, 'one', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]!.status).toBe('completed');
    const ev = store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload) as Record<string, any>);
    expect(ev.filter((e) => e.type === 'account.switched').map((e) => e.from)).toEqual(['a']);
    expect(ev.filter((e) => e.type === 'account.selected').map((e) => e.account)).toEqual(['a', 'b']);
    const threads = ev.filter((e) => e.type === 'thread.started').map((e) => e.thread_id);
    expect(threads).toHaveLength(2);
    expect(threads[1]).toBe(threads[0]); // second attempt resumed the thread started on account a
    expect(String(ev.find((e) => e.type === 'item.completed')!.item.home)).toMatch(/b$/);

    // account a is now blocked, so the next prompt goes straight to b
    store.enqueue(conv.id, 'two', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    const all = store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload) as Record<string, any>);
    expect(all.filter((e) => e.type === 'account.switched')).toHaveLength(1);
    expect(dispatcher.accounts.list()[0]!.blockedUntil).not.toBeNull();
  });

  it('says to add an account when none has been set up yet, instead of blaming a usage limit', async () => {
    const { store, dispatcher, conv } = setupDispatcher({}, undefined, []);
    store.enqueue(conv.id, 'hello', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]!.status).toBe('failed');
    const ev = store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload) as Record<string, any>)
      .find((e) => e.type === 'account.exhausted')!;
    expect(ev.message).toMatch(/no Codex account/i);
    expect(ev.message).toMatch(/\+ Account|add/i);
    expect(ev.message).not.toMatch(/usage limit/i);
    expect(dispatcher.accounts.list()).toEqual([]);
  });

  it('after a limit hit mid-turn, tells the next account to continue instead of repeating the whole request', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_LIMIT_HOMES: 'a', FAKE_LIMIT_AFTER_WORK: '1' }, undefined, ['a', 'b']);
    store.enqueue(conv.id, 'deploy the thing', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const msgs = store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload) as Record<string, any>)
      .filter((e) => e.type === 'item.completed' && e.item.type === 'agent_message');
    expect(msgs).toHaveLength(1); // account a failed before answering; account b answered
    expect(msgs[0]!.item.text).toMatch(/^Continue where you left off/);
    expect(msgs[0]!.item.text).toContain('deploy the thing');
    expect(msgs[0]!.item.text).toMatch(/do not repeat/i);
  });

  it('re-sends the original prompt unchanged when the limit hit before any work happened', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_LIMIT_HOMES: 'a' }, undefined, ['a', 'b']);
    store.enqueue(conv.id, 'plain request', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const msg = store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload) as Record<string, any>)
      .find((e) => e.type === 'item.completed' && e.item.type === 'agent_message')!;
    expect(msg.item.text).toBe('plain request');
  });

  it('blocks the limited account for as long as the message says', async () => {
    const { store, dispatcher, conv } = setupDispatcher(
      { FAKE_LIMIT_HOMES: 'a', FAKE_LIMIT_MESSAGE: 'usage limit reached, try again in 5 minutes' }, undefined, ['a', 'b']);
    store.enqueue(conv.id, 'x', []);
    const before = Date.now();
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const until_ = dispatcher.accounts.list()[0]!.blockedUntil!;
    expect(until_ - before).toBeGreaterThanOrEqual(5 * 60_000 - 50);
    expect(until_ - before).toBeLessThan(5 * 60_000 + 5_000); // not the 60 minute default
  });

  it('gives the agent a per-turn MCP token and config, and keeps the gateway token away from it', async () => {
    const saved = process.env.LZVR_TOKEN;
    process.env.LZVR_TOKEN = 'must-not-reach-codex';
    try {
      const { dir, store, conv } = setupDispatcher();
      const d = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE, mcpUrl: 'http://127.0.0.1:9876/mcp' });
      store.enqueue(conv.id, 'x', []);
      d.kick(conv.id);
      await until(() => turnsDone(store, conv.id, 1));
      const ev = store.eventsAfter(conv.id, 0).find((e) => e.type === 'item.completed')!;
      const { item } = JSON.parse(ev.payload) as { item: { args: string[]; mcpToken: string; leaked?: string } };
      expect(item.mcpToken).toMatch(/^[0-9a-f]{64}$/);
      expect(item.leaked).toBeUndefined();
      expect(item.args).toContain('mcp_servers.dalang.url="http://127.0.0.1:9876/mcp"');
      expect(item.args).toContain('mcp_servers.dalang.bearer_token_env_var="LZVR_MCP_TOKEN"');
      expect(d.mcpConversation(item.mcpToken)).toBeNull(); // revoked once the turn ended
    } finally {
      if (saved === undefined) delete process.env.LZVR_TOKEN; else process.env.LZVR_TOKEN = saved;
    }
  });

  it('adds no MCP config unless an MCP url is configured', async () => {
    const { store, dispatcher, conv } = setupDispatcher();
    store.enqueue(conv.id, 'x', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const ev = store.eventsAfter(conv.id, 0).find((e) => e.type === 'item.completed')!;
    const { item } = JSON.parse(ev.payload) as { item: { args: string[]; mcpToken?: string } };
    expect(item.args.some((a) => a.includes('mcp_servers'))).toBe(false);
    expect(item.mcpToken).toBeUndefined();
  });

  it('issues MCP tokens bound to one conversation and revokes them', () => {
    const { dispatcher, conv } = setupDispatcher();
    const t = dispatcher.issueMcpToken(conv.id);
    expect(dispatcher.mcpConversation(t)).toBe(conv.id);
    expect(dispatcher.mcpConversation('nope')).toBeNull();
    dispatcher.revokeMcpToken(t);
    expect(dispatcher.mcpConversation(t)).toBeNull();
  });

  it('fails the turn when every account is at its limit, and stays failed fast afterwards', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_LIMIT_HOMES: 'a,b' }, undefined, ['a', 'b']);
    store.enqueue(conv.id, 'one', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]!.status).toBe('failed');
    expect(store.getConversation(conv.id)!.status).toBe('failed');
    expect(store.eventsAfter(conv.id, 0).map((e) => e.type)).toContain('account.exhausted');

    store.enqueue(conv.id, 'two', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    expect(store.listTurns(conv.id)[1]!.status).toBe('failed');
    dispatcher.accounts.unblockAll();
    expect(dispatcher.accounts.pick()).not.toBeNull();
  });

  it('does not switch accounts for an ordinary failure', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_MODE: 'fail' }, undefined, ['a', 'b']);
    store.enqueue(conv.id, 'x', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const types = store.eventsAfter(conv.id, 0).map((e) => e.type);
    expect(types).not.toContain('account.switched');
    expect(store.listTurns(conv.id)[0]!.status).toBe('failed');
  });

  it('stores each event exactly as Codex printed it', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_MODE: 'rawline' });
    store.enqueue(conv.id, 'x', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const stored = store.eventsAfter(conv.id, 0).find((e) => e.type === 'item.completed')!;
    expect(stored.payload).toContain('12345678901234567890'); // JSON.stringify(JSON.parse(..)) would round this
  });

  it('shutdown interrupts running turns', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_MODE: 'slow' });
    store.enqueue(conv.id, 'long task', []);
    dispatcher.kick(conv.id);
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'turn.started'));
    await dispatcher.shutdown();
    expect(store.listTurns(conv.id)[0]!.status).toBe('interrupted');
    expect(store.getConversation(conv.id)).toMatchObject({ status: 'idle' });
    expect(store.listQueue(conv.id)).toEqual([]);
    store.enqueue(conv.id, 'after', []);
    dispatcher.kick(conv.id); // a stopped dispatcher starts nothing new
    await new Promise((r) => setTimeout(r, 100));
    expect(store.listTurns(conv.id)).toHaveLength(1);
  });

  it('delivers live events to subscribers until they unsubscribe', async () => {
    const { store, dispatcher, conv } = setupDispatcher();
    const seen: string[] = [];
    const off = dispatcher.subscribe(conv.id, (e) => seen.push(e.type));
    store.enqueue(conv.id, 'x', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(seen).toContain('turn.completed');
    off();
    const n = seen.length;
    store.enqueue(conv.id, 'y', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    expect(seen).toHaveLength(n);
  });
});

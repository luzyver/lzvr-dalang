import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { saveConnections } from '../src/databases.js';
import { Dispatcher } from '../src/dispatcher.js';
import { FAKE, turnsDone, until } from './helpers.js';
import { setupDispatcher } from './setup.js';

describe('Dispatcher', () => {
  it('persists changes to the effective agent/model with the turn that starts using them', async () => {
    const { store, dispatcher, conv, dir } = setupDispatcher();
    store.setDefaultModel('gpt-small');
    const run = async (worker: Dispatcher, n: number) => {
      store.enqueue(conv.id, `question ${n}`, []);
      worker.kick(conv.id);
      await until(() => turnsDone(store, conv.id, n));
    };
    await run(dispatcher, 1);
    store.setModel(conv.id, 'gpt-big');
    await run(dispatcher, 2);
    await run(dispatcher, 3); // the same selection is not another change
    store.setModel(conv.id, '');
    store.setDefaultModel('gpt-new-default');
    // A fresh dispatcher still compares against the selection stored in history.
    const restarted = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE });
    await run(restarted, 4);
    store.setBackend(conv.id, 'claude');
    store.setDefaultModel('sonnet', 'claude');
    await run(restarted, 5); // even an unavailable backend records the selection of its attempted turn

    const selections = store.eventsAfter(conv.id, 0).filter((e) => e.type === 'turn.selection').map((e) => JSON.parse(e.payload));
    expect(selections).toEqual([
      { type: 'turn.selection', current: { backend: 'codex', model: 'gpt-small' } },
      { type: 'turn.selection', current: { backend: 'codex', model: 'gpt-big' }, previous: { backend: 'codex', model: 'gpt-small' } },
      { type: 'turn.selection', current: { backend: 'codex', model: 'gpt-big' } },
      { type: 'turn.selection', current: { backend: 'codex', model: 'gpt-new-default' }, previous: { backend: 'codex', model: 'gpt-big' } },
      { type: 'turn.selection', current: { backend: 'claude', model: 'sonnet' }, previous: { backend: 'codex', model: 'gpt-new-default' } },
    ]);
    const latest = store.historyPage(conv.id, { turns: 1 }).events;
    expect(latest[0]?.type).toBe('turn.selection');
    expect(JSON.parse(latest[0]!.payload).previous).toEqual({ backend: 'codex', model: 'gpt-new-default' });
    expect(latest[1]?.type).toBe('user.prompt');
  });

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
    const events = store.eventsAfter(conv.id, 0);
    expect(events.map((e) => e.type)).toContain('turn.completed');
    expect(events.at(-1)).toMatchObject({ type: 'turn.status', payload: JSON.stringify({ type: 'turn.status', status: 'idle' }) });
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
    expect(store.eventsAfter(conv.id, 0).at(-1)).toMatchObject({
      type: 'turn.status', payload: JSON.stringify({ type: 'turn.status', status: 'failed' }),
    });
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

  it('after a move to another CLI, starts a new session told the chat so far', async () => {
    const { store, dispatcher, conv } = setupDispatcher();
    store.enqueue(conv.id, 'first question', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    const before = store.getConversation(conv.id)!.thread_id;
    store.setModel(conv.id, 'gpt-5-codex');
    store.setBackend(conv.id, 'claude');
    expect(store.getConversation(conv.id)).toMatchObject({ backend: 'claude', thread_id: null, model: '', effort: '' });
    store.setBackend(conv.id, 'codex'); // back again: still a new session (the fake only plays Codex)
    store.enqueue(conv.id, 'second question', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    const msgs = store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload) as Record<string, any>)
      .filter((e) => e.type === 'item.completed' && e.item.type === 'agent_message').map((e) => e.item.text as string);
    expect(msgs[0]).toBe('first question'); // a chat's first turn gets no history
    expect(msgs[1]).toContain('<earlier_turns>');
    expect(msgs[1]).toContain('Asked:\nfirst question\n\nAnswered:\nfirst question');
    expect(msgs[1]).toMatch(/New request:\nsecond question$/);
    expect(store.getConversation(conv.id)!.thread_id).not.toBe(before);
  });

  it('uses compact recoverable history only when starting a new session with MCP available', async () => {
    const { store, conv, dispatcher: original } = setupDispatcher();
    const dispatcher = new Dispatcher(store, { homes: original.accounts.homes, command: FAKE, mcpUrl: 'http://127.0.0.1:9876/mcp' });
    const run = async (prompt: string, count: number) => {
      store.enqueue(conv.id, prompt, []);
      dispatcher.kick(conv.id);
      await until(() => turnsDone(store, conv.id, count));
    };
    await run('first task', 1);
    store.setBackend(conv.id, 'claude');
    store.setBackend(conv.id, 'codex');
    await run('continue task', 2);
    await run('ordinary follow-up', 3);
    const answers = store.eventsAfter(conv.id, 0).map((e) => JSON.parse(e.payload))
      .filter((e) => e.item?.type === 'agent_message').map((e) => e.item.text);
    expect(answers[1]).toContain('Asked:\nfirst task\n\nAnswered:\nfirst task');
    expect(answers[1]).toContain('messages_only=true');
    expect(answers[1]).toContain(`conversation_id="${conv.id}"`);
    expect(answers[1]).toContain(`before_turn=${store.listTurns(conv.id)[1]!.id}`);
    expect(answers[2]).toBe('ordinary follow-up'); // resumed sessions already carry their context
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
      expect(item.args).toContain('mcp_servers.dalang.default_tools_approval_mode="approve"');
      expect(d.mcpConversation(item.mcpToken)).toBeNull(); // revoked once the turn ended
    } finally {
      if (saved === undefined) delete process.env.LZVR_TOKEN; else process.env.LZVR_TOKEN = saved;
    }
  });

  it('tells a turn how to start sub-agents only when agents decide themselves and the chat still may', async () => {
    const { dir, store, conv } = setupDispatcher();
    store.setAgentGit({ commit: true, push: true }); // no git guide either, so only this one is in the instructions
    const d = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE, mcpUrl: 'http://127.0.0.1:9876/mcp' });
    const argsOf = async (id: string, n: number) => {
      store.enqueue(id, 'x', []);
      d.kick(id);
      await until(() => turnsDone(store, id, n));
      const ev = store.eventsAfter(id, 0).filter((e) => e.type === 'item.completed').at(-1)!;
      return (JSON.parse(ev.payload) as { item: { args: string[] } }).item.args;
    };
    const guideArg = (args: string[]) => args.find((a) => a.startsWith('developer_instructions='));
    expect(guideArg(await argsOf(conv.id, 1))).toBeUndefined(); // 'asked' is the default

    store.setSubagentPolicy({ ...store.getSubagentPolicy(), mode: 'auto', maxDepth: 1 });
    store.setAgentModels(['small', 'big']);
    const arg = guideArg(await argsOf(conv.id, 2))!;
    const text = JSON.parse(arg.slice('developer_instructions='.length)) as string;
    expect(text).toContain('create_conversation');
    expect(text).toContain(`project_id ${conv.project_id}; 5 more sub-agent(s) allowed`);
    expect(text).toContain('weakest first: small, big');

    // A sub-agent at the depth limit is not told, and an admin's own guide replaces the built-in one.
    const sub = store.createConversation(conv.project_id, undefined, conv.id);
    expect(guideArg(await argsOf(sub.id, 1))).toBeUndefined();
    store.setSubagentPolicy({ ...store.getSubagentPolicy(), guide: 'Split big work.' });
    expect(d.orchestratorGuide(store.getConversation(conv.id)!, conv.project_id)).toMatch(/^Split big work\.\n\nFor this chat: project_id .*4 more sub-agent\(s\) allowed/);
  });

  it('gives Codex the code memory hook only when it knows the flag the hook needs', async () => {
    for (const [old, want] of [[false, true], [true, false]] as const) {
      const { dir, store, conv } = setupDispatcher();
      const d = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE, env: old ? { FAKE_OLD_CODEX: '1' } : {} });
      d.codeMemory = { guide: () => '', hooks: () => ({ args: ['--dangerously-bypass-hook-trust', '-c', 'hooks.PreToolUse=[]'], env: {} }) };
      store.enqueue(conv.id, 'x', []);
      d.kick(conv.id);
      await until(() => turnsDone(store, conv.id, 1));
      const ev = store.eventsAfter(conv.id, 0).filter((e) => e.type === 'item.completed').at(-1)!;
      expect((JSON.parse(ev.payload) as { item: { args: string[] } }).item.args.includes('--dangerously-bypass-hook-trust')).toBe(want);
      expect(store.listTurns(conv.id)[0]).toMatchObject({ status: 'completed' });
    }
  });

  it('waits for the code graph to be reindexed before the agent starts, and a cancel stops the wait', async () => {
    const { dir, store, conv } = setupDispatcher();
    const d = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE });
    d.codeMemory = { guide: () => '', hooks: () => null, refresh: (_p, onIndex) => { onIndex?.(); return new Promise(() => {}); } };
    store.enqueue(conv.id, 'x', []);
    d.kick(conv.id);
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'code_memory.indexing'));
    expect(d.cancel(conv.id)).toBe(true);
    await until(() => turnsDone(store, conv.id, 1));
    expect(store.listTurns(conv.id)[0]).toMatchObject({ status: 'cancelled' });
    expect(store.eventsAfter(conv.id, 0).map((e) => e.type).some((t) => t.startsWith('item.') || t === 'account.selected')).toBe(false);
  });

  it('puts nothing into a turn cancelled before its reindex starts', async () => {
    const { dir, store, conv } = setupDispatcher();
    const d = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE });
    let start!: () => void;
    let asked!: () => void;
    const askedP = new Promise<void>((r) => { asked = r; });
    d.codeMemory = { guide: () => '', hooks: () => null, refresh: (_p, onIndex) => { start = onIndex!; asked(); return new Promise(() => {}); } };
    store.enqueue(conv.id, 'x', []);
    d.kick(conv.id);
    await askedP;
    expect(d.cancel(conv.id)).toBe(true);
    await until(() => turnsDone(store, conv.id, 1));
    start();
    expect(store.eventsAfter(conv.id, 0).map((e) => e.type)).not.toContain('code_memory.indexing');
  });

  it('tells a turn to use the db tools while a database connection is open to agents', async () => {
    const { dir, store, conv } = setupDispatcher();
    store.setAgentGit({ commit: true, push: true }); // no git guide either, so only this one is in the instructions
    const d = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE, mcpUrl: 'http://127.0.0.1:9876/mcp' });
    const guideOf = async (n: number) => {
      store.enqueue(conv.id, 'x', []);
      d.kick(conv.id);
      await until(() => turnsDone(store, conv.id, n));
      const ev = store.eventsAfter(conv.id, 0).filter((e) => e.type === 'item.completed').at(-1)!;
      const arg = (JSON.parse(ev.payload) as { item: { args: string[] } }).item.args.find((a) => a.startsWith('developer_instructions='));
      return arg ? JSON.parse(arg.slice('developer_instructions='.length)) as string : null;
    };
    const conn = { id: 'pg', label: 'PG', driver: 'postgres', host: 'db', port: 5432, user: 'u', password: 'p', database: 'app', access: 'all', readOnly: false };
    saveConnections(store, [{ ...conn, agent: 'off' } as never]);
    expect(await guideOf(1)).toBeNull();
    saveConnections(store, [{ ...conn, agent: 'read-only' } as never]);
    const text = (await guideOf(2))!;
    expect(text).toContain('db_list_connections');
    expect(text).toContain('psql');
    expect(text).not.toContain('create_conversation'); // orchestrator mode is still 'asked'
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
    expect(store.listQueue(conv.id)).toMatchObject([{ prompt: 'long task', resume: true }]);
    store.enqueue(conv.id, 'after', []);
    dispatcher.kick(conv.id); // a stopped dispatcher starts nothing new
    await new Promise((r) => setTimeout(r, 100));
    expect(store.listTurns(conv.id)).toHaveLength(1);
  });

  it('after a restart, a turn shutdown cut off continues in its session before the prompts queued behind it', async () => {
    const { store, dispatcher, conv, dir } = setupDispatcher({ FAKE_MODE: 'slow' });
    store.enqueue(conv.id, 'long task', []);
    dispatcher.kick(conv.id);
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'turn.started'));
    store.enqueue(conv.id, 'next', []);
    await dispatcher.shutdown();
    const thread = store.getConversation(conv.id)!.thread_id;
    const restarted = new Dispatcher(store, { homes: [join(dir, 'a')], command: FAKE });
    restarted.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 3));
    const turns = store.listTurns(conv.id);
    expect(turns.map((t) => [t.prompt, t.status])).toEqual([['long task', 'interrupted'], ['long task', 'completed'], ['next', 'completed']]);
    const events = store.eventsAfter(conv.id, 0);
    const prompts = events.flatMap((e, i) => (e.type === 'user.prompt' ? [i] : []));
    const resumed = events.slice(prompts[1], prompts[2]);
    expect(JSON.parse(resumed.find((e) => e.type === 'user.prompt')!.payload)).toMatchObject({ resumed: true });
    const item = JSON.parse(resumed.find((e) => e.type === 'item.completed')!.payload).item as { text: string; args: string[] };
    expect(item.text).toMatch(/^Continue where you left off\. .*interrupted when Dalang restarted\..*\nlong task$/s);
    expect(item.args.slice(item.args.indexOf('resume'), item.args.indexOf('resume') + 2)).toEqual(['resume', thread]);
  });

  it('shutdown queues a cut-off turn to resume before the agent is gone, so a timeout cannot lose it', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_MODE: 'slow' });
    store.enqueue(conv.id, 'long task', []);
    dispatcher.kick(conv.id);
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'turn.started'));
    const done = dispatcher.shutdown();
    expect(dispatcher.isRunning(conv.id)).toBe(true); // the agent and the checkpoint after it are still to come
    expect(store.listQueue(conv.id)).toMatchObject([{ prompt: 'long task', resume: true }]);
    await done;
    expect(store.listQueue(conv.id)).toHaveLength(1); // not queued twice
  });

  it('shutdown does not resume a turn the person cancelled', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_MODE: 'slow' });
    store.enqueue(conv.id, 'long task', []);
    dispatcher.kick(conv.id);
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'turn.started'));
    dispatcher.cancel(conv.id);
    await dispatcher.shutdown();
    expect(store.listQueue(conv.id)).toEqual([]);
  });

  it('shutdown with a drain time lets running turns finish and holds new prompts for after the restart', async () => {
    const { store, dispatcher, conv } = setupDispatcher({ FAKE_DELAY_MS: '500' });
    store.enqueue(conv.id, 'task', []);
    dispatcher.kick(conv.id);
    await until(() => store.eventsAfter(conv.id, 0).some((e) => e.type === 'turn.started'));
    const done = dispatcher.shutdown(10_000);
    store.enqueue(conv.id, 'later', []);
    dispatcher.kick(conv.id);
    await done;
    expect(store.listTurns(conv.id).map((t) => t.status)).toEqual(['completed']);
    expect(store.listQueue(conv.id)).toMatchObject([{ prompt: 'later' }]);
    expect(store.listQueue(conv.id)[0]!.resume).toBeUndefined();
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

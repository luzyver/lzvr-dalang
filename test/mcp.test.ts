import { execFileSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { reviewDiffDir } from '../src/reviewer.js';
import { templateWorkDir } from '../src/templates.js';
import { changes, fakeClickUp } from './fake-clickup.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { mkUser, setupApp, type AppExtras } from './setup-app.js';

const opened: { close: () => Promise<unknown> }[] = [];
afterEach(async () => { for (const o of opened.splice(0)) await o.close().catch(() => {}); });

async function boot(extra: AppExtras = {}) {
  const t = setupApp({}, extra);
  opened.push({ close: () => t.app.close() });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (t.app.server.address() as { port: number }).port;
  const connect = async (headers: Record<string, string> = {}) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
      requestInit: { headers: { ...AUTH, ...headers } },
    }));
    opened.push(client);
    return client;
  };
  /** An MCP connection the way an agent running inside conversation `convId` gets it. */
  const connectAs = (convId: string) => connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(convId)}` });
  return { ...t, port, connect, connectAs };
}

type Booted = Awaited<ReturnType<typeof boot>>;
type C = Awaited<ReturnType<Booted['connect']>>;

async function call(c: C, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  const text = r.content[0]!.text;
  return { isError: Boolean(r.isError), text, json: r.isError ? null : JSON.parse(text) };
}

async function twoConvs(c: C) {
  const p = (await call(c, 'create_project', { name: 'proj', path: 'proj' })).json;
  const a = (await call(c, 'create_conversation', { project_id: p.id })).json;
  const b = (await call(c, 'create_conversation', { project_id: p.id })).json;
  return { p, a, b };
}

const ALL_TOOLS = [
  'list_projects', 'create_project', 'delete_project', 'list_conversations', 'create_conversation',
  'get_conversation', 'send_prompt', 'list_queue', 'remove_queue_item',
  'cancel_turn', 'set_draft', 'get_events', 'list_accounts', 'unblock_accounts', 'get_approval',
  'list_models', 'set_model', 'memory_search', 'memory_save', 'memory_update', 'memory_forget',
];
const REVIEWER_TOOLS = [
  'get_conversation', 'get_events', 'list_conversations', 'list_projects', 'list_queue', 'memory_search',
];
const AGENT_TOOLS = [
  'create_conversation', 'get_approval', 'get_conversation', 'get_events', 'list_accounts',
  'list_conversations', 'list_projects', 'list_queue', 'send_prompt', 'list_models', 'set_model',
  'memory_search', 'memory_save', 'memory_update', 'memory_forget',
];

describe('MCP gateway', () => {
  it('gives an outside client (main token) every gateway tool', async () => {
    const t = await boot();
    const names = (await (await t.connect()).listTools()).tools.map((x) => x.name);
    expect(names.sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('drives a conversation end to end', async () => {
    const t = await boot();
    const c = await t.connect();
    const { a } = await twoConvs(c);
    expect((await call(c, 'send_prompt', { conversation_id: a.id, prompt: 'hello' })).json.status).toBe('queued');
    await until(() => turnsDone(t.store, a.id, 1));
    const conv = (await call(c, 'get_conversation', { conversation_id: a.id })).json;
    expect(conv.turns[0]).toMatchObject({ prompt: 'hello', status: 'completed' });
    const ev = (await call(c, 'get_events', { conversation_id: a.id })).json;
    expect(ev.events.map((e: { type: string }) => e.type)).toContain('turn.completed');
    expect((await call(c, 'list_projects')).json).toHaveLength(1);
  });

  it('pages through events with after_id and limit', async () => {
    const t = await boot();
    const c = await t.connect();
    const { a } = await twoConvs(c);
    await call(c, 'send_prompt', { conversation_id: a.id, prompt: 'x' });
    await until(() => turnsDone(t.store, a.id, 1));
    const first = (await call(c, 'get_events', { conversation_id: a.id, limit: 2 })).json;
    expect(first.events).toHaveLength(2);
    const rest = (await call(c, 'get_events', { conversation_id: a.id, after_id: first.next_after_id })).json;
    expect(rest.events[0].id).toBeGreaterThan(first.next_after_id);
  });

  it('cuts long tool output by default, gives it in full on request, and reads by turns', async () => {
    const t = await boot();
    const c = await t.connect();
    const { a } = await twoConvs(c);
    const out = 'o'.repeat(10_000);
    let cmd = 0;
    for (let i = 0; i < 3; i++) {
      const turn = t.store.startTurn(a.id, `p${i}`);
      t.store.addEvent(turn, 'user.prompt', JSON.stringify({ type: 'user.prompt', text: `p${i}` }));
      for (let j = 0; j < 3; j++) t.store.addEvent(turn, 'item.updated', JSON.stringify({ type: 'item.updated', item: { aggregated_output: out } }));
      cmd = t.store.addEvent(turn, 'item.completed', JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', command: 'ls', aggregated_output: out } }));
    }
    const cut = (await call(c, 'get_events', { conversation_id: a.id, limit: 2 }));
    expect(cut.text).not.toContain(out);
    expect(cut.json.events.map((e: { type: string }) => e.type)).toEqual(['user.prompt', 'item.completed']); // item.updated left out
    expect(cut.json.events[1].data.item.cut).toBe(true);
    const one = (await call(c, 'get_events', { conversation_id: a.id, after_id: cmd - 1, limit: 1, full: true })).json;
    expect(one.events[0].data.item.aggregated_output).toBe(out);
    const last = (await call(c, 'get_events', { conversation_id: a.id, last_turns: 2 })).json;
    expect(last.events.filter((e: { type: string }) => e.type === 'user.prompt').map((e: { data: { text: string } }) => e.data.text)).toEqual(['p1', 'p2']);
    expect(last.more_earlier).toBe(true);
    const before = (await call(c, 'get_events', { conversation_id: a.id, last_turns: 2, before_turn: last.earlier_before_turn })).json;
    expect(before.events[0].data.text).toBe('p0');
    expect(before.more_earlier).toBe(false);
    const odd = t.store.addEvent(t.store.startTurn(a.id, 'q'), 'item.completed', JSON.stringify({ type: 'item.completed', item: { id: 'w', type: 'other_item', text: out } }));
    const oddCut = (await call(c, 'get_events', { conversation_id: a.id, after_id: odd - 1, limit: 1 })).json;
    expect(oddCut.events[0].data.item).toEqual({ id: 'w', type: 'other_item', cut: true }); // an item of another kind says it was cut too
  });

  it('reads full messages without tool output and keeps both paging modes usable', async () => {
    const t = await boot();
    const c = await t.connect();
    const { a } = await twoConvs(c);
    const turns: number[] = [];
    let lastId = 0;
    for (let i = 0; i < 3; i++) {
      const turn = t.store.startTurn(a.id, `p${i}`);
      turns.push(turn);
      t.store.addEvent(turn, 'user.prompt', JSON.stringify({ type: 'user.prompt', text: `p${i}` }));
      for (let j = 0; j < 5; j++) t.store.addEvent(turn, 'item.completed', JSON.stringify({ type: 'item.completed', item: { type: 'command_execution', aggregated_output: 'large output '.repeat(1000) } }));
      t.store.addEvent(turn, 'item.completed', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: `answer${i}${'x'.repeat(5000)}` } }));
      lastId = t.store.addEvent(turn, 'turn.completed', '{"type":"turn.completed"}');
    }
    const first = (await call(c, 'get_events', { conversation_id: a.id, messages_only: true, limit: 2 })).json;
    expect(first.events).toHaveLength(2);
    expect(first.events[0].data.text).toBe('p0');
    expect(first.events[1].data.item.text).toBe(`answer0${'x'.repeat(5000)}`);
    expect(first.events[1].id).toBe(first.next_after_id);
    const rest = (await call(c, 'get_events', { conversation_id: a.id, messages_only: true, after_id: first.next_after_id, limit: 10 })).json;
    expect(rest.events.map((e: { type: string }) => e.type)).toEqual(['user.prompt', 'item.completed', 'user.prompt', 'item.completed']);
    expect(rest.next_after_id).toBe(lastId); // ignored events still advance the cursor
    const one = (await call(c, 'get_events', { conversation_id: a.id, messages_only: true, last_turns: 1, before_turn: turns[1]! + 1 })).json;
    expect(one.events.map((e: { data: { text?: string; item?: { text: string } } }) => e.data.text || e.data.item?.text)).toEqual(['p1', `answer1${'x'.repeat(5000)}`]);
    expect(one.earlier_before_turn).toBe(turns[1]);
    expect(one.more_earlier).toBe(true);
    expect(JSON.stringify(one)).not.toContain('large output');
    expect((await call(c, 'get_events', { conversation_id: a.id, messages_only: true, after_id: lastId })).json.events).toEqual([]);
  });

  it('reports tool errors as results, not crashes', async () => {
    const t = await boot();
    const c = await t.connect();
    expect((await call(c, 'create_project', { name: 'x', path: '../..' })).isError).toBe(true);
    expect((await call(c, 'get_conversation', { conversation_id: 'nope' })).isError).toBe(true);
  });

  it('manages queue, cancel, draft and accounts', async () => {
    const t = await boot();
    const c = await t.connect();
    const { a } = await twoConvs(c);
    expect((await call(c, 'set_draft', { conversation_id: a.id, draft: 'wip' })).isError).toBe(false);
    expect(t.store.getConversation(a.id)!.draft).toBe('wip');
    expect((await call(c, 'cancel_turn', { conversation_id: a.id })).json).toEqual({ cancelled: false });
    expect((await call(c, 'list_queue', { conversation_id: a.id })).json).toEqual([]);
    expect((await call(c, 'list_accounts')).json).toHaveLength(1);
    expect((await call(c, 'unblock_accounts')).isError).toBe(false);
  });

  it('copes with having no Codex account yet', async () => {
    const t = await boot({ homes: [] });
    const c = await t.connect();
    expect((await call(c, 'list_accounts')).json).toEqual([]);
  });

  it('rejects requests without the token and non-POST methods', async () => {
    const t = await boot();
    const body = { jsonrpc: '2.0', id: 1, method: 'tools/list' };
    const noAuth = await fetch(`http://127.0.0.1:${t.port}/mcp`, {
      method: 'POST', headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' }, body: JSON.stringify(body),
    });
    expect(noAuth.status).toBe(401);
    const get = await fetch(`http://127.0.0.1:${t.port}/mcp`, { headers: AUTH });
    expect(get.status).toBe(405);
  });
});

/** The tools a user's token did not get while users had roles. */
const ONCE_ADMIN_ONLY = ['create_project', 'delete_project', 'unblock_accounts'];

describe('MCP for a user with a token of their own', () => {
  it('gives a user every tool, the project, session and account ones too', async () => {
    const t = await boot();
    const budi = await mkUser(t, 'budi');
    const c = await t.connect({ authorization: `Bearer ${budi.token}` });
    const names = (await c.listTools()).tools.map((x) => x.name);
    expect(names.sort()).toEqual([...ALL_TOOLS].sort());
    for (const once of ONCE_ADMIN_ONLY) expect(names, once).toContain(once);
    // and they work, not just show
    expect((await call(c, 'create_project', { name: 'x', path: 'proj' })).isError).toBeFalsy();
    expect(t.store.listProjects().map((p) => p.name)).toEqual(['x']);
  });
});

describe('agents calling the gateway from inside a conversation', () => {
  it('get a reduced toolset: no creating projects, no sandbox changes, no approvals', async () => {
    const t = await boot();
    const { a } = await twoConvs(await t.connect());
    const names = (await (await t.connectAs(a.id)).listTools()).tools.map((x) => x.name);
    expect(names.sort()).toEqual([...AGENT_TOOLS].sort());
  });

  it('use a token that only works on /mcp and dies when the turn is over', async () => {
    const t = await boot();
    const { a } = await twoConvs(await t.connect());
    const token = t.dispatcher.issueMcpToken(a.id);
    const rest = await t.app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${token}` } });
    expect(rest.statusCode).toBe(401);
    const approve = await t.app.inject({ method: 'POST', url: '/api/approvals/1/approve', headers: { authorization: `Bearer ${token}` } });
    expect(approve.statusCode).toBe(401);

    const ping = () => fetch(`http://127.0.0.1:${t.port}/mcp`, {
      method: 'POST',
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
    });
    expect((await ping()).status).toBe(200);
    t.dispatcher.revokeMcpToken(token);
    expect((await ping()).status).toBe(401);
  });

  it('cannot take another conversation\'s identity with a header', async () => {
    const t = await boot();
    const { a, b } = await twoConvs(await t.connect());
    const sneaky = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id)}`, 'x-conversation-id': b.id });
    expect((await call(sneaky, 'send_prompt', { conversation_id: b.id, prompt: 'as b' })).json.status).toBe('pending_approval');
    expect(t.store.listTurns(b.id)).toEqual([]);
  });
});

describe('reviewer tools', () => {
  it('let only a reviewer read its whole diff and the files under review, by lines and inside the folder', async () => {
    const t = await boot();
    const { a, p } = await twoConvs(await t.connect());
    const rev = t.store.createConversation(p.id, 'codex', a.id);
    t.store.setRole(rev.id, 'reviewer');
    const dir = t.store.getProject(p.id)!.path;
    mkdirSync(join(dir, 'src'), { recursive: true });
    writeFileSync(join(dir, 'src', 'a.ts'), 'one\ntwo\nthree');
    mkdirSync(reviewDiffDir(rev.id), { recursive: true });
    writeFileSync(join(reviewDiffDir(rev.id), 'change.diff'), Array.from({ length: 2500 }, (_, i) => `+line ${i + 1}`).join('\n'));
    try {
      const names = (c: C) => c.listTools().then((r) => r.tools.map((x) => x.name));
      expect(await names(await t.connectAs(a.id))).not.toContain('review_diff');
      const c = await t.connectAs(rev.id);
      expect(await names(c)).toEqual(expect.arrayContaining(['review_diff', 'review_read_file']));
      // It only reads: nothing that writes, starts or messages a chat, or reaches a server or database.
      expect((await names(c)).sort()).toEqual([...REVIEWER_TOOLS, 'review_diff', 'review_read_file'].sort());
      expect((await call(c, 'send_prompt', { conversation_id: a.id, prompt: 'x' })).isError).toBe(true);
      const first = (await call(c, 'review_diff')).json;
      expect(first).toMatchObject({ total_lines: 2500, offset: 1, next_offset: 2001 });
      const rest = (await call(c, 'review_diff', { offset: first.next_offset })).json;
      expect(rest.text.split('\n')).toHaveLength(500);
      expect(rest.text.endsWith('2500\t+line 2500')).toBe(true);
      expect(rest.next_offset).toBeUndefined();
      expect((await call(c, 'review_read_file', { path: 'src/a.ts', offset: 2, limit: 1 })).json.text).toBe('2\ttwo');
      expect((await call(c, 'review_read_file', { path: '.' })).json.entries).toContain('src/');
      expect((await call(c, 'review_read_file', { path: '../' })).isError).toBe(true);
    } finally { rmSync(reviewDiffDir(rev.id), { recursive: true, force: true }); }
  });
});

describe('cross-conversation sends', () => {
  it('holds a send from another conversation until it is approved over REST', async () => {
    const t = await boot();
    const { a, b } = await twoConvs(await t.connect());
    const fromA = await t.connectAs(a.id);

    const sent = (await call(fromA, 'send_prompt', { conversation_id: b.id, prompt: 'hi from A' })).json;
    expect(sent.status).toBe('pending_approval');
    expect(t.store.listQueue(b.id)).toEqual([]);
    expect(t.store.listTurns(b.id)).toEqual([]);

    const pending = await t.app.inject({ url: '/api/approvals', headers: AUTH });
    expect(pending.json()).toMatchObject([{ id: sent.approval_id, from_conv: a.id, to_conv: b.id, prompt: 'hi from A', status: 'pending' }]);
    expect((await call(fromA, 'get_approval', { approval_id: sent.approval_id })).json.status).toBe('pending');

    const ok = await t.app.inject({ method: 'POST', url: `/api/approvals/${sent.approval_id}/approve`, headers: AUTH });
    expect(ok.statusCode).toBe(204);
    await until(() => turnsDone(t.store, b.id, 1));
    expect(t.store.listTurns(b.id)[0]).toMatchObject({ prompt: 'hi from A', status: 'completed' });
    expect((await t.app.inject({ method: 'POST', url: `/api/approvals/${sent.approval_id}/approve`, headers: AUTH })).statusCode).toBe(409);
  });

  it('drops a rejected send', async () => {
    const t = await boot();
    const c = await t.connect();
    const { a, b } = await twoConvs(c);
    const sent = (await call(await t.connectAs(a.id), 'send_prompt', { conversation_id: b.id, prompt: 'no' })).json;
    expect((await t.app.inject({ method: 'POST', url: `/api/approvals/${sent.approval_id}/reject`, headers: AUTH })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'POST', url: `/api/approvals/${sent.approval_id}/approve`, headers: AUTH })).statusCode).toBe(409);
    expect(t.store.listTurns(b.id)).toEqual([]);
    expect((await call(c, 'get_approval', { approval_id: sent.approval_id })).json.status).toBe('rejected');
  });

  it('runs cross sends immediately in auto mode', async () => {
    const t = await boot({ cfg: { mcpCrossSend: 'auto' } });
    const { a, b } = await twoConvs(await t.connect());
    const sent = (await call(await t.connectAs(a.id), 'send_prompt', { conversation_id: b.id, prompt: 'go' })).json;
    expect(sent.status).toBe('queued');
    await until(() => turnsDone(t.store, b.id, 1));
  });

  it('lets an agent message its own conversation, and an outside client message any', async () => {
    const t = await boot();
    const c = await t.connect();
    const { a } = await twoConvs(c);
    expect((await call(await t.connectAs(a.id), 'send_prompt', { conversation_id: a.id, prompt: 'self' })).json.status).toBe('queued');
    await until(() => turnsDone(t.store, a.id, 1));
    expect((await call(c, 'send_prompt', { conversation_id: a.id, prompt: 'external' })).json.status).toBe('queued');
    await until(() => turnsDone(t.store, a.id, 2));
  });

  it('404s approval decisions for unknown ids and requires auth', async () => {
    const t = await boot();
    expect((await t.app.inject({ method: 'POST', url: '/api/approvals/999/approve', headers: AUTH })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/approvals' })).statusCode).toBe(401);
  });
});

describe('models of sub-agents', () => {
  it('start on the parent\'s model and effort and never go above them', async () => {
    const t = await boot();
    const { p, a, b } = await twoConvs(await t.connect());
    t.store.setModel(a.id, 'gpt-5.5');
    t.store.setEffort(a.id, 'medium');
    const fromA = await t.connectAs(a.id);

    const sub = (await call(fromA, 'create_conversation', { project_id: p.id })).json;
    expect(sub).toMatchObject({ parent: a.id, model: 'gpt-5.5', effort: 'medium', effective_model: 'gpt-5.5' });
    const small = (await call(fromA, 'create_conversation', { project_id: p.id, model: 'gpt-5.4-mini', effort: 'low' })).json;
    expect(small).toMatchObject({ model: 'gpt-5.4-mini', effort: 'low' });
    // Another CLI compares on the same scale.
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'claude', model: 'sonnet' })).isError).toBe(false);
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'claude', model: 'claude-fable-5-1' })).text).toMatch(/above your own \(gpt-5\.5\)/);
    expect((await call(fromA, 'create_conversation', { project_id: p.id, effort: 'high' })).text).toMatch(/effort high is above your own \(medium\)/);
    expect((await call(fromA, 'create_conversation', { project_id: p.id, model: 'mystery-1' })).text).toMatch(/cannot tell/);

    // Up again, but only as far as the parent; the parent itself only down.
    expect((await call(fromA, 'set_model', { conversation_id: small.id, model: 'gpt-5.5', effort: 'medium' })).json).toMatchObject({ model: 'gpt-5.5', effort: 'medium' });
    expect((await call(fromA, 'set_model', { conversation_id: small.id, effort: 'xhigh' })).text).toMatch(/above your own/);
    expect((await call(fromA, 'set_model', { conversation_id: a.id, effort: 'high' })).text).toMatch(/above your own/);
    expect((await call(fromA, 'set_model', { conversation_id: a.id, model: 'gpt-5.4-mini' })).json.model).toBe('gpt-5.4-mini');

    // A chat it did not start is not its to change, and an empty call changes nothing.
    expect((await call(fromA, 'set_model', { conversation_id: b.id, model: 'gpt-5.4-mini' })).text).toMatch(/only change its own/);
    expect((await call(fromA, 'set_model', { conversation_id: sub.id })).text).toMatch(/give model/);
    expect(t.store.getConversation(b.id)!.model).toBe('');
  });

  it('keep a sub-agent on the parent\'s own model when that one cannot be ranked', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const fromA = await t.connectAs(a.id);
    const sub = (await call(fromA, 'create_conversation', { project_id: p.id })).json;
    expect(sub).toMatchObject({ parent: a.id, model: '', effective_model: null });
    expect((await call(fromA, 'create_conversation', { project_id: p.id, model: 'gpt-5.4-mini' })).text).toMatch(/cannot tell/);
    expect((await call(fromA, 'list_models')).json).toMatchObject({ your_model: null, models: [], note: expect.stringMatching(/cannot be ranked/) });
  });

  it('do not take one CLI\'s default for another\'s', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const fromA = await t.connectAs(a.id);
    // Nothing set anywhere: on another CLI neither its default model nor its default effort compares with the parent's.
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'claude' })).text).toMatch(/cannot tell whether claude's default model/);
    expect((await call(fromA, 'create_conversation', { project_id: p.id, effort: 'medium' })).text).toMatch(/cannot tell whether effort medium/);
    expect((await call(fromA, 'create_conversation', { project_id: p.id, effort: 'low' })).isError).toBe(false); // nothing is below it
    t.store.setModel(a.id, 'gpt-5.5');
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'claude', model: 'haiku' })).text).toMatch(/cannot tell whether effort claude's default/);
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'claude', model: 'haiku', effort: 'low' })).json).toMatchObject({ backend: 'claude', model: 'haiku', effort: 'low' });
  });

  it('bring an inherited effort down to the highest the sub-agent\'s model takes', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    t.store.setBackend(a.id, 'claude');
    t.store.setModel(a.id, 'claude-opus-5-5');
    t.store.setEffort(a.id, 'max');
    t.dispatcher.models = async (b) => b === 'codex'
      ? [{ slug: 'gpt-5.5', name: '', description: '', efforts: ['low', 'medium', 'high', 'xhigh'] }, { slug: 'gpt-5.4-mini', name: '', description: '', efforts: ['low', 'medium'] }]
      : [{ slug: 'claude-opus-5-5', name: '', description: '', efforts: ['low', 'medium', 'high', 'xhigh', 'max'] }];
    const fromA = await t.connectAs(a.id);
    // Codex has no max: the sub-agent runs on its highest instead of failing.
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'codex', model: 'gpt-5.5' })).json).toMatchObject({ backend: 'codex', effort: 'xhigh' });
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'codex', model: 'gpt-5.4-mini' })).json).toMatchObject({ effort: 'medium' });
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'claude' })).json).toMatchObject({ backend: 'claude', effort: 'max' });
    // Without a model list (or a model not on it) the effort still comes down to the most its CLI takes at all.
    t.dispatcher.models = async () => [];
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'codex', model: 'gpt-5.5' })).json).toMatchObject({ effort: 'xhigh' });
    expect((await call(fromA, 'create_conversation', { project_id: p.id, backend: 'claude' })).json).toMatchObject({ effort: 'max' });
  });

  it('lists only the models and efforts up to the agent\'s own, weakest first', async () => {
    const t = await boot();
    const { a } = await twoConvs(await t.connect());
    t.dispatcher.models = async () => ['gpt-5.5', 'gpt-5.4-mini', 'mystery-1'].map((slug) => ({ slug, name: slug, description: '', efforts: [] }));
    t.store.setDefaultModel('gpt-5.5');
    t.store.setEffort(a.id, 'high');
    const listed = (await call(await t.connectAs(a.id), 'list_models')).json;
    expect(listed.models.map((m: { slug: string; rank: number }) => [m.rank, m.slug])).toEqual([[0, 'gpt-5.4-mini'], [2, 'gpt-5.5']]);
    expect(listed).toMatchObject({ your_model: 'gpt-5.5', your_effort: 'high', efforts: ['low', 'medium', 'high'] });
  });

  it('lets an outside client pick any model and backend', async () => {
    const t = await boot();
    const c = await t.connect();
    const { p, a } = await twoConvs(c);
    const out = (await call(c, 'create_conversation', { project_id: p.id, model: 'anything-1', effort: 'max', backend: 'claude' })).json;
    expect(out).toMatchObject({ parent: '', model: 'anything-1', effort: 'max', backend: 'claude' });
    expect((await call(c, 'set_model', { conversation_id: a.id, model: 'other-2' })).json.model).toBe('other-2');
    expect((await call(c, 'create_conversation', { project_id: p.id, model: '--flag' })).isError).toBe(true);
  });

});

describe('sub-agents', () => {
  const policy = (t: Booted, p: { maxChildren: number; maxDepth: number; autoSend: boolean }) =>
    t.app.inject({ method: 'PUT', url: '/api/settings/subagents', headers: AUTH, payload: p });
  const reports = (t: Booted, id: string) => t.store.listTurns(id).filter((x) => x.prompt.startsWith('[Sub-agent]'));

  it('run their first task without approval and report the answer back to the parent', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const sub = (await call(await t.connectAs(a.id), 'create_conversation', { project_id: p.id, prompt: 'count the files' })).json;
    expect(sub.parent).toBe(a.id);
    expect(sub.prompt.status).toBe('queued');
    await until(() => turnsDone(t.store, sub.id, 1));
    await until(() => reports(t, a.id).length === 1 && turnsDone(t.store, a.id, 1));
    const r = reports(t, a.id)[0]!.prompt;
    expect(r).toContain(`conversation ${sub.id}`);
    expect(r).toContain('finished');
    expect(r).toContain('count the files'); // the fake agent answers with its prompt
    expect(t.store.listApprovals('pending')).toEqual([]);
  });

  it('report once per batch, and not for prompts someone else sent them', async () => {
    const t = await boot();
    const c = await t.connect();
    const { p, a } = await twoConvs(c);
    const fromA = await t.connectAs(a.id);
    const sub = (await call(fromA, 'create_conversation', { project_id: p.id })).json;
    await call(fromA, 'send_prompt', { conversation_id: sub.id, prompt: 'one' });
    await call(fromA, 'send_prompt', { conversation_id: sub.id, prompt: 'two' });
    await until(() => turnsDone(t.store, sub.id, 2));
    await until(() => reports(t, a.id).length >= 1 && turnsDone(t.store, a.id, reports(t, a.id).length));
    expect(reports(t, a.id).length).toBeLessThanOrEqual(2);
    const before = reports(t, a.id).length;
    await call(c, 'send_prompt', { conversation_id: sub.id, prompt: 'from a person' });
    await until(() => turnsDone(t.store, sub.id, 3));
    await new Promise((r) => setTimeout(r, 300));
    expect(reports(t, a.id).length).toBe(before);
  });

  it('join reports waiting in the queue, but never a person\'s prompt that starts like one', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const sub = t.store.createConversation(p.id, 'codex', a.id);
    const report = (d: any) => d.reportToParent(sub.id, { from_conv: a.id, on_behalf: 'someone' }, 'completed', 'done');
    (t.dispatcher as any).kick = () => {}; // nothing starts, so what is queued stays queued
    t.store.enqueue(a.id, '[Sub-agent] typed by a person', ['notes.txt'], 'someone'); // on_behalf 'someone' too, like the reports
    report(t.dispatcher);
    report(t.dispatcher);
    const queued = t.store.listQueue(a.id);
    expect(queued).toHaveLength(2);
    expect(queued[0]!.prompt).toBe('[Sub-agent] typed by a person');
    expect(queued[0]!.author).toBe('someone');
    expect(queued[0]!.attachments).toEqual(['notes.txt']);
    expect(queued[1]!.prompt.match(/\[Sub-agent\] "/g)).toHaveLength(2);
  });

  it('pass a grandchild\'s report up through its parent', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const sub = (await call(await t.connectAs(a.id), 'create_conversation', { project_id: p.id })).json;
    const subsub = (await call(await t.connectAs(sub.id), 'create_conversation', { project_id: p.id, prompt: 'deep work' })).json;
    expect(subsub.parent).toBe(sub.id);
    await until(() => reports(t, sub.id).length === 1 && turnsDone(t.store, sub.id, 1));
    await until(() => reports(t, a.id).length === 1 && turnsDone(t.store, a.id, 1));
    expect(reports(t, a.id)[0]!.prompt).toContain(`conversation ${sub.id}`);
  });

  it('hold a middle sub-agent\'s report until the sub-agents it gave work to are done', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const sub = (await call(await t.connectAs(a.id), 'create_conversation', { project_id: p.id })).json;
    const subsub = (await call(await t.connectAs(sub.id), 'create_conversation', { project_id: p.id })).json;
    t.store.enqueue(subsub.id, 'deep work', [], '', '', sub.id); // its parent's work, not started yet
    await call(await t.connectAs(a.id), 'send_prompt', { conversation_id: sub.id, prompt: 'delegate it' });
    await until(() => turnsDone(t.store, sub.id, 1));
    await new Promise((r) => setTimeout(r, 300));
    expect(reports(t, a.id)).toEqual([]); // sub ended its turn, but subsub still owes it an answer

    t.dispatcher.kick(subsub.id);
    await until(() => reports(t, sub.id).length === 1 && turnsDone(t.store, sub.id, 2));
    await until(() => reports(t, a.id).length === 1 && turnsDone(t.store, a.id, 1));
    expect(reports(t, a.id)[0]!.prompt).toContain(`conversation ${sub.id}`);
    await new Promise((r) => setTimeout(r, 300));
    expect(reports(t, a.id)).toHaveLength(1);
  });

  it('stay within the limits set in the panel', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    expect((await policy(t, { maxChildren: 1, maxDepth: 1, autoSend: true })).statusCode).toBe(204);
    const fromA = await t.connectAs(a.id);
    const sub = (await call(fromA, 'create_conversation', { project_id: p.id })).json;
    expect((await call(fromA, 'create_conversation', { project_id: p.id })).text).toMatch(/already has 1 sub-agents/);
    expect((await call(await t.connectAs(sub.id), 'create_conversation', { project_id: p.id })).text).toMatch(/1 level\(s\) deep/);
    await policy(t, { maxChildren: 0, maxDepth: 2, autoSend: true });
    expect((await call(fromA, 'create_conversation', { project_id: p.id })).text).toMatch(/sub-agents are turned off/);
  });

  it('stay within the limit when an agent asks for several worktree sub-agents at once', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const path = t.store.getProject(p.id)!.path;
    const git = (...args: string[]) => execFileSync('git', ['-C', path, ...args]);
    git('init', '-q');
    writeFileSync(join(path, 'a.txt'), 'a\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await policy(t, { maxChildren: 2, maxDepth: 1, autoSend: true });
    const fromA = await t.connectAs(a.id);
    // Each call waits on git before its chat exists, so all of them passed a count taken before any was created.
    const out = await Promise.all([1, 2, 3, 4].map(() => call(fromA, 'create_conversation', { project_id: p.id, worktree: true })));
    expect(out.filter((r) => !r.isError)).toHaveLength(2);
    expect(out.filter((r) => r.isError)[0]!.text).toMatch(/already has 2 sub-agents/);
    expect(t.store.countChildren(a.id)).toBe(2);
  });

  it('wait for approval when sending unasked is off, or the sub-agent is in another project', async () => {
    const t = await boot();
    const c = await t.connect();
    const { p, a } = await twoConvs(c);
    const other = t.store.createProject('other', t.store.getProject(p.id)!.path);
    const fromA = await t.connectAs(a.id);
    const away = (await call(fromA, 'create_conversation', { project_id: other.id, prompt: 'over there' })).json;
    expect(away.prompt.status).toBe('pending_approval');
    await policy(t, { maxChildren: 5, maxDepth: 2, autoSend: false });
    const sub = (await call(fromA, 'create_conversation', { project_id: p.id })).json;
    expect((await call(fromA, 'send_prompt', { conversation_id: sub.id, prompt: 'x' })).json.status).toBe('pending_approval');
    expect(t.store.listTurns(sub.id)).toEqual([]);
  });

  it('keep their limits in settings every user can open', async () => {
    const t = await boot();
    expect((await t.app.inject({ url: '/api/settings/subagents', headers: AUTH })).json())
      .toEqual({ maxChildren: 5, maxDepth: 2, autoSend: true });
    expect((await policy(t, { maxDepth: 1 } as never)).statusCode).toBe(204); // a part leaves the rest as it was
    expect(t.store.getSubagentPolicy()).toEqual({ maxChildren: 5, maxDepth: 1, autoSend: true });
    await policy(t, { mode: 'auto', guide: 'x' } as never); // the skill decides now: not kept
    expect(t.store.getSubagentPolicy()).toEqual({ maxChildren: 5, maxDepth: 1, autoSend: true });
    // What older settings kept beside the limits is dropped.
    t.store.setKv('subagents', '{"maxChildren":3,"mode":"auto","guide":"x"}');
    expect(t.store.getSubagentPolicy()).toEqual({ maxChildren: 3, maxDepth: 2, autoSend: true });
    expect((await policy(t, { maxChildren: 99, maxDepth: 1, autoSend: true })).statusCode).toBe(400);
    const budi = { authorization: `Bearer ${(await mkUser(t, 'budi')).token}` };
    expect((await t.app.inject({ url: '/api/settings/subagents', headers: budi })).json()).toEqual({ maxChildren: 3, maxDepth: 2, autoSend: true });
    expect((await t.app.inject({ method: 'PUT', url: '/api/settings/subagents', headers: budi, payload: { maxChildren: 4 } })).statusCode).toBe(204);
    expect(t.store.getSubagentPolicy().maxChildren).toBe(4);
  });
});

/** Connects a person's own ClickUp (the owner's unless told otherwise) by the sign-in of Settings → MCP → ClickUp. */
async function connectClickUp(t: Booted, headers: Record<string, string> = AUTH) {
  await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers, payload: { apiKey: 'pk_test', workspaceId: '900', timeZone: '' } });
  const start = await t.app.inject({ method: 'POST', url: '/api/settings/clickup/oauth/start', headers });
  const state = new URL(start.json().url).searchParams.get('state')!;
  const done = await t.app.inject({ method: 'POST', url: '/api/settings/clickup/oauth/finish', headers, payload: { code: 'code1', state } });
  expect(done.statusCode).toBe(200);
}

describe('ClickUp tools', () => {
  const CLICKUP = [
    'clickup_chat_history', 'clickup_find_people', 'clickup_find_tasks', 'clickup_get_doc', 'clickup_get_list', 'clickup_get_task',
    'clickup_list_channels', 'clickup_list_docs', 'clickup_list_spaces', 'clickup_list_threads', 'clickup_time_entries', 'clickup_whoami',
  ];
  const SEND = [
    'clickup_attach_file', 'clickup_comment_task', 'clickup_create_task', 'clickup_link_tasks', 'clickup_log_time', 'clickup_send_message',
    'clickup_send_status', 'clickup_update_task', 'clickup_write_doc',
  ];
  const clickupNames = async (c: C) => (await c.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith('clickup_'));
  const allowSend = (t: Booted) => t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { workspaceId: '900', timeZone: '', send: true } });
  /** Boot with the fake ClickUp MCP server and the owner connected to it. */
  async function withClickUp(calls?: string[]) {
    const t = await boot({ clickupFetch: fakeClickUp(calls) });
    await connectClickUp(t);
    return t;
  }

  it('are not there until the person connects ClickUp, and go away when they disconnect', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    expect(await clickupNames(await t.connect())).toEqual([]);
    await connectClickUp(t);
    expect((await clickupNames(await t.connect())).sort()).toEqual(CLICKUP);
    await t.app.inject({ method: 'DELETE', url: '/api/settings/clickup/key', headers: AUTH });
    expect(await clickupNames(await t.connect())).toEqual([]);
  });

  it('read as each person on their own connection, and are not given on another person\'s', async () => {
    const t = await withClickUp();
    const owner = await t.connect();
    expect((await clickupNames(owner)).sort()).toEqual(CLICKUP);
    const r = await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-10', workspace_ids: ['900', '901'] });
    expect(r.json.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm3', 'd1m', 'm4']);
    const only = await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-10', workspace_ids: ['901'] });
    expect(only.json.messages.map((m: { id: string }) => m.id)).toEqual(['d1m']);
    expect((await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-01' })).isError).toBe(true);

    // The owner's connection is the owner's alone: any other user without one of their own gets nothing.
    const sari = await mkUser(t, 'u-sari');
    const budi = await mkUser(t, 'u-budi');
    const h = (u: { token: string }) => ({ authorization: `Bearer ${u.token}` });
    for (const u of [sari, budi]) expect(await clickupNames(await t.connect(h(u)))).toEqual([]);

    // A user with their own (one ClickUp no longer accepts): they get the tools on it, the owner stays on the owner's.
    const s = JSON.parse(t.store.getKv('clickup')!);
    s.users[t.store.userKeyOf('u-budi')] = { workspaceId: '', timeZone: '', oauth: 'mcp_gone', apiKey: 'pk_gone' };
    t.store.setKv('clickup', JSON.stringify(s));
    const asBudi = await t.connect(h(budi));
    expect((await clickupNames(asBudi)).sort()).toEqual(CLICKUP);
    const gone = await call(asBudi, 'clickup_whoami');
    expect(gone.isError).toBe(true);
    expect(gone.text).toMatch(/401/);
    expect((await call(await t.connect(), 'clickup_whoami')).json).toMatchObject({ user: { username: 'luz' } });
    expect(await clickupNames(await t.connect(h(sari)))).toEqual([]);

    // Their connection goes with them.
    expect((await t.app.inject({ method: 'DELETE', url: `/api/users/${budi.id}`, headers: AUTH })).statusCode).toBe(204);
    expect(t.store.getKv('clickup')).not.toContain('mcp_gone');
    expect(t.store.getKv('clickup')).toContain('mcp_test');
  });

  it('reach an agent only during a turn sent by someone who connected their own ClickUp', async () => {
    const t = await withClickUp();
    const budi = await mkUser(t, 'budi');
    const { a } = await twoConvs(await t.connect());
    const as = (author: string) => t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, author)}` });
    expect((await clickupNames(await as('owner'))).sort()).toEqual(CLICKUP);
    for (const author of ['', 'budi', 'nobody']) expect(await clickupNames(await as(author))).toEqual([]);
    await connectClickUp(t, { authorization: `Bearer ${budi.token}` });
    expect((await clickupNames(await as('budi'))).sort()).toEqual(CLICKUP);
    expect(await clickupNames(await as(''))).toEqual([]); // a prompt nobody sent (an agent, an approval) is on nobody's connection
  });

  it('do not read a personal API token saved before ClickUp went through its own MCP server', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    t.store.setKv('clickup', JSON.stringify({ token: 'pk_retired', workspaceId: '900', timeZone: '', allUsers: true, send: true }));
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json()).toEqual({ hasApiKey: false, connected: false, workspaceId: '900', timeZone: '', send: true });
    expect(await clickupNames(await t.connect())).toEqual([]);
    // the owner's other settings are kept, the token goes on the next save
    await connectClickUp(t);
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json()).toEqual({ hasApiKey: true, connected: true, workspaceId: '900', timeZone: '', send: true });
    expect(t.store.getKv('clickup')).not.toContain('pk_retired');
    expect((await clickupNames(await t.connect())).sort()).toEqual([...CLICKUP, ...SEND].sort());
  });

  it('send messages only once the owner allows it, for everyone who connected', async () => {
    const t = await withClickUp();
    const setSend = (send: boolean) =>
      t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { workspaceId: '900', timeZone: '', send } });
    const budi = { authorization: `Bearer ${(await mkUser(t, 'u-budi')).token}` };
    const budiPut = (payload: object) => t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: budi, payload });
    await connectClickUp(t, budi);
    const budiNames = async () => clickupNames(await t.connect(budi));
    expect(await clickupNames(await t.connect())).not.toContain('clickup_send_message');
    expect((await budiNames()).sort()).toEqual(CLICKUP);
    expect((await budiPut({ workspaceId: '', timeZone: '', send: true })).statusCode).toBe(403); // the owner's switch

    expect((await setSend(true)).json()).toMatchObject({ send: true, connected: true });
    const owner = await t.connect();
    expect((await clickupNames(owner)).sort()).toEqual([...CLICKUP, ...SEND].sort());
    const r = await call(owner, 'clickup_send_message', { channel_id: 'c1', content: 'deploy done' });
    expect(r.json).toMatchObject({ status: 'pending_approval', to: { channel: 'dev-team', workspace: 'Acme' } });
    expect((await call(owner, 'clickup_send_message', { channel_id: 'nope', content: 'hi' })).isError).toBe(true);
    expect((await budiNames()).sort()).toEqual([...CLICKUP, ...SEND].sort());

    // A user saving their own settings leaves the switch and their connection as they are.
    expect((await budiPut({ workspaceId: '900', timeZone: '' })).json()).toMatchObject({ workspaceId: '900', send: true, connected: true });
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json()).toMatchObject({ workspaceId: '900', send: true });
    await setSend(false);
    expect((await budiNames()).sort()).toEqual(CLICKUP);
  });

  it('hold every message for whoever sent the turn, who may change it before it goes out, and tell the chat', async () => {
    const calls: string[] = [];
    const t = await withClickUp(calls);
    await allowSend(t);
    const told = (re: RegExp) => until(() => [...t.store.listQueue(a.id), ...t.store.listTurns(a.id)].some((x) => re.test(x.prompt)));
    const { a } = await twoConvs(await t.connect());
    const agent = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'owner')}` });

    const thread = await call(agent, 'clickup_send_message', { channel_id: 'c1', reply_to: 'm3', content: 'done' });
    expect(thread.json).toMatchObject({ status: 'pending_approval', to: { reply_to: 'm3', thread: { author: 'luz', preview: 'still fixing the invoice export' } } });
    const dm = await call(agent, 'clickup_send_message', { to_user_id: '22', content: 'hi sari' });
    expect(dm.json).toMatchObject({ status: 'pending_approval', to: { to_user: { id: '22', name: 'sari' } } });
    expect((await call(agent, 'clickup_send_message', { channel_id: 'c1', to_user_id: '22', content: 'x' })).isError).toBe(true);
    expect(changes(calls)).toEqual([]);

    // Nobody else sees or decides them: the messages go out as the one who asked.
    const sari = { authorization: `Bearer ${(await mkUser(t, 'u-sari')).token}` };
    expect((await t.app.inject({ url: '/api/clickup/approvals', headers: sari })).json()).toEqual([]);
    const id = (thread.json as { approval_id: number }).approval_id;
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: sari })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/clickup/approvals', headers: AUTH })).json()).toHaveLength(2);

    const ok = await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH, payload: { content: 'done, deployed' } });
    expect(ok.json()).toMatchObject({ status: 'sent', content: 'done, deployed', edited: true, messageId: 'new1' });
    expect(changes(calls)).toEqual(['POST /api/v3/workspaces/900/chat/messages/m3/replies {"type":"message","content":"done, deployed","content_format":"text/md"}']);
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH })).statusCode).toBe(409);
    await told(/approved your message[\s\S]*> done, deployed/);

    const dmId = (dm.json as { approval_id: number }).approval_id;
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${dmId}/approve`, headers: AUTH })).json()).toMatchObject({ status: 'sent' });
    expect(changes(calls).slice(1)).toEqual(['POST /api/v3/workspaces/900/chat/channels/direct_message {"user_ids":["22"]}', 'POST /api/v3/workspaces/900/chat/channels/c2/messages {"type":"message","content":"hi sari","content_format":"text/md"}']);
    expect((await call(agent, 'clickup_send_status', { approval_id: dmId })).json).toMatchObject({ status: 'sent' });

    const no = await call(agent, 'clickup_send_message', { channel_id: 'c1', content: 'nope' });
    const noId = (no.json as { approval_id: number }).approval_id;
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${noId}/reject`, headers: AUTH })).json()).toMatchObject({ status: 'rejected' });
    expect(changes(calls)).toHaveLength(3);
    await told(/did not send your message/);
  });

  it('read tasks, time and Docs, and hold every change for whoever sent the turn until they approve it', async () => {
    const calls: string[] = [];
    const t = await withClickUp(calls);
    const { p, a } = await twoConvs(await t.connect());
    writeFileSync(join(t.store.getProject(p.id)!.path, 'a.xlsx'), 'xlsx');
    const told = (re: RegExp) => until(() => [...t.store.listQueue(a.id), ...t.store.listTurns(a.id)].some((x) => re.test(x.prompt)));
    const connect = () => t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'owner')}` });

    // Reading needs no switch; changing is not even offered without it.
    const reader = await connect();
    expect((await call(reader, 'clickup_find_tasks', { query: 'rekap' })).json).toMatchObject({ tasks: [{ id: 't1', status: 'in progress' }] });
    expect((await call(reader, 'clickup_get_task', { task: 'DEV-42' })).json).toMatchObject({ id: 't1', checklists: [{ id: 'ck1' }] });
    expect((await call(reader, 'clickup_time_entries', { from: '2026-10-08', to: '2026-10-09', workspace_ids: ['900'] })).json).toMatchObject({ total: '3h 30m' });
    expect((await call(reader, 'clickup_get_doc', { doc_id: 'doc1', page_id: 'p1' })).json).toMatchObject({ doc_id: 'doc1', page: { name: 'Deploy' } });
    expect((await call(reader, 'clickup_list_spaces')).json).toMatchObject([{ id: 's1', lists: [{ id: 'l1' }] }]);
    expect((await call(reader, 'clickup_get_list', { list_id: 'nope' })).isError).toBe(true);
    expect(await clickupNames(reader)).not.toContain('clickup_update_task');

    await allowSend(t);
    const agent = await connect();
    const asked = await call(agent, 'clickup_update_task', { task: 't1', status: 'done', add_tags: ['urgent fix'] });
    expect(asked.json).toMatchObject({ status: 'pending_approval', change: 'Change task "Rekap transaksi"\nStatus: in progress → done\nAdd tags: urgent fix' });
    expect((await call(agent, 'clickup_update_task', { task: 't1', status: 'review' })).text).toMatch(/no status "review"/);
    expect(changes(calls)).toEqual([]);

    const id = (asked.json as { approval_id: number }).approval_id;
    const sari = { authorization: `Bearer ${(await mkUser(t, 'u-sari')).token}` };
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: sari })).statusCode).toBe(404);
    const [waiting] = (await t.app.inject({ url: '/api/clickup/approvals', headers: AUTH })).json();
    expect(waiting).toMatchObject({ id, status: 'pending', action: { title: 'Change task "Rekap transaksi"', url: 'https://app.clickup.com/t/t1' } });

    const ok = (await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH })).json();
    expect(ok).toMatchObject({ status: 'sent', messageId: 't1', action: { calls: [] } }); // made once: its calls are not kept
    expect(ok.outcome).toMatch(/^Done .*https:\/\/app\.clickup\.com\/t\/t1$/);
    expect(changes(calls)).toEqual(['PUT /api/v2/task/t1 {"status":"done"}', 'POST /api/v2/task/t1/tag/urgent%20fix undefined']);
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH })).statusCode).toBe(409);
    await told(/approved your change \(Change task "Rekap transaksi"\) and it was made/);
    expect((await call(agent, 'clickup_send_status', { approval_id: id })).json).toMatchObject({ status: 'sent' });

    const no = await call(agent, 'clickup_comment_task', { task: 't1', text: 'beres' });
    const noId = (no.json as { approval_id: number }).approval_id;
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${noId}/reject`, headers: AUTH })).json()).toMatchObject({ status: 'rejected' });
    await told(/did not approve your change \(Comment on task "Rekap transaksi"\)/);

    // ClickUp refusing a step is a failure; one cut off midway is unknown, and is not made again.
    const fail = async (text: string, files?: string[]) => {
      const r = await call(agent, 'clickup_comment_task', { task: 't1', text, files });
      return (await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${(r.json as { approval_id: number }).approval_id}/approve`, headers: AUTH })).json();
    };
    expect(await fail('refuse this')).toMatchObject({ status: 'failed' });
    const cut = await fail('boom', ['a.xlsx']);
    expect(cut).toMatchObject({ status: 'unknown' });
    expect(cut.outcome).toMatch(/Already on task "Rekap transaksi".*a\.xlsx/);
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${cut.id}/approve`, headers: AUTH })).statusCode).toBe(409);
    expect(changes(calls).map((c) => c.split(' ')[0])).toEqual([
      'PUT', 'POST', 'POST', 'UPLOAD', 'POST',
    ]);
  });

  it('send files from the chat folder in the message itself, as they were when asked', async () => {
    const calls: string[] = [];
    const t = await withClickUp(calls);
    await allowSend(t);
    const { p, a } = await twoConvs(await t.connect());
    const dir = t.store.getProject(p.id)!.path;
    writeFileSync(join(dir, 'rekap.xlsx'), 'xlsx-bytes');
    const agent = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'owner')}` });
    const ask = (args: Record<string, unknown>) => call(agent, 'clickup_send_message', { channel_id: 'c1', content: 'rekap terlampir', ...args });
    expect((await agent.listTools()).tools.find((x) => x.name === 'clickup_send_message')!.description).toMatch(/message itself/);

    expect((await ask({ files: ['nope.xlsx'] })).text).toMatch(/no file nope.xlsx/);
    expect((await ask({ files: ['../outside.txt'] })).isError).toBe(true);
    const ok = await ask({ files: ['rekap.xlsx'] });
    expect(ok.json).toMatchObject({ status: 'pending_approval', files: [{ name: 'rekap.xlsx', size: 10 }], files_go: 'into the message itself' });
    expect((ok.json as { task?: unknown }).task).toBeUndefined();
    writeFileSync(join(dir, 'rekap.xlsx'), 'changed after asking'); // what the person approved is what goes
    expect(changes(calls)).toEqual([]);

    const id = (ok.json as { approval_id: number }).approval_id;
    const r = await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH });
    expect(r.json()).toMatchObject({ status: 'sent', messageId: 'new1' });
    expect(changes(calls)).toEqual([
      'UPLOAD c1 rekap.xlsx 10',
      `clickup_send_chat_message ${JSON.stringify({ channel_id: 'c1', content: 'rekap terlampir\n\n[rekap.xlsx](#attachment#f-rekap.xlsx)', content_format: 'text/md', workspace_id: '900' })}`,
    ]);
    expect(existsSync(join(t.cfg.stateDir, 'clickup-files', String(id)))).toBe(false);
    await until(() => [...t.store.listQueue(a.id), ...t.store.listTurns(a.id)].some((x) => /with 1 file\(s\) in the message itself/.test(x.prompt)));

    // disconnected between asking and approving: nothing is sent, and it can be approved after connecting again
    const late = ((await ask({ content: 'lagi', files: ['rekap.xlsx'] })).json as { approval_id: number }).approval_id;
    await t.app.inject({ method: 'DELETE', url: '/api/settings/clickup/oauth', headers: AUTH });
    const refused = await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${late}/approve`, headers: AUTH });
    expect(refused.statusCode).toBe(409);
    expect(refused.json().error).toMatch(/not connected/);
    expect(changes(calls)).toHaveLength(2);
    await connectClickUp(t);
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${late}/approve`, headers: AUTH })).json()).toMatchObject({ status: 'sent' });
    expect(changes(calls)).toHaveLength(4);
  });

  it('attach files from the chat folder to a task, with a comment that links them or alone, once approved', async () => {
    const calls: string[] = [];
    const t = await withClickUp(calls);
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { workspaceId: '900', timeZone: '', send: true } });
    const { p, a } = await twoConvs(await t.connect());
    const dir = t.store.getProject(p.id)!.path;
    writeFileSync(join(dir, 'shot.png'), 'png-bytes');
    const agent = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'owner')}` });
    const approve = async (id: number) => (await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH })).json();
    const sent = () => calls.filter((c) => /^(POST|UPLOAD) /.test(c));
    const filesOf = (id: number) => join(t.cfg.stateDir, 'clickup-files', String(id));

    expect((await call(agent, 'clickup_attach_file', { task: 't1', files: ['nope.png'] })).text).toMatch(/no file nope.png/);
    expect((await call(agent, 'clickup_attach_file', { task: 't404', files: ['shot.png'] })).text).toMatch(/no task t404/);
    // A file the agent made for the person is outside the project, in the chat's own folder: this chat's only.
    const other = 'another-chat';
    try {
      for (const id of [a.id, other]) {
        mkdirSync(templateWorkDir(id), { recursive: true });
        writeFileSync(join(templateWorkDir(id), 'data.xlsx'), 'xlsx-bytes');
      }
      expect((await call(agent, 'clickup_attach_file', { task: 't404', files: [join(templateWorkDir(a.id), 'data.xlsx')] })).text).toMatch(/no task t404/);
      expect((await call(agent, 'clickup_attach_file', { task: 't1', files: [join(templateWorkDir(other), 'data.xlsx')] })).text).toMatch(/no file .*data\.xlsx/);
    } finally {
      for (const id of [a.id, other]) rmSync(templateWorkDir(id), { recursive: true, force: true });
    }
    const note = await call(agent, 'clickup_comment_task', { task: 'DEV-42', text: 'lihat gambar', files: ['shot.png'] });
    expect(note.json).toMatchObject({
      status: 'pending_approval',
      change: 'Comment on task "Rekap transaksi"\nComment: lihat gambar\nFiles: shot.png (9 B): attached to the task, linked at the end of the comment',
    });
    const noteId = (note.json as { approval_id: number }).approval_id;
    const [waiting] = (await t.app.inject({ url: '/api/clickup/approvals', headers: AUTH })).json();
    expect(waiting).toMatchObject({ id: noteId, files: [{ name: 'shot.png', size: 9 }], task: { id: 't1' } });
    writeFileSync(join(dir, 'shot.png'), 'changed after asking'); // what the person approved is what goes
    expect(sent()).toEqual([]);

    expect(await approve(noteId)).toMatchObject({ status: 'sent', messageId: 'cm9' });
    expect(sent()).toEqual([
      'UPLOAD /api/v2/task/t1/attachment shot.png 9',
      `POST /api/v2/task/t1/comment ${JSON.stringify({ notify_all: false, comment: [{ text: 'lihat gambar\n', attributes: {} }, { text: '\n📎 ', attributes: {} }, { text: 'shot.png', attributes: { link: 'https://files.example/shot.png' } }] })}`,
    ]);
    expect(existsSync(filesOf(noteId))).toBe(false);
    await until(() => [...t.store.listQueue(a.id), ...t.store.listTurns(a.id)].some((x) => /with 1 file\(s\) attached to task "Rekap transaksi"/.test(x.prompt)));

    const alone = await call(agent, 'clickup_attach_file', { task: 't1', files: ['shot.png'] });
    expect(alone.json).toMatchObject({ status: 'pending_approval', change: 'Attach a file to task "Rekap transaksi"\nFiles: shot.png (20 B)' });
    const aloneId = (alone.json as { approval_id: number }).approval_id;
    const done = await approve(aloneId);
    expect(done).toMatchObject({ status: 'sent' });
    expect(done.outcome).toMatch(/^Done .*https:\/\/app\.clickup\.com\/t\/t1$/);
    expect(sent().slice(2)).toEqual(['UPLOAD /api/v2/task/t1/attachment shot.png 20']);

    // A rejected one uploads nothing and its files are dropped.
    const no = ((await call(agent, 'clickup_attach_file', { task: 't1', files: ['shot.png'] })).json as { approval_id: number }).approval_id;
    expect(existsSync(filesOf(no))).toBe(true);
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${no}/reject`, headers: AUTH })).json()).toMatchObject({ status: 'rejected' });
    expect(existsSync(filesOf(no))).toBe(false);
    expect(sent()).toHaveLength(3);
  });

  it('keep files whose names differ only in case apart, and keep the files of an upload cut off midway until dismissed', async () => {
    const calls: string[] = [];
    const t = await withClickUp(calls);
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { workspaceId: '900', timeZone: '', send: true } });
    const { p, a } = await twoConvs(await t.connect());
    const dir = t.store.getProject(p.id)!.path;
    for (const [sub, name, body] of [['a', 'rekap.xlsx', 'first'], ['b', 'REKAP.xlsx', 'second one'], ['b', 'bad-502.xlsx', 'x']]) {
      mkdirSync(join(dir, sub!), { recursive: true });
      writeFileSync(join(dir, sub!, name!), body!);
    }
    const agent = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'owner')}` });
    const ask = async (files: string[]) => ((await call(agent, 'clickup_attach_file', { task: 't1', files })).json as { approval_id: number }).approval_id;
    const approve = async (id: number) => (await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH })).json();
    const filesOf = (id: number) => join(t.cfg.stateDir, 'clickup-files', String(id));

    const both = await ask(['a/rekap.xlsx', 'b/REKAP.xlsx']);
    expect(await approve(both)).toMatchObject({ status: 'sent' });
    expect(calls.filter((c) => c.startsWith('UPLOAD '))).toEqual(['UPLOAD /api/v2/task/t1/attachment rekap.xlsx 5', 'UPLOAD /api/v2/task/t1/attachment REKAP.xlsx 10']);
    expect(existsSync(filesOf(both))).toBe(false);

    const cut = await ask(['a/rekap.xlsx', 'b/bad-502.xlsx']);
    const r = await approve(cut);
    expect(r).toMatchObject({ status: 'unknown' });
    expect(r.outcome).toMatch(/Already on task "Rekap transaksi".*rekap\.xlsx/);
    expect(existsSync(filesOf(cut))).toBe(true);
    expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${cut}/dismiss`, headers: AUTH })).json()).toMatchObject({ status: 'dismissed' });
    expect(existsSync(filesOf(cut))).toBe(false);
  });

  it('keeps a pending write bound to its ClickUp user when the API key changes', async () => {
    const calls: string[] = [];
    const inner = fakeClickUp(calls);
    const t = await boot({ clickupFetch: async (input, init) => {
      if (new Headers(init?.headers).get('authorization') === 'pk_another' && String(input).endsWith('/user')) {
        return Response.json({ user: { id: 99 } });
      }
      return inner(input, init);
    } });
    await connectClickUp(t);
    await allowSend(t);
    const pending = await call(await t.connect(), 'clickup_send_message', { channel_id: 'c1', content: 'draft' });
    const path = `/api/clickup/approvals/${pending.json.approval_id}/approve`;
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH,
      payload: { apiKey: 'pk_another', workspaceId: '900', timeZone: 'UTC' } });
    expect((await t.app.inject({ method: 'POST', url: path, headers: AUTH })).json()).toMatchObject({ status: 'failed' });
    expect(changes(calls)).toEqual([]);
  });

  it('refuse a request kept from before ClickUp went through its own MCP server, which is rejected and asked again', async () => {
    const calls: string[] = [];
    const t = await withClickUp(calls);
    await allowSend(t);
    const { a } = await twoConvs(await t.connect());
    const agent = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'owner')}` });
    const id = ((await call(agent, 'clickup_update_task', { task: 't1', name: 'x' })).json as { approval_id: number }).approval_id;
    const kept = JSON.parse(t.store.getKv('clickup_approvals')!);
    const row = (Array.isArray(kept) ? kept : kept.items ?? kept.approvals).find((x: { id: number }) => x.id === id);
    delete row.clickupUserId;
    row.action.calls = [{ method: 'PUT', path: '/api/v2/task/t1', body: { name: 'x' }, what: 'changing the task' }];
    t.store.setKv('clickup_approvals', JSON.stringify(kept));
    const r = await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH });
    expect(JSON.stringify(r.json())).toMatch(/reject it and ask again/i);
    expect(changes(calls)).toEqual([]);
  });

  it('show a request only to whoever asked, who alone decides it, and call a 5xx on sending unknown, not failed', async () => {
    const inner = fakeClickUp();
    const status = { code: 502 };
    const flaky = (async (input: string | URL, init?: RequestInit) => (status.code && init?.method === 'POST' && String(input).endsWith('/messages')
      ? new Response('{"err":"bad gateway"}', { status: status.code }) : inner(input, init))) as typeof fetch;
    const t = await boot({ clickupFetch: flaky });
    await connectClickUp(t);
    await allowSend(t);
    const { a } = await twoConvs(await t.connect());
    const agent = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'owner')}` });
    const asked = await call(agent, 'clickup_send_message', { channel_id: 'c1', content: 'secret draft' });
    const id = (asked.json as { approval_id: number }).approval_id;

    const budiAuth = { authorization: `Bearer ${(await mkUser(t, 'u-budi')).token}` };
    await connectClickUp(t, budiAuth);
    const budi = await t.connect(budiAuth);
    expect((await call(budi, 'clickup_send_status', { approval_id: id })).isError).toBe(true);
    const own = (await call(budi, 'clickup_send_message', { channel_id: 'c1', content: 'mine' })).json as { approval_id: number };
    expect((await call(budi, 'clickup_send_status', { approval_id: own.approval_id })).json).toMatchObject({ status: 'pending' });
    expect((await call(agent, 'clickup_send_status', { approval_id: own.approval_id })).isError).toBe(true);
    // The same chat, another person's turn: the owner's request is not theirs to read.
    const budiTurn = await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, 'u-budi')}` });
    expect((await call(budiTurn, 'clickup_send_status', { approval_id: id })).isError).toBe(true);
    expect((await call(agent, 'clickup_send_status', { approval_id: id })).json).toMatchObject({ status: 'pending' });

    // Each sees their own only, and the owner cannot send as the user.
    const ids = async (headers: Record<string, string>) => (await t.app.inject({ url: '/api/clickup/approvals', headers })).json().map((x: { id: number }) => x.id);
    expect(await ids(AUTH)).toEqual([id]);
    expect(await ids(budiAuth)).toEqual([own.approval_id]);
    for (const verb of ['approve', 'reject']) {
      expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${own.approval_id}/${verb}`, headers: AUTH })).statusCode).toBe(404);
      expect((await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/${verb}`, headers: budiAuth })).statusCode).toBe(404);
    }

    const r = await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${id}/approve`, headers: AUTH });
    expect(r.json()).toMatchObject({ status: 'unknown' });
    expect(await ids(AUTH)).toContain(id);
    status.code = 400; // refused outright: nothing was posted
    const r2 = await t.app.inject({ method: 'POST', url: `/api/clickup/approvals/${own.approval_id}/approve`, headers: budiAuth });
    expect(r2.json()).toMatchObject({ status: 'failed' });

    // The user's requests go with them, and their ids are not given out again.
    const last = (await call(budi, 'clickup_send_message', { channel_id: 'c1', content: 'last' })).json as { approval_id: number };
    const budiId = t.store.userKeyOf('u-budi');
    expect((await t.app.inject({ method: 'DELETE', url: `/api/users/${budiId}`, headers: AUTH })).statusCode).toBe(204);
    expect(t.store.getKv('clickup_approvals')).not.toContain('"last"');
    const again = (await call(agent, 'clickup_send_message', { channel_id: 'c1', content: 'again' })).json as { approval_id: number };
    expect(again.approval_id).toBeGreaterThan(last.approval_id);
  });
});

describe('Settings → ClickUp', () => {
  const put = (t: Booted, payload: object, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers, payload });
  const NOTHING = { hasApiKey: false, connected: false, workspaceId: '', timeZone: '', send: false };

  it('uses the saved personal key for ordinary tools without an OAuth connection', async () => {
    const urls: string[] = [];
    const t = await boot({ clickupFetch: async (input, init) => {
      const url = new URL(String(input));
      urls.push(url.origin);
      expect(new Headers(init?.headers).get('authorization')).toBe('pk_personal');
      if (url.pathname === '/api/v2/user') return Response.json({ user: { id: 11, username: 'API user' } });
      if (url.pathname === '/api/v2/team') return Response.json({ teams: [{ id: '900', name: 'Acme' }] });
      return new Response(null, { status: 404 });
    } });
    const saved = await put(t, { workspaceId: '900', timeZone: 'UTC', apiKey: 'pk_personal' });
    expect(saved.json()).toMatchObject({ hasApiKey: true });
    expect(saved.body).not.toContain('pk_personal');
    const result = await call(await t.connect(), 'clickup_whoami');
    expect(result.json.user.username).toBe('API user');
    expect(new Set(urls)).toEqual(new Set(['https://api.clickup.com']));
    await put(t, { workspaceId: '900', timeZone: 'UTC' });
    expect((await call(await t.connect(), 'clickup_whoami')).json.user.username).toBe('API user');
    await put(t, { workspaceId: '900', timeZone: 'UTC', apiKey: '' });
    expect(t.store.getKv('clickup')).not.toContain('pk_personal');
  });

  it('saves preferences and ignores the retired token field from older panels', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json()).toEqual(NOTHING);
    const saved = await put(t, { workspaceId: '900', timeZone: 'Asia/Jakarta' });
    expect(saved.json()).toEqual({ hasApiKey: false, connected: false, workspaceId: '900', timeZone: 'Asia/Jakarta', send: false });
    await put(t, { token: 'pk_test', workspaceId: '900', timeZone: '' }); // a token sent by an old panel page is not kept
    expect(t.store.getKv('clickup')).not.toContain('pk_test');
  });

  it('connects each person\'s own ClickUp by a sign-in that only whoever started it can finish, once', async () => {
    const calls: string[] = [];
    const t = await boot({ clickupFetch: fakeClickUp(calls) });
    const budi = { authorization: `Bearer ${(await mkUser(t, 'u-budi')).token}` };
    const post = (path: string, headers: Record<string, string>, payload?: object) =>
      t.app.inject({ method: 'POST', url: `/api/settings/clickup/oauth/${path}`, headers, payload });
    const connected = async (headers: Record<string, string>) => (await t.app.inject({ url: '/api/settings/clickup', headers })).json().connected;

    const started = await post('start', AUTH);
    expect(started.statusCode).toBe(200);
    const url = new URL(started.json().url);
    expect(url.origin + url.pathname).toBe('https://mcp.clickup.com/oauth/authorize');
    const q = url.searchParams;
    expect(Object.fromEntries(q)).toMatchObject({
      response_type: 'code', client_id: 'client1', redirect_uri: 'http://localhost:9876/', code_challenge_method: 'S256', scope: 'read write',
      resource: 'https://mcp.clickup.com/mcp',
    });
    const state = q.get('state')!;
    expect(state).toMatch(/^cu_/);

    expect((await post('finish', budi, { code: 'code1', state })).statusCode).toBe(400); // not theirs
    expect((await post('finish', AUTH, { code: 'code1', state: 'cu_unknown' })).statusCode).toBe(400);
    const done = await post('finish', AUTH, { code: 'code1', state });
    expect(done.json()).toEqual({ ...NOTHING, connected: true });
    expect(done.body).not.toContain('mcp_test');
    expect((await post('finish', AUTH, { code: 'code1', state })).statusCode).toBe(400); // once
    expect(await connected(AUTH)).toBe(true);
    expect(await connected(budi)).toBe(false);

    // a code ClickUp refuses connects nothing; the client is registered once per panel address
    const bad = new URL((await post('start', budi)).json().url).searchParams.get('state')!;
    expect((await post('finish', budi, { code: 'wrong', state: bad })).statusCode).toBe(502);
    expect(await connected(budi)).toBe(false);
    expect(calls.filter((c) => c.startsWith('REGISTER'))).toEqual(['REGISTER http://localhost:9876/']);

    // saving the other settings keeps the connection; disconnecting forgets it
    expect((await put(t, { workspaceId: '900', timeZone: '' })).json()).toMatchObject({ connected: true, workspaceId: '900' });
    expect((await t.app.inject({ method: 'DELETE', url: '/api/settings/clickup/oauth', headers: AUTH })).json()).toMatchObject({ connected: false, workspaceId: '900' });
    expect(t.store.getKv('clickup')).not.toContain('mcp_test');
  });

  it('refuses a sign-in from an http address that is not this machine, which ClickUp would not take', async () => {
    const calls: string[] = [];
    const t = await boot({ clickupFetch: fakeClickUp(calls), cfg: { origin: undefined } });
    const start = (origin: string) => t.app.inject({ method: 'POST', url: '/api/settings/clickup/oauth/start', headers: { ...AUTH, origin } });
    const r = await start('http://192.168.1.20:9876');
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toMatch(/https address, or to http:\/\/localhost: the panel is open on http:\/\/192\.168\.1\.20:9876/);
    expect(calls).toEqual([]);
    for (const ok of ['http://127.0.0.1:9876', 'http://localhost:9876', 'https://dalang.example']) expect((await start(ok)).statusCode).toBe(200);
    expect(calls).toEqual(['REGISTER http://127.0.0.1:9876/', 'REGISTER http://localhost:9876/', 'REGISTER https://dalang.example/']);
  });

  it('rejects a bad time zone or workspace id', async () => {
    const t = await boot();
    expect((await put(t, { workspaceId: '', timeZone: 'Mars/Base' })).statusCode).toBe(400);
    expect((await put(t, { workspaceId: 'abc', timeZone: '' })).statusCode).toBe(400);
    expect(t.store.getKv('clickup')).toBeNull();
  });

  it('tests the connection against ClickUp', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH })).statusCode).toBe(400);
    await connectClickUp(t);
    const r = await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH });
    expect(r.json()).toMatchObject({ user: { username: 'luz' }, workspaces: [{ id: '900' }, { id: '901' }], time_zone: 'Asia/Jakarta' });
    const s = JSON.parse(t.store.getKv('clickup')!);
    s.users.owner.apiKey = 'pk_gone';
    t.store.setKv('clickup', JSON.stringify(s));
    expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH })).statusCode).toBe(502);
  });

  it('is each user\'s own: nobody sees or changes another person\'s', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    await connectClickUp(t);
    await put(t, { workspaceId: '900', timeZone: '' });
    for (const who of ['sari', 'budi'] as const) {
      const h = { authorization: `Bearer ${(await mkUser(t, `u-${who}`)).token}` };
      const get = async () => (await t.app.inject({ url: '/api/settings/clickup', headers: h })).json();
      expect(await get()).toEqual(NOTHING);
      expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: h })).statusCode).toBe(400); // not on the owner's connection
      expect((await put(t, { workspaceId: '901', timeZone: 'Asia/Jakarta' }, h)).statusCode).toBe(200);
      expect(await get()).toEqual({ hasApiKey: false, connected: false, workspaceId: '901', timeZone: 'Asia/Jakarta', send: false });
      // clearing them leaves nothing of theirs behind
      await put(t, { workspaceId: '', timeZone: '' }, h);
      expect(Object.keys(JSON.parse(t.store.getKv('clickup')!).users)).toEqual(['owner']);
    }
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json()).toMatchObject({ connected: true, workspaceId: '900' });
    expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH })).statusCode).toBe(200);
  });
});

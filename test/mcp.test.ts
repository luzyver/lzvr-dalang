import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { fakeClickUp } from './fake-clickup.js';
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

const DEV_TOOLS = [
  'cancel_turn', 'create_conversation', 'get_approval', 'get_conversation', 'get_events', 'list_accounts',
  'list_conversations', 'list_projects', 'list_queue', 'remove_queue_item', 'send_prompt', 'set_draft', 'list_models', 'set_model',
  'memory_search', 'memory_save', 'memory_update', 'memory_forget',
];

describe('MCP for users with a role', () => {
  it('gives an admin user every tool', async () => {
    const t = await boot();
    const admin = await mkUser(t, 'sari', 'admin');
    const names = (await (await t.connect({ authorization: `Bearer ${admin.token}` })).listTools()).tools.map((x) => x.name);
    expect(names.sort()).toEqual([...ALL_TOOLS].sort());
  });

  it('gives a dev user the everyday tools, without project, session or account tools', async () => {
    const t = await boot();
    const dev = await mkUser(t, 'budi', 'dev');
    const c = await t.connect({ authorization: `Bearer ${dev.token}` });
    expect((await c.listTools()).tools.map((x) => x.name).sort()).toEqual([...DEV_TOOLS].sort());
    // and the missing tools really are missing, not just hidden
    const r = (await c.callTool({ name: 'create_project', arguments: { name: 'x', path: 'proj' } }).catch((e) => e)) as { isError?: boolean; message?: string };
    expect(Boolean(r.isError) || r instanceof Error).toBe(true);
    expect(t.store.listProjects()).toEqual([]);
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
  const allow = (t: Booted, models: string[], maxEffort: string) =>
    t.app.inject({ method: 'PUT', url: '/api/settings/agent-models', headers: AUTH, payload: { models, maxEffort } });

  it('keeps agents on the default until an admin allows models', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    const fromA = await t.connectAs(a.id);
    const r = await call(fromA, 'create_conversation', { project_id: p.id, model: 'gpt-big' });
    expect(r.isError).toBe(true);
    expect(r.text).toMatch(/not allowed any/);
    const listed = (await call(fromA, 'list_models')).json;
    expect(listed).toMatchObject({ backend: 'codex', models: [], efforts: [] });
    // Without a model it still works, on the default, and remembers who made it.
    const sub = (await call(fromA, 'create_conversation', { project_id: p.id })).json;
    expect(sub).toMatchObject({ parent: a.id, model: '', effective_model: null });
  });

  it('lets an agent pick and step up within the admin\'s list, for its own sub-agents only', async () => {
    const t = await boot();
    const c = await t.connect();
    const { p, a, b } = await twoConvs(c);
    expect((await allow(t, ['gpt-small', 'gpt-mid'], 'medium')).statusCode).toBe(204);
    t.store.setDefaultModel('gpt-small');
    const fromA = await t.connectAs(a.id);

    const listed = (await call(fromA, 'list_models')).json;
    expect(listed.models.map((m: { slug: string; rank: number }) => [m.rank, m.slug])).toEqual([[0, 'gpt-small'], [1, 'gpt-mid']]);
    expect(listed.efforts).toEqual(['low', 'medium']);
    expect(listed.default_model).toBe('gpt-small');

    const sub = (await call(fromA, 'create_conversation', { project_id: p.id, effort: 'low' })).json;
    expect(sub).toMatchObject({ parent: a.id, effective_model: 'gpt-small', effective_effort: 'low' });
    expect((await call(fromA, 'create_conversation', { project_id: p.id, model: 'gpt-huge' })).text).toMatch(/gpt-small, gpt-mid/);
    expect((await call(fromA, 'create_conversation', { project_id: p.id, effort: 'high' })).text).toMatch(/at most medium/);

    const up = (await call(fromA, 'set_model', { conversation_id: sub.id, model: 'gpt-mid', effort: 'medium' })).json;
    expect(up).toMatchObject({ model: 'gpt-mid', effort: 'medium', effective_model: 'gpt-mid' });
    expect(t.store.getConversation(sub.id)).toMatchObject({ model: 'gpt-mid', effort: 'medium' });
    expect((await call(fromA, 'get_conversation', { conversation_id: sub.id })).json.effective_model).toBe('gpt-mid');
    expect((await call(fromA, 'set_model', { conversation_id: sub.id, model: '' })).json.effective_model).toBe('gpt-small');
    expect((await call(fromA, 'set_model', { conversation_id: a.id, model: 'gpt-mid' })).isError).toBe(false);

    // A chat it did not start is not its to change, and an empty call changes nothing.
    expect((await call(fromA, 'set_model', { conversation_id: b.id, model: 'gpt-mid' })).text).toMatch(/only change its own/);
    expect((await call(fromA, 'set_model', { conversation_id: sub.id })).text).toMatch(/give model/);
    expect(t.store.getConversation(b.id)!.model).toBe('');
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

  it('keeps the agent model list per backend and for admins only', async () => {
    const t = await boot();
    const put = await t.app.inject({ method: 'PUT', url: '/api/settings/agent-models', headers: AUTH, payload: { models: ['opus'], maxEffort: 'high', backend: 'claude' } });
    expect(put.statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/settings/agent-models?backend=claude', headers: AUTH })).json()).toEqual({ models: ['opus'], maxEffort: 'high' });
    expect((await t.app.inject({ url: '/api/settings/agent-models', headers: AUTH })).json()).toEqual({ models: [], maxEffort: '' });
    const bad = await t.app.inject({ method: 'PUT', url: '/api/settings/agent-models', headers: AUTH, payload: { models: ['-x'], maxEffort: '' } });
    expect(bad.statusCode).toBe(400);
    const dev = await mkUser(t, 'budi', 'dev');
    expect((await t.app.inject({ url: '/api/settings/agent-models', headers: { authorization: `Bearer ${dev.token}` } })).statusCode).toBe(403);
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

  it('stay within the admin\'s limits', async () => {
    const t = await boot();
    const { p, a } = await twoConvs(await t.connect());
    expect((await policy(t, { maxChildren: 1, maxDepth: 1, autoSend: true })).statusCode).toBe(204);
    const fromA = await t.connectAs(a.id);
    const sub = (await call(fromA, 'create_conversation', { project_id: p.id })).json;
    expect((await call(fromA, 'create_conversation', { project_id: p.id })).text).toMatch(/already has 1 sub-agents/);
    expect((await call(await t.connectAs(sub.id), 'create_conversation', { project_id: p.id })).text).toMatch(/1 level\(s\) deep/);
    await policy(t, { maxChildren: 0, maxDepth: 2, autoSend: true });
    expect((await call(fromA, 'create_conversation', { project_id: p.id })).text).toMatch(/turned sub-agents off/);
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

  it('keep their limits in admin settings', async () => {
    const t = await boot();
    expect((await t.app.inject({ url: '/api/settings/subagents', headers: AUTH })).json())
      .toMatchObject({ maxChildren: 5, maxDepth: 2, autoSend: true, mode: 'asked', guide: '', defaultGuide: expect.stringContaining('create_conversation') });
    expect((await policy(t, { mode: 'auto' } as never)).statusCode).toBe(204); // a part leaves the rest as it was
    expect(t.store.getSubagentPolicy()).toMatchObject({ maxChildren: 5, mode: 'auto' });
    expect((await policy(t, { mode: 'always' } as never)).statusCode).toBe(400);
    expect((await policy(t, { maxChildren: 99, maxDepth: 1, autoSend: true })).statusCode).toBe(400);
    const dev = await mkUser(t, 'budi', 'dev');
    expect((await t.app.inject({ url: '/api/settings/subagents', headers: { authorization: `Bearer ${dev.token}` } })).statusCode).toBe(403);
  });
});

describe('ClickUp tools', () => {
  const CLICKUP = ['clickup_chat_history', 'clickup_list_channels', 'clickup_whoami'];
  const clickupNames = async (c: C) => (await c.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith('clickup_'));
  /** Boot with the fake ClickUp API and, unless told otherwise, a token saved in Settings → ClickUp. */
  async function withClickUp(token = 'pk_test') {
    const t = await boot({ clickupFetch: fakeClickUp() });
    const r = await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { token, workspaceId: '', timeZone: '' } });
    expect(r.statusCode).toBe(200);
    return t;
  }

  it('are not there until a ClickUp token is saved, and go away when it is removed', async () => {
    const t = await withClickUp('');
    expect(await clickupNames(await t.connect())).toEqual([]);
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { token: 'pk_test', workspaceId: '', timeZone: '' } });
    expect((await clickupNames(await t.connect())).sort()).toEqual(CLICKUP);
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { token: '', workspaceId: '', timeZone: '' } });
    expect(await clickupNames(await t.connect())).toEqual([]);
  });

  it('are given to the owner only, not to other admins or devs', async () => {
    const t = await withClickUp();
    const owner = await t.connect();
    expect((await clickupNames(owner)).sort()).toEqual(CLICKUP);
    const r = await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-10' });
    expect(r.json.messages.map((m: { id: string }) => m.id)).toEqual(['m1', 'm3', 'd1m', 'm4']);
    const only = await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-10', workspace_ids: ['901'] });
    expect(only.json.messages.map((m: { id: string }) => m.id)).toEqual(['d1m']);
    expect((await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-01' })).isError).toBe(true);
    for (const role of ['admin', 'dev'] as const) {
      const u = await mkUser(t, `u-${role}`, role);
      expect(await clickupNames(await t.connect({ authorization: `Bearer ${u.token}` }))).toEqual([]);
    }
  });

  it('reach an agent only during a turn the owner sent', async () => {
    const t = await withClickUp();
    const { a } = await twoConvs(await t.connect());
    const as = (author: string) => t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, author)}` });
    expect((await clickupNames(await as('owner'))).sort()).toEqual(CLICKUP);
    for (const author of ['', 'budi']) expect(await clickupNames(await as(author))).toEqual([]);
  });

  it('reach every user once the owner marks them for all users', async () => {
    const t = await withClickUp();
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { workspaceId: '', timeZone: '', allUsers: true } });
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json()).toMatchObject({ configured: true, allUsers: true });
    const dev = await mkUser(t, 'u-dev', 'dev');
    expect((await clickupNames(await t.connect({ authorization: `Bearer ${dev.token}` }))).sort()).toEqual(CLICKUP);
    const { a } = await twoConvs(await t.connect());
    for (const author of ['', 'budi']) {
      expect((await clickupNames(await t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, author)}` }))).sort()).toEqual(CLICKUP);
    }
  });

  it('send messages only once the owner allows it, to whoever gets the other tools', async () => {
    const t = await withClickUp();
    const setSend = (allUsers: boolean, send: boolean) =>
      t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { workspaceId: '', timeZone: '', allUsers, send } });
    const dev = await mkUser(t, 'u-dev', 'dev');
    const devNames = async () => clickupNames(await t.connect({ authorization: `Bearer ${dev.token}` }));
    expect(await clickupNames(await t.connect())).not.toContain('clickup_send_message');

    expect((await setSend(false, true)).json()).toMatchObject({ send: true, allUsers: false });
    const owner = await t.connect();
    expect((await clickupNames(owner)).sort()).toEqual([...CLICKUP, 'clickup_send_message'].sort());
    const r = await call(owner, 'clickup_send_message', { channel_id: 'c1', content: 'deploy done' });
    expect(r.json).toMatchObject({ sent: true, id: 'new1', channel: 'dev-team', workspace: 'Acme' });
    expect((await call(owner, 'clickup_send_message', { channel_id: 'nope', content: 'hi' })).isError).toBe(true);
    expect(await devNames()).toEqual([]);

    await setSend(true, true);
    expect(await devNames()).toContain('clickup_send_message');
    await setSend(true, false);
    expect((await devNames()).sort()).toEqual(CLICKUP);
  });
});

describe('Settings → ClickUp', () => {
  const put = (t: Booted, payload: object, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers, payload });

  it('saves the settings and never sends the token back', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json())
      .toEqual({ configured: false, tokenHint: '', workspaceId: '', timeZone: '', allUsers: false, send: false });
    const saved = await put(t, { token: ' pk_test ', workspaceId: '900', timeZone: 'Asia/Jakarta' });
    expect(saved.json()).toEqual({ configured: true, tokenHint: '…test', workspaceId: '900', timeZone: 'Asia/Jakarta', allUsers: false, send: false });
    expect(saved.body).not.toContain('pk_test');
    // leaving the token out keeps it
    expect((await put(t, { workspaceId: '', timeZone: '' })).json()).toMatchObject({ configured: true, tokenHint: '…test' });
    expect(t.store.getKv('clickup')).toContain('pk_test');
  });

  it('rejects a bad time zone or workspace id', async () => {
    const t = await boot();
    expect((await put(t, { token: 'pk_1', workspaceId: '', timeZone: 'Mars/Base' })).statusCode).toBe(400);
    expect((await put(t, { token: 'pk_1', workspaceId: 'abc', timeZone: '' })).statusCode).toBe(400);
    expect(t.store.getKv('clickup')).toBeNull();
  });

  it('tests the saved token against ClickUp', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH })).statusCode).toBe(400);
    await put(t, { token: 'pk_test', workspaceId: '', timeZone: '' });
    const r = await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH });
    expect(r.json()).toMatchObject({ user: { username: 'luz' }, workspaces: [{ id: '900' }, { id: '901' }], time_zone: 'Asia/Jakarta' });
    await put(t, { token: 'pk_wrong', workspaceId: '', timeZone: '' });
    expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH })).statusCode).toBe(502);
  });

  it('is for the owner only', async () => {
    const t = await boot();
    for (const role of ['admin', 'dev'] as const) {
      const h = { authorization: `Bearer ${(await mkUser(t, `u-${role}`, role)).token}` };
      expect((await t.app.inject({ url: '/api/settings/clickup', headers: h })).statusCode).toBe(403);
      expect((await put(t, { token: 'pk_x', workspaceId: '', timeZone: '' }, h)).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: h })).statusCode).toBe(403);
    }
  });
});

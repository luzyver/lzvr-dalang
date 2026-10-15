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
];
const AGENT_TOOLS = [
  'create_conversation', 'get_approval', 'get_conversation', 'get_events', 'list_accounts',
  'list_conversations', 'list_projects', 'list_queue', 'send_prompt',
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
  'list_conversations', 'list_projects', 'list_queue', 'remove_queue_item', 'send_prompt', 'set_draft',
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

describe('ClickUp tools', () => {
  const CLICKUP = ['clickup_chat_history', 'clickup_list_channels', 'clickup_whoami'];
  const clickupNames = async (c: C) => (await c.listTools()).tools.map((x) => x.name).filter((n) => n.startsWith('clickup_'));
  /** Boot with the fake ClickUp API and, unless told otherwise, a token saved in Settings → ClickUp. */
  async function withClickUp(token = 'pk_test') {
    const t = await boot({ clickupFetch: fakeClickUp() });
    const r = await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { token, workspaceId: '', timeZone: '', workHours: '' } });
    expect(r.statusCode).toBe(200);
    return t;
  }

  it('are not there until a ClickUp token is saved, and go away when it is removed', async () => {
    const t = await withClickUp('');
    expect(await clickupNames(await t.connect())).toEqual([]);
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { token: 'pk_test', workspaceId: '', timeZone: '', workHours: '' } });
    expect((await clickupNames(await t.connect())).sort()).toEqual(CLICKUP);
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { token: '', workspaceId: '', timeZone: '', workHours: '' } });
    expect(await clickupNames(await t.connect())).toEqual([]);
  });

  it('are given to the owner only, not to other admins or devs', async () => {
    const t = await withClickUp();
    const owner = await t.connect();
    expect((await clickupNames(owner)).sort()).toEqual(CLICKUP);
    const r = await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-10', overtime_only: true });
    expect(r.json.messages.map((m: { id: string }) => m.id)).toEqual(['m3', 'd1m', 'm4']);
    const only = await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-10', workspace_ids: ['901'] });
    expect(only.json.messages.map((m: { id: string }) => m.id)).toEqual(['d1m']);
    expect((await call(owner, 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-01' })).isError).toBe(true);
    for (const role of ['admin', 'dev'] as const) {
      const u = await mkUser(t, `u-${role}`, role);
      expect(await clickupNames(await t.connect({ authorization: `Bearer ${u.token}` }))).toEqual([]);
    }
  });

  it('use the work hours saved in Settings', async () => {
    const t = await withClickUp();
    await t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers: AUTH, payload: { workspaceId: '', timeZone: '', workHours: '08:00-21:00' } });
    const r = await call(await t.connect(), 'clickup_chat_history', { from: '2026-10-08', to: '2026-10-08', overtime_only: true });
    expect(r.json).toMatchObject({ work_hours: '08:00-21:00', messages: [] });
  });

  it('reach an agent only during a turn the owner sent', async () => {
    const t = await withClickUp();
    const { a } = await twoConvs(await t.connect());
    const as = (author: string) => t.connect({ authorization: `Bearer ${t.dispatcher.issueMcpToken(a.id, author)}` });
    expect((await clickupNames(await as('owner'))).sort()).toEqual(CLICKUP);
    for (const author of ['', 'budi']) expect(await clickupNames(await as(author))).toEqual([]);
  });
});

describe('Settings → ClickUp', () => {
  const put = (t: Booted, payload: object, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method: 'PUT', url: '/api/settings/clickup', headers, payload });

  it('saves the settings and never sends the token back', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    expect((await t.app.inject({ url: '/api/settings/clickup', headers: AUTH })).json())
      .toEqual({ configured: false, tokenHint: '', workspaceId: '', timeZone: '', workHours: '', defaultWorkHours: '09:00-18:00' });
    const saved = await put(t, { token: ' pk_test ', workspaceId: '900', timeZone: 'Asia/Jakarta', workHours: '08:00-17:00' });
    expect(saved.json()).toEqual({ configured: true, tokenHint: '…test', workspaceId: '900', timeZone: 'Asia/Jakarta', workHours: '08:00-17:00', defaultWorkHours: '09:00-18:00' });
    expect(saved.body).not.toContain('pk_test');
    // leaving the token out keeps it
    expect((await put(t, { workspaceId: '', timeZone: '', workHours: '' })).json()).toMatchObject({ configured: true, tokenHint: '…test' });
    expect(t.store.getKv('clickup')).toContain('pk_test');
  });

  it('rejects a bad time zone or work hours', async () => {
    const t = await boot();
    expect((await put(t, { token: 'pk_1', workspaceId: '', timeZone: 'Mars/Base', workHours: '' })).statusCode).toBe(400);
    expect((await put(t, { token: 'pk_1', workspaceId: '', timeZone: '', workHours: '9 to 5' })).statusCode).toBe(400);
    expect((await put(t, { token: 'pk_1', workspaceId: 'abc', timeZone: '', workHours: '' })).statusCode).toBe(400);
    expect(t.store.getKv('clickup')).toBeNull();
  });

  it('tests the saved token against ClickUp', async () => {
    const t = await boot({ clickupFetch: fakeClickUp() });
    expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH })).statusCode).toBe(400);
    await put(t, { token: 'pk_test', workspaceId: '', timeZone: '', workHours: '' });
    const r = await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH });
    expect(r.json()).toMatchObject({ user: { username: 'luz' }, workspaces: [{ id: '900' }, { id: '901' }], time_zone: 'Asia/Jakarta' });
    await put(t, { token: 'pk_wrong', workspaceId: '', timeZone: '', workHours: '' });
    expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: AUTH })).statusCode).toBe(502);
  });

  it('is for the owner only', async () => {
    const t = await boot();
    for (const role of ['admin', 'dev'] as const) {
      const h = { authorization: `Bearer ${(await mkUser(t, `u-${role}`, role)).token}` };
      expect((await t.app.inject({ url: '/api/settings/clickup', headers: h })).statusCode).toBe(403);
      expect((await put(t, { token: 'pk_x', workspaceId: '', timeZone: '', workHours: '' }, h)).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'POST', url: '/api/settings/clickup/test', headers: h })).statusCode).toBe(403);
    }
  });
});

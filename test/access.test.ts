import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

type T = ReturnType<typeof setupApp>;
const call = (t: T, method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, headers, payload: payload as object | undefined });

/**
 * Three projects, each with a chat: "all" (everyone), "owner" (the owner alone) and "shared" (the owner and sari).
 * sari and budi look at them.
 */
async function world() {
  const t = setupApp();
  const sari = bearer((await mkUser(t, 'sari')).token);
  const budi = bearer((await mkUser(t, 'budi')).token);
  const id = (name: string) => t.store.listUsers().find((u) => u.name === name)!.id;
  const p: Record<string, { id: string; conv: string }> = {};
  for (const [name, access, members] of [['all', 'all', []], ['owner', 'owner', []], ['shared', 'owner', [id('sari')]]] as const) {
    const r = await call(t, 'POST', '/api/projects', AUTH, { name, path: 'proj', access, members });
    expect(r.statusCode).toBe(201);
    p[name] = { id: r.json().id, conv: t.store.createConversation(r.json().id).id };
  }
  const names = async (h: Record<string, string>) => (await call(t, 'GET', '/api/projects', h)).json().map((x: { name: string }) => x.name);
  return { t, sari, budi, id, p, names };
}

describe('project access', () => {
  it('defaults to all and lists each project only to who may open it', async () => {
    const { t, sari, budi, names } = await world();
    expect((await call(t, 'POST', '/api/projects', AUTH, { name: 'x', path: 'proj' })).json().access).toBe('all');
    expect(await names(AUTH)).toEqual(['all', 'owner', 'shared', 'x']);
    expect(await names(sari)).toEqual(['all', 'shared', 'x']);
    expect(await names(budi)).toEqual(['all', 'x']);
  });

  it('answers 404 for a hidden project, its chats and what is in them', async () => {
    const { t, sari, budi, p } = await world();
    const sched = t.store.createSchedule(p.owner!.conv, { prompt: 'hi', cron: '0 9 * * *', enabled: true, nextRunAt: Date.now() + 1e6, createdBy: 'owner' });
    const queued = t.store.enqueue(p.owner!.conv, 'later', [], 'owner');
    for (const h of [sari, budi]) {
      expect((await call(t, 'GET', `/api/projects/${p.owner!.id}/conversations`, h)).statusCode).toBe(404);
      expect((await call(t, 'POST', `/api/projects/${p.owner!.id}/conversations`, h)).statusCode).toBe(404);
      expect((await call(t, 'GET', `/api/conversations/${p.owner!.conv}`, h)).statusCode).toBe(404);
      expect((await call(t, 'POST', `/api/conversations/${p.owner!.conv}/prompts`, h, { prompt: 'x' })).statusCode).toBe(404);
      expect((await call(t, 'GET', `/api/conversations/${p.owner!.conv}/git`, h)).statusCode).toBe(404);
      expect((await call(t, 'DELETE', `/api/schedules/${sched.id}`, h)).statusCode).toBe(404);
      expect((await call(t, 'DELETE', `/api/queue/${queued}`, h)).statusCode).toBe(404);
      expect((await call(t, 'DELETE', `/api/conversations/${p.owner!.conv}`, h)).statusCode).toBe(404);
      expect((await call(t, 'GET', '/api/schedules', h)).json()).toEqual([]);
    }
    expect((await call(t, 'GET', `/api/conversations/${p.shared!.conv}`, sari)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/conversations/${p.shared!.conv}`, budi)).statusCode).toBe(404);
    expect((await call(t, 'GET', `/api/conversations/${p.all!.conv}`, budi)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/conversations/${p.owner!.conv}`, AUTH)).statusCode).toBe(200);
    expect((await call(t, 'GET', '/api/schedules', AUTH)).json()).toHaveLength(1);
  });

  it('refuses to delete a chat or project whose sub-agents run in a project the person may not open, and deletes nothing', async () => {
    const { t, sari, p } = await world();
    const kid = t.store.createConversation(p.owner!.id, undefined, p.all!.conv);
    expect((await call(t, 'DELETE', `/api/conversations/${p.all!.conv}`, sari)).statusCode).toBe(403);
    expect((await call(t, 'DELETE', `/api/projects/${p.all!.id}`, sari)).statusCode).toBe(403);
    expect(t.store.getConversation(p.all!.conv)).not.toBeNull();
    expect(t.store.getConversation(kid.id)).not.toBeNull();
    expect(t.store.getProject(p.all!.id)).not.toBeNull();
    expect((await call(t, 'DELETE', `/api/conversations/${p.all!.conv}`, AUTH)).statusCode).toBe(204);
    expect(t.store.getConversation(kid.id)).toBeNull();
  });

  it('leaves hidden chats out of search', async () => {
    const { t, budi, p } = await world();
    for (const k of ['all', 'shared']) t.store.db.prepare('UPDATE conversations SET auto_title=? WHERE id=?').run(`secret ${k}`, p[k]!.conv);
    const hits = (await call(t, 'GET', '/api/search?q=secret', budi)).json();
    expect(hits.map((h: { project: string }) => h.project)).toEqual(['all']);
  });

  it('lets a user change access only to what keeps them in; the owner to anything', async () => {
    const { t, sari, budi, id, p, names } = await world();
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, sari, { access: 'admin' })).statusCode).toBe(400);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, sari, { access: 'dev' })).statusCode).toBe(400);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, sari, { access: 'owner' })).statusCode).toBe(403);
    expect((await call(t, 'POST', '/api/projects', sari, { name: 'y', path: 'proj', access: 'owner' })).statusCode).toBe(403);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, sari, { access: 'owner', members: [id('sari')] })).json().access).toBe('owner');
    expect(await names(budi)).toEqual([]);
    expect((await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, sari, { access: 'all' })).statusCode).toBe(404);
    expect((await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, AUTH, { access: 'all' })).statusCode).toBe(200);
    expect(await names(budi)).toEqual(['owner']);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, AUTH, { access: 'root' })).statusCode).toBe(400);
  });
});

describe('projects shared with selected users', () => {
  it('opens a limited project to the users it is shared with, and to nobody else', async () => {
    const { t, sari, budi, id, p, names } = await world();
    const r = await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, AUTH, { members: [id('budi'), id('budi')] });
    expect(r.json()).toMatchObject({ access: 'owner', members: [id('budi')] });
    expect(await names(budi)).toEqual(['all', 'owner']);
    expect(await names(sari)).toEqual(['all', 'shared']);
    expect((await call(t, 'GET', `/api/conversations/${p.owner!.conv}`, budi)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/conversations/${p.owner!.conv}`, sari)).statusCode).toBe(404);
    // Whoever may open it sees who else may; changing the level keeps the list.
    await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, AUTH, { members: [id('budi'), id('sari')] });
    const mine = (await call(t, 'GET', '/api/projects', budi)).json().find((x: { name: string }) => x.name === 'owner');
    expect(mine.members).toEqual([id('budi'), id('sari')]);
    expect((await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, AUTH, { access: 'all' })).json().members).toEqual([id('budi'), id('sari')]);
    expect((await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, AUTH, { access: 'owner', members: [] })).json().members).toEqual([]);
    expect(await names(budi)).toEqual(['all']);
  });

  it('refuses unknown users, and a user who would leave themselves out', async () => {
    const { t, sari, id, p } = await world();
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, AUTH, { members: ['nobody'] })).statusCode).toBe(400);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, AUTH, {})).statusCode).toBe(400);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, sari, { access: 'owner', members: [id('budi')] })).statusCode).toBe(403);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, sari, { access: 'owner', members: [id('budi'), id('sari')] })).statusCode).toBe(200);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, sari, { members: [id('budi')] })).statusCode).toBe(403);
    const made = await call(t, 'POST', '/api/projects', sari, { name: 'mine', path: 'proj', access: 'owner', members: [id('sari')] });
    expect(made.statusCode).toBe(201);
    expect(made.json().members).toEqual([id('sari')]);
  });

  it('drops a deleted user from the projects shared with them', async () => {
    const { t, id, p } = await world();
    const budi = id('budi');
    await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, AUTH, { members: [budi] });
    expect((await call(t, 'DELETE', `/api/users/${budi}`, AUTH)).statusCode).toBe(204);
    expect(t.store.getProject(p.owner!.id)!.members).toEqual([]);
  });
});

describe('project access over MCP', () => {
  const opened: { close: () => Promise<unknown> }[] = [];
  afterEach(async () => { for (const o of opened.splice(0)) await o.close().catch(() => {}); });

  it('shows a caller, or an agent working for them, only the projects they may open', async () => {
    const { t, sari, budi, p } = await world();
    opened.push({ close: () => t.app.close() });
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as { port: number }).port;
    const connect = async (headers: Record<string, string>) => {
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
      opened.push(client);
      return client;
    };
    const projects = async (c: Client) => {
      const r = (await c.callTool({ name: 'list_projects', arguments: {} })) as { content: { text: string }[] };
      return (JSON.parse(r.content[0]!.text) as { name: string }[]).map((x) => x.name).sort();
    };
    const tool = async (c: Client, name: string, args: Record<string, unknown>) =>
      ((await c.callTool({ name, arguments: args })) as { isError?: boolean }).isError ?? false;

    const asBudi = await connect(budi);
    expect(await projects(asBudi)).toEqual(['all']);
    expect(await tool(asBudi, 'get_conversation', { conversation_id: p.owner!.conv })).toBe(true);
    expect(await tool(asBudi, 'send_prompt', { conversation_id: p.shared!.conv, prompt: 'x' })).toBe(true);
    expect(await tool(asBudi, 'get_conversation', { conversation_id: p.all!.conv })).toBe(false);
    expect(await projects(await connect(sari))).toEqual(['all', 'shared']);

    // An agent on a turn sari sent: sari's projects. With no author: only what everyone may open.
    expect(await projects(await connect(bearer(t.dispatcher.issueMcpToken(p.all!.conv, 'sari'))))).toEqual(['all', 'shared']);
    expect(await projects(await connect(bearer(t.dispatcher.issueMcpToken(p.all!.conv, 'budi'))))).toEqual(['all']);
    expect(await projects(await connect(bearer(t.dispatcher.issueMcpToken(p.all!.conv, ''))))).toEqual(['all']);
    expect(await projects(await connect(bearer(t.dispatcher.issueMcpToken(p.all!.conv, 'owner'))))).toEqual(['all', 'owner', 'shared']);
  });
});

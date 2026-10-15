import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { AUTH } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

type T = ReturnType<typeof setupApp>;
const call = (t: T, method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, headers, payload: payload as object | undefined });

/** One project per access level, each with a chat, and an admin and a dev to look at them. */
async function world() {
  const t = setupApp();
  const admin = bearer((await mkUser(t, 'sari', 'admin')).token);
  const dev = bearer((await mkUser(t, 'budi', 'dev')).token);
  const p: Record<string, { id: string; conv: string }> = {};
  for (const access of ['all', 'owner', 'admin', 'dev']) {
    const r = await call(t, 'POST', '/api/projects', AUTH, { name: access, path: 'proj', access });
    expect(r.statusCode).toBe(201);
    p[access] = { id: r.json().id, conv: t.store.createConversation(r.json().id).id };
  }
  const names = async (h: Record<string, string>) => (await call(t, 'GET', '/api/projects', h)).json().map((x: { name: string }) => x.name);
  return { t, admin, dev, p, names };
}

describe('project access', () => {
  it('defaults to all and lists each project only to who may open it', async () => {
    const { t, admin, dev, names } = await world();
    expect((await call(t, 'POST', '/api/projects', AUTH, { name: 'x', path: 'proj' })).json().access).toBe('all');
    expect(await names(AUTH)).toEqual(['admin', 'all', 'dev', 'owner', 'x']);
    expect(await names(admin)).toEqual(['admin', 'all', 'dev', 'x']);
    expect(await names(dev)).toEqual(['all', 'dev', 'x']);
  });

  it('answers 404 for a hidden project, its chats and what is in them', async () => {
    const { t, admin, dev, p } = await world();
    const sched = t.store.createSchedule(p.owner!.conv, { prompt: 'hi', cron: '0 9 * * *', enabled: true, nextRunAt: Date.now() + 1e6, createdBy: 'owner' });
    const queued = t.store.enqueue(p.owner!.conv, 'later', [], 'owner');
    for (const h of [admin, dev]) {
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
    expect((await call(t, 'GET', `/api/conversations/${p.dev!.conv}`, admin)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/conversations/${p.admin!.conv}`, dev)).statusCode).toBe(404);
    expect((await call(t, 'GET', `/api/conversations/${p.dev!.conv}`, dev)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/conversations/${p.owner!.conv}`, AUTH)).statusCode).toBe(200);
    expect((await call(t, 'GET', '/api/schedules', AUTH)).json()).toHaveLength(1);
  });

  it('leaves hidden chats out of search', async () => {
    const { t, dev, p } = await world();
    for (const k of ['all', 'admin']) t.store.db.prepare('UPDATE conversations SET auto_title=? WHERE id=?').run(`secret ${k}`, p[k]!.conv);
    const hits = (await call(t, 'GET', '/api/search?q=secret', dev)).json();
    expect(hits.map((h: { project: string }) => h.project)).toEqual(['all']);
  });

  it('lets an admin change access only to levels they keep; the owner to any', async () => {
    const { t, admin, dev, p, names } = await world();
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, dev, { access: 'admin' })).statusCode).toBe(403);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, admin, { access: 'dev' })).json().access).toBe('dev');
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, admin, { access: 'owner' })).statusCode).toBe(403);
    expect((await call(t, 'POST', '/api/projects', admin, { name: 'y', path: 'proj', access: 'owner' })).statusCode).toBe(403);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, admin, { access: 'admin' })).json().access).toBe('admin');
    expect(await names(dev)).toEqual(['dev']);
    expect((await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, admin, { access: 'all' })).statusCode).toBe(404);
    expect((await call(t, 'PATCH', `/api/projects/${p.owner!.id}`, AUTH, { access: 'dev' })).statusCode).toBe(200);
    expect(await names(dev)).toEqual(['dev', 'owner']);
    expect((await call(t, 'PATCH', `/api/projects/${p.all!.id}`, AUTH, { access: 'root' })).statusCode).toBe(400);
  });
});

describe('project access over MCP', () => {
  const opened: { close: () => Promise<unknown> }[] = [];
  afterEach(async () => { for (const o of opened.splice(0)) await o.close().catch(() => {}); });

  it('shows a caller, or an agent working for them, only the projects they may open', async () => {
    const { t, dev, p } = await world();
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

    const asDev = await connect(dev);
    expect(await projects(asDev)).toEqual(['all', 'dev']);
    expect(await tool(asDev, 'get_conversation', { conversation_id: p.owner!.conv })).toBe(true);
    expect(await tool(asDev, 'send_prompt', { conversation_id: p.admin!.conv, prompt: 'x' })).toBe(true);
    expect(await tool(asDev, 'get_conversation', { conversation_id: p.dev!.conv })).toBe(false);

    // An agent in the dev project, on a turn budi sent: budi's projects. With no author: the shared ones and its own.
    expect(await projects(await connect(bearer(t.dispatcher.issueMcpToken(p.dev!.conv, 'budi'))))).toEqual(['all', 'dev']);
    expect(await projects(await connect(bearer(t.dispatcher.issueMcpToken(p.admin!.conv, ''))))).toEqual(['admin', 'all']);
    expect(await projects(await connect(bearer(t.dispatcher.issueMcpToken(p.all!.conv, 'owner'))))).toEqual(['admin', 'all', 'dev', 'owner']);
  });
});

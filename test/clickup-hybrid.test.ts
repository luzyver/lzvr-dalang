import { expect, it } from 'vitest';
import { ClickUp } from '../src/clickup.js';
import { ClickUpWork } from '../src/clickup-work.js';
import { fakeClickUp } from './fake-clickup.js';

it('lists Docs through the API and invokes MCP only for content search', async () => {
  const calls: string[] = [];
  const work = new ClickUpWork(new ClickUp({ token: 'pk_test', oauth: 'mcp_test', workspaceId: '900', fetch: fakeClickUp(calls) }));
  expect(await work.docs()).toMatchObject([{ name: 'Runbook' }]);
  expect(calls.some((x) => x.startsWith('clickup_'))).toBe(false);
  expect(await work.docs(undefined, 'rollback')).toMatchObject([{ name: 'Runbook' }]);
  expect(calls.filter((x) => x.startsWith('clickup_')).map((x) => x.split(' ')[0])).toEqual(['clickup_get_user', 'clickup_search']);
});

it('does not spend MCP quota when the API key is refused or rate limited', async () => {
  for (const status of [401, 429, 503]) {
    const origins: string[] = [];
    const client = new ClickUp({ token: 'pk_bad', oauth: 'mcp_test', timeZone: 'UTC', fetch: async (input) => {
      origins.push(new URL(String(input)).origin);
      return new Response('unavailable', { status, headers: { 'x-ratelimit-reset': String(Date.now() / 1000 + 3600) } });
    } });
    const dest = { workspace_id: '900', workspace: 'Acme', channel_id: 'c1', channel: 'dev' };
    await expect(client.deliver(dest, 'hello')).rejects.toThrow(String(status));
    expect(origins).toEqual(['https://api.clickup.com']);
  }
});

it('refuses mixed identities before uploading a file or opening a DM', async () => {
  const calls: string[] = [];
  const inner = fakeClickUp(calls);
  const client = new ClickUp({ token: 'pk_other', oauth: 'mcp_test', workspaceId: '900', timeZone: 'UTC',
    fetch: async (input, init) => new URL(String(input)).pathname === '/api/v2/user'
      ? Response.json({ user: { id: 99 } }) : inner(input, init) });
  await expect(client.deliver({ workspace_id: '900', workspace: 'Acme', to_user: { id: '22', name: 'Sari' }, channel: 'DM' }, 'hello',
    [{ name: 'doc.pdf', data: Buffer.from('document') }])).rejects.toThrow(/different ClickUp users/);
  expect(calls).toEqual(['clickup_get_user {}']);
});

it('can search Doc names with only an API key', async () => {
  const calls: string[] = [];
  const work = new ClickUpWork(new ClickUp({ token: 'pk_test', workspaceId: '900', fetch: fakeClickUp(calls) }));
  expect(await work.docs(undefined, 'run')).toMatchObject({ docs: [{ id: 'doc1' }], warnings: [expect.stringMatching(/titles only/i)] });
  expect(await work.docs(undefined, 'run', 50, 'name')).toMatchObject([{ id: 'doc1' }]);
  expect(await work.docs(undefined, 'other', 50, 'name')).toEqual([]);
  expect(calls.some((x) => x.startsWith('clickup_'))).toBe(false);
});

it('orders tasks across workspaces when ClickUp sends ISO or millisecond timestamps', async () => {
  const inner = fakeClickUp();
  const work = new ClickUpWork(new ClickUp({ token: 'pk_test', fetch: async (input, init) => {
    const path = new URL(String(input)).pathname;
    if (path.endsWith('/900/task')) return Response.json({ tasks: [{ id: 'new', date_updated: '2026-11-20T00:00:00Z' }] });
    if (path.endsWith('/901/task')) return Response.json({ tasks: [{ id: 'old', date_updated: '1690000000000' }] });
    return inner(input, init);
  } }));
  expect((await work.findTasks({ workspaceIds: ['900', '901'] })).tasks.map((t: any) => t.id)).toEqual(['new', 'old']);
});

it('returns the newest match when the task limit stops pagination after the first page', async () => {
  const inner = fakeClickUp();
  const tasks = Array.from({ length: 101 }, (_, i) => ({ id: String(i + 1), date_updated: String(i + 1) }));
  const work = new ClickUpWork(new ClickUp({ token: 'pk_test', workspaceId: '900', fetch: async (input, init) => {
    const url = new URL(String(input));
    if (!url.pathname.endsWith('/900/task')) return inner(input, init);
    const ordered = url.searchParams.get('reverse') === 'true' ? [...tasks].reverse() : tasks;
    const start = Number(url.searchParams.get('page')) * 100;
    return Response.json({ tasks: ordered.slice(start, start + 100) });
  } }));
  expect((await work.findTasks({ limit: 1 })).tasks).toMatchObject([{ id: '101' }]);
});

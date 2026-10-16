import { afterEach, describe, expect, it } from 'vitest';
import { buildClaudeArgs } from '../src/claude.js';
import { mcpLaunch, type McpServerConf } from '../src/mcp-servers.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { mkUser, setupApp } from './setup-app.js';

const apps: { close: () => Promise<unknown> }[] = [];
afterEach(async () => { for (const a of apps.splice(0)) await a.close(); });

function boot() {
  const t = setupApp();
  apps.push(t.app);
  const put = (name: string, payload: object, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method: 'PUT', url: `/api/settings/mcp-servers/${name}`, headers, payload });
  const list = async () => (await t.app.inject({ url: '/api/settings/mcp-servers', headers: AUTH })).json();
  return { ...t, put, list };
}

const CONTEXT7 = { enabled: true, allUsers: false, url: 'https://mcp.context7.com/mcp', token: 'ctx7-secret-1234' };
const SENTRY = { enabled: true, allUsers: true, command: 'npx', args: ['-y', '@sentry/mcp-server'], env: { SENTRY_ACCESS_TOKEN: 'sntry-abcd' } };

describe('Settings → MCP servers', () => {
  it('saves servers and never sends a secret back', async () => {
    const t = boot();
    const r = await t.put('context7', CONTEXT7);
    expect(r.json()).toEqual({ name: 'context7', enabled: true, allUsers: false, url: CONTEXT7.url, tokenHint: '…1234', command: '', args: [], envKeys: [] });
    await t.put('sentry', SENTRY);
    const body = JSON.stringify(await t.list());
    expect(body).not.toContain('ctx7-secret');
    expect(body).not.toContain('sntry-abcd');
    expect((await t.list()).map((s: { name: string }) => s.name)).toEqual(['context7', 'sentry']);
  });

  it('keeps a saved token and env value unless replaced', async () => {
    const t = boot();
    await t.put('context7', CONTEXT7);
    await t.put('sentry', SENTRY);
    await t.put('context7', { enabled: false, allUsers: false, url: CONTEXT7.url });
    await t.put('sentry', { ...SENTRY, env: { SENTRY_ACCESS_TOKEN: null } });
    const kv = t.store.getKv('mcp_servers')!;
    expect(kv).toContain('ctx7-secret-1234');
    expect(kv).toContain('sntry-abcd');
    expect((await t.list())[0]).toMatchObject({ enabled: false, tokenHint: '…1234' });
    await t.put('context7', { ...CONTEXT7, token: '' });
    expect((await t.list())[0].tokenHint).toBe('');
  });

  it('refuses bad names, transports, URLs and env names', async () => {
    const t = boot();
    for (const [name, body] of [
      ['Bad Name', CONTEXT7], ['dalang', CONTEXT7], ['clickup', CONTEXT7], ['add', CONTEXT7],
      ['x', { enabled: true, allUsers: false }], ['x', { ...CONTEXT7, command: 'npx' }],
      ['x', { ...CONTEXT7, url: 'file:///etc/passwd' }],
      ['x', { ...SENTRY, env: { PATH: '/tmp' } }], ['x', { ...SENTRY, env: { LZVR_TOKEN: 'x' } }],
      ['x', { ...SENTRY, env: { NEW_KEY: null } }],
    ] as const) expect((await t.put(name, body)).statusCode).toBe(400);
    expect(t.store.getKv('mcp_servers')).toBeNull();
  });

  it('gives one env variable to one server only', async () => {
    const t = boot();
    await t.put('sentry', SENTRY);
    const r = await t.put('other', { ...SENTRY, env: { sentry_access_token: 'x' } });
    expect(r.statusCode).toBe(400);
    expect(r.json().error).toContain('already set by sentry');
    expect((await t.put('sentry', { ...SENTRY, env: { SENTRY_ACCESS_TOKEN: 'new' } })).statusCode).toBe(200); // its own: fine
  });

  it('deletes a server', async () => {
    const t = boot();
    await t.put('context7', CONTEXT7);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/settings/mcp-servers/context7', headers: AUTH })).statusCode).toBe(200);
    expect(await t.list()).toEqual([]);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/settings/mcp-servers/context7', headers: AUTH })).statusCode).toBe(404);
  });

  it('is for the owner only', async () => {
    const t = boot();
    for (const role of ['admin', 'dev'] as const) {
      const h = { authorization: `Bearer ${(await mkUser(t, `u-${role}`, role)).token}` };
      expect((await t.app.inject({ url: '/api/settings/mcp-servers', headers: h })).statusCode).toBe(403);
      expect((await t.put('context7', CONTEXT7, h)).statusCode).toBe(403);
      expect((await t.app.inject({ method: 'DELETE', url: '/api/settings/mcp-servers/context7', headers: h })).statusCode).toBe(403);
    }
  });
});

describe('MCP servers in a turn', () => {
  const conf = (o: Partial<McpServerConf>): McpServerConf =>
    ({ name: 'x', enabled: true, allUsers: false, url: '', token: '', command: '', args: [], env: {}, ...o });

  it('passes secrets through the environment, never on the command line', () => {
    const l = mcpLaunch([conf({ name: 'context7', url: 'https://mcp.context7.com/mcp', token: 'tok' }),
      conf({ name: 'sentry', command: 'npx', args: ['-y', 'a "b"'], env: { SENTRY_ACCESS_TOKEN: 'sec' } })]);
    expect(l.codexArgs).toEqual([
      '-c', 'mcp_servers.context7.url="https://mcp.context7.com/mcp"',
      '-c', 'mcp_servers.context7.bearer_token_env_var="LZVR_MCPS_CONTEXT7_TOKEN"',
      '-c', 'mcp_servers.context7.default_tools_approval_mode="approve"',
      '-c', 'mcp_servers.sentry.command="npx"',
      '-c', 'mcp_servers.sentry.args=["-y","a \\"b\\""]',
      '-c', 'mcp_servers.sentry.env_vars=["SENTRY_ACCESS_TOKEN"]',
      '-c', 'mcp_servers.sentry.default_tools_approval_mode="approve"',
    ]);
    expect(l.env).toEqual({ LZVR_MCPS_CONTEXT7_TOKEN: 'tok', SENTRY_ACCESS_TOKEN: 'sec' });
    const args = buildClaudeArgs({ sandbox: 'read-only', mcpUrl: 'http://127.0.0.1:1/mcp', mcpServers: l.claudeServers });
    expect(args.join(' ')).not.toMatch(/tok\b|sec\b/);
    expect(JSON.parse(args[args.indexOf('--mcp-config') + 1]!).mcpServers).toEqual({
      context7: { type: 'http', url: 'https://mcp.context7.com/mcp', headers: { Authorization: 'Bearer ${LZVR_MCPS_CONTEXT7_TOKEN}' } },
      sentry: { type: 'stdio', command: 'npx', args: ['-y', 'a "b"'], env: { SENTRY_ACCESS_TOKEN: '${SENTRY_ACCESS_TOKEN}' } },
      dalang: { type: 'http', url: 'http://127.0.0.1:1/mcp', headers: { Authorization: 'Bearer ${LZVR_MCP_TOKEN}' } },
    });
    expect(args).toContain('--allowedTools=mcp__context7,mcp__sentry,mcp__dalang');
  });

  it('gives the owner every enabled server and anyone else only the all-users ones', async () => {
    const t = boot();
    await t.put('context7', CONTEXT7);
    await t.put('sentry', SENTRY);
    await t.put('off', { ...CONTEXT7, enabled: false, allUsers: true });
    const p = t.store.createProject('p', t.root);
    const conv = t.store.createConversation(p.id);
    const run = async (author: string, n: number) => {
      t.store.enqueue(conv.id, 'x', [], author);
      t.dispatcher.kick(conv.id);
      await until(() => turnsDone(t.store, conv.id, n));
      const ev = t.store.eventsAfter(conv.id, 0).filter((e) => e.type === 'item.completed').at(-1)!;
      return JSON.parse(ev.payload).item as { args: string[]; mcpsEnv: Record<string, string> };
    };
    const owner = await run('owner', 1);
    expect(owner.args).toContain('mcp_servers.context7.url="https://mcp.context7.com/mcp"');
    expect(owner.args).toContain('mcp_servers.sentry.command="npx"');
    expect(owner.args.some((a) => a.startsWith('mcp_servers.off.'))).toBe(false);
    expect(owner.mcpsEnv).toEqual({ LZVR_MCPS_CONTEXT7_TOKEN: 'ctx7-secret-1234', SENTRY_ACCESS_TOKEN: 'sntry-abcd' });
    for (const [i, author] of ['budi', ''].entries()) {
      const other = await run(author, i + 2);
      expect(other.args.some((a) => a.startsWith('mcp_servers.context7.'))).toBe(false);
      expect(other.args).toContain('mcp_servers.sentry.command="npx"');
      expect(other.mcpsEnv).toEqual({ SENTRY_ACCESS_TOKEN: 'sntry-abcd' });
    }
  });
});

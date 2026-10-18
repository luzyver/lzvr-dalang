import { execFile, execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import type { CbmClient } from '../src/code-memory.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const opened: { close: () => Promise<unknown> }[] = [];
afterEach(async () => { for (const o of opened.splice(0)) await o.close().catch(() => {}); });

const OBJ = (props: Record<string, object>, required: string[] = []) => ({ type: 'object', properties: props, required });

/** A CBM session that answers from memory and records what it was asked. */
function fakeCbm() {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  /** While set, index_repository waits for it (an index in flight). */
  const hold: { index: Promise<void> | null } = { index: null };
  const cbm: CbmClient = {
    listTools: async () => [
      { name: 'search_graph', description: 'Find symbols.', inputSchema: OBJ({ project: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } }, ['project']) },
      { name: 'index_repository', inputSchema: OBJ({ repo_path: { type: 'string' } }, ['repo_path']) },
      { name: 'delete_project', inputSchema: OBJ({ project: { type: 'string' } }, ['project']) },
      { name: 'list_projects', inputSchema: OBJ({}) },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'index_repository' && hold.index) await hold.index;
      const answer = name === 'index_repository'
        ? { project: `G-${basename(String(args.repo_path))}`, nodes: 10, edges: 20, status: 'indexed' }
        : { tool: name, project: args.project, query: args.query };
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
    },
    close: async () => {},
  };
  return { cbm, calls, hold };
}

async function boot() {
  const { cbm, calls, hold } = fakeCbm();
  const t = setupApp({}, { cbm });
  opened.push({ close: () => t.codeMemory.stop() }, { close: () => t.app.close() });
  await t.app.listen({ host: '127.0.0.1', port: 0 });
  const port = (t.app.server.address() as { port: number }).port;
  const connect = async (headers: Record<string, string>) => {
    const client = new Client({ name: 'test', version: '1.0.0' });
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), { requestInit: { headers } }));
    opened.push(client);
    return client;
  };
  const settings = (payload: object, headers = AUTH) => t.app.inject({ method: 'PUT', url: '/api/settings/code-memory', headers, payload });
  /** Click Index for a project. */
  const index = (id: string) => t.app.inject({ method: 'POST', url: `/api/settings/code-memory/projects/${id}/index`, headers: AUTH });
  /** Turn it on and index every project. */
  const turnOn = async () => {
    expect((await settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '' })).statusCode).toBe(200);
    for (const p of t.store.listProjects()) expect((await index(p.id)).statusCode).toBe(202);
    await until(() => t.store.listProjects().every((p) => t.codeMemory.state(p.id)?.status === 'ready'));
  };
  return { ...t, calls, hold, connect, settings, index, turnOn };
}

async function call(c: Client, name: string, args: Record<string, unknown> = {}) {
  const r = (await c.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
  return { isError: Boolean(r.isError), text: r.content[0]!.text };
}

describe('code memory', () => {
  it('is set by the owner only, and indexes a project only when asked', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    const admin = await mkUser(t, 'adi', 'admin');
    expect((await t.app.inject({ url: '/api/settings/code-memory', headers: bearer(admin.token) })).statusCode).toBe(403);
    expect((await t.settings({ enabled: true, command: '', cacheDir: '', runtimeDir: '' })).statusCode).toBe(400);
    expect((await t.index(p.id)).statusCode).toBe(400); // off
    expect((await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '' })).statusCode).toBe(200);
    expect(t.codeMemory.active).toBe(true); // the tools are there at once
    expect(t.calls.some((c) => c.name === 'index_repository')).toBe(false); // turning it on indexes nothing
    expect(t.codeMemory.state(p.id)).toBeNull();
    expect((await t.index(p.id)).statusCode).toBe(202);
    await until(() => t.codeMemory.state(p.id)?.status === 'ready');
    expect(t.codeMemory.state(p.id)).toMatchObject({ status: 'ready', graph: 'G-proj', nodes: 10, edges: 20 });
    expect(t.calls.find((c) => c.name === 'index_repository')?.args).toEqual({ repo_path: p.path });
    const view = (await t.app.inject({ url: '/api/settings/code-memory', headers: AUTH })).json();
    expect(view).toMatchObject({ enabled: true, active: true, tools: ['code_search_graph'] });
    expect(view.projects[0].index.graph).toBe('G-proj');
  });

  it('gives a chat the query tools on its own project, never on one its user may not open', async () => {
    const t = await boot();
    mkdirSync(join(t.root, 'secret'));
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    const secret = t.store.createProject('secret', join(t.root, 'secret'), undefined, undefined, 'owner');
    await mkUser(t, 'budi', 'dev');
    await t.turnOn();
    const conv = t.store.createConversation(p.id);
    const agent = await t.connect(bearer(t.dispatcher.issueMcpToken(conv.id, 'budi')));
    const names = (await agent.listTools()).tools.map((x) => x.name);
    expect(names).toContain('code_search_graph');
    expect(names.filter((n) => n.startsWith('code_'))).toEqual(['code_search_graph']); // no indexing, deleting or listing
    expect(JSON.parse((await call(agent, 'code_search_graph', { query: 'main' })).text)).toEqual({ tool: 'search_graph', project: 'G-proj', query: 'main' });
    const other = await call(agent, 'code_search_graph', { query: 'main', project_id: secret.id });
    expect(other).toMatchObject({ isError: true, text: `no such project: ${secret.id}` });
    // The owner may read it; an outside client names the project.
    const owner = await t.connect(AUTH);
    expect(JSON.parse((await call(owner, 'code_search_graph', { project_id: secret.id })).text).project).toBe('G-secret');
  });

  it('tells a turn about the graph only while it is on and the project is indexed', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    expect(t.codeMemory.guide(p, false)).toBe('');
    await t.turnOn();
    expect(t.codeMemory.guide(p, false)).toContain('code_search_graph');
    expect(t.codeMemory.guide(p, false)).not.toContain('worktree');
    expect(t.codeMemory.guide(p, true)).toContain('not of your worktree');
    await t.settings({ enabled: false, command: 'cbm', cacheDir: '', runtimeDir: '' });
    expect(t.codeMemory.guide(p, false)).toBe('');
    const agent = await t.connect(bearer(t.dispatcher.issueMcpToken(t.store.createConversation(p.id).id)));
    expect((await agent.listTools()).tools.map((x) => x.name).some((n) => n.startsWith('code_'))).toBe(false);
  });

  it('says when files changed since the index, never indexes on its own, and forgets a deleted project', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    const git = (...args: string[]) => execFileSync('git', ['-C', p.path, ...args]);
    git('init', '-q');
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await t.turnOn();
    const changed = async () => (await t.app.inject({ url: '/api/settings/code-memory', headers: AUTH })).json().projects[0].changed;
    expect(await changed()).toBe(false);
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 2;\n');
    expect(await changed()).toBe(true);
    // A turn in the project folder, or time passing, indexes nothing.
    const indexes = () => t.calls.filter((c) => c.name === 'index_repository').length;
    const before = indexes();
    t.store.enqueue(t.store.createConversation(p.id).id, 'hi', []);
    t.dispatcher.kick(t.store.listConversations(p.id)[0]!.id);
    await until(() => turnsDone(t.store, t.store.listConversations(p.id)[0]!.id, 1));
    await new Promise((r) => setTimeout(r, 300));
    expect(indexes()).toBe(before);
    await t.index(p.id);
    await until(() => indexes() === before + 1 && t.codeMemory.state(p.id)?.status === 'ready');
    expect(await changed()).toBe(false);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: AUTH })).statusCode).toBe(204);
    await until(() => t.calls.some((c) => c.name === 'delete_project'));
    expect(t.calls.find((c) => c.name === 'delete_project')?.args).toEqual({ project: 'G-proj' });
    expect(t.codeMemory.state(p.id)).toBeNull();
  });

  it('answers a query on a project without an index with what to do instead', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    await t.codeMemory.save({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '', hooks: true });
    await expect(t.codeMemory.query(p, 'search_graph', {})).rejects.toThrow(/no code graph yet .* use grep/);
    await expect(t.codeMemory.query(p, 'delete_project', {})).rejects.toThrow(/no such code memory tool/);
    expect(t.calls.some((c) => c.name === 'index_repository')).toBe(false);
  });

  it('gives turns hooks on the project folder while on, indexed and not switched off', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    expect(t.codeMemory.hooks(p, 'claude', p.path)).toBeNull();
    await t.settings({ enabled: true, command: 'C:/cbm/cbm.exe', cacheDir: 'C:/cache', runtimeDir: '' });
    expect(t.codeMemory.hooks(p, 'claude', p.path)).toBeNull(); // no index yet
    await t.index(p.id);
    await until(() => t.codeMemory.state(p.id)?.status === 'ready');
    const h = t.codeMemory.hooks(p, 'claude', join(t.base, 'some-worktree'))!;
    expect(h.env).toEqual({ CBM_CACHE_DIR: 'C:/cache', LZVR_CBM_COMMAND: 'C:/cbm/cbm.exe', LZVR_CODE_ROOT: p.path });
    expect(h.args[0]).toBe('--settings');
    const hooks = JSON.parse(h.args[1]!).hooks;
    expect(hooks.PreToolUse[0].matcher).toBe('Grep|Glob|Bash');
    expect(hooks.PostToolUse[0].matcher).toBe('Read');
    expect(hooks.PreToolUse[0].hooks[0].command).toMatch(/^"[^"]+" "[^"]+code-memory-hook\.mjs"$/);
    expect(hooks.PreToolUse[0].hooks[0].command).not.toContain('\\');
    await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '', hooks: false });
    expect(t.codeMemory.hooks(p, 'claude', p.path)).toBeNull();
    expect(t.codeMemory.hooks(p, 'codex', p.path)).toBeNull();
  });

  it('gives Codex turns an inline shell hook, never in a folder with Codex hooks of its own', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    await t.turnOn();
    const h = t.codeMemory.hooks(p, 'codex', p.path)!;
    expect(h.env.LZVR_CODE_ROOT).toBe(p.path);
    expect(h.args.slice(0, 2)).toEqual(['--dangerously-bypass-hook-trust', '-c']);
    expect(h.args[2]).toMatch(/^hooks\.PreToolUse=\[\{matcher="\^Bash\$",hooks=\[\{type="command",command=".+",timeout=5\}\]\}\]$/);
    expect(h.args[2]).toContain('code-memory-hook.mjs');
    // A repository bringing its own Codex hooks (in the turn's folder or the project's) gets none from us.
    const wt = join(t.base, 'wt');
    mkdirSync(join(wt, '.codex'), { recursive: true });
    writeFileSync(join(wt, '.codex', 'config.toml'), 'model = "x"\n');
    expect(t.codeMemory.hooks(p, 'codex', wt)).not.toBeNull();
    writeFileSync(join(wt, '.codex', 'config.toml'), 'model = "x"\n[[hooks.PreToolUse]]\nmatcher = "^Bash$"\n');
    expect(t.codeMemory.hooks(p, 'codex', wt)).toBeNull();
    mkdirSync(join(p.path, '.codex'));
    writeFileSync(join(p.path, '.codex', 'hooks.json'), '{"hooks":{}}');
    expect(t.codeMemory.hooks(p, 'codex', p.path)).toBeNull();
    expect(t.codeMemory.hooks(p, 'claude', p.path)).not.toBeNull(); // Claude Code takes ours through --settings, no trust bypass
  });
  it('leaves nothing behind of a project deleted while its index runs', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '' });
    let release!: () => void;
    t.hold.index = new Promise((r) => { release = r; });
    await t.index(p.id);
    await until(() => t.calls.some((c) => c.name === 'index_repository'));
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: AUTH })).statusCode).toBe(204);
    release();
    await until(() => t.calls.some((c) => c.name === 'delete_project'));
    expect(t.calls.find((c) => c.name === 'delete_project')?.args).toEqual({ project: 'G-proj' }); // the graph it just built
    expect(t.codeMemory.state(p.id)).toBeNull(); // not brought back
  });

  it('deletes the graph of a project deleted while code memory was off once it is on again', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    await t.turnOn();
    await t.settings({ enabled: false, command: 'cbm', cacheDir: '', runtimeDir: '' });
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: AUTH })).statusCode).toBe(204);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.calls.some((c) => c.name === 'delete_project')).toBe(false); // CBM could not be asked
    expect(t.store.getKv('code_memory_orphans')).toBe('["G-proj"]');
    await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '' });
    await until(() => t.calls.some((c) => c.name === 'delete_project'));
    expect(t.calls.find((c) => c.name === 'delete_project')?.args).toEqual({ project: 'G-proj' });
    await until(() => t.store.getKv('code_memory_orphans') === null);
  });
});

describe('code memory hook script', () => {
  const SCRIPT = fileURLToPath(new URL('../scripts/code-memory-hook.mjs', import.meta.url));
  const FAKE = fileURLToPath(new URL('./fake-cbm-hook.mjs', import.meta.url));
  const run = (event: object, env: Record<string, string>) => new Promise<{ code: number | null; out: string }>((resolve) => {
    const child = execFile(process.execPath, [SCRIPT], { env: { ...process.env, ...env } }, (err, out) => resolve({ code: err ? (err.code as number) : 0, out }));
    child.stdin!.end(JSON.stringify(event));
  });
  const EVENT = { session_id: 's', hook_event_name: 'PreToolUse', tool_name: 'Grep', cwd: 'C:\\wt\\abc', tool_input: { pattern: 'mcpServersFor' } };
  const CBM = { LZVR_CBM_COMMAND: process.execPath, LZVR_CBM_ARGS: JSON.stringify([FAKE]) };

  it('hands the event to CBM with the project folder in forward slashes', async () => {
    const r = await run(EVENT, { ...CBM, LZVR_CODE_ROOT: 'D:\\work\\proj' });
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out).hookSpecificOutput).toEqual({ hookEventName: 'PreToolUse', additionalContext: 'cwd=D:/work/proj tool=Grep' });
  });

  it('fails open: no answer and exit 0 when CBM fails, is missing or is not set', async () => {
    expect(await run(EVENT, { ...CBM, LZVR_CODE_ROOT: '/p', FAKE_CBM_FAIL: '1' })).toEqual({ code: 0, out: '' });
    expect(await run(EVENT, { LZVR_CBM_COMMAND: join(process.cwd(), 'no-such-cbm'), LZVR_CODE_ROOT: '/p' })).toEqual({ code: 0, out: '' });
    expect(await run(EVENT, { LZVR_CODE_ROOT: '/p', LZVR_CBM_COMMAND: '' })).toEqual({ code: 0, out: '' });
  });
});

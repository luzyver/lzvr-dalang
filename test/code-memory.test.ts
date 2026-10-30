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
  /** While set, index_repository waits for it (an index in flight); closing the session stops it, as CBM exiting would. */
  const hold: { index: Promise<void> | null; closed: number } = { index: null, closed: 0 };
  const stops: ((e: Error) => void)[] = [];
  const cbm: CbmClient = {
    listTools: async () => [
      { name: 'search_graph', description: 'Find symbols.', inputSchema: OBJ({ project: { type: 'string' }, query: { type: 'string' }, limit: { type: 'integer' } }, ['project']) },
      { name: 'index_repository', inputSchema: OBJ({ repo_path: { type: 'string' } }, ['repo_path']) },
      { name: 'delete_project', inputSchema: OBJ({ project: { type: 'string' } }, ['project']) },
      { name: 'list_projects', inputSchema: OBJ({}) },
    ],
    callTool: async (name, args) => {
      calls.push({ name, args });
      if (name === 'index_repository' && hold.index) await Promise.race([hold.index, new Promise((_, stop) => stops.push(stop))]);
      const answer = name === 'index_repository'
        ? { project: `G-${basename(String(args.repo_path))}`, nodes: 10, edges: 20, status: 'indexed' }
        : { tool: name, project: args.project, query: args.query };
      return { content: [{ type: 'text', text: JSON.stringify(answer) }] };
    },
    close: async () => { hold.closed++; for (const stop of stops.splice(0)) stop(new Error('connection closed')); },
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

  it('says when files changed since the index, reindexes only before a turn, and forgets a deleted project', async () => {
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
    // Time passing indexes nothing; a turn waits for the changed code to be reindexed before its agent starts.
    const indexes = () => t.calls.filter((c) => c.name === 'index_repository').length;
    const before = indexes();
    await new Promise((r) => setTimeout(r, 300));
    expect(indexes()).toBe(before);
    let release!: () => void;
    t.hold.index = new Promise((r) => { release = r; });
    const conv = t.store.createConversation(p.id);
    t.store.enqueue(conv.id, 'hi', []);
    t.dispatcher.kick(conv.id);
    await until(() => indexes() === before + 1);
    const types = () => t.store.eventsAfter(conv.id, 0).map((e) => e.type);
    expect(types()).toContain('code_memory.indexing');
    expect(types().some((x) => x.startsWith('item.'))).toBe(false); // the agent has not started
    release();
    t.hold.index = null;
    await until(() => turnsDone(t.store, conv.id, 1));
    const seen = types();
    expect(seen.indexOf('code_memory.indexed')).toBeLessThan(seen.findIndex((x) => x.startsWith('item.')));
    expect(await changed()).toBe(false);
    // Nothing changed since: the next turn starts at once.
    t.store.enqueue(conv.id, 'again', []);
    t.dispatcher.kick(conv.id);
    await until(() => turnsDone(t.store, conv.id, 2));
    expect(indexes()).toBe(before + 1);
    // A file already changed and edited again keeps its git status, but counts as a change too.
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 33;\n');
    expect(await changed()).toBe(true);
    // Turns starting together share one reindex, and each hears that it started.
    let heard = 0;
    const both = await Promise.all([t.codeMemory.refresh(p, () => heard++), t.codeMemory.refresh(p, () => heard++)]);
    expect(both).toEqual(['ready', 'ready']);
    expect(heard).toBe(2);
    expect(indexes()).toBe(before + 2);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: AUTH })).statusCode).toBe(204);
    await until(() => t.calls.some((c) => c.name === 'delete_project'));
    expect(t.calls.find((c) => c.name === 'delete_project')?.args).toEqual({ project: 'G-proj' });
    expect(t.codeMemory.state(p.id)).toBeNull();
  });

  it('answers a query on a project without an index with what to do instead', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    await t.codeMemory.save({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '', hooks: true, autoReindex: true });
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
    t.hold.index = new Promise(() => {});
    await t.index(p.id);
    await until(() => t.calls.some((c) => c.name === 'index_repository'));
    expect((await t.app.inject({ method: 'DELETE', url: `/api/projects/${p.id}`, headers: AUTH })).statusCode).toBe(204);
    await until(() => t.hold.closed === 1); // the index was stopped
    await until(() => t.codeMemory.active); // by a new CBM session, so chats keep their tools
    await new Promise((r) => setTimeout(r, 100));
    expect(t.codeMemory.state(p.id)).toBeNull(); // not brought back
  });

  it('drops the graph an index built for a project deleted as it ended', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '' });
    let release!: () => void;
    t.hold.index = new Promise((r) => { release = r; });
    await t.index(p.id);
    await until(() => t.calls.some((c) => c.name === 'index_repository'));
    t.store.deleteProject(p.id); // gone from the store before forget could stop the index
    release();
    await until(() => t.calls.some((c) => c.name === 'delete_project'));
    expect(t.calls.find((c) => c.name === 'delete_project')?.args).toEqual({ project: 'G-proj' }); // the graph it just built
  });

  it('deletes an index on request, stopping one running or queued, and a turn waiting for it starts', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    mkdirSync(join(t.root, 'other'));
    const q = t.store.createProject('other', join(t.root, 'other'));
    const git = (...args: string[]) => execFileSync('git', ['-C', p.path, ...args]);
    git('init', '-q');
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await t.turnOn();
    const indexes = () => t.calls.filter((c) => c.name === 'index_repository').length;
    const dev = bearer((await mkUser(t, 'budi', 'dev')).token);
    const admin = bearer((await mkUser(t, 'adi', 'admin')).token);
    const del = (id: string, headers: Record<string, string>) => t.app.inject({ method: 'DELETE', url: `/api/projects/${id}/code-memory/index`, headers });

    // A turn waits for the reindex of changed code; deleting the index stops it, and the turn goes on without a graph.
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 2;\n');
    let release!: () => void;
    t.hold.index = new Promise((r) => { release = r; });
    const before = indexes();
    const waiting = t.codeMemory.refresh(p);
    await until(() => indexes() === before + 1);
    void t.codeMemory.index(q); // queued behind it
    expect((await del(p.id, dev)).statusCode).toBe(403);
    expect((await del(p.id, admin)).statusCode).toBe(204);
    expect(t.hold.closed).toBe(1);
    expect(await waiting).toBe('fresh');
    expect(t.codeMemory.state(p.id)).toBeNull();
    expect(t.calls.filter((c) => c.name === 'delete_project').map((c) => c.args)).toEqual([{ project: 'G-proj' }]);
    release();
    t.hold.index = null;
    await until(() => indexes() === before + 2 && t.codeMemory.state(q.id)?.status === 'ready'); // the queue goes on

    // A reindex queued behind another project's never runs once deleted, a turn waiting for it starts at once, and the
    // running one is left alone.
    expect((await t.index(p.id)).statusCode).toBe(202);
    await until(() => t.codeMemory.state(p.id)?.status === 'ready');
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 3;\n');
    t.hold.index = new Promise(() => {});
    void t.codeMemory.index(q);
    await until(() => indexes() === before + 4);
    let started = false;
    const queued = t.codeMemory.refresh(p, () => { started = true; });
    await until(() => started); // its reindex waits in the queue
    expect((await t.app.inject({ method: 'DELETE', url: `/api/settings/code-memory/projects/${p.id}/index`, headers: AUTH })).statusCode).toBe(204);
    expect(await queued).toBe('fresh');
    expect(t.hold.closed).toBe(1);
    expect(indexes()).toBe(before + 4);
    t.hold.index = null;
    expect((await t.app.inject({ method: 'DELETE', url: `/api/settings/code-memory/projects/${q.id}/index`, headers: AUTH })).statusCode).toBe(204);
    expect(t.hold.closed).toBe(2);
    await new Promise((r) => setTimeout(r, 100));
    expect(indexes()).toBe(before + 4);
    expect(t.codeMemory.state(p.id)).toBeNull();
    expect(t.codeMemory.state(q.id)).toBeNull();
    // Indexing again works.
    expect((await t.index(p.id)).statusCode).toBe(202);
    await until(() => t.codeMemory.state(p.id)?.status === 'ready');
  });

  it('reindexes before a turn only while that is on', async () => {
    const t = await boot();
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    const git = (...args: string[]) => execFileSync('git', ['-C', p.path, ...args]);
    git('init', '-q');
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 1;\n');
    git('add', '.');
    git('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', 'init');
    await t.turnOn();
    expect((await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '', autoReindex: false })).json().autoReindex).toBe(false);
    // Saved without it (an older panel): stays as it was.
    expect((await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '' })).json().autoReindex).toBe(false);
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 2;\n');
    const indexes = () => t.calls.filter((c) => c.name === 'index_repository').length;
    const before = indexes();
    expect(await t.codeMemory.refresh(p)).toBe('fresh');
    expect(indexes()).toBe(before);
    await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '', autoReindex: true });
    expect(await t.codeMemory.refresh(p)).toBe('ready');
    expect(indexes()).toBe(before + 1);
    expect(t.hold.closed).toBe(0); // saving other settings left the CBM session be

    // Deleted while a turn's check reads the changed files: the check must not bring the index back.
    writeFileSync(join(p.path, 'a.ts'), 'export const a = 3;\n');
    const checking = t.codeMemory.refresh(p);
    await t.codeMemory.drop(p);
    expect(await checking).toBe('fresh');
    await new Promise((r) => setTimeout(r, 100));
    expect(indexes()).toBe(before + 1);
    expect(t.codeMemory.state(p.id)).toBeNull();
  });

  it('keeps an index as it was when code memory is turned off while it runs or waits', async () => {
    const t = await boot();
    mkdirSync(join(t.root, 'other'));
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    const q = t.store.createProject('other', join(t.root, 'other'));
    await t.turnOn();
    const ready = t.codeMemory.state(p.id);
    t.hold.index = new Promise(() => {});
    void t.codeMemory.index(p);
    void t.codeMemory.index(q); // waits behind it
    await until(() => t.codeMemory.state(p.id)?.status === 'indexing');
    await t.settings({ enabled: false, command: 'cbm', cacheDir: '', runtimeDir: '' });
    expect(t.hold.closed).toBe(1);
    await new Promise((r) => setTimeout(r, 100));
    expect(t.codeMemory.state(p.id)).toEqual(ready); // not "failed"
    expect(t.codeMemory.state(q.id)?.status).toBe('ready');
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
  it('lets admins index from the chat at once, and anyone else ask for it, which an admin approves or rejects', async () => {
    const t = await boot();
    mkdirSync(join(t.root, 'secret'));
    const p = t.store.createProject('proj', join(t.root, 'proj'));
    const secret = t.store.createProject('secret', join(t.root, 'secret'), undefined, undefined, 'owner');
    const dev = bearer((await mkUser(t, 'budi', 'dev')).token);
    const admin = bearer((await mkUser(t, 'adi', 'admin')).token);
    const ask = (id: string, headers: Record<string, string>) => t.app.inject({ method: 'POST', url: `/api/projects/${id}/code-memory/index`, headers });
    const indexes = () => t.calls.filter((c) => c.name === 'index_repository').length;
    expect((await ask(p.id, dev)).statusCode).toBe(400); // code memory is off
    await t.settings({ enabled: true, command: 'cbm', cacheDir: '', runtimeDir: '' });
    expect((await ask(secret.id, dev)).statusCode).toBe(404); // a project the dev may not open

    // A dev asks: nothing runs until an admin approves; asking again gives the same request.
    const first = await ask(p.id, dev);
    expect(first.statusCode).toBe(202);
    expect(first.json()).toMatchObject({ status: 'pending_approval', request: { project: p.id, who: 'budi', status: 'pending' } });
    expect((await ask(p.id, dev)).json().request.id).toBe(first.json().request.id);
    expect(indexes()).toBe(0);
    expect((await t.app.inject({ url: `/api/projects/${p.id}/code-memory`, headers: dev })).json())
      .toMatchObject({ enabled: true, index: null, pending: { who: 'budi' }, direct: false });
    expect((await t.app.inject({ url: '/api/code-memory/requests', headers: dev })).statusCode).toBe(403);
    const pending = (await t.app.inject({ url: '/api/code-memory/requests', headers: admin })).json();
    expect(pending).toMatchObject([{ projectName: 'proj', who: 'budi' }]);
    expect((await t.app.inject({ method: 'POST', url: `/api/code-memory/requests/${pending[0].id}/approve`, headers: dev })).statusCode).toBe(403);
    const approved = await t.app.inject({ method: 'POST', url: `/api/code-memory/requests/${pending[0].id}/approve`, headers: admin });
    expect(approved.json()).toMatchObject({ status: 'approved', decidedBy: 'adi' });
    await until(() => t.codeMemory.state(p.id)?.status === 'ready');
    expect(indexes()).toBe(1);
    expect((await t.app.inject({ method: 'POST', url: `/api/code-memory/requests/${pending[0].id}/reject`, headers: admin })).statusCode).toBe(409);

    // Rejected: nothing runs.
    const again = (await ask(p.id, dev)).json().request;
    expect((await t.app.inject({ method: 'POST', url: `/api/code-memory/requests/${again.id}/reject`, headers: AUTH })).json()).toMatchObject({ status: 'rejected' });
    await new Promise((r) => setTimeout(r, 100));
    expect(indexes()).toBe(1);
    expect((await t.app.inject({ url: '/api/code-memory/requests', headers: AUTH })).json()).toEqual([]);

    // An admin (or the owner) indexes at once.
    expect((await ask(p.id, admin)).json()).toEqual({ status: 'indexing' });
    await until(() => indexes() === 2);
    expect((await ask(secret.id, AUTH)).json()).toEqual({ status: 'indexing' });
    await until(() => indexes() === 3);
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

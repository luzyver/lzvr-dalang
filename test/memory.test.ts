import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { afterEach, describe, expect, it } from 'vitest';
import { Dispatcher } from '../src/dispatcher.js';
import { extractionPrompt, memoryGuide, parseOps, pickFor, pickMemories, queryTerms } from '../src/memory.js';
import { type Memory, Store } from '../src/store.js';
import { AUTH, FAKE, turnsDone, until } from './helpers.js';
import { setupDispatcher } from './setup.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const opened: { close: () => Promise<unknown> }[] = [];
afterEach(async () => { for (const o of opened.splice(0)) await o.close().catch(() => {}); });

/** setupDispatcher, but with memory on. */
function remembering(env: Record<string, string>) {
  const d = setupDispatcher(env);
  const dispatcher = new Dispatcher(d.store, { homes: d.dispatcher.accounts.homes, command: FAKE, env, autoMemory: true });
  return { ...d, dispatcher };
}

const mem = (id: number, text: string, user_key = ''): Memory => ({
  id, project_id: user_key ? null : 'p', user_key, text, source_conv: '', source_title: '', created_by: '', created_at: '', updated_at: '',
});
const of = (shown: Memory[], total = shown.length) => ({ shown, total });

/** The text of the last agent message in a chat (the fake CLI answers with its arguments under FAKE_ECHO_ARGS). */
const lastAnswer = (store: Store, convId: string) =>
  (JSON.parse(store.eventsAfter(convId, 0).filter((e) => e.type === 'item.completed').at(-1)!.payload) as { item: { text: string } }).item.text;

describe('memory', () => {
  it('reads only sensible changes out of an extraction answer', () => {
    const known = new Set([1, 2]);
    expect(parseOps('nothing here', known)).toBeNull();
    expect(parseOps('```json\n{"add": ["  Use pnpm,\\n not npm "], "update": [{"id": 1, "text": "new"}], "remove": [2]}\n```', known))
      .toEqual({ add: [{ text: 'Use pnpm, not npm', person: false }], update: [{ id: 1, text: 'new' }], remove: [2] });
    // unknown ids, empty text, an update of a removed one, and more than five new ones are dropped
    const ops = parseOps(JSON.stringify({
      add: ['a', '', 'a', 'b', 'c', 'd', 'e', 'f', 7], update: [{ id: 9, text: 'x' }, { id: 2, text: 'y' }, { id: 1, text: ' ' }], remove: [2, 5],
    }), known)!;
    expect(ops).toEqual({ add: ['a', 'b', 'c', 'd', 'e'].map((text) => ({ text, person: false })), update: [], remove: [2] });
    // memories for the person only when allowed; an unknown kind never
    const both = JSON.stringify({ add: [{ text: 'Answer in Indonesian', for: 'person' }, { text: 'Uses pnpm', for: 'project' }, { text: 'x', for: 'team' }] });
    expect(parseOps(both, known)!.add).toEqual([{ text: 'Uses pnpm', person: false }]);
    expect(parseOps(both, known, true)!.add).toEqual([{ text: 'Answer in Indonesian', person: true }, { text: 'Uses pnpm', person: false }]);
  });

  it('shows a turn the picked memories, the person\'s own first, with the tools only when it has them', () => {
    const none = { project: of([]), user: null };
    expect(memoryGuide(none, false)).toBe('');
    expect(memoryGuide({ project: of([], 3), user: of([], 2) }, true)).toBe('');
    const guide = memoryGuide({ project: of([mem(2, 'Deploy with ./run.cmd'), mem(1, 'Use pnpm')]), user: null }, false);
    expect(guide).toContain('- [2] Deploy with ./run.cmd\n- [1] Use pnpm');
    expect(guide).not.toContain('memory_save');
    expect(guide).not.toContain('About the person');
    const one = { project: of([mem(1, 'Use pnpm')]), user: null };
    expect(memoryGuide(one, true)).not.toContain('kept on their own');
    expect(memoryGuide(one, true, true)).toContain('memory_save');
    expect(memoryGuide({ project: of([mem(1, 'Use pnpm')], 40), user: null }, true)).toContain('(39 more not shown: memory_search finds them.)');
    const mine = memoryGuide({ project: of([mem(1, 'Use pnpm')]), user: of([mem(5, 'Answer in Indonesian', 'owner')]) }, false);
    expect(mine).toMatch(/About the person[\s\S]*\[5\] Answer in Indonesian[\s\S]*Project memory[\s\S]*\[1\] Use pnpm/);

    expect(extractionPrompt('dalang', { project: [mem(3, 'Keep it')], user: null }, 'asked', 'answered'))
      .toMatch(/\[3\] Keep it[\s\S]*<person>\nasked\n<\/person>/);
    const withPerson = extractionPrompt('dalang', { project: [], user: [mem(4, 'Never add Co-Authored-By', 'owner')] }, 'a', 'b');
    expect(withPerson).toContain('<person-memories>\n- [4] Never add Co-Authored-By\n</person-memories>');
    expect(withPerson).toContain('"for": "person"');
    expect(extractionPrompt('dalang', { project: [], user: null }, 'a', 'b')).not.toContain('person-memories');
  });

  it('picks the memories a request names or is about, then the newest, within the room', () => {
    const store = new Store();
    const p = store.createProject('p', '.');
    const scope = { projectId: p.id };
    const old = store.addMemory(scope, 'Deployment runs through ./run.cmd on the VM');
    const named = store.addMemory(scope, 'Tabel users punya kolom email unik');
    for (let i = 0; i < 80; i++) store.addMemory(scope, `Filler fact number ${i} ${'x'.repeat(60)}`);
    expect(queryTerms('Gimana cara deploy ke VM? Tolong cek juga [7]')).toEqual(['cara', 'deploy', 'cek']);

    const picked = pickMemories(store, scope, `how do I deploy this? see [${named.id}]`, 2000);
    expect(picked.total).toBe(82);
    expect(picked.shown[0]!.id).toBe(named.id); // named by [id] first
    expect(picked.shown[1]!.id).toBe(old.id); // matched "deploy" as the start of "Deployment", though it is the oldest
    expect(picked.shown[2]!.text).toMatch(/^Filler fact number 79/); // then the newest
    expect(picked.shown.reduce((n, m) => n + m.text.length + 8, 0)).toBeLessThanOrEqual(2000 + 82 * 2);

    // A person's own come first and leave the project the rest of the room; they never show up as the project's.
    store.addMemory({ userKey: 'owner' }, 'Deploys only after asking me');
    const both = pickFor(store, p.id, 'owner', 'deploy');
    expect(both.user!.shown.map((m) => m.text)).toEqual(['Deploys only after asking me']);
    expect(both.project.shown.every((m) => m.project_id === p.id)).toBe(true);
    expect(pickFor(store, p.id, '', 'deploy').user).toBeNull();

    // the index follows edits and deletes, and goes with the project
    store.updateMemory(old.id, 'Releases go out with npm run release');
    expect(store.matchMemories(scope, ['deployment'])).toEqual([]);
    expect(store.matchMemories(scope, ['release']).map((m) => m.id)).toEqual([old.id]);
    store.deleteMemory(old.id);
    expect(store.matchMemories(scope, ['release'])).toEqual([]);
    store.deleteProject(p.id);
    expect(store.matchMemories(scope, ['tabel'])).toEqual([]);
    expect(store.db.prepare('SELECT count(*) AS n FROM memories_fts').get()).toEqual(expect.objectContaining({ n: 1 })); // the person's
    expect(() => store.db.prepare("INSERT INTO memories (project_id, user_key, text) VALUES (NULL, '', 'nobody')").run()).toThrow(/CHECK/);
  });

  it('keeps what a finished turn says is worth keeping, and keeps it when the chat is deleted', async () => {
    const { store, dispatcher, conv, project } = remembering({ FAKE_ANSWER: '{"add": ["Builds run with npm run check"], "update": [], "remove": []}' });
    const scope = { projectId: project.id };
    store.enqueue(conv.id, 'how do I check the build?', [], 'sari');
    dispatcher.kick(conv.id);
    await until(() => store.listMemories(scope).length === 1);
    const [m] = store.listMemories(scope);
    expect(m).toMatchObject({ text: 'Builds run with npm run check', source_conv: conv.id, source_title: 'how do I check the build?', created_by: 'sari' });

    // The same fact again is not kept twice; the next turn is shown it.
    store.enqueue(conv.id, 'again', []);
    dispatcher.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    await new Promise((r) => setTimeout(r, 300));
    expect(store.listMemories(scope)).toHaveLength(1);

    store.deleteConversation(conv.id);
    expect(store.listMemories(scope)).toHaveLength(1);
    store.deleteProject(project.id);
    expect(store.listMemories(scope)).toHaveLength(0);
  });

  it("keeps a person's stated preferences in their own memory, only from their own turns", async () => {
    const answer = JSON.stringify({ add: [{ text: 'Never add a Co-Authored-By line', for: 'person' }, { text: 'Tests run with vitest', for: 'project' }] });
    const { store, dispatcher, conv, project } = remembering({ FAKE_ANSWER: answer });
    store.enqueue(conv.id, 'commit this, and never add a Co-Authored-By line from now on', [], 'owner');
    dispatcher.kick(conv.id);
    await until(() => store.listMemories({ userKey: 'owner' }).length === 1);
    expect(store.listMemories({ userKey: 'owner' })[0]).toMatchObject({ project_id: null, text: 'Never add a Co-Authored-By line', created_by: 'owner' });
    await until(() => store.listMemories({ projectId: project.id }).length === 1);

    // A prompt nobody typed (an agent, an approval) keeps nothing for a person; nor with Settings keeping people's off.
    const other = remembering({ FAKE_ANSWER: answer.replace('Never add', 'Always add') });
    other.store.enqueue(other.conv.id, 'from another agent', [], '', 'owner');
    other.dispatcher.kick(other.conv.id);
    await until(() => other.store.listMemories({ projectId: other.project.id }).length === 1);
    other.store.setMemoryPolicy({ ...other.store.getMemoryPolicy(), user: false });
    other.store.enqueue(other.conv.id, 'mine', [], 'owner');
    other.dispatcher.kick(other.conv.id);
    await until(() => turnsDone(other.store, other.conv.id, 2));
    await new Promise((r) => setTimeout(r, 300));
    expect(other.store.listMemories({ userKey: 'owner' })).toHaveLength(0);
  });

  it('keeps nothing when Settings turns it off, for sub-agents, or when the answer makes no sense', async () => {
    const off = remembering({ FAKE_ANSWER: '{"add": ["Never kept"]}' });
    off.store.setMemoryPolicy({ ...off.store.getMemoryPolicy(), auto: false });
    off.store.enqueue(off.conv.id, 'hi', []);
    off.dispatcher.kick(off.conv.id);
    const sub = off.store.createConversation(off.project.id, undefined, off.conv.id);
    await until(() => turnsDone(off.store, off.conv.id, 1));
    off.store.setMemoryPolicy({ ...off.store.getMemoryPolicy(), auto: true });
    off.store.enqueue(sub.id, 'sub task', []);
    off.dispatcher.kick(sub.id);
    await until(() => turnsDone(off.store, sub.id, 1));

    const odd = remembering({ FAKE_ANSWER: 'I would keep the build command.' });
    odd.store.enqueue(odd.conv.id, 'hi', []);
    odd.dispatcher.kick(odd.conv.id);
    await until(() => turnsDone(odd.store, odd.conv.id, 1));
    await new Promise((r) => setTimeout(r, 300));
    expect(off.store.listMemories({ projectId: off.project.id })).toHaveLength(0);
    expect(odd.store.listMemories({ projectId: odd.project.id })).toHaveLength(0);
  });

  it("tells each turn what the project keeps, and the person's own only on their turns", async () => {
    const { store, project, conv, dir } = setupDispatcher({ FAKE_ECHO_ARGS: '1' });
    store.setAgentGit({ commit: true, push: true }); // no git guide
    store.addMemory({ projectId: project.id }, 'The API lives in src/app.ts');
    store.addMemory({ userKey: 'owner' }, 'Answer in Indonesian');
    const d = new Dispatcher(store, { homes: [`${dir}/a`], command: FAKE, env: { FAKE_ECHO_ARGS: '1' } });
    store.enqueue(conv.id, 'x', [], 'owner');
    d.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 1));
    expect(lastAnswer(store, conv.id)).toContain('The API lives in src/app.ts');
    expect(lastAnswer(store, conv.id)).toContain('Answer in Indonesian');
    store.enqueue(conv.id, 'y', [], 'someone-else');
    d.kick(conv.id);
    await until(() => turnsDone(store, conv.id, 2));
    expect(lastAnswer(store, conv.id)).toContain('The API lives in src/app.ts');
    expect(lastAnswer(store, conv.id)).not.toContain('Answer in Indonesian');
  });

  it('lets everyone who may open the project read and change its memory, and admins the settings', async () => {
    const t = setupApp();
    const dev = bearer((await mkUser(t, 'budi', 'dev')).token);
    const mk = async (access: string) => (await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: access, path: 'proj', access } })).json().id as string;
    const open = await mk('all');
    const hidden = await mk('owner');
    const req = (method: string, url: string, headers: Record<string, string>, payload?: object) => t.app.inject({ method: method as 'GET', url, headers, payload });

    const made = await req('POST', `/api/projects/${open}/memories`, dev, { text: '  Use the  staging DB for tests ' });
    expect(made.statusCode).toBe(201);
    expect(made.json()).toMatchObject({ text: 'Use the staging DB for tests', created_by: 'budi' });
    const id = made.json().id;
    expect((await req('PATCH', `/api/projects/${open}/memories/${id}`, dev, { text: 'Use the test DB' })).json().text).toBe('Use the test DB');
    expect((await req('GET', `/api/projects/${open}/memories?q=test`, dev)).json()).toHaveLength(1);
    expect((await req('GET', `/api/projects/${open}/memories?q=nothing`, dev)).json()).toHaveLength(0);
    // another project's id does not reach it, and a project the user may not open does not exist for them
    expect((await req('DELETE', `/api/projects/${hidden}/memories/${id}`, AUTH)).statusCode).toBe(404);
    expect((await req('GET', `/api/projects/${hidden}/memories`, dev)).statusCode).toBe(404);
    expect((await req('DELETE', `/api/projects/${open}/memories/${id}`, dev)).statusCode).toBe(204);
    expect(t.store.listMemories({ projectId: open })).toHaveLength(0);

    expect((await req('GET', '/api/settings/memory', dev)).statusCode).toBe(403);
    const saved = await req('PUT', '/api/settings/memory', AUTH, { auto: false, user: false, effort: '', models: { claude: 'haiku' } });
    expect(saved.json()).toMatchObject({ auto: false, user: false, effort: '', models: { claude: 'haiku' } });
    expect((await req('PUT', '/api/settings/memory', AUTH, { auto: true, models: { codex: '--flag' } })).statusCode).toBe(400);
  });

  it("keeps each person's own memory to them alone, not even the owner sees another's", async () => {
    const t = setupApp();
    const budi = await mkUser(t, 'budi', 'dev');
    const dev = bearer(budi.token);
    const req = (method: string, url: string, headers: Record<string, string>, payload?: object) => t.app.inject({ method: method as 'GET', url, headers, payload });

    const mine = (await req('POST', '/api/me/memories', dev, { text: 'Prefers short answers' })).json();
    expect(mine).toMatchObject({ user_key: budi.id, project_id: null });
    await req('POST', '/api/me/memories', AUTH, { text: 'Answer in Indonesian' });
    expect((await req('GET', '/api/me/memories', dev)).json().map((m: Memory) => m.text)).toEqual(['Prefers short answers']);
    expect((await req('GET', '/api/me/memories', AUTH)).json().map((m: Memory) => m.text)).toEqual(['Answer in Indonesian']);
    expect((await req('PATCH', `/api/me/memories/${mine.id}`, AUTH, { text: 'hijacked' })).statusCode).toBe(404);
    expect((await req('DELETE', `/api/me/memories/${mine.id}`, AUTH)).statusCode).toBe(404);
    expect((await req('PATCH', `/api/me/memories/${mine.id}`, dev, { text: 'Prefers very short answers' })).json().text).toBe('Prefers very short answers');

    // a person's memory goes with them
    t.store.deleteUser(budi.id);
    expect(t.store.listMemories({ userKey: budi.id })).toHaveLength(0);
    expect(t.store.listMemories({ userKey: 'owner' })).toHaveLength(1);
  });

  it('gives agents memory tools on their own project, the ones they may open, and their person\'s own', async () => {
    const t = setupApp();
    opened.push({ close: () => t.app.close() });
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const port = (t.app.server.address() as { port: number }).port;
    const p = t.store.createProject('proj', t.cfg.workspaceRoot);
    const other = t.store.createProject('secret', t.cfg.workspaceRoot, undefined, undefined, 'owner');
    const conv = t.store.createConversation(p.id);
    const connect = async (author = '') => {
      const client = new Client({ name: 'test', version: '1.0.0' });
      await client.connect(new StreamableHTTPClientTransport(new URL(`http://127.0.0.1:${port}/mcp`), {
        requestInit: { headers: bearer(t.dispatcher.issueMcpToken(conv.id, author)) },
      }));
      opened.push(client);
      return async (name: string, args: Record<string, unknown>) => {
        const r = (await client.callTool({ name, arguments: args })) as { isError?: boolean; content: { text: string }[] };
        return { isError: Boolean(r.isError), text: r.content[0]!.text };
      };
    };
    const call = await connect();

    const saved = JSON.parse((await call('memory_save', { text: 'Releases are tagged vX.Y.Z' })).text);
    expect(t.store.getMemory(saved.id)).toMatchObject({ project_id: p.id, created_by: 'agent', source_conv: conv.id });
    expect(JSON.parse((await call('memory_search', { query: 'tagged' })).text)).toHaveLength(1);
    expect(JSON.parse((await call('memory_search', { query: 'how are releases versioned' })).text)).toHaveLength(1); // some words
    expect(JSON.parse((await call('memory_search', { query: 'nothing alike' })).text)).toHaveLength(0);
    await call('memory_update', { id: saved.id, text: 'Releases are tagged release-X.Y' });
    expect(t.store.getMemory(saved.id)!.text).toBe('Releases are tagged release-X.Y');

    const secret = t.store.addMemory({ projectId: other.id }, 'hidden');
    expect((await call('memory_search', { project_id: other.id })).isError).toBe(true);
    expect((await call('memory_forget', { id: secret.id })).isError).toBe(true);
    expect((await call('memory_forget', { id: saved.id })).isError).toBe(false);
    expect(t.store.listMemories({ projectId: p.id })).toHaveLength(0);
    expect(t.store.listMemories({ projectId: other.id })).toHaveLength(1);

    // "mine": the person the turn runs for; a turn no person sent has none, and nobody reaches another person's
    expect((await call('memory_save', { scope: 'mine', text: 'x' })).isError).toBe(true);
    const owners = await connect('owner');
    const pref = JSON.parse((await owners('memory_save', { scope: 'mine', text: 'Answer in Indonesian' })).text);
    expect(t.store.getMemory(pref.id)).toMatchObject({ user_key: 'owner', project_id: null });
    expect(JSON.parse((await owners('memory_search', { scope: 'mine' })).text)).toMatchObject([{ id: pref.id, scope: 'mine' }]);
    expect((await call('memory_forget', { id: pref.id })).isError).toBe(true);
    expect((await owners('memory_forget', { id: pref.id })).isError).toBe(false);
  });
});

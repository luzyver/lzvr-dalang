import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { insideRoot } from '../src/paths.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const B = '----lzvrtest';
function multipart(filename: string, content: string) {
  const body = `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${B}--\r\n`;
  return { payload: body, headers: { ...AUTH, 'content-type': `multipart/form-data; boundary=${B}` } };
}

describe('uploads', () => {
  it('keeps pending files private and enforces current project access on downloads and reuse', async () => {
    const t = setupApp();
    vi.spyOn(t.dispatcher, 'kick').mockImplementation(() => {});
    const dev = await mkUser(t, 'dev', 'dev');
    const second = await mkUser(t, 'second', 'dev');
    const upload = multipart('secret.txt', 'private data');
    const up = await t.app.inject({ method: 'POST', url: '/api/uploads', ...upload, headers: { ...upload.headers, ...bearer(dev.token) } });
    const path = up.json().path as string;
    const url = '/api/uploads/' + path.split(/[\\/]/).slice(-2).map(encodeURIComponent).join('/');
    const download = (token: string) => t.app.inject({ url, headers: bearer(token) });
    expect((await download(dev.token)).statusCode).toBe(200);
    expect((await download(second.token)).statusCode).toBe(404);
    const project = t.store.createProject('shared', t.root);
    const conv = t.store.createConversation(project.id);
    const attach = (token: string) => t.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/prompts`, headers: bearer(token), payload: { prompt: 'read', attachments: [path] } });
    expect((await attach(second.token)).statusCode).toBe(404);
    expect((await attach(dev.token)).statusCode).toBe(202);
    expect((await download(second.token)).statusCode).toBe(200);
    expect((await download(dev.token)).headers['cache-control']).toBe('private, no-store');
    t.store.db.prepare("UPDATE projects SET access='owner' WHERE id=?").run(project.id);
    expect((await download(dev.token)).statusCode).toBe(404);
    expect((await download(second.token)).statusCode).toBe(404);
    const other = t.store.createConversation(t.store.createProject('other', t.root).id);
    expect((await t.app.inject({ method: 'POST', url: `/api/conversations/${other.id}/prompts`, headers: bearer(dev.token), payload: { prompt: 'steal', attachments: [path] } })).statusCode).toBe(404);
    expect((await t.app.inject({ url, headers: AUTH })).body).toBe('private data');
    t.store.db.prepare('DELETE FROM projects WHERE id=?').run(project.id);
    expect((await download(dev.token)).statusCode).toBe(404);
    await t.app.close();
  });

  it('stores a file under the uploads dir even with a hostile filename', async () => {
    const t = setupApp();
    const uploads = join(t.cfg.stateDir, 'uploads');
    for (const name of ['notes.txt', '../../evil.txt', '..']) {
      const r = await t.app.inject({ method: 'POST', url: '/api/uploads', ...multipart(name, 'data') });
      expect(r.statusCode, name).toBe(201);
      expect(insideRoot(uploads, r.json().path), name).not.toBeNull();
    }
  });

  it('turns awkward filenames into safe ones', async () => {
    const t = setupApp();
    const names: Record<string, string> = {
      'a:b.txt': 'a_b.txt', 'CON.txt': '_CON.txt', 'aux': '_aux', 'nul.tar.gz': '_nul.tar.gz',
      'report.': 'report', 'with space.txt': 'with space.txt', '': 'file',
    };
    for (const [input, expected] of Object.entries(names)) {
      const r = await t.app.inject({ method: 'POST', url: '/api/uploads', ...multipart(input, 'x') });
      expect(r.statusCode, input).toBe(201);
      expect(r.json().path.split(/[\\/]/).pop(), input).toBe(expected);
    }
  });

  it('rejects an upload over the size limit instead of storing a truncated file', async () => {
    const t = setupApp({}, { maxUploadBytes: 1024 });
    const r = await t.app.inject({ method: 'POST', url: '/api/uploads', ...multipart('big.txt', 'x'.repeat(5000)) });
    expect(r.statusCode).toBe(413);
    expect(readdirSync(join(t.cfg.stateDir, 'uploads'))).toEqual([]);
  });

  it('lets an uploaded file be attached to a prompt', async () => {
    const t = setupApp();
    const up = await t.app.inject({ method: 'POST', url: '/api/uploads', ...multipart('a.txt', 'hi') });
    expect(up.statusCode).toBe(201);
    const p = await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'proj', path: 'proj' } });
    const c = await t.app.inject({ method: 'POST', url: `/api/projects/${p.json().id}/conversations`, headers: AUTH });
    const r = await t.app.inject({
      method: 'POST', url: `/api/conversations/${c.json().id}/prompts`, headers: AUTH,
      payload: { prompt: 'read it', attachments: [up.json().path] },
    });
    expect(r.statusCode).toBe(202);
    await until(() => turnsDone(t.store, c.json().id, 1));
  });
});

describe('SSE', () => {
  let close: (() => Promise<unknown>) | undefined;
  afterEach(async () => { await close?.(); close = undefined; });

  async function readUntil(res: Response, done: (text: string) => boolean): Promise<string> {
    const reader = res.body!.getReader();
    const dec = new TextDecoder();
    let text = '';
    const start = Date.now();
    while (!done(text)) {
      if (Date.now() - start > 8000) throw new Error('readUntil timeout\n' + text);
      const { value, done: end } = await reader.read();
      if (end) break;
      text += dec.decode(value);
    }
    await reader.cancel();
    return text;
  }

  it('returns actual context independently of chat totals and hides it after a session switch', async () => {
    const t = setupApp({ FAKE_CONTEXT: JSON.stringify({ tokens: 12_000, window: 200_000 }),
      FAKE_USAGE: JSON.stringify({ input_tokens: 5_000_000, cached_input_tokens: 4_000_000, output_tokens: 100 }) });
    const conv = t.store.createConversation(t.store.createProject('p', t.root).id);
    t.store.enqueue(conv.id, 'task', []);
    t.dispatcher.kick(conv.id);
    await until(() => turnsDone(t.store, conv.id, 1));
    const url = `/api/conversations/${conv.id}`;
    const result = (await t.app.inject({ url, headers: AUTH })).json();
    expect(result.context_usage).toEqual({ tokens: 12_000, window: 200_000 });
    expect(result.token_usage.input_tokens).toBe(5_000_000);
    await t.app.inject({ method: 'PUT', url: `${url}/backend`, headers: AUTH, payload: { backend: 'claude' } });
    const switched = (await t.app.inject({ url, headers: AUTH })).json();
    expect(switched.context_usage).toBeNull();
    expect(switched.token_usage).toEqual(result.token_usage);
  });

  it('streams live events and replays from Last-Event-ID', async () => {
    const t = setupApp();
    close = () => t.app.close();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const addr = t.app.server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    const p = await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'proj', path: 'proj' } });
    const conv = (await t.app.inject({ method: 'POST', url: `/api/projects/${p.json().id}/conversations`, headers: AUTH })).json();

    const live = await fetch(`${base}/api/conversations/${conv.id}/events`, { headers: AUTH });
    expect(live.headers.get('content-type')).toContain('text/event-stream');
    await t.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/prompts`, headers: AUTH, payload: { prompt: 'go' } });
    const text = await readUntil(live, (s) => s.includes('event: turn.completed'));
    expect(text).toContain('event: thread.started');
    expect(text).toMatch(/id: \d+\nevent: turn\.completed\ndata: \{/);

    await until(() => turnsDone(t.store, conv.id, 1));
    const all = t.store.eventsAfter(conv.id, 0);
    const completedId = all.find((e) => e.type === 'turn.completed')!.id;
    const replay = await fetch(`${base}/api/conversations/${conv.id}/events`, {
      headers: { ...AUTH, 'last-event-id': String(completedId - 1) },
    });
    const replayed = await readUntil(replay, (s) => s.includes('event: turn.completed'));
    expect(replayed).not.toContain('event: thread.started');
  });

  it('returns one-turn counts for paged history and SSE, and a chat-wide total across agents', async () => {
    const t = setupApp();
    close = () => t.app.close();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
    const conv = t.store.createConversation(t.store.createProject('p', t.root).id);
    const add = (prompt: string, session: string, usage: Record<string, number>) => {
      const turn = t.store.startTurn(conv.id, prompt);
      t.store.addEvent(turn, 'user.prompt', JSON.stringify({ type: 'user.prompt', text: prompt }));
      t.store.addEvent(turn, 'thread.started', JSON.stringify({ type: 'thread.started', thread_id: session }));
      const answer = t.store.addEvent(turn, 'item.completed', JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: prompt } }));
      const completed = t.store.addEvent(turn, 'turn.completed', JSON.stringify({ type: 'turn.completed', usage }));
      t.store.endTurn(turn, 'completed', usage);
      return { turn, answer, completed };
    };
    add('first', 'codex-a', { input_tokens: 7684476, cached_input_tokens: 7366528, output_tokens: 36917 });
    const second = add('second', 'codex-a', { input_tokens: 7871037, cached_input_tokens: 7526784, output_tokens: 37019 });
    const third = add('claude', 'claude-b', { input_tokens: 8, output_tokens: 2 });
    add('codex again', 'codex-c', { input_tokens: 100, cached_input_tokens: 20, output_tokens: 5 });
    const expected = { input_tokens: 186561, cached_input_tokens: 160256, output_tokens: 102 };
    const page = (await t.app.inject({ url: `/api/conversations/${conv.id}/history?turns=1&before=${third.turn}`, headers: AUTH })).json();
    expect(page.more).toBe(true);
    expect(page.events.find((e: { id: number }) => e.id === second.completed).data.turn_usage).toEqual(expected);
    const details = (await t.app.inject({ url: `/api/conversations/${conv.id}`, headers: AUTH })).json();
    expect(details.token_usage).toEqual({ input_tokens: 7871145, output_tokens: 37026, cached_input_tokens: 7526804 });
    const raw = t.store.eventOf(conv.id, second.completed)!;
    expect(JSON.parse(raw.payload).usage.input_tokens).toBe(7871037); // no database rewrite
    const streamed = await readUntil(await fetch(`${base}/api/conversations/${conv.id}/events?compact=1&after=${second.answer}`, { headers: AUTH }), (s) => s.includes('event: turn.completed'));
    const payload = JSON.parse(streamed.split('\n').find((line) => line.startsWith('data:'))!.slice(5));
    expect(payload.turn_usage).toEqual(expected);
  });

  it('updates turn counts and chat totals on a new live completion, including after reconnect', async () => {
    const env = { FAKE_USAGE: JSON.stringify({ input_tokens: 100, cached_input_tokens: 80, output_tokens: 10 }) };
    const t = setupApp(env);
    close = () => t.app.close();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
    const conv = t.store.createConversation(t.store.createProject('p', t.root).id);
    t.store.enqueue(conv.id, 'first', []);
    t.dispatcher.kick(conv.id);
    await until(() => turnsDone(t.store, conv.id, 1));
    const after = t.store.eventsAfter(conv.id, 0).at(-1)!.id;
    const live = await fetch(`${base}/api/conversations/${conv.id}/events?compact=1&after=${after}`, { headers: AUTH });
    env.FAKE_USAGE = JSON.stringify({ input_tokens: 150, cached_input_tokens: 120, output_tokens: 13 });
    t.store.enqueue(conv.id, 'second', []);
    t.dispatcher.kick(conv.id);
    const text = await readUntil(live, (s) => s.includes('event: turn.completed'));
    const completed = text.split('\n\n').find((frame) => frame.includes('event: turn.completed'))!;
    expect(JSON.parse(completed.split('\n').find((line) => line.startsWith('data:'))!.slice(5)).turn_usage)
      .toEqual({ input_tokens: 50, output_tokens: 3, cached_input_tokens: 40 });
    await until(() => turnsDone(t.store, conv.id, 2));
    const get = async () => (await t.app.inject({ url: `/api/conversations/${conv.id}`, headers: AUTH })).json();
    expect((await get()).token_usage).toEqual({ input_tokens: 150, output_tokens: 13, cached_input_tokens: 120 });
    await readUntil(await fetch(`${base}/api/conversations/${conv.id}/events?compact=1&after=${after}`, { headers: AUTH }), (s) => s.includes('event: turn.completed'));
    expect((await get()).token_usage).toEqual({ input_tokens: 150, output_tokens: 13, cached_input_tokens: 120 });
  });

  it('cannot be split into extra frames by a hostile event type', async () => {
    const t = setupApp();
    close = () => t.app.close();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
    const p = t.store.createProject('p', t.root);
    const conv = t.store.createConversation(p.id);
    const turn = t.store.startTurn(conv.id, 'x');
    t.store.addEvent(turn, 'evil\ndata: {"forged":true}\n\nevent: x', '{"type":"x"}');
    const res = await fetch(`${base}/api/conversations/${conv.id}/events`, { headers: AUTH });
    const text = await readUntil(res, (s) => s.includes('\n\n'));
    expect(text.match(/^event:/gm)).toHaveLength(1);
    expect(text.match(/^data:/gm)).toHaveLength(1);
    expect(text).toContain('\ndata: {"type":"x"}\n'); // the real payload, as the only data line
    expect(text.split('\n\n').filter(Boolean)).toHaveLength(1); // exactly one frame
  });

  it('replays a chat whose history is over a megabyte in full', async () => {
    const t = setupApp();
    close = () => t.app.close();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
    const conv = t.store.createConversation(t.store.createProject('p', t.root).id);
    const turn = t.store.startTurn(conv.id, 'x');
    const big = JSON.stringify({ type: 'x', text: 'y'.repeat(40_000) });
    for (let i = 0; i < 60; i++) t.store.addEvent(turn, 'item.completed', big); // about 2.4 MB
    t.store.addEvent(turn, 'turn.completed', '{"type":"turn.completed"}');
    const res = await fetch(`${base}/api/conversations/${conv.id}/events`, { headers: AUTH });
    const text = await readUntil(res, (s) => s.includes('event: turn.completed'));
    expect(text.match(/^event: item\.completed$/gm)).toHaveLength(60);
  });

  it('cuts long tool output for the panel and drops item.updated', async () => {
    const t = setupApp();
    close = () => t.app.close();
    await t.app.listen({ host: '127.0.0.1', port: 0 });
    const base = `http://127.0.0.1:${(t.app.server.address() as { port: number }).port}`;
    const conv = t.store.createConversation(t.store.createProject('p', t.root).id);
    const turn = t.store.startTurn(conv.id, 'x');
    const out = 'o'.repeat(10_000);
    const cmd = t.store.addEvent(turn, 'item.completed', JSON.stringify({ type: 'item.completed', item: { id: 'c', type: 'command_execution', command: 'ls', aggregated_output: out, exit_code: 0 } }));
    t.store.addEvent(turn, 'item.updated', JSON.stringify({ type: 'item.updated', item: { type: 'command_execution', aggregated_output: out } }));
    t.store.addEvent(turn, 'turn.completed', '{"type":"turn.completed"}');
    const compact = await readUntil(await fetch(`${base}/api/conversations/${conv.id}/events?compact=1`, { headers: AUTH }), (s) => s.includes('event: turn.completed'));
    expect(compact).not.toContain(out);
    expect(compact).not.toContain('event: item.updated');
    expect(compact).toContain('"cut":true');
    const full = await readUntil(await fetch(`${base}/api/conversations/${conv.id}/events`, { headers: AUTH }), (s) => s.includes('event: turn.completed'));
    expect(full).toContain(out); // API clients still get every event as it is
    const one = await t.app.inject({ url: `/api/conversations/${conv.id}/events/${cmd}`, headers: AUTH });
    expect(one.json().data.item.aggregated_output).toBe(out);
    const other = t.store.createConversation(t.store.createProject('q', t.root).id);
    expect((await t.app.inject({ url: `/api/conversations/${other.id}/events/${cmd}`, headers: AUTH })).statusCode).toBe(404);
  });

  it('pages the history in whole turns, newest first', async () => {
    const t = setupApp();
    const conv = t.store.createConversation(t.store.createProject('p', t.root).id);
    const firsts: number[] = [];
    for (let i = 0; i < 25; i++) {
      const turn = t.store.startTurn(conv.id, `p${i}`);
      firsts.push(t.store.addEvent(turn, 'user.prompt', JSON.stringify({ type: 'user.prompt', text: `p${i}` })));
      t.store.addEvent(turn, 'turn.completed', '{"type":"turn.completed"}');
    }
    const get = async (q: string) => (await t.app.inject({ url: `/api/conversations/${conv.id}/history?${q}`, headers: AUTH })).json();
    const last = await get('turns=10');
    expect(last.events).toHaveLength(20);
    expect(last.events[0].data.text).toBe('p15');
    expect(last.more).toBe(true);
    expect(last.last).toBe(last.events[19].id);
    const mid = await get(`turns=10&before=${last.before}`);
    expect(mid.events[0].data.text).toBe('p5');
    const rest = await get(`turns=10&before=${mid.before}`);
    expect(rest.events.map((e: { data: { text?: string } }) => e.data.text).filter(Boolean)).toEqual(['p0', 'p1', 'p2', 'p3', 'p4']);
    expect(rest.more).toBe(false);
    const toHit = await get(`turns=10&focus=${firsts[3]}`);
    expect(toHit.events[0].data.text).toBe('p3'); // reaches back to a search hit
    expect(toHit.more).toBe(true);
  });

  it('404s for an unknown conversation', async () => {
    const t = setupApp();
    const r = await t.app.inject({ url: '/api/conversations/nope/events', headers: AUTH });
    expect(r.statusCode).toBe(404);
  });
});

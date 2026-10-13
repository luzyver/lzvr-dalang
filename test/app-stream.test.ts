import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { insideRoot } from '../src/paths.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { setupApp } from './setup-app.js';

const B = '----lzvrtest';
function multipart(filename: string, content: string) {
  const body = `--${B}\r\nContent-Disposition: form-data; name="file"; filename="${filename}"\r\nContent-Type: text/plain\r\n\r\n${content}\r\n--${B}--\r\n`;
  return { payload: body, headers: { ...AUTH, 'content-type': `multipart/form-data; boundary=${B}` } };
}

describe('uploads', () => {
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
    const lastId = all.at(-1)!.id;
    const replay = await fetch(`${base}/api/conversations/${conv.id}/events`, {
      headers: { ...AUTH, 'last-event-id': String(lastId - 1) },
    });
    const replayed = await readUntil(replay, (s) => s.includes('event: turn.completed'));
    expect(replayed).not.toContain('event: thread.started');
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
    expect(text).toContain('\ndata: {"type":"x"}\n\n'); // the real payload, as the only data line
    expect(text.split('\n\n').filter(Boolean)).toHaveLength(1); // exactly one frame
  });

  it('404s for an unknown conversation', async () => {
    const t = setupApp();
    const r = await t.app.inject({ url: '/api/conversations/nope/events', headers: AUTH });
    expect(r.statusCode).toBe(404);
  });
});

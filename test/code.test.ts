import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { badName } from '../src/code-routes.js';
import { Terminals } from '../src/terminals.js';
import { AUTH, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

/** An app with one project (folder `proj`, some files in it) and a chat in it. */
async function withChat(opts: { sandbox?: string; terminals?: Terminals } = {}) {
  const t = setupApp({}, { terminals: opts.terminals });
  const dir = join(t.root, 'proj');
  mkdirSync(join(dir, 'src'), { recursive: true });
  mkdirSync(join(dir, '.git'));
  writeFileSync(join(dir, 'README.md'), '# hi\n');
  writeFileSync(join(dir, 'src', 'app.ts'), 'export const a = 1;\r\n');
  writeFileSync(join(dir, 'logo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 1]));
  const p = await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'proj', path: 'proj', ...(opts.sandbox && { sandbox: opts.sandbox }) } });
  const c = await t.app.inject({ method: 'POST', url: `/api/projects/${p.json().id}/conversations`, headers: AUTH, payload: {} });
  const id = c.json().id as string;
  const call = (method: string, url: string, payload?: unknown, headers = AUTH) =>
    t.app.inject({ method: method as 'GET', url: `/api/conversations/${id}${url}`, headers, ...(payload !== undefined && { payload: payload as object }) });
  return { ...t, dir, id, call };
}

describe('code editor: files', () => {
  it('describes the chat folder and who may do what', async () => {
    const { call } = await withChat({ terminals: new Terminals({ load: async () => { throw new Error('no pty'); } }) });
    const r = await call('GET', '/code');
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ project: { name: 'proj' }, root: 'proj', readOnly: false, busy: false, terminal: false });
  });

  it('lists a folder with folders first and without .git', async () => {
    const { call } = await withChat();
    const root = await call('GET', '/fs/list');
    expect(root.json().entries.map((e: { name: string }) => e.name)).toEqual(['src', 'logo.png', 'README.md']);
    expect(root.json().entries[0]).toMatchObject({ dir: true });
    expect((await call('GET', '/fs/list?path=src')).json().entries).toMatchObject([{ name: 'app.ts', dir: false }]);
    expect((await call('GET', '/fs/list?path=../')).statusCode).toBe(404);
    expect((await call('GET', '/fs/list?path=missing')).statusCode).toBe(404);
  });

  it('lists every file for "Go to file"', async () => {
    const { call } = await withChat();
    expect((await call('GET', '/fs/files')).json().files.sort()).toEqual(['README.md', 'logo.png', 'src/app.ts']);
  });

  it('reads text as it is (CRLF kept) and does not send binary files', async () => {
    const { call } = await withChat();
    const r = await call('GET', '/fs/file?path=src/app.ts');
    expect(r.json()).toMatchObject({ path: 'src/app.ts', content: 'export const a = 1;\r\n' });
    expect(typeof r.json().mtime).toBe('number');
    expect((await call('GET', '/fs/file?path=logo.png')).json()).toMatchObject({ binary: true });
    expect((await call('GET', '/fs/file?path=logo.png')).json().content).toBeUndefined();
    expect((await call('GET', '/fs/file?path=../../state')).statusCode).toBe(404);
    expect((await call('GET', '/fs/file?path=src')).statusCode).toBe(404);
  });

  it('saves, and refuses to overwrite a file that changed on disk since it was read', async () => {
    const { call, dir } = await withChat();
    const read = (await call('GET', '/fs/file?path=README.md')).json();
    const saved = await call('PUT', '/fs/file', { path: 'README.md', content: '# hello\n', mtime: read.mtime });
    expect(saved.statusCode).toBe(200);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# hello\n');
    // Someone else writes it; the old mtime no longer matches.
    writeFileSync(join(dir, 'README.md'), '# theirs\n');
    const stale = await call('PUT', '/fs/file', { path: 'README.md', content: '# mine\n', mtime: saved.json().mtime - 5000 });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({ changed: true });
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# theirs\n');
    // Without an mtime it overwrites.
    expect((await call('PUT', '/fs/file', { path: 'README.md', content: '# mine\n' })).statusCode).toBe(200);
    expect(readFileSync(join(dir, 'README.md'), 'utf8')).toBe('# mine\n');
    expect((await call('PUT', '/fs/file', { path: 'nope.md', content: 'x' })).statusCode).toBe(404);
  });

  it('creates, renames and deletes files and folders', async () => {
    const { call, dir } = await withChat();
    expect((await call('POST', '/fs/new', { path: 'lib', dir: true })).statusCode).toBe(201);
    expect((await call('POST', '/fs/new', { path: 'lib/util.ts' })).json()).toEqual({ path: 'lib/util.ts' });
    expect(existsSync(join(dir, 'lib', 'util.ts'))).toBe(true);
    expect((await call('POST', '/fs/new', { path: 'lib/util.ts' })).statusCode).toBe(409);
    expect((await call('POST', '/fs/new', { path: 'nowhere/x.ts' })).statusCode).toBe(400);

    expect((await call('POST', '/fs/rename', { from: 'lib/util.ts', to: 'lib/helpers.ts' })).json()).toEqual({ path: 'lib/helpers.ts' });
    expect((await call('POST', '/fs/rename', { from: 'lib/helpers.ts', to: 'README.md' })).statusCode).toBe(409);
    expect((await call('POST', '/fs/rename', { from: 'lib', to: 'lib/inner' })).statusCode).toBe(400);
    expect((await call('POST', '/fs/rename', { from: 'lib', to: 'src/lib' })).json()).toEqual({ path: 'src/lib' });
    expect(existsSync(join(dir, 'src', 'lib', 'helpers.ts'))).toBe(true);

    expect((await call('POST', '/fs/delete', { path: 'src/lib' })).statusCode).toBe(204);
    expect(existsSync(join(dir, 'src', 'lib'))).toBe(false);
    expect((await call('POST', '/fs/delete', { path: 'src/lib' })).statusCode).toBe(404);
  });

  it('never leaves the folder, touches .git or deletes the root', async () => {
    const { call, root } = await withChat();
    writeFileSync(join(root, 'outside.txt'), 'x');
    expect((await call('POST', '/fs/new', { path: '../evil.txt' })).statusCode).toBe(400);
    expect(existsSync(join(root, 'evil.txt'))).toBe(false);
    expect((await call('PUT', '/fs/file', { path: '../outside.txt', content: 'y' })).statusCode).toBe(404);
    expect((await call('POST', '/fs/delete', { path: '../outside.txt' })).statusCode).toBe(404);
    expect((await call('POST', '/fs/rename', { from: 'README.md', to: '../moved.md' })).statusCode).toBe(400);
    expect((await call('POST', '/fs/new', { path: '.git/hooks' })).statusCode).toBe(403);
    expect((await call('POST', '/fs/delete', { path: '.git' })).statusCode).toBe(403);
    expect((await call('POST', '/fs/rename', { from: 'README.md', to: '.git/README.md' })).statusCode).toBe(403);
    expect((await call('POST', '/fs/delete', { path: '.' })).statusCode).toBe(400);
    expect(readFileSync(join(root, 'outside.txt'), 'utf8')).toBe('x');
  });

  it('refuses names that do not work on Linux or Windows', () => {
    for (const bad of ['', '.', '..', 'a/b', 'a\\b', 'x:y', 'what?', 'trailing.', 'CON', 'nul.txt']) expect(badName(bad), bad).not.toBeNull();
    for (const ok of ['app.ts', '.env', 'My File (1).md', 'über.txt']) expect(badName(ok), ok).toBeNull();
  });

  it('uploads into a folder, replacing an existing file only when asked', async () => {
    const { app, id, dir } = await withChat();
    const upload = (name: string, body: string, query = '') => {
      const boundary = '----dalang';
      const payload = `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: text/plain\r\n\r\n${body}\r\n--${boundary}--\r\n`;
      return app.inject({ method: 'POST', url: `/api/conversations/${id}/fs/upload${query}`, payload,
        headers: { ...AUTH, 'content-type': `multipart/form-data; boundary=${boundary}` } });
    };
    expect((await upload('notes.txt', 'one', '?dir=src')).json()).toEqual({ path: 'src/notes.txt' });
    expect(readFileSync(join(dir, 'src', 'notes.txt'), 'utf8')).toBe('one');
    const again = await upload('notes.txt', 'two', '?dir=src');
    expect(again.statusCode).toBe(409);
    expect(again.json()).toMatchObject({ exists: true });
    expect((await upload('notes.txt', 'two', '?dir=src&replace=1')).statusCode).toBe(201);
    expect(readFileSync(join(dir, 'src', 'notes.txt'), 'utf8')).toBe('two');
    expect((await upload('x.txt', 'x', '?dir=..')).statusCode).toBe(400);
  });

  it('reports the open files\' mtimes and whether an agent works there', async () => {
    const { call, dir } = await withChat();
    const r = await call('POST', '/fs/stat', { paths: ['README.md', 'gone.md'] });
    expect(r.json()).toEqual({ busy: false, files: { 'README.md': statSync(join(dir, 'README.md')).mtimeMs, 'gone.md': null } });
  });

  it('changes nothing in a read-only project, nor while an agent works in the folder', async () => {
    const ro = await withChat({ sandbox: 'read-only' });
    expect((await ro.call('GET', '/code')).json().readOnly).toBe(true);
    expect((await ro.call('GET', '/fs/file?path=README.md')).statusCode).toBe(200);
    expect((await ro.call('PUT', '/fs/file', { path: 'README.md', content: 'x' })).statusCode).toBe(403);
    expect((await ro.call('POST', '/fs/new', { path: 'a.txt' })).statusCode).toBe(403);

    const busy = await withChat();
    busy.dispatcher.isRunning = () => true;
    expect((await busy.call('POST', '/fs/stat', { paths: [] })).json().busy).toBe(true);
    const r = await busy.call('PUT', '/fs/file', { path: 'README.md', content: 'x' });
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/agent is working/);
    expect((await busy.call('POST', '/fs/delete', { path: 'README.md' })).statusCode).toBe(409);
    expect(readFileSync(join(busy.dir, 'README.md'), 'utf8')).toBe('# hi\n');
  });

  it('lets a dev use the editor', async () => {
    const t = await withChat();
    const dev = await mkUser(t, 'dev1', 'dev');
    expect((await t.call('PUT', '/fs/file', { path: 'README.md', content: 'dev\n' }, bearer(dev.token))).statusCode).toBe(200);
    expect((await t.call('GET', '/code', undefined, bearer(dev.token))).json().terminal).toBe(false);
  });

  it('404s for an unknown chat', async () => {
    const { app } = setupApp();
    expect((await app.inject({ url: '/api/conversations/nope/fs/list', headers: AUTH })).statusCode).toBe(404);
  });
});

describe('code editor: terminals', () => {
  // A "shell" that echoes what it reads, so the test does not depend on the machine's shell.
  const echo = () => new Terminals({ shell: [process.execPath, '-e', 'process.stdin.on("data", (d) => process.stdout.write("got:" + d))'] });

  it('are for admins only, and offered to them', async () => {
    const t = await withChat({ terminals: echo() });
    expect((await t.call('GET', '/code')).json().terminal).toBe(true);
    const dev = await mkUser(t, 'dev2', 'dev');
    expect((await t.call('POST', '/terminals', {}, bearer(dev.token))).statusCode).toBe(403);
    expect((await t.call('GET', '/terminals', undefined, bearer(dev.token))).statusCode).toBe(403);
  });

  it('opens a shell in the chat folder, streams it over a ticketed socket, and closes it', async () => {
    const terminals = echo();
    const t = await withChat({ terminals });
    const created = await t.call('POST', '/terminals', { cols: 90, rows: 20 });
    expect(created.statusCode).toBe(201);
    const term = created.json();
    expect((await t.call('GET', '/terminals')).json()).toMatchObject([{ id: term.id }]);

    // No ticket, a made-up one, or one used twice: refused before the upgrade.
    await t.app.ready();
    await expect(t.app.injectWS('/api/terminals/socket?ticket=nope')).rejects.toThrow();
    const { ticket } = (await t.app.inject({ method: 'POST', url: `/api/terminals/${term.id}/ticket`, headers: AUTH })).json();
    const ws = await t.app.injectWS(`/api/terminals/socket?ticket=${ticket}`);
    await expect(t.app.injectWS(`/api/terminals/socket?ticket=${ticket}`)).rejects.toThrow();

    let out = '';
    ws.on('message', (m: Buffer) => { const msg = JSON.parse(String(m)); if (msg.t === 'o') out += msg.d; });
    ws.send(JSON.stringify({ t: 'i', d: 'hello\r' }));
    await until(() => out.includes('got:hello'));

    expect((await t.app.inject({ method: 'DELETE', url: `/api/terminals/${term.id}`, headers: AUTH })).statusCode).toBe(204);
    expect((await t.call('GET', '/terminals')).json()).toEqual([]);
    ws.terminate();
  });

  it('go with their chat', async () => {
    const terminals = echo();
    const t = await withChat({ terminals });
    await t.call('POST', '/terminals', {});
    expect(terminals.list(t.id)).toHaveLength(1);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/conversations/${t.id}`, headers: AUTH })).statusCode).toBe(204);
    expect(terminals.list(t.id)).toHaveLength(0);
  });

  it('say so when node-pty cannot load', async () => {
    const t = await withChat({ terminals: new Terminals({ load: async () => { throw new Error('no build'); } }) });
    const r = await t.call('POST', '/terminals', {});
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/not available/);
  });
});

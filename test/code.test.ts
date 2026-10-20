import { mkdirSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { badName, globList, searchRegExp } from '../src/code-routes.js';
import { asUser, shellUser, Terminals, userShell } from '../src/terminals.js';
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

describe('code editor: search and replace in files', () => {
  it('finds every match with its line, column and a preview', async () => {
    const { call, dir } = await withChat();
    writeFileSync(join(dir, 'src', 'b.ts'), 'const alpha = 1;\nconst beta = alpha + alpha;\n');
    const r = await call('POST', '/fs/search', { query: 'alpha' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ count: 3, truncated: false, results: [{ path: 'src/b.ts' }] });
    const m = r.json().results[0].matches;
    expect(m.map((x: { line: number; col: number }) => [x.line, x.col])).toEqual([[1, 7], [2, 14], [2, 22]]);
    expect(m[1].preview.slice(m[1].at, m[1].at + m[1].len)).toBe('alpha');
    // Binary files and .git are never searched.
    expect((await call('POST', '/fs/search', { query: 'PNG' })).json().count).toBe(0);
  });

  it('honours case, whole word, regex and the include/exclude globs', async () => {
    const { call, dir } = await withChat();
    writeFileSync(join(dir, 'src', 'b.ts'), 'Foo foo food\n');
    writeFileSync(join(dir, 'notes.md'), 'foo\n');
    const count = async (q: object) => (await call('POST', '/fs/search', q)).json().count;
    expect(await count({ query: 'foo' })).toBe(4);
    expect(await count({ query: 'foo', matchCase: true })).toBe(3);
    expect(await count({ query: 'foo', word: true })).toBe(3);
    expect(await count({ query: 'fo+d?', regex: true, matchCase: true })).toBe(3);
    expect(await count({ query: 'foo', include: 'src/**' })).toBe(3);
    expect(await count({ query: 'foo', exclude: '*.md' })).toBe(3);
    expect(await count({ query: 'a.b' })).toBe(0); // literal unless regex
    expect((await call('POST', '/fs/search', { query: '(', regex: true })).statusCode).toBe(400);
  });

  it('replaces in the files named, literally or with regex groups', async () => {
    const { call, dir } = await withChat();
    writeFileSync(join(dir, 'src', 'b.ts'), 'let x = old(1);\nold(2);\n');
    writeFileSync(join(dir, 'src', 'c.ts'), 'old(3);\n');
    const lit = await call('POST', '/fs/replace', { query: 'old(', replace: 'neu(', paths: ['src/b.ts'] });
    expect(lit.json()).toEqual({ files: 1, replacements: 2 });
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).toBe('let x = neu(1);\nneu(2);\n');
    expect(readFileSync(join(dir, 'src', 'c.ts'), 'utf8')).toBe('old(3);\n'); // not named
    const re = await call('POST', '/fs/replace', { query: 'neu\\((\\d)\\)', regex: true, replace: 'call($1, 0)', paths: ['src/b.ts', '../outside.ts', '.git/x'] });
    expect(re.json()).toEqual({ files: 1, replacements: 2 });
    expect(readFileSync(join(dir, 'src', 'b.ts'), 'utf8')).toBe('let x = call(1, 0);\ncall(2, 0);\n');
  });

  it('replaces nothing in a read-only project or while an agent works there', async () => {
    const ro = await withChat({ sandbox: 'read-only' });
    expect((await ro.call('POST', '/fs/replace', { query: 'hi', replace: 'x', paths: ['README.md'] })).statusCode).toBe(403);
    const busy = await withChat();
    busy.dispatcher.isRunning = () => true;
    expect((await busy.call('POST', '/fs/replace', { query: 'hi', replace: 'x', paths: ['README.md'] })).statusCode).toBe(409);
    expect(readFileSync(join(busy.dir, 'README.md'), 'utf8')).toBe('# hi\n');
  });

  it('turns globs and queries into the right expressions', () => {
    const [ts, src, docs, deep] = [globList('*.ts')[0]!, globList('src/**')[0]!, globList('docs/')[0]!, globList('**/test/*.js')[0]!];
    expect(ts.test('a/b/c.ts')).toBe(true);
    expect(ts.test('c.tsx')).toBe(false);
    expect(src.test('src/a/b.js')).toBe(true);
    expect(src.test('lib/src/b.js')).toBe(false);
    expect(docs.test('docs/x.md')).toBe(true);
    expect(deep.test('test/a.js')).toBe(true);
    expect(deep.test('pkg/test/a.js')).toBe(true);
    expect(globList(' , ')).toEqual([]);
    expect(searchRegExp({ query: 'a.b' }).test('axb')).toBe(false);
    expect(searchRegExp({ query: 'cat', word: true }).test('concat')).toBe(false);
  });
});

describe('code editor: terminals', () => {
  // A "shell" that echoes what it reads, so the test does not depend on the machine's shell.
  const echo = () => new Terminals({ shell: [process.execPath, '-e', 'process.stdin.on("data", (d) => process.stdout.write("got:" + d))'] });

  it('are the owner\'s alone without TERMINAL_USER: admins and devs get none', async () => {
    const t = await withChat({ terminals: echo() });
    expect((await t.call('GET', '/code')).json()).toMatchObject({ terminal: true, terminalAs: 'server' });
    for (const [name, role] of [['dev2', 'dev'], ['adm2', 'admin']] as const) {
      const u = await mkUser(t, name, role);
      expect((await t.call('GET', '/code', undefined, bearer(u.token))).json()).toMatchObject({ terminal: false, terminalAs: null });
      expect((await t.call('POST', '/terminals', {}, bearer(u.token))).statusCode).toBe(403);
      expect((await t.call('GET', '/terminals', undefined, bearer(u.token))).statusCode).toBe(403);
    }
  });

  it('with TERMINAL_USER: admins and devs run as that account, and never see or reach the owner\'s root shells', async () => {
    const terminals = echo();
    Object.defineProperty(terminals, 'userName', { get: () => 'dalang' }); // as on a Linux server with TERMINAL_USER=dalang
    const t = await withChat({ terminals });
    const own = (await t.call('POST', '/terminals', {})).json();
    expect(own.account).not.toBe('dalang'); // the owner's runs as the server's account

    const dev = await mkUser(t, 'dev3', 'dev');
    expect((await t.call('GET', '/code', undefined, bearer(dev.token))).json()).toMatchObject({ terminal: true, terminalAs: 'dalang' });
    expect((await t.call('GET', '/terminals', undefined, bearer(dev.token))).json()).toEqual([]);
    expect((await t.app.inject({ method: 'POST', url: `/api/terminals/${own.id}/ticket`, headers: bearer(dev.token) })).statusCode).toBe(404);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/terminals/${own.id}`, headers: bearer(dev.token) })).statusCode).toBe(404);
    expect(terminals.list(t.id)).toHaveLength(1);
    // What they open goes through the TERMINAL_USER checks (here there is no such account), never to the server's shell.
    const theirs = await t.call('POST', '/terminals', {}, bearer(dev.token));
    if (theirs.statusCode === 201) expect(theirs.json().account).toBe('dalang');
    else expect(theirs.statusCode).toBe(409);
    expect(terminals.list(t.id).filter((x) => x.account !== 'dalang')).toHaveLength(1);
  });

  it('are refused to devs in a read-only project', async () => {
    const terminals = echo();
    Object.defineProperty(terminals, 'userName', { get: () => 'dalang' });
    const t = await withChat({ sandbox: 'read-only', terminals });
    const dev = await mkUser(t, 'dev4', 'dev');
    expect((await t.call('GET', '/code', undefined, bearer(dev.token))).json().terminal).toBe(false);
    expect((await t.call('POST', '/terminals', {}, bearer(dev.token))).statusCode).toBe(403);
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

describe('code editor: terminals as another account (TERMINAL_USER)', () => {
  const passwd = [
    'root:x:0:0:root:/root:/bin/bash',
    'dalang:x:1001:1001::/home/dalang:/bin/bash',
    'svc:x:998:998::/var/lib/svc:/usr/sbin/nologin',
    'ops:x:1002:1002::/home/ops:/bin/zsh',
    'boss:x:1003:27::/home/boss:/bin/bash',
  ].join('\n');
  const group = ['root:x:0:', 'sudo:x:27:ops', 'wheel:x:10:', 'dalang:x:1001:', 'svc:x:998:'].join('\n');
  const files = (sudoers: string[] = []) => ({ passwd, group, sudoers });

  it('finds an ordinary account', () => {
    expect(shellUser('dalang', files())).toEqual({ name: 'dalang', uid: 1001, gid: 1001, home: '/home/dalang', shell: '/bin/bash' });
  });

  it('refuses root, a missing account, and anyone who could use sudo', () => {
    expect(() => shellUser('root', files())).toThrow(/is root/);
    expect(() => shellUser('nobody-here', files())).toThrow(/does not exist/);
    expect(() => shellUser('ops', files())).toThrow(/sudo group/); // a supplementary member
    expect(() => shellUser('boss', files())).toThrow(/sudo group/); // sudo as primary group
    expect(() => shellUser('dalang', files(['# comment\ndalang ALL=(ALL) NOPASSWD: ALL\n']))).toThrow(/sudoers/);
    expect(() => shellUser('dalang', files(['# dalang ALL=(ALL) ALL\n%admins ALL=(ALL) ALL\n']))).not.toThrow();
  });

  it('starts the shell through setpriv with no_new_privs, so sudo can never work there', () => {
    const user = shellUser('dalang', files());
    const cmd = asUser(user, ['/bin/bash', '-l'], '/usr/bin/setpriv');
    expect(cmd[0]).toBe('/usr/bin/setpriv');
    expect(cmd).toContain('--no-new-privs');
    expect(cmd.slice(cmd.indexOf('--'))).toEqual(['--', '/bin/bash', '-l']);
    if (process.getuid?.() !== 1001) expect(cmd).toEqual(expect.arrayContaining(['--reuid=1001', '--regid=1001', '--init-groups']));
    expect(() => asUser(user, ['/bin/bash'], null)).toThrow(/setpriv/); // undefined would look setpriv up on this machine
  });

  it('uses the account\'s login shell, and bash for one without (nologin)', () => {
    expect(userShell(shellUser('dalang', files()), {})).toEqual(['/bin/bash', '-l']);
    expect(userShell(shellUser('svc', files()), {})[0]).toMatch(/\/bin\/(ba)?sh$/);
    expect(userShell(shellUser('dalang', files()), { TERMINAL_SHELL: '/usr/bin/fish' })).toEqual(['/usr/bin/fish']);
  });

  it.skipIf(process.platform !== 'linux')('refuses to open a terminal for an account that may not be used', async () => {
    const t = await withChat({ terminals: new Terminals({ user: 'root' }) });
    const dev = await mkUser(t, 'dev4', 'dev'); // the owner's terminals run as the server's account, never TERMINAL_USER
    const r = await t.call('POST', '/terminals', {}, bearer(dev.token));
    expect(r.statusCode).toBe(409);
    expect(r.json().error).toMatch(/is root/);
  });

  it('is for Linux only: on Windows and macOS shells run as the server user', () => {
    const term = new Terminals({ user: 'dalang' });
    expect(term.userName).toBe(process.platform === 'linux' ? 'dalang' : null);
  });
});

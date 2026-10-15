import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { GitAuth, helperCommand, helperKind, parseAuthStatus, sshTarget } from '../src/git-auth.js';
import { AUTH, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const fakeForge = fileURLToPath(new URL('./fake-forge.mjs', import.meta.url));
const fakeSsh = fileURLToPath(new URL('./fake-ssh.mjs', import.meta.url));

/** An app whose Settings → Git uses a private git config, ~/.ssh and fake gh/glab/ssh. */
function setup(env: Record<string, string> = {}) {
  const t0 = setupApp();
  const dir = join(t0.base, 'git-auth');
  for (const d of ['gh', 'glab', 'ssh']) mkdirSync(join(dir, d), { recursive: true });
  const gitConfig = join(dir, 'gitconfig');
  writeFileSync(gitConfig, '');
  const auth = new GitAuth({
    ghCommand: [process.execPath, fakeForge, join(dir, 'gh')], glabCommand: [process.execPath, fakeForge, join(dir, 'glab')],
    sshDir: join(dir, 'ssh'), sshCommand: [process.execPath, fakeSsh, dir],
    env: { GIT_CONFIG_GLOBAL: gitConfig, GIT_CONFIG_NOSYSTEM: '1', ...env },
  });
  // Panel users' own setups run the same fakes (their gh/glab keep logins in their own config folder).
  const t = setupApp({}, {
    gitAuth: auth, gitSshCommand: [process.execPath, fakeSsh, dir],
    cfg: { ghCommand: [process.execPath, fakeForge, join(dir, 'gh')], glabCommand: [process.execPath, fakeForge, join(dir, 'glab')] },
  });
  const call = (method: string, url: string, payload?: unknown, headers = AUTH) =>
    t.app.inject({ method: method as 'GET', url, headers, ...(payload === undefined ? {} : { payload: payload as object }) });
  const calls = (cli: 'gh' | 'glab') => {
    const f = join(dir, cli, 'calls.log');
    return existsSync(f) ? readFileSync(f, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : [];
  };
  return { ...t, dir, gitConfig, call, calls };
}

describe('parsing the CLIs', () => {
  it('reads gh and glab auth status', () => {
    expect(parseAuthStatus([
      'github.com',
      '  ✓ Logged in to github.com account octo (keyring)',
      '  - Active account: true',
      '  ✓ Logged in to github.com account other (keyring)',
      '  - Active account: false',
      'ghe.example.com',
      '  X Failed to log in to ghe.example.com account bob (default)',
    ].join('\n'))).toEqual([
      { host: 'github.com', user: 'octo', ok: true, active: true },
      { host: 'github.com', user: 'other', ok: true, active: false },
      { host: 'ghe.example.com', user: 'bob', ok: false, active: true },
    ]);
    expect(parseAuthStatus('gitlab.example.com\n  ✓ Logged in to gitlab.example.com as alice (/home/u/.config/glab-cli/config.yml)'))
      .toEqual([{ host: 'gitlab.example.com', user: 'alice', ok: true, active: true }]);
  });

  it('quotes a helper command with spaces for git', () => {
    expect(helperCommand(['glab'], 'auth git-credential')).toBe('!glab auth git-credential');
    expect(helperCommand(['C:\\Program Files\\glab\\glab.exe'], 'auth git-credential')).toBe('!"C:/Program Files/glab/glab.exe" auth git-credential');
  });
});

describe('Settings → Git', () => {
  it('gives every other user their own setup, apart from the server\'s', async () => {
    const t = setup();
    const ann = await mkUser(t, 'ann', 'admin');
    const dev = await mkUser(t, 'dev', 'dev');
    const asAnn = bearer(ann.token);
    const annDir = join(t.cfg.stateDir, 'git-users', ann.id);

    expect((await t.call('GET', '/api/settings/git')).json().scope).toBe('server');
    const mine = (await t.call('GET', '/api/settings/git', undefined, asAnn)).json();
    expect(mine).toMatchObject({ scope: 'user', identity: { name: '', email: '' }, keys: [], aliases: [] });

    // identity: into ann's own global config, not the server's
    await t.call('PUT', '/api/settings/git/identity', { name: 'Ann', email: 'ann@example.com' }, asAnn);
    expect(readFileSync(join(annDir, 'gitconfig'), 'utf8')).toMatch(/ann@example.com/);
    expect(readFileSync(t.gitConfig, 'utf8')).not.toMatch(/ann@example.com/);

    // a forge login: kept in ann's gh folder (and out of the OS keyring), invisible to the owner and to other users
    const r = await t.call('POST', '/api/settings/git/login', { forge: 'github', host: 'github.com', token: 'good-token', https: false }, asAnn);
    expect(r.json().accounts).toEqual([{ host: 'github.com', user: 'octo', ok: true, active: true }]);
    const login = t.calls('gh').find((c) => c.args[1] === 'login');
    expect(login.configDir).toBe(join(annDir, 'gh'));
    expect(login.args).toContain('--insecure-storage');
    expect((await t.call('GET', '/api/settings/git/forges/github')).json().accounts).toEqual([]);
    expect((await t.call('GET', '/api/settings/git/forges/github', undefined, bearer(dev.token))).json().accounts).toEqual([]);

    // an ssh key in ann's folder; an alias names it by its full path
    await t.call('POST', '/api/settings/git/ssh-keys', { name: 'id_ed25519', comment: 'ann' }, asAnn);
    expect(existsSync(join(annDir, 'ssh', 'id_ed25519'))).toBe(true);
    expect(existsSync(join(t.dir, 'ssh', 'id_ed25519'))).toBe(false);

    // deleting the user deletes their setup
    expect((await t.call('DELETE', `/api/users/${ann.id}`)).statusCode).toBe(204);
    expect(existsSync(annDir)).toBe(false);
  });

  it('sets the commit identity in the global git config', async () => {
    const t = setup();
    expect((await t.call('GET', '/api/settings/git')).json().identity).toEqual({ name: '', email: '' });
    const r = await t.call('PUT', '/api/settings/git/identity', { name: 'Octo Cat', email: 'octo@example.com' });
    expect(r.json()).toEqual({ name: 'Octo Cat', email: 'octo@example.com' });
    expect(readFileSync(t.gitConfig, 'utf8')).toMatch(/name = Octo Cat/);
    expect((await t.call('PUT', '/api/settings/git/identity', { name: 'x', email: 'nope' })).statusCode).toBe(400);
    expect((await t.call('PUT', '/api/settings/git/identity', { name: '', email: '' })).json()).toEqual({ name: '', email: '' });
  });

  it('generates an SSH key once, lists it with its fingerprint and tests a host', async () => {
    const t = setup();
    const r = await t.call('POST', '/api/settings/git/ssh-keys', { name: 'id_ed25519', comment: 'dalang@vm' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'id_ed25519', type: 'ssh-ed25519', comment: 'dalang@vm' });
    expect(r.json().fingerprint).toMatch(/^SHA256:/);
    expect(existsSync(join(t.dir, 'ssh', 'id_ed25519'))).toBe(true);
    expect((await t.call('GET', '/api/settings/git')).json().keys.map((k: { name: string }) => k.name)).toEqual(['id_ed25519']);
    // never overwrites, and no path tricks
    expect((await t.call('POST', '/api/settings/git/ssh-keys', { name: 'id_ed25519', comment: '' })).statusCode).toBe(409);
    expect((await t.call('POST', '/api/settings/git/ssh-keys', { name: '../x', comment: '' })).statusCode).toBe(400);

    const ok = (await t.call('POST', '/api/settings/git/ssh-test', { host: 'github.com' })).json();
    expect(ok).toMatchObject({ ok: true, output: expect.stringMatching(/successfully authenticated/) });
    const denied = (await t.call('POST', '/api/settings/git/ssh-test', { host: 'gitlab.com' })).json();
    expect(denied.ok).toBe(false);
    const sshArgs = readFileSync(join(t.dir, 'ssh.log'), 'utf8').trim().split('\n').map((l) => JSON.parse(l))[0];
    expect(sshArgs).toEqual(expect.arrayContaining(['-T', 'BatchMode=yes', 'StrictHostKeyChecking=accept-new', '--', 'git@github.com']));
    expect((await t.call('POST', '/api/settings/git/ssh-test', { host: '-oProxyCommand=x' })).statusCode).toBe(400);
  });

  it('adds and removes SSH aliases without touching the rest of ~/.ssh/config', async () => {
    const t = setup();
    const config = join(t.dir, 'ssh', 'config');
    const mine = 'Host *\n    ServerAliveInterval 60\n\n# work account\nHost github.com-work\n    HostName github.com\n    User git\n    IdentityFile ~/.ssh/id_work\n';
    writeFileSync(config, mine);
    await t.call('POST', '/api/settings/git/ssh-keys', { name: 'id_ed25519_octo', comment: 'octo' });
    expect((await t.call('GET', '/api/settings/git')).json().aliases).toEqual([
      { alias: 'github.com-work', hostName: 'github.com', user: 'git', port: '', identityFile: '~/.ssh/id_work', managed: false },
    ]);

    // outside the real ~/.ssh the alias names the key by its full path
    const key = join(t.dir, 'ssh', 'id_ed25519_octo').replace(/\\/g, '/');
    const r = await t.call('POST', '/api/settings/git/ssh-aliases', { alias: 'github.com-octo', hostName: 'github.com', key: 'id_ed25519_octo' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ alias: 'github.com-octo', hostName: 'github.com', identityFile: key, managed: true });
    expect(readFileSync(config, 'utf8')).toBe(`${mine}\n# Added by Dalang\nHost github.com-octo\n    HostName github.com\n    User git\n    IdentityFile ${key}\n    IdentitiesOnly yes\n`);
    expect((await t.call('POST', '/api/settings/git/ssh-aliases', { alias: 'GitHub.com-Work', hostName: 'github.com', key: 'id_ed25519_octo' })).statusCode).toBe(409);
    expect((await t.call('POST', '/api/settings/git/ssh-aliases', { alias: 'x', hostName: 'github.com', key: 'id_missing' })).statusCode).toBe(404);
    expect((await t.call('POST', '/api/settings/git/ssh-aliases', { alias: 'a*', hostName: 'github.com', key: 'id_ed25519_octo' })).statusCode).toBe(400);

    // removing one leaves the other block, its comment and the wildcard block alone
    expect((await t.call('DELETE', '/api/settings/git/ssh-aliases/github.com-octo')).statusCode).toBe(204);
    expect(readFileSync(config, 'utf8')).toBe(mine);
    expect((await t.call('DELETE', '/api/settings/git/ssh-aliases/github.com-work')).statusCode).toBe(204);
    // only Dalang's own marker goes with a block; a comment someone wrote stays
    expect(readFileSync(config, 'utf8')).toBe('Host *\n    ServerAliveInterval 60\n\n# work account\n');
    expect((await t.call('DELETE', '/api/settings/git/ssh-aliases/nope')).statusCode).toBe(404);
  });

  it('signs gh in with a token on stdin, sets up HTTPS and signs out again', async () => {
    const t = setup();
    expect((await t.call('GET', '/api/settings/git/forges/github')).json()).toMatchObject({ installed: true, accounts: [] });

    const bad = await t.call('POST', '/api/settings/git/login', { forge: 'github', host: 'github.com', token: 'wrong', https: true });
    expect(bad.statusCode).toBe(502);
    expect(bad.json().error).toMatch(/Bad credentials/);

    const r = await t.call('POST', '/api/settings/git/login', { forge: 'github', host: 'github.com', token: 'good-token', https: true });
    expect(r.statusCode).toBe(200);
    expect(r.json().accounts).toEqual([{ host: 'github.com', user: 'octo', ok: true, active: true }]);
    const login = t.calls('gh').find((c) => c.args[1] === 'login' && c.input.trim() === 'good-token');
    expect(login.args).toEqual(['auth', 'login', '--hostname', 'github.com', '--with-token', '--git-protocol', 'https', '--skip-ssh-key']);
    expect(login.leaked).toBeNull();
    expect(t.calls('gh').some((c) => c.args.join(' ') === 'auth setup-git --hostname github.com')).toBe(true);

    const out = await t.call('POST', '/api/settings/git/logout', { forge: 'github', host: 'github.com', user: 'octo' });
    expect(out.json().accounts).toEqual([]);
    expect(t.calls('gh').some((c) => c.args.join(' ') === 'auth logout --hostname github.com --user octo')).toBe(true);
  });

  it('signs glab in and points git over HTTPS at it', async () => {
    const t = setup();
    const r = await t.call('POST', '/api/settings/git/login', { forge: 'gitlab', host: 'gitlab.example.com', token: 'good-token', https: true });
    expect(r.statusCode).toBe(200);
    expect(t.calls('glab')[0].args).toEqual(['auth', 'login', '--hostname', 'gitlab.example.com', '--stdin', '--git-protocol', 'https']);
    const helpers = (await t.call('GET', '/api/settings/git')).json().helpers;
    expect(helpers).toHaveLength(1);
    expect(helpers[0].scope).toBe('https://gitlab.example.com');
    expect(helpers[0].helper).toMatch(/fake-forge\.mjs.* auth git-credential$/);

    await t.call('POST', '/api/settings/git/logout', { forge: 'gitlab', host: 'gitlab.example.com' });
    expect((await t.call('GET', '/api/settings/git')).json().helpers).toEqual([]);
  });

  it('uploads a public key to the account on the right host', async () => {
    const t = setup();
    await t.call('POST', '/api/settings/git/ssh-keys', { name: 'id_ed25519', comment: 'c' });
    const r = await t.call('POST', '/api/settings/git/upload-key', { forge: 'gitlab', host: 'gitlab.example.com', key: 'id_ed25519', title: 'vm' });
    expect(r.statusCode).toBe(200);
    const call = t.calls('glab')[0];
    expect(call.args.slice(0, 2)).toEqual(['ssh-key', 'add']);
    expect(call.args[2]).toBe(join(t.dir, 'ssh', 'id_ed25519.pub'));
    expect(call.args.slice(3)).toEqual(['--title', 'vm']);
    expect(call.host).toBe('gitlab.example.com');
    expect((await t.call('POST', '/api/settings/git/upload-key', { forge: 'github', host: 'github.com', key: 'nope', title: '' })).statusCode).toBe(404);
  });

  it('runs the GitHub browser sign-in and reports the code', async () => {
    const t = setup();
    const r = await t.call('POST', '/api/settings/git/login-web', { host: 'github.com', https: false });
    expect(r.statusCode).toBe(202);
    const { id } = r.json();
    let s: any;
    await until(() => { void t.call('GET', `/api/settings/git/login-web/${id}`).then((x) => { s = x.json(); }); return s?.status === 'success'; });
    expect(s).toMatchObject({ code: 'AB12-CD34', url: 'https://github.com/login/device' });
    expect(t.calls('gh')[0].args).toEqual(expect.arrayContaining(['--web', '--scopes', 'admin:public_key', '--git-protocol', 'ssh']));
    expect((await t.call('GET', '/api/settings/git/forges/github')).json().accounts[0].user).toBe('webuser');
  });

  it('cancels a browser sign-in and allows only one at a time', async () => {
    const t = setup({ FAKE_WEB: 'hang' });
    const { id } = (await t.call('POST', '/api/settings/git/login-web', { host: 'github.com', https: false })).json();
    expect((await t.call('POST', '/api/settings/git/login-web', { host: 'github.com', https: false })).statusCode).toBe(409);
    expect((await t.call('DELETE', `/api/settings/git/login-web/${id}`)).statusCode).toBe(204);
    expect((await t.call('GET', `/api/settings/git/login-web/${id}`)).json().status).toBe('cancelled');
  });

  it('says when a CLI is not installed', async () => {
    const t0 = setupApp();
    const auth = new GitAuth({ ghCommand: ['dalang-no-such-gh'], glabCommand: ['dalang-no-such-glab'], sshDir: join(t0.base, 'ssh') });
    const t = setupApp({}, { gitAuth: auth });
    const s = await t.app.inject({ method: 'GET', url: '/api/settings/git/forges/gitlab', headers: AUTH });
    expect(s.json()).toEqual({ installed: false, accounts: [], output: '' });
    const r = await t.app.inject({ method: 'POST', url: '/api/settings/git/login', headers: AUTH, payload: { forge: 'gitlab', host: 'gitlab.com', token: 't', https: false } });
    expect(r.json().error).toMatch(/glab is not installed/);
  });
});

describe('which credentials a commit and push use', () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  /** A repository with one commit and an `origin`, next to a fake ~/.ssh holding `id_work`. */
  function repo(remote: string) {
    const t = setup();
    const cwd = join(t.dir, 'repo');
    mkdirSync(cwd);
    sh(cwd, 'init', '-q', '-b', 'main');
    sh(cwd, 'config', 'user.name', 'Repo Person');
    sh(cwd, 'config', 'user.email', 'repo@example.com');
    sh(cwd, 'commit', '-q', '--allow-empty', '-m', 'init');
    sh(cwd, 'remote', 'add', 'origin', remote);
    writeFileSync(join(t.dir, 'ssh', 'id_work'), 'private');
    const auth = new GitAuth({
      ghCommand: [process.execPath, fakeForge, join(t.dir, 'gh')], glabCommand: [process.execPath, fakeForge, join(t.dir, 'glab')],
      sshDir: join(t.dir, 'ssh'), sshCommand: [process.execPath, fakeSsh, t.dir], env: { GIT_CONFIG_GLOBAL: t.gitConfig, GIT_CONFIG_NOSYSTEM: '1' },
    });
    return { ...t, cwd, auth };
  }

  it('follows an SSH alias to the real host and the key that exists', async () => {
    const t = repo('git@github.com-work:acme/app.git');
    const c = await t.auth.credentials(t.cwd);
    expect(c).toMatchObject({
      author: { name: 'Repo Person', email: 'repo@example.com', scope: 'local' },
      remote: { name: 'origin', url: 'git@github.com-work:acme/app.git', branch: 'origin/main' },
      transport: 'ssh',
      ssh: { alias: 'github.com-work', hostName: 'github.com', user: 'git', port: '22', keys: ['~/.ssh/id_work'] },
      forge: { forge: 'github', cli: 'gh', host: 'github.com' },
    });
    expect(c.check).toBeUndefined();

    await t.call('POST', '/api/settings/git/login', { forge: 'github', host: 'github.com', token: 'good-token', https: false });
    const checked = await t.auth.credentials(t.cwd, { check: true });
    expect(checked.check).toEqual({
      push: { ok: true, account: 'octo', output: expect.stringMatching(/Hi octo!/) }, forgeAccount: 'octo', forgeInstalled: true,
    });
  });

  it('names the HTTPS credential helper that answers for the remote', async () => {
    const t = repo('https://gitlab.example.com/acme/app.git');
    sh(t.cwd, 'config', 'credential.https://gitlab.example.com.helper', '!glab auth git-credential');
    const c = await t.auth.credentials(t.cwd, { check: true });
    expect(c).toMatchObject({
      transport: 'https',
      https: { host: 'gitlab.example.com', scheme: 'https', helper: '!glab auth git-credential', helperKind: 'glab', username: null },
      forge: { forge: 'gitlab', cli: 'glab', host: 'gitlab.example.com' },
      check: { forgeAccount: null, forgeInstalled: true },
    });
  });

  it('tells a plain http remote apart, and that a helper for https:// does not cover it', async () => {
    const t = repo('http://gitlab.example.com/acme/app.git');
    sh(t.cwd, 'config', 'credential.https://gitlab.example.com.helper', '!glab auth git-credential');
    const c = await t.auth.credentials(t.cwd);
    expect(c.https).toMatchObject({ host: 'gitlab.example.com', scheme: 'http', helper: null });
  });

  it('reports a missing author and a repository without a remote', async () => {
    const t = repo('../elsewhere.git');
    sh(t.cwd, 'remote', 'remove', 'origin');
    sh(t.cwd, 'config', '--unset', 'user.email');
    sh(t.cwd, 'config', '--unset', 'user.name');
    const c = await t.auth.credentials(t.cwd);
    expect(c.remote).toBeNull();
    expect(c.transport).toBeNull();
    if (!c.author) expect(c.authorError).toBeTruthy(); // git may still guess one from the machine
  });

  it('is shown for a chat in its Changes tab, and the forge is asked only on request', async () => {
    const t = setup();
    const proj = join(t.root, 'proj');
    sh(proj, 'init', '-q', '-b', 'main');
    sh(proj, 'config', 'user.name', 'Repo Person');
    sh(proj, 'config', 'user.email', 'repo@example.com');
    sh(proj, 'commit', '-q', '--allow-empty', '-m', 'init');
    sh(proj, 'remote', 'add', 'origin', 'git@github.com:acme/app.git');
    const project = (await t.call('POST', '/api/projects', { name: 'proj', path: 'proj', sandbox: 'workspace-write' })).json();
    const conv = (await t.call('POST', `/api/projects/${project.id}/conversations`, { worktree: false })).json();

    const r = await t.call('GET', `/api/conversations/${conv.id}/git/credentials`);
    expect(r.statusCode).toBe(200);
    expect(r.json()).toMatchObject({ author: { email: 'repo@example.com' }, transport: 'ssh', forge: { cli: 'gh' } });
    expect(r.json().check).toBeUndefined();
    const checked = (await t.call('GET', `/api/conversations/${conv.id}/git/credentials?check=1`)).json();
    expect(checked.check).toMatchObject({ push: { ok: true, account: 'octo' }, forgeAccount: null });
    expect((await t.call('GET', '/api/conversations/nope/git/credentials')).statusCode).toBe(404);

    // The author for this repository only: the global config is left alone, and clearing it falls back to the global one.
    writeFileSync(t.gitConfig, '[user]\n\tname = Global Person\n\temail = global@example.com\n');
    const set = await t.call('PUT', `/api/conversations/${conv.id}/git/identity`, { name: 'Work Me', email: 'me@work.example' });
    expect(set.statusCode).toBe(200);
    expect(set.json()).toMatchObject({ author: { name: 'Work Me', email: 'me@work.example', scope: 'local' }, localAuthor: { name: 'Work Me', email: 'me@work.example' } });
    expect(sh(proj, 'config', '--local', 'user.email')).toBe('me@work.example');
    expect(readFileSync(t.gitConfig, 'utf8')).toMatch(/global@example.com/);
    expect((await t.call('PUT', `/api/conversations/${conv.id}/git/identity`, { name: 'Only Name', email: '' })).statusCode).toBe(400);
    expect((await t.call('PUT', `/api/conversations/${conv.id}/git/identity`, { name: 'X', email: 'nope' })).statusCode).toBe(400);
    const cleared = (await t.call('PUT', `/api/conversations/${conv.id}/git/identity`, { name: '', email: '' })).json();
    expect(cleared).toMatchObject({ author: { email: 'global@example.com', scope: 'global' }, localAuthor: { name: '', email: '' } });
  });

  it('parses SSH remotes and helper kinds', () => {
    expect(sshTarget('git@github.com-work:acme/app.git')).toEqual({ host: 'github.com-work', user: 'git', port: null });
    expect(sshTarget('ssh://git@gitlab.example.com:2222/g/app.git')).toEqual({ host: 'gitlab.example.com', user: 'git', port: '2222' });
    expect(sshTarget('https://github.com/a/b.git')).toBeNull();
    expect(sshTarget('C:\\repos\\app')).toBeNull();
    expect(helperKind("!'C:\\Program Files\\GitHub CLI\\gh.exe' auth git-credential")).toBe('gh');
    expect(helperKind('manager')).toBe('manager');
    expect(helperKind('store --file ~/.creds')).toBe('store');
    expect(helperKind(null)).toBeNull();
  });
});

describe('working as a panel user in a chat', () => {
  const sh = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  /** A repository whose own config names the owner as author, a project on it, and one chat. */
  async function chatRepo() {
    const t = setup();
    const repo = join(t.root, 'proj');
    sh(repo, 'init', '-q', '-b', 'main');
    sh(repo, 'config', 'user.name', 'Owner Person');
    sh(repo, 'config', 'user.email', 'owner@example.com');
    sh(repo, 'config', 'core.autocrlf', 'false');
    sh(repo, 'commit', '-q', '--allow-empty', '-m', 'init');
    const project = (await t.call('POST', '/api/projects', { name: 'proj', path: 'proj', sandbox: 'workspace-write' })).json();
    const conv = (await t.call('POST', `/api/projects/${project.id}/conversations`, { worktree: false })).json();
    const dev = await mkUser(t, 'dev', 'dev');
    let n = 0;
    const commitAs = (headers: { authorization: string }) => {
      writeFileSync(join(repo, `f${++n}.txt`), `${n}\n`);
      return t.call('POST', `/api/conversations/${conv.id}/git/commit`, { message: `change ${n}` }, headers);
    };
    const lastAuthor = () => sh(repo, 'log', '-1', '--format=%an <%ae> / %cn');
    return { ...t, repo, project, conv, dev, commitAs, lastAuthor };
  }

  it('commits as whoever clicks, never as the repository\'s own author', async () => {
    const t = await chatRepo();
    const asDev = bearer(t.dev.token);

    // no author of their own yet: refused rather than committed as the owner
    const refused = await t.commitAs(asDev);
    expect(refused.statusCode).toBe(400);
    expect(sh(t.repo, 'log', '--format=%s')).toBe('init');
    expect((await t.call('GET', `/api/conversations/${t.conv.id}/git/credentials`, undefined, asDev)).json())
      .toMatchObject({ author: null, authorError: expect.stringMatching(/Settings/) });

    await t.call('PUT', '/api/settings/git/identity', { name: 'Dev Person', email: 'dev@example.com' }, asDev);
    expect((await t.commitAs(asDev)).statusCode).toBe(200);
    expect(t.lastAuthor()).toBe('Dev Person <dev@example.com> / Dev Person');

    // the owner keeps the server's setup, here the repository's own author
    expect((await t.commitAs(AUTH)).statusCode).toBe(200);
    expect(t.lastAuthor()).toBe('Owner Person <owner@example.com> / Owner Person');
  });

  it('keeps a user\'s author for one project in Dalang, out of the repository config', async () => {
    const t = await chatRepo();
    const asDev = bearer(t.dev.token);
    await t.call('PUT', '/api/settings/git/identity', { name: 'Dev Person', email: 'dev@example.com' }, asDev);
    const set = await t.call('PUT', `/api/conversations/${t.conv.id}/git/identity`, { name: 'Dev At Work', email: 'dev@work.example' }, asDev);
    expect(set.json()).toMatchObject({ author: { name: 'Dev At Work', email: 'dev@work.example', scope: 'local' }, localAuthor: { name: 'Dev At Work' } });
    expect(sh(t.repo, 'config', '--local', 'user.email')).toBe('owner@example.com'); // untouched
    await t.commitAs(asDev);
    expect(t.lastAuthor()).toBe('Dev At Work <dev@work.example> / Dev At Work');

    const cleared = (await t.call('PUT', `/api/conversations/${t.conv.id}/git/identity`, { name: '', email: '' }, asDev)).json();
    expect(cleared.author).toMatchObject({ email: 'dev@example.com', scope: 'global' });
    // the owner's card still shows the server's view
    expect((await t.call('GET', `/api/conversations/${t.conv.id}/git/credentials`)).json().author).toMatchObject({ email: 'owner@example.com', scope: 'local' });
  });

  it('gives agent turns the git setup of the user they run for', async () => {
    const t = await chatRepo();
    const env = (name: string) => t.dispatcher.gitEnvFor!(name, t.project.id);
    expect(env('owner')).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' });
    const dev = env('dev');
    expect(dev.GIT_CONFIG_GLOBAL).toBe(join(t.cfg.stateDir, 'git-users', t.dev.id, 'gitconfig'));
    expect(dev.GH_CONFIG_DIR).toBe(join(t.cfg.stateDir, 'git-users', t.dev.id, 'gh'));
    expect(dev.GIT_SSH_COMMAND).toMatch(/IdentitiesOnly=yes/);
    expect(dev.GIT_SSH_COMMAND).toMatch(/\.no-key/); // no keys yet: never the server's ~/.ssh/id_*
    expect(dev.GIT_AUTHOR_NAME).toBe('');
    // nobody known (an old queue row) or a deleted user: no credentials at all
    expect(env('').GIT_CONFIG_GLOBAL).toMatch(/_nobody/);
    expect(env('ghost').GIT_CONFIG_GLOBAL).toMatch(/_nobody/);

    // a queued prompt runs for its author unless it says otherwise
    const q = t.store.enqueue(t.conv.id, 'hi', [], 'dev');
    expect(t.store.listQueue(t.conv.id).find((i) => i.id === q)?.on_behalf).toBe('dev');
    const q2 = t.store.enqueue(t.conv.id, 'from an agent', [], '', 'dev');
    expect(t.store.listQueue(t.conv.id).find((i) => i.id === q2)).toMatchObject({ author: '', on_behalf: 'dev' });
  });
});

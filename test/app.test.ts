import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { sessionHash } from '../src/auth.js';
import { AUTH, turnsDone, until } from './helpers.js';
import { mkUser, setupApp } from './setup-app.js';

async function makeConv(t: ReturnType<typeof setupApp>) {
  const p = await t.app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'proj', path: 'proj' } });
  const c = await t.app.inject({ method: 'POST', url: `/api/projects/${p.json().id}/conversations`, headers: AUTH });
  return { project: p.json(), conv: c.json() };
}

describe('auth', () => {
  it('rejects missing and wrong tokens', async () => {
    const { app } = setupApp();
    expect((await app.inject({ url: '/api/projects' })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/projects', headers: { authorization: 'Bearer nope' } })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/projects', headers: AUTH })).statusCode).toBe(200);
  });
});

describe('auth rate limit', () => {
  it('blocks an address after too many wrong tokens, even if the next token is right', async () => {
    const { app } = setupApp({}, { authMaxFailures: 3 });
    const bad = { authorization: 'Bearer wrong' };
    for (let i = 0; i < 3; i++) expect((await app.inject({ url: '/api/projects', headers: bad })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/projects', headers: bad })).statusCode).toBe(429);
    expect((await app.inject({ url: '/api/projects', headers: AUTH })).statusCode).toBe(429);
  });

  it('does not count successful requests', async () => {
    const { app } = setupApp({}, { authMaxFailures: 3 });
    for (let i = 0; i < 10; i++) expect((await app.inject({ url: '/api/projects', headers: AUTH })).statusCode).toBe(200);
  });
});

describe('auth rate limit behind a reverse proxy', () => {
  const via = (spoofed: string, real: string, token = 'wrong') => ({ 'x-forwarded-for': `${spoofed}, ${real}`, authorization: `Bearer ${token}` });

  it('keys on the address the proxy saw, so a forged X-Forwarded-For prefix neither evades nor frames anyone', async () => {
    const { app } = setupApp({}, { authMaxFailures: 3, cfg: { trustProxy: ['127.0.0.1'] } });
    for (let i = 0; i < 3; i++) await app.inject({ url: '/api/projects', headers: via(`10.0.0.${i}`, '5.5.5.5') });
    // rotating the forged prefix does not reset the attacker's counter
    expect((await app.inject({ url: '/api/projects', headers: via('10.9.9.9', '5.5.5.5') })).statusCode).toBe(429);
    // the owner, seen by the proxy at another address, is fine even while claiming the attacker's address first
    const owner = { ...AUTH, 'x-forwarded-for': '5.5.5.5, 7.7.7.7' };
    expect((await app.inject({ url: '/api/projects', headers: owner })).statusCode).toBe(200);
  });
});

describe('accounts', () => {
  it('lists accounts and unblocks them', async () => {
    const t = setupApp();
    const home = t.dispatcher.accounts.homes[0]!;
    t.dispatcher.accounts.block(home);
    const list = await t.app.inject({ url: '/api/accounts', headers: AUTH });
    expect(list.json()).toEqual([{ name: expect.any(String), blockedUntil: expect.any(Number), loggedIn: false, enabled: true, limits: null }]);
    expect((await t.app.inject({ method: 'POST', url: '/api/accounts/unblock', headers: AUTH })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/accounts', headers: AUTH })).json()[0].blockedUntil).toBeNull();
  });
});

describe('with no Codex account yet', () => {
  it('lists nothing instead of failing', async () => {
    const t = setupApp({}, { homes: [] });
    expect((await t.app.inject({ url: '/api/accounts', headers: AUTH })).json()).toEqual([]);
    expect((await t.app.inject({ method: 'POST', url: '/api/accounts/unblock', headers: AUTH })).statusCode).toBe(204);
  });

  it('lets an admin add the first one from the panel', async () => {
    const t = setupApp({}, { homes: [] });
    const started = await t.app.inject({ method: 'POST', url: '/api/accounts/login', headers: AUTH, payload: { name: 'main' } });
    expect(started.statusCode).toBe(202);
    await until(() => t.logins.get(started.json().id)!.status === 'success');
    const list = (await t.app.inject({ url: '/api/accounts', headers: AUTH })).json();
    expect(list).toEqual([{ name: 'main', blockedUntil: null, loggedIn: true, enabled: true, limits: null }]);
  });
});

describe('adding accounts from the panel', () => {
  const login = (t: ReturnType<typeof setupApp>, name: string, headers: Record<string, string> = AUTH) =>
    t.app.inject({ method: 'POST', url: '/api/accounts/login', headers, payload: { name } });

  it('walks through a device login and lists the new account as logged in', async () => {
    const t = setupApp();
    const started = await login(t, 'second');
    expect(started.statusCode).toBe(202);
    const id = started.json().id;
    await until(() => t.logins.get(id)!.status === 'success');

    const state = (await t.app.inject({ url: `/api/accounts/login/${id}`, headers: AUTH })).json();
    expect(state).toMatchObject({ name: 'second', status: 'success', url: 'https://auth.example.test/device', code: 'ABCD-1234' });

    const list = (await t.app.inject({ url: '/api/accounts', headers: AUTH })).json();
    expect(list.map((a: { name: string }) => a.name)).toEqual(['home', 'second']);
    expect(list[1]).toMatchObject({ loggedIn: true, blockedUntil: null });
    expect(list[0]).toMatchObject({ loggedIn: false });
  });

  it('is for admins only: a dev cannot link new accounts, an admin (including an owner session) can', async () => {
    const t = setupApp();
    const dev = { authorization: `Bearer ${(await mkUser(t, 'budi', 'dev')).token}` };
    expect((await login(t, 'x', dev)).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/accounts/login/anything', headers: dev })).statusCode).toBe(403);
    expect((await t.app.inject({ method: 'DELETE', url: '/api/accounts/login/anything', headers: dev })).statusCode).toBe(403);
    expect((await t.app.inject({ url: '/api/accounts', headers: dev })).statusCode).toBe(200); // reading is fine

    t.store.createSession(sessionHash('owner-session'), Date.now() + 60_000); // owner signed in by email
    const bad = await login(t, '../x', { authorization: 'Bearer owner-session' });
    expect(bad.statusCode).toBe(400); // got past the permission check, then failed name validation
    expect((await login(t, 'x', {})).statusCode).toBe(401);
  });

  it('rejects bad or taken names and only runs one login at a time', async () => {
    const t = setupApp({}, { loginEnv: { FAKE_LOGIN: 'hang' } });
    expect((await login(t, '../etc')).statusCode).toBe(400);
    expect((await login(t, 'home')).statusCode).toBe(409); // the existing account is called "home"
    expect((await t.app.inject({ method: 'POST', url: '/api/accounts/login', headers: AUTH, payload: {} })).statusCode).toBe(400);
    const first = await login(t, 'one');
    expect(first.statusCode).toBe(202);
    expect((await login(t, 'two')).statusCode).toBe(409);
    const cancel = await t.app.inject({ method: 'DELETE', url: `/api/accounts/login/${first.json().id}`, headers: AUTH });
    expect(cancel.statusCode).toBe(204);
    expect((await t.app.inject({ url: `/api/accounts/login/${first.json().id}`, headers: AUTH })).json().status).toBe('cancelled');
    expect((await t.app.inject({ method: 'DELETE', url: `/api/accounts/login/${first.json().id}`, headers: AUTH })).statusCode).toBe(404);
    expect((await t.app.inject({ url: '/api/accounts/login/nope', headers: AUTH })).statusCode).toBe(404);
  });
});

describe('projects', () => {
  it('creates, lists and deletes a project inside the workspace', async () => {
    const { app } = setupApp();
    const created = await app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'proj', path: 'proj' } });
    expect(created.statusCode).toBe(201);
    expect(created.json().path).toContain('proj');
    const list = await app.inject({ url: '/api/projects', headers: AUTH });
    expect(list.json()).toHaveLength(1);
    const del = await app.inject({ method: 'DELETE', url: `/api/projects/${created.json().id}`, headers: AUTH });
    expect(del.statusCode).toBe(204);
    expect((await app.inject({ method: 'DELETE', url: `/api/projects/${created.json().id}`, headers: AUTH })).statusCode).toBe(404);
  });

  it('rejects paths outside the workspace and invalid bodies', async () => {
    const { app } = setupApp();
    for (const path of ['..', '../x', '/', 'missing']) {
      const r = await app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'n', path } });
      expect(r.statusCode, path).toBe(400);
    }
    const bad = await app.inject({ method: 'POST', url: '/api/projects', headers: AUTH, payload: { name: 'n', path: 'proj', sandbox: 'root' } });
    expect(bad.statusCode).toBe(400);
  });
});

describe('conversations and prompts', () => {
  it('404s for an unknown project', async () => {
    const { app } = setupApp();
    const r = await app.inject({ method: 'POST', url: '/api/projects/nope/conversations', headers: AUTH });
    expect(r.statusCode).toBe(404);
  });

  it('runs a prompt end to end', async () => {
    const t = setupApp();
    const { conv } = await makeConv(t);
    const r = await t.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/prompts`, headers: AUTH, payload: { prompt: 'hello' } });
    expect(r.statusCode).toBe(202);
    await until(() => turnsDone(t.store, conv.id, 1));
    const got = await t.app.inject({ url: `/api/conversations/${conv.id}`, headers: AUTH });
    expect(got.json()).toMatchObject({ status: 'idle', turns: [{ prompt: 'hello', status: 'completed' }] });
  });

  it('rejects an empty prompt and attachments outside uploads', async () => {
    const t = setupApp();
    const { conv } = await makeConv(t);
    const url = `/api/conversations/${conv.id}/prompts`;
    expect((await t.app.inject({ method: 'POST', url, headers: AUTH, payload: { prompt: '' } })).statusCode).toBe(400);
    const r = await t.app.inject({ method: 'POST', url, headers: AUTH, payload: { prompt: 'x', attachments: [t.root] } });
    expect(r.statusCode).toBe(400);
    expect(t.store.listQueue(conv.id)).toEqual([]);
    // the uploads folder itself is inside the allowed root but is not a file
    const dir = await t.app.inject({ method: 'POST', url, headers: AUTH, payload: { prompt: 'x', attachments: [join(t.cfg.stateDir, 'uploads')] } });
    expect(dir.statusCode).toBe(400);
  });

  it('lists and removes queued prompts, and cancels the running one', async () => {
    const t = setupApp({ FAKE_MODE: 'slow' });
    const { conv } = await makeConv(t);
    const url = `/api/conversations/${conv.id}`;
    await t.app.inject({ method: 'POST', url: `${url}/prompts`, headers: AUTH, payload: { prompt: 'first' } });
    const second = await t.app.inject({ method: 'POST', url: `${url}/prompts`, headers: AUTH, payload: { prompt: 'second' } });
    const q = await t.app.inject({ url: `${url}/queue`, headers: AUTH });
    expect(q.json().map((i: { prompt: string }) => i.prompt)).toEqual(['second']);
    const del = await t.app.inject({ method: 'DELETE', url: `/api/queue/${second.json().queueId}`, headers: AUTH });
    expect(del.statusCode).toBe(204);
    expect((await t.app.inject({ method: 'DELETE', url: `/api/queue/${second.json().queueId}`, headers: AUTH })).statusCode).toBe(404);
    await until(() => t.store.eventsAfter(conv.id, 0).some((e) => e.type === 'turn.started'));
    const c = await t.app.inject({ method: 'POST', url: `${url}/cancel`, headers: AUTH });
    expect(c.json()).toEqual({ cancelled: true });
    await until(() => turnsDone(t.store, conv.id, 1));
  });

  it('clears the saved draft when the prompt is sent, so it cannot reappear in the composer', async () => {
    const t = setupApp();
    const { conv } = await makeConv(t);
    await t.app.inject({ method: 'PUT', url: `/api/conversations/${conv.id}/draft`, headers: AUTH, payload: { draft: 'about to send' } });
    await t.app.inject({ method: 'POST', url: `/api/conversations/${conv.id}/prompts`, headers: AUTH, payload: { prompt: 'about to send' } });
    expect(t.store.getConversation(conv.id)!.draft).toBe('');
  });

  it('saves the draft', async () => {
    const t = setupApp();
    const { conv } = await makeConv(t);
    const url = `/api/conversations/${conv.id}`;
    expect((await t.app.inject({ method: 'PUT', url: `${url}/draft`, headers: AUTH, payload: { draft: 'wip' } })).statusCode).toBe(204);
    expect((await t.app.inject({ url, headers: AUTH })).json().draft).toBe('wip');
  });
});

describe('model choice', () => {
  it('stores a model per chat and refuses values that could be read as flags', async () => {
    const t = setupApp();
    const { conv } = await makeConv(t);
    const put = (model: string) => t.app.inject({ method: 'PUT', url: `/api/conversations/${conv.id}/model`, headers: AUTH, payload: { model } });
    expect((await put('gpt-5-codex')).statusCode).toBe(204);
    expect(t.store.getConversation(conv.id)!.model).toBe('gpt-5-codex');
    expect((await put('--dangerously-bypass-approvals-and-sandbox')).statusCode).toBe(400);
    expect((await put('')).statusCode).toBe(204);
    expect(t.store.getConversation(conv.id)!.model).toBe('');
  });
});

describe('model list', () => {
  it('answers with a list even when Codex cannot report its models', async () => {
    const t = setupApp();
    const r = await t.app.inject({ url: '/api/models', headers: AUTH });
    expect(r.statusCode).toBe(200);
    expect(Array.isArray(r.json())).toBe(true);
  });
});

describe('deleting a chat', () => {
  it('removes only that chat, not its project or siblings', async () => {
    const t = setupApp();
    const { project, conv } = await makeConv(t);
    const other = (await t.app.inject({ method: 'POST', url: `/api/projects/${project.id}/conversations`, headers: AUTH })).json();
    const del = (id: string) => t.app.inject({ method: 'DELETE', url: `/api/conversations/${id}`, headers: AUTH });
    expect((await del(conv.id)).statusCode).toBe(204);
    expect((await del(conv.id)).statusCode).toBe(404);
    const left = (await t.app.inject({ url: `/api/projects/${project.id}/conversations`, headers: AUTH })).json();
    expect(left.map((c: { id: string }) => c.id)).toEqual([other.id]);
  });
});

describe('reasoning effort', () => {
  it('stores an effort per chat and refuses unknown values', async () => {
    const t = setupApp();
    const { conv } = await makeConv(t);
    const put = (effort: string) => t.app.inject({ method: 'PUT', url: `/api/conversations/${conv.id}/effort`, headers: AUTH, payload: { effort } });
    expect((await put('xhigh')).statusCode).toBe(204);
    expect(t.store.getConversation(conv.id)!.effort).toBe('xhigh');
    expect((await put('x"y')).statusCode).toBe(400);
    expect((await put('')).statusCode).toBe(204);
    expect(t.store.getConversation(conv.id)!.effort).toBe('');
  });
});

describe('removing an account', () => {
  it('is admin only, deletes a panel account, and 404s on one that is not', async () => {
    const t = setupApp();
    const id = (await t.app.inject({ method: 'POST', url: '/api/accounts/login', headers: AUTH, payload: { name: 'second' } })).json().id;
    await until(() => t.logins.get(id)!.status === 'success');
    const del = (name: string, headers = AUTH) => t.app.inject({ method: 'DELETE', url: `/api/accounts/${name}`, headers });

    const dev = { authorization: `Bearer ${(await mkUser(t, 'budi', 'dev')).token}` };
    expect((await del('second', dev)).statusCode).toBe(403);
    expect((await del('nope')).statusCode).toBe(404);
    expect((await del('second')).statusCode).toBe(204);
    const names = (await t.app.inject({ url: '/api/accounts', headers: AUTH })).json().map((a: { name: string }) => a.name);
    expect(names).not.toContain('second');
  });
});

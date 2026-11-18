import { describe, expect, it } from 'vitest';
import { AUTH, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

type T = ReturnType<typeof setupApp>;
const call = (t: T, method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, headers, payload: payload as object | undefined });

describe('users', () => {
  it('creates a user, and shows the personal token only once', async () => {
    const t = setupApp();
    const r = await call(t, 'POST', '/api/users', AUTH, { name: 'budi' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'budi', token: expect.stringMatching(/^[0-9a-f]{64}$/) });
    expect(r.json()).not.toHaveProperty('role');

    const list = (await call(t, 'GET', '/api/users', AUTH)).json();
    expect(list).toEqual([{ id: expect.any(String), name: 'budi', email: null, createdAt: expect.any(String) }]);
    expect(JSON.stringify(list)).not.toContain(r.json().token);
    // the database keeps a hash, never the token itself
    expect(JSON.stringify(t.store.db.prepare('SELECT * FROM users').all())).not.toContain(r.json().token);
  });

  it('ignores a role (users have none), rejects bad or reserved names, and duplicates', async () => {
    const t = setupApp();
    const withRole = await call(t, 'POST', '/api/users', AUTH, { name: 'a', role: 'admin' });
    expect(withRole.statusCode).toBe(201);
    expect(withRole.json()).not.toHaveProperty('role');
    expect((await call(t, 'POST', '/api/users', AUTH, {})).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'A B' })).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: '../x' })).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'owner' })).statusCode).toBe(409);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'budi' })).statusCode).toBe(201);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'budi' })).statusCode).toBe(409);
  });

  it('tells each caller who they are', async () => {
    const t = setupApp();
    const budi = await mkUser(t, 'budi');
    expect((await call(t, 'GET', '/api/me', AUTH)).json()).toEqual({ name: 'owner', main: true });
    expect((await call(t, 'GET', '/api/me', bearer(budi.token))).json()).toEqual({ name: 'budi', main: false });
    expect((await call(t, 'GET', '/api/me', {})).statusCode).toBe(401);
  });

  it('lets any user manage users', async () => {
    const t = setupApp();
    const budi = await mkUser(t, 'budi');
    const made = await call(t, 'POST', '/api/users', bearer(budi.token), { name: 'x' });
    expect(made.statusCode).toBe(201);
    expect((await call(t, 'GET', '/api/users', bearer(budi.token))).json().map((u: { name: string }) => u.name)).toEqual(['budi', 'x']);
    expect((await call(t, 'DELETE', `/api/users/${made.json().id}`, bearer(budi.token))).statusCode).toBe(204);
  });

  it('rotating a token kills the old one and the user\'s sessions', async () => {
    const t = setupApp();
    const budi = await mkUser(t, 'budi');
    t.store.createSession('sess-hash', Date.now() + 60_000, budi.id);
    const r = await call(t, 'POST', `/api/users/${budi.id}/token`, AUTH);
    expect(r.statusCode).toBe(200);
    const fresh = r.json().token as string;
    expect(fresh).not.toBe(budi.token);
    expect((await call(t, 'GET', '/api/me', bearer(budi.token))).statusCode).toBe(401);
    expect((await call(t, 'GET', '/api/me', bearer(fresh))).statusCode).toBe(200);
    expect(t.store.hasSession('sess-hash', Date.now())).toBe(false);
    expect((await call(t, 'POST', '/api/users/nope/token', AUTH)).statusCode).toBe(404);
  });

  it('changes an email, and no longer a role', async () => {
    const t = setupApp();
    const budi = await mkUser(t, 'budi');
    expect((await call(t, 'PATCH', `/api/users/${budi.id}`, AUTH, { email: 'budi@example.com' })).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/users', AUTH)).json()[0].email).toBe('budi@example.com');
    expect((await call(t, 'PATCH', `/api/users/${budi.id}`, AUTH, { role: 'admin' })).statusCode).toBe(400);
    expect((await call(t, 'PATCH', `/api/users/${budi.id}`, AUTH, {})).statusCode).toBe(400);
    expect((await call(t, 'PATCH', '/api/users/nope', AUTH, { email: '' })).statusCode).toBe(404);
  });

  it('deleting a user ends their access, including sessions', async () => {
    const t = setupApp();
    const budi = await mkUser(t, 'budi');
    t.store.createSession('sess-hash', Date.now() + 60_000, budi.id);
    expect((await call(t, 'DELETE', `/api/users/${budi.id}`, AUTH)).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/me', bearer(budi.token))).statusCode).toBe(401);
    expect(t.store.hasSession('sess-hash', Date.now())).toBe(false);
    expect((await call(t, 'DELETE', `/api/users/${budi.id}`, AUTH)).statusCode).toBe(404);
  });

  it('a user can remove their own account without locking the owner out', async () => {
    const t = setupApp();
    const sari = await mkUser(t, 'sari');
    expect((await call(t, 'DELETE', `/api/users/${sari.id}`, bearer(sari.token))).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/users', AUTH)).json()).toEqual([]); // the main token still works
  });
});

describe('what a user may do', () => {
  async function world() {
    const t = setupApp();
    const user = await mkUser(t, 'budi');
    const proj = (await call(t, 'POST', '/api/projects', AUTH, { name: 'proj', path: 'proj' })).json();
    const conv = (await call(t, 'POST', `/api/projects/${proj.id}/conversations`, AUTH)).json();
    return { t, user: bearer(user.token), proj, conv };
  }

  it('is refused none of the routes that were once for admins', async () => {
    const { t, user, proj } = await world();
    const onceAdminOnly: [string, string, unknown?][] = [
      ['POST', '/api/projects', { name: 'x', path: 'proj' }],
      ['POST', '/api/accounts/unblock'],
      ['POST', '/api/accounts/login', { name: 'x' }],
      ['GET', '/api/accounts/login/abc'],
      ['DELETE', '/api/accounts/login/abc'],
      ['GET', '/api/approvals'],
      ['POST', '/api/approvals/1/approve'],
      ['POST', '/api/approvals/1/reject'],
      ['GET', '/api/users'],
      ['POST', '/api/users', { name: 'zed' }],
      ['PATCH', '/api/users/abc', { email: '' }],
      ['POST', '/api/users/abc/token'],
      ['DELETE', '/api/users/abc'],
      ['DELETE', `/api/projects/${proj.id}`],
    ];
    for (const [method, url, body] of onceAdminOnly) {
      expect((await call(t, method, url, user, body)).statusCode, `${method} ${url}`).not.toBe(403);
    }
    expect(t.store.getProject(proj.id)).toBeNull(); // the last of them removed it
  });

  it('can do the everyday work: chat, queue, cancel, draft, files, notifications', async () => {
    const { t, user, proj, conv } = await world();
    expect((await call(t, 'GET', '/api/projects', user)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/projects/${proj.id}/conversations`, user)).statusCode).toBe(200);
    expect((await call(t, 'POST', `/api/projects/${proj.id}/conversations`, user)).statusCode).toBe(201);
    const sent = await call(t, 'POST', `/api/conversations/${conv.id}/prompts`, user, { prompt: 'hello' });
    expect(sent.statusCode).toBe(202);
    await until(() => t.store.listTurns(conv.id).some((x) => x.status === 'completed'));
    expect((await call(t, 'GET', `/api/conversations/${conv.id}`, user)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/conversations/${conv.id}/queue`, user)).statusCode).toBe(200);
    expect((await call(t, 'POST', `/api/conversations/${conv.id}/cancel`, user)).statusCode).toBe(200);
    expect((await call(t, 'PUT', `/api/conversations/${conv.id}/draft`, user, { draft: 'x' })).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/accounts', user)).statusCode).toBe(200);
    expect((await call(t, 'GET', '/api/push/key', user)).statusCode).toBe(200);
  });

});

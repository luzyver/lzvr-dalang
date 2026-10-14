import { describe, expect, it } from 'vitest';
import { AUTH, until } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

type T = ReturnType<typeof setupApp>;
const call = (t: T, method: string, url: string, headers: Record<string, string>, payload?: unknown) =>
  t.app.inject({ method: method as 'GET', url, headers, payload: payload as object | undefined });

describe('users', () => {
  it('lets an admin create a user, and shows the personal token only once', async () => {
    const t = setupApp();
    const r = await call(t, 'POST', '/api/users', AUTH, { name: 'budi', role: 'dev' });
    expect(r.statusCode).toBe(201);
    expect(r.json()).toMatchObject({ name: 'budi', role: 'dev', token: expect.stringMatching(/^[0-9a-f]{64}$/) });

    const list = (await call(t, 'GET', '/api/users', AUTH)).json();
    expect(list).toEqual([{ id: expect.any(String), name: 'budi', role: 'dev', email: null, createdAt: expect.any(String) }]);
    expect(JSON.stringify(list)).not.toContain(r.json().token);
    // the database keeps a hash, never the token itself
    expect(JSON.stringify(t.store.db.prepare('SELECT * FROM users').all())).not.toContain(r.json().token);
  });

  it('rejects bad roles, bad or reserved names, and duplicates', async () => {
    const t = setupApp();
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'a', role: 'root' })).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'A B', role: 'dev' })).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: '../x', role: 'dev' })).statusCode).toBe(400);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'owner', role: 'dev' })).statusCode).toBe(409);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'budi', role: 'dev' })).statusCode).toBe(201);
    expect((await call(t, 'POST', '/api/users', AUTH, { name: 'budi', role: 'admin' })).statusCode).toBe(409);
  });

  it('tells each caller who they are', async () => {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    const admin = await mkUser(t, 'sari', 'admin');
    expect((await call(t, 'GET', '/api/me', AUTH)).json()).toEqual({ name: 'owner', role: 'admin', main: true });
    expect((await call(t, 'GET', '/api/me', bearer(dev.token))).json()).toEqual({ name: 'budi', role: 'dev', main: false });
    expect((await call(t, 'GET', '/api/me', bearer(admin.token))).json()).toEqual({ name: 'sari', role: 'admin', main: false });
    expect((await call(t, 'GET', '/api/me', {})).statusCode).toBe(401);
  });

  it('lets an admin user manage users, but not a dev', async () => {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    const admin = await mkUser(t, 'sari', 'admin');
    expect((await call(t, 'POST', '/api/users', bearer(dev.token), { name: 'x', role: 'dev' })).statusCode).toBe(403);
    expect((await call(t, 'POST', '/api/users', bearer(admin.token), { name: 'x', role: 'dev' })).statusCode).toBe(201);
  });

  it('rotating a token kills the old one and the user\'s sessions', async () => {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    t.store.createSession('sess-hash', Date.now() + 60_000, dev.id);
    const r = await call(t, 'POST', `/api/users/${dev.id}/token`, AUTH);
    expect(r.statusCode).toBe(200);
    const fresh = r.json().token as string;
    expect(fresh).not.toBe(dev.token);
    expect((await call(t, 'GET', '/api/me', bearer(dev.token))).statusCode).toBe(401);
    expect((await call(t, 'GET', '/api/me', bearer(fresh))).statusCode).toBe(200);
    expect(t.store.hasSession('sess-hash', Date.now())).toBe(false);
    expect((await call(t, 'POST', '/api/users/nope/token', AUTH)).statusCode).toBe(404);
  });

  it('changes a role, with immediate effect', async () => {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    expect((await call(t, 'GET', '/api/users', bearer(dev.token))).statusCode).toBe(403);
    expect((await call(t, 'PATCH', `/api/users/${dev.id}`, AUTH, { role: 'admin' })).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/users', bearer(dev.token))).statusCode).toBe(200);
    expect((await call(t, 'PATCH', `/api/users/${dev.id}`, AUTH, { role: 'god' })).statusCode).toBe(400);
    expect((await call(t, 'PATCH', '/api/users/nope', AUTH, { role: 'dev' })).statusCode).toBe(404);
  });

  it('deleting a user ends their access, including sessions', async () => {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    t.store.createSession('sess-hash', Date.now() + 60_000, dev.id);
    expect((await call(t, 'DELETE', `/api/users/${dev.id}`, AUTH)).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/me', bearer(dev.token))).statusCode).toBe(401);
    expect(t.store.hasSession('sess-hash', Date.now())).toBe(false);
    expect((await call(t, 'DELETE', `/api/users/${dev.id}`, AUTH)).statusCode).toBe(404);
  });

  it('an admin can remove their own account without locking the owner out', async () => {
    const t = setupApp();
    const admin = await mkUser(t, 'sari', 'admin');
    expect((await call(t, 'DELETE', `/api/users/${admin.id}`, bearer(admin.token))).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/users', AUTH)).json()).toEqual([]); // the main token still works
  });
});

describe('what a dev may do', () => {
  async function world() {
    const t = setupApp();
    const dev = await mkUser(t, 'budi', 'dev');
    const admin = await mkUser(t, 'sari', 'admin');
    const proj = (await call(t, 'POST', '/api/projects', AUTH, { name: 'proj', path: 'proj' })).json();
    const conv = (await call(t, 'POST', `/api/projects/${proj.id}/conversations`, AUTH)).json();
    return { t, dev: bearer(dev.token), admin: bearer(admin.token), proj, conv };
  }

  it('is refused every admin-only route, while an admin is not', async () => {
    const { t, dev, admin, proj, conv } = await world();
    const adminOnly: [string, string, unknown?][] = [
      ['POST', '/api/projects', { name: 'x', path: 'proj' }],
      ['DELETE', `/api/projects/${proj.id}`],
      ['POST', '/api/accounts/unblock'],
      ['POST', '/api/accounts/login', { name: 'x' }],
      ['GET', '/api/accounts/login/abc'],
      ['DELETE', '/api/accounts/login/abc'],
      ['GET', '/api/approvals'],
      ['POST', '/api/approvals/1/approve'],
      ['POST', '/api/approvals/1/reject'],
      ['GET', '/api/users'],
      ['POST', '/api/users', { name: 'zed', role: 'dev' }],
      ['PATCH', '/api/users/abc', { role: 'admin' }],
      ['POST', '/api/users/abc/token'],
      ['DELETE', '/api/users/abc'],
    ];
    for (const [method, url, body] of adminOnly) {
      expect((await call(t, method, url, dev, body)).statusCode, `dev ${method} ${url}`).toBe(403);
    }
    // the project and conversation are untouched by all that
    expect(t.store.getProject(proj.id)).not.toBeNull();
    for (const [method, url, body] of adminOnly.filter(([, u]) => !u.startsWith('/api/projects/') || !u.endsWith(proj.id))) {
      expect((await call(t, method, url, admin, body)).statusCode, `admin ${method} ${url}`).not.toBe(403);
    }
  });

  it('can do the everyday work: chat, queue, cancel, draft, files, notifications', async () => {
    const { t, dev, proj, conv } = await world();
    expect((await call(t, 'GET', '/api/projects', dev)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/projects/${proj.id}/conversations`, dev)).statusCode).toBe(200);
    expect((await call(t, 'POST', `/api/projects/${proj.id}/conversations`, dev)).statusCode).toBe(201);
    const sent = await call(t, 'POST', `/api/conversations/${conv.id}/prompts`, dev, { prompt: 'hello' });
    expect(sent.statusCode).toBe(202);
    await until(() => t.store.listTurns(conv.id).some((x) => x.status === 'completed'));
    expect((await call(t, 'GET', `/api/conversations/${conv.id}`, dev)).statusCode).toBe(200);
    expect((await call(t, 'GET', `/api/conversations/${conv.id}/queue`, dev)).statusCode).toBe(200);
    expect((await call(t, 'POST', `/api/conversations/${conv.id}/cancel`, dev)).statusCode).toBe(200);
    expect((await call(t, 'PUT', `/api/conversations/${conv.id}/draft`, dev, { draft: 'x' })).statusCode).toBe(204);
    expect((await call(t, 'GET', '/api/accounts', dev)).statusCode).toBe(200);
    expect((await call(t, 'GET', '/api/push/key', dev)).statusCode).toBe(200);
  });

});

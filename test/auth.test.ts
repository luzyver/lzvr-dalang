import { describe, expect, it } from 'vitest';
import { sessionHash } from '../src/auth.js';
import { AUTH } from './helpers.js';
import { setupApp } from './setup-app.js';

describe('sign-out', () => {
  it('revokes the session on the server', async () => {
    const t = setupApp();
    t.store.createSession(sessionHash('a-session'), Date.now() + 60_000);
    const bearer = { authorization: 'Bearer a-session' };
    expect((await t.app.inject({ url: '/api/projects', headers: bearer })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/projects', headers: bearer })).statusCode).toBe(401);
    // idempotent, and the main token is not a session so it cannot be revoked this way
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: AUTH })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/projects', headers: AUTH })).statusCode).toBe(200);
  });
});

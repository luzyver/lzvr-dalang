import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import type { WebAuthn } from '../src/webauthn.js';
import { realWebAuthn } from '../src/webauthn.js';
import { AUTH } from './helpers.js';
import { bearer, mkUser, setupApp } from './setup-app.js';

const CRED = { id: 'cred-1', publicKey: new Uint8Array([1, 2, 3]), counter: 0 };

/** Real option generation, scripted verification (no software authenticator available in tests). */
function fakeWebAuthn(over: Partial<WebAuthn> = {}): WebAuthn & { calls: any[] } {
  const calls: any[] = [];
  return {
    ...realWebAuthn,
    verifyReg: async (o) => {
      calls.push(['reg', o]);
      return { verified: true, registrationInfo: { credential: { ...CRED, id: (o.response as any)?.id ?? CRED.id } } } as any;
    },
    verifyAuth: async (o) => {
      calls.push(['auth', o]);
      return { verified: true, authenticationInfo: { newCounter: 5 } } as any;
    },
    ...over,
    calls,
  };
}

const post = (t: ReturnType<typeof setupApp>, url: string, payload: unknown, headers: Record<string, string> = AUTH) =>
  t.app.inject({ method: 'POST', url, headers, payload: payload as object });

describe('passkeys', () => {
  it('registers a passkey (needs the main token) and then reports passkeys as available', async () => {
    const wa = fakeWebAuthn();
    const t = setupApp({}, { webauthn: wa });
    expect((await t.app.inject({ url: '/api/auth/status' })).json()).toEqual({ passkeys: false });

    expect((await post(t, '/api/passkey/register/options', {}, {})).statusCode).toBe(401);
    const opts = await post(t, '/api/passkey/register/options', {});
    expect(opts.statusCode).toBe(200);
    expect(opts.json().rp.id).toBe('localhost');
    expect(opts.json().challenge).toBeTruthy();
    // discoverable credentials: login can then work without telling strangers which credential ids exist
    expect(opts.json().authenticatorSelection.residentKey).toBe('required');

    const ok = await post(t, '/api/passkey/register/verify', { response: { id: 'cred-1' } });
    expect(ok.statusCode).toBe(204);
    expect(wa.calls[0][1]).toMatchObject({ expectedOrigin: 'http://localhost:9876', expectedRPID: 'localhost' });
    expect((await t.app.inject({ url: '/api/auth/status' })).json()).toEqual({ passkeys: true });
  });

  it('rejects a registration that does not verify', async () => {
    const t = setupApp({}, { webauthn: fakeWebAuthn({ verifyReg: async () => ({ verified: false }) as any }) });
    expect((await post(t, '/api/passkey/register/verify', { response: {} })).statusCode).toBe(400);
    expect(t.store.listPasskeys()).toEqual([]);
  });

  it('logs in with a passkey and hands back a session token that works like the main token', async () => {
    const t = setupApp({}, { webauthn: fakeWebAuthn() });
    expect((await post(t, '/api/auth/passkey/options', {}, {})).statusCode).toBe(404); // none registered yet
    await post(t, '/api/passkey/register/verify', { response: {} });

    const opts = await post(t, '/api/auth/passkey/options', {}, {});
    expect(opts.statusCode).toBe(200);
    expect(opts.json().allowCredentials).toBeUndefined(); // the browser offers whichever passkey it holds

    const login = await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-1' } }, {});
    expect(login.statusCode).toBe(200);
    const { token } = login.json();
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(t.store.getPasskey('cred-1')!.counter).toBe(5);

    const viaSession = await t.app.inject({ url: '/api/projects', headers: { authorization: `Bearer ${token}` } });
    expect(viaSession.statusCode).toBe(200);
    // the raw token is never stored, only its hash
    expect(t.store.hasSession(createHash('sha256').update(token).digest('hex'), Date.now())).toBe(true);
    expect(t.store.hasSession(token, Date.now())).toBe(false);
  });

  it('refuses login for unknown credentials and failed verification, and counts them as failed attempts', async () => {
    const t = setupApp({}, {
      authMaxFailures: 2,
      webauthn: fakeWebAuthn({ verifyAuth: async () => { throw new Error('bad signature'); } }),
    });
    await post(t, '/api/passkey/register/verify', { response: {} });
    expect((await post(t, '/api/auth/passkey/verify', { response: { id: 'nope' } }, {})).statusCode).toBe(401);
    expect((await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-1' } }, {})).statusCode).toBe(401);
    expect((await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-1' } }, {})).statusCode).toBe(429);
  });

  it('accepts each challenge once, and only ones this server issued', async () => {
    const wa = fakeWebAuthn();
    const t = setupApp({}, { webauthn: wa });
    const opts = (await post(t, '/api/passkey/register/options', {})).json();
    await post(t, '/api/passkey/register/verify', { response: {} });
    const check = wa.calls[0][1].expectedChallenge as (c: string) => boolean;
    expect(check('made-up')).toBe(false);
    expect(check(opts.challenge)).toBe(true);
    expect(check(opts.challenge)).toBe(false);
  });

  it('keeps the pending-challenge table bounded when strangers keep asking for login options', async () => {
    let seen: any;
    const wa = fakeWebAuthn({ verifyAuth: async (o) => { seen = o; return { verified: false } as any; } });
    const t = setupApp({}, { webauthn: wa, authMaxFailures: 100 });
    await post(t, '/api/passkey/register/verify', { response: {} });
    const first = (await post(t, '/api/auth/passkey/options', {}, {})).json().challenge;
    let last = first;
    for (let i = 0; i < 1100; i++) last = (await post(t, '/api/auth/passkey/options', {}, {})).json().challenge;
    await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-1' } }, {});
    const check = seen.expectedChallenge as (c: string) => boolean;
    expect(check(first)).toBe(false); // evicted, oldest first
    expect(check(last)).toBe(true);
  }, 30000);

  it('signing out revokes the session on the server', async () => {
    const t = setupApp({}, { webauthn: fakeWebAuthn() });
    await post(t, '/api/passkey/register/verify', { response: {} });
    const { token } = (await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-1' } }, {})).json();
    const bearer = { authorization: `Bearer ${token}` };
    expect((await t.app.inject({ url: '/api/projects', headers: bearer })).statusCode).toBe(200);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/projects', headers: bearer })).statusCode).toBe(401);
    // idempotent, and the main token is not a session so it cannot be revoked this way
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: bearer })).statusCode).toBe(204);
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/logout', headers: AUTH })).statusCode).toBe(204);
    expect((await t.app.inject({ url: '/api/projects', headers: AUTH })).statusCode).toBe(200);
  });

  it('ties each passkey to the user who registered it, and logs in as that user', async () => {
    const seen: any[] = [];
    const wa = fakeWebAuthn({ genReg: async (o) => { seen.push(o); return realWebAuthn.genReg(o); } });
    const t = setupApp({}, { webauthn: wa });
    const dev = await mkUser(t, 'budi', 'dev');

    // the owner (main token) and the dev each register their own
    await post(t, '/api/passkey/register/verify', { response: { id: 'cred-owner' } });
    await post(t, '/api/passkey/register/options', {}, bearer(dev.token));
    await post(t, '/api/passkey/register/verify', { response: { id: 'cred-dev' } }, bearer(dev.token));
    expect(t.store.getPasskey('cred-owner')!.userId).toBeNull();
    expect(t.store.getPasskey('cred-dev')!.userId).toBe(dev.id);

    // a later registration only excludes that user's own credentials
    await post(t, '/api/passkey/register/options', {}, bearer(dev.token));
    expect(seen.at(-1).excludeCredentials).toEqual([{ id: 'cred-dev' }]);
    expect(seen.at(-1).userName).toBe('budi');

    const asDev = (await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-dev' } }, {})).json();
    expect((await t.app.inject({ url: '/api/me', headers: bearer(asDev.token) })).json()).toEqual({ name: 'budi', role: 'dev', main: false });
    expect((await t.app.inject({ url: '/api/users', headers: bearer(asDev.token) })).statusCode).toBe(403);

    const asOwner = (await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-owner' } }, {})).json();
    expect((await t.app.inject({ url: '/api/me', headers: bearer(asOwner.token) })).json()).toEqual({ name: 'owner', role: 'admin', main: false });

    // removing the user takes the passkey login and any open session with them
    await t.app.inject({ method: 'DELETE', url: `/api/users/${dev.id}`, headers: AUTH });
    expect((await t.app.inject({ url: '/api/me', headers: bearer(asDev.token) })).statusCode).toBe(401);
    expect((await post(t, '/api/auth/passkey/verify', { response: { id: 'cred-dev' } }, {})).statusCode).toBe(401);
  });

  it('answers 501 when RP id / origin are not configured', async () => {
    const t = setupApp({}, { cfg: { rpId: undefined, origin: undefined } });
    expect((await post(t, '/api/passkey/register/options', {})).statusCode).toBe(501);
    expect((await post(t, '/api/auth/passkey/options', {}, {})).statusCode).toBe(501);
    expect((await t.app.inject({ url: '/api/auth/status' })).json()).toEqual({ passkeys: false });
  });

  it('sessions expire', () => {
    const t = setupApp();
    t.store.createSession('h', 1000);
    expect(t.store.hasSession('h', 999)).toBe(true);
    expect(t.store.hasSession('h', 1000)).toBe(false);
  });
});

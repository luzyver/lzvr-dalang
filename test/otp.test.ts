import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.js';
import type { Mail } from '../src/otp.js';
import { AUTH } from './helpers.js';
import { bearer, setupApp } from './setup-app.js';

function withMail(cfg: Record<string, unknown> = {}, sendMail?: (m: Mail) => Promise<void>) {
  const sent: Mail[] = [];
  const t = setupApp({}, {
    cfg: { mailerUrl: 'http://mailer.test', ownerEmails: ['boss@example.com'], ...cfg },
    sendMail: sendMail ?? (async (m) => { sent.push(m); }),
  });
  const post = (url: string, payload: unknown) => t.app.inject({ method: 'POST', url, payload: payload as object });
  const codeOf = (m: Mail) => /\b(\d{6})\b/.exec(m.text)![1]!;
  return { ...t, sent, post, codeOf };
}

describe('email sign-in (OTP)', () => {
  it('mails a code to an owner email and trades it for a session token', async () => {
    const t = withMail();
    const r = await t.post('/api/auth/otp/request', { email: ' Boss@Example.com ' });
    expect(r.statusCode).toBe(200);
    expect(r.json()).toEqual({ cooldown: 60 });
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]!.to).toBe('boss@example.com');

    const v = await t.post('/api/auth/otp/verify', { email: 'boss@example.com', code: t.codeOf(t.sent[0]!) });
    expect(v.statusCode).toBe(200);
    const me = await t.app.inject({ url: '/api/me', headers: bearer(v.json().token) });
    expect(me.json()).toEqual({ name: 'owner', role: 'admin', main: false });
    // a code works once
    expect((await t.post('/api/auth/otp/verify', { email: 'boss@example.com', code: t.codeOf(t.sent[0]!) })).statusCode).toBe(401);
  });

  it('signs a panel user in as themselves, by the email set on the user', async () => {
    const t = withMail();
    const u = await t.app.inject({ method: 'POST', url: '/api/users', headers: AUTH, payload: { name: 'budi', role: 'dev', email: 'Budi@Example.com' } });
    expect(u.json()).toMatchObject({ email: 'budi@example.com' });
    await t.post('/api/auth/otp/request', { email: 'budi@example.com' });
    const v = await t.post('/api/auth/otp/verify', { email: 'budi@example.com', code: t.codeOf(t.sent[0]!) });
    expect((await t.app.inject({ url: '/api/me', headers: bearer(v.json().token) })).json()).toMatchObject({ name: 'budi', role: 'dev' });
  });

  it('answers an unknown email the same way but sends nothing', async () => {
    const t = withMail();
    const r = await t.post('/api/auth/otp/request', { email: 'nobody@example.com' });
    expect(r.statusCode).toBe(200);
    expect(t.sent).toHaveLength(0);
    expect((await t.post('/api/auth/otp/request', { email: 'not-an-email' })).statusCode).toBe(400);
  });

  it('holds back a second code for a minute', async () => {
    const t = withMail();
    await t.post('/api/auth/otp/request', { email: 'boss@example.com' });
    const again = await t.post('/api/auth/otp/request', { email: 'boss@example.com' });
    expect(again.statusCode).toBe(429);
    expect(again.json().cooldown).toBeGreaterThan(0);
    expect(t.sent).toHaveLength(1);
  });

  it('drops the code after 5 wrong tries', async () => {
    const t = withMail();
    await t.post('/api/auth/otp/request', { email: 'boss@example.com' });
    const right = t.codeOf(t.sent[0]!);
    const wrong = right === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await t.post('/api/auth/otp/verify', { email: 'boss@example.com', code: wrong })).statusCode).toBe(401);
    expect((await t.post('/api/auth/otp/verify', { email: 'boss@example.com', code: right })).statusCode).toBe(401);
  });

  it('does not expose delivery failure or latency, and keeps its cooldown', async () => {
    const t = withMail({}, async () => { throw new Error('down'); });
    expect((await t.post('/api/auth/otp/request', { email: 'boss@example.com' })).json()).toEqual({ cooldown: 60 });
    expect((await t.post('/api/auth/otp/request', { email: 'boss@example.com' })).statusCode).toBe(429);
    const slow = withMail({}, () => new Promise(() => {}));
    expect((await slow.post('/api/auth/otp/request', { email: 'boss@example.com' })).statusCode).toBe(200);
  });

  it('gives known and unknown addresses the same cooldown without an unknown-only IP penalty', async () => {
    const t = withMail();
    for (const email of ['boss@example.com', ...Array.from({ length: 12 }, (_, i) => `unknown${i}@example.com`)]) {
      expect((await t.post('/api/auth/otp/request', { email })).json()).toEqual({ cooldown: 60 });
      const again = await t.post('/api/auth/otp/request', { email });
      expect(again.statusCode).toBe(429);
      expect(again.json().cooldown).toBeGreaterThan(0);
      expect(again.headers['retry-after']).toBeDefined();
    }
    expect(t.sent).toHaveLength(1);
  });

  it('is off without MAILER_URL', async () => {
    const t = setupApp();
    expect((await t.app.inject({ method: 'POST', url: '/api/auth/otp/request', payload: { email: 'a@b.co' } })).statusCode).toBe(501);
    expect((await t.app.inject({ url: '/api/auth/status' })).json()).toMatchObject({ email: false, bypass: false });
  });

  it('keeps user emails unique and apart from the owner emails', async () => {
    const t = withMail();
    const mk = (name: string, email: string) => t.app.inject({ method: 'POST', url: '/api/users', headers: AUTH, payload: { name, role: 'dev', email } });
    expect((await mk('a', 'a@example.com')).statusCode).toBe(201);
    expect((await mk('b', 'A@example.com')).statusCode).toBe(409);
    expect((await mk('c', 'boss@example.com')).statusCode).toBe(400);
    expect((await mk('d', 'nope')).statusCode).toBe(400);
    const b = (await mk('b', '')).json();
    expect(b.email).toBeNull();
    const patch = (email: string) => t.app.inject({ method: 'PATCH', url: `/api/users/${b.id}`, headers: AUTH, payload: { email } });
    expect((await patch('a@example.com')).statusCode).toBe(409);
    expect((await patch('b@example.com')).statusCode).toBe(204);
    expect(t.store.getUser(b.id)!.email).toBe('b@example.com');
    expect((await patch('')).statusCode).toBe(204);
    expect(t.store.getUser(b.id)!.email).toBeNull();
  });
});

describe('AUTH_BYPASS', () => {
  it('makes every request the owner', async () => {
    const t = setupApp({}, { cfg: { authBypass: true } });
    expect((await t.app.inject({ url: '/api/me' })).json()).toEqual({ name: 'owner', role: 'admin', main: false });
    expect((await t.app.inject({ url: '/api/auth/status' })).json()).toMatchObject({ bypass: true });
  });

  it('is refused unless the server listens on loopback', () => {
    const base = { LZVR_TOKEN: 'x'.repeat(32), WORKSPACE_ROOT: '/w' };
    expect(loadConfig({ ...base, AUTH_BYPASS: 'true' }).authBypass).toBe(true);
    expect(loadConfig(base).authBypass).toBe(false);
    expect(() => loadConfig({ ...base, AUTH_BYPASS: 'true', HOST: '0.0.0.0' })).toThrow(/AUTH_BYPASS/);
  });
});

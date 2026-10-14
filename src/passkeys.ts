import { createHash, randomBytes } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './store.js';
import type { WebAuthn } from './webauthn.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const MAX_CHALLENGES = 1000;

export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');

/**
 * Passkey (WebAuthn) registration and login. The main token registers a passkey; a passkey login then
 * hands back a session token that the auth hook accepts like the main one. One owner, many passkeys.
 */
export function passkeyRoutes(
  app: FastifyInstance,
  d: { cfg: Config; store: Store; webauthn: WebAuthn; noteFailure: (ip: string) => void },
): void {
  const { cfg, store, webauthn, noteFailure } = d;
  const enabled = () => Boolean(cfg.rpId && cfg.origin);
  const notConfigured = { error: 'passkeys need LZVR_RP_ID and LZVR_ORIGIN' };

  // challenge -> expiry. Single process, so memory is enough; each challenge is usable once.
  // Login options are public, so the table is capped: oldest challenges are dropped first.
  const challenges = new Map<string, number>();
  const issue = (c: string) => {
    const now = Date.now();
    for (const [k, exp] of challenges) { if (exp > now) break; challenges.delete(k); } // insertion order == expiry order
    while (challenges.size >= MAX_CHALLENGES) challenges.delete(challenges.keys().next().value as string);
    challenges.set(c, now + CHALLENGE_TTL_MS);
  };
  const consume = (c: string) => {
    const exp = challenges.get(c);
    challenges.delete(c);
    return exp !== undefined && exp > Date.now();
  };

  const body = { type: 'object', required: ['response'], properties: { response: { type: 'object' } } };

  // What the sign-in screen offers. `bypass`: local development, no sign-in at all (AUTH_BYPASS).
  app.get('/api/auth/status', () => ({
    passkeys: enabled() && store.listPasskeys().length > 0, email: Boolean(cfg.mailerUrl), bypass: cfg.authBypass,
  }));

  // Sign out: revoke the session token presented. Idempotent; the main token is not a session and is left alone.
  app.post('/api/auth/logout', (req, reply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (m) store.deleteSession(sessionHash(m[1]!));
    return reply.code(204).send();
  });

  // A passkey belongs to whoever is signed in when registering it: a panel user, or the owner (main token).
  app.post('/api/passkey/register/options', async (req, reply) => {
    if (!enabled()) return reply.code(501).send(notConfigured);
    const me = req.user!;
    const opts = await webauthn.genReg({
      rpName: 'Dalang',
      rpID: cfg.rpId!,
      userName: me.name,
      userID: new TextEncoder().encode(`lzvr-user-${me.id ?? 'owner'}`),
      excludeCredentials: store.listPasskeys(me.id).map((p) => ({ id: p.id })),
      // Discoverable, so login can offer "whichever passkey you hold" without listing every user's credential ids.
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    issue(opts.challenge);
    return opts;
  });

  app.post<{ Body: { response: any } }>('/api/passkey/register/verify', { schema: { body } }, async (req, reply) => {
    if (!enabled()) return reply.code(501).send(notConfigured);
    let v;
    try {
      v = await webauthn.verifyReg({
        response: req.body.response, expectedChallenge: consume, expectedOrigin: cfg.origin!, expectedRPID: cfg.rpId!,
      });
    } catch {
      return reply.code(400).send({ error: 'registration failed' });
    }
    if (!v.verified) return reply.code(400).send({ error: 'registration failed' });
    const c = v.registrationInfo.credential;
    store.addPasskey({ id: c.id, publicKey: c.publicKey, counter: c.counter, transports: c.transports }, req.user!.id);
    return reply.code(204).send();
  });

  app.post('/api/auth/passkey/options', async (_req, reply) => {
    if (!enabled()) return reply.code(501).send(notConfigured);
    if (!store.listPasskeys().length) return reply.code(404).send({ error: 'no passkeys registered' });
    // No allowCredentials: the browser offers the passkeys it holds, and the server learns who it is from the one used.
    const opts = await webauthn.genAuth({ rpID: cfg.rpId! });
    issue(opts.challenge);
    return opts;
  });

  app.post<{ Body: { response: any } }>('/api/auth/passkey/verify', { schema: { body } }, async (req, reply) => {
    if (!enabled()) return reply.code(501).send(notConfigured);
    const fail = () => { noteFailure(req.ip); return reply.code(401).send({ error: 'unauthorized' }); };
    const cred = store.getPasskey(String(req.body.response?.id ?? ''));
    if (!cred) return fail();
    let v;
    try {
      v = await webauthn.verifyAuth({
        response: req.body.response, expectedChallenge: consume, expectedOrigin: cfg.origin!, expectedRPID: cfg.rpId!,
        credential: { id: cred.id, publicKey: cred.publicKey, counter: cred.counter, transports: cred.transports as any },
      });
    } catch {
      return fail();
    }
    if (!v.verified) return fail();
    store.setPasskeyCounter(cred.id, v.authenticationInfo.newCounter);
    const token = randomBytes(32).toString('hex');
    store.createSession(sessionHash(token), Date.now() + SESSION_TTL_MS, cred.userId ?? null);
    return { token };
  });
}

import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './store.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');

const ownerTag = (mainToken: string, email: string) => createHmac('sha256', mainToken).update(`owner session\n${email}`).digest();

/**
 * A session token for an owner email: random, then the email and a tag keyed by LZVR_TOKEN. The session row has no
 * email, so the token carries it, and `ownerSessionValid` can end the session once the email leaves
 * LZVR_OWNER_EMAILS or LZVR_TOKEN is rotated.
 */
export const ownerSessionToken = (cfg: Pick<Config, 'token'>, email: string) =>
  `${randomBytes(32).toString('hex')}.${Buffer.from(email).toString('base64url')}.${ownerTag(cfg.token, email).toString('base64url')}`;

/** Whether an owner session token (see ownerSessionToken) still belongs to an owner email. */
export function ownerSessionValid(cfg: Pick<Config, 'token' | 'ownerEmails'>, token: string): boolean {
  const [, mail, tag] = token.split('.');
  if (!mail || !tag) return false;
  const email = Buffer.from(mail, 'base64url').toString();
  const want = ownerTag(cfg.token, email);
  const got = Buffer.from(tag, 'base64url');
  return got.length === want.length && timingSafeEqual(got, want) && cfg.ownerEmails.includes(email);
}

/** What the sign-in screen offers, and signing out of a session (email sign-in creates them, see otp.ts). */
export function authRoutes(app: FastifyInstance, d: { cfg: Config; store: Store }): void {
  const { cfg, store } = d;

  // `bypass`: local development, no sign-in at all (AUTH_BYPASS).
  app.get('/api/auth/status', () => ({ email: Boolean(cfg.mailerUrl), bypass: cfg.authBypass }));

  // Sign out: revoke the session token presented. Idempotent; the main token is not a session and is left alone.
  app.post('/api/auth/logout', (req, reply) => {
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '');
    if (m) store.deleteSession(sessionHash(m[1]!));
    return reply.code(204).send();
  });
}

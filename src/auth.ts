import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import type { Store } from './store.js';

export const SESSION_TTL_MS = 30 * 24 * 60 * 60 * 1000;

export const sessionHash = (token: string) => createHash('sha256').update(token).digest('hex');

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

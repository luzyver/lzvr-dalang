import { createHmac, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { Config } from './config.js';
import { SESSION_TTL_MS, ownerSessionToken, sessionHash } from './auth.js';
import type { Store } from './store.js';

const CODE_TTL_MS = 5 * 60 * 1000;
const COOLDOWN_MS = 60 * 1000;
const MAX_ATTEMPTS = 5;
const MAX_CHALLENGES = 1000;
// Wrong codes per email across all codes and addresses: the per-address block alone lets many addresses guess on.
const MAX_MISSES = 20;
const MISS_WINDOW_MS = 24 * 60 * 60 * 1000;
const MAX_TRACKED = 100_000;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface Mail { to: string; subject: string; text: string; html: string; from?: string }
export type SendMail = (mail: Mail) => Promise<void>;

/** Hands the mail to the mailer service (`POST /mail/send`, answered 202 once queued). */
export const mailerSend = (url: string): SendMail => async (mail) => {
  const res = await fetch(`${url}/mail/send`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(mail),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`mailer answered ${res.status}`);
};

/**
 * Email sign-in: a 6-digit code is mailed to a known address (an owner email or a panel user's), and trading it in
 * returns a session token. Unknown addresses get the same answer, so the form does not tell
 * who has an account.
 */
export function otpRoutes(
  app: FastifyInstance,
  d: { cfg: Config; store: Store; sendMail?: SendMail; noteFailure: (ip: string) => void },
): void {
  const { cfg, store, noteFailure } = d;
  const send = d.sendMail ?? (cfg.mailerUrl ? mailerSend(cfg.mailerUrl) : null);
  const key = randomBytes(32); // codes are kept only as an HMAC, valid until this process restarts
  const hash = (email: string, code: string) => createHmac('sha256', key).update(`${email}\n${code}`).digest();

  // email -> pending code. Single process, so memory is enough. A code used up by wrong tries stays until it expires,
  // so its cooldown still holds.
  const pending = new Map<string, { hash: Buffer; expires: number; sentAt: number; attempts: number }>();
  // email -> wrong codes since `since`. Oldest entries go first when full, so one flood cannot wipe every count.
  const misses = new Map<string, { count: number; since: number }>();
  const locked = (email: string, now: number) => {
    const m = misses.get(email);
    if (m && now - m.since >= MISS_WINDOW_MS) misses.delete(email);
    return (misses.get(email)?.count ?? 0) >= MAX_MISSES;
  };
  const miss = (email: string, now: number) => {
    const m = misses.get(email);
    if (m) { m.count++; return; }
    while (misses.size >= MAX_TRACKED) misses.delete(misses.keys().next().value as string);
    misses.set(email, { count: 1, since: now });
  };

  /** null: not an address that may sign in. Otherwise the user it signs in as (null id = the owner). */
  const whoIs = (email: string): { userId: string | null } | null => {
    if (cfg.ownerEmails.includes(email)) return { userId: null };
    const u = store.getUserByEmail(email);
    return u ? { userId: u.id } : null;
  };

  const emailBody = { type: 'object', required: ['email'], properties: { email: { type: 'string', maxLength: 254 } } };

  app.post<{ Body: { email: string } }>('/api/auth/otp/request', { schema: { body: emailBody } }, async (req, reply) => {
    if (!send) return reply.code(501).send({ error: 'email sign-in needs MAILER_URL' });
    const email = req.body.email.trim().toLowerCase();
    if (!EMAIL_RE.test(email)) return reply.code(400).send({ error: 'enter a valid email address' });
    const now = Date.now();
    const cur = pending.get(email);
    if (cur && now - cur.sentAt < COOLDOWN_MS) {
      const wait = Math.ceil((COOLDOWN_MS - (now - cur.sentAt)) / 1000);
      return reply.code(429).header('retry-after', wait).send({ error: `wait ${wait}s before asking for another code`, cooldown: wait });
    }
    const cooldown = COOLDOWN_MS / 1000;

    for (const [k, v] of pending) if (v.expires <= now) pending.delete(k);
    while (pending.size >= MAX_CHALLENGES) pending.delete(pending.keys().next().value as string);
    const code = String(randomInt(0, 1_000_000)).padStart(6, '0');
    pending.set(email, { hash: hash(email, code), expires: now + CODE_TTL_MS, sentAt: now, attempts: 0 });
    // Keep the same cooldown and response timing for every address, including mailer failures.
    // Delivery runs in the background; awaiting SMTP here would disclose which addresses exist.
    // A locked email gets the same answer but no mail: no code would be taken.
    if (!locked(email, now) && whoIs(email)) void Promise.resolve().then(() => send({
      to: email,
      from: cfg.mailFrom,
      subject: `Dalang sign-in code: ${code}`,
      text: `Your Dalang sign-in code is ${code}. It is valid for 5 minutes.\n\nIf you did not ask for it, ignore this email.`,
      html: `<p>Your Dalang sign-in code is</p><p style="font-size:28px;font-weight:700;letter-spacing:6px">${code}</p>`
        + '<p>It is valid for 5 minutes. If you did not ask for it, ignore this email.</p>',
    })).catch((e: unknown) => {
      req.log.error({ err: e }, 'sending the sign-in code failed');
    });
    return { cooldown };
  });

  app.post<{ Body: { email: string; code: string } }>('/api/auth/otp/verify', {
    schema: { body: { type: 'object', required: ['email', 'code'], properties: { email: { type: 'string', maxLength: 254 }, code: { type: 'string', maxLength: 16 } } } },
  }, (req, reply) => {
    const email = req.body.email.trim().toLowerCase();
    const p = pending.get(email);
    const now = Date.now();
    const fail = () => { noteFailure(req.ip); return reply.code(401).send({ error: 'wrong or expired code' }); };
    if (!p || p.expires <= now) { pending.delete(email); return fail(); }
    if (p.attempts >= MAX_ATTEMPTS || locked(email, now)) return fail(); // a new code has to be asked for
    if (!timingSafeEqual(hash(email, req.body.code.trim()), p.hash)) {
      p.attempts++;
      miss(email, now);
      return fail();
    }
    pending.delete(email);
    const who = whoIs(email); // the user may have been deleted or changed email meanwhile
    if (!who) return fail();
    const token = who.userId === null ? ownerSessionToken(cfg, email) : randomBytes(32).toString('hex');
    store.createSession(sessionHash(token), Date.now() + SESSION_TTL_MS, who.userId);
    return { token };
  });
}

import { lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

// The texts the CLIs print at a limit (Codex: "You've hit your usage limit", "Your workspace is out of credits", "You hit
// your spend cap"; Claude Code: "You've hit your session limit · resets 3pm"). Claude Code also marks its limit as such
// (see `limit` below), so the text only has to catch what is not marked. Override with LIMIT_REGEX (see docs/guide.md). Bare
// "quota" and "429" are deliberately not matched: "Disk quota exceeded" or a line number must not take an account offline.
export const DEFAULT_LIMIT_RE = /usage limit|rate.?limit|too many requests|insufficient_quota|exceeded your (current )?quota|limit (has been )?reached|hit your [\w ]*limit|out of credits|spend cap/i;

type Failure = { type: string; [k: string]: unknown };

/** The only text we judge: the error message, or the tail of stderr for a process that died. Nothing else in the event. */
function failureText(ev: Failure): string {
  if (ev.type === 'process.exit') return String(ev.stderr ?? '').slice(-1000);
  const err = ev.error as { message?: unknown } | undefined;
  return [err?.message, ev.message].filter((x): x is string => typeof x === 'string').join('\n');
}

/** A failure the CLI itself marked as a usage limit (set by the Claude Code mapper, never by the agent). */
function marked(ev: Failure): { resetsAt?: number } | null {
  return ev.limit && typeof ev.limit === 'object' ? ev.limit as { resetsAt?: number } : null;
}

export function isLimit(ev: Failure, re: RegExp = DEFAULT_LIMIT_RE): boolean {
  return !!marked(ev) || re.test(failureText(ev));
}

const UNIT_MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/**
 * How long the limit lasts, if the failure says: the reset time Claude Code marks it with, "try again in 3 minutes", or
 * Codex's "Try again at 3:04 PM" / "Try again at Oct 20th, 2026 3:04 PM" (local time, which Codex and we share). Else null.
 * Capped at 24 hours.
 */
export function retryAfter(ev: Failure, now = Date.now()): number | null {
  const cap = (ms: number) => (ms > 0 ? Math.min(ms, UNIT_MS.day) : null);
  const resetsAt = marked(ev)?.resetsAt;
  if (typeof resetsAt === 'number' && resetsAt > 0) return cap(resetsAt * 1000 - now);
  const text = failureText(ev);
  const m = /try again in (\d+)\s*(second|minute|hour|day)s?/i.exec(text);
  if (m) return cap(Number(m[1]) * UNIT_MS[m[2]!.toLowerCase() as keyof typeof UNIT_MS]);
  const at = /try again at (?:([a-z]{3})[a-z]* (\d{1,2})(?:st|nd|rd|th)?,? (\d{4}),? )?(\d{1,2}):(\d{2})\s*([ap]m)?/i.exec(text);
  if (!at) return null;
  let hour = Number(at[4]) % (at[6] ? 12 : 24);
  if (at[6]?.toLowerCase() === 'pm') hour += 12;
  const d = new Date(now);
  if (at[1]) {
    const month = MONTHS.indexOf(at[1].toLowerCase());
    if (month < 0) return null;
    d.setFullYear(Number(at[3]), month, Number(at[2]));
  }
  d.setHours(hour, Number(at[5]), 0, 0);
  if (!at[1] && d.getTime() <= now) d.setDate(d.getDate() + 1); // a bare time that has passed today means tomorrow
  return cap(d.getTime() - now);
}

/** retryAfter, or `fallback` when the failure does not say. */
export function retryAfterMs(ev: Failure, fallback: number): number {
  return retryAfter(ev) ?? fallback;
}

/** Until the latest reset of a usage window the account has used up (as the CLI last reported it), or null. Capped at 24 hours. */
export function windowsResetMs(windows: { usedPercent: number; resetsAt: number }[], now = Date.now()): number | null {
  const ends = windows.filter((w) => w.usedPercent >= 100 && w.resetsAt * 1000 > now).map((w) => w.resetsAt * 1000 - now);
  return ends.length ? Math.min(Math.max(...ends), UNIT_MS.day) : null;
}

export class Accounts {
  // ponytail: block state lives in memory; a restart forgets it and costs one extra limited attempt per account.
  private blocked = new Map<string, number>();
  /** Accounts an admin switched off: never picked, whatever their limit state. */
  private disabled = new Set<string>();
  /** Accounts whose login the CLI says is gone: never picked, so a prompt does not fail on them. */
  private loggedOut = new Set<string>();

  constructor(
    readonly homes: string[],
    private blockMs = 60 * 60 * 1000,
    private now: () => number = Date.now,
  ) {}

  /** The first account: the one whose `sessions` folder all the others share. Null while no account exists. */
  primary(): string | null { return this.homes[0] ?? null; }

  /** Add an account at runtime (last in failover order). Adding one that is already there does nothing. */
  add(home: string): void {
    if (!this.homes.includes(home)) this.homes.push(home);
  }

  /** Forget an account (its folder is the caller's business). */
  remove(home: string): void {
    const i = this.homes.indexOf(home);
    if (i >= 0) this.homes.splice(i, 1);
    this.blocked.delete(home);
    this.disabled.delete(home);
    this.loggedOut.delete(home);
  }

  setEnabled(home: string, enabled: boolean): void {
    if (enabled) this.disabled.delete(home); else this.disabled.add(home);
  }

  /** The CLI reports this account as signed out: it is skipped (like a switched-off one) until it is signed in again. */
  setLoggedOut(home: string, loggedOut: boolean): void {
    if (loggedOut) this.loggedOut.add(home); else this.loggedOut.delete(home);
  }

  /** Why `pick()` came back empty while accounts exist: names signed-out ones so the fix (sign in again) is clear. */
  exhaustedReason(): string {
    const out = this.homes.some((h) => this.loggedOut.has(h));
    return out ? 'every account is switched off, at its usage limit or signed out (sign in again in the panel)' : 'every account is switched off or at its usage limit';
  }

  /** First account (configured order) that is not currently blocked. */
  pick(): string | null {
    return this.homes.find((h) => !this.disabled.has(h) && !this.loggedOut.has(h) && (this.blocked.get(h) ?? 0) <= this.now()) ?? null;
  }

  block(home: string, ms: number = this.blockMs): void {
    this.blocked.set(home, this.now() + ms);
  }

  unblockAll(): void {
    this.blocked.clear();
  }

  list(): { name: string; blockedUntil: number | null; enabled: boolean }[] {
    return this.homes.map((h) => {
      const until = this.blocked.get(h) ?? 0;
      return { name: basename(h), blockedUntil: until > this.now() ? until : null, enabled: !this.disabled.has(h) };
    });
  }
}

/** Directories every account shares: `sessions` so a chat can resume on another account, `memories` so memory is global. */
export const SHARED_DIRS = ['sessions', 'memories'];
/** Claude Code keeps sessions and per-project memory together under `projects`. */
export const CLAUDE_SHARED_DIRS = ['projects'];

/**
 * Link every other home's shared directories to the first home's. Returns homes that already had their own
 * real directory and were left untouched.
 */
export function linkSessions(homes: string[], dirs: string[] = SHARED_DIRS): string[] {
  const [primary, ...rest] = homes;
  if (!primary) return [];
  const skipped = new Set<string>();
  for (const name of dirs) {
    const target = join(primary, name);
    mkdirSync(target, { recursive: true });
    for (const h of rest) {
      mkdirSync(h, { recursive: true });
      const link = join(h, name);
      try {
        if (lstatSync(link).isSymbolicLink()) continue;
        skipped.add(h);
      } catch {
        symlinkSync(target, link, 'junction');
      }
    }
  }
  return [...skipped];
}

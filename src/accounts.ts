import { lstatSync, mkdirSync, symlinkSync } from 'node:fs';
import { basename, join } from 'node:path';

// The exact error text Codex prints at a usage limit is undocumented; this is a best guess.
// Override with LIMIT_REGEX once the real output is known (see README). Bare "quota" and "429" are
// deliberately not matched: "Disk quota exceeded" or a line number must not take an account offline.
export const DEFAULT_LIMIT_RE = /usage limit|rate.?limit|too many requests|insufficient_quota|exceeded your (current )?quota|limit (has been )?reached/i;

type Failure = { type: string; [k: string]: unknown };

/** The only text we judge: the error message, or the tail of stderr for a process that died. Nothing else in the event. */
function failureText(ev: Failure): string {
  if (ev.type === 'process.exit') return String(ev.stderr ?? '').slice(-1000);
  const err = ev.error as { message?: unknown } | undefined;
  return [err?.message, ev.message].filter((x): x is string => typeof x === 'string').join('\n');
}

export function isLimit(ev: Failure, re: RegExp = DEFAULT_LIMIT_RE): boolean {
  return re.test(failureText(ev));
}

const UNIT_MS = { second: 1000, minute: 60_000, hour: 3_600_000, day: 86_400_000 } as const;

/** How long the limit lasts if the message says ("try again in 3 minutes"), else `fallback`. Capped at 24 hours. */
export function retryAfterMs(ev: Failure, fallback: number): number {
  const m = /try again in (\d+)\s*(second|minute|hour|day)s?/i.exec(failureText(ev));
  if (!m) return fallback;
  return Math.min(Number(m[1]) * UNIT_MS[m[2]!.toLowerCase() as keyof typeof UNIT_MS], UNIT_MS.day);
}

export class Accounts {
  // ponytail: block state lives in memory; a restart forgets it and costs one extra limited attempt per account.
  private blocked = new Map<string, number>();

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
  }

  /** First account (configured order) that is not currently blocked. */
  pick(): string | null {
    return this.homes.find((h) => (this.blocked.get(h) ?? 0) <= this.now()) ?? null;
  }

  block(home: string, ms: number = this.blockMs): void {
    this.blocked.set(home, this.now() + ms);
  }

  unblockAll(): void {
    this.blocked.clear();
  }

  list(): { name: string; blockedUntil: number | null }[] {
    return this.homes.map((h) => {
      const until = this.blocked.get(h) ?? 0;
      return { name: basename(h), blockedUntil: until > this.now() ? until : null };
    });
  }
}

/** Directories every account shares: `sessions` so a chat can resume on another account, `memories` so memory is global. */
export const SHARED_DIRS = ['sessions', 'memories'];

/**
 * Link every other home's shared directories to the first home's. Returns homes that already had their own
 * real directory and were left untouched.
 */
export function linkSessions(homes: string[]): string[] {
  const [primary, ...rest] = homes;
  if (!primary) return [];
  const skipped = new Set<string>();
  for (const name of SHARED_DIRS) {
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

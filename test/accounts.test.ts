import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Accounts, isLimit, linkSessions, retryAfter, retryAfterMs, windowsResetMs } from '../src/accounts.js';

describe('Accounts', () => {
  it('picks the first unblocked account, in configured order', () => {
    const a = new Accounts(['/h/a', '/h/b']);
    expect(a.pick()).toBe('/h/a');
    a.block('/h/a');
    expect(a.pick()).toBe('/h/b');
    a.block('/h/b');
    expect(a.pick()).toBeNull();
  });

  it('skips signed-out accounts and says so when nothing is left', () => {
    const a = new Accounts(['/h/a', '/h/b']);
    a.setLoggedOut('/h/a', true);
    expect(a.pick()).toBe('/h/b');
    a.setEnabled('/h/b', false);
    expect(a.pick()).toBeNull();
    expect(a.exhaustedReason()).toContain('signed out');
    a.setLoggedOut('/h/a', false);
    expect(a.exhaustedReason()).not.toContain('signed out');
  });

  it('unblocks after the block time passes, and on demand', () => {
    let now = 1000;
    const a = new Accounts(['/h/a', '/h/b'], 500, () => now);
    a.block('/h/a');
    expect(a.pick()).toBe('/h/b');
    now = 1499;
    expect(a.pick()).toBe('/h/b');
    now = 1500;
    expect(a.pick()).toBe('/h/a');
    a.block('/h/a');
    a.unblockAll();
    expect(a.pick()).toBe('/h/a');
  });

  it('blocks for a given duration when told how long', () => {
    let now = 1000;
    const a = new Accounts(['/h/a'], 500, () => now);
    a.block('/h/a', 100);
    now = 1099;
    expect(a.pick()).toBeNull();
    now = 1100;
    expect(a.pick()).toBe('/h/a');
  });

  it('lists accounts by name with their block state', () => {
    const a = new Accounts(['/h/a', '/h/b'], 500, () => 1000);
    a.block('/h/b');
    expect(a.list()).toEqual([
      { name: 'a', blockedUntil: null, enabled: true },
      { name: 'b', blockedUntil: 1500, enabled: true },
    ]);
  });
});

describe('isLimit', () => {
  it('recognises usage/rate limit failures', () => {
    expect(isLimit({ type: 'turn.failed', error: { message: 'You have reached your usage limit' } })).toBe(true);
    expect(isLimit({ type: 'turn.failed', error: { message: "You've hit your usage limit. Try again in 3 minutes." } })).toBe(true);
    expect(isLimit({ type: 'error', message: 'Rate limit exceeded, 429 Too Many Requests' })).toBe(true);
    expect(isLimit({ type: 'error', message: 'stream error: 429 Too Many Requests' })).toBe(true);
    expect(isLimit({ type: 'process.exit', code: 1, stderr: 'ERROR: You exceeded your current quota' })).toBe(true);
  });

  it('recognises the texts Claude Code and Codex print today', () => {
    for (const message of [
      "You've hit your session limit · resets 3pm (Asia/Jakarta)", // Claude Code
      "You've hit your weekly limit · resets Oct 20",
      'Claude AI usage limit reached|1792333200',
      "You’ve hit your usage limit. Upgrade to Plus to continue using Codex (https://chatgpt.com/explore/plus), or try again at 3:04 PM.", // Codex
      "You’ve hit your usage limit for gpt-6-sol. Switch to another model now, or try again at Oct 20th, 2026 3:04 PM.",
      'Your workspace is out of credits. Add credits to continue using Codex.',
      'You hit your spend cap set by the owner of your workspace. Ask an owner to increase your spend cap to continue.',
      "Usage limit reached. You've reached your usage limit. Increase your limits to continue using codex.",
    ]) expect(isLimit({ type: 'turn.failed', error: { message } }), message).toBe(true);
  });

  it('trusts a failure the CLI marked as a usage limit, whatever its text', () => {
    expect(isLimit({ type: 'turn.failed', error: { message: 'API Error' }, limit: { resetsAt: 1 } })).toBe(true);
    expect(isLimit({ type: 'process.exit', code: 1, stderr: '', limit: {} }, /never/)).toBe(true);
  });

  it('ignores unrelated failures, including look-alike words and numbers', () => {
    expect(isLimit({ type: 'turn.failed', error: { message: 'boom' } })).toBe(false);
    expect(isLimit({ type: 'process.exit', code: 1, stderr: 'permission denied' })).toBe(false);
    expect(isLimit({ type: 'process.exit', code: 1, stderr: 'write failed: Disk quota exceeded' })).toBe(false);
    expect(isLimit({ type: 'process.exit', code: 1, stderr: 'panic at src/parser.rs:429' })).toBe(false);
    expect(isLimit({ type: 'turn.failed', error: { message: 'tool output was 429 bytes' } })).toBe(false);
  });

  it('only reads the error message, not unrelated fields of the event', () => {
    expect(isLimit({ type: 'turn.failed', error: { message: 'boom' }, detail: 'usage limit' })).toBe(false);
  });

  it('honours a custom regex', () => {
    expect(isLimit({ type: 'error', message: 'plan exhausted' }, /exhausted/)).toBe(true);
  });
});

describe('retryAfterMs', () => {
  const ev = (message: string) => ({ type: 'turn.failed', error: { message } });

  it('reads "try again in N units" from the message', () => {
    expect(retryAfterMs(ev('usage limit. Try again in 3 minutes.'), 1)).toBe(180_000);
    expect(retryAfterMs(ev('rate limit, try again in 2 hours'), 1)).toBe(7_200_000);
    expect(retryAfterMs(ev('rate limit, try again in 30 seconds'), 1)).toBe(30_000);
  });

  it('falls back when there is no hint, and caps absurd hints at 24 hours', () => {
    expect(retryAfterMs(ev('usage limit reached'), 555)).toBe(555);
    expect(retryAfterMs(ev('usage limit, try again in 9 days'), 555)).toBe(24 * 3_600_000);
  });

  it('reads the reset time a marked failure carries', () => {
    const now = 1_800_000_000_000;
    expect(retryAfter({ type: 'turn.failed', error: { message: 'x' }, limit: { resetsAt: now / 1000 + 5400 } }, now)).toBe(5_400_000);
    expect(retryAfter({ type: 'turn.failed', error: { message: 'x' }, limit: { resetsAt: now / 1000 - 5 } }, now)).toBeNull(); // already past
    expect(retryAfter({ type: 'turn.failed', error: { message: 'x' }, limit: {} }, now)).toBeNull();
  });

  it("reads Codex's local \"try again at\" time, today, tomorrow or on a date", () => {
    const now = new Date(2026, 9, 18, 13, 0, 0).getTime(); // 18 Oct 2026, 1:00 PM local
    expect(retryAfter(ev('usage limit, or try again at 3:04 PM.'), now)).toBe((2 * 60 + 4) * 60_000);
    expect(retryAfter(ev('usage limit, or try again at 12:30 PM.'), now)).toBe((23 * 60 + 30) * 60_000); // passed: tomorrow
    expect(retryAfter(ev('usage limit, or try again at Oct 19th, 2026 9:00 AM.'), now)).toBe(20 * 3_600_000);
    expect(retryAfter(ev('usage limit, or try again at Oct 25th, 2026 9:00 AM.'), now)).toBe(24 * 3_600_000); // capped
    expect(retryAfter(ev('usage limit, try again later.'), now)).toBeNull();
  });
});

describe('windowsResetMs', () => {
  it('waits for the latest used-up window to reset', () => {
    const now = 1_000_000_000;
    const s = now / 1000;
    expect(windowsResetMs([{ usedPercent: 100, resetsAt: s + 60 }, { usedPercent: 40, resetsAt: s + 9000 }], now)).toBe(60_000);
    expect(windowsResetMs([{ usedPercent: 100, resetsAt: s + 60 }, { usedPercent: 100, resetsAt: s + 600 }], now)).toBe(600_000);
    expect(windowsResetMs([{ usedPercent: 99, resetsAt: s + 60 }], now)).toBeNull();
    expect(windowsResetMs([{ usedPercent: 100, resetsAt: s - 60 }], now)).toBeNull();
  });
});

describe('linkSessions', () => {
  it('shares the primary sessions dir with the other homes and leaves existing dirs alone', () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), 'lzvr-link-')));
    const [a, b, c] = ['a', 'b', 'c'].map((n) => join(base, n)) as [string, string, string];
    mkdirSync(join(c, 'sessions'), { recursive: true });
    writeFileSync(join(c, 'sessions', 'keep.txt'), 'x');

    const skipped = linkSessions([a, b, c]);

    expect(lstatSync(join(b, 'sessions')).isSymbolicLink()).toBe(true);
    writeFileSync(join(a, 'sessions', 'rollout.jsonl'), 'x');
    expect(existsSync(join(b, 'sessions', 'rollout.jsonl'))).toBe(true);
    expect(lstatSync(join(c, 'sessions')).isSymbolicLink()).toBe(false);
    expect(skipped).toEqual([c]);
    expect(lstatSync(join(b, 'memories')).isSymbolicLink()).toBe(true);
    writeFileSync(join(a, 'memories', 'note.md'), 'x');
    expect(existsSync(join(b, 'memories', 'note.md'))).toBe(true);
    expect(linkSessions([a, b, c])).toEqual([c]); // idempotent
  });
});

describe('Accounts on/off', () => {
  it('never picks a switched-off account and reports it', () => {
    const a = new Accounts(['/x/a', '/x/b']);
    a.setEnabled('/x/a', false);
    expect(a.pick()).toBe('/x/b');
    expect(a.list()).toMatchObject([{ name: 'a', enabled: false }, { name: 'b', enabled: true }]);
    a.setEnabled('/x/b', false);
    expect(a.pick()).toBeNull();
    a.setEnabled('/x/a', true);
    expect(a.pick()).toBe('/x/a');
  });
});

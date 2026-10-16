import { existsSync, lstatSync, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { Accounts, isLimit, linkSessions, retryAfterMs } from '../src/accounts.js';

describe('Accounts', () => {
  it('picks the first unblocked account, in configured order', () => {
    const a = new Accounts(['/h/a', '/h/b']);
    expect(a.pick()).toBe('/h/a');
    a.block('/h/a');
    expect(a.pick()).toBe('/h/b');
    a.block('/h/b');
    expect(a.pick()).toBeNull();
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

import { describe, expect, it } from 'vitest';
import { CronError, nextRun, parseCron } from '../src/cron.js';

/** Local time, as cron reads it. */
const at = (y: number, mo: number, d: number, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const next = (expr: string, from: number) => nextRun(parseCron(expr), from);

describe('cron', () => {
  it('finds the next matching minute, strictly after the given time', () => {
    expect(next('0 9 * * *', at(2026, 10, 14, 8, 30))).toBe(at(2026, 10, 14, 9, 0));
    expect(next('0 9 * * *', at(2026, 10, 14, 9, 0))).toBe(at(2026, 10, 15, 9, 0));
    expect(next('*/15 * * * *', at(2026, 10, 14, 9, 7))).toBe(at(2026, 10, 14, 9, 15));
    expect(next('@hourly', at(2026, 10, 14, 9, 7))).toBe(at(2026, 10, 14, 10, 0));
  });

  it('handles weekdays, ranges, lists and Sunday as 0 or 7', () => {
    // 2026-10-17 is a Saturday
    expect(next('0 9 * * 1-5', at(2026, 10, 17, 12))).toBe(at(2026, 10, 19, 9));
    expect(next('30 8,17 * * *', at(2026, 10, 14, 9))).toBe(at(2026, 10, 14, 17, 30));
    expect(next('0 0 * * 7', at(2026, 10, 14))).toBe(at(2026, 10, 18));
    expect(next('0 0 * * 0', at(2026, 10, 14))).toBe(at(2026, 10, 18));
  });

  it('crosses months and years, and matches either day field when both are set', () => {
    expect(next('0 0 1 * *', at(2026, 12, 15))).toBe(at(2027, 1, 1));
    expect(next('0 0 29 2 *', at(2026, 3, 1))).toBe(at(2028, 2, 29));
    // the 20th, or any Monday: Monday 19th comes first
    expect(next('0 0 20 * 1', at(2026, 10, 14))).toBe(at(2026, 10, 19));
  });

  it('stays strictly after the given time through the hour a clock change repeats, and skips the one it drops', () => {
    const tz = process.env.TZ;
    process.env.TZ = 'America/Chicago'; // 2026-11-01 02:00 CDT goes back to 01:00 CST; 2026-03-08 02:00 CST jumps to 03:00 CDT
    try {
      const second = Date.parse('2026-11-01T07:10:00Z'); // 01:10 the second time
      expect(next('*/5 * * * *', second)).toBe(Date.parse('2026-11-01T07:15:00Z'));
      expect(next('30 1 * * *', second)).toBe(Date.parse('2026-11-01T07:30:00Z'));
      // From 01:40 the first time, the hour step goes on to 02:00: a daily job runs once, not again in the repeat.
      expect(next('30 1 * * *', Date.parse('2026-11-01T06:40:00Z'))).toBe(Date.parse('2026-11-02T07:30:00Z'));
      expect(next('0 2 * * *', second)).toBe(Date.parse('2026-11-01T08:00:00Z'));
      expect(next('30 2 * * *', Date.parse('2026-03-08T07:30:00Z'))).toBe(Date.parse('2026-03-09T07:30:00Z')); // no 02:30 that day
      expect(next('*/15 * * * *', Date.parse('2026-03-08T07:50:00Z'))).toBe(Date.parse('2026-03-08T08:00:00Z')); // 01:50, then 03:00
    } finally {
      if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
    }
  });

  it('rejects malformed expressions and reports ones that never run', () => {
    for (const bad of ['', '* * * *', '60 * * * *', '* 24 * * *', '5-1 * * * *', '*/0 * * * *', 'a * * * *', '* * * * * *']) {
      expect(() => parseCron(bad), bad).toThrow(CronError);
    }
    expect(next('0 0 31 2 *', at(2026, 1, 1))).toBeNull();
  });
});

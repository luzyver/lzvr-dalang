/**
 * Five-field cron expressions (`minute hour day-of-month month day-of-week`) in the server's local time, as crontab
 * reads them: `*`, lists (`1,15`), ranges (`1-5`), steps (`*\/15`, `9-17/2`), day-of-week 0-7 (0 and 7 are Sunday), and
 * the shorthands @hourly, @daily, @weekly, @monthly, @yearly. When both day fields are restricted, either one matching
 * is enough (crontab's rule); a field starting with `*` counts as unrestricted.
 */
export class CronError extends Error {}

export interface Cron {
  minute: Set<number>; hour: Set<number>; dom: Set<number>; month: Set<number>; dow: Set<number>;
  domAny: boolean; dowAny: boolean;
}

const SHORTHANDS: Record<string, string> = {
  '@hourly': '0 * * * *', '@daily': '0 0 * * *', '@midnight': '0 0 * * *', '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *', '@yearly': '0 0 1 1 *', '@annually': '0 0 1 1 *',
};
const FIELDS = [['minute', 0, 59], ['hour', 0, 23], ['day of month', 1, 31], ['month', 1, 12], ['day of week', 0, 7]] as const;

function field(text: string, [name, min, max]: (typeof FIELDS)[number]): Set<number> {
  const out = new Set<number>();
  for (const part of text.split(',')) {
    const m = /^(\*|(\d+)(?:-(\d+))?)(?:\/(\d+))?$/.exec(part);
    if (!m) throw new CronError(`bad ${name}: ${part}`);
    const from = m[1] === '*' ? min : Number(m[2]);
    const to = m[1] === '*' ? max : m[3] !== undefined ? Number(m[3]) : m[4] !== undefined ? max : from;
    const step = m[4] !== undefined ? Number(m[4]) : 1;
    if (from < min || to > max || from > to || step < 1) throw new CronError(`${name} must be ${min}-${max}: ${part}`);
    for (let v = from; v <= to; v += step) out.add(v);
  }
  return out;
}

export function parseCron(expr: string): Cron {
  const text = SHORTHANDS[expr.trim().toLowerCase()] ?? expr.trim();
  const parts = text.split(/\s+/);
  if (parts.length !== 5) throw new CronError('a schedule has 5 fields: minute hour day-of-month month day-of-week');
  const [minute, hour, dom, month, dow] = parts.map((p, i) => field(p, FIELDS[i]!));
  if (dow!.delete(7)) dow!.add(0);
  return { minute: minute!, hour: hour!, dom: dom!, month: month!, dow: dow!, domAny: parts[2]!.startsWith('*'), dowAny: parts[4]!.startsWith('*') };
}

function dayMatches(c: Cron, d: Date): boolean {
  const dom = c.dom.has(d.getDate());
  const dow = c.dow.has(d.getDay());
  return c.domAny || c.dowAny ? dom && dow : dom || dow;
}

/** The first minute strictly after `after` that the expression matches (ms), or null if it never does within 5 years. */
export function nextRun(c: Cron, after: number): number | null {
  const d = new Date(after);
  d.setSeconds(0, 0);
  d.setMinutes(d.getMinutes() + 1);
  const end = after + 5 * 366 * 86_400_000;
  while (d.getTime() <= end) {
    if (!c.month.has(d.getMonth() + 1)) { d.setMonth(d.getMonth() + 1, 1); d.setHours(0, 0); continue; }
    if (!dayMatches(c, d)) { d.setDate(d.getDate() + 1); d.setHours(0, 0); continue; }
    if (!c.hour.has(d.getHours())) { d.setHours(d.getHours() + 1, 0); continue; }
    if (!c.minute.has(d.getMinutes())) { d.setMinutes(d.getMinutes() + 1); continue; }
    return d.getTime();
  }
  return null;
}

/**
 * Read-only ClickUp Chat client for the MCP gateway: lists chat channels and reads messages in a date range, each
 * stamped with its local date and time and whether it fell outside working hours (to answer "when did I work late,
 * and on what"). Uses a personal API token (pk_...), so it sees what that ClickUp user sees.
 */

export interface ClickUpOpts {
  token: string;
  /** Workspace (team) id; the token's first workspace when unset. */
  workspaceId?: string;
  /** IANA time zone the dates are read in; the ClickUp user's own time zone when unset. */
  timeZone?: string;
  /** Normal working hours, `HH:MM-HH:MM`. Anything outside, and all of Saturday and Sunday, counts as overtime. */
  workHours: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface HistoryQuery {
  /** Local dates `YYYY-MM-DD`, both included. */
  from: string;
  to: string;
  channelIds?: string[];
  /** Only messages written by the token's own user (default true). */
  mineOnly?: boolean;
  overtimeOnly?: boolean;
  workHours?: string;
  /** Also read thread replies (one more request per thread, so slower). */
  includeReplies?: boolean;
  limit?: number;
}

interface Channel { id: string; name: string; type: string }
interface RawMessage { id: string; user_id: string; content?: string; date: number; replies_count?: number; parent_message?: string }

export const DEFAULT_WORK_HOURS = '09:00-18:00';
const DAY_MS = 86_400_000;
const MAX_DAYS = 93;
const MAX_REQUESTS = 250; // per call, so one question cannot spend the whole ClickUp rate limit (100/min on most plans)
const MAX_CONTENT = 1500;
const REPLY_LOOKBACK_MS = 7 * DAY_MS; // threads started this long before `from` are still read for replies
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `09:00-18:00` -> minutes after midnight; throws on anything else. */
export function parseWorkHours(s: string): { start: number; end: number } {
  const m = /^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/.exec(s.trim());
  const start = m ? Number(m[1]) * 60 + Number(m[2]) : NaN;
  const end = m ? Number(m[3]) * 60 + Number(m[4]) : NaN;
  if (!(start >= 0 && end <= 24 * 60 && start < end && Number(m![2]) < 60 && Number(m![4]) < 60)) {
    throw new Error(`work hours must look like 09:00-18:00 (got ${s})`);
  }
  return { start, end };
}

export function validTimeZone(tz: string): boolean {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return true; } catch { return false; }
}

/** Wall-clock parts of `ms` in `tz`. */
export function localParts(ms: number, tz: string) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    weekday: 'short', hourCycle: 'h23',
  }).formatToParts(ms);
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const hour = Number(p.hour) % 24;
  return {
    date: `${p.year}-${p.month}-${p.day}`, time: `${String(hour).padStart(2, '0')}:${p.minute}`, weekday: p.weekday!,
    minutes: hour * 60 + Number(p.minute), offsetMs: Date.UTC(+p.year!, +p.month! - 1, +p.day!, hour, +p.minute!, +p.second!) - Math.floor(ms / 1000) * 1000,
  };
}

/** Epoch ms of local midnight starting `date` (YYYY-MM-DD) in `tz`. */
export function startOfDay(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  const first = guess - localParts(guess, tz).offsetMs;
  return guess - localParts(first, tz).offsetMs; // second pass settles days where the offset changes (DST)
}

export const isOvertime = (weekday: string, minutes: number, h: { start: number; end: number }) =>
  weekday === 'Sat' || weekday === 'Sun' || minutes < h.start || minutes >= h.end;

export class ClickUpError extends Error {}

const channelName = (c: any): string =>
  c.name ? String(c.name) : c.type === 'DM' ? 'Direct message' : c.type === 'GROUP_DM' ? 'Group DM' : String(c.id);

export class ClickUp {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private me?: Promise<{ id: string; username: string; email: string; timezone: string | null }>;
  private team?: Promise<{ id: string; name: string; members: Map<string, string> }>;

  constructor(private readonly o: ClickUpOpts) {
    parseWorkHours(o.workHours);
    if (o.timeZone && !validTimeZone(o.timeZone)) throw new Error(`unknown time zone: ${o.timeZone}`);
    this.base = (o.baseUrl ?? 'https://api.clickup.com').replace(/\/+$/, '');
    this.fetch = o.fetch ?? fetch;
  }

  /** One GET, counted against `budget`. A 429 is retried once after a short wait; a longer wait is reported instead. */
  private async get(path: string, query: Record<string, string | number | boolean | undefined> = {}, budget?: { left: number }): Promise<any> {
    if (budget && budget.left-- <= 0) throw new ClickUpError('request budget for this call used up');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ''}`;
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, { headers: { authorization: this.o.token, accept: 'application/json' }, signal: AbortSignal.timeout(20_000) });
      if (res.status === 429 && attempt === 0) {
        const reset = Number(res.headers.get('x-ratelimit-reset')) * 1000;
        const wait = reset ? reset - Date.now() : 5_000;
        if (wait <= 10_000) { await new Promise((r) => setTimeout(r, Math.max(wait, 500))); continue; }
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        throw new ClickUpError(`ClickUp ${res.status} on ${path}: ${body.slice(0, 300)}`);
      }
      return res.json();
    }
  }

  private user() {
    this.me ??= this.get('/api/v2/user').then((r) => ({
      id: String(r.user.id), username: r.user.username ?? '', email: r.user.email ?? '', timezone: r.user.timezone ?? null,
    }));
    this.me.catch(() => { this.me = undefined; }); // a failure is not remembered
    return this.me;
  }

  private workspace() {
    this.team ??= this.get('/api/v2/team').then((r) => {
      const teams: any[] = r.teams ?? [];
      const t = this.o.workspaceId ? teams.find((x) => String(x.id) === this.o.workspaceId) : teams[0];
      if (!t) throw new ClickUpError(this.o.workspaceId ? `the token has no workspace ${this.o.workspaceId}` : 'the token has no workspace');
      const members = new Map<string, string>();
      for (const m of t.members ?? []) if (m.user) members.set(String(m.user.id), m.user.username || m.user.email || String(m.user.id));
      return { id: String(t.id), name: String(t.name ?? ''), members };
    });
    this.team.catch(() => { this.team = undefined; });
    return this.team;
  }

  async timeZone(): Promise<string> {
    if (this.o.timeZone) return this.o.timeZone;
    const tz = (await this.user()).timezone;
    return tz && validTimeZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  async whoami() {
    const [me, ws, tz] = await Promise.all([this.user(), this.workspace(), this.timeZone()]);
    return { user: { id: me.id, username: me.username, email: me.email }, workspace: { id: ws.id, name: ws.name }, time_zone: tz, work_hours: this.o.workHours };
  }

  /** Chat channels, DMs and group DMs the user can see; with `sinceMs`, only those with a message since then. */
  async channels(sinceMs?: number, budget: { left: number } = { left: MAX_REQUESTS }): Promise<Channel[]> {
    const ws = await this.workspace();
    const out: Channel[] = [];
    let cursor: string | undefined;
    do {
      const r = await this.get(`/api/v3/workspaces/${ws.id}/chat/channels`,
        { limit: 100, cursor, with_message_since: sinceMs, include_closed: true }, budget);
      for (const c of r.data ?? []) out.push({ id: String(c.id), name: channelName(c), type: String(c.type ?? '') });
      cursor = r.next_cursor || undefined;
    } while (cursor);
    return out;
  }

  /** Top-level messages of a channel from `fromMs` on (newest first from the API), and optionally their replies. */
  private async channelMessages(wsId: string, channelId: string, fromMs: number, toMs: number, replies: boolean, budget: { left: number }) {
    const out: RawMessage[] = [];
    const threads: RawMessage[] = [];
    const oldest = replies ? fromMs - REPLY_LOOKBACK_MS : fromMs;
    let cursor: string | undefined;
    pages: do {
      const r = await this.get(`/api/v3/workspaces/${wsId}/chat/channels/${channelId}/messages`,
        { limit: 100, cursor, content_format: 'text/plain' }, budget);
      for (const m of (r.data ?? []) as RawMessage[]) {
        if (m.date < oldest) break pages;
        if (m.date >= fromMs && m.date < toMs) out.push(m);
        if (replies && (m.replies_count ?? 0) > 0 && m.date < toMs) threads.push(m);
      }
      cursor = r.next_cursor || undefined;
    } while (cursor);
    for (const t of threads) {
      let rc: string | undefined;
      do {
        const r = await this.get(`/api/v3/workspaces/${wsId}/chat/messages/${t.id}/replies`,
          { limit: 100, cursor: rc, content_format: 'text/plain' }, budget);
        for (const m of (r.data ?? []) as RawMessage[]) {
          if (m.date >= fromMs && m.date < toMs) out.push({ ...m, parent_message: t.id });
        }
        rc = r.next_cursor || undefined;
      } while (rc);
    }
    return out;
  }

  async history(q: HistoryQuery) {
    if (!DATE_RE.test(q.from) || !DATE_RE.test(q.to)) throw new ClickUpError('from and to must be dates like 2026-10-01');
    const hours = parseWorkHours(q.workHours ?? this.o.workHours);
    const [me, ws, tz] = await Promise.all([this.user(), this.workspace(), this.timeZone()]);
    const fromMs = startOfDay(q.from, tz);
    const [y, m, d] = q.to.split('-').map(Number);
    const endMs = startOfDay(new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10), tz); // midnight after `to`
    if (endMs <= fromMs) throw new ClickUpError('to must not be before from');
    if (endMs - fromMs > MAX_DAYS * DAY_MS) throw new ClickUpError(`at most ${MAX_DAYS} days per call; split the range`);

    const budget = { left: MAX_REQUESTS };
    const warnings: string[] = [];
    const all = await this.channels(fromMs - (q.includeReplies ? REPLY_LOOKBACK_MS : 0), budget);
    const channels = q.channelIds?.length ? all.filter((c) => q.channelIds!.includes(c.id)) : all;
    for (const id of q.channelIds ?? []) if (!all.some((c) => c.id === id)) warnings.push(`channel ${id} not found or has no messages in the range`);

    const raw: { m: RawMessage; c: Channel }[] = [];
    for (const c of channels) {
      try {
        for (const m of await this.channelMessages(ws.id, c.id, fromMs, endMs, Boolean(q.includeReplies), budget)) raw.push({ m, c });
      } catch (e) {
        warnings.push(`${c.name}: ${(e as Error).message}`);
        if (budget.left <= 0) { warnings.push('stopped early: too many ClickUp requests for one call; narrow the range or pick channels'); break; }
      }
    }

    const mineOnly = q.mineOnly ?? true;
    const rows = raw
      .filter(({ m }) => !mineOnly || String(m.user_id) === me.id)
      .map(({ m, c }) => {
        const p = localParts(m.date, tz);
        const content = (m.content ?? '').trim();
        return {
          id: m.id, date: p.date, time: p.time, weekday: p.weekday, overtime: isOvertime(p.weekday, p.minutes, hours),
          channel: c.name, channel_id: c.id, author: ws.members.get(String(m.user_id)) ?? String(m.user_id),
          ...(m.parent_message && { reply_to: m.parent_message }),
          content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}…` : content,
          ts: m.date,
        };
      })
      .sort((a, b) => a.ts - b.ts);

    // One line per day that has messages: when the first and last ones were, and how many fell outside hours.
    const days = new Map<string, { date: string; weekday: string; messages: number; overtime_messages: number; first: string; last: string }>();
    for (const r of rows) {
      const d = days.get(r.date);
      if (!d) days.set(r.date, { date: r.date, weekday: r.weekday, messages: 1, overtime_messages: r.overtime ? 1 : 0, first: r.time, last: r.time });
      else { d.messages++; if (r.overtime) d.overtime_messages++; d.last = r.time; }
    }

    const picked = q.overtimeOnly ? rows.filter((r) => r.overtime) : rows;
    const limit = q.limit ?? 300;
    if (picked.length > limit) warnings.push(`${picked.length} messages matched; only the last ${limit} are listed (raise limit or narrow the range)`);
    return {
      time_zone: tz, work_hours: q.workHours ?? this.o.workHours, overtime_rule: 'outside work hours, or any time on Saturday/Sunday',
      range: { from: q.from, to: q.to }, user: mineOnly ? me.username : 'everyone', channels_read: channels.length,
      days: [...days.values()].filter((d) => !q.overtimeOnly || d.overtime_messages > 0),
      messages: picked.slice(-limit).map(({ ts: _ts, ...r }) => r),
      ...(warnings.length && { warnings }),
    };
  }
}

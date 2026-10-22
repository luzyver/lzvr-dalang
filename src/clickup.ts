/**
 * ClickUp Chat client for the MCP gateway: lists chat channels, reads messages in a date range, each stamped with its
 * local date, time and weekday, and sends a message or thread reply. Uses a personal API token (pk_...), so it sees
 * what that ClickUp user sees and sends as them.
 */

export interface ClickUpOpts {
  token: string;
  /** Workspace (team) id read when a call names none; every workspace the token can see when unset. */
  workspaceId?: string;
  /** IANA time zone the dates are read in; the ClickUp user's own time zone when unset. */
  timeZone?: string;
  baseUrl?: string;
  fetch?: typeof fetch;
}

export interface HistoryQuery {
  /** Local dates `YYYY-MM-DD`, both included. */
  from: string;
  to: string;
  /** Default: the configured workspace, else all of them. */
  workspaceIds?: string[];
  channelIds?: string[];
  /** Only messages written by the token's own user (default true). */
  mineOnly?: boolean;
  /** Also read thread replies (one more request per thread, so slower). */
  includeReplies?: boolean;
  limit?: number;
}

export interface SendQuery {
  channelId: string;
  /** Markdown. */
  content: string;
  /** Reply in the thread of this message instead of posting to the channel. */
  replyTo?: string;
  /** The channel's workspace; looked for among the workspaces read by default when unset. */
  workspaceId?: string;
}

interface Channel { id: string; name: string; type: string; workspace_id: string; workspace: string }
interface Workspace { id: string; name: string; members: Map<string, string> }
interface RawMessage { id: string; user_id: string; content?: string; date: number; replies_count?: number; parent_message?: string }

const DAY_MS = 86_400_000;
const MAX_DAYS = 93;
const MAX_REQUESTS = 250; // per call, so one question cannot spend the whole ClickUp rate limit (100/min on most plans)
const MAX_CONTENT = 1500;
export const MAX_SEND = 4000;
const REPLY_LOOKBACK_MS = 7 * DAY_MS; // threads started this long before `from` are still read for replies
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
    offsetMs: Date.UTC(+p.year!, +p.month! - 1, +p.day!, hour, +p.minute!, +p.second!) - Math.floor(ms / 1000) * 1000,
  };
}

/** Epoch ms of local midnight starting `date` (YYYY-MM-DD) in `tz`. */
export function startOfDay(date: string, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const guess = Date.UTC(y!, m! - 1, d!);
  const first = guess - localParts(guess, tz).offsetMs;
  return guess - localParts(first, tz).offsetMs; // second pass settles days where the offset changes (DST)
}

export class ClickUpError extends Error {}

const channelName = (c: any): string =>
  c.name ? String(c.name) : c.type === 'DM' ? 'Direct message' : c.type === 'GROUP_DM' ? 'Group DM' : String(c.id);

export class ClickUp {
  private readonly base: string;
  private readonly fetch: typeof fetch;
  private me?: Promise<{ id: string; username: string; email: string; timezone: string | null }>;
  private teams?: Promise<Workspace[]>;
  private dmNames = new Map<string, string>(); // DM channel id -> "DM with ...", learned once

  constructor(private readonly o: ClickUpOpts) {
    if (o.timeZone && !validTimeZone(o.timeZone)) throw new Error(`unknown time zone: ${o.timeZone}`);
    this.base = (o.baseUrl ?? 'https://api.clickup.com').replace(/\/+$/, '');
    this.fetch = o.fetch ?? fetch;
  }

  /** One GET, counted against `budget`. */
  private get(path: string, query: Record<string, string | number | boolean | undefined> = {}, budget?: { left: number }): Promise<any> {
    return this.request('GET', path, query, undefined, budget);
  }

  /** One request. A 429 is retried once after a short wait (ClickUp did nothing then); a longer wait is reported instead. */
  private async request(method: 'GET' | 'POST', path: string, query: Record<string, string | number | boolean | undefined>,
    payload?: unknown, budget?: { left: number }): Promise<any> {
    if (budget && budget.left-- <= 0) throw new ClickUpError('request budget for this call used up');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, String(v));
    const url = `${this.base}${path}${qs.size ? `?${qs}` : ''}`;
    const headers: Record<string, string> = { authorization: this.o.token, accept: 'application/json' };
    if (payload !== undefined) headers['content-type'] = 'application/json';
    for (let attempt = 0; ; attempt++) {
      const res = await this.fetch(url, {
        method, headers, body: payload === undefined ? undefined : JSON.stringify(payload), signal: AbortSignal.timeout(20_000),
      });
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

  /** Every workspace the token can see, with its members' names. */
  private allWorkspaces() {
    this.teams ??= this.get('/api/v2/team').then((r) => ((r.teams ?? []) as any[]).map((t) => {
      const members = new Map<string, string>();
      for (const m of t.members ?? []) if (m.user) members.set(String(m.user.id), m.user.username || m.user.email || String(m.user.id));
      return { id: String(t.id), name: String(t.name ?? ''), members };
    }));
    this.teams.catch(() => { this.teams = undefined; });
    return this.teams;
  }

  /** The workspaces a call reads: the ones it names, else the configured one, else all. */
  private async workspaces(ids?: string[]): Promise<Workspace[]> {
    const all = await this.allWorkspaces();
    const want = ids?.length ? ids : this.o.workspaceId ? [this.o.workspaceId] : null;
    if (!want) {
      if (!all.length) throw new ClickUpError('the token has no workspace');
      return all;
    }
    const unknown = want.filter((id) => !all.some((w) => w.id === id));
    if (unknown.length) throw new ClickUpError(`the token has no workspace ${unknown.join(', ')} (it has: ${all.map((w) => `${w.id} ${w.name}`).join(', ')})`);
    return all.filter((w) => want.includes(w.id));
  }

  async timeZone(): Promise<string> {
    if (this.o.timeZone) return this.o.timeZone;
    const tz = (await this.user()).timezone;
    return tz && validTimeZone(tz) ? tz : Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  async whoami() {
    const [me, all, tz] = await Promise.all([this.user(), this.allWorkspaces(), this.timeZone()]);
    return {
      user: { id: me.id, username: me.username, email: me.email }, workspaces: all.map((w) => ({ id: w.id, name: w.name })),
      default_workspace: this.o.workspaceId ?? 'all', time_zone: tz,
    };
  }

  /**
   * Chat channels, DMs and group DMs the user can see, in the given workspaces (default: see `workspaces`); with
   * `sinceMs`, only those with a message since then. DMs are named after who they are with.
   */
  async channels(sinceMs?: number, workspaceIds?: string[], budget: { left: number } = { left: MAX_REQUESTS }): Promise<Channel[]> {
    const out: Channel[] = [];
    for (const ws of await this.workspaces(workspaceIds)) {
      let cursor: string | undefined;
      do {
        const r = await this.get(`/api/v3/workspaces/${ws.id}/chat/channels`,
          { limit: 100, cursor, with_message_since: sinceMs, include_closed: true }, budget);
        for (const c of r.data ?? []) {
          const id = String(c.id);
          out.push({ id, name: this.dmNames.get(id) ?? channelName(c), type: String(c.type ?? ''), workspace_id: ws.id, workspace: ws.name });
        }
        cursor = r.next_cursor || undefined;
      } while (cursor);
    }
    await this.nameDms(out, budget);
    return out;
  }

  /** "DM with sari" / "Group DM: sari, budi" for unnamed DMs: one request each (first page of members), best effort. */
  private async nameDms(channels: Channel[], budget: { left: number }): Promise<void> {
    const me = await this.user();
    for (const c of channels) {
      if ((c.type !== 'DM' && c.type !== 'GROUP_DM') || this.dmNames.has(c.id) || budget.left <= 0) continue;
      try {
        const r = await this.get(`/api/v3/workspaces/${c.workspace_id}/chat/channels/${c.id}/members`, { limit: 100 }, budget);
        const others = ((r.data ?? []) as any[]).filter((m) => String(m.id) !== me.id).map((m) => m.username || m.name || m.email);
        if (!others.length) continue;
        c.name = c.type === 'DM' ? `DM with ${others[0]}` : `Group DM: ${others.join(', ')}`;
        this.dmNames.set(c.id, c.name);
      } catch { /* keep the generic name */ }
    }
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
    const [me, workspaces, tz] = await Promise.all([this.user(), this.workspaces(q.workspaceIds), this.timeZone()]);
    const members = new Map(workspaces.map((w) => [w.id, w.members]));
    const fromMs = startOfDay(q.from, tz);
    const [y, m, d] = q.to.split('-').map(Number);
    const endMs = startOfDay(new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10), tz); // midnight after `to`
    if (endMs <= fromMs) throw new ClickUpError('to must not be before from');
    if (endMs - fromMs > MAX_DAYS * DAY_MS) throw new ClickUpError(`at most ${MAX_DAYS} days per call; split the range`);

    const budget = { left: MAX_REQUESTS };
    const warnings: string[] = [];
    const all = await this.channels(fromMs - (q.includeReplies ? REPLY_LOOKBACK_MS : 0), workspaces.map((w) => w.id), budget);
    const channels = q.channelIds?.length ? all.filter((c) => q.channelIds!.includes(c.id)) : all;
    for (const id of q.channelIds ?? []) if (!all.some((c) => c.id === id)) warnings.push(`channel ${id} not found or has no messages in the range`);

    const raw: { m: RawMessage; c: Channel }[] = [];
    for (const c of channels) {
      try {
        for (const m of await this.channelMessages(c.workspace_id, c.id, fromMs, endMs, Boolean(q.includeReplies), budget)) raw.push({ m, c });
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
          id: m.id, date: p.date, time: p.time, weekday: p.weekday,
          workspace: c.workspace, channel: c.name, channel_id: c.id, author: members.get(c.workspace_id)?.get(String(m.user_id)) ?? String(m.user_id),
          ...(m.parent_message && { reply_to: m.parent_message }),
          content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}…` : content,
          ts: m.date,
        };
      })
      .sort((a, b) => a.ts - b.ts);

    const limit = q.limit ?? 300;
    if (rows.length > limit) warnings.push(`${rows.length} messages matched; only the last ${limit} are listed (raise limit or narrow the range)`);
    return {
      time_zone: tz, range: { from: q.from, to: q.to }, user: mineOnly ? me.username : 'everyone',
      workspaces: workspaces.map((w) => w.name), channels_read: channels.length,
      messages: rows.slice(-limit).map(({ ts: _ts, ...r }) => r),
      ...(warnings.length && { warnings }),
    };
  }

  /** The channel `id` in the first of the given workspaces (default: see `workspaces`) that has it. */
  private async findChannel(id: string, workspaceIds?: string[]): Promise<Channel> {
    for (const ws of await this.workspaces(workspaceIds)) {
      let c: any;
      try {
        const r = await this.get(`/api/v3/workspaces/${ws.id}/chat/channels/${encodeURIComponent(id)}`);
        c = r?.data ?? r;
      } catch (e) {
        if ((e as Error).message.startsWith('ClickUp 404 ')) continue;
        throw e;
      }
      return { id, name: this.dmNames.get(id) ?? channelName({ ...c, id }), type: String(c?.type ?? ''), workspace_id: ws.id, workspace: ws.name };
    }
    throw new ClickUpError(`channel ${id} not found (ids from clickup_list_channels)`);
  }

  /** Send `content` (markdown) as the token's user to a channel or DM, or as a reply in one of its message's threads. */
  async send(q: SendQuery) {
    const content = q.content.trim();
    if (!content) throw new ClickUpError('the message is empty');
    if (content.length > MAX_SEND) throw new ClickUpError(`at most ${MAX_SEND} characters per message`);
    // Everything that can fail is read first: once the POST went through, a later failure would make a retry post twice.
    const [c, tz] = await Promise.all([this.findChannel(q.channelId, q.workspaceId ? [q.workspaceId] : undefined), this.timeZone()]);
    const path = q.replyTo
      ? `/api/v3/workspaces/${c.workspace_id}/chat/messages/${encodeURIComponent(q.replyTo)}/replies`
      : `/api/v3/workspaces/${c.workspace_id}/chat/channels/${encodeURIComponent(c.id)}/messages`;
    const r = await this.request('POST', path, {}, { type: 'message', content, content_format: 'text/md' });
    const m = r?.data ?? r ?? {};
    const p = localParts(typeof m.date === 'number' ? m.date : Date.now(), tz);
    return {
      sent: true, id: m.id ? String(m.id) : null, workspace: c.workspace, channel: c.name, channel_id: c.id,
      ...(q.replyTo && { reply_to: q.replyTo }), date: p.date, time: p.time,
    };
  }
}

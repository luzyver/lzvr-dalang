/**
 * ClickUp client for the MCP gateway, over ClickUp's own MCP server (clickup-mcp.ts) with the person's connection, so
 * it sees what that ClickUp user sees and sends as them. Here: who and where (user, workspace, members) and ClickUp
 * Chat (lists chat channels, reads messages in a date range, each stamped with its local date, time and weekday, lists
 * people and a channel's latest threads, and sends a message, DM or thread reply, with files in the message itself).
 * Tasks, time tracking and Docs are in clickup-work.ts.
 */

import { attachmentRef, ClickUpMcp, type UploadTarget } from './clickup-mcp.js';

export interface ClickUpOpts {
  /** The access token of the person's ClickUp connection. */
  token: string;
  /** Workspace id read when a call names none; the connection's own workspace when unset. */
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
  /** Default: the configured workspace, else the connection's own. */
  workspaceIds?: string[];
  channelIds?: string[];
  /** Only messages written by the connected user (default true). */
  mineOnly?: boolean;
  /** Also read thread replies (one more request per thread, so slower). */
  includeReplies?: boolean;
  limit?: number;
}

export interface SendQuery {
  /** A channel, DM or group DM; or else `toUserId`. */
  channelId?: string;
  /** A person to message directly (their DM is opened, or made, on sending). */
  toUserId?: string;
  /** Markdown. */
  content: string;
  /** Reply in the thread of this message of the channel instead of posting to it. */
  replyTo?: string;
  /** The channel's or person's workspace; the one read by default when unset. */
  workspaceId?: string;
}

/** Where a message goes, checked and named before it is sent (for the approval card, and to send it later). */
export interface Destination {
  workspace_id: string;
  workspace: string;
  /** Unset for a person whose DM is opened only on sending. */
  channel_id?: string;
  channel: string;
  to_user?: { id: string; name: string };
  reply_to?: string;
  /** The message replied to. */
  thread?: { author: string; date: string; time: string; weekday: string; preview: string };
}

/** A file sent with a message or put on a task. */
export interface OutFile { name: string; data: Buffer }
/** A file uploaded to a task; ClickUp does not always say its address. */
export interface Uploaded { name: string; url?: string }
/** An uploaded file named in markdown, as a link when its address is known. */
export const fileLink = (f: Uploaded) => (f.url ? `📎 [${f.name.replace(/[[\]]/g, '')}](${f.url})` : `📎 ${f.name}`);
/** " Already on task …: files." for a failure after files went up, so nobody uploads them twice without knowing. */
export const onTask = (task: TaskRef, files: Uploaded[]) => (files.length ? ` Already on task "${task.name}" (${task.url}): ${files.map(fileLink).join(', ')}.` : '');
/** The task files are uploaded to. */
export interface TaskRef { id: string; name: string; url: string; workspace_id?: string }

interface Channel { id: string; name: string; type: string; workspace_id: string; workspace: string }
interface Person { id: string; name: string; email: string }
export interface Workspace { id: string; name: string; members: Map<string, string>; people: Person[] }
interface RawMessage { id: string; user_id: string; content?: string; date: number; has_replies?: boolean; parent_message?: string }

export const DAY_MS = 86_400_000;
export const MAX_DAYS = 93;
export const MAX_REQUESTS = 250; // per call, so one question cannot spend the whole ClickUp rate limit
const MAX_CONTENT = 1500;
export const MAX_SEND = 4000;
/** Files sent along with one message or change. */
export const MAX_FILES = 5;
const PREVIEW = 200;
const REPLY_LOOKBACK_MS = 7 * DAY_MS; // threads started this long before `from` are still read for replies
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const PARALLEL = 5; // channels read at a time

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

export class ClickUpError extends Error {
  /** 4xx when ClickUp refused and did nothing (the HTTP status, or 400 for a tool that said why). */
  constructor(message: string, readonly status?: number) { super(message); }
}
/** A call failed in a way that does not tell whether ClickUp acted (a 5xx, a timeout, a lost connection, an unclear error). */
export class ClickUpUncertain extends ClickUpError {}

const channelName = (c: any): string =>
  c.name ? String(c.name) : c.type === 'DM' ? 'Direct message' : c.type === 'GROUP_DM' ? 'Group DM' : String(c.id);

/** Runs `fn` over `items`, `n` at a time. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) await fn(items[i++]!); }));
}

const messages = (r: any): RawMessage[] => ((r?.messages ?? r?.replies ?? []) as any[])
  .map((m) => ({ ...m, id: String(m.id), user_id: String(m.user_id ?? ''), date: Number(m.date) }));

export class ClickUp {
  readonly mcp: ClickUpMcp;
  private me?: Promise<{ id: string; username: string; email: string; timezone: string | null }>;
  private teams = new Map<string, Promise<Workspace>>(); // by the id asked for; '' is the connection's own
  private dmNames = new Map<string, string>(); // DM channel id -> "DM with ...", learned once
  private known = new Map<string, Channel>(); // channels seen in a list

  constructor(private readonly o: ClickUpOpts) {
    if (o.timeZone && !validTimeZone(o.timeZone)) throw new Error(`unknown time zone: ${o.timeZone}`);
    this.mcp = new ClickUpMcp({ token: o.token, fetch: o.fetch, baseUrl: o.baseUrl });
  }

  /** One tool of ClickUp's MCP server called in a workspace (default: the configured one, else the connection's own). */
  call(tool: string, args: Record<string, unknown> = {}, workspaceId?: string, budget?: { left: number }): Promise<any> {
    return this.mcp.call(tool, { ...args, workspace_id: workspaceId ?? this.o.workspaceId }, budget);
  }

  user() {
    this.me ??= this.mcp.call('clickup_get_user').then((r) => {
      const u = r?.user ?? r ?? {};
      if (u.id === undefined) throw new ClickUpError('ClickUp did not say who is connected');
      return { id: String(u.id), username: String(u.username ?? ''), email: String(u.email ?? ''), timezone: (u.timezone as string) ?? null };
    });
    this.me.catch(() => { this.me = undefined; }); // a failure is not remembered
    return this.me;
  }

  /** A workspace of the connection with its members' names: the one of `id`, else the configured one, else its own. */
  workspace(id: string | undefined = this.o.workspaceId): Promise<Workspace> {
    const key = id ?? '';
    let p = this.teams.get(key);
    if (!p) {
      p = (async () => {
        let h: any;
        let m: any;
        try {
          [h, m] = await Promise.all([
            this.mcp.call('clickup_get_workspace_hierarchy', { max_depth: '0', limit: 1, workspace_id: id }),
            this.mcp.call('clickup_get_workspace_members', { workspace_id: id }),
          ]);
        } catch (e) {
          if (id && refused(e) && (e as ClickUpError).status !== 401) {
            throw new ClickUpError(`workspace ${id} is not in this ClickUp connection (connect ClickUp again and pick it): ${(e as Error).message}`, 400);
          }
          throw e;
        }
        const root = h?.hierarchy?.root;
        if (!root?.id) throw new ClickUpError('ClickUp named no workspace for this connection');
        const members = new Map<string, string>();
        const people: Person[] = [];
        for (const u of (m?.members ?? []) as any[]) {
          if (u?.id === undefined) continue;
          const person = { id: String(u.id), name: String(u.username || u.name || u.email || u.id), email: String(u.email ?? '') };
          members.set(person.id, person.name);
          people.push(person);
        }
        return { id: String(root.id), name: String(root.name ?? ''), members, people };
      })();
      this.teams.set(key, p);
      p.catch(() => { this.teams.delete(key); });
    }
    return p;
  }

  /** The workspaces a call reads: the ones it names, else the configured one, else the connection's own. */
  async workspaces(ids?: string[]): Promise<Workspace[]> {
    const all = await Promise.all((ids?.length ? [...new Set(ids)] : [undefined]).map((id) => this.workspace(id)));
    return all.filter((w, i) => all.findIndex((x) => x.id === w.id) === i);
  }

  /** The time zone dates are read in. */
  async timeZone(): Promise<string> {
    return this.o.timeZone ?? this.userZone();
  }

  /** The ClickUp user's own time zone, in which ClickUp reads the dates and times it is given. */
  async userZone(): Promise<string> {
    const tz = (await this.user()).timezone;
    return tz && validTimeZone(tz) ? tz : this.o.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  }

  async whoami() {
    const [me, ws, tz] = await Promise.all([this.user(), this.workspace(), this.timeZone()]);
    return {
      user: { id: me.id, username: me.username, email: me.email }, workspaces: [{ id: ws.id, name: ws.name }],
      default_workspace: ws.id, time_zone: tz,
    };
  }

  /** Every chat channel, DM and group DM the user can see in the given workspaces, DMs not named yet. */
  private async listChannels(workspaces: Workspace[], budget: { left: number }): Promise<(Channel & { created?: number })[]> {
    const out: (Channel & { created?: number })[] = [];
    for (const ws of workspaces) {
      let cursor: string | undefined;
      do {
        const r = await this.call('clickup_get_chat_channels', { limit: 100, cursor }, ws.id, budget);
        for (const c of (r?.channels ?? []) as any[]) {
          const id = String(c.id);
          const ch = { id, name: this.dmNames.get(id) ?? channelName(c), type: String(c.type ?? ''), workspace_id: ws.id, workspace: ws.name };
          this.known.set(id, ch);
          out.push({ ...ch, ...(Number(c.created_at) > 0 && { created: Number(c.created_at) }) });
        }
        cursor = (r?.has_more ?? true) ? r?.next_cursor || undefined : undefined;
      } while (cursor);
    }
    return out;
  }

  /**
   * Chat channels, DMs and group DMs the user can see, in the given workspaces (default: see `workspaces`). DMs are
   * named after who wrote in them (ClickUp does not say who a DM is with), one request each, best effort.
   */
  async channels(workspaceIds?: string[], budget: { left: number } = { left: MAX_REQUESTS }): Promise<Channel[]> {
    const [me, workspaces] = await Promise.all([this.user(), this.workspaces(workspaceIds)]);
    const out = await this.listChannels(workspaces, budget);
    await pool(out.filter((c) => this.unnamed(c)), PARALLEL, async (c) => {
      if (budget.left <= 0) return;
      try {
        const r = await this.call('clickup_get_chat_channel_messages', { channel_id: c.id, limit: 50 }, c.workspace_id, budget);
        this.nameDm(c, messages(r), workspaces.find((w) => w.id === c.workspace_id)!, me.id);
      } catch { /* keep the generic name */ }
    });
    return out.map(({ created: _created, ...c }) => c);
  }

  private unnamed(c: Channel) { return (c.type === 'DM' || c.type === 'GROUP_DM') && !this.dmNames.has(c.id); }

  /** "DM with sari" / "Group DM: sari, budi" for an unnamed DM, from who wrote the messages read. */
  private nameDm(c: Channel, read: RawMessage[], ws: Workspace, meId: string): void {
    if (!this.unnamed(c)) return;
    const others = [...new Set(read.map((m) => m.user_id).filter((id) => id && id !== meId))].map((id) => ws.members.get(id) ?? id);
    if (!others.length) return;
    c.name = c.type === 'DM' ? `DM with ${others[0]}` : `Group DM: ${others.join(', ')}`;
    this.dmNames.set(c.id, c.name);
    const k = this.known.get(c.id);
    if (k) k.name = c.name;
  }

  /** Top-level messages of a channel from `fromMs` on (ClickUp gives the newest first), and optionally their replies. */
  private async channelMessages(c: Channel, ws: Workspace, meId: string, fromMs: number, toMs: number, replies: boolean, budget: { left: number }) {
    const out: RawMessage[] = [];
    const threads: RawMessage[] = [];
    const oldest = replies ? fromMs - REPLY_LOOKBACK_MS : fromMs;
    let cursor: string | undefined;
    pages: do {
      const r = await this.call('clickup_get_chat_channel_messages', { channel_id: c.id, limit: 100, cursor }, c.workspace_id, budget);
      const page = messages(r);
      this.nameDm(c, page, ws, meId);
      for (const m of page) {
        if (m.date < oldest) break pages;
        if (m.date >= fromMs && m.date < toMs) out.push(m);
        if (replies && m.has_replies && m.date < toMs) threads.push(m);
      }
      cursor = (r?.has_more ?? true) ? r?.next_cursor || undefined : undefined;
    } while (cursor);
    for (const t of threads) {
      let rc: string | undefined;
      do {
        const r = await this.call('clickup_get_chat_message_replies', { message_id: t.id, limit: 100, cursor: rc }, c.workspace_id, budget);
        for (const m of messages(r)) {
          if (m.date >= fromMs && m.date < toMs) out.push({ ...m, parent_message: t.id });
        }
        rc = (r?.has_more ?? true) ? r?.next_cursor || undefined : undefined;
      } while (rc);
    }
    return out;
  }

  async history(q: HistoryQuery) {
    if (!DATE_RE.test(q.from) || !DATE_RE.test(q.to)) throw new ClickUpError('from and to must be dates like 2026-10-01');
    const [me, workspaces, tz] = await Promise.all([this.user(), this.workspaces(q.workspaceIds), this.timeZone()]);
    const byId = new Map(workspaces.map((w) => [w.id, w]));
    const fromMs = startOfDay(q.from, tz);
    const [y, m, d] = q.to.split('-').map(Number);
    const endMs = startOfDay(new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10), tz); // midnight after `to`
    if (endMs <= fromMs) throw new ClickUpError('to must not be before from');
    if (endMs - fromMs > MAX_DAYS * DAY_MS) throw new ClickUpError(`at most ${MAX_DAYS} days per call; split the range`);

    const budget = { left: MAX_REQUESTS };
    const warnings: string[] = [];
    const all = await this.listChannels(workspaces, budget);
    for (const id of q.channelIds ?? []) if (!all.some((c) => c.id === id)) warnings.push(`channel ${id} not found`);
    // ClickUp does not say which channels have a message in the range, so each one is asked (a channel made later has none).
    const channels = (q.channelIds?.length ? all.filter((c) => q.channelIds!.includes(c.id)) : all).filter((c) => !c.created || c.created < endMs);

    const raw: { m: RawMessage; c: Channel }[] = [];
    let spent = false;
    await pool(channels, PARALLEL, async (c) => {
      if (spent) return;
      try {
        for (const msg of await this.channelMessages(c, byId.get(c.workspace_id)!, me.id, fromMs, endMs, Boolean(q.includeReplies), budget)) raw.push({ m: msg, c });
      } catch (e) {
        if (budget.left <= 0) spent = true;
        else warnings.push(`${c.name}: ${(e as Error).message}`);
      }
    });
    if (spent) warnings.push('stopped early: too many ClickUp requests for one call; narrow the range or pick channels');

    const mineOnly = q.mineOnly ?? true;
    const rows = raw
      .filter(({ m: msg }) => !mineOnly || msg.user_id === me.id)
      .map(({ m: msg, c }) => {
        const p = localParts(msg.date, tz);
        const content = String(msg.content ?? '').trim();
        return {
          id: msg.id, date: p.date, time: p.time, weekday: p.weekday,
          workspace: c.workspace, channel: c.name, channel_id: c.id, author: byId.get(c.workspace_id)?.members.get(msg.user_id) ?? msg.user_id,
          ...(msg.parent_message && { reply_to: msg.parent_message }),
          content: content.length > MAX_CONTENT ? `${content.slice(0, MAX_CONTENT)}…` : content,
          ts: msg.date,
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

  /** The channel `id` of the given workspaces (default: see `workspaces`), looked for in their channel lists. */
  private async findChannel(id: string, workspaceIds?: string[]): Promise<Channel> {
    const workspaces = await this.workspaces(workspaceIds);
    const seen = this.known.get(id);
    const found = seen && workspaces.some((w) => w.id === seen.workspace_id)
      ? seen : (await this.listChannels(workspaces, { left: MAX_REQUESTS })).find((c) => c.id === id);
    if (!found) throw new ClickUpError(`channel ${id} not found (ids from clickup_list_channels)`);
    const c: Channel = { id, name: this.dmNames.get(id) ?? found.name, type: found.type, workspace_id: found.workspace_id, workspace: found.workspace };
    if (this.unnamed(c)) { // a DM picked by id still shows who it is with
      try {
        const [me, r] = await Promise.all([this.user(), this.call('clickup_get_chat_channel_messages', { channel_id: id, limit: 50 }, c.workspace_id)]);
        this.nameDm(c, messages(r), workspaces.find((w) => w.id === c.workspace_id)!, me.id);
      } catch { /* keep the generic name */ }
    }
    return c;
  }

  /** People of the given workspaces (default: see `workspaces`) but the connected user, by name or email containing `query`. */
  async people(query?: string, workspaceIds?: string[]) {
    const [me, workspaces] = await Promise.all([this.user(), this.workspaces(workspaceIds)]);
    const q = query?.trim().toLowerCase();
    return workspaces.flatMap((w) => w.people
      .filter((p) => p.id !== me.id && (!q || p.name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q)))
      .map((p) => ({ ...p, workspace_id: w.id, workspace: w.name })));
  }

  /** The latest top-level messages of a channel (newest first), to pick one to reply to in its thread. */
  async threads(channelId: string, workspaceId?: string, limit = 20) {
    const [c, tz] = await Promise.all([this.findChannel(channelId, workspaceId ? [workspaceId] : undefined), this.timeZone()]);
    const n = Math.min(Math.max(limit, 1), 100);
    const members = (await this.workspace(c.workspace_id)).members;
    const r = await this.call('clickup_get_chat_channel_messages', { channel_id: c.id, limit: n }, c.workspace_id);
    return {
      workspace: c.workspace, channel: c.name, channel_id: c.id, time_zone: tz,
      messages: messages(r).slice(0, n).map((m) => ({
        id: m.id, ...stamp(m.date, tz), author: members.get(m.user_id) ?? m.user_id, has_replies: Boolean(m.has_replies), content: preview(m),
      })),
    };
  }

  /** The top-level message `id` of a channel, looked for among its latest 500 (a reply names no channel). */
  private async topMessage(c: Channel, id: string) {
    const members = (await this.workspace(c.workspace_id)).members;
    let cursor: string | undefined;
    for (let page = 0; page < 5; page++) {
      const r = await this.call('clickup_get_chat_channel_messages', { channel_id: c.id, limit: 100, cursor }, c.workspace_id);
      const m = messages(r).find((x) => x.id === id);
      if (m) return { m, author: members.get(m.user_id) ?? m.user_id };
      cursor = (r?.has_more ?? true) ? r?.next_cursor || undefined : undefined;
      if (!cursor) break;
    }
    return undefined;
  }

  /**
   * Checks where a message goes and names it, sending nothing: a channel (and the thread replied to, which must be one
   * of its latest 500 messages), or a person of a workspace for a DM.
   */
  async destination(q: Omit<SendQuery, 'content'>): Promise<Destination> {
    if (!q.channelId === !q.toUserId) throw new ClickUpError('give either channel_id or to_user_id');
    const ws = q.workspaceId ? [q.workspaceId] : undefined;
    if (q.toUserId) {
      if (q.replyTo) throw new ClickUpError('reply_to needs channel_id: a thread is in a channel');
      const p = (await this.people(undefined, ws)).find((x) => x.id === q.toUserId);
      if (!p) throw new ClickUpError(`no person ${q.toUserId} in the workspace (ids from clickup_find_people)`);
      return { workspace_id: p.workspace_id, workspace: p.workspace, channel: `DM with ${p.name}`, to_user: { id: p.id, name: p.name } };
    }
    const c = await this.findChannel(q.channelId!, ws);
    const d: Destination = { workspace_id: c.workspace_id, workspace: c.workspace, channel_id: c.id, channel: c.name };
    if (!q.replyTo) return d;
    const [found, tz] = await Promise.all([this.topMessage(c, q.replyTo), this.timeZone()]);
    if (!found) throw new ClickUpError(`message ${q.replyTo} is not among the latest 500 of "${c.name}" (ids from clickup_list_threads)`);
    return { ...d, reply_to: q.replyTo, thread: { author: found.author, ...stamp(found.m.date, tz), preview: preview(found.m) } };
  }

  /** A task by id or link, named for the approval card. */
  async task(ref: string): Promise<TaskRef> {
    const t = await this.rawTask(ref);
    const team = taskId(ref)?.team;
    return { id: String(t.id), name: String(t.name ?? t.id), url: String(t.url ?? `https://app.clickup.com/t/${t.id}`), ...(team && { workspace_id: team }) };
  }

  /**
   * A task as ClickUp gives it, by id, custom id (`DEV-42`) or link, with the parts named in `include`. A link with a
   * workspace (`…/t/<workspace>/<id>`) is read in that workspace.
   */
  async rawTask(ref: string, include: string[] = []): Promise<any> {
    const found = taskId(ref);
    if (!found) throw new ClickUpError(`not a task id or link: ${ref}`);
    let t: any;
    try {
      t = await this.call('clickup_get_task', { task_id: found.id, ...(include.length && { include }) }, found.team);
    } catch (e) {
      if (!refused(e) || (e as ClickUpError).status === 401) throw e;
      throw new ClickUpError(`no task ${found.id} that this ClickUp user can open (${(e as Error).message})`, (e as ClickUpError).status);
    }
    t = t?.task ?? t;
    if (!t?.id) throw new ClickUpError(`no task ${found.id} that this ClickUp user can open`, 404);
    return t;
  }

  /** Send `content` (markdown) as the connected user to a channel, person or thread (see `destination`). */
  async send(q: SendQuery) {
    const content = checkContent(q.content);
    return this.deliver(await this.destination(q), content);
  }

  /**
   * Uploads files to a task as attachments and gives the name (and address, when ClickUp says it) of each. A refusal
   * with nothing uploaded yet did nothing; any failure after that is uncertain and names the files already on the task.
   */
  async attach(task: TaskRef, files: OutFile[]): Promise<Uploaded[]> {
    const done: Uploaded[] = [];
    for (const f of files) {
      try {
        const a = await this.mcp.upload({ task_id: task.id }, f, task.workspace_id ?? this.o.workspaceId);
        done.push({ name: a.name, ...(a.url && { url: a.url }) });
      } catch (e) {
        const msg = `${(e as Error).message}.${onTask(task, done)}`;
        throw refused(e) && !done.length ? new ClickUpError(msg, (e as ClickUpError).status) : new ClickUpUncertain(`${msg} Check the task before sending them again.`);
      }
    }
    return done;
  }

  /**
   * Send `content` to a destination checked before. Files go into the message itself: each is uploaded first (an
   * upload shows nowhere until a message names it, so a failed upload posts nothing) and the message names them. A
   * person with no DM open yet has no channel to upload to, so the text goes first, which opens the DM, and the files
   * follow in a second message. Only a refusal by ClickUp says nothing was sent; any other failure is uncertain.
   */
  async deliver(d: Destination, raw: string, files: OutFile[] = []) {
    const content = checkContent(raw);
    const tz = await this.timeZone();
    const say = async (target: UploadTarget | { user_ids: string[] }, text: string) => {
      const r = await this.call('clickup_send_chat_message', { ...target, content: text, content_format: 'text/md' }, d.workspace_id);
      if (r?.success === false) throw new ClickUpUncertain('ClickUp did not confirm the message');
      return { id: r?.message_id ? String(r.message_id) : null, channel: r?.channel_id ? String(r.channel_id) : undefined };
    };
    const withFiles = async (target: UploadTarget, text: string) => {
      const refs: string[] = [];
      for (const f of files) refs.push(attachmentRef(await this.mcp.upload(target, f, d.workspace_id)));
      return say(target, [text, refs.join('\n')].filter(Boolean).join('\n\n'));
    };
    let sent: { id: string | null; channel?: string };
    if (d.reply_to) sent = await withFiles({ parent_message_id: d.reply_to }, content);
    else if (d.channel_id) sent = await withFiles({ channel_id: d.channel_id }, content);
    else {
      sent = await say({ user_ids: [d.to_user!.id] }, content);
      if (files.length) {
        const late = (why: string) => new ClickUpUncertain(`the message was sent to ${d.channel}, but its ${files.length === 1 ? 'file was' : 'files were'} not: ${why}`);
        if (!sent.channel) throw late('ClickUp did not say which DM it opened');
        try { await withFiles({ channel_id: sent.channel }, ''); } catch (e) { throw late((e as Error).message); }
      }
    }
    const at = localParts(Date.now(), tz);
    return {
      sent: true, id: sent.id, workspace: d.workspace, channel: d.channel, channel_id: d.channel_id ?? sent.channel ?? null,
      ...(d.reply_to && { reply_to: d.reply_to }), ...(files.length && { attached: files.length }), date: at.date, time: at.time,
    };
  }
}

/** The id in a task id or link (`…/t/<id>`, or `…/t/<workspace>/<custom id>` with its workspace). */
export function taskId(ref: string): { id: string; team?: string } | null {
  const r = ref.trim();
  const m = /\/t\/(?:(\d+)\/)?([A-Za-z0-9_-]+)\/?(?:[?#].*)?$/.exec(r);
  if (m) return { id: m[2]!, ...(m[1] && { team: m[1] }) };
  return /^[A-Za-z0-9_-]+$/.test(r) ? { id: r } : null;
}

/** Whether a failed request says ClickUp refused it (a 4xx but a timeout); anything else may have been kept. */
export const refused = (e: unknown) => {
  const s = e instanceof ClickUpError ? e.status : undefined;
  return s !== undefined && s >= 400 && s < 500 && s !== 408;
};

function checkContent(raw: string): string {
  const content = raw.trim();
  if (!content) throw new ClickUpError('the message is empty');
  if (content.length > MAX_SEND) throw new ClickUpError(`at most ${MAX_SEND} characters per message`);
  return content;
}

export function stamp(ms: number, tz: string) {
  const p = localParts(ms, tz);
  return { date: p.date, time: p.time, weekday: p.weekday };
}

function preview(m: RawMessage): string {
  const t = String(m.content ?? '').trim();
  return t.length > PREVIEW ? `${t.slice(0, PREVIEW)}…` : t;
}

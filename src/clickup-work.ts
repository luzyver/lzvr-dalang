/**
 * ClickUp beyond chat, for the MCP gateway: the Space → Folder → List tree, tasks (find, read, with comments), time
 * entries and Docs, all through ClickUp's own MCP server. Reading happens at once. Every change (a task made or
 * changed, a comment, a link, time logged, a Doc written) is first planned: checked against ClickUp and put in words as
 * a ClickUpAction, which waits for the person's approval and only then runs (`perform`).
 */
import {
  type ClickUp, ClickUpError, ClickUpUncertain, DAY_MS, fileLink, localParts, MAX_DAYS, MAX_REQUESTS, onTask, type OutFile, refused, stamp,
  startOfDay, taskId, type TaskRef,
} from './clickup.js';

/**
 * One tool call of an action, in `workspace` (default: the one read by default). `{0.document_id}` as an argument
 * stands for a field of the answer to an earlier call (here: the first). `links` names the argument holding a
 * comment's markdown: with files uploaded for the action, that text ends with a line naming each file.
 */
export interface ClickUpCall { tool: string; args: Record<string, unknown>; workspace?: string; what: string; links?: string }
/** A file that goes with an action, as the approval shows it. */
export interface FileNote { name: string; size: number }
const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fileList = (files: FileNote[]) => files.map((f) => `${f.name} (${fileSize(f.size)})`).join(', ');
/** A change to ClickUp, named for the approval card and kept as the tool calls that make it. */
export interface ClickUpAction { title: string; details: { label: string; value: string }[]; url?: string; calls: ClickUpCall[] }

export interface TaskQuery {
  workspaceIds?: string[]; listIds?: string[]; spaceIds?: string[]; folderIds?: string[];
  /** User ids, or `me`. */
  assignees?: string[];
  statuses?: string[]; tags?: string[]; includeClosed?: boolean; subtasks?: boolean;
  /** Local dates `YYYY-MM-DD`, both included. */
  dueFrom?: string; dueTo?: string; updatedSince?: string;
  /** Subtasks of this task. */
  parent?: string;
  /** Part of the name or the custom id. */
  query?: string;
  limit?: number;
}

export interface TaskFields {
  name?: string; description?: string; status?: string; priority?: Priority;
  /** `YYYY-MM-DD` or `YYYY-MM-DD HH:MM`, local; '' clears it (on a change). */
  due?: string; start?: string;
  timeEstimateMinutes?: number; parent?: string;
  customFields?: { id: string; value: unknown }[];
}
export interface NewTask extends TaskFields { listId: string; name: string; assignees?: string[]; tags?: string[] }
export interface TaskChange extends TaskFields {
  task: string; addAssignees?: string[]; removeAssignees?: string[]; addTags?: string[]; removeTags?: string[];
  moveToList?: string;
}

export const PRIORITIES = ['urgent', 'high', 'normal', 'low', 'none'] as const;
export type Priority = typeof PRIORITIES[number];

const MAX_PAGES = 10; // of 100 tasks
const MAX_TEXT = 8000;
const MAX_COMMENT = 1500;
const COMMENT_PAGE = 25; // what ClickUp gives per request
const MAX_COMMENTS = 500;
const MAX_COMMENT_PAGES = MAX_COMMENTS / COMMENT_PAGE;
const MAX_PAGE_TEXT = 20_000;
export const MAX_WRITE = 20_000;
const WHEN_RE = /^(\d{4}-\d{2}-\d{2})(?:[ T](\d{2}):(\d{2}))?$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const num = (v: unknown): number | null => (v === null || v === undefined || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
/** A moment in ms, as ClickUp gives it (ms as a number or text) or as an ISO date; null when it is neither. */
const moment = (v: unknown): number | null => {
  const n = num(v);
  if (n !== null) return n;
  const d = typeof v === 'string' ? Date.parse(v) : NaN;
  return Number.isNaN(d) ? null : d;
};
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** "2026-10-08", or with its time "2026-10-08 14:00". */
function fmt(ms: number, withTime: boolean, tz: string): string {
  const p = localParts(ms, tz);
  return withTime ? `${p.date} ${p.time}` : p.date;
}

/** A local date, or date and time, as ClickUp wants it. A date alone is put at 04:00, as ClickUp itself does. */
function when(s: string, tz: string): { ms: number; time: boolean } {
  const m = WHEN_RE.exec(s.trim());
  if (!m) throw new ClickUpError(`not a date like 2026-10-01 or 2026-10-01 14:30: ${s}`);
  return m[2] ? { ms: localTime(m[1]!, Number(m[2]), Number(m[3]), tz), time: true } : { ms: localTime(m[1]!, 4, 0, tz), time: false };
}

/** Epoch ms of a local date and time in `tz`, by the offset that holds at that time (not at midnight: DST may change it). */
function localTime(date: string, hour: number, minute: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  realDate(date);
  if (hour > 23 || minute > 59) throw new ClickUpError(`no such time: ${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`);
  const guess = Date.UTC(y!, m! - 1, d!, hour, minute);
  const first = guess - localParts(guess, tz).offsetMs;
  return guess - localParts(first, tz).offsetMs;
}

/** Refuses a date the calendar does not have (2026-02-31), which Date would quietly roll over into the next month. */
function realDate(date: string): void {
  const [y, m, d] = date.split('-').map(Number);
  if (new Date(Date.UTC(y!, m! - 1, d!)).toISOString().slice(0, 10) !== date) throw new ClickUpError(`no such date: ${date}`);
}

function dayStart(date: string, tz: string, next = false): number {
  if (!DATE_RE.test(date)) throw new ClickUpError(`not a date like 2026-10-01: ${date}`);
  realDate(date);
  if (!next) return startOfDay(date, tz);
  const [y, m, d] = date.split('-').map(Number);
  return startOfDay(new Date(Date.UTC(y!, m! - 1, d! + 1)).toISOString().slice(0, 10), tz);
}

const minutes = (ms: number) => Math.round(ms / 60_000);
const hours = (min: number) => `${Math.floor(min / 60)}h ${String(min % 60).padStart(2, '0')}m`;

/** ClickUp gives a status or priority as its name, or as an object holding it. */
const word = (v: any, key: string): string => (typeof v === 'string' ? v : String(v?.[key] ?? ''));
const tagName = (x: any): string => (typeof x === 'string' ? x : String(x?.name ?? ''));
const person = (a: any): string => String(a?.username || a?.email || a?.id || '');

/**
 * A due or start date in words. ClickUp does not say whether it has a time; it puts a date alone at 04:00 of the
 * ClickUp user's day, so that reads as the date alone.
 */
function day(ms: number, tz: string, uz: string): { text: string; time: boolean } {
  const p = localParts(ms, uz);
  return p.time === '04:00' ? { text: p.date, time: false } : { text: fmt(ms, true, tz), time: true };
}

/** A time ClickUp gave: epoch ms, an ISO time, or `YYYY-MM-DD HH:MM` on the ClickUp user's clock. */
function parseTime(v: unknown, uz: string): number | null {
  if (num(v) !== null) return num(v);
  if (typeof v !== 'string') return null;
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}):(\d{2})(?::\d{2})?$/.exec(v.trim());
  if (m) { try { return localTime(m[1]!, Number(m[2]), Number(m[3]), uz); } catch { return null; } }
  const t = Date.parse(v);
  return Number.isNaN(t) ? null : t;
}

/** A task in one line of a list. */
function row(t: any, tz: string, uz: string) {
  const due = num(t.due_date);
  const assignees = ((t.assignees ?? []) as any[]).map(person).filter(Boolean);
  const priority = word(t.priority, 'priority');
  return {
    id: String(t.id), ...(t.custom_id && { custom_id: String(t.custom_id) }), name: String(t.name ?? ''),
    status: word(t.status, 'status'), ...(assignees.length && { assignees }),
    ...(due !== null && { due: day(due, tz, uz).text }),
    ...(priority && { priority }),
    ...(t.list?.name && { list: String(t.list.name) }), ...(t.parent && { parent: String(t.parent?.id ?? t.parent) }),
    url: String(t.url ?? `https://app.clickup.com/t/${t.id}`),
  };
}

/** A custom field's value in words: the option's name, people's names, a date. */
function fieldValue(f: any, tz: string): unknown {
  const v = f.value;
  if (v === undefined || v === null || v === '') return undefined;
  const opts = (f.type_config?.options ?? []) as any[];
  const opt = (x: unknown) => { const o = opts.find((y) => y.id === x || y.orderindex === x); return o ? String(o.name ?? o.label ?? x) : x; };
  switch (f.type) {
    case 'drop_down': return opt(v);
    case 'labels': return Array.isArray(v) ? v.map(opt) : v;
    case 'date': return num(v) === null ? v : fmt(num(v)!, false, tz);
    case 'users': return Array.isArray(v) ? v.map((u) => u?.username ?? u?.email ?? u?.id ?? u) : v;
    case 'tasks': return Array.isArray(v) ? v.map((t) => (t?.id ? { id: t.id, name: t.name } : t)) : v;
    default: return v;
  }
}

/** Everything `clickup_get_task` can add to a task. */
const FULL = ['attachments', 'checklists', 'custom_fields', 'dependencies', 'description', 'linked_tasks', 'subtasks', 'watchers'];
const kids = (n: any, type: string) => ((n?.children ?? []) as any[]).filter((c) => c?.type === type);
const named = (n: any) => ({ id: String(n.id), name: String(n.name ?? '') });
const pagesOf = (r: any): any[] => (Array.isArray(r) ? r : r?.pages ?? r?.data ?? []) as any[];
const subPages = (p: any): any[] => (p?.pages ?? p?.children ?? p?.sub_pages ?? []) as any[];

export class ClickUpWork {
  constructor(private readonly cu: ClickUp) {}

  /** User ids as ClickUp takes them, `me` being the connected user; each must be someone of the workspace. */
  private async people(ids: string[] | undefined, workspaceId?: string): Promise<{ id: string; name: string }[]> {
    if (!ids?.length) return [];
    const [me, ws] = await Promise.all([this.cu.user(), this.cu.workspace(workspaceId)]);
    return ids.map((raw) => {
      const id = raw === 'me' ? me.id : raw.trim();
      const name = ws.members.get(id) ?? (id === me.id ? me.username : undefined);
      if (!name || !/^\d+$/.test(id)) throw new ClickUpError(`no person ${raw} in the workspace (ids from clickup_find_people, or "me")`);
      return { id, name };
    });
  }

  /** Spaces with their folders and lists, in the given workspaces (default: see ClickUp.workspaces), or one space of them. */
  async spaces(workspaceIds?: string[], spaceId?: string) {
    const budget = { left: MAX_REQUESTS };
    const out: unknown[] = [];
    for (const ws of await this.cu.workspaces(workspaceIds)) {
      let cursor: string | undefined;
      do {
        let r: any;
        try {
          r = await this.cu.call('clickup_get_workspace_hierarchy', { max_depth: '2', limit: 50, cursor, ...(spaceId && { space_ids: [spaceId] }) }, ws.id, budget);
        } catch (e) {
          if (spaceId && refused(e) && (e as ClickUpError).status !== 401) break; // not a space of this workspace
          throw e;
        }
        for (const s of kids(r?.hierarchy?.root, 'space')) {
          if (spaceId && String(s.id) !== spaceId) continue;
          out.push({
            ...named(s), workspace_id: ws.id, workspace: ws.name, lists: kids(s, 'list').map(named),
            folders: kids(s, 'folder').map((f) => ({ ...named(f), lists: kids(f, 'list').map(named) })),
          });
        }
        cursor = r?.has_more ? r?.next_cursor || undefined : undefined;
      } while (cursor);
    }
    if (spaceId && !out.length) throw new ClickUpError(`no space ${spaceId} (ids from clickup_list_spaces)`);
    return out;
  }

  /** A list as ClickUp gives it; a refusal says it is not one the user can open. */
  private async rawList(id: string, workspaceId?: string): Promise<any> {
    try {
      const l = await this.cu.call('clickup_get_list', { list_id: id.trim() }, workspaceId);
      if (!l?.id) throw new ClickUpError('ClickUp gave no list', 404);
      return l;
    } catch (e) {
      if (refused(e) && (e as ClickUpError).status !== 401) throw new ClickUpError(`no list ${id} that this ClickUp user can open (ids from clickup_list_spaces)`, (e as ClickUpError).status);
      throw e;
    }
  }

  /** The custom fields tasks of a list can have: its own and those of its folder, space and workspace. */
  private async listFields(listId: string, workspaceId?: string): Promise<any[]> {
    const r = await this.cu.call('clickup_get_custom_fields', { list_id: listId }, workspaceId);
    const all = [r?.list_fields, r?.folder_fields, r?.space_fields, r?.workspace_fields, r?.fields].flatMap((x) => (Array.isArray(x) ? x : []));
    return all.filter((f, i) => all.findIndex((x) => String(x.id) === String(f.id)) === i);
  }

  /** A list: where it is, the statuses its tasks can have and its custom fields (with their options). */
  async list(listId: string) {
    const l = await this.rawList(listId);
    const fields = await this.listFields(String(l.id));
    return {
      id: String(l.id), name: String(l.name ?? ''), space: l.space?.name,
      statuses: ((l.statuses ?? []) as any[]).map((s) => ({ status: String(s.status), type: String(s.type ?? '') })),
      custom_fields: fields.map((f) => ({
        id: String(f.id), name: String(f.name ?? ''), type: String(f.type ?? ''), ...(f.required && { required: true }),
        ...(f.type_config?.options?.length && { options: (f.type_config.options as any[]).map((o) => ({ id: o.id, name: o.name ?? o.label })) }),
      })),
    };
  }

  /** Tasks matching the filters, last changed first. Closed tasks and subtasks only on request. */
  async findTasks(q: TaskQuery) {
    const [me, workspaces, tz, uz] = await Promise.all([this.cu.user(), this.cu.workspaces(q.workspaceIds), this.cu.timeZone(), this.cu.userZone()]);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    const needle = q.query?.trim().toLowerCase();
    const hit = (t: any) => !needle || String(t.name ?? '').toLowerCase().includes(needle) || String(t.custom_id ?? '').toLowerCase().includes(needle);
    if (q.parent) {
      // ClickUp filters no tasks by their parent, so the subtasks come from the parent itself; other filters do not apply.
      const t = await this.cu.rawTask(q.parent, ['subtasks']);
      const subs = ((t.subtasks ?? []) as any[]).filter(hit);
      return {
        time_zone: tz, tasks: subs.slice(0, limit).map((s) => ({ ...row(s, tz, uz), parent: String(t.id) })),
        ...(subs.length > limit && { warnings: [`more tasks match; only ${limit} are listed (raise limit or narrow the filters)`] }),
      };
    }
    // ClickUp reads these dates on the ClickUp user's clock, each as its whole day.
    for (const d of [q.dueFrom, q.dueTo]) if (d) dayStart(d, tz);
    const since = q.updatedSince ? dayStart(q.updatedSince, tz) : undefined;
    const some = <T>(l?: T[]) => (l?.length ? l : undefined);
    const filters = {
      order_by: 'updated', subtasks: Boolean(q.subtasks), include_closed: Boolean(q.includeClosed),
      list_ids: some(q.listIds), space_ids: some(q.spaceIds), folder_ids: some(q.folderIds), statuses: some(q.statuses), tags: some(q.tags),
      assignees: some(q.assignees?.map((a) => (a === 'me' ? me.id : a))), due_date_from: q.dueFrom, due_date_to: q.dueTo,
    };
    const budget = { left: MAX_REQUESTS };
    const rows: ({ ts: number } & Record<string, unknown>)[] = [];
    const warnings: string[] = [];
    let read = 0;
    let more = false;
    let failed: unknown;
    // Each workspace gives its own latest `limit`; the latest of them all are picked after, so none is skipped.
    for (const ws of workspaces) {
      try {
        let own = 0;
        pages: for (let page = 0, n = 0; ; n++) {
          if (n >= MAX_PAGES) { warnings.push(`${ws.name}: stopped after ${MAX_PAGES} pages of tasks; narrow the filters`); break; }
          const r = await this.cu.call('clickup_filter_tasks', { ...filters, page }, ws.id, budget);
          const tasks = (r?.tasks ?? []) as any[];
          for (const t of tasks) {
            const at = moment(t.date_updated);
            // Last changed first: the rest is older still. A task that does not say when it changed is kept, not taken as old.
            if (since !== undefined && at !== null && at < since) break pages;
            const ts = at ?? 0;
            if (!hit(t)) continue;
            rows.push({ ts, ...row(t, tz, uz), ...(workspaces.length > 1 && { workspace: ws.name }) });
            own++;
          }
          const last = !r?.has_more || !tasks.length;
          if (own >= limit && !last) more = true;
          if (last || own >= limit) break;
          page = num(r.next_page) ?? page + 1;
        }
        read++;
      } catch (e) {
        failed ??= e;
        warnings.push(`${ws.name}: ${(e as Error).message}`);
      }
    }
    if (!read) throw failed;
    rows.sort((a, b) => b.ts - a.ts);
    if (more || rows.length > limit) warnings.push(`more tasks match; only ${limit} are listed (raise limit or narrow the filters)`);
    return { time_zone: tz, tasks: rows.slice(0, limit).map(({ ts: _ts, ...r }) => r), ...(warnings.length && { warnings }) };
  }

  /** A task's comments, newest first, read page by page (ClickUp gives 25) until `max`; `more` says older ones are left. */
  private async comments(id: string, max: number, workspaceId?: string): Promise<{ list: any[]; more: boolean }> {
    const list: any[] = [];
    const budget = { left: MAX_COMMENT_PAGES };
    for (let after: any; ;) {
      const r = await this.cu.call('clickup_get_task_comments', { task_id: id, ...(after && { start: Number(after.date), start_id: String(after.id) }) }, workspaceId, budget);
      const page = (r?.comments ?? []) as any[];
      list.push(...page);
      if (page.length < COMMENT_PAGE) return { list: list.slice(0, max), more: list.length > max };
      if (list.length >= max || budget.left <= 0) return { list: list.slice(0, max), more: true };
      after = page[page.length - 1];
    }
  }

  /** One task in full; with `comments`, its latest comments too (newest first, at most `commentLimit`). */
  async task(ref: string, comments = false, commentLimit = 50) {
    const [t, tz, uz] = await Promise.all([this.cu.rawTask(ref, FULL), this.cu.timeZone(), this.cu.userZone()]);
    const at = (v: unknown) => (num(v) === null ? undefined : fmt(num(v)!, true, tz));
    const text = String(t.markdown_description ?? t.description ?? t.text_content ?? '').trim();
    const start = num(t.start_date) === null ? undefined : day(num(t.start_date)!, tz, uz).text;
    const fields = ((t.custom_fields ?? []) as any[])
      .map((f) => ({ id: String(f.id), name: String(f.name ?? ''), type: String(f.type ?? ''), value: fieldValue(f, tz) }))
      .filter((f) => f.value !== undefined);
    const self = String(t.id);
    const other = (x: any, ...keys: string[]) => keys.map((k) => x?.[k]).map((v) => (v && typeof v === 'object' ? v.id : v)).find((v) => v !== undefined && v !== null && String(v) !== self);
    const waitingOn: string[] = [];
    const blocking: string[] = [];
    for (const d of (t.dependencies ?? []) as any[]) {
      const id = other(d, 'depends_on', 'task_id', 'id');
      if (id === undefined) continue;
      const waits = d?.type !== undefined && typeof d.type === 'string' ? /wait/i.test(d.type) : String(d?.task_id ?? self) === self;
      (waits ? waitingOn : blocking).push(String(id));
    }
    const linked = ((t.linked_tasks ?? []) as any[]).map((l) => other(l, 'link_id', 'task_id', 'id')).filter((x) => x !== undefined).map(String);
    const tags = ((t.tags ?? []) as any[]).map(tagName).filter(Boolean);
    const out = {
      ...row(t, tz, uz), ...(taskId(ref)?.team && { workspace_id: taskId(ref)!.team }), list_id: String(t.list?.id ?? ''),
      ...(t.folder?.name && !t.folder.hidden && t.folder.name !== 'hidden' && { folder: String(t.folder.name) }), ...(t.space?.id && { space_id: String(t.space.id) }),
      creator: t.creator?.username ?? t.creator?.email, created: at(t.date_created), updated: at(t.date_updated),
      ...(num(t.date_closed) !== null && { closed: at(t.date_closed) }), ...(start && { start }),
      ...(num(t.time_estimate) !== null && { time_estimate_minutes: minutes(num(t.time_estimate)!) }),
      ...(num(t.time_spent) && { time_spent_minutes: minutes(num(t.time_spent)!) }),
      ...(tags.length && { tags }),
      description: clip(text, MAX_TEXT), ...(text.length > MAX_TEXT && { description_cut: true }),
      ...(fields.length && { custom_fields: fields }),
      ...(t.checklists?.length && { checklists: (t.checklists as any[]).map((c) => ({
        id: String(c.id), name: String(c.name ?? ''),
        items: ((c.items ?? []) as any[]).map((i) => ({ id: String(i.id), name: String(i.name ?? ''), done: Boolean(i.resolved) })),
      })) }),
      ...(t.subtasks?.length && { subtasks: (t.subtasks as any[]).map((s) => ({ id: String(s.id), name: String(s.name ?? ''), status: word(s.status, 'status') })) }),
      ...(waitingOn.length && { waiting_on: waitingOn }), ...(blocking.length && { blocking }), ...(linked.length && { linked }),
      ...(t.attachments?.length && { attachments: (t.attachments as any[]).map((a) => ({ name: String(a.title ?? a.id), ...(a.url && { url: String(a.url) }) })) }),
    };
    if (!comments) return out;
    const r = await this.comments(self, Math.min(Math.max(commentLimit, 1), MAX_COMMENTS), taskId(ref)?.team);
    return {
      ...out, ...(r.more && { comments_more: true }),
      comments: r.list.map((c) => {
        const body = String(c.comment_text ?? '').trim();
        return {
          id: String(c.id), ...(num(c.date) !== null && stamp(num(c.date)!, tz)), author: person(c.user),
          text: clip(body, MAX_COMMENT), ...(c.resolved && { resolved: true }), ...(c.assignee && { assigned_to: c.assignee.username ?? c.assignee.id ?? c.assignee }),
          ...(Number(c.reply_count) > 0 && { replies: Number(c.reply_count) }),
        };
      }),
    };
  }

  /**
   * Time entries between two local dates (both included), oldest first, with the minutes of each day and in all. The
   * connected user's own entries unless other people are named (ClickUp shows those to workspace owners and admins only).
   */
  async timeEntries(q: { from: string; to: string; workspaceIds?: string[]; assignees?: string[]; task?: string }) {
    const team = q.task ? taskId(q.task)?.team : undefined;
    const [workspaces, tz, uz] = await Promise.all([this.cu.workspaces(team ? [team] : q.workspaceIds), this.cu.timeZone(), this.cu.userZone()]);
    const fromMs = dayStart(q.from, tz);
    const endMs = dayStart(q.to, tz, true);
    if (endMs <= fromMs) throw new ClickUpError('to must not be before from');
    if (endMs - fromMs > MAX_DAYS * DAY_MS) throw new ClickUpError(`at most ${MAX_DAYS} days per call; split the range`);
    const task = q.task ? await this.cu.rawTask(q.task) : undefined;
    // ClickUp reads the range on the ClickUp user's clock: ask for the days that hold ours, and keep what is inside.
    const range = { start_date: localParts(fromMs, uz).date, end_date: localParts(endMs - 1, uz).date };
    const rows: ({ ts: number; date: string; weekday: string; minutes: number } & Record<string, unknown>)[] = [];
    const warnings: string[] = [];
    let read = 0;
    let failed: unknown;
    for (const ws of workspaces) {
      try {
        const who = await this.people(q.assignees, ws.id);
        const r = await this.cu.call('clickup_get_time_entries', {
          ...range, ...(who.length && { assignee: who.map((p) => p.id) }), ...(task && { task_id: String(task.id) }),
        }, ws.id);
        for (const e of (r?.entries ?? r?.data ?? []) as any[]) {
          const start = parseTime(e.start, uz);
          if (start === null) { warnings.push(`entry ${e.id}: ClickUp gave a start that is no time (${String(e.start).slice(0, 40)})`); continue; }
          if (start < fromMs || start >= endMs) continue;
          const dur = num(e.duration_ms) ?? num(e.duration) ?? 0;
          const s = stamp(start, tz);
          const end = parseTime(e.end, uz);
          const running = dur < 0 || (end === null && !dur);
          rows.push({
            ts: start, id: String(e.id), date: s.date, weekday: s.weekday, start: s.time,
            ...(running ? { running: true } : end !== null && { end: localParts(end, tz).time }), minutes: running ? 0 : minutes(dur),
            user: person(e.user),
            ...(e.task?.id && { task: String(e.task.name ?? ''), task_id: String(e.task.id) }),
            ...(e.task_location?.list_name && { list: String(e.task_location.list_name) }),
            ...(e.description && { description: clip(String(e.description), MAX_COMMENT) }), ...(e.billable && { billable: true }),
            ...(workspaces.length > 1 && { workspace: ws.name }),
          });
        }
        read++;
      } catch (e) {
        failed ??= e;
        warnings.push(`${ws.name}: ${(e as Error).message}`);
      }
    }
    if (!read && failed) throw failed;
    rows.sort((a, b) => a.ts - b.ts);
    const days = new Map<string, { date: string; weekday: string; minutes: number }>();
    for (const r of rows) {
      const d = days.get(r.date) ?? { date: r.date, weekday: r.weekday, minutes: 0 };
      d.minutes += r.minutes;
      days.set(r.date, d);
    }
    const total = rows.reduce((n, r) => n + r.minutes, 0);
    return {
      time_zone: tz, range: { from: q.from, to: q.to }, total_minutes: total, total: hours(total),
      days: [...days.values()].map((d) => ({ ...d, total: hours(d.minutes) })),
      entries: rows.map(({ ts: _ts, ...r }) => r), ...(warnings.length && { warnings }),
    };
  }

  /** Docs of the workspaces that ClickUp's search finds, optionally for `query` (words of the name or the text). */
  async docs(workspaceIds?: string[], query?: string, limit = 50) {
    const max = Math.min(Math.max(limit, 1), 200);
    const tz = await this.cu.timeZone();
    const budget = { left: 30 };
    const out = new Map<string, unknown>();
    for (const ws of await this.cu.workspaces(workspaceIds)) {
      let cursor: string | undefined;
      do {
        const r = await this.cu.call('clickup_search', {
          ...(query?.trim() && { keywords: query.trim() }), filters: { asset_types: ['doc'] }, count: Math.min(max, 50), cursor,
        }, ws.id, budget);
        const found = (r?.results ?? []) as any[];
        for (const d of found) {
          const id = String(d.id);
          const updated = num(d.dateUpdated ?? d.date_updated);
          if (!out.has(id)) out.set(id, { id, name: String(d.name ?? ''), workspace_id: ws.id, workspace: ws.name, ...(d.url && { url: String(d.url) }), ...(updated !== null && { updated: fmt(updated, false, tz) }) });
        }
        cursor = found.length ? r?.next_cursor || undefined : undefined;
      } while (cursor && out.size < max && budget.left > 0);
    }
    return [...out.values()].slice(0, max);
  }

  /**
   * The Doc `id` with its tree of pages, in the workspace named, else the first of those read by default that has it.
   * ClickUp does not give a Doc's name by its id, so it goes by its only top page's name, else by its id.
   */
  private async findDoc(id: string, workspaceId?: string): Promise<{ ws: string; workspace: string; id: string; name: string; pages: any[] }> {
    const doc = id.trim().replace(/^.*\/(?:docs|dc)\/([\w-]+).*$/, '$1');
    for (const ws of await this.cu.workspaces(workspaceId ? [workspaceId] : undefined)) {
      try {
        const pages = pagesOf(await this.cu.call('clickup_list_document_pages', { document_id: doc, max_page_depth: -1 }, ws.id));
        return { ws: ws.id, workspace: ws.name, id: doc, name: pages.length === 1 && pages[0].name ? String(pages[0].name) : `Doc ${doc}`, pages };
      } catch (e) {
        if (!refused(e) || (e as ClickUpError).status === 401) throw e;
      }
    }
    throw new ClickUpError(`no Doc ${id} that this ClickUp user can open (ids from clickup_list_docs)`);
  }

  /** A page of a Doc with its text (markdown). */
  private async page(d: { ws: string; id: string; name: string }, pageId: string): Promise<any> {
    let p: any;
    try {
      p = pagesOf(await this.cu.call('clickup_get_document_pages', { document_id: d.id, page_ids: [pageId.trim()], content_format: 'text/md' }, d.ws))[0];
    } catch (e) {
      if (!refused(e) || (e as ClickUpError).status === 401) throw e;
    }
    if (!p?.id) throw new ClickUpError(`no page ${pageId} in ${d.name} (ids from clickup_get_doc without page_id)`);
    return p;
  }

  /** A Doc's pages as a tree of names; with `pageId`, that page's text (markdown). A Doc of one page comes with its text. */
  async doc(docId: string, pageId?: string, workspaceId?: string) {
    const d = await this.findDoc(docId, workspaceId);
    const page = (p: any) => {
      const text = String(p.content ?? '');
      return { id: String(p.id), name: String(p.name ?? ''), content: clip(text, MAX_PAGE_TEXT), ...(text.length > MAX_PAGE_TEXT && { content_cut: true }) };
    };
    if (pageId) return { doc_id: d.id, doc: d.name, workspace: d.workspace, page: page(await this.page(d, pageId)) };
    const tree = (list: any[]): unknown[] => list.map((p) => ({ id: String(p.id), name: String(p.name ?? ''), ...(subPages(p).length && { pages: tree(subPages(p)) }) }));
    const single = d.pages.length === 1 && !subPages(d.pages[0]).length;
    return { doc_id: d.id, doc: d.name, workspace: d.workspace, pages: single ? [page(await this.page(d, String(d.pages[0].id)))] : tree(d.pages) };
  }

  // ---- changes: each is checked and named here, and made by `perform` once the person approved it ----

  /** What a create or change sets, as the tool's arguments and as rows for the card. */
  private async fields(f: TaskFields, tz: string, uz: string, statuses: any[] | undefined, old?: any) {
    const args: Record<string, unknown> = {};
    const details: { label: string; value: string }[] = [];
    const change = (label: string, value: string, was?: string) => details.push({ label, value: was !== undefined && was !== value ? `${was || 'none'} → ${value}` : value });
    if (f.name !== undefined) {
      if (!f.name.trim()) throw new ClickUpError('the name is empty');
      args.name = f.name.trim();
      if (old) change('Name', f.name.trim(), String(old.name ?? ''));
    }
    if (f.status !== undefined) {
      const known = (statuses ?? []).map((s) => String(s.status));
      const hit = known.find((s) => s.toLowerCase() === f.status!.trim().toLowerCase());
      if (known.length && !hit) throw new ClickUpError(`the list has no status "${f.status}" (it has: ${known.join(', ')})`);
      args.status = hit ?? f.status.trim();
      change('Status', String(args.status), old ? word(old.status, 'status') : undefined);
    }
    if (f.priority !== undefined) {
      if (old || f.priority !== 'none') args.priority = f.priority;
      change('Priority', f.priority, old ? word(old.priority, 'priority') || 'none' : undefined);
    }
    for (const [key, label] of [['due', 'Due'], ['start', 'Start']] as const) {
      const v = f[key];
      if (v === undefined) continue;
      const was = old && num(old[`${key}_date`]) !== null ? day(num(old[`${key}_date`])!, tz, uz).text : old ? '' : undefined;
      if (!v.trim()) {
        if (!old) continue;
        args[`${key}_date`] = 'none';
        change(label, 'none', was);
      } else {
        // ClickUp reads a date on the ClickUp user's clock; a date alone stays that date.
        const w = when(v, tz);
        args[`${key}_date`] = w.time ? fmt(w.ms, true, uz) : v.trim().slice(0, 10);
        change(label, w.time ? fmt(w.ms, true, tz) : v.trim().slice(0, 10), was);
      }
    }
    if (f.timeEstimateMinutes !== undefined) {
      args.time_estimate = String(f.timeEstimateMinutes);
      change('Time estimate', hours(f.timeEstimateMinutes), old ? hours(minutes(num(old.time_estimate) ?? 0)) : undefined);
    }
    if (f.parent !== undefined) {
      const p = await this.cu.rawTask(f.parent);
      args.parent = String(p.id);
      change(old ? 'Move under' : 'Subtask of', String(p.name ?? p.id));
    }
    if (f.description !== undefined) {
      if (f.description.length > MAX_WRITE) throw new ClickUpError(`at most ${MAX_WRITE} characters of description`);
      args.markdown_description = f.description.trim() || ' '; // a space clears a description
      details.push({ label: old ? 'New description' : 'Description', value: f.description.trim() || '(emptied)' });
    }
    return { args, details };
  }

  /** The custom fields set, as ClickUp takes them ('' clears one) and as rows for the card, named after the fields known. */
  private custom(set: { id: string; value: unknown }[], known: any[]) {
    const rows = set.map((c) => {
      const f = known.find((x) => String(x.id) === c.id);
      if (!f) throw new ClickUpError(`no custom field ${c.id} here (ids from clickup_get_list)`);
      return { label: `Field "${f.name}"`, value: c.value === null ? 'cleared' : typeof c.value === 'string' ? c.value : JSON.stringify(c.value) };
    });
    return { rows, args: set.map((c) => ({ id: c.id, value: c.value === null ? '' : typeof c.value === 'string' ? c.value : JSON.stringify(c.value) })) };
  }

  async planCreateTask(q: NewTask): Promise<ClickUpAction> {
    const [l, tz, uz, who] = await Promise.all([this.rawList(q.listId), this.cu.timeZone(), this.cu.userZone(), this.people(q.assignees)]);
    const { args, details } = await this.fields(q, tz, uz, l.statuses);
    if (who.length) { args.assignees = who.map((p) => p.id); details.push({ label: 'Assignees', value: who.map((p) => p.name).join(', ') }); }
    const tags = (q.tags ?? []).map((t) => t.trim()).filter(Boolean);
    if (tags.length) { args.tags = tags; details.push({ label: 'Tags', value: tags.join(', ') }); }
    if (q.customFields?.length) {
      const c = this.custom(q.customFields, await this.listFields(String(l.id)));
      details.push(...c.rows);
      args.custom_fields = c.args;
    }
    return {
      title: `Create task "${args.name}" in list "${l.name}"${l.space?.name ? ` (${l.space.name})` : ''}`, details,
      calls: [{ tool: 'clickup_create_task', args: { ...args, list_id: String(l.id) }, what: 'creating the task' }],
    };
  }

  async planUpdateTask(q: TaskChange): Promise<ClickUpAction> {
    const ws = taskId(q.task)?.team;
    const [t, tz, uz, add, rem] = await Promise.all([
      this.cu.rawTask(q.task, ['custom_fields']), this.cu.timeZone(), this.cu.userZone(), this.people(q.addAssignees, ws), this.people(q.removeAssignees, ws),
    ]);
    const id = String(t.id);
    const call = (tool: string, args: Record<string, unknown>, what: string): ClickUpCall => ({ tool, args: { task_id: id, ...args }, ...(ws && { workspace: ws }), what });
    // A task that moves takes its status from the list it moves to, so that is the list a status is checked against.
    const dest = q.moveToList ? await this.rawList(q.moveToList, ws) : undefined;
    const own = (q.status !== undefined || dest) && t.list?.id ? ((await this.rawList(String(t.list.id), ws)).statuses ?? []) as any[] : undefined;
    const { args, details } = await this.fields(q, tz, uz, dest ? dest.statuses : own, t);
    if (add.length || rem.length) {
      // ClickUp takes the people a task is to have, so the ones it has now are kept but those unassigned.
      const now = ((t.assignees ?? []) as any[]).map((a) => String(a.id));
      args.assignees = [...new Set([...now, ...add.map((p) => p.id)])].filter((x) => !rem.some((p) => p.id === x));
      if (add.length) details.push({ label: 'Assign', value: add.map((p) => p.name).join(', ') });
      if (rem.length) details.push({ label: 'Unassign', value: rem.map((p) => p.name).join(', ') });
    }
    if (q.customFields?.length) {
      let known = (t.custom_fields ?? []) as any[];
      if (q.customFields.some((c) => !known.some((f) => String(f.id) === c.id)) && t.list?.id) known = [...known, ...await this.listFields(String(t.list.id), ws)];
      const c = this.custom(q.customFields, known);
      details.push(...c.rows);
      args.custom_fields = c.args;
    }
    const calls: ClickUpCall[] = [];
    if (dest) {
      if (t.parent) throw new ClickUpError('a subtask cannot be moved to another list: move its parent, or give it another parent');
      // ClickUp moves a task only with a status the new list has too. One it has moves first and changes after; one it
      // lacks must first become a status both lists have.
      const has = ((dest.statuses ?? []) as any[]).map((s) => String(s.status));
      const now = word(t.status, 'status');
      const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();
      details.push({ label: 'Move to list', value: `${t.list?.name ?? '?'} → ${dest.name}` });
      const move = call('clickup_move_task', { list_id: String(dest.id) }, `moving it to list "${dest.name}"`);
      if (has.length && !has.some((s) => same(s, now))) {
        const to = typeof args.status === 'string' ? args.status : undefined;
        if (!to) throw new ClickUpError(`list "${dest.name}" has no status "${now}": give the status the task gets there (it has: ${has.join(', ')})`);
        if (own?.length && !own.some((s) => same(String(s.status), to))) {
          const both = has.filter((s) => own.some((o) => same(String(o.status), s)));
          throw new ClickUpError(`the task can only move with a status both lists have, and "${to}" is not in its list now`
            + (both.length ? ` (both have: ${both.join(', ')})` : '; the lists share no status, so move it in ClickUp'));
        }
        delete args.status;
        calls.push(call('clickup_update_task', { status: to }, `setting status "${to}"`), move);
      } else calls.push(move);
    }
    if (Object.keys(args).length) calls.push(call('clickup_update_task', args, 'changing the task'));
    const tags = (list?: string[]) => (list ?? []).map((x) => x.trim()).filter(Boolean);
    for (const tag of tags(q.addTags)) calls.push(call('clickup_add_tag_to_task', { tag_name: tag }, `adding tag "${tag}"`));
    for (const tag of tags(q.removeTags)) calls.push(call('clickup_remove_tag_from_task', { tag_name: tag }, `removing tag "${tag}"`));
    if (tags(q.addTags).length) details.push({ label: 'Add tags', value: tags(q.addTags).join(', ') });
    if (tags(q.removeTags).length) details.push({ label: 'Remove tags', value: tags(q.removeTags).join(', ') });
    if (!calls.length) throw new ClickUpError('nothing to change: name what to set');
    return { title: `Change task "${t.name}"`, details, url: String(t.url ?? ''), calls };
  }

  /**
   * A comment on a task (markdown), or a reply to one of its comments (`replyTo`, an id from the task's comments).
   * `files` are uploaded to the task first (see `perform`) and the comment ends with a line naming each.
   */
  async planComment(q: { task: string; text: string; replyTo?: string; assignee?: string; notifyAll?: boolean; files?: FileNote[] }): Promise<ClickUpAction> {
    const text = q.text.trim();
    if (!text) throw new ClickUpError('the comment is empty');
    if (text.length > MAX_WRITE) throw new ClickUpError(`at most ${MAX_WRITE} characters per comment`);
    const ws = taskId(q.task)?.team;
    const [t, who] = await Promise.all([this.cu.rawTask(q.task), this.people(q.assignee ? [q.assignee] : undefined, ws)]);
    const details: { label: string; value: string }[] = [];
    let reply: string | undefined;
    if (q.replyTo) {
      const all = await this.comments(String(t.id), MAX_COMMENTS, ws);
      const c = all.list.find((x) => String(x.id) === q.replyTo!.trim());
      if (!c) throw new ClickUpError(`comment ${q.replyTo} is not among the latest ${all.list.length} of "${t.name}" (ids from clickup_get_task with comments)`);
      details.push({ label: 'Reply to', value: `${c.user?.username ?? 'someone'}: ${clip(String(c.comment_text ?? '').trim(), 200)}` });
      reply = String(c.id);
    }
    if (who.length) details.push({ label: 'Assign the comment to', value: who[0]!.name });
    details.push({ label: 'Comment', value: text });
    if (q.files?.length) details.push({ label: 'Files', value: `${fileList(q.files)}: attached to the task, named at the end of the comment` });
    return {
      title: `${q.replyTo ? 'Reply to a comment' : 'Comment'} on task "${t.name}"`, details, url: String(t.url ?? ''),
      calls: [{
        tool: 'clickup_create_comment', ...(ws && { workspace: ws }), what: 'posting the comment', links: 'comment_text',
        args: { entity_type: 'task', entity_id: String(t.id), comment_text: text, notify_all: Boolean(q.notifyAll), ...(reply && { reply_to_id: reply }), ...(who.length && { assignee: who[0]!.id }) },
      }],
    };
  }

  /** Files attached to a task, with no comment: the upload itself happens in `perform`. */
  async planAttach(q: { task: string; files: FileNote[] }): Promise<ClickUpAction> {
    if (!q.files.length) throw new ClickUpError('name the files to attach');
    const t = await this.cu.rawTask(q.task);
    return {
      title: `Attach ${q.files.length === 1 ? 'a file' : `${q.files.length} files`} to task "${t.name}"`,
      details: [{ label: 'Files', value: fileList(q.files) }], url: String(t.url ?? ''), calls: [],
    };
  }

  /** Ties two tasks: `task` waits on `other`, blocks it, or is merely linked to it; or takes that tie away. */
  async planLink(q: { task: string; other: string; kind: 'waits_on' | 'blocks' | 'link'; remove?: boolean }): Promise<ClickUpAction> {
    const ws = taskId(q.task)?.team;
    const [a, b] = await Promise.all([this.cu.rawTask(q.task), this.cu.rawTask(q.other)]);
    if (String(a.id) === String(b.id)) throw new ClickUpError('a task cannot be tied to itself');
    const words = q.kind === 'waits_on' ? 'wait on' : q.kind === 'blocks' ? 'block' : 'be linked to';
    const title = q.remove ? `Task "${a.name}" no longer to ${words} "${b.name}"` : `Make task "${a.name}" ${words} "${b.name}"`;
    const what = q.remove ? 'removing the tie' : 'tying the tasks';
    const call: ClickUpCall = q.kind === 'link'
      ? { tool: q.remove ? 'clickup_remove_task_link' : 'clickup_add_task_link', args: { task_id: String(a.id), links_to: String(b.id) }, what }
      : {
        tool: q.remove ? 'clickup_remove_task_dependency' : 'clickup_add_task_dependency', what,
        args: { task_id: String(a.id), depends_on: String(b.id), type: q.kind === 'waits_on' ? 'waiting_on' : 'blocking' },
      };
    return { title, details: [], url: String(a.url ?? ''), calls: [{ ...call, ...(ws && { workspace: ws }) }] };
  }

  /** Time worked on a task, as the connected user. */
  async planLogTime(q: { task: string; date: string; start: string; minutes: number; description?: string; billable?: boolean }): Promise<ClickUpAction> {
    if (!/^\d{2}:\d{2}$/.test(q.start.trim())) throw new ClickUpError(`start must be a time like 09:30: ${q.start}`);
    if (!DATE_RE.test(q.date)) throw new ClickUpError(`not a date like 2026-10-01: ${q.date}`);
    if (!q.task?.trim()) throw new ClickUpError('give the task the time was spent on: ClickUp logs no time without one here');
    const ws = taskId(q.task)?.team;
    const [t, tz, uz] = await Promise.all([this.cu.rawTask(q.task), this.cu.timeZone(), this.cu.userZone()]);
    const start = when(`${q.date} ${q.start.trim()}`, tz).ms;
    const end = localParts(start + q.minutes * 60_000, tz);
    const details = [
      { label: 'When', value: `${q.date} ${q.start.trim()} to ${end.date === q.date ? end.time : `${end.date} ${end.time}`} (${hours(q.minutes)})` },
      ...(q.description?.trim() ? [{ label: 'Description', value: q.description.trim() }] : []),
      ...(q.billable ? [{ label: 'Billable', value: 'yes' }] : []),
    ];
    return {
      title: `Log ${hours(q.minutes)} on task "${t.name}"`, details, ...(t.url && { url: String(t.url) }),
      calls: [{
        tool: 'clickup_add_time_entry', ...(ws && { workspace: ws }), what: 'logging the time',
        args: {
          task_id: String(t.id), start: fmt(start, true, uz), duration: `${q.minutes}m`,
          ...(q.description?.trim() && { description: q.description.trim() }), ...(q.billable !== undefined && { billable: q.billable }),
        },
      }],
    };
  }

  /**
   * Writing in Docs (markdown): a new Doc (`name`, with `content` as its first page; private unless `visibility` says
   * public), a new page of a Doc (`docId` and `name`), or a page changed (`docId` and `pageId`: its text replaced, or
   * added at its end or start, and its name).
   */
  async planDoc(q: { name?: string; content?: string; docId?: string; pageId?: string; parentPageId?: string; mode?: 'replace' | 'append' | 'prepend'; workspaceId?: string; visibility?: 'private' | 'public' }): Promise<ClickUpAction> {
    const content = q.content?.trim();
    if (content && content.length > 5 * MAX_WRITE) throw new ClickUpError(`at most ${5 * MAX_WRITE} characters per page`);
    const name = q.name?.trim();
    const text = content ? [{ label: 'Text', value: content }] : [];
    if (!q.docId) {
      if (!name) throw new ClickUpError('give name for a new Doc, or doc_id for one there (ids from clickup_list_docs)');
      const ws = await this.cu.workspace(q.workspaceId);
      const open = q.visibility === 'public';
      return {
        title: `Create Doc "${name}" in ${ws.name}`, details: [{ label: 'Seen by', value: open ? 'everyone in the workspace' : 'only you, until shared' }, ...text],
        calls: [
          { tool: 'clickup_create_document', workspace: ws.id, what: 'creating the Doc', args: { name, parent: { id: ws.id, type: 12 }, visibility: open ? 'PUBLIC' : 'PRIVATE', create_page: !content } },
          ...(content ? [{ tool: 'clickup_create_document_page', workspace: ws.id, what: 'writing its page', args: { document_id: '{0.document_id}', name, content, content_format: 'text/md' } } as ClickUpCall] : []),
        ],
      };
    }
    const d = await this.findDoc(q.docId, q.workspaceId);
    if (!q.pageId) {
      if (!name) throw new ClickUpError('give name for a new page, or page_id to change one (ids from clickup_get_doc)');
      return {
        title: `Add page "${name}" to ${d.name}`, details: text,
        calls: [{
          tool: 'clickup_create_document_page', workspace: d.ws, what: 'creating the page',
          args: { document_id: d.id, name, content: content ?? '', content_format: 'text/md', ...(q.parentPageId && { parent_page_id: q.parentPageId.trim() }) },
        }],
      };
    }
    if (!content && !name) throw new ClickUpError('give content or name to change the page');
    const p = await this.page(d, q.pageId);
    const mode = q.mode ?? 'replace';
    return {
      title: `Change page "${p.name ?? q.pageId}" of ${d.name}`,
      details: [
        ...(name ? [{ label: 'Rename to', value: name }] : []),
        ...(content ? [{ label: mode === 'replace' ? 'Replace its text with' : mode === 'append' ? 'Add at its end' : 'Add at its start', value: content }] : []),
      ],
      calls: [{
        tool: 'clickup_update_document_page', workspace: d.ws, what: 'changing the page',
        args: { document_id: d.id, page_id: String(p.id), ...(name && { name }), ...(content && { content, content_edit_mode: mode, content_format: 'text/md' }) },
      }],
    };
  }

  /**
   * Makes an approved change. A refusal by ClickUp means that step did nothing; any other failure does not say, and is
   * uncertain. Steps done before a failure stay done and are named, so nobody repeats them without knowing. `files` go
   * first, to `task`; a call that asks for it (`links`) then ends its text with a line naming each.
   */
  async perform(a: ClickUpAction, files: OutFile[] = [], task?: TaskRef) {
    if (files.length && !task) throw new ClickUpError('files need a task to be uploaded to');
    if (!files.length && !a.calls.length) throw new ClickUpError('nothing to do');
    if (a.calls.some((c) => typeof c?.tool !== 'string' || !c.args)) {
      throw new ClickUpError('this change was asked for before ClickUp moved to its own connection and cannot run any more; reject it and ask again', 400);
    }
    const tz = await this.cu.timeZone();
    const links = files.length ? await this.cu.attach(task!, files) : [];
    const attached = links.length ? onTask(task!, links) : '';
    const results: any[] = [];
    for (const [i, c] of a.calls.entries()) {
      const done = () => `${i ? ` Already done: ${a.calls.slice(0, i).map((x) => x.what).join(', ')}.` : ''}${attached}`;
      let missing = false;
      const args = Object.fromEntries(Object.entries(c.args).map(([k, v]) => {
        const m = typeof v === 'string' ? /^\{(\d+)\.([\w.]+)\}$/.exec(v) : null;
        if (!m) return [k, v];
        const got = m[2]!.split('.').reduce((o: any, key) => o?.[key], results[Number(m[1])]);
        if (got === undefined || got === null || got === '') missing = true;
        return [k, got];
      }));
      if (missing) throw new ClickUpError(`${c.what} could not start: ClickUp gave no id for the step before.${done()}`);
      if (c.links && links.length) args[c.links] = `${String(args[c.links] ?? '')}\n\n${links.map(fileLink).join('\n')}`;
      try {
        const r = await this.cu.call(c.tool, args, c.workspace);
        if (r?.success === false) throw new ClickUpUncertain(String(r.error ?? r.message ?? 'ClickUp did not confirm it'));
        results.push(r);
      } catch (e) {
        const msg = `${c.what} failed: ${(e as Error).message}.${done()}`;
        const status = e instanceof ClickUpError ? e.status : undefined;
        throw refused(e) ? new ClickUpError(msg, status) : new ClickUpUncertain(`${msg} Check ClickUp before asking again.`, status);
      }
    }
    const first = results[0] ?? {};
    const p = localParts(Date.now(), tz);
    const id = first.task_id ?? first.document_id ?? first.comment_id ?? first.page_id ?? first.timeEntry?.id ?? first.id;
    const url = [first.task_url, first.document_url, first.url].find((u) => typeof u === 'string' && u) ?? a.url;
    return { done: true, id: id ? String(id) : null, ...(url && { url }), ...(links.length && { attached: links.length }), date: p.date, time: p.time };
  }
}

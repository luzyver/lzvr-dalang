/**
 * ClickUp beyond chat, for the MCP gateway: the Space → Folder → List tree, tasks (find, read, with comments), time
 * entries and Docs. Reading happens at once. Every change (a task made or changed, a comment, a link, time
 * logged, a Doc written) is first planned: checked against ClickUp and put in words as a ClickUpAction, which waits for
 * the person's approval and only then runs (`perform`).
 */
import {
  type ClickUp, ClickUpError, ClickUpUncertain, DAY_MS, localParts, MAX_DAYS, MAX_REQUESTS, onTask, type OutFile, type Query, refused, stamp,
  startOfDay, type TaskRef,
} from './clickup.js';

/**
 * One request of an action. `{0.id}` in its path stands for a field of the answer to an earlier call (here: the first).
 * `links` names the plain text of a comment's body (`comment_text`): with files uploaded for the action it goes as
 * rich text instead (`comment`), that text followed by a link to each file, since plain text makes no links.
 */
export interface ClickUpCall { method: 'POST' | 'PUT' | 'DELETE'; path: string; query?: Query; body?: unknown; what: string; links?: string }
/** A file that goes with an action, as the approval shows it. */
export interface FileNote { name: string; size: number }
const fileSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 * 1024 ? `${Math.round(n / 1024)} KB` : `${(n / 1024 / 1024).toFixed(1)} MB`);
const fileList = (files: FileNote[]) => files.map((f) => `${f.name} (${fileSize(f.size)})`).join(', ');
/** A change to ClickUp, named for the approval card and kept as the requests that make it. */
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
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const enc = encodeURIComponent;

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

/** ClickUp represents a date without a time as 04:00 in the API user's timezone. */
function taskDate(task: any, key: 'due' | 'start', displayZone: string, userZone: string): string | undefined {
  const ms = num(task[`${key}_date`]);
  if (ms === null) return undefined;
  const local = localParts(ms, userZone);
  const timed = task[`${key}_date_time`] ?? (local.time !== '04:00');
  return timed ? fmt(ms, true, displayZone) : local.date;
}

/** A task in one line of a list. */
function row(t: any, tz: string, userZone: string) {
  const due = taskDate(t, 'due', tz, userZone);
  const assignees = ((t.assignees ?? []) as any[]).map((a) => String(a.username || a.email || a.id));
  return {
    id: String(t.id), ...(t.custom_id && { custom_id: String(t.custom_id) }), name: String(t.name ?? ''),
    status: String(t.status?.status ?? ''), ...(assignees.length && { assignees }),
    ...(due && { due }),
    ...(t.priority?.priority && { priority: String(t.priority.priority) }),
    ...(t.list?.name && { list: String(t.list.name) }), ...(t.parent && { parent: String(t.parent) }),
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
    case 'users': return Array.isArray(v) ? v.map((u) => u.username ?? u.email ?? u.id) : v;
    case 'tasks': return Array.isArray(v) ? v.map((t) => ({ id: t.id, name: t.name })) : v;
    default: return v;
  }
}

const listRow = (l: any) => ({ id: String(l.id), name: String(l.name ?? ''), ...(l.task_count != null && { tasks: Number(l.task_count) }) });

export class ClickUpWork {
  constructor(private readonly cu: ClickUp) {}

  /** id -> name of everyone in the workspaces the token sees. */
  private async names(): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    for (const w of await this.cu.allWorkspaces()) for (const [id, name] of w.members) out.set(id, name);
    return out;
  }

  /** User ids as ClickUp takes them (numbers), `me` being the token's own user; each must be someone of a workspace. */
  private async people(ids: string[] | undefined): Promise<{ id: number; name: string }[]> {
    if (!ids?.length) return [];
    const [me, names] = await Promise.all([this.cu.user(), this.names()]);
    return ids.map((raw) => {
      const id = raw === 'me' ? me.id : raw.trim();
      const name = names.get(id);
      if (!name || !/^\d+$/.test(id)) throw new ClickUpError(`no person ${raw} in the workspace (ids from clickup_find_people, or "me")`);
      return { id: Number(id), name };
    });
  }

  /** Spaces with their folders and lists, in the given workspaces (default: see ClickUp.workspaces), or one space of them. */
  async spaces(workspaceIds?: string[], spaceId?: string, archived = false) {
    const budget = { left: MAX_REQUESTS };
    const out: unknown[] = [];
    for (const ws of await this.cu.workspaces(workspaceIds)) {
      const r = await this.cu.get(`/api/v2/team/${ws.id}/space`, { archived }, budget);
      for (const s of (r.spaces ?? []) as any[]) {
        if (spaceId && String(s.id) !== spaceId) continue;
        const folders = await this.cu.get(`/api/v2/space/${s.id}/folder`, { archived }, budget);
        const lists = await this.cu.get(`/api/v2/space/${s.id}/list`, { archived }, budget);
        out.push({
          id: String(s.id), name: String(s.name ?? ''), workspace_id: ws.id, workspace: ws.name,
          lists: ((lists.lists ?? []) as any[]).map(listRow),
          folders: ((folders.folders ?? []) as any[]).map((f) => ({ id: String(f.id), name: String(f.name ?? ''), lists: ((f.lists ?? []) as any[]).map(listRow) })),
        });
      }
    }
    if (spaceId && !out.length) throw new ClickUpError(`no space ${spaceId} (ids from clickup_list_spaces)`);
    return out;
  }

  /** A list as ClickUp gives it; a 4xx says it is not one the user can open. */
  private async rawList(id: string): Promise<any> {
    try {
      return await this.cu.get(`/api/v2/list/${enc(id.trim())}`);
    } catch (e) {
      if (e instanceof ClickUpError && [403, 404].includes(e.status ?? 0)) throw new ClickUpError(`no list ${id} that this ClickUp user can open (ids from clickup_list_spaces)`, (e as ClickUpError).status);
      throw e;
    }
  }

  /** A list: where it is, the statuses its tasks can have and its custom fields (with their options). */
  async list(listId: string) {
    const l = await this.rawList(listId);
    const fields = await this.cu.get(`/api/v2/list/${enc(String(l.id))}/field`);
    return {
      id: String(l.id), name: String(l.name ?? ''), space: l.space?.name, ...(l.folder && !l.folder.hidden && { folder: l.folder.name }),
      statuses: ((l.statuses ?? []) as any[]).map((s) => ({ status: String(s.status), type: String(s.type ?? '') })),
      custom_fields: ((fields.fields ?? []) as any[]).map((f) => ({
        id: String(f.id), name: String(f.name ?? ''), type: String(f.type ?? ''), ...(f.required && { required: true }),
        ...(f.type_config?.options?.length && { options: (f.type_config.options as any[]).map((o) => ({ id: o.id, name: o.name ?? o.label })) }),
      })),
    };
  }

  /** Tasks matching the filters, last changed first. Closed tasks and subtasks only on request. */
  async findTasks(q: TaskQuery) {
    const [me, workspaces, tz, userZone] = await Promise.all([this.cu.user(), this.cu.workspaces(q.workspaceIds), this.cu.timeZone(), this.cu.userZone()]);
    const limit = Math.min(Math.max(q.limit ?? 50, 1), 200);
    if (q.parent) {
      const parent = await this.cu.rawTask(q.parent, { include_subtasks: true });
      const needle = q.query?.trim().toLowerCase() ?? '';
      const subs = ((parent.subtasks ?? []) as any[]).filter((t) => [t.name, t.custom_id].some((v) => String(v ?? '').toLowerCase().includes(needle)));
      return { time_zone: tz, tasks: subs.slice(0, limit).map((t) => ({ ...row(t, tz, userZone), parent: String(parent.id) })),
        ...(subs.length > limit && { warnings: [`more than ${limit} subtasks match`] }) };
    }
    const filters: Query = {
      order_by: 'updated', subtasks: q.subtasks || undefined, include_closed: q.includeClosed || undefined,
      'list_ids[]': q.listIds, 'space_ids[]': q.spaceIds, 'project_ids[]': q.folderIds, 'statuses[]': q.statuses, 'tags[]': q.tags,
      'assignees[]': q.assignees?.map((a) => (a === 'me' ? me.id : a)),
      due_date_gt: q.dueFrom ? dayStart(q.dueFrom, tz) - 1 : undefined, due_date_lt: q.dueTo ? dayStart(q.dueTo, tz, true) : undefined,
      date_updated_gt: q.updatedSince ? dayStart(q.updatedSince, tz) - 1 : undefined,
    };
    const needle = q.query?.trim().toLowerCase();
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
        for (let page = 0; ; page++) {
          if (page >= MAX_PAGES) { warnings.push(`${ws.name}: stopped after ${MAX_PAGES * 100} tasks; narrow the filters`); break; }
          const r = await this.cu.get(`/api/v2/team/${ws.id}/task`, { ...filters, page }, budget);
          const tasks = (r.tasks ?? []) as any[];
          for (const t of tasks) {
            if (needle && !String(t.name ?? '').toLowerCase().includes(needle) && !String(t.custom_id ?? '').toLowerCase().includes(needle)) continue;
            const updated = num(t.date_updated) ?? Date.parse(String(t.date_updated));
            rows.push({ ts: Number.isFinite(updated) ? updated : 0, ...row(t, tz, userZone), ...(workspaces.length > 1 && { workspace: ws.name }) });
            own++;
          }
          const last = r.last_page === true || tasks.length < 100;
          if (own >= limit && !last) more = true;
          if (last || own >= limit) break;
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
  private async comments(taskId: string, max: number): Promise<{ list: any[]; more: boolean }> {
    const list: any[] = [];
    const budget = { left: MAX_COMMENT_PAGES };
    for (let after: any; ;) {
      const r = await this.cu.get(`/api/v2/task/${enc(taskId)}/comment`, after ? { start: Number(after.date), start_id: String(after.id) } : {}, budget);
      const page = (r.comments ?? []) as any[];
      list.push(...page);
      if (page.length < COMMENT_PAGE) return { list: list.slice(0, max), more: list.length > max };
      if (list.length >= max || budget.left <= 0) return { list: list.slice(0, max), more: true };
      after = page[page.length - 1];
    }
  }

  /** One task in full; with `comments`, its latest comments too (newest first, at most `commentLimit`). */
  async task(ref: string, comments = false, commentLimit = 50) {
    const [t, tz, userZone] = await Promise.all([this.cu.rawTask(ref, { include_subtasks: true, include_markdown_description: true }), this.cu.timeZone(), this.cu.userZone()]);
    const at = (v: unknown, time = true) => (num(v) === null ? undefined : fmt(num(v)!, time, tz));
    const text = String(t.markdown_description ?? t.description ?? '').trim();
    const start = taskDate(t, 'start', tz, userZone);
    const fields = ((t.custom_fields ?? []) as any[])
      .map((f) => ({ id: String(f.id), name: String(f.name ?? ''), type: String(f.type ?? ''), value: fieldValue(f, tz) }))
      .filter((f) => f.value !== undefined);
    const deps = (t.dependencies ?? []) as any[];
    const waitingOn = deps.filter((d) => d.task_id === t.id).map((d) => String(d.depends_on));
    const blocking = deps.filter((d) => d.depends_on === t.id).map((d) => String(d.task_id));
    const linked = ((t.linked_tasks ?? []) as any[]).map((l) => String(l.link_id === t.id ? l.task_id : l.link_id));
    const out = {
      ...row(t, tz, userZone), workspace_id: String(t.team_id ?? ''), list_id: String(t.list?.id ?? ''),
      ...(t.folder?.name && !t.folder.hidden && { folder: String(t.folder.name) }), ...(t.space?.id && { space_id: String(t.space.id) }),
      creator: t.creator?.username ?? t.creator?.email, created: at(t.date_created), updated: at(t.date_updated),
      ...(num(t.date_closed) !== null && { closed: at(t.date_closed) }), ...(start && { start }),
      ...(num(t.time_estimate) !== null && { time_estimate_minutes: minutes(num(t.time_estimate)!) }),
      ...(num(t.time_spent) && { time_spent_minutes: minutes(num(t.time_spent)!) }),
      ...(t.tags?.length && { tags: (t.tags as any[]).map((x) => String(x.name)) }),
      description: clip(text, MAX_TEXT), ...(text.length > MAX_TEXT && { description_cut: true }),
      ...(fields.length && { custom_fields: fields }),
      ...(t.checklists?.length && { checklists: (t.checklists as any[]).map((c) => ({
        id: String(c.id), name: String(c.name ?? ''),
        items: ((c.items ?? []) as any[]).map((i) => ({ id: String(i.id), name: String(i.name ?? ''), done: Boolean(i.resolved) })),
      })) }),
      ...(t.subtasks?.length && { subtasks: (t.subtasks as any[]).map((s) => ({ id: String(s.id), name: String(s.name ?? ''), status: String(s.status?.status ?? '') })) }),
      ...(waitingOn.length && { waiting_on: waitingOn }), ...(blocking.length && { blocking }), ...(linked.length && { linked }),
      ...(t.attachments?.length && { attachments: (t.attachments as any[]).map((a) => ({ name: String(a.title ?? a.id), url: String(a.url ?? '') })) }),
    };
    if (!comments) return out;
    const r = await this.comments(String(t.id), Math.min(Math.max(commentLimit, 1), MAX_COMMENTS));
    return {
      ...out, ...(r.more && { comments_more: true }),
      comments: r.list.map((c) => {
        const body = String(c.comment_text ?? '').trim();
        return {
          id: String(c.id), ...(num(c.date) !== null && stamp(num(c.date)!, tz)), author: String(c.user?.username ?? c.user?.email ?? c.user?.id ?? ''),
          text: clip(body, MAX_COMMENT), ...(c.resolved && { resolved: true }), ...(c.assignee && { assigned_to: c.assignee.username ?? c.assignee.id }),
          ...(Number(c.reply_count) > 0 && { replies: Number(c.reply_count) }),
        };
      }),
    };
  }

  /**
   * Time entries between two local dates (both included), oldest first, with the minutes of each day and in all. The
   * token's own entries unless other people are named (ClickUp shows those to workspace owners and admins only).
   */
  async timeEntries(q: { from: string; to: string; workspaceIds?: string[]; assignees?: string[]; task?: string }) {
    const [tz, who] = await Promise.all([this.cu.timeZone(), this.people(q.assignees)]);
    const fromMs = dayStart(q.from, tz);
    const endMs = dayStart(q.to, tz, true);
    if (endMs <= fromMs) throw new ClickUpError('to must not be before from');
    if (endMs - fromMs > MAX_DAYS * DAY_MS) throw new ClickUpError(`at most ${MAX_DAYS} days per call; split the range`);
    const task = q.task ? await this.cu.rawTask(q.task) : undefined;
    if (task && !task.team_id) throw new ClickUpError('ClickUp did not return the workspace of the task');
    const taskWorkspace = task ? String(task.team_id) : undefined;
    if (taskWorkspace && q.workspaceIds?.length && !q.workspaceIds.includes(taskWorkspace)) {
      throw new ClickUpError(`Task ${task.id} belongs to workspace ${taskWorkspace}, outside workspace_ids (${q.workspaceIds.join(', ')})`);
    }
    const workspaces = await this.cu.workspaces(q.workspaceIds?.length ? q.workspaceIds : taskWorkspace ? [taskWorkspace] : undefined);
    const rows: ({ ts: number; date: string; weekday: string; minutes: number } & Record<string, unknown>)[] = [];
    const warnings: string[] = [];
    let read = 0;
    let failed: unknown;
    for (const ws of workspaces.filter((w) => !task || w.id === taskWorkspace)) {
      try {
        const r = await this.cu.get(`/api/v2/team/${ws.id}/time_entries`, {
          start_date: fromMs, end_date: endMs - 1, assignee: who.length ? who.map((p) => p.id).join(',') : undefined,
          task_id: task ? String(task.id) : undefined, include_location_names: true,
        });
        for (const e of (r.data ?? []) as any[]) {
          const start = num(e.start);
          if (start === null || start < fromMs || start >= endMs) continue;
          const dur = num(e.duration) ?? 0;
          const s = stamp(start, tz);
          const end = num(e.end);
          rows.push({
            ts: start, id: String(e.id), date: s.date, weekday: s.weekday, start: s.time,
            ...(dur < 0 ? { running: true } : end !== null && { end: localParts(end, tz).time }), minutes: dur < 0 ? 0 : minutes(dur),
            user: String(e.user?.username ?? e.user?.email ?? e.user?.id ?? ''),
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

  /** Docs of the workspaces, optionally those whose name contains `query`. */
  async docs(workspaceIds?: string[], query?: string, limit = 50, searchIn: 'name' | 'name_and_content' = 'name_and_content') {
    const max = Math.min(Math.max(limit, 1), 200);
    const words = query?.trim();
    if (words && searchIn === 'name_and_content') return this.searchDocs(workspaceIds, words, max);
    const needle = words?.toLowerCase();
    const tz = await this.cu.timeZone();
    const budget = { left: 30 };
    const out: unknown[] = [];
    for (const ws of await this.cu.workspaces(workspaceIds)) {
      let cursor: string | undefined;
      do {
        const r = await this.cu.get(`/api/v3/workspaces/${ws.id}/docs`, { limit: 100, cursor }, budget);
        for (const d of (r.docs ?? r.data ?? []) as any[]) {
          if (needle && !String(d.name ?? '').toLowerCase().includes(needle)) continue;
          out.push({
            id: String(d.id), name: String(d.name ?? ''), workspace_id: ws.id, workspace: ws.name,
            ...(num(d.date_updated) !== null && { updated: fmt(num(d.date_updated)!, false, tz) }),
          });
        }
        cursor = r.next_cursor || undefined;
      } while (cursor && out.length < max && budget.left > 0);
    }
    return out.slice(0, max);
  }

  private async searchDocs(workspaceIds: string[] | undefined, query: string, max: number) {
    const mcp = await this.cu.special();
    const tz = await this.cu.timeZone();
    const budget = { left: 30 };
    const out = new Map<string, unknown>();
    for (const ws of await this.cu.workspaces(workspaceIds)) {
      let cursor: string | undefined;
      do {
        const r = await mcp.call('clickup_search', { workspace_id: ws.id,
          keywords: query, filters: { asset_types: ['doc'] }, count: Math.min(max, 50), cursor,
        }, budget);
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

  /** The Doc `id` and its workspace: the one named, else the first of those read by default that has it. */
  private async findDoc(id: string, workspaceId?: string): Promise<{ ws: string; workspace: string; id: string; name: string }> {
    id = id.trim().replace(/^.*\/(?:docs|dc)\/([\w-]+).*$/, '$1');
    for (const ws of await this.cu.workspaces(workspaceId ? [workspaceId] : undefined)) {
      try {
        const r = await this.cu.get(`/api/v3/workspaces/${ws.id}/docs/${enc(id.trim())}`);
        const d = r?.data ?? r;
        return { ws: ws.id, workspace: ws.name, id: String(d?.id ?? id.trim()), name: String(d?.name ?? id) };
      } catch (e) {
        if (!(e instanceof ClickUpError && [403, 404].includes(e.status ?? 0))) throw e;
      }
    }
    throw new ClickUpError(`no Doc ${id} that this ClickUp user can open (ids from clickup_list_docs)`);
  }

  /** A Doc's pages as a tree of names; with `pageId`, that page's text (markdown). A Doc of one page comes with its text. */
  async doc(docId: string, pageId?: string, workspaceId?: string) {
    const d = await this.findDoc(docId, workspaceId);
    const base = `/api/v3/workspaces/${d.ws}/docs/${enc(d.id)}/pages`;
    const page = (p: any) => {
      const text = String(p.content ?? '');
      return { id: String(p.id), name: String(p.name ?? ''), content: clip(text, MAX_PAGE_TEXT), ...(text.length > MAX_PAGE_TEXT && { content_cut: true }) };
    };
    if (pageId) {
      let p: any;
      try {
        p = await this.cu.get(`${base}/${enc(pageId.trim())}`, { content_format: 'text/md' });
      } catch (e) {
        if (e instanceof ClickUpError && [403, 404].includes(e.status ?? 0)) throw new ClickUpError(`no page ${pageId} in Doc "${d.name}" (ids from clickup_get_doc without page_id)`);
        throw e;
      }
      return { doc_id: d.id, doc: d.name, workspace: d.workspace, page: page(p?.data ?? p) };
    }
    const r = await this.cu.get(base, { max_page_depth: -1, content_format: 'text/md' });
    const pages = (Array.isArray(r) ? r : r.pages ?? r.data ?? []) as any[];
    const tree = (list: any[]): unknown[] => list.map((p) => ({ id: String(p.id), name: String(p.name ?? ''), ...(p.pages?.length && { pages: tree(p.pages) }) }));
    const single = pages.length === 1 && !pages[0].pages?.length;
    return { doc_id: d.id, doc: d.name, workspace: d.workspace, pages: single ? [page(pages[0])] : tree(pages) };
  }

  // ---- changes: each is checked and named here, and made by `perform` once the person approved it ----

  /** What a create or change sets, as the request body and as rows for the card. */
  private async fields(f: TaskFields, tz: string, statuses: any[] | undefined, old?: any) {
    const body: Record<string, unknown> = {};
    const details: { label: string; value: string }[] = [];
    const change = (label: string, value: string, was?: string) => details.push({ label, value: was !== undefined && was !== value ? `${was || 'none'} → ${value}` : value });
    if (f.name !== undefined) {
      if (!f.name.trim()) throw new ClickUpError('the name is empty');
      body.name = f.name.trim();
      if (old) change('Name', f.name.trim(), String(old.name ?? ''));
    }
    if (f.status !== undefined) {
      const known = (statuses ?? []).map((s) => String(s.status));
      const hit = known.find((s) => s.toLowerCase() === f.status!.trim().toLowerCase());
      if (known.length && !hit) throw new ClickUpError(`the list has no status "${f.status}" (it has: ${known.join(', ')})`);
      body.status = hit ?? f.status.trim();
      change('Status', String(body.status), old ? String(old.status?.status ?? '') : undefined);
    }
    if (f.priority !== undefined) {
      body.priority = f.priority === 'none' ? null : PRIORITIES.indexOf(f.priority) + 1;
      change('Priority', f.priority, old ? String(old.priority?.priority ?? 'none') : undefined);
    }
    for (const [key, label] of [['due', 'Due'], ['start', 'Start']] as const) {
      const v = f[key];
      if (v === undefined) continue;
      const was = old ? taskDate(old, key, tz, await this.cu.userZone()) ?? '' : undefined;
      if (!v.trim()) {
        if (!old) continue;
        body[`${key}_date`] = null;
        change(label, 'none', was);
      } else {
        const w = when(v, tz);
        body[`${key}_date`] = w.ms;
        body[`${key}_date_time`] = w.time;
        change(label, fmt(w.ms, w.time, tz), was);
      }
    }
    if (f.timeEstimateMinutes !== undefined) {
      body.time_estimate = f.timeEstimateMinutes * 60_000;
      change('Time estimate', hours(f.timeEstimateMinutes), old ? hours(minutes(num(old.time_estimate) ?? 0)) : undefined);
    }
    if (f.parent !== undefined) {
      const p = await this.cu.rawTask(f.parent);
      body.parent = String(p.id);
      change(old ? 'Move under' : 'Subtask of', String(p.name ?? p.id));
    }
    if (f.description !== undefined) {
      if (f.description.length > MAX_WRITE) throw new ClickUpError(`at most ${MAX_WRITE} characters of description`);
      body.markdown_content = f.description.trim() || ' '; // ClickUp clears a description with a space
      details.push({ label: old ? 'New description' : 'Description', value: f.description.trim() || '(emptied)' });
    }
    return { body, details };
  }

  /** Rows for the custom fields set, named after the fields known (a list's or a task's). */
  private customRows(set: { id: string; value: unknown }[], known: any[]) {
    return set.map((c) => {
      const f = known.find((x) => String(x.id) === c.id);
      if (!f) throw new ClickUpError(`no custom field ${c.id} here (ids from clickup_get_list)`);
      return { label: `Field "${f.name}"`, value: c.value === null ? 'cleared' : typeof c.value === 'string' ? c.value : JSON.stringify(c.value) };
    });
  }

  async planCreateTask(q: NewTask): Promise<ClickUpAction> {
    const [l, tz, who] = await Promise.all([this.rawList(q.listId), this.cu.timeZone(), this.people(q.assignees)]);
    const { body, details } = await this.fields(q, tz, l.statuses);
    if (who.length) { body.assignees = who.map((p) => p.id); details.push({ label: 'Assignees', value: who.map((p) => p.name).join(', ') }); }
    const tags = (q.tags ?? []).map((t) => t.trim()).filter(Boolean);
    if (tags.length) { body.tags = tags; details.push({ label: 'Tags', value: tags.join(', ') }); }
    if (q.customFields?.length) {
      const known = (await this.cu.get(`/api/v2/list/${enc(String(l.id))}/field`)).fields ?? [];
      details.push(...this.customRows(q.customFields, known));
      body.custom_fields = q.customFields;
    }
    return {
      title: `Create task "${body.name}" in list "${l.name}"${l.space?.name ? ` (${l.space.name})` : ''}`, details,
      calls: [{ method: 'POST', path: `/api/v2/list/${enc(String(l.id))}/task`, body, what: 'creating the task' }],
    };
  }

  async planUpdateTask(q: TaskChange): Promise<ClickUpAction> {
    const [t, tz, add, rem] = await Promise.all([this.cu.rawTask(q.task), this.cu.timeZone(), this.people(q.addAssignees), this.people(q.removeAssignees)]);
    const id = enc(String(t.id));
    // A task that moves takes its status from the list it moves to, so that is the list a status is checked against.
    const dest = q.moveToList ? await this.rawList(q.moveToList) : undefined;
    const statuses = dest ? dest.statuses : q.status !== undefined && t.list?.id ? (await this.rawList(String(t.list.id))).statuses : undefined;
    const { body, details } = await this.fields(q, tz, statuses, t);
    if (add.length || rem.length) {
      body.assignees = { add: add.map((p) => p.id), rem: rem.map((p) => p.id) };
      if (add.length) details.push({ label: 'Assign', value: add.map((p) => p.name).join(', ') });
      if (rem.length) details.push({ label: 'Unassign', value: rem.map((p) => p.name).join(', ') });
    }
    const calls: ClickUpCall[] = [];
    if (dest) {
      if (t.parent) throw new ClickUpError('A subtask cannot move to another list');
      // The move goes first, so a status of the new list can be set after it. A status the new list lacks must be
      // mapped to one it has, or ClickUp refuses the move.
      const has = ((dest.statuses ?? []) as any[]);
      const now = String(t.status?.status ?? '');
      const move: Record<string, unknown> = {};
      if (has.length && !has.some((s) => String(s.status).toLowerCase() === now.toLowerCase())) {
        const to = has.find((s) => String(s.status) === body.status);
        if (!to) throw new ClickUpError(`list "${dest.name}" has no status "${now}": give the status the task gets there (it has: ${has.map((s) => s.status).join(', ')})`);
        if (t.status?.id && to.id) move.status_mappings = [{ source_status_id: String(t.status.id), destination_status_id: String(to.id) }];
      }
      details.push({ label: 'Move to list', value: `${t.list?.name ?? '?'} → ${dest.name}` });
      calls.push({ method: 'PUT', path: `/api/v3/workspaces/${enc(String(t.team_id))}/tasks/${id}/home_list/${enc(String(dest.id))}`, body: move, what: `moving it to list "${dest.name}"` });
    }
    if (Object.keys(body).length) calls.push({ method: 'PUT', path: `/api/v2/task/${id}`, body, what: 'changing the task' });
    const tags = (list?: string[]) => (list ?? []).map((x) => x.trim()).filter(Boolean);
    for (const tag of tags(q.addTags)) calls.push({ method: 'POST', path: `/api/v2/task/${id}/tag/${enc(tag)}`, what: `adding tag "${tag}"` });
    for (const tag of tags(q.removeTags)) calls.push({ method: 'DELETE', path: `/api/v2/task/${id}/tag/${enc(tag)}`, what: `removing tag "${tag}"` });
    if (tags(q.addTags).length) details.push({ label: 'Add tags', value: tags(q.addTags).join(', ') });
    if (tags(q.removeTags).length) details.push({ label: 'Remove tags', value: tags(q.removeTags).join(', ') });
    if (q.customFields?.length) {
      const rows = this.customRows(q.customFields, t.custom_fields ?? []);
      details.push(...rows);
      q.customFields.forEach((c, i) => calls.push(c.value === null
        ? { method: 'DELETE', path: `/api/v2/task/${id}/field/${enc(c.id)}`, what: `clearing ${rows[i]!.label.toLowerCase()}` }
        : { method: 'POST', path: `/api/v2/task/${id}/field/${enc(c.id)}`, body: { value: c.value }, what: `setting ${rows[i]!.label.toLowerCase()}` }));
    }
    if (!calls.length) throw new ClickUpError('nothing to change: name what to set');
    return { title: `Change task "${t.name}"`, details, url: String(t.url ?? ''), calls };
  }

  /**
   * A comment on a task, or a reply to one of its comments (`replyTo`, an id from the task's comments). `files` are
   * uploaded to the task first (see `perform`) and the comment ends with a link to each.
   */
  async planComment(q: { task: string; text: string; replyTo?: string; assignee?: string; notifyAll?: boolean; files?: FileNote[] }): Promise<ClickUpAction> {
    const text = q.text.trim();
    if (!text) throw new ClickUpError('the comment is empty');
    if (text.length > MAX_WRITE) throw new ClickUpError(`at most ${MAX_WRITE} characters per comment`);
    const [t, who] = await Promise.all([this.cu.rawTask(q.task), this.people(q.assignee ? [q.assignee] : undefined)]);
    const details: { label: string; value: string }[] = [];
    let path = `/api/v2/task/${enc(String(t.id))}/comment`;
    if (q.replyTo) {
      const all = await this.comments(String(t.id), MAX_COMMENTS);
      const c = all.list.find((x) => String(x.id) === q.replyTo!.trim());
      if (!c) throw new ClickUpError(`comment ${q.replyTo} is not among the latest ${all.list.length} of "${t.name}" (ids from clickup_get_task with comments)`);
      details.push({ label: 'Reply to', value: `${c.user?.username ?? 'someone'}: ${clip(String(c.comment_text ?? '').trim(), 200)}` });
      path = `/api/v2/comment/${enc(String(c.id))}/reply`;
    }
    if (who.length) details.push({ label: 'Assign the comment to', value: who[0]!.name });
    details.push({ label: 'Comment', value: text });
    if (q.files?.length) details.push({ label: 'Files', value: `${fileList(q.files)}: attached to the task, linked at the end of the comment` });
    return {
      title: `${q.replyTo ? 'Reply to a comment' : 'Comment'} on task "${t.name}"`, details, url: String(t.url ?? ''),
      calls: [{ method: 'POST', path, body: { comment_text: text, notify_all: Boolean(q.notifyAll), ...(who.length && { assignee: who[0]!.id }) }, what: 'posting the comment', links: 'comment_text' }],
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
    const [a, b] = await Promise.all([this.cu.rawTask(q.task), this.cu.rawTask(q.other)]);
    if (String(a.id) === String(b.id)) throw new ClickUpError('a task cannot be tied to itself');
    const id = enc(String(a.id));
    const words = q.kind === 'waits_on' ? 'wait on' : q.kind === 'blocks' ? 'block' : 'be linked to';
    const title = q.remove ? `Task "${a.name}" no longer to ${words} "${b.name}"` : `Make task "${a.name}" ${words} "${b.name}"`;
    const key = q.kind === 'waits_on' ? 'depends_on' : 'dependency_of';
    const what = q.remove ? 'removing the tie' : 'tying the tasks';
    const call: ClickUpCall = q.kind === 'link'
      ? { method: q.remove ? 'DELETE' : 'POST', path: `/api/v2/task/${id}/link/${enc(String(b.id))}`, what }
      : q.remove
        ? { method: 'DELETE', path: `/api/v2/task/${id}/dependency`, query: { [key]: String(b.id) }, what }
        : { method: 'POST', path: `/api/v2/task/${id}/dependency`, body: { [key]: String(b.id) }, what };
    return { title, details: [], url: String(a.url ?? ''), calls: [call] };
  }

  /** Time worked on a task as the API key owner. */
  async planLogTime(q: { task: string; date: string; start: string; minutes: number; description?: string; billable?: boolean }): Promise<ClickUpAction> {
    if (!/^\d{2}:\d{2}$/.test(q.start.trim())) throw new ClickUpError(`start must be a time like 09:30: ${q.start}`);
    if (!DATE_RE.test(q.date)) throw new ClickUpError(`not a date like 2026-10-01: ${q.date}`);
    const [t, tz] = await Promise.all([this.cu.rawTask(q.task), this.cu.timeZone()]);
    const ws = t.team_id;
    if (!ws) throw new ClickUpError('ClickUp did not return the workspace of the task');
    const start = when(`${q.date} ${q.start.trim()}`, tz).ms;
    const end = localParts(start + q.minutes * 60_000, tz);
    const details = [
      { label: 'When', value: `${q.date} ${q.start.trim()} to ${end.date === q.date ? end.time : `${end.date} ${end.time}`} (${hours(q.minutes)})` },
      ...(q.description?.trim() ? [{ label: 'Description', value: q.description.trim() }] : []),
      ...(q.billable ? [{ label: 'Billable', value: 'yes' }] : []),
    ];
    return {
      title: `Log ${hours(q.minutes)} on task "${t.name}"`, details, ...(t?.url && { url: String(t.url) }),
      calls: [{
        method: 'POST', path: `/api/v2/team/${enc(ws)}/time_entries`,
        body: { start, duration: q.minutes * 60_000, tid: String(t.id), ...(q.description?.trim() && { description: q.description.trim() }), ...(q.billable !== undefined && { billable: q.billable }) },
        what: 'logging the time',
      }],
    };
  }

  /**
   * Writing in Docs (markdown): a new Doc (`name`, with `content` as its first page), a new page of a Doc (`docId` and
   * `name`), or a page changed (`docId` and `pageId`: its text replaced, or added at its end or start, and its name).
   */
  async planDoc(q: { name?: string; content?: string; docId?: string; pageId?: string; parentPageId?: string; mode?: 'replace' | 'append' | 'prepend'; visibility?: 'private' | 'public'; workspaceId?: string }): Promise<ClickUpAction> {
    const content = q.content?.trim();
    if (content && content.length > 5 * MAX_WRITE) throw new ClickUpError(`at most ${5 * MAX_WRITE} characters per page`);
    const name = q.name?.trim();
    const text = content ? [{ label: 'Text', value: content }] : [];
    if (!q.docId) {
      if (!name) throw new ClickUpError('give name for a new Doc, or doc_id for one there (ids from clickup_list_docs)');
      const all = await this.cu.workspaces(q.workspaceId ? [q.workspaceId] : undefined);
      if (all.length !== 1) throw new ClickUpError(`give workspace_id: there are ${all.length} workspaces (${all.map((w) => `${w.id} ${w.name}`).join(', ')})`);
      const base = `/api/v3/workspaces/${all[0]!.id}/docs`;
      return {
        title: `Create Doc "${name}" in ${all[0]!.name}`, details: [{ label: 'Visibility', value: q.visibility ?? 'private' }, ...text],
        calls: [
          { method: 'POST', path: base, body: { name, visibility: q.visibility === 'public' ? 'PUBLIC' : 'PRIVATE', create_page: !content }, what: 'creating the Doc' },
          ...(content ? [{ method: 'POST', path: `${base}/{0.id}/pages`, body: { name, content, content_format: 'text/md' }, what: 'writing its page' } as ClickUpCall] : []),
        ],
      };
    }
    const d = await this.findDoc(q.docId, q.workspaceId);
    const pages = `/api/v3/workspaces/${d.ws}/docs/${enc(d.id)}/pages`;
    if (!q.pageId) {
      if (!name) throw new ClickUpError('give name for a new page, or page_id to change one (ids from clickup_get_doc)');
      return {
        title: `Add page "${name}" to Doc "${d.name}"`, details: text,
        calls: [{
          method: 'POST', path: pages, what: 'creating the page',
          body: { name, ...(content && { content, content_format: 'text/md' }), ...(q.parentPageId && { parent_page_id: q.parentPageId.trim() }) },
        }],
      };
    }
    if (!content && !name) throw new ClickUpError('give content or name to change the page');
    let p: any;
    try {
      p = await this.cu.get(`${pages}/${enc(q.pageId.trim())}`, { content_format: 'text/md' });
      p = p?.data ?? p;
    } catch (e) {
      if (e instanceof ClickUpError && [403, 404].includes(e.status ?? 0)) throw new ClickUpError(`no page ${q.pageId} in Doc "${d.name}" (ids from clickup_get_doc)`);
      throw e;
    }
    const mode = q.mode ?? 'replace';
    return {
      title: `Change page "${p.name ?? q.pageId}" of Doc "${d.name}"`,
      details: [
        ...(name ? [{ label: 'Rename to', value: name }] : []),
        ...(content ? [{ label: mode === 'replace' ? 'Replace its text with' : mode === 'append' ? 'Add at its end' : 'Add at its start', value: content }] : []),
      ],
      calls: [{
        method: 'PUT', path: `${pages}/${enc(String(p.id ?? q.pageId.trim()))}`, what: 'changing the page',
        body: { ...(name && { name }), ...(content && { content, content_edit_mode: mode, content_format: 'text/md' }) },
      }],
    };
  }

  /**
   * Makes an approved change. A refusal by ClickUp (a 4xx) means that step did nothing; any other failure does not say,
   * and is uncertain. Steps done before a failure stay done and are named, so nobody repeats them without knowing.
   * `files` go first, to `task`; a call that asks for it (`links`) then ends its text with a link to each.
   */
  async perform(a: ClickUpAction, files: OutFile[] = [], task?: TaskRef) {
    if (files.length && !task) throw new ClickUpError('files need a task to be uploaded to');
    if (!files.length && !a.calls.length) throw new ClickUpError('nothing to do');
    const tz = await this.cu.timeZone();
    const links = files.length ? await this.cu.attach(task!, files) : [];
    const attached = links.length ? onTask(task!, links) : '';
    const results: any[] = [];
    for (const [i, c] of a.calls.entries()) {
      const done = () => `${i ? ` Already done: ${a.calls.slice(0, i).map((x) => x.what).join(', ')}.` : ''}${attached}`;
      let missing = false;
      const path = c.path.replace(/\{(\d+)\.([\w.]+)\}/g, (_, n: string, key: string) => {
        const pick = (from: any) => key.split('.').reduce((o: any, k) => o?.[k], from);
        const v = pick(results[Number(n)]) ?? pick(results[Number(n)]?.data);
        if (v === undefined || v === null || v === '') missing = true;
        return enc(String(v ?? ''));
      });
      if (missing) throw new ClickUpError(`${c.what} could not start: ClickUp gave no id for the step before.${done()}`);
      try {
        let body = c.body;
        if (c.links && links.length) {
          const { [c.links]: plain, ...rest } = c.body as Record<string, unknown>;
          body = { ...rest, comment: [
            { text: `${plain}\n`, attributes: {} },
            ...links.flatMap((f) => [{ text: '\n📎 ', attributes: {} }, { text: f.name, attributes: { link: f.url } }]),
          ] };
        }
        results.push(await this.cu.request(c.method, path, c.query ?? {}, body));
      } catch (e) {
        const msg = `${c.what} failed: ${(e as Error).message}.${done()}`;
        const status = e instanceof ClickUpError ? e.status : undefined;
        throw refused(e) ? new ClickUpError(msg, status) : new ClickUpUncertain(`${msg} Check ClickUp before asking again.`, status);
      }
    }
    const first = results[0]?.data ?? results[0] ?? {};
    const p = localParts(Date.now(), tz);
    const url = typeof first.url === 'string' && first.url ? first.url : a.url;
    return { done: true, id: first.id ? String(first.id) : null, ...(url && { url }), ...(links.length && { attached: links.length }), date: p.date, time: p.time };
  }
}

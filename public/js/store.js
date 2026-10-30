// App state as signals: who is signed in, the projects and their chats, what the main area shows, and the open
// overlays. Components read `.value` and re-render when it changes; actions below are the only writers.
import { batch, computed, signal } from '../vendor/signals.js';
import { api, Unauthorized } from './api.js';

export const me = signal(null);
export const isAdmin = computed(() => me.value?.role === 'admin'); // the server enforces this; the panel only hides what would be refused
export const isOwner = computed(() => me.value?.name === 'owner'); // the main token or the owner's sign-in (no panel user may take the name)
export const projects = signal([]);
/** project id -> its chats */
export const convs = signal(new Map());
/**
 * What the main area shows: { view: 'home' } | { view: 'chat', id, focusEvent } | { view: 'schedules' } | { view: 'approvals' } | { view: 'ssh' },
 * or, in a tab of its own, { view: 'code', id }: the code editor on a chat's folder, or { view: 'sql' }: the SQL editor.
 */
export const route = signal({ view: 'home' });
export const approvals = signal([]);
/** Database writes agents asked for on "write with approval" connections of the SQL editor (admins). */
export const dbApprovals = signal([]);
/** Users' requests to index a project's code graph, waiting for an admin. */
export const indexRequests = signal([]);
/** Commands agents asked to run on SSH hosts set to "every command after approval" (admins). */
export const sshApprovals = signal([]);

const wide = () => innerWidth > 1280;
const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const ui = {
  /** mobile: the sidebar drawer; desktop: whether the sidebar column is shown */
  sidebarOpen: signal(false),
  sidebarHidden: signal(pref('dalang-sidebar-hidden', false)),
  /** Closed until asked for, or until a turn in the open chat leaves changed files (see autoOpenInspector). */
  inspectorOpen: signal(wide() && pref('dalang-inspector', false)),
  /** The inspector's width in px on wide screens (dragged at its edge), and whether it fills the main area. */
  inspectorWidth: signal(pref('dalang-inspector-width', 480)),
  inspectorMax: signal(false),
  inspectorTab: signal('changes'),
  palette: signal(false),
  /** the open settings section, or null */
  settings: signal(null),
  addProject: signal(false),
  collapsed: signal(new Set(pref('dalang-collapsed', []))),
  /** How the sidebar lists chats: 'project' (each project with its chats) or 'status' (needs you, running, recent). */
  groupBy: signal(pref('dalang-group-by', 'project')),
};

export function setGroupBy(by) {
  ui.groupBy.value = by;
  keep('dalang-group-by', by);
}

/**
 * chat id -> the `last_at` of its last turn when it was last looked at, so a chat that finished a turn since shows as
 * unread. Kept on this device only. Before the first look ever, every chat counts as seen (seeded in loadProjects).
 * The mark only moves forward, so details that come back late cannot turn a read turn unread again.
 */
export const seen = signal(pref('dalang-seen', null));
function markSeen(list) {
  const next = { ...seen.value };
  let changed = false;
  for (const c of list) if (c.last_at && !(next[c.id] >= c.last_at)) { next[c.id] = c.last_at; changed = true; }
  if (!changed) return;
  seen.value = next;
  keep('dalang-seen', next);
}

/** Chats whose inspector was closed by hand: changed files do not open it again there until the page reloads. */
const dismissed = new Set();

export function toggleInspector(open = !ui.inspectorOpen.value, tab) {
  const r = route.peek();
  if (r.view === 'chat') { if (open) dismissed.delete(r.id); else dismissed.add(r.id); }
  batch(() => {
    if (tab) ui.inspectorTab.value = tab;
    ui.inspectorOpen.value = open;
    if (!open) ui.inspectorMax.value = false;
  });
  if (wide()) keep('dalang-inspector', open);
}

/** The open chat's files changed: show them, on a screen wide enough for a column, unless it was closed there. */
export function autoOpenInspector(id, changed) {
  if (!changed || !wide() || ui.inspectorOpen.peek() || dismissed.has(id)) return;
  batch(() => { ui.inspectorTab.value = 'changes'; ui.inspectorOpen.value = true; });
}

export function setInspectorWidth(px) {
  const w = Math.round(Math.min(Math.max(px, 360), Math.max(360, innerWidth - 560)));
  ui.inspectorWidth.value = w;
  keep('dalang-inspector-width', w);
}
export function toggleSidebar() {
  if (innerWidth <= 900) ui.sidebarOpen.value = !ui.sidebarOpen.value;
  else { ui.sidebarHidden.value = !ui.sidebarHidden.value; keep('dalang-sidebar-hidden', ui.sidebarHidden.value); }
}
export function toggleCollapsed(projectId) {
  const next = new Set(ui.collapsed.value);
  if (next.has(projectId)) next.delete(projectId); else next.add(projectId);
  ui.collapsed.value = next;
  keep('dalang-collapsed', [...next]);
}

// ---------- toasts ----------
export const toasts = signal([]);
let toastId = 0;
export function dismissToast(id) { toasts.value = toasts.value.filter((t) => t.id !== id); }
/** A short message at the bottom of the screen; `tone`: 'ok' | 'err'. */
export function toast(text, tone = 'ok') {
  if (!text) return;
  const id = ++toastId;
  toasts.value = [...toasts.value.slice(-3), { id, text, tone }];
  setTimeout(() => dismissToast(id), tone === 'err' ? 8000 : 4000);
}
/** Wraps an async handler: a failure becomes an error toast (a 401 already sent the user to the sign-in screen). */
export const guarded = (fn) => async (...args) => {
  try { return await fn(...args); } catch (e) { if (!(e instanceof Unauthorized)) toast(e.message, 'err'); return undefined; }
};

// ---------- projects and chats ----------
export function findConv(id) {
  for (const project of projects.value) {
    const conv = (convs.value.get(project.id) || []).find((c) => c.id === id);
    if (conv) return { project, conv };
  }
  return null;
}

export async function loadProjects() {
  const list = await api('/api/projects');
  const entries = await Promise.all(list.map(async (p) => [p.id, await api(`/api/projects/${p.id}/conversations`)]));
  batch(() => {
    projects.value = list;
    convs.value = new Map(entries);
  });
  if (!seen.value) { seen.value = {}; markSeen(entries.flatMap(([, l]) => l)); }
  // The open chat is gone (deleted elsewhere, or its project removed); the one in view is read as it changes.
  const r = route.value;
  if (r.view === 'chat' && !findConv(r.id)) goHome();
  else if (r.view === 'chat') markSeen([findConv(r.id).conv]);
}

/**
 * Patch a chat in the sidebar's lists (status, title or last turn changed in the open chat). The chat in view, or one
 * whose turn was watched to its end (`read`), is read as it changes, so the next poll does not show it as unread.
 * A patch older than what the list has (details that came back after newer ones) is dropped.
 */
export function patchConv(id, patch, read = false) {
  const found = findConv(id);
  if (!found || (patch.last_at && found.conv.last_at && patch.last_at < found.conv.last_at)) return;
  const conv = { ...found.conv, ...patch };
  const r = route.peek();
  if (read || (r.view === 'chat' && r.id === id)) markSeen([conv]);
  if (Object.entries(patch).every(([k, v]) => found.conv[k] === v)) return;
  const next = new Map(convs.value);
  next.set(found.project.id, next.get(found.project.id).map((c) => (c.id === id ? conv : c)));
  convs.value = next;
}

const setHash = (hash) => history.replaceState(null, '', `${location.pathname}${location.search}${hash}`);

/** `focusEvent`: the id of a message to scroll to and mark (from a search result). */
export function openChat(id, focusEvent) {
  if (!findConv(id)) { goHome(); return; }
  batch(() => {
    route.value = { view: 'chat', id, focusEvent };
    ui.sidebarOpen.value = false;
    ui.palette.value = false;
  });
  markSeen([findConv(id).conv]);
  setHash(`#c=${encodeURIComponent(id)}`);
}

export function goHome() {
  route.value = { view: 'home' };
  setHash('');
}

export function openView(view) {
  batch(() => {
    route.value = { view };
    ui.sidebarOpen.value = false;
    ui.palette.value = false;
  });
  setHash('');
}

/** The code editor on a chat's folder, in a new browser tab (it signs in with the same stored token). */
export function openCodeEditor(id) {
  window.open(`/code#c=${encodeURIComponent(id)}`, `dalang-code-${id}`);
}

/** The SQL editor in its own browser tab: the panel's database connections, not tied to a chat. */
export function openSqlEditor() {
  window.open('/sql', 'dalang-sql');
}

/** `worktree`: the chat gets its own git branch and folder, so it cannot collide with other chats in the project. */
export const newChat = (project, worktree = false) => guarded(async () => {
  const c = await api(`/api/projects/${project.id}/conversations`, { method: 'POST', body: worktree ? { worktree } : {} });
  await loadProjects();
  openChat(c.id);
});

export async function refreshApprovals() {
  if (!isAdmin.value) return;
  try {
    const [chats, dbs, indexes, ssh] = await Promise.all([api('/api/approvals'), api('/api/db/approvals'), api('/api/code-memory/requests'), api('/api/ssh/approvals')]);
    batch(() => { approvals.value = chats; dbApprovals.value = dbs; indexRequests.value = indexes; sshApprovals.value = ssh; });
  } catch { /* retried on the next tick */ }
}

export function openSettings(section = 'appearance') {
  batch(() => {
    ui.settings.value = section;
    ui.palette.value = false;
    ui.sidebarOpen.value = false;
  });
}

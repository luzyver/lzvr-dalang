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
/** What the main area shows: { view: 'home' } | { view: 'chat', id, focusEvent } | { view: 'schedules' } | { view: 'approvals' } */
export const route = signal({ view: 'home' });
export const approvals = signal([]);

const wide = () => innerWidth > 1280;
const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

export const ui = {
  /** mobile: the sidebar drawer; desktop: whether the sidebar column is shown */
  sidebarOpen: signal(false),
  sidebarHidden: signal(pref('dalang-sidebar-hidden', false)),
  inspectorOpen: signal(wide() && pref('dalang-inspector', true)),
  inspectorTab: signal('changes'),
  palette: signal(false),
  /** the open settings section, or null */
  settings: signal(null),
  addProject: signal(false),
  collapsed: signal(new Set(pref('dalang-collapsed', []))),
};

export function toggleInspector(open = !ui.inspectorOpen.value, tab) {
  batch(() => {
    if (tab) ui.inspectorTab.value = tab;
    ui.inspectorOpen.value = open;
  });
  if (wide()) keep('dalang-inspector', open);
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
  // The open chat is gone (deleted elsewhere, or its project removed).
  const r = route.value;
  if (r.view === 'chat' && !findConv(r.id)) goHome();
}

/** Patch a chat in the sidebar's lists (status or title changed in the open chat). */
export function patchConv(id, patch) {
  const found = findConv(id);
  if (!found || Object.entries(patch).every(([k, v]) => found.conv[k] === v)) return;
  const next = new Map(convs.value);
  next.set(found.project.id, next.get(found.project.id).map((c) => (c.id === id ? { ...c, ...patch } : c)));
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

/** `worktree`: the chat gets its own git branch and folder, so it cannot collide with other chats in the project. */
export const newChat = (project, worktree = false) => guarded(async () => {
  const c = await api(`/api/projects/${project.id}/conversations`, { method: 'POST', body: worktree ? { worktree } : {} });
  await loadProjects();
  openChat(c.id);
});

export async function refreshApprovals() {
  if (!isAdmin.value) return;
  try { approvals.value = await api('/api/approvals'); } catch { /* retried on the next tick */ }
}

export function openSettings(section = 'appearance') {
  batch(() => {
    ui.settings.value = section;
    ui.palette.value = false;
    ui.sidebarOpen.value = false;
  });
}

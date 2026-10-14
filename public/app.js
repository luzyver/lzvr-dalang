// Dalang panel: the app shell (header, menu, sidebar, main area). Every feature lives in its own module under js/.
// Every server-provided string is inserted as text, never parsed as HTML.
import { h, icon } from './js/dom.js';
import { api, currentToken, tokenStore, Unauthorized, setUnauthorizedHandler } from './js/api.js';
import { loginScreen } from './js/login.js';
import { sidebar as createSidebar } from './js/sidebar.js';
import { chatView } from './js/chat-view.js';
import { accountsPage } from './js/accounts.js';
import { usersPage } from './js/users.js';
import { defaultsPage, promptsPage } from './js/settings.js';
import { approvals as createApprovals } from './js/approvals.js';
import { schedulesPage } from './js/schedules.js';
import { searchPage } from './js/search.js';
import { enableNotifications, registerPasskey } from './js/passkeys.js';

const root = document.getElementById('root');
let stopStream = null;
let refreshTimer = null;
let notificationOpensChat = null; // set by showApp; one service-worker listener (below) calls it

function stopChat() { if (stopStream) { stopStream(); stopStream = null; } }

/** Revoke the session on the server (passkey sessions last 30 days), then forget the token here. */
async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${currentToken()}` } }); } catch { /* offline: still sign out locally */ }
  showLogin();
}

function showLogin(message) {
  stopChat();
  clearInterval(refreshTimer);
  tokenStore.clear();
  root.replaceChildren(loginScreen({ message, onSignedIn: showApp }));
}

async function showApp() {
  let me;
  try { me = await api('/api/me'); } catch (e) { if (!(e instanceof Unauthorized)) showLogin(e.message); return; }
  const isAdmin = me.role === 'admin'; // the server enforces this; the panel only hides what would be refused
  const state = { projects: [], convs: new Map(), current: null, collapsedProjects: new Set() };
  const main = h('main');
  const status = h('span', { class: 'small' });

  const flash = (msg) => { status.textContent = msg; if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 5000); };
  const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!(e instanceof Unauthorized)) flash(e.message); } };

  // Every menu action opens as a page in the main area instead of a chat; closing it goes back to the chat that was open.
  function openPage(content) {
    stopChat();
    document.body.classList.remove('nav');
    main.replaceChildren(h('div', { class: 'page' }, content));
  }
  const closePage = () => drawMain(state.current);
  const page = { guarded, flash, close: closePage }; // what every page module gets

  const lookup = (id) => {
    for (const project of state.projects) {
      const conv = (state.convs.get(project.id) || []).find((c) => c.id === id);
      if (conv) return { project, conv };
    }
    return null;
  };
  async function loadProjects() {
    state.projects = await api('/api/projects');
    for (const p of state.projects) state.convs.set(p.id, await api(`/api/projects/${p.id}/conversations`));
    side.draw();
  }
  /** The open chat is gone (deleted, or its project removed). */
  function leaveConv() {
    stopChat();
    state.current = null;
    history.replaceState(null, '', `${location.pathname}${location.search}`);
    drawMain(null);
  }
  /** `focusEvent`: the id of a message to scroll to and mark (from a search result). */
  function openConv(id, focusEvent) {
    stopChat();
    if (!lookup(id)) { leaveConv(); return; }
    state.current = id;
    history.replaceState(null, '', `${location.pathname}${location.search}#c=${encodeURIComponent(id)}`);
    document.body.classList.remove('nav');
    side.draw();
    drawMain(id, focusEvent);
  }
  function drawMain(id, focusEvent) {
    stopChat();
    if (!id) {
      main.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Dalang'), h('p', {}, 'Pick a chat, or start a new one with the + next to a project.'),
        h('button', { class: 'primary mobonly', onclick: () => document.body.classList.add('nav') }, 'Open chats')));
      return;
    }
    const view = chatView({ id, focusEvent, lookup, ...page, openPage, onChange: () => loadProjects().catch(() => {}), onUpdate: () => side.draw() });
    main.replaceChildren(...view.nodes);
    stopStream = view.stop;
  }

  const side = createSidebar({ state, isAdmin, ...page, reload: loadProjects, openConv, leaveConv, openPage,
    openSearch: (query) => openPage(searchPage({ query, ...page, open: openConv })) });
  const approvals = createApprovals({ guarded, openPage, close: closePage });

  document.body.classList.remove('nav');
  const menu = h('details', { class: 'menu' },
    h('summary', {}, h('span', { class: 'avatar' }, me.name.slice(0, 1).toUpperCase()), h('span', { class: 'uname' }, me.name)),
    h('div', { class: 'pop', onclick: () => { menu.open = false; } },
      h('div', { class: 'small who' }, `${me.name} · ${me.role}`),
      isAdmin && h('button', { onclick: () => openPage(accountsPage({ backend: 'codex', ...page })) }, 'Codex accounts'),
      isAdmin && h('button', { onclick: () => openPage(accountsPage({ backend: 'claude', ...page })) }, 'Claude Code accounts'),
      isAdmin && h('button', { onclick: () => openPage(defaultsPage(page)) }, 'Model & effort defaults'),
      isAdmin && h('button', { onclick: () => openPage(promptsPage(page)) }, 'Generate prompts'),
      isAdmin && h('button', { onclick: () => openPage(usersPage(page)) }, 'Manage users'),
      h('button', { onclick: () => openPage(schedulesPage({ ...page, open: (id) => openConv(id) })) }, 'Scheduled prompts'),
      h('button', { onclick: guarded(async () => { await enableNotifications(); flash('notifications on'); }) }, 'Enable notifications'),
      h('button', { onclick: guarded(async () => { await registerPasskey(); flash('passkey registered'); }) }, 'Add passkey'),
      h('button', { class: 'danger', onclick: signOut }, 'Sign out')));
  document.onclick = (e) => { if (!menu.contains(e.target)) menu.open = false; };
  const header = h('header', {},
    h('button', { class: 'navtoggle', 'aria-label': 'chats', onclick: () => document.body.classList.toggle('nav') }, icon('panel-left')),
    h('span', { class: 'title' }, 'Dalang'), approvals.button,
    h('span', { class: 'spacer' }), status, menu);
  root.replaceChildren(h('div', { class: 'shell' }, header, side.el, main));
  notificationOpensChat = (id) => openConv(id);

  drawMain(null);
  try { await loadProjects(); } catch (e) { if (!(e instanceof Unauthorized)) flash(e.message); return; }
  if (isAdmin) {
    // First run: nothing works until an account exists, so an admin lands straight in the sign-in step.
    Promise.all([api('/api/accounts'), api('/api/accounts?backend=claude')])
      .then(([a, c]) => { if (!a.length && !c.length) openPage(accountsPage({ backend: 'codex', ...page })); }).catch(() => {});
    approvals.refresh();
  }
  clearInterval(refreshTimer);
  refreshTimer = setInterval(() => { if (isAdmin) approvals.refresh(); }, 15000);

  const fromHash = /#c=([\w-]+)/.exec(location.hash);
  if (fromHash) openConv(fromHash[1]);
}

// ---------- boot ----------
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('/sw.js').catch(() => {});
  // Registered once (not per login): a tapped notification opens its chat in whichever app view is current.
  navigator.serviceWorker.addEventListener('message', (m) => {
    if (m.data && m.data.convId && notificationOpensChat) notificationOpensChat(m.data.convId);
  });
}
setUnauthorizedHandler(showLogin);
if (currentToken()) showApp(); else showLogin();

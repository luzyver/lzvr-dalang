// Signing in and out, and loading what the app needs once signed in.
import { batch, signal } from '../vendor/signals.js';
import { api, currentToken, publicApi, setUnauthorizedHandler, tokenStore, Unauthorized } from './api.js';
import { loadProjects, me, openChat, openSettings, refreshApprovals, route, toast } from './store.js';
import { disableNotifications, restoreNotifications } from './notifications.js';
import { refreshScheduleCount } from './schedules.js';

/** 'checking' (a stored token is being tried, or whether one is needed at all), 'out' or 'in'. */
export const session = signal('checking');
export const loginMessage = signal('');
let timer = 0;

export function showLogin(message = '') {
  clearInterval(timer);
  tokenStore.clear();
  batch(() => {
    me.value = null;
    route.value = { view: 'home' };
    loginMessage.value = message;
    session.value = 'out';
  });
}

/** Revoke the session on the server (sessions last 30 days), then forget the token here. */
export async function signOut() {
  try { await disableNotifications(); } catch { /* still revoke the session */ }
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${currentToken()}` } }); } catch { /* offline: still sign out locally */ }
  showLogin();
}

export async function startSession() {
  let user;
  try { user = await api('/api/me'); } catch (e) { if (!(e instanceof Unauthorized)) showLogin(e.message); return; }
  // Both pages name the chat with #c=<id>; under /code it opens the code editor, from its first frame (never the chat view in between).
  const fromHash = /#c=([\w-]+)/.exec(location.hash);
  const code = fromHash && location.pathname.startsWith('/code');
  const sql = location.pathname.startsWith('/sql');
  batch(() => {
    me.value = user;
    if (code) route.value = { view: 'code', id: fromHash[1] };
    else if (sql) route.value = { view: 'sql' };
    session.value = 'in';
  });
  try { await loadProjects(); } catch (e) { if (!(e instanceof Unauthorized)) toast(e.message, 'err'); return; }
  void restoreNotifications().catch(() => {});
  refreshScheduleCount();
  if (user.role === 'admin') {
    refreshApprovals();
    // First run: nothing works until an account exists, so an admin lands straight in the sign-in step.
    Promise.all([api('/api/accounts'), api('/api/accounts?backend=claude')])
      .then(([a, c]) => { if (!a.length && !c.length) openSettings('codex'); }).catch(() => {});
  }
  clearInterval(timer);
  // Agents start sub-agents and chats change status on their own: keep the sidebar current while the panel is in view.
  timer = setInterval(() => {
    refreshApprovals();
    if (document.visibilityState === 'visible') loadProjects().catch(() => {});
  }, 15000);
  if (fromHash && !code && !sql) openChat(fromHash[1]);
}

/**
 * On load: try the stored token. Without one, ask the server first instead of showing the sign-in form straight away:
 * with AUTH_BYPASS (local development) there is nothing to sign in with, and the form would only flash.
 */
export function bootSession() {
  if (currentToken()) { startSession(); return; }
  publicApi('/api/auth/status').then((s) => { if (s.bypass) startSession(); else session.value = 'out'; }, () => { session.value = 'out'; });
}

setUnauthorizedHandler(() => showLogin());

// Signing in and out, and loading what the app needs once signed in.
import { batch, signal } from '../vendor/signals.js';
import { api, currentToken, setUnauthorizedHandler, tokenStore, Unauthorized } from './api.js';
import { loadProjects, me, openChat, openSettings, refreshApprovals, route, toast } from './store.js';
import { refreshScheduleCount } from './schedules.js';

/** 'checking' (a stored token is being tried), 'out' or 'in'. */
export const session = signal(currentToken() ? 'checking' : 'out');
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

/** Revoke the session on the server (passkey sessions last 30 days), then forget the token here. */
export async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${currentToken()}` } }); } catch { /* offline: still sign out locally */ }
  showLogin();
}

export async function startSession() {
  let user;
  try { user = await api('/api/me'); } catch (e) { if (!(e instanceof Unauthorized)) showLogin(e.message); return; }
  batch(() => {
    me.value = user;
    session.value = 'in';
  });
  try { await loadProjects(); } catch (e) { if (!(e instanceof Unauthorized)) toast(e.message, 'err'); return; }
  refreshScheduleCount();
  if (user.role === 'admin') {
    refreshApprovals();
    // First run: nothing works until an account exists, so an admin lands straight in the sign-in step.
    Promise.all([api('/api/accounts'), api('/api/accounts?backend=claude')])
      .then(([a, c]) => { if (!a.length && !c.length) openSettings('codex'); }).catch(() => {});
  }
  clearInterval(timer);
  timer = setInterval(refreshApprovals, 15000);
  const fromHash = /#c=([\w-]+)/.exec(location.hash);
  if (fromHash) openChat(fromHash[1]);
}

setUnauthorizedHandler(() => showLogin());

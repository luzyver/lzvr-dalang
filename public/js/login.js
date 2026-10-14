// The sign-in screen: an access token, or a passkey when one is registered on the server.
import { h } from './dom.js';
import { publicApi, tokenStore } from './api.js';
import { loginWithPasskey } from './passkeys.js';

/** `onSignedIn` runs once a token is stored. */
export function loginScreen({ message, onSignedIn }) {
  const err = h('div', { class: 'error' }, message || '');
  const input = h('input', { type: 'password', placeholder: 'access token', autocomplete: 'current-password' });
  const go = async () => {
    const t = input.value.trim();
    if (!t) return;
    // Not api(): a 401 there rebuilds this screen and the message below would go to a detached element.
    const res = await fetch('/api/projects', { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    if (res && res.ok) { tokenStore.set(t); onSignedIn(); return; }
    err.textContent = !res ? 'cannot reach the server' : res.status === 429 ? 'too many attempts, wait a minute' : 'wrong token';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const passkeyBtn = h('button', { onclick: async () => {
    err.textContent = '';
    try { await loginWithPasskey(); onSignedIn(); } catch (e) { err.textContent = e.message; }
  } }, 'Sign in with passkey');
  passkeyBtn.hidden = true;
  publicApi('/api/auth/status').then((s) => { passkeyBtn.hidden = !s.passkeys; }).catch(() => {});
  return h('div', { class: 'login' },
    h('h1', {}, 'Dalang'), input,
    h('button', { class: 'primary', onclick: go }, 'Sign in'), passkeyBtn, err);
}

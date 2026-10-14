// The sign-in screen: an access token, or a passkey when one is registered on the server.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html } from './lib.js';
import { publicApi, tokenStore } from './api.js';
import { Icon, Spinner } from './ui.js';
import { loginWithPasskey } from './passkeys.js';
import { loginMessage, startSession } from './session.js';

export function Login() {
  const [token, setToken] = useState('');
  const [error, setError] = useState(loginMessage.value);
  const [busy, setBusy] = useState(false);
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => { publicApi('/api/auth/status').then((s) => setPasskeys(!!s.passkeys)).catch(() => {}); }, []);

  const signIn = async (e) => {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    setBusy(true);
    setError('');
    // Not api(): a 401 there would rebuild this screen and lose the message below.
    const res = await fetch('/api/projects', { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    setBusy(false);
    if (res && res.ok) { tokenStore.set(t); startSession(); return; }
    setError(!res ? 'Cannot reach the server' : res.status === 429 ? 'Too many attempts, wait a minute' : 'Wrong token');
  };
  const passkey = async () => {
    setError('');
    try { await loginWithPasskey(); startSession(); } catch (e) { setError(e.message); }
  };

  return html`<div class="login-screen">
    <form class="login" onSubmit=${signIn}>
      <span class="logo lg" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.5c3.6 2.8 6 6.3 6 10.2a6 6 0 0 1-12 0c0-3.9 2.4-7.4 6-10.2Z" /><path d="M12 9v12" /></svg></span>
      <div><h1>Sign in to Dalang</h1><p class="dim">The control room for your coding agents.</p></div>
      <label class="field"><span class="field-label">Access token</span>
        <input type="password" autocomplete="current-password" autofocus value=${token} onInput=${(e) => setToken(e.currentTarget.value)} /></label>
      <button class="btn primary lg" type="submit" disabled=${busy}>${busy && html`<${Spinner} />`}Sign in</button>
      ${passkeys && html`<button class="btn lg" type="button" onClick=${passkey}><${Icon} name="key-round" />Sign in with passkey</button>`}
      <div class="form-error" role="alert">${error}</div>
    </form>
  </div>`;
}

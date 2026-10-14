// The sign-in screen: a code mailed to your email.
// The access token stays as a fallback for when the mailer is not set up.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html } from './lib.js';
import { publicApi, tokenStore } from './api.js';
import { Logo, Spinner } from './ui.js';
import { loginMessage, startSession } from './session.js';

export function Login() {
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [sent, setSent] = useState(false); // a code went out: the button says Resend and the hint shows
  const [cooldown, setCooldown] = useState(0);
  const [token, setToken] = useState('');
  const [useToken, setUseToken] = useState(false);
  const [error, setError] = useState(loginMessage.value);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState({ email: true });
  useEffect(() => {
    publicApi('/api/auth/status').then((s) => {
      if (s.bypass) { startSession(); return; } // AUTH_BYPASS (local development): nothing to sign in with
      setStatus(s);
      if (!s.email) setUseToken(true);
    }).catch(() => {});
  }, []);
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setTimeout(() => setCooldown(cooldown - 1), 1000);
    return () => clearTimeout(t);
  }, [cooldown]);

  const run = async (fn) => {
    setBusy(true);
    setError('');
    try { await fn(); } catch (e) { setError(e.message); }
    setBusy(false);
  };
  const sendCode = () => {
    if (!email.trim() || cooldown > 0) return;
    run(async () => {
      try {
        const r = await publicApi('/api/auth/otp/request', { email: email.trim() });
        setSent(true);
        setCooldown(r.cooldown || 60);
        document.getElementById('login-code')?.focus();
      } catch (err) {
        const wait = /wait (\d+)s/.exec(err.message);
        if (wait) { setSent(true); setCooldown(Number(wait[1])); }
        throw err;
      }
    });
  };
  const verify = (e) => {
    e.preventDefault();
    if (!code.trim()) return;
    run(async () => {
      const r = await publicApi('/api/auth/otp/verify', { email: email.trim(), code: code.trim() }).catch((err) => {
        throw new Error(/too many|429/i.test(err.message) ? 'Too many attempts, wait a minute' : 'Wrong or expired code');
      });
      tokenStore.set(r.token);
      startSession();
    });
  };
  const signInToken = (e) => {
    e.preventDefault();
    const t = token.trim();
    if (!t) return;
    run(async () => {
      // Not api(): a 401 there would rebuild this screen and lose the message below.
      const res = await fetch('/api/projects', { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
      if (res && res.ok) { tokenStore.set(t); startSession(); return; }
      throw new Error(!res ? 'Cannot reach the server' : res.status === 429 ? 'Too many attempts, wait a minute' : 'Wrong token');
    });
  };

  // One form: Send code mails the code, Sign in (or Enter) trades it in.
  const emailForm = html`<form class="login-fields" onSubmit=${verify}>
      <label class="field"><span class="field-label">Email</span>
        <input type="email" autocomplete="email" autofocus value=${email} onInput=${(e) => setEmail(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter' && code.length !== 6) { e.preventDefault(); sendCode(); } }} /></label>
      <div class="field"><label class="field-label" for="login-code">Code</label>
        <div class="login-send">
          <input id="login-code" class="mono" inputmode="numeric" autocomplete="one-time-code" maxlength="6" placeholder="6 digits" value=${code}
            onInput=${(e) => setCode(e.currentTarget.value.replace(/\D/g, ''))} />
          <button class="btn" type="button" disabled=${busy || cooldown > 0 || !email.trim()} onClick=${sendCode}>
            ${cooldown > 0 ? `Resend (${cooldown}s)` : sent ? 'Resend' : 'Send code'}</button>
        </div>
        ${sent && html`<span class="field-hint">If ${email.trim()} may sign in, a code is on its way. It is valid for 5 minutes.</span>`}</div>
      <button class="btn primary lg" type="submit" disabled=${busy || !email.trim() || code.length !== 6}>${busy && html`<${Spinner} />`}Sign in</button>
    </form>`;
  const tokenForm = html`<form class="login-fields" onSubmit=${signInToken}>
      <label class="field"><span class="field-label">Access token</span>
        <input type="password" autocomplete="current-password" autofocus value=${token} onInput=${(e) => setToken(e.currentTarget.value)} /></label>
      <button class="btn primary lg" type="submit" disabled=${busy}>${busy && html`<${Spinner} />`}Sign in</button>
    </form>`;

  return html`<div class="login-screen">
    <div class="login">
      <${Logo} size=${44} />
      <div><h1>Sign in to Dalang</h1><p class="dim">The control room for your coding agents.</p></div>
      ${useToken ? tokenForm : emailForm}
      ${status.email && html`<button class="btn ghost sm" type="button" onClick=${() => { setUseToken(!useToken); setError(''); }}>
        ${useToken ? 'Sign in with email' : 'Use an access token'}</button>`}
      <div class="form-error" role="alert">${error}</div>
    </div>
  </div>`;
}

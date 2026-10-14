// Codex / Claude Code accounts (admins): the list with usage meters, and adding one by running the CLI's login on the server.
import { useEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Empty, Field, Icon, Spinner, Switch } from './ui.js';
import { guarded, toast } from './store.js';
import { refreshUsage } from './sidebar.js';
import { copyText } from './code.js';
import { duration } from './format.js';

/** One bar per usage window (the share still left) as last reported by the CLI during a turn. A window past its reset counts as full. */
function Limits({ l }) {
  if (!l) return html`<div class="dim small">Usage appears after this account runs its first turn.</div>`;
  return html`<div class="meters">${l.windows.map((w) => {
    const over = w.resetsAt * 1000 < Date.now();
    const left = over ? 100 : Math.max(0, 100 - Math.round(w.usedPercent));
    return html`<div class="meter-row" title=${`resets ${new Date(w.resetsAt * 1000).toLocaleString()}`}>
      <span class="meter-label">${w.label}</span>
      <div class="meter"><span class=${cx(left <= 10 ? 'hot' : left <= 30 && 'warm')} style=${{ width: `${left}%` }}></span></div>
      <span class="meter-pct">${left}%</span>
      <span class="dim small">${over ? 'reset' : `resets in ${duration(w.resetsAt * 1000 - Date.now()).replace(/ \d+s$/, '')}`}</span>
    </div>`;
  })}</div>`;
}

function AddAccount({ backend, label, onDone }) {
  const [name, setName] = useState('');
  const [login, setLogin] = useState(null); // { id, status, output, url, code, error }
  const [code, setCode] = useState('');
  const timer = useRef(0);
  const poll = async (id) => {
    try {
      const s = await api(`/api/accounts/login/${id}`);
      setLogin({ id, ...s });
      if (s.status !== 'pending') {
        clearInterval(timer.current);
        if (s.status === 'success') { toast(`Account "${s.name}" added`); setName(''); }
        onDone();
      }
    } catch (e) { clearInterval(timer.current); toast(e.message, 'err'); }
  };
  useEffect(() => () => clearInterval(timer.current), []); // stops polling once the section is left
  const start = guarded(async () => {
    const r = await api('/api/accounts/login', { method: 'POST', body: { name: name.trim(), backend } });
    clearInterval(timer.current);
    timer.current = setInterval(() => poll(r.id), 1500);
    await poll(r.id);
  });
  const cancel = guarded(async () => { await api(`/api/accounts/login/${login.id}`, { method: 'DELETE' }); await poll(login.id); });
  const sendCode = guarded(async () => {
    await api(`/api/accounts/login/${login.id}/code`, { method: 'POST', body: { code: code.trim() } });
    setCode('');
    await poll(login.id);
  });
  const pending = login?.status === 'pending';
  return html`<section class="form-card">
    <strong>Add an account</strong>
    <span class="dim small">${backend === 'claude'
      ? 'Runs "claude auth login" on the server. A browser window opens on that machine; sign in with the account you want to add (or open the link below). If the page shows a code instead of finishing, paste it here.'
      : 'Runs "codex login --device-auth" on the server. Open the link, enter the code and approve with the account you want to add.'}</span>
    <div class="row">
      <input value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="account name (a-z, 0-9, - or _)" aria-label="Account name" disabled=${pending} />
      ${pending ? html`<button class="btn danger" onClick=${cancel}>Cancel</button>` : html`<${AsyncButton} class="btn primary" icon="key-round" onClick=${start}>Start login<//>`}
    </div>
    ${login && html`<div class="login-flow">
      ${pending && html`<div class="row"><${Spinner} /><span>Waiting for the sign-in to finish…</span></div>`}
      ${login.url && /^https:\/\//.test(login.url) && html`<a class="btn" href=${login.url} target="_blank" rel="noopener noreferrer"><${Icon} name="external-link" />Open the ${label} sign-in page</a>`}
      ${login.code && html`<div class="row"><span>Code</span><code class="login-code">${login.code}</code>
        <button class="btn sm" onClick=${() => copyText(login.code)}><${Icon} name="copy" />Copy</button></div>`}
      ${backend === 'claude' && pending && html`<div class="row">
        <input value=${code} onInput=${(e) => setCode(e.currentTarget.value)} placeholder="code from the sign-in page" aria-label="Code from the sign-in page" />
        <${AsyncButton} class="btn" onClick=${sendCode}>Send code<//></div>`}
      ${login.status === 'success' && html`<div class="ok-text"><${Icon} name="circle-check" /> Account "${login.name}" added.</div>`}
      ${login.status === 'cancelled' && html`<div class="dim">Cancelled.</div>`}
      ${login.status === 'failed' && html`<div class="form-error">Failed: ${login.error || 'unknown error'}</div>`}
      ${login.output && html`<details class="login-log"><summary>CLI output</summary><pre>${login.output}</pre></details>`}
    </div>`}
  </section>`;
}

/** `backend`: 'codex' or 'claude'. */
export function AccountsSection({ backend }) {
  const label = backend === 'claude' ? 'Claude Code' : 'Codex';
  const q = backend === 'claude' ? '?backend=claude' : '';
  const [list, setList] = useState(null);
  const load = guarded(async () => { setList(await api(`/api/accounts${q}`)); refreshUsage(); });
  useEffect(() => { load(); }, [backend]);

  const enable = (a) => guarded(async (enabled) => {
    await api(`/api/accounts/${encodeURIComponent(a.name)}/enabled`, { method: 'PUT', body: { enabled, backend } });
    await load();
  });
  const remove = (a) => guarded(async () => {
    if (!confirm(`Remove account "${a.name}"? Its ${label} login is deleted from this server. Chats and projects stay.`)) return;
    await api(`/api/accounts/${encodeURIComponent(a.name)}${q}`, { method: 'DELETE' });
    toast(`Removed ${a.name}`);
    await load();
  });
  const unblock = guarded(async () => { await api('/api/accounts/unblock', { method: 'POST' }); await load(); });

  return html`
    <p class="dim">With two or more accounts, a usage limit moves the same turn to the next account and resumes the session.</p>
    ${list == null ? html`<div class="pane-loading"><${Spinner} /></div>`
      : !list.length ? html`<${Empty} icon="key-round" title=${`No ${label} accounts yet`}>Add one below to start running chats.<//>`
        : list.map((a) => {
          const state = !a.enabled ? ['off', 'dim'] : a.loggedIn === false ? ['not logged in', 'err'] : a.blockedUntil ? ['at limit', 'warn'] : ['ready', 'ok'];
          return html`<section class="account" key=${a.name}>
            <div class="account-head">
              <${Switch} checked=${a.enabled} title="Use this account for new turns" onChange=${enable(a)} />
              <strong>${a.name}</strong>
              <span class=${cx('pill', state[1])}>${state[0]}</span>
              <div class="spacer"></div>
              ${a.blockedUntil && html`<${AsyncButton} class="btn sm" onClick=${unblock}>Unblock<//>`}
              <button class="icon-btn sm danger" aria-label=${`Remove ${a.name}`} title="Remove" onClick=${remove(a)}><${Icon} name="trash-2" /></button>
            </div>
            <${Limits} l=${a.limits} />
          </section>`;
        })}
    <${AddAccount} backend=${backend} label=${label} onDone=${load} />`;
}

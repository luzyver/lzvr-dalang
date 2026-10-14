// User management (admins): create users with an email and a role, change them, issue a new API token, delete.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Icon, Spinner } from './ui.js';
import { guarded, toast } from './store.js';
import { copyText } from './code.js';

const ROLES = ['dev', 'admin'];

export function UsersSection() {
  const [users, setUsers] = useState(null);
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [role, setRole] = useState('dev');
  const [reveal, setReveal] = useState(null); // { who, token }, shown only once
  const load = guarded(async () => setUsers(await api('/api/users')));
  useEffect(() => { load(); }, []);

  const create = guarded(async () => {
    const r = await api('/api/users', { method: 'POST', body: { name: name.trim(), email: email.trim(), role } });
    setName('');
    setEmail('');
    setReveal({ who: r.name, token: r.token });
    await load();
  });
  const changeRole = (u) => guarded(async (e) => {
    const value = e.currentTarget.value;
    await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: value } });
    toast(`${u.name} is now ${value}`);
    await load();
  });
  const changeEmail = (u) => guarded(async (e) => {
    const value = e.currentTarget.value.trim();
    if (value === (u.email || '')) return;
    try { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { email: value } }); } finally { await load(); }
    toast(value ? `${u.name} signs in with ${value}` : `${u.name} can no longer sign in by email`);
  });
  const newToken = (u) => guarded(async () => {
    if (!confirm(`Issue a new token for ${u.name}? Their old token stops working.`)) return;
    setReveal({ who: u.name, token: (await api(`/api/users/${u.id}/token`, { method: 'POST' })).token });
  });
  const remove = (u) => guarded(async () => {
    if (!confirm(`Delete user "${u.name}"? Their token and sessions stop working.`)) return;
    await api(`/api/users/${u.id}`, { method: 'DELETE' });
    await load();
  });

  return html`
    <p class="dim">admin: everything. dev: use projects and chats, but not manage users, accounts or projects.
      Users sign in with a code mailed to their email.</p>
    ${reveal && html`<section class="form-card reveal">
      <strong>API token for ${reveal.who}</strong>
      <span class="dim small">It is shown only now. They sign in by email; this token is for the HTTP/MCP API (or signing in without email).</span>
      <div class="row"><input class="mono" readonly value=${reveal.token} onFocus=${(e) => e.currentTarget.select()} aria-label="Token" />
        <button class="btn" onClick=${() => copyText(reveal.token)}><${Icon} name="copy" />Copy</button>
        <button class="icon-btn" aria-label="Hide token" onClick=${() => setReveal(null)}><${Icon} name="x" /></button></div>
    </section>`}
    ${users == null ? html`<div class="pane-loading"><${Spinner} /></div>` : html`<div class="table-wrap"><table class="users">
      <thead><tr><th>Name</th><th>Email</th><th>Role</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr key=${u.id}>
        <td><strong>${u.name}</strong></td>
        <td><input type="email" key=${u.email || ''} value=${u.email || ''} placeholder="no email" aria-label=${`Email of ${u.name}`}
          onChange=${changeEmail(u)} onKeyDown=${(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} /></td>
        <td><select value=${u.role} aria-label=${`Role of ${u.name}`} onChange=${changeRole(u)}>${ROLES.map((r) => html`<option value=${r}>${r}</option>`)}</select></td>
        <td class="actions"><button class="btn ghost sm" onClick=${newToken(u)}>New API token</button>
          <button class="icon-btn sm danger" aria-label=${`Delete ${u.name}`} title="Delete" onClick=${remove(u)}><${Icon} name="trash-2" /></button></td>
      </tr>`)}</tbody>
    </table></div>`}
    <section class="form-card">
      <strong>Add a user</strong>
      <div class="row">
        <input value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="user name (a-z, 0-9, - or _)" aria-label="User name" />
        <input type="email" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} placeholder="email" aria-label="Email" />
        <select value=${role} onChange=${(e) => setRole(e.currentTarget.value)} aria-label="Role">${ROLES.map((r) => html`<option value=${r}>${r}</option>`)}</select>
        <${AsyncButton} class="btn primary" icon="plus" onClick=${create}>Create<//>
      </div>
    </section>`;
}

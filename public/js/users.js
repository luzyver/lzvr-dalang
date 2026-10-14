// User management (admins): create users with a role, change roles, issue a new token, delete.
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
  const [role, setRole] = useState('dev');
  const [reveal, setReveal] = useState(null); // { who, token }, shown only once
  const load = guarded(async () => setUsers(await api('/api/users')));
  useEffect(() => { load(); }, []);

  const create = guarded(async () => {
    const r = await api('/api/users', { method: 'POST', body: { name: name.trim(), role } });
    setName('');
    setReveal({ who: r.name, token: r.token });
    await load();
  });
  const changeRole = (u) => guarded(async (e) => {
    const value = e.currentTarget.value;
    await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: value } });
    toast(`${u.name} is now ${value}`);
    await load();
  });
  const newToken = (u) => guarded(async () => {
    if (!confirm(`Issue a new token for ${u.name}? Their old token stops working.`)) return;
    setReveal({ who: u.name, token: (await api(`/api/users/${u.id}/token`, { method: 'POST' })).token });
  });
  const remove = (u) => guarded(async () => {
    if (!confirm(`Delete user "${u.name}"? Their token, sessions and passkeys stop working.`)) return;
    await api(`/api/users/${u.id}`, { method: 'DELETE' });
    await load();
  });

  return html`
    <p class="dim">admin: everything. dev: use projects and chats, but not manage users, accounts or projects.</p>
    ${reveal && html`<section class="form-card reveal">
      <strong>Token for ${reveal.who}</strong>
      <span class="dim small">It is shown only now: give it to them privately. They can add a passkey after signing in.</span>
      <div class="row"><input class="mono" readonly value=${reveal.token} onFocus=${(e) => e.currentTarget.select()} aria-label="Token" />
        <button class="btn" onClick=${() => copyText(reveal.token)}><${Icon} name="copy" />Copy</button>
        <button class="icon-btn" aria-label="Hide token" onClick=${() => setReveal(null)}><${Icon} name="x" /></button></div>
    </section>`}
    ${users == null ? html`<div class="pane-loading"><${Spinner} /></div>` : html`<div class="table-wrap"><table class="users">
      <thead><tr><th>Name</th><th>Role</th><th>Passkeys</th><th></th></tr></thead>
      <tbody>${users.map((u) => html`<tr key=${u.id}>
        <td><strong>${u.name}</strong></td>
        <td><select value=${u.role} aria-label=${`Role of ${u.name}`} onChange=${changeRole(u)}>${ROLES.map((r) => html`<option value=${r}>${r}</option>`)}</select></td>
        <td class="dim">${u.passkeys}</td>
        <td class="actions"><button class="btn ghost sm" onClick=${newToken(u)}>New token</button>
          <button class="icon-btn sm danger" aria-label=${`Delete ${u.name}`} title="Delete" onClick=${remove(u)}><${Icon} name="trash-2" /></button></td>
      </tr>`)}</tbody>
    </table></div>`}
    <section class="form-card">
      <strong>Add a user</strong>
      <div class="row">
        <input value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="user name (a-z, 0-9, - or _)" aria-label="User name" />
        <select value=${role} onChange=${(e) => setRole(e.currentTarget.value)} aria-label="Role">${ROLES.map((r) => html`<option value=${r}>${r}</option>`)}</select>
        <${AsyncButton} class="btn primary" icon="plus" onClick=${create}>Create<//>
      </div>
    </section>`;
}

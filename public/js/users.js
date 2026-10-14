// User management (admins): create users with a role, change roles, issue a new token, delete.
import { h, icon } from './dom.js';
import { api } from './api.js';

const ROLES = ['dev', 'admin'];

export function usersPage({ guarded, flash, close }) {
  const list = h('div');
  const reveal = h('div');
  const nameIn = h('input', { placeholder: 'user name (a-z, 0-9, - or _)' });
  const roleSel = h('select', {}, ROLES.map((v) => h('option', { value: v }, v)));

  function showToken(who, token) {
    const field = h('input', { readonly: true, value: token });
    reveal.replaceChildren(
      h('div', { class: 'small' }, `Token for ${who}. It is shown only now: give it to them privately. They can add a passkey after signing in.`),
      h('div', { class: 'row' }, field, h('button', { onclick: async () => {
        try { await navigator.clipboard.writeText(token); flash('copied'); } catch { field.select(); }
      } }, 'Copy')));
    field.select();
  }

  async function reload() {
    const users = await api('/api/users');
    list.replaceChildren(...users.map((u) => {
      const sel = h('select', {}, ROLES.map((v) => h('option', { value: v, selected: v === u.role }, v)));
      sel.addEventListener('change', guarded(async () => { await api(`/api/users/${u.id}`, { method: 'PATCH', body: { role: sel.value } }); flash(`${u.name} is now ${sel.value}`); }));
      return h('div', { class: 'row' }, h('strong', {}, u.name), sel, h('span', { class: 'small' }, `${u.passkeys} passkey(s)`),
        h('button', { onclick: guarded(async () => { showToken(u.name, (await api(`/api/users/${u.id}/token`, { method: 'POST' })).token); }) }, 'New token'),
        h('button', { class: 'danger', onclick: guarded(async () => {
          if (!confirm(`Delete user "${u.name}"? Their token, sessions and passkeys stop working.`)) return;
          await api(`/api/users/${u.id}`, { method: 'DELETE' });
          reload();
        }) }, 'Delete'));
    }));
  }

  const create = guarded(async () => {
    const r = await api('/api/users', { method: 'POST', body: { name: nameIn.value.trim(), role: roleSel.value } });
    nameIn.value = '';
    showToken(r.name, r.token);
    reload();
  });
  reload().catch((e) => flash(e.message));
  return h('div', { class: 'page-body' },
    h('strong', {}, 'Users'),
    h('div', { class: 'small' }, 'admin: everything. dev: use projects and chats, but not manage users, accounts or projects.'),
    list,
    h('div', { class: 'row' }, nameIn, roleSel, h('button', { class: 'primary', onclick: create }, 'Create'), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, icon('x'))),
    reveal);
}

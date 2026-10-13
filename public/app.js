'use strict';
// Dalang panel. Plain JS, no build step. Every server-provided string goes in via textContent.

// ---------- helpers ----------
function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (v === true) el.setAttribute(k, '');
    else if (v !== false && v != null) el.setAttribute(k, v);
  }
  for (const k of kids.flat()) if (k != null && k !== false) el.append(k.nodeType ? k : document.createTextNode(String(k)));
  return el;
}

const tokenStore = {
  get() { try { return localStorage.getItem('lzvr_token') || ''; } catch { return ''; } },
  set(t) { try { localStorage.setItem('lzvr_token', t); } catch { /* private mode: login lasts until reload */ memoryToken = t; } },
  clear() { try { localStorage.removeItem('lzvr_token'); } catch { /* ignore */ } memoryToken = ''; },
};
let memoryToken = '';
const currentToken = () => tokenStore.get() || memoryToken;

class Unauthorized extends Error {}

async function api(path, { method = 'GET', body, form } = {}) {
  const headers = { authorization: `Bearer ${currentToken()}` };
  let payload;
  if (form) payload = form;
  else if (body !== undefined) { headers['content-type'] = 'application/json'; payload = JSON.stringify(body); }
  const res = await fetch(path, { method, headers, body: payload });
  if (res.status === 401) { showLogin(); throw new Unauthorized(); }
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function publicApi(path, body) {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: body === undefined ? {} : { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (!res.ok) {
    let msg = res.statusText;
    try { msg = (await res.json()).error || msg; } catch { /* not json */ }
    throw new Error(msg);
  }
  return res.json();
}

/** Split an SSE text buffer into complete events; returns the unfinished remainder. */
function parseSSE(buf) {
  const events = [];
  let rest = buf;
  for (let i = rest.indexOf('\n\n'); i !== -1; i = rest.indexOf('\n\n')) {
    const block = rest.slice(0, i);
    rest = rest.slice(i + 2);
    const ev = { id: 0, type: 'message', data: null };
    for (const line of block.split('\n')) {
      if (line.startsWith('id:')) ev.id = Number(line.slice(3).trim()) || 0;
      else if (line.startsWith('event:')) ev.type = line.slice(6).trim();
      else if (line.startsWith('data:')) { try { ev.data = JSON.parse(line.slice(5).trim()); } catch { ev.data = null; } }
    }
    if (ev.data !== null) events.push(ev);
  }
  return { events, rest };
}

/** Follow a conversation's event stream, resuming from the last id after a drop. Returns a stop function. */
function startStream(convId, onEvent) {
  const ac = new AbortController();
  let last = 0;
  (async () => {
    while (!ac.signal.aborted) {
      try {
        const res = await fetch(`/api/conversations/${convId}/events`, {
          headers: { authorization: `Bearer ${currentToken()}`, 'last-event-id': String(last) },
          signal: ac.signal,
        });
        if (res.status === 401) { showLogin(); return; }
        if (!res.ok) throw new Error(String(res.status));
        const reader = res.body.getReader();
        const dec = new TextDecoder();
        let buf = '';
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          const r = parseSSE(buf);
          buf = r.rest;
          for (const e of r.events) { last = Math.max(last, e.id); onEvent(e); }
        }
      } catch { if (ac.signal.aborted) return; }
      await new Promise((r) => setTimeout(r, 2000));
    }
  })();
  return () => ac.abort();
}

// ---------- markdown (DOM-built, never innerHTML: the CSP and the textContent rule both hold) ----------
const INLINE = /`([^`]+)`|\*\*(.+?)\*\*|(?<![\w*])\*([^*\s][^*]*?)\*(?![\w*])|\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;
function inline(text) {
  const out = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    if (m[1] != null) out.push(h('code', {}, m[1]));
    else if (m[2] != null) out.push(h('strong', {}, inline(m[2])));
    else if (m[3] != null) out.push(h('em', {}, inline(m[3])));
    else out.push(h('a', { href: m[5], target: '_blank', rel: 'noopener noreferrer' }, m[4]));
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const LIST_ITEM = /^\s*([-*+]|\d+\.)\s/;
function markdown(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src).replace(/\r/g, '').split('\n');
  const isBlock = (l) => /^(```|#{1,6}\s|>\s?)/.test(l) || LIST_ITEM.test(l);
  for (let i = 0; i < lines.length;) {
    const l = lines[i];
    let m;
    if (!l.trim()) { i++; continue; }
    if (l.startsWith('```')) {
      const code = [];
      for (i++; i < lines.length && !lines[i].startsWith('```'); i++) code.push(lines[i]);
      i++;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
    } else if ((m = /^(#{1,6})\s+(.*)/.exec(l))) {
      root.append(h(`h${Math.min(m[1].length + 2, 6)}`, {}, inline(m[2]))); i++;
    } else if (/^>\s?/.test(l)) {
      const q = [];
      for (; i < lines.length && /^>\s?/.test(lines[i]); i++) q.push(lines[i].replace(/^>\s?/, ''));
      root.append(h('blockquote', {}, inline(q.join(' '))));
    } else if (LIST_ITEM.test(l)) {
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      for (; i < lines.length && LIST_ITEM.test(lines[i]); i++) items.push(h('li', {}, inline(lines[i].replace(LIST_ITEM, ''))));
      root.append(h(ordered ? 'ol' : 'ul', {}, items));
    } else {
      const p = [];
      for (; i < lines.length && lines[i].trim() && (!p.length || !isBlock(lines[i])); i++) p.push(lines[i]);
      root.append(h('p', {}, p.flatMap((x, j) => (j ? [h('br'), ...inline(x)] : inline(x)))));
    }
  }
  return root;
}

// ---------- event rendering ----------
const note = (text, cls) => h('div', { class: `note ${cls || ''}` }, text);
const bubble = (cls, text) => h('div', { class: `msg ${cls}` }, text);

function renderItem(item) {
  if (!item) return null;
  switch (item.type) {
    case 'agent_message': return h('div', { class: 'msg agent' }, markdown(item.text || ''));
    case 'command_execution': {
      const out = h('span', { class: 'out' }, String(item.aggregated_output || '').slice(-2000));
      const code = item.exit_code == null ? '' : `  [exit ${item.exit_code}]`;
      return h('div', { class: 'msg cmd' }, `$ ${item.command || ''}${code}`, out);
    }
    case 'file_change': {
      const files = (item.changes || []).map((c) => `${c.kind || 'change'} ${c.path || ''}`).join('\n');
      return bubble('cmd', files || 'file change');
    }
    case 'reasoning': return item.text ? note(`thinking: ${String(item.text).slice(0, 300)}`) : null;
    default: return note(`${item.type || 'item'}`);
  }
}

function renderEvent(e) {
  const d = e.data || {};
  switch (e.type) {
    case 'user.prompt': return bubble('user', d.text || '');
    case 'item.completed': return renderItem(d.item);
    case 'turn.completed': {
      const u = d.usage || {};
      return note(`done · tokens in ${u.input_tokens ?? '?'} / out ${u.output_tokens ?? '?'}`);
    }
    case 'turn.failed':
    case 'error': return note(`error: ${(d.error && d.error.message) || d.message || JSON.stringify(d)}`, 'err');
    case 'process.exit': return note(`process exited (${d.code})${d.stderr ? `: ${String(d.stderr).slice(-300)}` : ''}`, 'err');
    case 'account.selected': return note(`account: ${d.account}`);
    case 'account.switched': return note(`usage limit on ${d.from}, switching account`, 'warn');
    case 'account.exhausted': return note(d.message || 'all accounts are at their limit', 'err');
    case 'thread.started':
    case 'turn.started':
    case 'item.started':
    case 'item.updated': return null;
    default: return note(e.type);
  }
}

// ---------- web push / passkeys ----------
function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('this browser has no Web Push');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('notification permission denied');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

async function registerPasskey() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.parseCreationOptionsFromJSON) throw new Error('this browser has no passkey support');
  const opts = await api('/api/passkey/register/options', { method: 'POST', body: {} });
  const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts) });
  await api('/api/passkey/register/verify', { method: 'POST', body: { response: cred.toJSON() } });
}

async function loginWithPasskey() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.parseRequestOptionsFromJSON) throw new Error('this browser has no passkey support');
  const opts = await publicApi('/api/auth/passkey/options', {});
  const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts) });
  const { token } = await publicApi('/api/auth/passkey/verify', { response: cred.toJSON() });
  tokenStore.set(token);
}

// ---------- views ----------
const root = document.getElementById('root');
let stopStream = null;
let accountTimer = null;
let notificationOpensChat = null; // set by showApp; one service-worker listener (below) calls it

/** Revoke the session on the server (passkey sessions last 30 days), then forget the token here. */
async function signOut() {
  try { await fetch('/api/auth/logout', { method: 'POST', headers: { authorization: `Bearer ${currentToken()}` } }); } catch { /* offline: still sign out locally */ }
  showLogin();
}

function showLogin(message) {
  if (stopStream) { stopStream(); stopStream = null; }
  clearInterval(accountTimer);
  tokenStore.clear();
  const err = h('div', { class: 'error' }, message || '');
  const input = h('input', { type: 'password', placeholder: 'access token', autocomplete: 'current-password' });
  const go = async () => {
    const t = input.value.trim();
    if (!t) return;
    // Not api(): a 401 there rebuilds this screen and the message below would go to a detached element.
    const res = await fetch('/api/projects', { headers: { authorization: `Bearer ${t}` } }).catch(() => null);
    if (res && res.ok) { tokenStore.set(t); showApp(); return; }
    err.textContent = !res ? 'cannot reach the server' : res.status === 429 ? 'too many attempts, wait a minute' : 'wrong token';
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') go(); });
  const passkeyBtn = h('button', { onclick: async () => {
    err.textContent = '';
    try { await loginWithPasskey(); showApp(); } catch (e) { err.textContent = e.message; }
  } }, 'Sign in with passkey');
  passkeyBtn.hidden = true;
  root.replaceChildren(h('div', { class: 'login' },
    h('h1', {}, 'Dalang'), input,
    h('button', { class: 'primary', onclick: go }, 'Sign in'), passkeyBtn, err));
  publicApi('/api/auth/status').then((s) => { passkeyBtn.hidden = !s.passkeys; }).catch(() => {});
}

async function showApp() {
  let me;
  try { me = await api('/api/me'); } catch (e) { if (!(e instanceof Unauthorized)) showLogin(e.message); return; }
  const isAdmin = me.role === 'admin'; // the server enforces this; the panel only hides what would be refused
  const state = { projects: [], convs: new Map(), current: null, queue: [] };
  const sidebar = h('aside');
  const main = h('main');
  const accounts = h('span', { class: 'accts' });
  const status = h('span', { class: 'small' });

  const flash = (msg) => { status.textContent = msg; if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 5000); };
  const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!(e instanceof Unauthorized)) flash(e.message); } };

  document.body.classList.remove('nav');
  const menu = h('details', { class: 'menu' },
    h('summary', {}, h('span', { class: 'avatar' }, me.name.slice(0, 1).toUpperCase()), h('span', { class: 'uname' }, me.name)),
    h('div', { class: 'pop', onclick: () => { menu.open = false; } },
      h('div', { class: 'small who' }, `${me.name} · ${me.role}`),
      isAdmin && h('button', { onclick: () => addAccountDialog() }, '+ Codex account'),
      isAdmin && h('button', { onclick: () => usersDialog() }, 'Manage users'),
      h('button', { onclick: guarded(async () => { await enableNotifications(); flash('notifications on'); }) }, 'Enable notifications'),
      h('button', { onclick: guarded(async () => { await registerPasskey(); flash('passkey registered'); }) }, 'Add passkey'),
      h('button', { class: 'danger', onclick: signOut }, 'Sign out')));
  document.onclick = (e) => { if (!menu.contains(e.target)) menu.open = false; };
  const header = h('header', {},
    h('button', { class: 'navtoggle', 'aria-label': 'chats', onclick: () => document.body.classList.toggle('nav') }, '☰'),
    h('span', { class: 'title' }, 'Dalang'), accounts,
    h('span', { class: 'spacer' }), status, menu);
  root.replaceChildren(h('div', { class: 'shell' }, header, sidebar, main));
  notificationOpensChat = (id) => openConv(id);

  async function refreshAccounts() {
    try {
      const list = await api('/api/accounts');
      if (!list.length) {
        accounts.replaceChildren(h('span', { class: 'badge warn' },
          isAdmin ? 'no Codex account yet: click + Account' : 'no Codex account yet: ask an admin'));
        return list;
      }
      accounts.replaceChildren(...list.map((a) => h('span', {
        class: `badge ${a.blockedUntil ? 'blocked' : ''} ${a.loggedIn === false ? 'warn' : ''}`,
        title: a.loggedIn === false ? 'not logged in on this machine (run codex login for it, or re-add it)'
          : a.blockedUntil ? 'at usage limit, click to unblock' : 'available',
        onclick: a.blockedUntil && isAdmin ? guarded(async () => { await api('/api/accounts/unblock', { method: 'POST' }); refreshAccounts(); }) : null,
      }, a.loggedIn === false ? `⚠ ${a.name}` : a.name)));
      return list;
    } catch { return null; /* shown on next tick */ }
  }

  // Add another Codex account: runs `codex login --device-auth` on the server and shows its link and code here.
  const loginSlot = h('div');
  function addAccountDialog() {
    const nameIn = h('input', { placeholder: 'account name (a-z, 0-9, - or _)' });
    const out = h('pre', { class: 'loginlog' });
    const link = h('div');
    const msg = h('div', { class: 'small' });
    let id = null;
    let timer = null;
    const close = () => { clearInterval(timer); loginSlot.replaceChildren(); };
    const poll = async () => {
      try {
        const s = await api(`/api/accounts/login/${id}`);
        out.textContent = s.output;
        link.replaceChildren();
        if (s.url && /^https:\/\//.test(s.url)) link.append(h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page'));
        if (s.code) link.append(' code: ', h('strong', {}, s.code));
        if (s.status !== 'pending') {
          clearInterval(timer);
          msg.textContent = s.status === 'success' ? `Account "${s.name}" added.` : s.status === 'cancelled' ? 'Cancelled.' : `Failed: ${s.error || 'unknown error'}`;
          startBtn.disabled = false;
          cancelBtn.hidden = true;
          refreshAccounts();
        }
      } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
    };
    const startBtn = h('button', { class: 'primary', onclick: guarded(async () => {
      msg.textContent = '';
      const r = await api('/api/accounts/login', { method: 'POST', body: { name: nameIn.value.trim() } });
      id = r.id;
      startBtn.disabled = true;
      cancelBtn.hidden = false;
      clearInterval(timer);
      timer = setInterval(poll, 1500);
      poll();
    }) }, 'Start login');
    const cancelBtn = h('button', { class: 'danger', hidden: true, onclick: guarded(async () => {
      await api(`/api/accounts/login/${id}`, { method: 'DELETE' });
      poll();
    }) }, 'Cancel');
    document.body.classList.add('nav');
    loginSlot.replaceChildren(h('div', { class: 'msg' },
      h('strong', {}, 'Add a Codex account'),
      h('div', { class: 'small' }, 'Runs "codex login --device-auth" on the server. Open the link, enter the code and approve with the account you want to add.'),
      h('div', { class: 'row' }, nameIn, startBtn, cancelBtn, h('button', { onclick: close }, '×')),
      link, out, msg));
  }

  // User management (admins): create users with a role, change roles, issue a new token, delete.
  const usersSlot = h('div');
  function usersDialog() {
    const list = h('div');
    const reveal = h('div');
    const nameIn = h('input', { placeholder: 'user name (a-z, 0-9, - or _)' });
    const roleSel = h('select', {}, ['dev', 'admin'].map((v) => h('option', { value: v }, v)));
    const close = () => usersSlot.replaceChildren();

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
        const sel = h('select', {}, ['dev', 'admin'].map((v) => h('option', { value: v, selected: v === u.role }, v)));
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
    document.body.classList.add('nav');
    usersSlot.replaceChildren(h('div', { class: 'msg' },
      h('strong', {}, 'Users'),
      h('div', { class: 'small' }, 'admin: everything. dev: use projects and chats, but not manage users, accounts or projects.'),
      list,
      h('div', { class: 'row' }, nameIn, roleSel, h('button', { class: 'primary', onclick: create }, 'Create'), h('button', { onclick: close }, '×')),
      reveal));
    reload().catch((e) => flash(e.message));
  }

  // Sends one chat wants to make into another (via MCP) wait here until a human decides.
  const approvalsBox = h('div');
  async function refreshApprovals() {
    try {
      const list = await api('/api/approvals');
      const decide = (a, verb) => guarded(async () => { await api(`/api/approvals/${a.id}/${verb}`, { method: 'POST' }); refreshApprovals(); });
      approvalsBox.replaceChildren(...list.map((a) => h('div', { class: 'msg' },
        `Approval needed: chat ${a.from_conv.slice(0, 8)} wants to message chat ${a.to_conv.slice(0, 8)}:\n${a.prompt}`,
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: decide(a, 'approve') }, 'Approve'),
          h('button', { class: 'danger', onclick: decide(a, 'reject') }, 'Reject')))));
    } catch { /* retried on the next tick */ }
  }

  async function loadProjects() {
    state.projects = await api('/api/projects');
    for (const p of state.projects) state.convs.set(p.id, await api(`/api/projects/${p.id}/conversations`));
    drawSidebar();
  }

  // Built once: the sidebar is redrawn on every status change, which must not wipe what is being typed.
  const nameIn = h('input', { placeholder: 'name' });
  const pathIn = h('input', { placeholder: 'path (absolute or under the root)' });
  const sbSel = h('select', {}, ['workspace-write', 'read-only', 'danger-full-access'].map((v) => h('option', { value: v }, v)));
  const addForm = h('details', {},
    h('summary', {}, '+ Add project'),
    h('div', { class: 'row' }, nameIn), h('div', { class: 'row' }, pathIn), h('div', { class: 'row' }, sbSel),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: guarded(async () => {
      await api('/api/projects', { method: 'POST', body: { name: nameIn.value.trim(), path: pathIn.value.trim(), sandbox: sbSel.value } });
      nameIn.value = ''; pathIn.value = '';
      await loadProjects();
    }) }, 'Create')));
  const adoptSlot = h('div');

  const newChat = (p) => guarded(async () => { const c = await api(`/api/projects/${p.id}/conversations`, { method: 'POST', body: {} }); await loadProjects(); openConv(c.id); });
  function drawSidebar() {
    const blocks = state.projects.map((p) => {
      const convs = state.convs.get(p.id) || [];
      return h('section', { class: 'proj' },
        h('div', { class: 'projhead' },
          h('div', { class: 'pname' }, h('strong', {}, p.name), h('span', { class: 'small' }, p.sandbox)),
          h('button', { class: 'iconbtn', title: 'New chat', 'aria-label': 'New chat', onclick: newChat(p) }, '+'),
          isAdmin && h('details', { class: 'more' }, h('summary', { 'aria-label': 'Project options' }, '⋯'),
            h('div', { class: 'pop' },
              h('button', { onclick: guarded(() => adoptDialog(p)) }, 'Adopt Codex session'),
              h('button', { class: 'danger', onclick: guarded(async () => {
                if (!confirm(`Remove project "${p.name}" and its chats from the panel? Files stay untouched.`)) return;
                await api(`/api/projects/${p.id}`, { method: 'DELETE' });
                if ((state.convs.get(p.id) || []).some((c) => c.id === state.current)) {
                  if (stopStream) { stopStream(); stopStream = null; } // else it keeps retrying a chat that no longer exists
                  state.current = null;
                  drawMain(null);
                }
                await loadProjects();
              }) }, 'Remove project')))),
        convs.length ? convs.map((c) => h('button', { class: `conv ${c.id === state.current ? 'active' : ''}`, onclick: () => openConv(c.id) },
          h('span', { class: `dot ${c.status}`, title: c.status }), h('span', { class: 'ct' }, c.title || 'New chat')))
          : h('div', { class: 'small hint' }, 'No chats yet'));
    });
    sidebar.replaceChildren(...[loginSlot, usersSlot, approvalsBox, adoptSlot, ...blocks, isAdmin ? addForm : null].filter(Boolean));
  }

  async function adoptDialog(project) {
    const sessions = await api('/api/sessions');
    if (!sessions.length) { flash('no Codex sessions found'); return; }
    const sel = h('select', {}, sessions.map((s) => h('option', { value: s.id },
      `${new Date(s.modified).toLocaleString()} ${s.cwd ? '· ' + s.cwd : ''} · ${s.id.slice(0, 8)}`)));
    const box = h('div', { class: 'row' }, sel, h('button', { class: 'primary', onclick: guarded(async () => {
      const c = await api(`/api/projects/${project.id}/conversations`, { method: 'POST', body: { threadId: sel.value } });
      adoptSlot.replaceChildren();
      await loadProjects();
      openConv(c.id);
    }) }, 'Adopt'), h('button', { onclick: () => adoptSlot.replaceChildren() }, '×'));
    document.body.classList.add('nav');
    adoptSlot.replaceChildren(box);
  }

  async function openConv(id) {
    if (stopStream) stopStream();
    state.current = id;
    document.body.classList.remove('nav');
    drawSidebar();
    drawMain(id);
  }

  function drawMain(id) {
    if (!id) {
      main.replaceChildren(h('div', { class: 'empty' }, h('h2', {}, 'Dalang'), h('p', {}, 'Pick a chat, or start a new one with the + next to a project.'),
        h('button', { class: 'primary mobonly', onclick: () => document.body.classList.add('nav') }, 'Open chats')));
      return;
    }
    const log = h('div', { class: 'log' });
    const queueBox = h('div', { class: 'queue' });
    const text = h('textarea', { placeholder: 'Message Codex…', rows: '1' });
    const files = h('input', { type: 'file', multiple: true });
    const model = h('input', { list: 'models', placeholder: 'model (default)', maxlength: '64', autocomplete: 'off', onchange: guarded(async () => {
      await api(`/api/conversations/${id}/model`, { method: 'PUT', body: { model: model.value.trim() } });
      flash(model.value.trim() ? `model: ${model.value.trim()}` : 'model: default');
    }) });
    const effort = h('select', { title: 'reasoning effort', onchange: guarded(async () => {
      await api(`/api/conversations/${id}/effort`, { method: 'PUT', body: { effort: effort.value } });
      flash(effort.value ? `effort: ${effort.value}` : 'effort: default');
    }) }, [['', 'effort: default'], ...['low', 'medium', 'high', 'xhigh', 'max'].map((v) => [v, v])].map(([v, t]) => h('option', { value: v }, t)));
    const models = h('datalist', { id: 'models' });
    api('/api/models').then((list) => models.replaceChildren(...list.map((m) => h('option', { value: m.slug }, m.name)))).catch(() => {});

    async function refreshQueue() {
      const q = await api(`/api/conversations/${id}/queue`);
      queueBox.replaceChildren(...q.map((item) => h('span', { class: 'chip' }, item.prompt.slice(0, 40),
        h('button', { title: 'remove', onclick: guarded(async () => { await api(`/api/queue/${item.id}`, { method: 'DELETE' }); refreshQueue(); }) }, '×'))));
    }
    async function refreshConv() {
      const c = await api(`/api/conversations/${id}`);
      if (document.activeElement !== model) model.value = c.model || '';
      effort.value = c.effort || '';
      if (!text.value && c.draft) text.value = c.draft;
      const list = state.projects.flatMap((p) => state.convs.get(p.id) || []);
      const known = list.find((x) => x.id === id);
      stop.hidden = c.status !== 'running';
      const title = c.turns && c.turns[0] ? c.turns[0].prompt.slice(0, 80) : null;
      if (known && (known.status !== c.status || (title && known.title !== title))) { known.status = c.status; if (title) known.title = title; drawSidebar(); }
    }

    const send = guarded(async () => {
      const prompt = text.value.trim();
      if (!prompt) return;
      const attachments = [];
      for (const f of files.files) {
        const form = new FormData();
        form.append('file', f);
        attachments.push((await api('/api/uploads', { method: 'POST', form })).path);
      }
      await api(`/api/conversations/${id}/prompts`, { method: 'POST', body: { prompt, attachments } });
      text.value = '';
      files.value = '';
      await api(`/api/conversations/${id}/draft`, { method: 'PUT', body: { draft: '' } });
      refreshQueue();
    });
    // Desktop: Enter sends, Shift+Enter is a new line. Touch keyboards keep Enter as a new line (the send button sends).
    const mouse = matchMedia('(pointer: fine)');
    text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && (e.ctrlKey || e.metaKey || (mouse.matches && !e.shiftKey))) { e.preventDefault(); send(); } });
    let draftTimer;
    text.addEventListener('input', () => {
      clearTimeout(draftTimer);
      draftTimer = setTimeout(() => api(`/api/conversations/${id}/draft`, { method: 'PUT', body: { draft: text.value } }).catch(() => {}), 800);
    });

    const attachCount = h('span', {});
    files.addEventListener('change', () => { attachCount.textContent = files.files.length ? ` ${files.files.length}` : ''; });
    const settings = h('div', { class: 'settings', hidden: true },
      h('label', {}, 'Model', model, models), h('label', {}, 'Effort', effort),
      h('button', { class: 'danger', onclick: guarded(async () => {
        if (!confirm('Delete this chat and its history? The project and its files stay.')) return;
        await api(`/api/conversations/${id}`, { method: 'DELETE' });
        if (stopStream) { stopStream(); stopStream = null; }
        state.current = null;
        drawMain(null);
        await loadProjects();
      }) }, 'Delete chat'));
    const stop = h('button', { class: 'stop', hidden: true, title: 'Stop', 'aria-label': 'Stop', onclick: guarded(async () => {
      const r = await api(`/api/conversations/${id}/cancel`, { method: 'POST' }); flash(r.cancelled ? 'cancelled' : 'nothing running');
    }) }, '■');
    main.replaceChildren(log, h('div', { class: 'composer' },
      queueBox,
      h('div', { class: 'box' },
        h('div', { class: 'inputrow' },
          h('label', { class: 'iconbtn', title: 'Attach files' }, '📎', attachCount, files),
          text,
          h('button', { class: 'iconbtn', title: 'Settings', 'aria-label': 'Settings', onclick: () => { settings.hidden = !settings.hidden; } }, '⚙'),
          stop,
          h('button', { class: 'primary send', 'aria-label': 'Send', onclick: send }, '↑')),
        settings)));

    stopStream = startStream(id, (e) => {
      const el = renderEvent(e);
      if (el) {
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.append(el);
        if (nearBottom) log.scrollTop = log.scrollHeight;
      }
      if (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'process.exit' || e.type === 'user.prompt') {
        refreshQueue().catch(() => {});
        refreshConv().catch(() => {});
      }
    });
    refreshQueue().catch(() => {});
    refreshConv().catch(() => {});
  }

  drawMain(null);
  try { await loadProjects(); } catch (e) { if (!(e instanceof Unauthorized)) flash(e.message); return; }
  const tick = () => { refreshAccounts(); if (isAdmin) refreshApprovals(); };
  // First run: nothing works until an account exists, so an admin lands straight in the sign-in step.
  refreshAccounts().then((list) => { if (isAdmin && list && !list.length) addAccountDialog(); });
  if (isAdmin) refreshApprovals();
  clearInterval(accountTimer);
  accountTimer = setInterval(tick, 15000);

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
if (currentToken()) showApp(); else showLogin();

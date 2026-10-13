// Dalang panel. Every server-provided string is inserted as text, never parsed as HTML.
import { h } from './js/dom.js';
import { api, publicApi, currentToken, tokenStore, Unauthorized, setUnauthorizedHandler } from './js/api.js';
import { startStream, renderEvent } from './js/chat.js';
import { enableNotifications, registerPasskey, loginWithPasskey } from './js/passkeys.js';

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
  const state = { projects: [], convs: new Map(), current: null, queue: [], collapsedProjects: new Set() };
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
      isAdmin && h('button', { onclick: () => addAccountDialog() }, 'Codex accounts'),
      isAdmin && h('button', { onclick: () => defaultModelDialog() }, 'Model & effort defaults'),
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
  const defaultModelSlot = h('div');
  function defaultModelDialog() {
    const model = h('input', { list: 'global-models', placeholder: 'Codex default', maxlength: '64', autocomplete: 'off' });
    const effort = h('select', {}, [['', 'Codex default'], ...['low', 'medium', 'high', 'xhigh', 'max'].map((v) => [v, v])]
      .map(([value, label]) => h('option', { value }, label)));
    const options = h('datalist', { id: 'global-models' });
    const msg = h('div', { class: 'small' });
    const close = () => defaultModelSlot.replaceChildren();
    const save = guarded(async () => {
      await api('/api/settings/default-model', { method: 'PUT', body: { model: model.value.trim() } });
      await api('/api/settings/default-effort', { method: 'PUT', body: { effort: effort.value } });
      flash('Global model and effort defaults saved');
      close();
    });
    document.body.classList.add('nav');
    defaultModelSlot.replaceChildren(h('div', { class: 'msg model-settings' },
      h('strong', {}, 'Global defaults'),
      h('div', { class: 'small' }, 'Used when a chat has no model or effort override. Leave a field on Codex default to let Codex choose.'),
      h('label', {}, 'Model', model, options),
      h('label', {}, 'Reasoning effort', effort),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save'), h('button', { onclick: close }, 'Cancel')),
      msg));
    Promise.all([api('/api/settings/default-model'), api('/api/settings/default-effort')]).then(([m, e]) => {
      model.value = m.model;
      effort.value = e.effort;
    }).catch((e) => { msg.textContent = e.message; });
    api('/api/models').then((models) => options.replaceChildren(...models.map((m) => h('option', { value: m.slug }, m.name)))).catch(() => {});
  }
  function addAccountDialog() {
    const nameIn = h('input', { placeholder: 'account name (a-z, 0-9, - or _)' });
    const list = h('div', { class: 'acctlist' });
    const loadList = async () => {
      try {
        const accts = await api('/api/accounts');
        list.replaceChildren(...accts.map((a) => h('div', { class: 'row' }, h('strong', {}, a.name),
          h('span', { class: 'small' }, a.loggedIn === false ? 'not logged in' : a.blockedUntil ? 'at limit' : 'ready'),
          h('span', { class: 'spacer' }),
          h('button', { class: 'danger', onclick: guarded(async () => {
            if (!confirm(`Remove account "${a.name}"? Its Codex login is deleted from this server. Chats and projects stay.`)) return;
            await api(`/api/accounts/${encodeURIComponent(a.name)}`, { method: 'DELETE' });
            flash(`removed ${a.name}`);
            loadList();
            refreshAccounts();
          }) }, 'Remove'))));
      } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
    };
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
          loadList();
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
    loadList();
    loginSlot.replaceChildren(h('div', { class: 'msg' },
      h('strong', {}, 'Codex accounts'), list,
      h('strong', {}, 'Add an account'),
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
  const deleteConv = (id) => guarded(async () => {
    if (!confirm('Delete this chat and its history? The project and its files stay.')) return;
    await api(`/api/conversations/${id}`, { method: 'DELETE' });
    if (state.current === id) {
      if (stopStream) { stopStream(); stopStream = null; }
      state.current = null;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      drawMain(null);
    }
    await loadProjects();
  });
  function drawSidebar() {
    const blocks = state.projects.map((p) => {
      const convs = state.convs.get(p.id) || [];
      const collapsed = state.collapsedProjects.has(p.id);
      return h('section', { class: 'proj' },
        h('div', { class: 'projhead' },
          h('button', { class: 'project-toggle', 'aria-expanded': String(!collapsed), onclick: () => {
            if (collapsed) state.collapsedProjects.delete(p.id); else state.collapsedProjects.add(p.id);
            drawSidebar();
          } },
            h('span', { class: 'project-chevron', 'aria-hidden': 'true' }, collapsed ? '›' : '⌄'),
            h('span', { class: 'project-glyph', 'aria-hidden': 'true' }, '▰'),
            h('span', { class: 'pname' }, h('strong', {}, p.name), h('span', { class: 'small' }, p.sandbox))),
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
                  history.replaceState(null, '', `${location.pathname}${location.search}`);
                  drawMain(null);
                }
                await loadProjects();
              }) }, 'Remove project')))),
        !collapsed && (convs.length ? h('div', { class: 'project-sessions' }, ...convs.map((c) => {
          const title = c.title || 'New chat';
          const shortTitle = title.length > 40 ? `${title.slice(0, 39)}…` : title;
          return h('div', { class: 'conv-row' },
            h('button', { class: `conv ${c.id === state.current ? 'active' : ''}`, onclick: () => openConv(c.id) },
              h('span', { class: `dot ${c.status}`, title: c.status }), h('span', { class: 'ct', title }, shortTitle)),
            h('button', { class: 'conv-delete', title: `Delete ${title}`, 'aria-label': `Delete chat ${title}`, onclick: deleteConv(c.id) }, '🗑'));
        })) : h('div', { class: 'small hint' }, 'No chats yet')));
    });
    sidebar.replaceChildren(...[loginSlot, defaultModelSlot, usersSlot, approvalsBox, adoptSlot,
      h('div', { class: 'explorer-head' }, h('span', {}, 'WORKSPACE'), h('span', { class: 'explorer-caption' }, `${state.projects.length} PROJECT${state.projects.length === 1 ? '' : 'S'}`)),
      isAdmin ? addForm : null, ...blocks,
      !blocks.length ? h('div', { class: 'small empty-projects' }, 'No projects yet') : null].filter(Boolean));
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
    if (stopStream) { stopStream(); stopStream = null; }
    const exists = state.projects.some((p) => (state.convs.get(p.id) || []).some((c) => c.id === id));
    if (!exists) {
      state.current = null;
      history.replaceState(null, '', `${location.pathname}${location.search}`);
      drawMain(null);
      return;
    }
    state.current = id;
    history.replaceState(null, '', `${location.pathname}${location.search}#c=${encodeURIComponent(id)}`);
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
    const project = state.projects.find((p) => (state.convs.get(p.id) || []).some((c) => c.id === id));
    const initial = (state.convs.get(project?.id) || []).find((c) => c.id === id);
    const chatTitle = h('strong', { class: 'chat-title', title: initial?.title || 'New conversation' }, initial?.title || 'New conversation');
    const chatProject = h('span', { class: 'chat-project' }, project?.name || 'Project');
    const chatState = h('span', { class: `chat-state ${initial?.status || 'idle'}` }, initial?.status || 'idle');
    const chatHead = h('div', { class: 'chathead' },
      h('div', { class: 'chat-context' }, chatProject, h('span', { class: 'crumb' }, '/'), chatTitle), chatState);
    const log = h('div', { class: 'log' });
    const queueBox = h('div', { class: 'queue' });
    const text = h('textarea', { placeholder: 'Message Codex…', rows: '1' });
    const files = h('input', { type: 'file', multiple: true });
    const model = h('input', { list: 'models', placeholder: 'model (global default)', maxlength: '64', autocomplete: 'off', onchange: guarded(async () => {
      await api(`/api/conversations/${id}/model`, { method: 'PUT', body: { model: model.value.trim() } });
      flash(model.value.trim() ? `model: ${model.value.trim()}` : 'using global model default');
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
      chatTitle.textContent = title || 'New conversation';
      chatTitle.title = title || 'New conversation';
      chatState.textContent = c.status;
      chatState.className = `chat-state ${c.status}`;
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
      h('label', {}, 'Model', model, models), h('label', {}, 'Effort', effort));
    const stop = h('button', { class: 'stop', hidden: true, title: 'Stop', 'aria-label': 'Stop', onclick: guarded(async () => {
      const r = await api(`/api/conversations/${id}/cancel`, { method: 'POST' }); flash(r.cancelled ? 'cancelled' : 'nothing running');
    }) }, '■');
    main.replaceChildren(chatHead, log, h('div', { class: 'composer' },
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
setUnauthorizedHandler(showLogin);
if (currentToken()) showApp(); else showLogin();

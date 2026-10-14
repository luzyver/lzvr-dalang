// Dalang panel. Every server-provided string is inserted as text, never parsed as HTML.
import { h, icon } from './js/dom.js';
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
  const status = h('span', { class: 'small' });

  const flash = (msg) => { status.textContent = msg; if (msg) setTimeout(() => { if (status.textContent === msg) status.textContent = ''; }, 5000); };
  const guarded = (fn) => async (...a) => { try { await fn(...a); } catch (e) { if (!(e instanceof Unauthorized)) flash(e.message); } };

  document.body.classList.remove('nav');
  const menu = h('details', { class: 'menu' },
    h('summary', {}, h('span', { class: 'avatar' }, me.name.slice(0, 1).toUpperCase()), h('span', { class: 'uname' }, me.name)),
    h('div', { class: 'pop', onclick: () => { menu.open = false; } },
      h('div', { class: 'small who' }, `${me.name} · ${me.role}`),
      isAdmin && h('button', { onclick: () => addAccountDialog() }, 'Codex accounts'),
      isAdmin && h('button', { onclick: () => addAccountDialog('claude') }, 'Claude Code accounts'),
      isAdmin && h('button', { onclick: () => defaultModelDialog() }, 'Model & effort defaults'),
      isAdmin && h('button', { onclick: () => usersDialog() }, 'Manage users'),
      h('button', { onclick: guarded(async () => { await enableNotifications(); flash('notifications on'); }) }, 'Enable notifications'),
      h('button', { onclick: guarded(async () => { await registerPasskey(); flash('passkey registered'); }) }, 'Add passkey'),
      h('button', { class: 'danger', onclick: signOut }, 'Sign out')));
  document.onclick = (e) => { if (!menu.contains(e.target)) menu.open = false; };
  const approvalsBox = h('div', { class: 'modal-body' });
  const approvalsBtn = h('button', { class: 'badge warn', hidden: true, onclick: () => openModal(approvalsBox) });
  const header = h('header', {},
    h('button', { class: 'navtoggle', 'aria-label': 'chats', onclick: () => document.body.classList.toggle('nav') }, icon('panel-left')),
    h('span', { class: 'title' }, 'Dalang'), approvalsBtn,
    h('span', { class: 'spacer' }), status, menu);
  root.replaceChildren(h('div', { class: 'shell' }, header, sidebar, main));
  notificationOpensChat = (id) => openConv(id);

  const resetIn = (ts) => {
    const m = Math.max(0, Math.round((ts * 1000 - Date.now()) / 60000));
    return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  // One bar per usage window (the share still left) as last reported by the CLI during a turn. A window past its reset counts as full.
  function limitBars(l) {
    if (!l) return h('div', { class: 'small' }, 'Usage appears after this account runs its first turn.');
    return h('div', { class: 'meters' }, l.windows.map((w) => {
      const over = w.resetsAt * 1000 < Date.now();
      const left = over ? 100 : Math.max(0, 100 - Math.round(w.usedPercent));
      return h('div', { class: 'meter', title: limitsTitle(l) },
        h('span', { class: 'meter-label' }, w.label),
        h('div', { class: 'meter-track' }, h('div', { class: `meter-fill ${left <= 10 ? 'hot' : left <= 30 ? 'warm' : ''}`, style: `width:${left}%` })),
        h('span', { class: 'meter-pct' }, `${left}%`),
        h('span', { class: 'meter-reset small' }, over ? 'reset' : `resets in ${resetIn(w.resetsAt)}`));
    }));
  }
  function limitsTitle(l) {
    return l ? l.windows.map((w) => `${w.label}: ${Math.max(0, 100 - Math.round(w.usedPercent))}% left, resets ${new Date(w.resetsAt * 1000).toLocaleString()}`).join('\n') : '';
  }

  // Add another Codex account: runs `codex login --device-auth` on the server and shows its link and code here.
  // Every menu action opens in this one modal instead of the sidebar.
  const modal = h('dialog', { class: 'modal' });
  let onModalClose = null;
  modal.addEventListener('close', () => { const f = onModalClose; onModalClose = null; modal.replaceChildren(); f?.(); });
  modal.addEventListener('click', (e) => { if (e.target === modal) modal.close(); }); // click on the backdrop
  root.append(modal);
  const closeModal = () => modal.close();
  function openModal(content, onClose) {
    if (modal.open) modal.close();
    onModalClose = onClose || null;
    modal.replaceChildren(content);
    modal.showModal();
  }
  // Global model/effort defaults, one section per backend (a Codex model name means nothing to Claude Code).
  function defaultModelDialog() {
    const msg = h('div', { class: 'small' });
    const section = (backend, title) => {
      const q = backend === 'claude' ? '?backend=claude' : '';
      const model = h('select');
      const effort = h('select', {}, [['', `${title} default`], ...['low', 'medium', 'high', 'xhigh', 'max'].map((v) => [v, v])]
        .map(([value, label]) => h('option', { value }, label)));
      let modelList = [];
      let savedModel = '';
      const updateModels = () => {
        const options = [h('option', { value: '' }, `${title} default`), ...modelList.map((m) => h('option', { value: m.slug }, `${m.name} (${m.slug})`))];
        if (savedModel && !modelList.some((m) => m.slug === savedModel)) options.push(h('option', { value: savedModel }, savedModel));
        model.replaceChildren(...options);
        model.value = savedModel;
      };
      Promise.all([api(`/api/settings/default-model${q}`), api(`/api/settings/default-effort${q}`)]).then(([m, e]) => {
        savedModel = m.model;
        effort.value = e.effort;
        updateModels();
      }).catch((e) => { msg.textContent = e.message; });
      api(`/api/models${q}`).then((models) => { modelList = models; updateModels(); }).catch(() => {});
      return {
        el: h('div', { class: 'model-settings' }, h('strong', {}, title), h('label', {}, 'Model', model), h('label', {}, 'Reasoning effort', effort)),
        save: async () => {
          await api('/api/settings/default-model', { method: 'PUT', body: { model: model.value, backend } });
          await api('/api/settings/default-effort', { method: 'PUT', body: { effort: effort.value, backend } });
        },
      };
    };
    const sections = [section('codex', 'Codex'), section('claude', 'Claude Code')];
    const save = guarded(async () => {
      for (const s of sections) await s.save();
      flash('Global model and effort defaults saved');
      closeModal();
    });
    openModal(h('div', { class: 'modal-body' },
      h('strong', {}, 'Global defaults'),
      h('div', { class: 'small' }, 'Used when a chat has no model or effort override. Leave a field on its default to let the CLI choose.'),
      ...sections.map((s) => s.el),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save'), h('button', { onclick: closeModal }, 'Cancel')),
      msg));
  }
  function addAccountDialog(backend = 'codex') {
    const label = backend === 'claude' ? 'Claude Code' : 'Codex';
    const q = backend === 'claude' ? '?backend=claude' : '';
    const nameIn = h('input', { placeholder: 'account name (a-z, 0-9, - or _)' });
    const list = h('div', { class: 'acctlist' });
    const loadList = async () => {
      try {
        const accts = await api(`/api/accounts${q}`);
        list.replaceChildren(...accts.map((a) => h('div', { class: 'acct' }, h('div', { class: 'acct-head' },
          h('label', { class: 'switch', title: 'Use this account for new turns' },
            h('input', { type: 'checkbox', checked: a.enabled, onchange: guarded(async (e) => {
              await api(`/api/accounts/${encodeURIComponent(a.name)}/enabled`, { method: 'PUT', body: { enabled: e.target.checked, backend } });
              loadList();
            }) })),
          h('strong', {}, a.name),
          h('span', { class: 'small' }, !a.enabled ? 'off' : a.loggedIn === false ? 'not logged in' : a.blockedUntil ? 'at limit' : 'ready'),
          h('span', { class: 'spacer' }),
          a.blockedUntil && h('button', { onclick: guarded(async () => { await api('/api/accounts/unblock', { method: 'POST' }); loadList(); }) }, 'Unblock'),
          h('button', { class: 'danger', onclick: guarded(async () => {
            if (!confirm(`Remove account "${a.name}"? Its ${label} login is deleted from this server. Chats and projects stay.`)) return;
            await api(`/api/accounts/${encodeURIComponent(a.name)}${q}`, { method: 'DELETE' });
            flash(`removed ${a.name}`);
            loadList();
          }) }, 'Remove')),
          limitBars(a.limits))));
      } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
    };
    const out = h('pre', { class: 'loginlog' });
    const link = h('div', { class: 'loginlink' });
    const msg = h('div', { class: 'small' });
    let id = null;
    let timer = null;
    const close = closeModal;
    const poll = async () => {
      try {
        const s = await api(`/api/accounts/login/${id}`);
        // Only touch the DOM when something changed, so a selection in the log or the code survives polling.
        if (out.textContent !== s.output) out.textContent = s.output;
        const linkKey = `${s.url || ''}\n${s.code || ''}`;
        if (link.dataset.key !== linkKey) {
          link.dataset.key = linkKey;
          link.replaceChildren();
          if (s.url && /^https:\/\//.test(s.url)) link.append(h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page'));
          if (s.code) link.append(' code: ', h('strong', { class: 'logincode' }, s.code), ' ', h('button', { onclick: async () => {
            try { await navigator.clipboard.writeText(s.code); flash('copied'); } catch { getSelection().selectAllChildren(link.querySelector('.logincode')); }
          } }, 'Copy'));
        }
        if (s.status !== 'pending') {
          clearInterval(timer);
          msg.textContent = s.status === 'success' ? `Account "${s.name}" added.` : s.status === 'cancelled' ? 'Cancelled.' : `Failed: ${s.error || 'unknown error'}`;
          startBtn.disabled = false;
          cancelBtn.hidden = true;
          loadList();
        }
      } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
    };
    const startBtn = h('button', { class: 'primary', onclick: guarded(async () => {
      msg.textContent = '';
      const r = await api('/api/accounts/login', { method: 'POST', body: { name: nameIn.value.trim(), backend } });
      id = r.id;
      startBtn.disabled = true;
      cancelBtn.hidden = false;
      clearInterval(timer);
      timer = setInterval(poll, 1500);
      poll();
    }) }, 'Start login');
    const codeIn = h('input', { placeholder: 'code from the sign-in page' });
    const codeRow = backend === 'claude' ? h('div', { class: 'row' }, codeIn, h('button', { onclick: guarded(async () => {
      await api(`/api/accounts/login/${id}/code`, { method: 'POST', body: { code: codeIn.value.trim() } });
      codeIn.value = '';
      poll();
    }) }, 'Send code')) : null;
    const cancelBtn = h('button', { class: 'danger', hidden: true, onclick: guarded(async () => {
      await api(`/api/accounts/login/${id}`, { method: 'DELETE' });
      poll();
    }) }, 'Cancel');
    loadList();
    openModal(h('div', { class: 'modal-body' },
      h('strong', {}, `${label} accounts`), list,
      h('strong', {}, 'Add an account'),
      h('div', { class: 'small' }, backend === 'claude'
        ? 'Runs "claude auth login" on the server. A browser window opens on that machine; sign in with the account you want to add (or open the link below). If the page shows a code instead of finishing, paste it here.'
        : 'Runs "codex login --device-auth" on the server. Open the link, enter the code and approve with the account you want to add.'),
      h('div', { class: 'row' }, nameIn, startBtn, cancelBtn, h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, icon('x'))),
      link, codeRow, out, msg), () => clearInterval(timer));
  }

  // User management (admins): create users with a role, change roles, issue a new token, delete.
  function usersDialog() {
    const list = h('div');
    const reveal = h('div');
    const nameIn = h('input', { placeholder: 'user name (a-z, 0-9, - or _)' });
    const roleSel = h('select', {}, ['dev', 'admin'].map((v) => h('option', { value: v }, v)));
    const close = closeModal;

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
    openModal(h('div', { class: 'modal-body' },
      h('strong', {}, 'Users'),
      h('div', { class: 'small' }, 'admin: everything. dev: use projects and chats, but not manage users, accounts or projects.'),
      list,
      h('div', { class: 'row' }, nameIn, roleSel, h('button', { class: 'primary', onclick: create }, 'Create'), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, icon('x'))),
      reveal));
    reload().catch((e) => flash(e.message));
  }

  // Sends one chat wants to make into another (via MCP) wait here until a human decides.
  async function refreshApprovals() {
    try {
      const list = await api('/api/approvals');
      const decide = (a, verb) => guarded(async () => { await api(`/api/approvals/${a.id}/${verb}`, { method: 'POST' }); refreshApprovals(); });
      approvalsBtn.hidden = !list.length;
      approvalsBtn.textContent = `Approvals (${list.length})`;
      if (!list.length && approvalsBox.isConnected) closeModal();
      approvalsBox.replaceChildren(h('strong', {}, 'Approvals'), ...list.map((a) => h('div', { class: 'msg' },
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

  function addProjectDialog() {
    const nameIn = h('input', { placeholder: 'name' });
    const pathIn = h('input', { placeholder: 'path (absolute or under the root)' });
    const sbSel = h('select', {}, ['workspace-write', 'read-only', 'danger-full-access'].map((v) => h('option', { value: v }, v)));
    const backendSel = h('select', {}, [['codex', 'Codex'], ['claude', 'Claude Code']].map(([v, l]) => h('option', { value: v }, l)));
    const msg = h('div', { class: 'small' });
    const create = async () => {
      try {
        await api('/api/projects', { method: 'POST', body: { name: nameIn.value.trim(), path: pathIn.value.trim(), sandbox: sbSel.value, backend: backendSel.value } });
        closeModal();
        await loadProjects();
      } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
    };
    openModal(h('div', { class: 'modal-body' },
      h('strong', {}, 'Add project'),
      h('label', {}, 'Name', nameIn),
      h('label', {}, 'Folder', pathIn),
      h('label', {}, 'Agent (for every chat in this project)', backendSel),
      h('label', {}, 'Sandbox', sbSel),
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: create }, 'Create'), h('button', { onclick: closeModal }, 'Cancel')),
      msg));
    nameIn.focus();
  }
  const addProjectBtn = h('button', { class: 'add-project', onclick: addProjectDialog }, icon('plus'), 'Add project');

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
            icon(collapsed ? 'chevron-right' : 'chevron-down'),
            icon('folder'),
            h('span', { class: 'pname' }, h('strong', {}, p.name), h('span', { class: `small backend-tag ${p.backend}` }, `${p.backend === 'claude' ? 'Claude Code' : 'Codex'} · ${p.sandbox}`))),
          h('button', { class: 'iconbtn', title: 'New chat', 'aria-label': 'New chat', onclick: newChat(p) }, icon('plus')),
          isAdmin && h('details', { class: 'more' }, h('summary', { 'aria-label': 'Project options' }, icon('ellipsis')),
            h('div', { class: 'pop' },
              p.backend === 'codex' && h('button', { onclick: guarded(() => adoptDialog(p)) }, 'Adopt Codex session'),
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
            h('button', { class: 'conv-delete', title: `Delete ${title}`, 'aria-label': `Delete chat ${title}`, onclick: deleteConv(c.id) }, icon('trash-2')));
        })) : h('div', { class: 'small hint' }, 'No chats yet')));
    });
    sidebar.replaceChildren(...[
      h('div', { class: 'explorer-head' }, h('span', {}, 'WORKSPACE'), h('span', { class: 'explorer-caption' }, `${state.projects.length} PROJECT${state.projects.length === 1 ? '' : 'S'}`)),
      isAdmin ? addProjectBtn : null, ...blocks,
      !blocks.length ? h('div', { class: 'small empty-projects' }, 'No projects yet') : null].filter(Boolean));
  }

  async function adoptDialog(project) {
    const sessions = await api('/api/sessions');
    if (!sessions.length) { flash('no Codex sessions found'); return; }
    const sel = h('select', {}, sessions.map((s) => h('option', { value: s.id },
      `${new Date(s.modified).toLocaleString()} ${s.cwd ? '· ' + s.cwd : ''} · ${s.id.slice(0, 8)}`)));
    const box = h('div', { class: 'row' }, sel, h('button', { class: 'primary', onclick: guarded(async () => {
      const c = await api(`/api/projects/${project.id}/conversations`, { method: 'POST', body: { threadId: sel.value } });
      closeModal();
      await loadProjects();
      openConv(c.id);
    }) }, 'Adopt'), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: closeModal }, icon('x')));
    openModal(h('div', { class: 'modal-body' }, h('strong', {}, 'Adopt a Codex session'), box));
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
    let modelList = [];
    let currentModel = '';
    let currentEffort = '';
    let globalModel = '';
    let globalEffort = '';
    let backendName = 'Codex';
    const model = h('select', { title: 'Model', onchange: guarded(async () => {
      currentModel = model.value;
      updateEffortOptions();
      await api(`/api/conversations/${id}/model`, { method: 'PUT', body: { model: currentModel } });
      flash(currentModel ? `model: ${currentModel}` : 'using global model default');
    }) });
    const effort = h('select', { title: 'Reasoning effort', onchange: guarded(async () => {
      currentEffort = effort.value;
      await api(`/api/conversations/${id}/effort`, { method: 'PUT', body: { effort: currentEffort } });
      flash(currentEffort ? `effort: ${currentEffort}` : 'effort: default');
    }) });
    function updateModelOptions() {
      const options = [h('option', { value: '' }, globalModel || `${backendName} default`), ...modelList.filter((m) => m.slug !== globalModel).map((m) => h('option', { value: m.slug }, `${m.name} (${m.slug})`))];
      if (currentModel && currentModel !== globalModel && !modelList.some((m) => m.slug === currentModel)) options.push(h('option', { value: currentModel }, currentModel));
      model.replaceChildren(...options);
      model.value = currentModel === globalModel ? '' : currentModel;
    }
    function updateEffortOptions() {
      const supported = modelList.find((m) => m.slug === (model.value || globalModel))?.efforts;
      const choices = (supported?.length ? supported : ['low', 'medium', 'high', 'xhigh', 'max']).filter((v) => v !== globalEffort);
      const selectedEffort = currentEffort === globalEffort ? '' : currentEffort;
      const values = [...new Set(['', ...choices, ...(selectedEffort && !choices.includes(selectedEffort) ? [selectedEffort] : [])])];
      effort.replaceChildren(...values.map((v) => h('option', { value: v }, v || globalEffort || `${backendName} default`)));
      effort.value = selectedEffort;
    }
    updateModelOptions();
    updateEffortOptions();
    api(`/api/conversations/${id}`).then((c) => {
      const claude = c.backend === 'claude';
      backendName = claude ? 'Claude Code' : 'Codex';
      text.placeholder = `Message ${backendName}…`;
      return Promise.all([
        api(`/api/models${claude ? '?backend=claude' : ''}`),
        api(`/api/settings/default-model${claude ? '?backend=claude' : ''}`).catch(() => ({ model: '' })),
        api(`/api/settings/default-effort${claude ? '?backend=claude' : ''}`).catch(() => ({ effort: '' })),
      ]);
    }).then(([list, m, e]) => {
      modelList = list;
      globalModel = m.model;
      globalEffort = e.effort;
      updateModelOptions();
      updateEffortOptions();
    }).catch(() => {});

    async function refreshQueue() {
      const q = await api(`/api/conversations/${id}/queue`);
      queueBox.replaceChildren(...q.map((item) => h('span', { class: 'chip' }, item.prompt.slice(0, 40),
        h('button', { class: 'iconbtn', title: 'Remove from queue', 'aria-label': 'Remove from queue', onclick: guarded(async () => { await api(`/api/queue/${item.id}`, { method: 'DELETE' }); refreshQueue(); }) }, icon('x')))));
    }
    async function refreshConv() {
      const c = await api(`/api/conversations/${id}`);
      currentModel = c.model || '';
      currentEffort = c.effort || '';
      if (document.activeElement !== model) updateModelOptions();
      updateEffortOptions();
      if (!text.value && c.draft) text.value = c.draft;
      const list = state.projects.flatMap((p) => state.convs.get(p.id) || []);
      const known = list.find((x) => x.id === id);
      const running = c.status === 'running';
      stop.hidden = !running;
      sendButton.hidden = running;
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
    const settings = h('div', { class: 'settings' },
      h('label', {}, 'Model', model), h('label', {}, 'Effort', effort));
    const initiallyRunning = initial?.status === 'running';
    const stop = h('button', { class: 'stop', hidden: !initiallyRunning, title: 'Stop', 'aria-label': 'Stop', onclick: guarded(async () => {
      const r = await api(`/api/conversations/${id}/cancel`, { method: 'POST' }); flash(r.cancelled ? 'cancelled' : 'nothing running');
    }) }, icon('square'));
    const sendButton = h('button', { class: 'primary send', hidden: initiallyRunning, 'aria-label': 'Send', onclick: send }, icon('arrow-up'));
    main.replaceChildren(chatHead, log, h('div', { class: 'composer' },
      queueBox,
      h('div', { class: 'box' },
        h('div', { class: 'inputrow' },
          h('label', { class: 'iconbtn', title: 'Attach files' }, icon('paperclip'), attachCount, files),
          text,
          stop,
          sendButton),
        settings)));

    stopStream = startStream(id, (e) => {
      const el = renderEvent(e);
      if (el) {
        const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
        log.append(el);
        if (nearBottom) log.scrollTop = log.scrollHeight;
      }
      if (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.status' || e.type === 'process.exit' || e.type === 'user.prompt') {
        refreshQueue().catch(() => {});
        refreshConv().catch(() => {});
      }
    });
    refreshQueue().catch(() => {});
    refreshConv().catch(() => {});
  }

  drawMain(null);
  try { await loadProjects(); } catch (e) { if (!(e instanceof Unauthorized)) flash(e.message); return; }
  const tick = () => { if (isAdmin) refreshApprovals(); };
  // First run: nothing works until an account exists, so an admin lands straight in the sign-in step.
  if (isAdmin) Promise.all([api('/api/accounts'), api('/api/accounts?backend=claude')]).then(([a, c]) => { if (!a.length && !c.length) addAccountDialog(); }).catch(() => {});
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

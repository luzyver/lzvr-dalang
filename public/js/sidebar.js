// The sidebar: search, Scheduled / Approvals, every project with its chats, account usage and the user menu.
// Also the Add project dialog.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Field, Icon, Logo, Menu, MenuItem, Modal, Seg } from './ui.js';
import {
  approvals, convs, dbApprovals, goHome, guarded, isAdmin, isOwner, loadProjects, me, newChat, openChat, openSettings, openSqlEditor, openView, projects, route,
  toggleCollapsed, toggleSidebar, ui,
} from './store.js';
import { scheduleCount } from './schedules.js';

/** Per backend, the first account that is ready and how much of its tightest usage window is left. */
export const usage = signal([]);
export async function refreshUsage() {
  if (!isAdmin.value) return;
  try {
    const [codex, claude] = await Promise.all([api('/api/accounts'), api('/api/accounts?backend=claude')]);
    const pick = (label, list) => {
      const a = list.find((x) => x.enabled && x.loggedIn !== false && !x.blockedUntil) || list.find((x) => x.enabled);
      if (!a) return null;
      const left = a.limits?.windows?.length
        ? Math.min(...a.limits.windows.map((w) => (w.resetsAt * 1000 < Date.now() ? 100 : Math.max(0, 100 - Math.round(w.usedPercent)))))
        : null;
      return { label, name: a.name, left, blocked: !!a.blockedUntil };
    };
    usage.value = [pick('Codex', codex), pick('Claude Code', claude)].filter(Boolean);
  } catch { /* shown on the next refresh */ }
}

/** Who may open a project (the server enforces it). The owner always may; an admin may only pick what keeps them in. */
const ACCESS = { all: 'Everyone', admin: 'Owner and admins', owner: 'Owner only' };
const grantable = () => Object.keys(ACCESS).filter((k) => isOwner.value || k !== 'owner');

/** `my-app` from `git@github.com:acme/my-app.git` or `https://host/acme/my-app`. */
const repoName = (url) => url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || '';

function AddProject() {
  const [form, setForm] = useState({ name: '', path: '', backend: 'codex', sandbox: 'workspace-write', access: 'all', clone: '' });
  const [source, setSource] = useState('folder'); // or 'clone': the folder is made by cloning a repository
  const [error, setError] = useState('');
  const set = (k) => (e) => setForm({ ...form, [k]: e.currentTarget.value });
  // A repository address fills in the name and folder while they are still untouched (or were filled in by it).
  const setClone = (e) => {
    const url = e.currentTarget.value;
    const before = repoName(form.clone);
    setForm({ ...form, clone: url, ...(form.name === before && { name: repoName(url) }), ...(form.path === before && { path: repoName(url) }) });
  };
  const close = () => { ui.addProject.value = false; };
  const create = async () => {
    setError('');
    const { clone, ...rest } = form;
    try {
      await api('/api/projects', { method: 'POST', body: { ...rest, name: form.name.trim(), path: form.path.trim(), ...(source === 'clone' && { clone: clone.trim() }) } });
      close();
      await loadProjects();
    } catch (e) { setError(e.message); }
  };
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Add project</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    <${Seg} label="Source" value=${source} onChange=${setSource} options=${[['folder', 'Existing folder', 'folder'], ['clone', 'Clone a repository', 'git-branch']]} />
    ${source === 'clone' && html`<${Field} label="Repository" hint="SSH or HTTPS address. It is cloned with your git login (Settings → Git & forges).">
      <input class="mono" value=${form.clone} onInput=${setClone} autofocus placeholder="git@github.com:acme/my-app.git" /><//>`}
    <${Field} label="Name"><input value=${form.name} onInput=${set('name')} autofocus=${source === 'folder'} placeholder="my-app" /><//>
    <${Field} label="Folder" hint=${source === 'clone' ? 'A new folder, relative to the projects root on the server.' : 'Absolute, or relative to the projects root on the server.'}>
      <input class="mono" value=${form.path} onInput=${set('path')} placeholder=${source === 'clone' ? 'my-app' : '/srv/code/my-app'} /><//>
    <div class="row wrap">
      <${Field} label="Agent (every chat in this project)"><select value=${form.backend} onChange=${set('backend')}>
        <option value="codex">Codex</option><option value="claude">Claude Code</option></select><//>
      <${Field} label="Sandbox"><select value=${form.sandbox} onChange=${set('sandbox')}>
        ${['workspace-write', 'read-only', 'danger-full-access'].map((v) => html`<option value=${v}>${v}</option>`)}</select><//>
      <${Field} label="Access"><select value=${form.access} onChange=${set('access')}>
        ${grantable().map((k) => html`<option value=${k}>${ACCESS[k]}</option>`)}</select><//>
    </div>
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="row end"><button class="btn" onClick=${close}>Cancel</button>
      <${AsyncButton} class="btn primary" icon="folder-plus" busyText=${source === 'clone' ? 'Cloning…' : undefined} onClick=${create}>${source === 'clone' ? 'Clone and create' : 'Create'}<//></div>
  </div>`;
}

export const AddProjectModal = () => html`<${Modal} open=${ui.addProject.value} label="Add project" class="dialog" onClose=${() => { ui.addProject.value = false; }}><${AddProject} /><//>`;

function ChatRow({ c, active }) {
  const title = c.title || 'New chat';
  const remove = guarded(async () => {
    if (!await confirmDialog({
      title: 'Delete this chat and its history?',
      message: c.worktree
        ? `Its worktree is removed too: uncommitted changes there are lost. Branch ${c.branch} is deleted here and on the remote if it is merged, otherwise it stays.`
        : 'The project and its files stay.',
      confirmText: 'Delete',
      danger: true,
    })) return;
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    if (active) goHome();
    await loadProjects();
  });
  return html`<div class=${cx('chat-row', active && 'active')}>
    <a class="chat" href=${`#c=${c.id}`} aria-current=${active ? 'page' : undefined} onClick=${(e) => { e.preventDefault(); openChat(c.id); }}>
      <span class=${cx('dot', c.status)} title=${c.status}></span>
      <span class="chat-title" title=${title}>${title}</span>
      ${c.worktree && html`<span class="chat-branch" title=${`Own worktree on ${c.branch}`}><${Icon} name="git-branch" class="tiny" /></span>`}
    </a>
    <button class="icon-btn sm row-action" aria-label=${`Delete chat ${title}`} title="Delete chat" onClick=${remove}><${Icon} name="trash-2" /></button>
  </div>`;
}

const SANDBOX_TAGS = {
  'read-only': { name: 'eye', label: 'read-only' },
  'workspace-write': { name: 'pencil', label: 'workspace-write' },
  'danger-full-access': { name: 'shield-alert', label: 'danger-full-access', danger: true },
};

const Tag = ({ name, label, danger }) => name
  && html`<span class=${cx('project-tag', danger && 'danger')} title=${label} aria-label=${label} role="img"><${Icon} name=${name} /></span>`;

function Project({ p }) {
  const list = convs.value.get(p.id) || [];
  const collapsed = ui.collapsed.value.has(p.id);
  const current = route.value.view === 'chat' ? route.value.id : null;
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: `Remove project "${p.name}"?`, message: 'It and its chats leave the panel. Files stay untouched.', confirmText: 'Remove', danger: true })) return;
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    await loadProjects();
  });
  const setAccess = (access) => guarded(async () => {
    await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { access } });
    await loadProjects();
  });
  return html`<div class="project">
    <div class="project-row">
      <button class="project-toggle" aria-expanded=${!collapsed} onClick=${() => toggleCollapsed(p.id)}>
        <${Icon} name=${collapsed ? 'chevron-right' : 'chevron-down'} class="caret" />
        <span class="project-meta">
          <${Tag} name=${p.backend === 'claude' ? 'asterisk' : 'code-xml'} label=${p.backend === 'claude' ? 'Claude Code' : 'Codex'} />
          <${Tag} ...${SANDBOX_TAGS[p.sandbox]} />
          ${p.access && p.access !== 'all' && html`<${Tag} name=${p.access === 'owner' ? 'user' : 'users'} label=${`Access: ${ACCESS[p.access]}`} />`}
        </span>
        <span class="project-name" title=${p.path}>${p.name}</span>
      </button>
      <button class="icon-btn sm row-action" aria-label=${`New chat in ${p.name}`} title="New chat" onClick=${newChat(p)}><${Icon} name="plus" /></button>
      <${Menu} label="Project options" buttonClass="sm row-action">
        <${MenuItem} icon="git-branch" title="A new git branch and folder for this chat only; open a Merge Request for it from Changes" onClick=${newChat(p, true)}>New chat in own worktree<//>
        ${isAdmin.value && html`<div class="menu-label">Access</div>
          ${grantable().map((k) => html`<button key=${k} role="menuitemradio" aria-checked=${p.access === k} class="menu-item"
            onClick=${p.access === k ? undefined : setAccess(k)}><${Icon} name="check" class=${cx(p.access !== k && 'invisible')} /><span>${ACCESS[k]}</span></button>`)}
          <div class="menu-sep"></div>
          <${MenuItem} icon="trash-2" danger onClick=${remove}>Remove project<//>`}
      <//>
    </div>
    ${!collapsed && html`<div class="chats">
      ${list.length ? list.map((c) => html`<${ChatRow} key=${c.id} c=${c} active=${c.id === current} />`)
        : html`<button class="chat ghost" onClick=${newChat(p)}><${Icon} name="plus" class="tiny" />Start a chat</button>`}
    </div>`}
  </div>`;
}

export function Sidebar() {
  const user = me.value;
  const view = route.value.view;
  const waiting = approvals.value.length + dbApprovals.value.length;
  useEffect(() => {
    refreshUsage();
    const t = setInterval(refreshUsage, 60000);
    return () => clearInterval(t);
  }, []);
  return html`<aside class="sidebar" aria-label="Projects and chats">
    <div class="side-top">
      <a class="brand" href="#" onClick=${(e) => { e.preventDefault(); goHome(); }}>
        <${Logo} />
        <span class="brand-name">Dalang</span>
      </a>
      <button class="icon-btn" aria-label="Hide sidebar" title="Hide sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
    </div>
    <button class="search-trigger" onClick=${() => { ui.palette.value = true; }}>
      <${Icon} name="search" /><span>Search or run a command</span><kbd>${navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
    </button>
    <nav class="side-nav">
      <a class=${cx('nav-item', view === 'schedules' && 'active')} href="#" onClick=${(e) => { e.preventDefault(); openView('schedules'); }}>
        <${Icon} name="clock" />Scheduled${scheduleCount.value > 0 && html`<span class="count">${scheduleCount.value}</span>`}</a>
      ${isAdmin.value && html`<a class=${cx('nav-item', view === 'approvals' && 'active')} href="#" onClick=${(e) => { e.preventDefault(); openView('approvals'); }}>
        <${Icon} name="shield-check" />Approvals${waiting > 0 && html`<span class="count attention">${waiting}</span>`}</a>`}
      <a class="nav-item" href="/sql" target="dalang-sql" title="Opens in its own tab" onClick=${(e) => { e.preventDefault(); openSqlEditor(); }}>
        <${Icon} name="database" />SQL Editor</a>
    </nav>
    <div class="side-section">
      <div class="section-head"><span>Projects</span>
        ${isAdmin.value && html`<button class="icon-btn sm" aria-label="Add project" title="Add project" onClick=${() => { ui.addProject.value = true; }}><${Icon} name="plus" /></button>`}</div>
      ${projects.value.map((p) => html`<${Project} key=${p.id} p=${p} />`)}
      ${!projects.value.length && html`<div class="side-empty">${isAdmin.value ? 'No projects yet. Add a folder with the + above.' : 'No projects yet. An admin adds them.'}</div>`}
    </div>
    <div class="side-bottom">
      ${usage.value.map((u) => html`<button class="usage" key=${u.label} title="Accounts" onClick=${() => openSettings(u.label === 'Codex' ? 'codex' : 'claude')}>
        <div class="usage-row"><span>${u.label} · ${u.name}</span><span class=${cx(u.blocked ? 'warn' : 'dim')}>${u.blocked ? 'at limit' : u.left == null ? '' : `${u.left}% left`}</span></div>
        ${u.left != null && html`<div class="meter"><span class=${cx(u.left <= 10 ? 'hot' : u.left <= 30 && 'warm')} style=${{ width: `${u.left}%` }}></span></div>`}
      </button>`)}
      <div class="user-row">
        <span class="avatar" aria-hidden="true">${(user?.name || '?').slice(0, 1).toUpperCase()}</span>
        <div class="user-meta"><strong>${user?.name}</strong><span>${user?.role}</span></div>
        <button class="icon-btn" aria-label="Settings" title="Settings" onClick=${() => openSettings()}><${Icon} name="settings" /></button>
      </div>
    </div>
  </aside>`;
}

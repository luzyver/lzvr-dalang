// The sidebar: new chat and search, Approvals / Scheduled, the chats by project, by status or archived, the tools,
// account usage and the user menu.
// Also the Add project and project access dialogs.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Field, Icon, Logo, Menu, MenuItem, Modal, Seg } from './ui.js';
import {
  approvals, clickupApprovals, dbApprovals, sshApprovals, goHome, guarded, isOwner, loadProjects, me, newChat, openChat, openSettings, openSqlEditor, openView, projects, route,
  setGroupBy, toggleCollapsed, toggleInspector, toggleSidebar, ui,
} from './store.js';
import { scheduleCount } from './schedules.js';
import { ago, byStatus, canArchive, chatLists, isUnread, WHY } from './inbox.js';
import { removeChat, rootOf } from './agent-tree.js';

/** Per backend, the first account that is ready and how much of its tightest usage window is left. */
export const usage = signal([]);
export async function refreshUsage() {
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

/** Who may open a project (the server enforces it). The owner always may; anyone else may only pick what keeps them in. */
const ACCESS = { all: 'Everyone', owner: 'Owner only' };
const grantable = () => Object.keys(ACCESS).filter((k) => isOwner.value || k !== 'owner');
/** The same in words: below "Everyone" a project is the owner's and that of the users it is shared with. */
const accessLabel = (p) => (p.access === 'all' ? ACCESS.all : p.members?.length ? 'Owner and selected users' : ACCESS.owner);

/** The project whose access dialog is open. */
const sharing = signal(null);

/** Who may open a project: everyone, or the owner and the users ticked here. */
function ProjectAccess({ p }) {
  const [access, setAccess] = useState(p.access);
  const [members, setMembers] = useState(new Set(p.members || []));
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/users').then(setUsers, (e) => setError(e.message)); }, []);
  const close = () => { sharing.value = null; };
  const toggle = (id) => () => { const next = new Set(members); if (!next.delete(id)) next.add(id); setMembers(next); };
  const save = async () => {
    setError('');
    try {
      await api(`/api/projects/${p.id}`, { method: 'PATCH', body: { access, members: [...members] } });
      close();
      await loadProjects();
    } catch (e) { setError(e.message); }
  };
  // The owner always may; anyone else may pick "selected users" only while they are one of them (the server checks).
  const levels = [['all', 'Everyone'], ['owner', 'Selected users']];
  const hint = { all: 'Every user of this panel may open it.', owner: 'The owner and only the users ticked below. With none ticked: the owner only.' }[access];
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Access to ${p.name}</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    <${Seg} label="Who may open it" value=${access} onChange=${setAccess} options=${levels} />
    <div class="dim small">${hint}</div>
    ${access !== 'all' && html`<div class="member-list" role="group" aria-label="Users">
      ${!users ? html`<div class="dim small">Loading users…</div>`
        : !users.length ? html`<div class="dim small">No users yet. Add them in Settings → Users.</div>`
        : users.map((u) => html`<label key=${u.id} class="row member">
          <input type="checkbox" checked=${members.has(u.id)} onChange=${toggle(u.id)} />
          <span class="member-name">${u.name}${u.name === me.value?.name ? ' (you)' : ''}</span>
          <span class="dim small">${u.email || ''}</span></label>`)}
    </div>`}
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="row end"><button class="btn" onClick=${close}>Cancel</button>
      <${AsyncButton} class="btn primary" icon="check" onClick=${save}>Save<//></div>
  </div>`;
}
export const ProjectAccessModal = () => html`<${Modal} open=${!!sharing.value} label="Project access" class="dialog" onClose=${() => { sharing.value = null; }}>
  ${sharing.value && html`<${ProjectAccess} key=${sharing.value.id} p=${sharing.value} />`}<//>`;

/** `my-app` from `git@github.com:acme/my-app.git` or `https://host/acme/my-app`. */
const repoName = (url) => url.trim().replace(/\/+$/, '').replace(/\.git$/, '').split(/[/:]/).pop() || '';

function AddProject() {
  const [form, setForm] = useState({ name: '', path: '', sandbox: 'workspace-write', access: 'all', clone: '' });
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

/**
 * One chat in the sidebar: a chat a person started. Its sub-agents and reviewers (`agents`) are not listed; a badge
 * says how many there are and whether one is running, and opens the Agents tab. The row is marked while one of them
 * is open.
 */
function ChatRow({ c, active, agents = [], project, why, archived = false }) {
  const title = c.title || 'New chat';
  const remove = removeChat(c, active);
  const archiveBlocked = !archived && !canArchive(c, agents);
  const move = guarded(async () => {
    await api(`/api/conversations/${c.id}/archive`, { method: 'PUT', body: { archived: !archived } });
    await loadProjects();
  });
  const unread = isUnread(c);
  const status = why ? WHY[why].label : unread ? 'New answer' : c.status;
  const n = agents.length;
  const busy = agents.filter((a) => a.status === 'running').length;
  const showAgents = (e) => { e.preventDefault(); e.stopPropagation(); openChat(c.id); toggleInspector(true, 'agents'); };
  return html`<div class=${cx('chat-row', active && 'active', unread && 'unread')}>
    <a class="chat" href=${`#c=${c.id}`} aria-current=${active ? 'page' : undefined} onClick=${(e) => { e.preventDefault(); openChat(c.id); }}>
      <span class=${cx('dot', c.status, why === 'approval' && 'waiting')} title=${status} role="img" aria-label=${status}></span>
      <span class="chat-title" title=${project ? `${title} · ${project.name}` : title}>${title}${project && html`<small class="chat-project">${project.name}</small>`}</span>
      ${n > 0 && html`<span class=${cx('chat-kids', busy > 0 && 'busy')} onClick=${showAgents}
        title=${`${n} agent${n > 1 ? 's' : ''}${busy ? `, ${busy} running` : ''}: click to show them`}>
        <${Icon} name="bot" class="tiny" />${n}</span>`}
      ${c.worktree && html`<span class="chat-branch" title=${`Own worktree on ${c.branch}`}><${Icon} name="git-branch" class="tiny" /></span>`}
      ${c.status !== 'running' && c.last_at && html`<span class="chat-time">${ago(c.last_at)}</span>`}
    </a>
    <${Menu} label=${`Chat options for ${title}`} buttonClass="sm row-action">
      <${MenuItem} icon=${archived ? 'undo-2' : 'archive'} disabled=${archiveBlocked}
        title=${archiveBlocked ? 'Available when the chat and its agents finish running and approvals are resolved' : undefined}
        onClick=${move}>${archived ? 'Restore chat' : 'Move to archive'}<//>
      <${MenuItem} icon="trash-2" danger onClick=${remove}>Delete chat<//>
    <//>
  </div>`;
}

const SANDBOX_TAGS = {
  'read-only': { name: 'eye', label: 'read-only' },
  'workspace-write': { name: 'pencil', label: 'workspace-write' },
  'danger-full-access': { name: 'shield-alert', label: 'danger-full-access', danger: true },
};

const Tag = ({ name, label, danger }) => name
  && html`<span class=${cx('project-tag', danger && 'danger')} title=${label} aria-label=${label} role="img"><${Icon} name=${name} /></span>`;

/**
 * A project and its chats, newest activity first: the ones in use, or with `archived` the ones left idle. In use, a
 * project whose chats are all archived says so and leads to them.
 */
function Project({ p, archived = false }) {
  const { active, archived: old } = chatLists.value;
  const list = (archived ? old : active).filter((x) => x.project.id === p.id);
  const away = archived ? 0 : old.filter((x) => x.project.id === p.id).length;
  const collapsed = ui.collapsed.value.has(p.id);
  const current = openTop();
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: `Remove project "${p.name}"?`, message: 'It and its chats leave the panel. Files stay untouched.', confirmText: 'Remove', danger: true })) return;
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    await loadProjects();
  });
  return html`<div class="project">
    <div class="project-row">
      <button class="project-toggle" aria-expanded=${!collapsed} onClick=${() => toggleCollapsed(p.id)}>
        <${Icon} name=${collapsed ? 'chevron-right' : 'chevron-down'} class="caret" />
        <span class="project-meta">
          <${Tag} ...${SANDBOX_TAGS[p.sandbox]} />
          ${p.access && p.access !== 'all' && html`<${Tag} name=${p.access === 'owner' && !p.members?.length ? 'user' : 'users'} label=${`Access: ${accessLabel(p)}`} />`}
        </span>
        <span class="project-name" title=${p.path}>${p.name}</span>
      </button>
      <button class="icon-btn sm row-action" aria-label=${`New chat in ${p.name}`} title="New chat" onClick=${newChat(p)}><${Icon} name="plus" /></button>
      <${Menu} label="Project options" buttonClass="sm row-action">
        <${MenuItem} icon="git-branch" title="A new git branch and folder for this chat only; open a Merge Request for it from Changes" onClick=${newChat(p, true)}>New chat in own worktree<//>
        ${html`<${MenuItem} icon="users" title=${`Now: ${accessLabel(p)}`} onClick=${() => { sharing.value = p; }}>Access…<//>
          <div class="menu-sep"></div>
          <${MenuItem} icon="trash-2" danger onClick=${remove}>Remove project<//>`}
      <//>
    </div>
    ${!collapsed && html`<div class="chats">
      ${list.length ? list.map((x) => html`<${ChatRow} key=${x.conv.id} c=${x.conv} archived=${archived} agents=${x.agents} active=${x.conv.id === current} />`)
        : html`<button class="chat ghost" onClick=${newChat(p)}><${Icon} name="plus" class="tiny" />Start a chat</button>`}
      ${!list.length && away > 0 && html`<button class="chat ghost" title="Show archived chats" onClick=${() => setGroupBy('archive')}>
        <${Icon} name="archive" class="tiny" />${away} archived</button>`}
    </div>`}
  </div>`;
}

/** The sidebar row to mark: the open chat, or the chat a person started that it runs under. */
const openTop = () => (route.value.view === 'chat' ? rootOf(route.value.id)?.conv.id ?? route.value.id : null);

/** The chats across projects: what needs a person first, then what runs, then the rest by recent activity. */
function StatusList() {
  const { attention, running, rest } = byStatus.value;
  const current = openTop();
  const rows = (list) => list.map((x) => html`<${ChatRow} key=${x.conv.id} c=${x.conv} agents=${x.agents} project=${x.project} why=${x.why} active=${x.conv.id === current} />`);
  const group = (label, list, cls) => list.length > 0 && html`<div class=${cx('status-group', cls)}>
    <div class="group-head"><span>${label}</span><span class="count">${list.length}</span></div>
    <div class="chats flat">${rows(list)}</div></div>`;
  return html`${group('Needs you', attention, 'attention')}${group('Running', running)}${group('Recent', rest.slice(0, 40))}
    ${!attention.length && !running.length && !rest.length && html`<div class="side-empty">No chats yet.</div>`}`;
}

/** Chats archived manually or after three idle hours, grouped by project. Their next turn brings them back to the other lists. */
function ArchiveList() {
  const ids = new Set(chatLists.value.archived.map((x) => x.project.id));
  const list = projects.value.filter((p) => ids.has(p.id));
  return html`${list.map((p) => html`<${Project} key=${p.id} p=${p} archived />`)}
    <div class="side-empty">${!list.length && 'No archived chats. '}Chats move here after 3 idle hours. Daily cleanup permanently deletes completed chats and chats idle for more than 10 days.</div>`;
}

/** Start a chat: straight away with one project, otherwise pick the project from a menu. */
function NewChat() {
  const list = projects.value;
  if (list.length <= 1) {
    return html`<button class="new-chat" disabled=${!list.length} onClick=${list[0] && newChat(list[0])}><${Icon} name="square-pen" /><span>New chat</span></button>`;
  }
  return html`<${Menu} icon="square-pen" text="New chat" label="New chat in a project" align="start" class="new-chat-menu" buttonClass="new-chat">
    ${list.map((p) => html`<${MenuItem} key=${p.id} icon="folder" onClick=${newChat(p)}>${p.name}<//>`)}
  <//>`;
}

export function Sidebar() {
  const user = me.value;
  const view = route.value.view;
  const waiting = approvals.value.length + dbApprovals.value.length + sshApprovals.value.length + clickupApprovals.value.length;
  const by = ui.groupBy.value;
  const go = (name) => (e) => { e.preventDefault(); openView(name); };
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
    <div class="side-actions">
      <${NewChat} />
      <button class="search-trigger" aria-label="Search or run a command" title="Search or run a command" onClick=${() => { ui.palette.value = true; }}>
        <${Icon} name="search" /><span>Search</span><kbd>${navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'}</kbd>
      </button>
    </div>
    <nav class="side-nav">
      ${html`<a class=${cx('nav-item', view === 'approvals' && 'active')} href="#" onClick=${go('approvals')}>
        <${Icon} name="shield-check" />Approvals${waiting > 0 && html`<span class="count attention">${waiting}</span>`}</a>`}
      <a class=${cx('nav-item', view === 'schedules' && 'active')} href="#" onClick=${go('schedules')}>
        <${Icon} name="clock" />Scheduled${scheduleCount.value > 0 && html`<span class="count">${scheduleCount.value}</span>`}</a>
    </nav>
    <div class="side-section">
      <div class="section-head">
        <${Seg} small label="Show chats" value=${by} onChange=${setGroupBy} options=${[['project', 'Projects'], ['status', 'Status'], ['archive', 'Archive']]} />
        ${html`<button class="icon-btn sm" aria-label="Add project" title="Add project" onClick=${() => { ui.addProject.value = true; }}><${Icon} name="folder-plus" /></button>`}</div>
      ${by === 'status' ? html`<${StatusList} />` : by === 'archive' ? html`<${ArchiveList} />` : html`
        ${projects.value.map((p) => html`<${Project} key=${p.id} p=${p} />`)}
        ${!projects.value.length && html`<div class="side-empty">No projects yet. Add a folder with the button above.</div>`}`}
    </div>
    <div class="side-bottom">
      <nav class="side-tools" aria-label="Tools">
        <a class="nav-item" href="/sql" target="dalang-sql" title="Opens in its own tab" onClick=${(e) => { e.preventDefault(); openSqlEditor(); }}>
          <${Icon} name="database" />SQL Editor<${Icon} name="external-link" class="tiny trail" /></a>
        ${html`<a class=${cx('nav-item', view === 'ssh' && 'active')} href="#" onClick=${go('ssh')}>
          <${Icon} name="terminal" />SSH Hosts</a>`}
      </nav>
      ${usage.value.map((u) => html`<button class="usage" key=${u.label} title="Accounts" onClick=${() => openSettings(u.label === 'Codex' ? 'codex' : 'claude')}>
        <div class="usage-row"><span>${u.label} · ${u.name}</span><span class=${cx(u.blocked ? 'warn' : 'dim')}>${u.blocked ? 'at limit' : u.left == null ? '' : `${u.left}% left`}</span></div>
        ${u.left != null && html`<div class="meter"><span class=${cx(u.left <= 10 ? 'hot' : u.left <= 30 && 'warm')} style=${{ width: `${u.left}%` }}></span></div>`}
      </button>`)}
      <div class="user-row">
        <span class="avatar" aria-hidden="true">${(user?.name || '?').slice(0, 1).toUpperCase()}</span>
        <div class="user-meta"><strong>${user?.name}</strong></div>
        <button class="icon-btn" aria-label="Settings" title="Settings" onClick=${() => openSettings()}><${Icon} name="settings" /></button>
      </div>
    </div>
  </aside>`;
}

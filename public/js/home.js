// The main area when no chat is open: what needs a person, what runs, recent chats, starting a chat per project and
// how much the accounts have left. Before the first project, a short welcome instead.
import { html, cx } from './lib.js';
import { Icon, Logo } from './ui.js';
import { approvals, convs, dbApprovals, indexRequests, isAdmin, me, newChat, openChat, openSettings, openView, projects, sshApprovals, toggleSidebar, ui } from './store.js';
import { ago, byStatus, WHY } from './inbox.js';
import { usage } from './sidebar.js';
import { plural } from './format.js';

const searchKey = () => (navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K');

function Welcome() {
  return html`<div class="home">
    <${Logo} size=${56} />
    <h1>What should the agents work on?</h1>
    <p class="dim">${isAdmin.value ? 'Add a project folder to start chatting with an agent in it.' : 'An admin adds the projects you can work in.'}</p>
    ${isAdmin.value && html`<button class="btn primary" onClick=${() => { ui.addProject.value = true; }}><${Icon} name="folder-plus" />Add your first project</button>`}
  </div>`;
}

/** One chat: what it needs (or that it runs), its title, its project and when it was last active. */
function ChatLine({ x, why }) {
  const { conv: c, project } = x;
  const w = why && WHY[why];
  return html`<li><button class="ov-row" onClick=${() => openChat(c.id)}>
    ${w ? html`<span class=${cx('ov-icon', w.tone)}><${Icon} name=${w.icon} /></span>`
      : html`<span class="ov-icon"><span class=${cx('dot', c.status)}></span></span>`}
    <span class="ov-main"><strong>${c.title || 'New chat'}</strong>
      <span>${project.name}${w ? ` · ${w.label}${x.count > 1 ? ` (${x.count})` : ''}` : c.model ? ` · ${c.model}` : ''}</span></span>
    <span class="ov-time">${c.status === 'running' ? `for ${ago(c.last_at) === 'now' ? '<1m' : ago(c.last_at)}` : ago(c.last_at)}</span>
  </button></li>`;
}

function Section({ title, count, action, children }) {
  return html`<section class="ov-section">
    <div class="ov-head"><h2>${title}${count > 0 && html`<span class="ov-count">${count}</span>`}</h2>${action}</div>
    ${children}
  </section>`;
}

export function Home() {
  const list = projects.value;
  const { attention, running, rest } = byStatus.value;
  const waiting = approvals.value.length + dbApprovals.value.length + indexRequests.value.length + sshApprovals.value.length;
  const hour = new Date().getHours();
  const greet = hour < 11 ? 'Good morning' : hour < 15 ? 'Good afternoon' : hour < 19 ? 'Good evening' : 'Good night';
  const summary = [attention.length && `${plural(attention.length, 'chat')} need${attention.length === 1 ? 's' : ''} you`, running.length && `${running.length} running`]
    .filter(Boolean).join(' · ') || 'Nothing waits for you.';
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
    </header>
    <div class="thread">${!list.length ? html`<${Welcome} />` : html`<div class="overview">
      <div class="ov-intro">
        <div><h1>${greet}${me.value?.name ? `, ${me.value.name}` : ''}</h1><p>${summary}</p></div>
        <button class="btn ghost" onClick=${() => { ui.palette.value = true; }}><${Icon} name="search" />Search<kbd>${searchKey()}</kbd></button>
      </div>
      <div class="ov-cols">
        <div class="ov-col">
          <${Section} title="Needs you" count=${attention.length}
            action=${isAdmin.value && waiting > 0 && html`<button class="btn sm ghost" onClick=${() => openView('approvals')}>${plural(waiting, 'approval')}<${Icon} name="chevron-right" class="tiny" /></button>`}>
            ${attention.length ? html`<ul class="ov-list">${attention.slice(0, 8).map((x) => html`<${ChatLine} key=${x.conv.id} x=${x} why=${x.why} />`)}</ul>`
              : html`<p class="ov-empty">No failed chats, approvals or unread answers.</p>`}
          <//>
          ${running.length > 0 && html`<${Section} title="Running" count=${running.length}>
            <ul class="ov-list">${running.slice(0, 8).map((x) => html`<${ChatLine} key=${x.conv.id} x=${x} />`)}</ul><//>`}
          ${rest.length > 0 && html`<${Section} title="Recent">
            <ul class="ov-list">${rest.slice(0, 6).map((x) => html`<${ChatLine} key=${x.conv.id} x=${x} />`)}</ul><//>`}
        </div>
        <div class="ov-col side">
          <${Section} title="Start a chat"
            action=${isAdmin.value && html`<button class="icon-btn sm" aria-label="Add project" title="Add project" onClick=${() => { ui.addProject.value = true; }}><${Icon} name="folder-plus" /></button>`}>
            <ul class="ov-list">${list.map((p) => html`<li key=${p.id}><button class="ov-row" onClick=${newChat(p)}>
              <span class="ov-icon"><${Icon} name="folder" /></span>
              <span class="ov-main"><strong>${p.name}</strong><span>${p.backend === 'claude' ? 'Claude Code' : 'Codex'} · ${plural((convs.value.get(p.id) || []).length, 'chat')}</span></span>
              <${Icon} name="plus" class="ov-go" />
            </button></li>`)}</ul>
          <//>
          ${usage.value.length > 0 && html`<${Section} title="Accounts">
            <ul class="ov-list">${usage.value.map((u) => html`<li key=${u.label}><button class="ov-row usage-line" onClick=${() => openSettings(u.label === 'Codex' ? 'codex' : 'claude')}>
              <span class="ov-main"><strong>${u.label}</strong><span>${u.name}</span></span>
              <span class="ov-usage">
                <span class=${cx('ov-left', u.blocked && 'warn')}>${u.blocked ? 'at limit' : u.left == null ? '' : `${u.left}% left`}</span>
                ${u.left != null && html`<span class="meter"><span class=${cx(u.left <= 10 ? 'hot' : u.left <= 30 && 'warm')} style=${{ width: `${u.left}%` }}></span></span>`}
              </span>
            </button></li>`)}</ul>
          <//>`}
        </div>
      </div>
    </div>`}</div>
  </main>`;
}

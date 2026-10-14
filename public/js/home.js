// The main area when no chat is open.
import { html } from './lib.js';
import { Icon } from './ui.js';
import { isAdmin, newChat, projects, toggleSidebar, ui } from './store.js';

export function Home() {
  const list = projects.value;
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
    </header>
    <div class="thread"><div class="home">
      <span class="logo xl" aria-hidden="true"><svg viewBox="0 0 24 24"><path d="M12 2.5c3.6 2.8 6 6.3 6 10.2a6 6 0 0 1-12 0c0-3.9 2.4-7.4 6-10.2Z" /><path d="M12 9v12" /></svg></span>
      <h1>What should the agents work on?</h1>
      <p class="dim">Pick a chat in the sidebar, or start a new one.</p>
      ${list.length > 0 && html`<div class="home-grid">
        ${list.slice(0, 6).map((p) => html`<button key=${p.id} class="home-card" onClick=${newChat(p)}>
          <${Icon} name="plus" /><span><strong>New chat in ${p.name}</strong><span class="dim small">${p.backend === 'claude' ? 'Claude Code' : 'Codex'} · ${p.sandbox}</span></span>
        </button>`)}
      </div>`}
      ${!list.length && isAdmin.value && html`<button class="btn primary" onClick=${() => { ui.addProject.value = true; }}><${Icon} name="folder-plus" />Add your first project</button>`}
      <button class="btn ghost" onClick=${() => { ui.palette.value = true; }}><${Icon} name="search" />Search everything<kbd>${navigator.platform.startsWith('Mac') ? '⌘K' : 'Ctrl K'}</kbd></button>
    </div></div>
  </main>`;
}

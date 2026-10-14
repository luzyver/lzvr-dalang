// Messages one chat wants to send another (via MCP) wait here until a human decides. Shown as cards in the receiving
// chat and all together in the Approvals view.
import { html } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Empty, Icon } from './ui.js';
import { approvals, findConv, guarded, openChat, refreshApprovals, toggleSidebar } from './store.js';

const chatName = (id) => {
  const f = findConv(id);
  return f ? `${f.project.name} / ${f.conv.title || 'New chat'}` : `chat ${id.slice(0, 8)}`;
};

export function ApprovalCard({ a, showTarget }) {
  const decide = (verb) => guarded(async () => { await api(`/api/approvals/${a.id}/${verb}`, { method: 'POST' }); await refreshApprovals(); });
  return html`<div class="card approval">
    <div class="card-icon"><${Icon} name="shield-check" /></div>
    <div class="card-body">
      <strong>${chatName(a.from_conv)} wants to message ${showTarget ? html`<a onClick=${() => openChat(a.to_conv)}>${chatName(a.to_conv)}</a>` : 'this chat'}</strong>
      <div class="card-text">${a.prompt}</div>
      <div class="card-actions">
        <${AsyncButton} class="btn primary sm" icon="check" onClick=${decide('approve')}>Approve<//>
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('reject')}>Reject<//>
      </div>
    </div>
  </div>`;
}

export function ApprovalsView() {
  const list = approvals.value;
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
      <div class="crumbs"><span class="crumb-title">Approvals</span></div>
    </header>
    <div class="thread"><div class="page">
      <p class="dim">Chats can message each other through the MCP gateway. Messages that need a human wait here.</p>
      ${list.length ? list.map((a) => html`<${ApprovalCard} key=${a.id} a=${a} showTarget />`)
        : html`<${Empty} icon="inbox" title="Nothing waiting">New requests show up here and in the chat they are meant for.<//>`}
    </div></div>
  </main>`;
}

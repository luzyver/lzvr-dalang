// Messages one chat wants to send another (via MCP), and database writes agents ask for on "write with approval"
// connections of the SQL editor, wait here until a human decides. Shown as cards in the chat concerned and all together
// in the Approvals view.
import { html } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Empty, Icon } from './ui.js';
import { approvals, dbApprovals, findConv, guarded, openChat, refreshApprovals, toast, toggleSidebar } from './store.js';

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

/** A script an agent wants to run with writes allowed; Approve runs it right away, as the agent wrote it. */
export function DbApprovalCard({ a, showChat }) {
  const decide = (verb) => guarded(async () => {
    const r = await api(`/api/db/approvals/${a.id}/${verb}`, { method: 'POST' });
    if (verb === 'approve') toast(r.status === 'approved' ? `Ran it: ${r.outcome.split('\n').join(', ')}` : `It failed: ${r.outcome}`, r.status === 'approved' ? 'ok' : 'err');
    await refreshApprovals();
  });
  return html`<div class="card approval">
    <div class="card-icon"><${Icon} name="database" /></div>
    <div class="card-body">
      <strong>${a.who || 'An agent'} wants to write on <span class="mono">${a.conn}</span>${a.database && html` · <span class="mono">${a.database}</span>`}
        ${showChat && a.conv && html` from <a onClick=${() => openChat(a.conv)}>${chatName(a.conv)}</a>`}</strong>
      <pre class="card-text mono">${a.sql}</pre>
      <span class="dim small">Approve runs it now, as written, with writes allowed; the outcome goes back to the chat.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn primary sm" icon="check" onClick=${decide('approve')}>Approve and run<//>
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('reject')}>Reject<//>
      </div>
    </div>
  </div>`;
}

export function ApprovalsView() {
  const list = approvals.value;
  const writes = dbApprovals.value;
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
      <div class="crumbs"><span class="crumb-title">Approvals</span></div>
    </header>
    <div class="thread"><div class="page">
      ${(list.length > 0 || !writes.length) && html`<p class="dim">Chats can message each other through the MCP gateway. Messages that need a human wait here.</p>`}
      ${list.map((a) => html`<${ApprovalCard} key=${a.id} a=${a} showTarget />`)}
      ${writes.length > 0 && html`<p class="dim">Database writes agents asked for on connections set to "write with approval" in the SQL editor.</p>`}
      ${writes.map((a) => html`<${DbApprovalCard} key=${`db${a.id}`} a=${a} showChat />`)}
      ${!list.length && !writes.length && html`<${Empty} icon="inbox" title="Nothing waiting">New requests show up here and in the chat they are meant for.<//>`}
    </div></div>
  </main>`;
}

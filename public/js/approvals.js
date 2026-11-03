// Messages one chat wants to send another (via MCP), database writes agents ask for on "write with approval"
// connections of the SQL editor, commands agents ask for on SSH hosts that need approval, ClickUp messages agents ask to send as the owner, and users' requests to index a project's code graph wait here until a human decides. Shown as cards in the chat concerned and all together
// in the Approvals view.
import { useState } from '../vendor/preact-hooks.js';
import { html } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Empty, Icon } from './ui.js';
import { approvals, clickupApprovals, dbApprovals, findConv, sshApprovals, guarded, indexRequests, openChat, refreshApprovals, toast, toggleSidebar } from './store.js';

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
      ${a.unsafe?.map((u) => html`<div class="sql-warning small"><${Icon} name="triangle-alert" /><span><strong>${u}</strong>: it changes every row of the table.</span></div>`)}
      <pre class="card-text mono">${a.sql}</pre>
      ${a.status !== 'pending' ? html`<p class="sql-warning">${a.status === 'executing'
        ? 'Execution in progress. This request cannot run twice.'
        : a.outcome}</p>
      ${a.status === 'unknown' && html`<span class="dim small">Dismiss closes this request without running it again. Its outcome remains uncertain.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('dismiss')}>Dismiss<//>
      </div>`}` : html`<span class="dim small">Approve backs up the rows it changes, then runs it as written with writes allowed; the outcome goes back to the chat.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn primary sm" icon="check" onClick=${decide('approve')}>Approve and run<//>
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('reject')}>Reject<//>
      </div>`}

    </div>
  </div>`;
}

/** A command an agent wants to run on an SSH host; Approve runs it right away, as the agent wrote it. */
export function SshApprovalCard({ a, showChat }) {
  const decide = (verb) => guarded(async () => {
    const r = await api(`/api/ssh/approvals/${a.id}/${verb}`, { method: 'POST' });
    if (verb === 'approve') toast(r.status === 'approved' ? `Ran it: ${r.outcome.split('\n')[0]}` : `It could not run: ${r.outcome}`, r.status === 'approved' ? 'ok' : 'err');
    await refreshApprovals();
  });
  return html`<div class="card approval">
    <div class="card-icon"><${Icon} name="terminal" /></div>
    <div class="card-body">
      <strong>${a.who || 'An agent'} wants to run a command on <span class="mono">${a.host}</span>${a.sudo && ' as root (sudo)'}
        ${showChat && a.conv && html` from <a onClick=${() => openChat(a.conv)}>${chatName(a.conv)}</a>`}</strong>
      ${a.dangerous?.map((d) => html`<div class="sql-warning small"><${Icon} name="triangle-alert" /><span>Held: <strong>${d}</strong></span></div>`)}
      <pre class="card-text mono">${a.command}</pre>
      ${a.status !== 'pending' ? html`<p class="sql-warning">${a.status === 'executing'
        ? 'Execution in progress. This request cannot run twice.'
        : a.outcome}</p>
      ${a.status === 'unknown' && html`<span class="dim small">Dismiss closes this request without running it again. Its outcome remains uncertain.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('dismiss')}>Dismiss<//>
      </div>`}` : html`<span class="dim small">Approve runs it now, as written (timeout ${Math.round(a.timeoutMs / 1000)} s); its output goes back to the chat.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn primary sm" icon="check" onClick=${decide('approve')}>Approve and run<//>
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('reject')}>Reject<//>
      </div>`}

    </div>
  </div>`;
}

/** Where a ClickUp message goes, in words: workspace, channel or person, and the thread it replies in. */
function ClickUpWhere({ d }) {
  return html`<div class="small">
    <div><span class="dim">Workspace</span> ${d.workspace}</div>
    <div><span class="dim">${d.to_user ? 'Private to' : 'Channel'}</span> <strong>${d.to_user ? d.to_user.name : d.channel}</strong></div>
    ${d.reply_to && html`<div><span class="dim">Reply in thread</span> ${d.thread
      ? html`${d.thread.author}, ${d.thread.date} ${d.thread.time}: <em>${d.thread.preview}</em>`
      : html`<span class="mono">${d.reply_to}</span> (an older message)`}</div>`}
  </div>`;
}

/** A ClickUp message an agent wants to send as the owner; the owner may change the text, then Approve sends it. */
export function ClickUpApprovalCard({ a, showChat }) {
  const [text, setText] = useState(a.content);
  const decide = (verb) => guarded(async () => {
    const r = await api(`/api/clickup/approvals/${a.id}/${verb}`, { method: 'POST', ...(verb === 'approve' && { body: { content: text } }) });
    if (verb === 'approve') toast(r.status === 'sent' ? 'Sent to ClickUp' : `It may not have been sent: ${r.outcome}`, r.status === 'sent' ? 'ok' : 'err');
    await refreshApprovals();
  });
  const pending = a.status === 'pending';
  return html`<div class="card approval">
    <div class="card-icon"><${Icon} name="message-square" /></div>
    <div class="card-body">
      <strong>${a.who || 'An agent'} wants to send a ClickUp message as you
        ${showChat && a.conv && html` from <a onClick=${() => openChat(a.conv)}>${chatName(a.conv)}</a>`}</strong>
      <${ClickUpWhere} d=${a.dest} />
      ${pending
        ? html`<textarea rows="4" value=${text} aria-label="Message text" onInput=${(e) => setText(e.currentTarget.value)}></textarea>`
        : html`<div class="card-text">${a.content}</div>`}
      ${!pending ? html`<p class="sql-warning">${a.status === 'sending' ? 'Sending now. It cannot be sent twice.' : a.outcome}</p>
      ${a.status === 'unknown' && html`<span class="dim small">Dismiss closes this request without sending it again. Check ClickUp for whether it arrived.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('dismiss')}>Dismiss<//>
      </div>`}` : html`<span class="dim small">Approve sends it now as you${text.trim() !== a.content ? ', with your changes' : ''}; others see it at once. The outcome goes back to the chat.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn primary sm" icon="check" disabled=${!text.trim()} onClick=${decide('approve')}>Approve and send<//>
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('reject')}>Reject<//>
      </div>`}
    </div>
  </div>`;
}

/** A user asks to index a project's code graph (code memory); Approve starts the index, which takes the cores a while. */
export function IndexRequestCard({ r }) {
  const decide = (verb) => guarded(async () => {
    await api(`/api/code-memory/requests/${r.id}/${verb}`, { method: 'POST' });
    if (verb === 'approve') toast(`Indexing ${r.projectName}`);
    await refreshApprovals();
  });
  return html`<div class="card approval">
    <div class="card-icon"><${Icon} name="brain" /></div>
    <div class="card-body">
      <strong>${r.who} wants to index the code graph of ${r.projectName}</strong>
      <span class="dim small">Approve starts it now. A first index uses several cores for seconds to minutes; again, it only reads what changed.</span>
      <div class="card-actions">
        <${AsyncButton} class="btn primary sm" icon="check" onClick=${decide('approve')}>Approve and index<//>
        <${AsyncButton} class="btn sm" icon="x" onClick=${decide('reject')}>Reject<//>
      </div>
    </div>
  </div>`;
}

export function ApprovalsView() {
  const list = approvals.value;
  const writes = dbApprovals.value;
  const indexes = indexRequests.value;
  const commands = sshApprovals.value;
  const clickups = clickupApprovals.value;
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
      <div class="crumbs"><span class="crumb-title">Approvals</span></div>
    </header>
    <div class="thread"><div class="page">
      ${(list.length > 0 || (!writes.length && !indexes.length && !commands.length && !clickups.length)) && html`<p class="dim">Chats can message each other through the MCP gateway. Messages that need a human wait here.</p>`}
      ${list.map((a) => html`<${ApprovalCard} key=${a.id} a=${a} showTarget />`)}
      ${writes.length > 0 && html`<p class="dim">Database writes agents asked for on connections set to "write with approval" in the SQL editor.</p>`}
      ${writes.map((a) => html`<${DbApprovalCard} key=${`db${a.id}`} a=${a} showChat />`)}
      ${commands.length > 0 && html`<p class="dim">Commands agents asked to run on SSH hosts set to "every command after approval" (SSH Hosts).</p>`}
      ${commands.map((a) => html`<${SshApprovalCard} key=${`ssh${a.id}`} a=${a} showChat />`)}
      ${clickups.length > 0 && html`<p class="dim">ClickUp messages agents asked to send as you (Settings → MCP → ClickUp, "Allow sending").</p>`}
      ${clickups.map((a) => html`<${ClickUpApprovalCard} key=${`cu${a.id}`} a=${a} showChat />`)}
      ${indexes.length > 0 && html`<p class="dim">Code graphs users asked to index (code memory).</p>`}
      ${indexes.map((r) => html`<${IndexRequestCard} key=${`ix${r.id}`} r=${r} />`)}
      ${!list.length && !writes.length && !indexes.length && !commands.length && !clickups.length && html`<${Empty} icon="inbox" title="Nothing waiting">New requests show up here and in the chat they are meant for.<//>`}
    </div></div>
  </main>`;
}

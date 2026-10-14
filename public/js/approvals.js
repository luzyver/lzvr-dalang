// Sends one chat wants to make into another (via MCP) wait here until a human decides.
import { h } from './dom.js';
import { api } from './api.js';

/** A header badge with the waiting count that opens the list as a page (`openPage`). `refresh` polls the server. */
export function approvals({ guarded, openPage, close }) {
  const box = h('div', { class: 'page-body' });
  const button = h('button', { class: 'badge warn', hidden: true, onclick: () => openPage(box) });

  async function refresh() {
    try {
      const list = await api('/api/approvals');
      const decide = (a, verb) => guarded(async () => { await api(`/api/approvals/${a.id}/${verb}`, { method: 'POST' }); refresh(); });
      button.hidden = !list.length;
      button.textContent = `Approvals (${list.length})`;
      if (!list.length && box.isConnected) close();
      box.replaceChildren(h('strong', {}, 'Approvals'), ...list.map((a) => h('div', { class: 'msg' },
        `Approval needed: chat ${a.from_conv.slice(0, 8)} wants to message chat ${a.to_conv.slice(0, 8)}:\n${a.prompt}`,
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: decide(a, 'approve') }, 'Approve'),
          h('button', { class: 'danger', onclick: decide(a, 'reject') }, 'Reject')))));
    } catch { /* retried on the next tick */ }
  }

  return { button, refresh };
}

// The inspector beside an open chat: Changes, Schedules and Info tabs. A column on wide screens, a drawer on narrower
// ones and a bottom sheet on phones.
import { html, cx } from './lib.js';
import { Icon } from './ui.js';
import { findConv, toggleInspector, ui } from './store.js';
import { chat } from './chat-view.js';
import { ChangesPane } from './git.js';
import { SchedulesPane } from './schedules.js';

function InfoPane({ id }) {
  const c = chat.conv.value;
  chat.version.value; // the account comes from the thread model
  const project = findConv(id)?.project;
  const rows = [
    ['Project', project?.name],
    ['Agent', (c?.backend || project?.backend) === 'claude' ? 'Claude Code' : 'Codex'],
    ['Account', chat.model.account || '—'],
    ['Folder', c?.worktree || project?.path],
    ['Branch', c?.branch && `${c.branch}${c.base_branch ? ` (from ${c.base_branch})` : ''}`],
    ['Sandbox', project?.sandbox],
    ['Model', c?.model || 'default'],
    ['Effort', c?.effort || 'default'],
    ['Session', c?.thread_id],
    ['Chat id', id],
  ].filter(([, v]) => v);
  return html`<dl class="info">${rows.map(([k, v]) => html`<dt>${k}</dt><dd class=${cx(/Folder|Session|Chat id|Branch/.test(k) && 'mono')}>${v}</dd>`)}</dl>`;
}

const TABS = [['changes', 'Changes'], ['schedules', 'Schedules'], ['info', 'Info']];

export function Inspector({ id }) {
  const tab = ui.inspectorTab.value;
  const count = chat.git.value?.files?.length || 0;
  return html`<aside class="inspector" aria-label="Inspector">
    <div class="insp-head">
      <div class="tabs" role="tablist">
        ${TABS.map(([k, label]) => html`<button key=${k} role="tab" aria-selected=${tab === k} class=${cx('tab', tab === k && 'active')} onClick=${() => { ui.inspectorTab.value = k; }}>
          ${label}${k === 'changes' && count > 0 && html`<span class="tab-count">${count}</span>`}</button>`)}
      </div>
      <button class="icon-btn" aria-label="Close inspector" onClick=${() => toggleInspector(false)}><${Icon} name="x" /></button>
    </div>
    <div class="insp-body">
      ${tab === 'changes' && html`<${ChangesPane} id=${id} />`}
      ${tab === 'schedules' && html`<${SchedulesPane} id=${id} />`}
      ${tab === 'info' && html`<${InfoPane} id=${id} />`}
    </div>
  </aside>`;
}

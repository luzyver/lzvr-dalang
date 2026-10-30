// The inspector beside an open chat: Changes, Schedules and Info tabs. A column on wide screens, a drawer on narrower
// ones and a bottom sheet on phones.
import { html, cx } from './lib.js';
import { Icon } from './ui.js';
import { findConv, setInspectorWidth, toggleInspector, ui } from './store.js';
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
    ['Access', project?.access],
    ['Model', c?.model || 'default'],
    ['Effort', c?.effort || 'default'],
    ['Session', c?.thread_id],
    ['Chat id', id],
  ].filter(([, v]) => v);
  return html`<dl class="info">${rows.map(([k, v]) => html`<dt>${k}</dt><dd class=${cx(/Folder|Session|Chat id|Branch/.test(k) && 'mono')}>${v}</dd>`)}</dl>`;
}

const TABS = [['changes', 'Changes'], ['schedules', 'Schedules'], ['info', 'Info']];

/** The inspector's left edge: drag it, or focus it and use the arrow keys, to make the column wider or narrower. */
function ResizeHandle() {
  const drag = (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.documentElement.classList.add('resizing');
    const move = (m) => setInspectorWidth(innerWidth - m.clientX);
    const up = () => {
      el.removeEventListener('pointermove', move);
      document.documentElement.classList.remove('resizing');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up, { once: true });
    el.addEventListener('pointercancel', up, { once: true });
  };
  const key = (e) => {
    const step = e.shiftKey ? 96 : 24;
    if (e.key === 'ArrowLeft') setInspectorWidth(ui.inspectorWidth.value + step);
    else if (e.key === 'ArrowRight') setInspectorWidth(ui.inspectorWidth.value - step);
    else return;
    e.preventDefault();
  };
  return html`<div class="insp-resize" role="separator" aria-orientation="vertical" aria-label="Resize inspector" title="Drag to resize"
    tabindex="0" aria-valuenow=${ui.inspectorWidth.value} onPointerDown=${drag} onKeyDown=${key} onDblClick=${() => setInspectorWidth(480)}></div>`;
}

export function Inspector({ id }) {
  const tab = ui.inspectorTab.value;
  const count = chat.git.value?.files?.length || 0;
  const max = ui.inspectorMax.value;
  return html`<aside class="inspector" aria-label="Inspector">
    ${!max && html`<${ResizeHandle} />`}
    <div class="insp-head">
      <div class="tabs" role="tablist">
        ${TABS.map(([k, label]) => html`<button key=${k} role="tab" aria-selected=${tab === k} class=${cx('tab', tab === k && 'active')} onClick=${() => { ui.inspectorTab.value = k; }}>
          ${label}${k === 'changes' && count > 0 && html`<span class="tab-count">${count}</span>`}</button>`)}
      </div>
      <div class="insp-actions">
        <button class="icon-btn insp-max-btn" aria-label=${max ? 'Restore inspector' : 'Maximize inspector'} title=${max ? 'Restore' : 'Maximize'} aria-pressed=${max}
          onClick=${() => { ui.inspectorMax.value = !max; }}><${Icon} name=${max ? 'minimize-2' : 'maximize-2'} /></button>
        <button class="icon-btn" aria-label="Close inspector" title="Close" onClick=${() => toggleInspector(false)}><${Icon} name="x" /></button>
      </div>
    </div>
    <div class="insp-body">
      ${tab === 'changes' && html`<${ChangesPane} id=${id} />`}
      ${tab === 'schedules' && html`<${SchedulesPane} id=${id} />`}
      ${tab === 'info' && html`<${InfoPane} id=${id} />`}
    </div>
  </aside>`;
}

// Scheduled prompts: a prompt queued into a chat on a cron schedule, as if someone pressed Send at that time.
// The Schedules tab of a chat (its schedules and a form), and the Scheduled view with every schedule.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { signal } from '../vendor/signals.js';
import cronstrue from '../vendor/cronstrue.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Empty, Field, Icon, Spinner, Switch } from './ui.js';
import { guarded, openChat, toast, toggleSidebar } from './store.js';
import { dateTime, until } from './format.js';

const PRESETS = [
  ['0 * * * *', 'Every hour'],
  ['0 9 * * *', 'Every day at 09:00'],
  ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 9 * * 1', 'Mondays at 09:00'],
  ['0 9 1 * *', 'First of the month at 09:00'],
];

/** How many schedules exist, for the sidebar. */
export const scheduleCount = signal(0);
export async function refreshScheduleCount() {
  try { scheduleCount.value = (await api('/api/schedules')).length; } catch { /* shown on the next refresh */ }
}

/** "At 02:00 AM, Monday through Friday", or '' for an expression cronstrue cannot read (the server's check decides). */
export function describeCron(expr) {
  try { return cronstrue.toString(expr, { use24HourTimeFormat: true, verbose: false }); } catch { return ''; }
}

function ScheduleCard({ s, overview, reload }) {
  const toggle = guarded(async (enabled) => { await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled } }); await reload(); });
  const run = guarded(async () => { await api(`/api/schedules/${s.id}/run`, { method: 'POST' }); toast('Queued'); });
  const remove = guarded(async () => {
    if (!confirm('Delete this scheduled prompt?')) return;
    await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
    await reload();
  });
  const human = describeCron(s.cron);
  return html`<div class=${cx('sched', !s.enabled && 'off')}>
    <div class="sched-top">
      ${overview ? html`<a class="sched-chat" onClick=${() => openChat(s.conversation_id)}>${s.project} / ${s.title || 'New chat'}</a>` : html`<span class="sched-when">${human || s.cron}</span>`}
      <${Switch} checked=${s.enabled} title="Run on schedule" onChange=${toggle} />
    </div>
    <div class="sched-prompt">${s.prompt}</div>
    <div class="sched-meta">
      <code>${s.cron}</code>${overview && human && html`<span>${human}</span>`}
      <span>${s.enabled && s.next_run_at ? `next ${dateTime(s.next_run_at)} (in ${until(s.next_run_at)})` : 'off'}</span>
    </div>
    <div class="sched-meta">by ${s.created_by || 'unknown'}${s.last_run_at ? ` · last run ${dateTime(s.last_run_at)}` : ' · not run yet'}</div>
    <div class="row">
      <${AsyncButton} class="btn sm" icon="play" title="Queue the prompt now; the schedule stays as it is" onClick=${run}>Run now<//>
      <div class="spacer"></div>
      <button class="btn ghost danger sm" onClick=${remove}><${Icon} name="trash-2" />Delete</button>
    </div>
  </div>`;
}

function AddSchedule({ convId, onAdded }) {
  const [prompt, setPrompt] = useState('');
  const [cron, setCron] = useState(PRESETS[1][0]);
  const [preview, setPreview] = useState('');
  useEffect(() => {
    const expr = cron.trim();
    if (!expr) { setPreview(''); return undefined; }
    const t = setTimeout(async () => {
      try {
        const r = await api(`/api/schedules/preview?cron=${encodeURIComponent(expr)}`);
        setPreview(`Next: ${r.next.map(dateTime).join(', ')} (server time zone ${r.timeZone})`);
      } catch (e) { setPreview(e.message); }
    }, 300);
    return () => clearTimeout(t);
  }, [cron]);
  const preset = PRESETS.some(([v]) => v === cron.trim()) ? cron.trim() : '';
  const add = guarded(async () => {
    if (!prompt.trim()) throw new Error('Write the prompt to send');
    await api(`/api/conversations/${convId}/schedules`, { method: 'POST', body: { prompt: prompt.trim(), cron: cron.trim() } });
    setPrompt('');
    toast('Schedule added');
    await onAdded();
  });
  const human = describeCron(cron.trim());
  return html`<section class="form-card">
    <strong>New scheduled prompt</strong>
    <${Field} label="Prompt"><textarea rows="3" value=${prompt} onInput=${(e) => setPrompt(e.currentTarget.value)}
      placeholder='e.g. "Run npm audit and summarise anything new"'></textarea><//>
    <div class="row wrap">
      <${Field} label="When"><select value=${preset} onChange=${(e) => { if (e.currentTarget.value) setCron(e.currentTarget.value); }}>
        ${PRESETS.map(([v, l]) => html`<option value=${v}>${l}</option>`)}<option value="">Custom</option></select><//>
      <${Field} label="Cron (minute hour day month weekday)"><input value=${cron} class="mono" onInput=${(e) => setCron(e.currentTarget.value)} /><//>
    </div>
    <div class="field-hint">${human && html`<strong>${human}. </strong>`}${preview}</div>
    <div class="row"><${AsyncButton} class="btn primary" icon="plus" onClick=${add}>Add schedule<//></div>
  </section>`;
}

/** `convId` set: that chat's schedules and the form; unset: every schedule, each linking to its chat. */
function ScheduleList({ convId }) {
  const [items, setItems] = useState(null);
  const load = guarded(async () => {
    setItems(await api(convId ? `/api/conversations/${convId}/schedules` : '/api/schedules'));
    refreshScheduleCount();
  });
  useEffect(() => { setItems(null); load(); }, [convId]);
  return html`
    ${convId && html`<${AddSchedule} convId=${convId} onAdded=${load} />`}
    ${items == null ? html`<div class="pane-loading"><${Spinner} /> Loading…</div>`
      : items.length ? items.map((s) => html`<${ScheduleCard} key=${s.id} s=${s} overview=${!convId} reload=${load} />`)
        : html`<${Empty} icon="clock" title="No scheduled prompts">${convId ? 'Add one above: at each time the prompt is queued into this chat.' : 'Add one from a chat\'s clock button.'}<//>`}`;
}

export const SchedulesPane = ({ id }) => html`<div class="pane-stack">
  <p class="dim small">At each time the prompt is queued into this chat, so its agent continues the same conversation. A run is skipped while the same prompt is still waiting in the queue.</p>
  <${ScheduleList} convId=${id} />
</div>`;

export function SchedulesView() {
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
      <div class="crumbs"><span class="crumb-title">Scheduled prompts</span></div>
    </header>
    <div class="thread"><div class="page"><${ScheduleList} /></div></div>
  </main>`;
}

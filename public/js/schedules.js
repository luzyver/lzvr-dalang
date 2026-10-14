// Scheduled prompts: a prompt queued into a chat on a cron schedule, as if someone pressed Send at that time.
import { h, icon } from './dom.js';
import { api } from './api.js';

const PRESETS = [
  ['0 * * * *', 'Every hour'],
  ['0 9 * * *', 'Every day at 09:00'],
  ['0 9 * * 1-5', 'Weekdays at 09:00'],
  ['0 9 * * 1', 'Mondays at 09:00'],
  ['0 9 1 * *', 'First of the month at 09:00'],
];

const when = (ms) => (ms ? new Date(ms).toLocaleString([], { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) : '');

/**
 * `convId` set: that chat's schedules and a form to add one. Unset: every schedule, each with a link to its chat
 * (`open(convId)`).
 */
export function schedulesPage({ convId, guarded, flash, close, open }) {
  const list = h('div', { class: 'sched-list' }, h('div', { class: 'small' }, 'Loading…'));

  async function load() {
    const items = await api(convId ? `/api/conversations/${convId}/schedules` : '/api/schedules');
    list.replaceChildren(...(items.length ? items.map(row) : [h('div', { class: 'small' }, convId ? 'This chat has no scheduled prompts yet.' : 'No scheduled prompts yet. Add one from a chat\'s clock button.')]));
  }

  function row(s) {
    const toggle = h('input', { type: 'checkbox', checked: s.enabled, onchange: guarded(async () => {
      await api(`/api/schedules/${s.id}`, { method: 'PATCH', body: { enabled: toggle.checked } });
      await load();
    }) });
    return h('div', { class: 'sched' },
      h('div', { class: 'acct-head' },
        h('label', { class: 'switch', title: 'Run on schedule' }, toggle),
        h('code', {}, s.cron),
        h('span', { class: 'small' }, s.enabled && s.next_run_at ? `next ${when(s.next_run_at)}` : 'off'),
        h('span', { class: 'spacer' }),
        !convId && h('button', { onclick: () => open(s.conversation_id) }, `${s.project} / ${s.title || 'New chat'}`),
        h('button', { title: 'Queue the prompt now; the schedule stays as it is', onclick: guarded(async () => {
          await api(`/api/schedules/${s.id}/run`, { method: 'POST' });
          flash('queued');
        }) }, 'Run now'),
        h('button', { class: 'danger', onclick: guarded(async () => {
          if (!confirm('Delete this scheduled prompt?')) return;
          await api(`/api/schedules/${s.id}`, { method: 'DELETE' });
          await load();
        }) }, 'Delete')),
      h('div', { class: 'sched-prompt' }, s.prompt),
      h('div', { class: 'small' }, `by ${s.created_by || 'unknown'}${s.last_run_at ? ` · last run ${when(s.last_run_at)}` : ' · not run yet'}`));
  }

  let form = null;
  if (convId) {
    const prompt = h('textarea', { rows: '3', placeholder: 'Prompt to send, e.g. "Run npm audit and summarise anything new"' });
    const cron = h('input', { value: PRESETS[1][0], placeholder: 'minute hour day month weekday', 'aria-label': 'Cron schedule' });
    const preset = h('select', { 'aria-label': 'Preset' },
      ...PRESETS.map(([v, l]) => h('option', { value: v }, l)), h('option', { value: '' }, 'Custom'));
    preset.value = PRESETS[1][0];
    const preview = h('div', { class: 'small' });
    let previewTimer;
    const showPreview = () => {
      clearTimeout(previewTimer);
      previewTimer = setTimeout(async () => {
        const expr = cron.value.trim();
        if (!expr) { preview.textContent = ''; return; }
        try {
          const r = await api(`/api/schedules/preview?cron=${encodeURIComponent(expr)}`);
          preview.textContent = `Next: ${r.next.map(when).join(', ')} (cron is read in the server's time zone, ${r.timeZone})`;
        } catch (e) { preview.textContent = e.message; }
      }, 300);
    };
    preset.addEventListener('change', () => { if (preset.value) cron.value = preset.value; showPreview(); });
    cron.addEventListener('input', () => { preset.value = PRESETS.some(([v]) => v === cron.value.trim()) ? cron.value.trim() : ''; showPreview(); });
    showPreview();
    const add = guarded(async () => {
      if (!prompt.value.trim()) throw new Error('write the prompt to send');
      await api(`/api/conversations/${convId}/schedules`, { method: 'POST', body: { prompt: prompt.value.trim(), cron: cron.value.trim() } });
      prompt.value = '';
      flash('schedule added');
      await load();
    });
    form = h('div', { class: 'gitbox' },
      h('strong', {}, 'Add a scheduled prompt'),
      prompt,
      h('div', { class: 'row' }, preset, cron),
      preview,
      h('div', { class: 'row' }, h('button', { class: 'primary', onclick: add }, 'Add schedule')));
  }

  guarded(load)();
  return h('div', { class: 'page-body' },
    h('div', { class: 'row githead' }, icon('clock'), h('strong', {}, convId ? 'Scheduled prompts for this chat' : 'Scheduled prompts'),
      h('span', { class: 'spacer' }), h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, icon('x'))),
    h('div', { class: 'small' }, 'At each time the prompt is queued into the chat, so its agent continues the same conversation. A notification comes when the turn ends. A run is skipped while the same prompt is still waiting in the queue.'),
    form, list);
}

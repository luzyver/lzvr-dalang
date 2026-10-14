// An open chat: header (Changes, schedules, status), the live log, and the composer with queue, model and effort.
import { h, icon } from './dom.js';
import { api } from './api.js';
import { startStream, renderEvent } from './chat.js';
import { changesPage } from './git.js';
import { schedulesPage } from './schedules.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/**
 * `lookup(id)` gives `{ project, conv }` from the sidebar's lists; `conv` is updated in place and `onUpdate` called when
 * its status or title changed. `onChange` runs after the Changes page changed files. `focusEvent`: the id of a message to
 * scroll to and mark (from a search result). Returns the nodes for the main area and a function that stops the stream.
 */
export function chatView({ id, focusEvent, lookup, guarded, flash, openPage, close, onChange, onUpdate }) {
  const { project, conv: initial } = lookup(id) || {};
  const chatTitle = h('strong', { class: 'chat-title', title: initial?.title || 'New conversation' }, initial?.title || 'New conversation');
  const chatProject = h('span', { class: 'chat-project' }, project?.name || 'Project');
  const chatState = h('span', { class: `chat-state ${initial?.status || 'idle'}` }, initial?.status || 'idle');
  // What git sees in the folder this chat's agent works in; hidden when that folder is not a repository.
  const changesBtn = h('button', { class: 'changes-btn', hidden: true, title: 'Uncommitted changes: review, commit, revert', onclick: () =>
    openPage(changesPage({ id, guarded, flash, close, onChange })) },
    icon('git-branch'), h('span', {}, initial?.branch || 'Changes'));
  const refreshChanges = async () => {
    const s = await api(`/api/conversations/${id}/git`);
    changesBtn.hidden = !s.repo;
    if (s.repo) changesBtn.lastChild.textContent = `${s.branch || 'HEAD'}${s.files.length ? ` · ${s.files.length} changed` : ''}`;
  };
  const schedulesBtn = h('button', { class: 'iconbtn', title: 'Scheduled prompts for this chat', 'aria-label': 'Scheduled prompts', onclick: () =>
    openPage(schedulesPage({ convId: id, guarded, flash, close })) }, icon('clock'));
  const chatHead = h('div', { class: 'chathead' },
    h('div', { class: 'chat-context' }, chatProject, h('span', { class: 'crumb' }, '/'), chatTitle),
    h('div', { class: 'chat-tools' }, schedulesBtn), changesBtn, chatState);
  const log = h('div', { class: 'log' });
  const queueBox = h('div', { class: 'queue' });
  const text = h('textarea', { placeholder: 'Message Codex…', rows: '1' });
  const files = h('input', { type: 'file', multiple: true });

  // Model and effort: '' follows the global default, which is shown as the first option.
  let modelList = [];
  let currentModel = '';
  let currentEffort = '';
  let globalModel = '';
  let globalEffort = '';
  let backendName = 'Codex';
  const model = h('select', { title: 'Model', onchange: guarded(async () => {
    currentModel = model.value;
    updateEffortOptions();
    await api(`/api/conversations/${id}/model`, { method: 'PUT', body: { model: currentModel } });
    flash(currentModel ? `model: ${currentModel}` : 'using global model default');
  }) });
  const effort = h('select', { title: 'Reasoning effort', onchange: guarded(async () => {
    currentEffort = effort.value;
    await api(`/api/conversations/${id}/effort`, { method: 'PUT', body: { effort: currentEffort } });
    flash(currentEffort ? `effort: ${currentEffort}` : 'effort: default');
  }) });
  function updateModelOptions() {
    const options = [h('option', { value: '' }, globalModel || `${backendName} default`), ...modelList.filter((m) => m.slug !== globalModel).map((m) => h('option', { value: m.slug }, `${m.name} (${m.slug})`))];
    if (currentModel && currentModel !== globalModel && !modelList.some((m) => m.slug === currentModel)) options.push(h('option', { value: currentModel }, currentModel));
    model.replaceChildren(...options);
    model.value = currentModel === globalModel ? '' : currentModel;
  }
  function updateEffortOptions() {
    const supported = modelList.find((m) => m.slug === (model.value || globalModel))?.efforts;
    const choices = (supported?.length ? supported : EFFORTS).filter((v) => v !== globalEffort);
    const selectedEffort = currentEffort === globalEffort ? '' : currentEffort;
    const values = [...new Set(['', ...choices, ...(selectedEffort && !choices.includes(selectedEffort) ? [selectedEffort] : [])])];
    effort.replaceChildren(...values.map((v) => h('option', { value: v }, v || globalEffort || `${backendName} default`)));
    effort.value = selectedEffort;
  }
  updateModelOptions();
  updateEffortOptions();
  api(`/api/conversations/${id}`).then((c) => {
    const claude = c.backend === 'claude';
    backendName = claude ? 'Claude Code' : 'Codex';
    text.placeholder = `Message ${backendName}…`;
    return Promise.all([
      api(`/api/models${claude ? '?backend=claude' : ''}`),
      api(`/api/settings/default-model${claude ? '?backend=claude' : ''}`).catch(() => ({ model: '' })),
      api(`/api/settings/default-effort${claude ? '?backend=claude' : ''}`).catch(() => ({ effort: '' })),
    ]);
  }).then(([list, m, e]) => {
    modelList = list;
    globalModel = m.model;
    globalEffort = e.effort;
    updateModelOptions();
    updateEffortOptions();
  }).catch(() => {});

  async function refreshQueue() {
    const q = await api(`/api/conversations/${id}/queue`);
    queueBox.replaceChildren(...q.map((item) => h('span', { class: 'chip' }, item.prompt.slice(0, 40),
      h('button', { class: 'iconbtn', title: 'Remove from queue', 'aria-label': 'Remove from queue', onclick: guarded(async () => { await api(`/api/queue/${item.id}`, { method: 'DELETE' }); refreshQueue(); }) }, icon('x')))));
  }
  async function refreshConv() {
    const c = await api(`/api/conversations/${id}`);
    currentModel = c.model || '';
    currentEffort = c.effort || '';
    if (document.activeElement !== model) updateModelOptions();
    updateEffortOptions();
    if (!text.value && c.draft) text.value = c.draft;
    const known = lookup(id)?.conv;
    const running = c.status === 'running';
    stop.hidden = !running;
    sendButton.hidden = running;
    const title = c.title || null; // the generated title, or the start of the first prompt until there is one
    chatTitle.textContent = title || 'New conversation';
    chatTitle.title = title || 'New conversation';
    chatState.textContent = c.status;
    chatState.className = `chat-state ${c.status}`;
    if (known && (known.status !== c.status || (title && known.title !== title))) { known.status = c.status; if (title) known.title = title; onUpdate(); }
  }

  const send = guarded(async () => {
    const prompt = text.value.trim();
    if (!prompt) return;
    const attachments = [];
    for (const f of files.files) {
      const form = new FormData();
      form.append('file', f);
      attachments.push((await api('/api/uploads', { method: 'POST', form })).path);
    }
    await api(`/api/conversations/${id}/prompts`, { method: 'POST', body: { prompt, attachments } });
    text.value = '';
    files.value = '';
    await api(`/api/conversations/${id}/draft`, { method: 'PUT', body: { draft: '' } });
    refreshQueue();
  });
  // Desktop: Enter sends, Shift+Enter is a new line. Touch keyboards keep Enter as a new line (the send button sends).
  const mouse = matchMedia('(pointer: fine)');
  text.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.isComposing && (e.ctrlKey || e.metaKey || (mouse.matches && !e.shiftKey))) { e.preventDefault(); send(); } });
  let draftTimer;
  text.addEventListener('input', () => {
    clearTimeout(draftTimer);
    draftTimer = setTimeout(() => api(`/api/conversations/${id}/draft`, { method: 'PUT', body: { draft: text.value } }).catch(() => {}), 800);
  });

  const attachCount = h('span', {});
  files.addEventListener('change', () => { attachCount.textContent = files.files.length ? ` ${files.files.length}` : ''; });
  const settings = h('div', { class: 'settings' },
    h('label', {}, 'Model', model), h('label', {}, 'Effort', effort));
  const initiallyRunning = initial?.status === 'running';
  const stop = h('button', { class: 'stop', hidden: !initiallyRunning, title: 'Stop', 'aria-label': 'Stop', onclick: guarded(async () => {
    const r = await api(`/api/conversations/${id}/cancel`, { method: 'POST' }); flash(r.cancelled ? 'cancelled' : 'nothing running');
  }) }, icon('square'));
  const sendButton = h('button', { class: 'primary send', hidden: initiallyRunning, 'aria-label': 'Send', onclick: send }, icon('arrow-up'));
  const composer = h('div', { class: 'composer' },
    queueBox,
    h('div', { class: 'box' },
      h('div', { class: 'inputrow' },
        h('label', { class: 'iconbtn', title: 'Attach files' }, icon('paperclip'), attachCount, files),
        text,
        stop,
        sendButton),
      settings));

  let pinnedUntil = 0;
  const stopStream = startStream(id, (e) => {
    const el = renderEvent(e);
    if (el) {
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 80;
      log.append(el);
      if (focusEvent && e.id === focusEvent) {
        el.classList.add('hit');
        el.scrollIntoView({ block: 'center' });
        pinnedUntil = Date.now() + 2000; // the rest of the history replays right after: it must not scroll the hit away
      } else if (nearBottom && Date.now() > pinnedUntil) log.scrollTop = log.scrollHeight;
    }
    if (e.type === 'turn.completed' || e.type === 'turn.failed' || e.type === 'turn.status' || e.type === 'process.exit' || e.type === 'user.prompt') {
      refreshQueue().catch(() => {});
      refreshConv().catch(() => {});
    }
    if (e.type === 'turn.status') refreshChanges().catch(() => {});
    if (e.type === 'conversation.title') refreshConv().catch(() => {});
  });
  refreshQueue().catch(() => {});
  refreshConv().catch(() => {});
  refreshChanges().catch(() => {});
  return { nodes: [chatHead, log, composer], stop: stopStream };
}

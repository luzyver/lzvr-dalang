// Admin settings pages: global model/effort defaults and the instructions behind the Changes page's generate buttons.
import { h } from './dom.js';
import { api } from './api.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Global model/effort defaults, one section per backend (a Codex model name means nothing to Claude Code). */
export function defaultsPage({ guarded, flash, close }) {
  const msg = h('div', { class: 'small' });
  const section = (backend, title) => {
    const q = backend === 'claude' ? '?backend=claude' : '';
    const model = h('select');
    const effort = h('select', {}, [['', `${title} default`], ...EFFORTS.map((v) => [v, v])]
      .map(([value, label]) => h('option', { value }, label)));
    let modelList = [];
    let savedModel = '';
    const updateModels = () => {
      const options = [h('option', { value: '' }, `${title} default`), ...modelList.map((m) => h('option', { value: m.slug }, `${m.name} (${m.slug})`))];
      if (savedModel && !modelList.some((m) => m.slug === savedModel)) options.push(h('option', { value: savedModel }, savedModel));
      model.replaceChildren(...options);
      model.value = savedModel;
    };
    Promise.all([api(`/api/settings/default-model${q}`), api(`/api/settings/default-effort${q}`)]).then(([m, e]) => {
      savedModel = m.model;
      effort.value = e.effort;
      updateModels();
    }).catch((e) => { msg.textContent = e.message; });
    api(`/api/models${q}`).then((models) => { modelList = models; updateModels(); }).catch(() => {});
    return {
      el: h('div', { class: 'model-settings' }, h('strong', {}, title), h('label', {}, 'Model', model), h('label', {}, 'Reasoning effort', effort)),
      save: async () => {
        await api('/api/settings/default-model', { method: 'PUT', body: { model: model.value, backend } });
        await api('/api/settings/default-effort', { method: 'PUT', body: { effort: effort.value, backend } });
      },
    };
  };
  const sections = [section('codex', 'Codex'), section('claude', 'Claude Code')];
  const save = guarded(async () => {
    for (const s of sections) await s.save();
    flash('Global model and effort defaults saved');
    close();
  });
  return h('div', { class: 'page-body' },
    h('strong', {}, 'Global defaults'),
    h('div', { class: 'small' }, 'Used when a chat has no model or effort override. Leave a field on its default to let the CLI choose.'),
    ...sections.map((s) => s.el),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save'), h('button', { onclick: close }, 'Cancel')),
    msg);
}

/** The instructions the Changes page's generate buttons give the agent, the same for Codex and Claude Code. Empty = built in. */
export function promptsPage({ guarded, flash, close }) {
  const section = (path, title, help) => {
    const text = h('textarea', { rows: '14', class: 'prompt-edit', placeholder: 'Loading…' });
    let builtIn = '';
    api(`/api/settings/${path}`).then((r) => { builtIn = r.default; text.value = r.prompt || r.default; text.placeholder = ''; })
      .catch((e) => flash(e.message));
    return {
      el: h('div', { class: 'model-settings' }, h('strong', {}, title), h('div', { class: 'small' }, help), text,
        h('div', { class: 'row' }, h('button', { onclick: () => { text.value = builtIn; } }, 'Reset to default'))),
      // Saving the built-in text unchanged stores nothing, so later updates of the default still apply.
      save: () => api(`/api/settings/${path}`, { method: 'PUT', body: { prompt: text.value.trim() === builtIn.trim() ? '' : text.value.trim() } }),
    };
  };
  const sections = [
    section('commit-prompt', 'Commit message', '"Generate message" in Changes. The selected files, their diffs, recent commits and the chat\'s last requests are appended.'),
    section('mr-prompt', 'Merge Request description', '"Generate MR description" for a worktree chat. The branch\'s commits, its diff against the branch it merges into and the chat\'s last requests are appended. A "## Title" line becomes the Merge Request title.'),
  ];
  const save = guarded(async () => {
    for (const s of sections) await s.save();
    flash('prompts saved');
    close();
  });
  return h('div', { class: 'page-body' },
    h('strong', {}, 'Generate prompts'),
    h('div', { class: 'small' }, 'Used by Codex and Claude Code alike, with the chat\'s own model.'),
    ...sections.map((s) => s.el),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: save }, 'Save'), h('button', { onclick: close }, 'Cancel')));
}

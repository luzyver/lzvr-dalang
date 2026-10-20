// Memory: facts kept for later chats, apart from the chats (a deleted chat leaves its memories behind): a project's,
// for every chat of it, and each person's own preferences, for their turns in any project (only they see those).
// The chat header's button opens both: search, add, edit and remove.
// Settings → Project memory (admins): whether each finished turn is mined for them, and with what model.
import { useEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { html } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Empty, Field, Icon, Modal, Seg, Spinner } from './ui.js';
import { guarded, toast } from './store.js';
import { dateTime } from './format.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Where a memory came from, for its card. */
function origin(m) {
  const who = m.created_by === 'agent' ? 'an agent' : m.created_by || null;
  const chat = m.source_title ? `"${m.source_title}"` : null;
  if (chat) return `from chat ${chat}${who && who !== 'an agent' ? ` (${who})` : who ? `, saved by ${who}` : ''}`;
  return who ? `added by ${who}` : '';
}

function MemoryCard({ m, base, reload }) {
  const [text, setText] = useState(null); // the text being edited, or null
  const save = guarded(async () => {
    if (!text.trim()) throw new Error('Write what to remember, or delete it');
    await api(`${base}/${m.id}`, { method: 'PATCH', body: { text } });
    setText(null);
    await reload();
  });
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: 'Forget this?', message: m.text, confirmText: 'Forget', danger: true })) return;
    await api(`${base}/${m.id}`, { method: 'DELETE' });
    await reload();
  });
  return html`<div class="sched">
    ${text == null
      ? html`<div class="sched-prompt">${m.text}</div>`
      : html`<textarea rows="3" value=${text} onInput=${(e) => setText(e.currentTarget.value)} autofocus></textarea>`}
    <div class="sched-meta"><span>${dateTime(m.updated_at)}</span>${origin(m) && html`<span>${origin(m)}</span>`}</div>
    <div class="row">
      ${text == null
        ? html`<button class="btn ghost sm" onClick=${() => setText(m.text)}><${Icon} name="pencil" />Edit</button>`
        : html`<${AsyncButton} class="btn primary sm" onClick=${save}>Save<//><button class="btn ghost sm" onClick=${() => setText(null)}>Cancel</button>`}
      <div class="spacer"></div>
      <button class="btn ghost danger sm" onClick=${remove}><${Icon} name="trash-2" />Forget</button>
    </div>
  </div>`;
}

const KINDS = {
  project: {
    note: 'Facts every chat of this project is shown, whoever runs it. They stay when the chat they came from is deleted. '
      + 'Agents keep them from finished turns and when told to; fix or forget what is wrong.',
    placeholder: 'Something every chat here should know', added: 'Kept in the project memory',
  },
  mine: {
    note: 'Your own preferences, shown to every turn you send, in any project. Only you see them. Agents keep what you ask '
      + 'of them for later ("always...", "never..."); fix or forget what is wrong.',
    placeholder: 'e.g. Answer in Indonesian; never add a Co-Authored-By line', added: 'Kept in your memory',
  },
};

function MemoryDialog({ project, onClose }) {
  const [kind, setKind] = useState('project');
  const base = kind === 'mine' ? '/api/me/memories' : `/api/projects/${project.id}/memories`;
  const k = KINDS[kind];
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [draft, setDraft] = useState('');
  const asked = useRef(0); // the newest search, so an older answer that comes late is dropped
  const load = async (query = q) => {
    const n = ++asked.current;
    try {
      const r = await api(`${base}${query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ''}`);
      if (n === asked.current) setList(r);
    } catch (e) { toast(e.message, 'err'); }
  };
  useEffect(() => { const t = setTimeout(() => load(q), q ? 250 : 0); return () => clearTimeout(t); }, [q, base]);
  const add = guarded(async () => {
    if (!draft.trim()) throw new Error('Write what to remember');
    await api(base, { method: 'POST', body: { text: draft } });
    setDraft('');
    toast(k.added);
    await load();
  });
  return html`<div class="dialog-body stash-dialog">
    <div class="dialog-head"><h2>Memory</h2>
      <${Seg} small label="Whose memory" value=${kind} onChange=${(v) => { setList(null); setKind(v); }}
        options=${[['project', project.name], ['mine', 'Mine']]} />
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <p class="dim small">${k.note}</p>
    <div class="row">
      <input value=${draft} onInput=${(e) => setDraft(e.currentTarget.value)} placeholder=${k.placeholder}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); add(); } }} />
      <${AsyncButton} class="btn primary sm" icon="plus" onClick=${add}>Add<//>
    </div>
    <input type="search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Search the memory" aria-label="Search the memory" />
    <div class="stash-list">
      ${list == null ? html`<div class="dim small"><${Spinner} /> Loading…</div>`
        : !list.length ? html`<${Empty} icon="lightbulb" title=${q ? 'Nothing matches' : 'Nothing kept yet'}>
            ${q ? 'Try other words.' : 'Facts from finished turns show up here, or add one above.'}<//>`
        : html`<span class="dim small">${list.length} ${list.length === 1 ? 'memory' : 'memories'}</span>
          ${list.map((m) => html`<${MemoryCard} key=${`${kind}:${m.id}:${m.updated_at}`} m=${m} base=${base} reload=${() => load()} />`)}`}
    </div>
  </div>`;
}

/** The chat header's button: the project's memory and the caller's own in a dialog. */
export function MemoryButton({ project }) {
  const [open, setOpen] = useState(false);
  if (!project) return null;
  return html`
    <button class="icon-btn" aria-label="Memory" title="Memory: what chats of this project, and your own turns, are shown" onClick=${() => setOpen(true)}>
      <${Icon} name="lightbulb" /></button>
    <${Modal} open=${open} label="Memory" class="history-modal" onClose=${() => setOpen(false)}>
      <${MemoryDialog} project=${project} onClose=${() => setOpen(false)} />
    <//>`;
}

/** One backend's extraction model: the chat's own by default. */
function ModelFor({ backend, title, value, onChange }) {
  const [models, setModels] = useState([]);
  useEffect(() => { api(`/api/models${backend === 'claude' ? '?backend=claude' : ''}`).then(setModels).catch(() => {}); }, []);
  const options = [['', "The chat's own model"], ...models.map((m) => [m.slug, `${m.name} (${m.slug})`])];
  if (value && !models.some((m) => m.slug === value)) options.push([value, value]);
  return html`<${Field} label=${title}><select value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>
    ${options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select><//>`;
}

/** Settings → Project memory, for admins. */
export function MemorySection() {
  const [p, setP] = useState(null);
  useEffect(() => { api('/api/settings/memory').then(setP).catch((e) => toast(e.message, 'err')); }, []);
  const save = guarded(async () => {
    setP(await api('/api/settings/memory', { method: 'PUT', body: { auto: p.auto, user: p.user, effort: p.effort, models: p.models } }));
    toast('Saved: applies from the next finished turn');
  });
  if (p == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const model = (b) => (v) => setP({ ...p, models: { ...p.models, [b]: v } });
  return html`
    <p class="dim">Every project keeps a memory of facts from its chats (decisions, preferences, conventions, how things are
      built and run). Each chat of the project is shown it, on Codex and Claude Code alike, and it stays when the chat it came
      from is deleted. Each person also has their own memory of preferences, shown to the turns they send in any project
      and seen by them alone. People see and change both from a chat's <${Icon} name="lightbulb" /> button; agents with the
      memory_* tools.</p>
    <section class="form-card">
      <strong>Keep facts from every finished turn</strong>
      <span class="dim small">After each finished turn of a person's chat (not sub-agents: their parent's turn counts), one small
        read-only request picks what is worth keeping from what was asked and the final answer. It counts against the
        account's usage. Off: only what agents and people save on purpose is kept.</span>
      <label class="row"><input type="checkbox" checked=${p.auto} onChange=${(e) => setP({ ...p, auto: e.currentTarget.checked })} />
        <span>On</span></label>
      <label class="row"><input type="checkbox" checked=${p.user} disabled=${!p.auto} onChange=${(e) => setP({ ...p, user: e.currentTarget.checked })} />
        <span>Also keep the preferences people give for later ("always...", "never...") in their own memory
          <span class="dim small">(only from what they wrote themselves, never guessed)</span></span></label>
      <div class="row wrap">
        <${ModelFor} backend="codex" title="Codex model" value=${p.models.codex ?? ''} onChange=${model('codex')} />
        <${ModelFor} backend="claude" title="Claude Code model" value=${p.models.claude ?? ''} onChange=${model('claude')} />
        <${Field} label="Reasoning effort"><select value=${p.effort} onChange=${(e) => setP({ ...p, effort: e.currentTarget.value })}>
          <option value="">The chat's own</option>${EFFORTS.map((v) => html`<option value=${v}>${v}</option>`)}</select><//>
      </div>
      <span class="dim small">A small model is enough.</span>
      ${p.serverOff && html`<div class="form-error" role="alert">The server runs with AUTO_MEMORY=0, so nothing is kept from turns whatever is set here.</div>`}
      <div class="row"><${AsyncButton} class="btn primary sm" onClick=${save}>Save<//></div>
    </section>`;
}

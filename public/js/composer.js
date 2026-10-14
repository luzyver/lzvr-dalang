// The composer: prompt box with its draft, attachments, the queue, model and effort, Stop and Send.
import { useEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { Icon } from './ui.js';
import { guarded, toast } from './store.js';
import { chat, refreshQueue } from './chat-view.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** Model and effort for one chat: '' follows the global default, shown as the first option. */
function useModelChoices(id) {
  const [state, setState] = useState({ list: [], globalModel: '', globalEffort: '', backend: 'Codex' });
  useEffect(() => {
    let live = true;
    api(`/api/conversations/${id}`).then((c) => {
      const q = c.backend === 'claude' ? '?backend=claude' : '';
      return Promise.all([
        api(`/api/models${q}`),
        api(`/api/settings/default-model${q}`).catch(() => ({ model: '' })),
        api(`/api/settings/default-effort${q}`).catch(() => ({ effort: '' })),
      ]).then(([list, m, e]) => {
        if (live) setState({ list, globalModel: m.model, globalEffort: e.effort, backend: c.backend === 'claude' ? 'Claude Code' : 'Codex' });
      });
    }).catch(() => {});
    return () => { live = false; };
  }, [id]);
  return state;
}

function ChipSelect({ icon, title, value, options, onChange }) {
  const current = options.find(([v]) => v === value) || options[0];
  return html`<label class="select-chip" title=${title}>
    <${Icon} name=${icon} /><span>${current?.[1]}</span><${Icon} name="chevron-down" class="tiny" />
    <select aria-label=${title} value=${value} onChange=${(e) => onChange(e.currentTarget.value)}>
      ${options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}
    </select>
  </label>`;
}

export function Composer({ id, project }) {
  const conv = chat.conv.value;
  const running = conv?.status === 'running';
  const queue = chat.queue.value;
  const { list, globalModel, globalEffort, backend } = useModelChoices(id);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const box = useRef(null);
  const fileInput = useRef(null);
  const draftTimer = useRef(0);
  const draftLoaded = useRef(false);

  useEffect(() => { setText(''); setFiles([]); draftLoaded.current = false; }, [id]);
  // The saved draft comes with the chat; it only fills an empty box, once.
  useEffect(() => {
    if (conv && conv.id === id && !draftLoaded.current) {
      draftLoaded.current = true;
      if (conv.draft) setText((t) => t || conv.draft);
    }
  }, [conv, id]);

  const saveDraft = (value) => {
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => api(`/api/conversations/${id}/draft`, { method: 'PUT', body: { draft: value } }).catch(() => {}), 800);
  };

  const send = guarded(async () => {
    const prompt = text.trim();
    if (!prompt || sending) return;
    setSending(true);
    try {
      const attachments = [];
      for (const f of files) {
        const form = new FormData();
        form.append('file', f);
        attachments.push((await api('/api/uploads', { method: 'POST', form })).path);
      }
      await api(`/api/conversations/${id}/prompts`, { method: 'POST', body: { prompt, attachments } });
      clearTimeout(draftTimer.current);
      setText('');
      setFiles([]);
      await api(`/api/conversations/${id}/draft`, { method: 'PUT', body: { draft: '' } });
      await refreshQueue(id);
    } finally {
      setSending(false);
      box.current?.focus();
    }
  });

  // Desktop: Enter sends, Shift+Enter is a new line. Touch keyboards keep Enter as a new line (the button sends).
  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.isComposing && (e.ctrlKey || e.metaKey || (matchMedia('(pointer: fine)').matches && !e.shiftKey))) {
      e.preventDefault();
      send();
    }
  };

  const stop = guarded(async () => {
    const r = await api(`/api/conversations/${id}/cancel`, { method: 'POST' });
    toast(r.cancelled ? 'Stopped' : 'Nothing was running');
  });
  const unqueue = (item) => guarded(async () => { await api(`/api/queue/${item.id}`, { method: 'DELETE' }); await refreshQueue(id); });

  const currentModel = conv?.model || '';
  const currentEffort = conv?.effort || '';
  const modelOptions = [['', globalModel || `${backend} default`], ...list.filter((m) => m.slug !== globalModel).map((m) => [m.slug, m.name || m.slug])];
  if (currentModel && currentModel !== globalModel && !list.some((m) => m.slug === currentModel)) modelOptions.push([currentModel, currentModel]);
  const supported = list.find((m) => m.slug === (currentModel || globalModel))?.efforts;
  const effortChoices = (supported?.length ? supported : EFFORTS).filter((v) => v !== globalEffort);
  const effortValue = currentEffort === globalEffort ? '' : currentEffort;
  const effortOptions = [...new Set(['', ...effortChoices, ...(effortValue && !effortChoices.includes(effortValue) ? [effortValue] : [])])]
    .map((v) => [v, v || globalEffort || 'default effort']);

  const setModel = guarded(async (value) => {
    await api(`/api/conversations/${id}/model`, { method: 'PUT', body: { model: value } });
    chat.conv.value = { ...chat.conv.value, model: value };
  });
  const setEffort = guarded(async (value) => {
    await api(`/api/conversations/${id}/effort`, { method: 'PUT', body: { effort: value } });
    chat.conv.value = { ...chat.conv.value, effort: value };
  });

  return html`<div class="composer-wrap">
    ${queue.length > 0 && html`<div class="queue">
      <span class="queue-label">Queued</span>
      ${queue.map((item) => html`<span class="chip" key=${item.id} title=${item.prompt}>
        <span class="chip-text">${item.prompt}</span>
        <button aria-label="Remove from queue" title="Remove from queue" onClick=${unqueue(item)}><${Icon} name="x" /></button>
      </span>`)}
    </div>`}
    <div class=${cx('composer', sending && 'busy')}>
      ${files.length > 0 && html`<div class="attachments">
        ${files.map((f, i) => html`<span class="chip" key=${i}><${Icon} name="paperclip" /><span class="chip-text">${f.name}</span>
          <button aria-label=${`Remove ${f.name}`} onClick=${() => setFiles(files.filter((_, j) => j !== i))}><${Icon} name="x" /></button></span>`)}
      </div>`}
      <textarea ref=${box} rows="1" value=${text} aria-label="Message"
        placeholder=${running ? 'Queue a follow-up…' : `Message ${backend}…`}
        onInput=${(e) => { setText(e.currentTarget.value); saveDraft(e.currentTarget.value); }} onKeyDown=${onKeyDown}></textarea>
      <div class="composer-bar">
        <button class="icon-btn" aria-label="Attach files" title="Attach files" onClick=${() => fileInput.current.click()}><${Icon} name="paperclip" /></button>
        <input ref=${fileInput} type="file" multiple hidden onChange=${(e) => { setFiles([...files, ...e.currentTarget.files]); e.currentTarget.value = ''; }} />
        <${ChipSelect} icon="cpu" title="Model" value=${currentModel === globalModel ? '' : currentModel} options=${modelOptions} onChange=${setModel} />
        <${ChipSelect} icon="brain" title="Reasoning effort" value=${effortValue} options=${effortOptions} onChange=${setEffort} />
        ${project && html`<span class="select-chip static" title="Sandbox of this project"><${Icon} name="shield-check" /><span>${project.sandbox}</span></span>`}
        <div class="spacer"></div>
        ${running && html`<button class="btn sm stop" onClick=${stop} title="Stop the running turn"><${Icon} name="square" />Stop</button>`}
        <button class="send" aria-label=${running ? 'Queue' : 'Send'} title=${running ? 'Queue (runs after this turn)' : 'Send'} disabled=${!text.trim() || sending} onClick=${send}>
          <${Icon} name=${sending ? 'loader-circle' : 'arrow-up'} spin=${sending} />
        </button>
      </div>
    </div>
  </div>`;
}

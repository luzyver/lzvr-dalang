// The composer: prompt box with its draft, attachments, the queue, model and effort, Stop and Send.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { DRIVERS, EngineIcon, Icon } from './ui.js';
import { guarded, toast } from './store.js';
import { chat, refreshQueue } from './chat-view.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];
const BACKEND_OPTIONS = [['claude', 'Claude Code'], ['codex', 'Codex']];

/** Model and effort for one chat on its agent CLI (`backend`): '' follows the global default, shown as the first option. */
function useModelChoices(id, backend) {
  const [state, setState] = useState({ list: [], globalModel: '', globalEffort: '', backend: 'Codex' });
  useEffect(() => {
    if (!backend) return undefined;
    let live = true;
    const q = backend === 'claude' ? '?backend=claude' : '';
    Promise.all([
      api(`/api/models${q}`),
      api(`/api/settings/default-model${q}`).catch(() => ({ model: '' })),
      api(`/api/settings/default-effort${q}`).catch(() => ({ effort: '' })),
    ]).then(([list, m, e]) => {
      if (live) setState({ list, globalModel: m.model, globalEffort: e.effort, backend: backend === 'claude' ? 'Claude Code' : 'Codex' });
    }).catch(() => {});
    return () => { live = false; };
  }, [id, backend]);
  return state;
}

// "@db", "@database" or "@ssh" right before the caret, with what follows it so far ("@db:pro").
const MENTION = /(^|\s)@(database|db|ssh):?([\w.-]*)$/i;
const MENTION_KINDS = {
  db: { url: '/api/db/agent-connections', icon: 'database', label: 'Databases', none: 'No database connection agents may use' },
  ssh: { url: '/api/ssh/agent-hosts', icon: 'terminal', label: 'SSH hosts', none: 'No SSH host agents may use' },
};

/** The @db / @ssh list above the box: the connections and hosts agents may use, inserted as "@db:<id>" / "@ssh:<id>". */
function useMentions(box, setText) {
  const [at, setAt] = useState(null);
  const [lists, setLists] = useState({});
  const [sel, setSel] = useState(0);
  const loading = useRef({});
  const pop = useRef(null);
  // Arrow keys move through a list taller than the popup: keep the chosen one in sight.
  useEffect(() => { pop.current?.querySelector('.menu-item.active')?.scrollIntoView({ block: 'nearest' }); }, [sel, at]);

  const update = (el) => {
    const caret = el.selectionStart;
    const m = el.selectionEnd === caret && el.value.slice(0, caret).match(MENTION);
    if (!m) { setAt(null); return; }
    const kind = m[2].toLowerCase() === 'ssh' ? 'ssh' : 'db';
    setAt({ kind, start: caret - m[0].length + m[1].length, end: caret, filter: m[3].toLowerCase() });
    setSel(0);
    if (!loading.current[kind]) {
      loading.current[kind] = true;
      api(MENTION_KINDS[kind].url).then((l) => setLists((ls) => ({ ...ls, [kind]: l })))
        .catch((e) => { loading.current[kind] = false; toast(e.message, 'err'); });
    }
  };

  const list = at && lists[at.kind];
  const items = (list || []).filter((x) => !at.filter || x.id.includes(at.filter) || x.label.toLowerCase().includes(at.filter));

  const pick = (item) => {
    const el = box.current;
    const ref = `@${at.kind}:${item.id} `;
    const next = el.value.slice(0, at.start) + ref + el.value.slice(at.end);
    setText(next);
    setAt(null);
    const caret = at.start + ref.length;
    requestAnimationFrame(() => { el.focus(); el.setSelectionRange(caret, caret); });
  };

  /** True when the key moved through or picked from the list (the box must not handle it too). */
  const onKey = (e) => {
    if (!at) return false;
    if (e.key === 'Escape') { setAt(null); return true; }
    if (!items.length) return false;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      setSel((i) => (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length);
      return true;
    }
    // Plain Enter or Tab picks; Shift+Enter (new line), Ctrl/Cmd+Enter (send) and Shift+Tab keep their own meaning.
    if ((e.key === 'Enter' || e.key === 'Tab') && !e.isComposing && !e.shiftKey && !e.ctrlKey && !e.metaKey && !e.altKey) { pick(items[Math.min(sel, items.length - 1)]); return true; }
    return false;
  };

  const kind = at && MENTION_KINDS[at.kind];
  const menu = at && html`<div class="mention-pop" ref=${pop} role="listbox" aria-label=${kind.label}>
    <div class="menu-label">${kind.label}</div>
    ${!list ? html`<div class="mention-empty">Loading…</div>`
      : !items.length ? html`<div class="mention-empty">${list.length ? 'No match' : kind.none}</div>`
      : items.map((x, i) => html`<button key=${x.id} type="button" role="option" aria-selected=${i === sel}
          class=${cx('menu-item', i === sel && 'active')} title=${x.note || x.label}
          onMouseDown=${(e) => e.preventDefault()} onMouseEnter=${() => setSel(i)} onClick=${() => pick(x)}>
          ${x.engine ? html`<${EngineIcon} driver=${x.engine} />` : html`<${Icon} name=${kind.icon} />`}<span class="mention-id">${x.id}</span>
          <span class="mention-sub">${[x.label !== x.id && x.label, x.engine && DRIVERS[x.engine], x.note].filter(Boolean).join(' · ')}</span>
        </button>`)}
  </div>`;
  return { update, onKey, menu, close: () => setAt(null) };
}

function ChipSelect({ icon, title, value, options, onChange, disabled = false }) {
  const [pos, setPos] = useState(null);
  const wrap = useRef(null);
  const trigger = useRef(null);
  const menu = useRef(null);
  const current = options.find(([v]) => v === value) || options[0];
  const close = (restore = false) => { setPos(null); if (restore) trigger.current?.focus(); };
  useLayoutEffect(() => {
    if (pos) (menu.current?.querySelector('[aria-checked="true"]') || menu.current?.querySelector('button'))?.focus();
  }, [pos]);
  useEffect(() => { if (disabled) setPos(null); }, [disabled]);
  useEffect(() => {
    if (!pos) return undefined;
    const outside = (e) => { if (!wrap.current?.contains(e.target)) close(); };
    const scroll = (e) => { if (!menu.current?.contains(e.target)) close(); };
    const resize = () => close();
    document.addEventListener('pointerdown', outside);
    addEventListener('scroll', scroll, true);
    addEventListener('resize', resize);
    return () => {
      document.removeEventListener('pointerdown', outside);
      removeEventListener('scroll', scroll, true);
      removeEventListener('resize', resize);
    };
  }, [pos]);
  const open = () => {
    if (disabled) return;
    const r = trigger.current.getBoundingClientRect();
    const width = Math.min(300, innerWidth - 16);
    // Preact 11 leaves numeric style values unitless; these lengths need explicit px.
    setPos({ left: `${Math.max(8, Math.min(r.left, innerWidth - width - 8))}px`, width: `${width}px`,
      maxHeight: `${Math.max(0, Math.min(360, r.top - 16))}px`,
      bottom: `${innerHeight - r.top + 6}px` });
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(e.key)) return;
    e.preventDefault();
    const items = [...menu.current.querySelectorAll('[role="menuitemradio"]')];
    const i = items.indexOf(document.activeElement);
    const next = e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1
      : (i + (e.key === 'ArrowDown' ? 1 : items.length - 1)) % items.length;
    items[next]?.focus();
  };
  return html`<div class="chip-picker" ref=${wrap}
    onBlur=${(e) => { if (!e.currentTarget.contains(e.relatedTarget)) close(); }}>
    <button type="button" ref=${trigger} class=${cx('select-chip', pos && 'open')} title=${title}
      aria-label=${`${title}: ${current?.[1] || ''}`} aria-haspopup="menu" aria-expanded=${!!pos} disabled=${disabled}
      onClick=${() => pos ? close() : open()}
      onKeyDown=${(e) => { if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); open(); } }}>
      <${Icon} name=${icon} /><span>${current?.[1]}</span><${Icon} name="chevron-down" class="tiny" />
    </button>
    ${pos && html`<div ref=${menu} class="menu-pop chip-picker-menu" role="menu" aria-label=${title} style=${pos} onKeyDown=${onKey}>
      <div class="menu-label">${title}</div>
      ${options.map(([v, label]) => html`<button key=${v} type="button" role="menuitemradio" aria-checked=${v === current?.[0]}
        tabIndex="-1" class=${cx('menu-item', v === current?.[0] && 'selected')}
        onClick=${() => { close(true); if (v !== value) onChange(v); }}>
        <span class="picker-option-label">${label}</span>
        ${v === '' && html`<span class="picker-default">Default</span>`}
        <${Icon} name="check" class=${v !== current?.[0] && 'invisible'} />
      </button>`)}
    </div>`}
  </div>`;
}

export function Composer({ id, project }) {
  const conv = chat.conv.value;
  const running = conv?.status === 'running';
  const queue = chat.queue.value;
  const { list, globalModel, globalEffort, backend } = useModelChoices(id, conv?.id === id ? conv.backend : null);
  const [text, setText] = useState('');
  const [files, setFiles] = useState([]);
  const [sending, setSending] = useState(false);
  const box = useRef(null);
  const fileInput = useRef(null);
  const draftTimer = useRef(0);
  const draftLoaded = useRef(false);
  const mention = useMentions(box, (value) => { setText(value); saveDraft(value); });

  useEffect(() => { setText(''); setFiles([]); mention.close(); draftLoaded.current = false; }, [id]);
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
    mention.close();
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

  // Ctrl+V with a screenshot or copied files attaches them; plain text pastes as usual. Screenshots all arrive as
  // "image.png", so they get a unique name.
  const onPaste = (e) => {
    const pasted = [...(e.clipboardData?.files || [])];
    if (!pasted.length) return;
    e.preventDefault();
    const stamp = Date.now();
    setFiles((fs) => [...fs, ...pasted.map((f, i) => (f.name && f.name !== 'image.png' ? f
      : new File([f], `pasted-${stamp}-${i + 1}.${(f.type.split('/')[1] || 'bin').replace('jpeg', 'jpg')}`, { type: f.type })))]);
  };

  // Desktop: Enter sends, Shift+Enter is a new line. Touch keyboards keep Enter as a new line (the button sends).
  const onKeyDown = (e) => {
    if (mention.onKey(e)) { e.preventDefault(); return; }
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
  // Another CLI: a new session there, told the chat so far; model and effort go back to its defaults.
  const setBackend = guarded(async (value) => {
    if (value === conv?.backend) return;
    await api(`/api/conversations/${id}/backend`, { method: 'PUT', body: { backend: value } });
    chat.conv.value = { ...chat.conv.value, backend: value, thread_id: null, model: '', effort: '', context_usage: null };
    toast(`Next turn runs on ${value === 'claude' ? 'Claude Code' : 'Codex'}, in a new session told this chat so far`);
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
      ${mention.menu}
      ${files.length > 0 && html`<div class="attachments">
        ${files.map((f, i) => html`<span class="chip" key=${i}><${Icon} name="paperclip" /><span class="chip-text">${f.name}</span>
          <button aria-label=${`Remove ${f.name}`} onClick=${() => setFiles(files.filter((_, j) => j !== i))}><${Icon} name="x" /></button></span>`)}
      </div>`}
      <textarea ref=${box} rows="1" value=${text} aria-label="Message"
        placeholder=${running ? 'Queue a follow-up…' : `Message ${backend}…`}
        onInput=${(e) => { setText(e.currentTarget.value); saveDraft(e.currentTarget.value); mention.update(e.currentTarget); }}
        onKeyDown=${onKeyDown} onPaste=${onPaste} onBlur=${mention.close}
        onClick=${(e) => mention.update(e.currentTarget)}
        onKeyUp=${(e) => { if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'Home' || e.key === 'End') mention.update(e.currentTarget); }}></textarea>
      <div class="composer-bar">
        <button class="icon-btn" aria-label="Attach files" title="Attach files" onClick=${() => fileInput.current.click()}><${Icon} name="paperclip" /></button>
        <input ref=${fileInput} type="file" multiple hidden onChange=${(e) => { setFiles([...files, ...e.currentTarget.files]); e.currentTarget.value = ''; }} />
        <${ChipSelect} key=${`${id}-agent`} icon=${conv?.backend === 'claude' ? 'asterisk' : 'code-xml'} title=${running ? 'Agent (change it once this turn is done)' : 'Agent'}
          value=${conv?.backend || 'codex'} options=${BACKEND_OPTIONS} disabled=${running} onChange=${setBackend} />
        <${ChipSelect} key=${`${id}-${conv?.backend}-model`} icon="cpu" title="Model" value=${currentModel === globalModel ? '' : currentModel} options=${modelOptions} onChange=${setModel} />
        <${ChipSelect} key=${`${id}-${conv?.backend}-effort`} icon="brain" title="Reasoning effort" value=${effortValue} options=${effortOptions} onChange=${setEffort} />
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

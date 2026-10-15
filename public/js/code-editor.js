// The code editor: a chat's folder in its own browser tab, with the file tree on the left, open files as tabs in the
// middle and terminals below (VS Code's layout, kept as quiet as the rest of the panel). Phones get one pane at a
// time. Saving follows the agent's rules: never in a read-only project, and not while an agent works in the folder.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { batch, signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api, downloadFile } from './api.js';
import { confirmDialog, Empty, Icon, Logo, Seg, Spinner } from './ui.js';
import { guarded, toast } from './store.js';
import { createState, EditorView, loadLanguage, languageOf } from './code-mirror.js';
import { FileTree, QuickOpen, quickOpen, refreshGitMarks, refreshTree, reveal, tree } from './code-files.js';
import { TerminalPanel } from './code-terminal.js';

const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const mobile = () => innerWidth <= 760;
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Open files. A doc: { path, name, kind: 'loading'|'text'|'binary'|'large'|'error', state, lang, saved (the text last
 * read or written), mtime, dirty, changedOnDisk, deletedOnDisk, langName, error }. Docs are mutated in place and
 * `version` goes up when the tabs should re-render.
 */
const ed = {
  convId: null,
  info: signal(null),
  error: signal(null),
  docs: signal([]),
  active: signal(null),
  version: signal(0),
  busy: signal(false),
  cursor: signal({ line: 1, col: 1, sel: 0 }),
  /** phones: which pane shows */
  pane: signal('editor'),
};
/** The one CodeMirror view; switching tabs swaps its state. `view.dalangDoc` is the doc it shows. */
let view = null;

const bump = () => { ed.version.value++; };
const docOf = (path) => ed.docs.value.find((d) => d.path === path);
const activeDoc = () => docOf(ed.active.value);
const stateOf = (doc) => (view?.dalangDoc === doc ? view.state : doc.state);
const readOnly = () => !!ed.info.value?.readOnly;

function persistTabs() {
  if (ed.convId) keep(`dalang-code-tabs:${ed.convId}`, { tabs: ed.docs.value.map((d) => d.path), active: ed.active.value });
}

function onEdit(doc, u) {
  doc.state = u.state;
  const dirty = !u.state.doc.eq(doc.saved);
  if (dirty !== doc.dirty) { doc.dirty = dirty; bump(); }
  if (view?.dalangDoc === doc) {
    const r = u.state.selection.main;
    const line = u.state.doc.lineAt(r.head);
    ed.cursor.value = { line: line.number, col: r.head - line.from + 1, sel: Math.abs(r.to - r.from) };
  }
}

function fill(doc, file) {
  doc.mtime = file.mtime;
  doc.size = file.size;
  if (file.tooLarge) { doc.kind = 'large'; return; }
  if (file.binary) { doc.kind = 'binary'; return; }
  const made = createState(file.content, doc.path, { readOnly: readOnly(), onSave: () => save(doc), onChange: (u) => onEdit(doc, u) });
  Object.assign(doc, { kind: 'text', state: made.state, lang: made.lang, crlf: made.crlf, indent: made.indent, saved: made.state.doc, dirty: false, changedOnDisk: false, deletedOnDisk: false });
  doc.langName = languageOf(doc.path)?.name || 'Plain Text';
  loadLanguage(view, doc, doc.path);
}

export function openFile(path) {
  if (mobile()) ed.pane.value = 'editor';
  if (!docOf(path)) ed.docs.value = [...ed.docs.value, { path, name: nameOf(path), kind: 'loading', lazy: true }];
  activate(path);
  reveal(ed.convId, path);
}

/** Read a tab's file. A tab restored from last time whose file is gone just closes. */
async function load(doc) {
  doc.lazy = false;
  const restored = doc.restored;
  try {
    fill(doc, await api(`/api/conversations/${ed.convId}/fs/file?path=${encodeURIComponent(doc.path)}`));
  } catch (e) {
    if (e.status === 404 && restored) { close(doc, true); return; }
    Object.assign(doc, { kind: 'error', error: e.status === 404 ? 'This file does not exist (any more).' : e.message });
  }
  bump();
  if (ed.active.value === doc.path) show(doc);
}

function activate(path) {
  if (view?.dalangDoc) view.dalangDoc.state = view.state;
  ed.active.value = path;
  persistTabs();
  const doc = docOf(path);
  if (!doc) return;
  tree.selected.value = path;
  if (doc.lazy) load(doc); else show(doc);
}

/** Put the doc into the view (text only) and focus it. */
function show(doc) {
  if (!view || doc.kind !== 'text') return;
  if (view.dalangDoc !== doc) {
    view.setState(doc.state);
    view.dalangDoc = doc;
  }
  const r = doc.state.selection.main;
  const line = doc.state.doc.lineAt(r.head);
  ed.cursor.value = { line: line.number, col: r.head - line.from + 1, sel: Math.abs(r.to - r.from) };
  if (!mobile()) requestAnimationFrame(() => view.focus());
}

async function close(doc, force = false) {
  if (!force && doc.dirty && !await confirmDialog({
    title: `Close ${doc.name}?`, message: 'It has changes that are not saved. Closing it throws them away.', confirmText: 'Discard changes', danger: true,
  })) return;
  const list = ed.docs.value;
  const i = list.indexOf(doc);
  const next = list.filter((d) => d !== doc);
  if (view?.dalangDoc === doc) view.dalangDoc = null;
  batch(() => {
    ed.docs.value = next;
    if (ed.active.value === doc.path) ed.active.value = (next[i] || next[i - 1])?.path ?? null;
  });
  persistTabs();
  const now = activeDoc();
  if (now) show(now);
}

async function save(doc, { force = false } = {}) {
  if (!doc || doc.kind !== 'text' || doc.saving) return;
  const info = ed.info.value;
  if (info?.readOnly) { toast('read-only project: files cannot be changed here', 'err'); return; }
  if (!doc.dirty && !force && !doc.deletedOnDisk) return;
  const state = stateOf(doc);
  doc.saving = true;
  bump();
  try {
    const r = await api(`/api/conversations/${ed.convId}/fs/file`, {
      method: 'PUT', body: { path: doc.path, content: state.sliceDoc(), ...(force ? {} : { mtime: doc.mtime }) },
    });
    doc.mtime = r.mtime;
    doc.saved = state.doc;
    doc.dirty = !stateOf(doc).doc.eq(doc.saved); // typed on while it was saving
    doc.changedOnDisk = false;
    refreshGitMarks(ed.convId);
  } catch (e) {
    if (e.status === 409 && /changed on disk/.test(e.message)) {
      doc.changedOnDisk = true;
      doc.saving = false;
      bump();
      if (await confirmDialog({
        title: `${doc.name} changed on disk`,
        message: 'Something else (the agent, a terminal) changed this file since you opened it. Saving replaces that version with yours.',
        confirmText: 'Overwrite', danger: true,
      })) await save(doc, { force: true });
      return;
    }
    toast(e.status === 404 ? `${doc.path} no longer exists: create it again from the tree to save it` : e.message, 'err');
  } finally {
    doc.saving = false;
    bump();
  }
}

/** Read the file again: the version on disk replaces what the editor has (one undo step). */
async function reload(doc) {
  let file;
  try { file = await api(`/api/conversations/${ed.convId}/fs/file?path=${encodeURIComponent(doc.path)}`); } catch (e) { toast(e.message, 'err'); return; }
  if (file.binary || file.tooLarge) { fill(doc, file); bump(); return; }
  const state = stateOf(doc);
  const text = file.content;
  const spec = { changes: { from: 0, to: state.doc.length, insert: state.toText(text) } };
  if (view?.dalangDoc === doc) { view.dispatch(spec); doc.state = view.state; } else doc.state = state.update(spec).state;
  Object.assign(doc, { saved: doc.state.doc, mtime: file.mtime, dirty: false, changedOnDisk: false, deletedOnDisk: false });
  bump();
}

/** Files changed elsewhere: an unchanged tab follows silently, one with edits gets a banner. */
async function poll() {
  const docs = ed.docs.value.filter((d) => d.kind === 'text' && !d.saving);
  let r;
  try { r = await api(`/api/conversations/${ed.convId}/fs/stat`, { method: 'POST', body: { paths: docs.map((d) => d.path) } }); } catch { return; }
  const wasBusy = ed.busy.value;
  ed.busy.value = r.busy;
  if (wasBusy && !r.busy) { refreshTree(ed.convId); refreshGitMarks(ed.convId); }
  let changed = false;
  for (const d of docs) {
    const m = r.files[d.path];
    if (m === undefined || d.saving) continue;
    if (m === null) { if (!d.deletedOnDisk) { d.deletedOnDisk = true; changed = true; } continue; }
    if (d.deletedOnDisk) { d.deletedOnDisk = false; changed = true; }
    if (m !== d.mtime) {
      if (!d.dirty) await reload(d);
      else if (!d.changedOnDisk) { d.changedOnDisk = true; changed = true; }
    }
  }
  if (changed) bump();
}

// ---------- components ----------

function EditorHost() {
  const host = useRef(null);
  useLayoutEffect(() => {
    view = new EditorView({ parent: host.current });
    const doc = activeDoc();
    if (doc) show(doc);
    return () => { view.destroy(); view = null; };
  }, []);
  return html`<div class="cm-host" ref=${host}></div>`;
}

function Tabs() {
  ed.version.value;
  const docs = ed.docs.value;
  const active = ed.active.value;
  const strip = useRef(null);
  useEffect(() => { strip.current?.querySelector('.editor-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }, [active]);
  if (!docs.length) return null;
  return html`<div class="editor-tabs" role="tablist" ref=${strip}>
    ${docs.map((d) => html`<div key=${d.path} role="tab" aria-selected=${d.path === active} title=${d.path}
      class=${cx('editor-tab', d.path === active && 'active', d.dirty && 'dirty', d.deletedOnDisk && 'gone')}
      onClick=${() => activate(d.path)} onAuxClick=${(e) => { if (e.button === 1) close(d); }}>
      <span class="editor-tab-name">${d.name}</span>
      ${d.saving ? html`<${Spinner} class="tiny" />` : html`<button class="icon-btn xs editor-tab-close" aria-label=${`Close ${d.name}`} title="Close"
        onClick=${(e) => { e.stopPropagation(); close(d); }}><span class="dirty-dot"></span><${Icon} name="x" /></button>`}
    </div>`)}
  </div>`;
}

function Crumbs({ doc }) {
  const parts = doc.path.split('/');
  return html`<div class="editor-crumbs">
    ${parts.map((p, i) => html`${i > 0 && html`<${Icon} name="chevron-right" class="tiny" />`}<span class=${cx(i === parts.length - 1 && 'last')}>${p}</span>`)}
  </div>`;
}

function Banner({ doc }) {
  if (doc.deletedOnDisk) {
    return html`<div class="editor-banner warn"><${Icon} name="triangle-alert" />
      <span>This file was deleted or moved on disk. Saving creates it again.</span>
      <button class="btn sm" onClick=${() => close(doc, true)}>Close tab</button></div>`;
  }
  if (doc.changedOnDisk) {
    return html`<div class="editor-banner warn"><${Icon} name="triangle-alert" />
      <span>The file changed on disk while you were editing it.</span>
      <button class="btn sm" onClick=${() => reload(doc)}>Reload theirs</button>
      <button class="btn sm" onClick=${() => save(doc, { force: true })}>Keep mine</button></div>`;
  }
  return null;
}

function EditorArea() {
  ed.version.value;
  const doc = activeDoc();
  const download = guarded(() => downloadFile(`/api/conversations/${ed.convId}/files/download?path=${encodeURIComponent(doc.path)}`, doc.name));
  const placeholder = !doc ? html`<${Empty} icon="code-xml" title="No file open">
        Pick a file in the tree, or go to one by name.
        <div class="ide-keys">
          <span><kbd>Ctrl</kbd> <kbd>P</kbd> Go to file</span>
          <span><kbd>Ctrl</kbd> <kbd>S</kbd> Save</span>
          <span><kbd>Ctrl</kbd> <kbd>F</kbd> Find</span>
          ${ed.info.value?.terminal && html`<span><kbd>Ctrl</kbd> <kbd>\`</kbd> Terminal</span>`}
        </div>
        <button class="btn sm" onClick=${() => { quickOpen.value = true; }}><${Icon} name="search" />Go to file</button>
      <//>`
    : doc.kind === 'loading' ? html`<div class="editor-loading"><${Spinner} /></div>`
      : doc.kind === 'error' ? html`<${Empty} icon="circle-alert" title="Could not open this file">${doc.error}<//>`
        : doc.kind === 'binary' || doc.kind === 'large' ? html`<${Empty} icon="file" title=${doc.kind === 'binary' ? 'Binary file' : 'File too large to edit'}>
            ${doc.kind === 'binary' ? 'This file is not text, so the editor does not show it.' : 'Files over 5 MB open as a download only.'}
            <button class="btn sm" onClick=${download}><${Icon} name="arrow-down-to-line" />Download</button><//>`
          : null;
  return html`<section class="editor-area" aria-label="Editor">
    <${Tabs} />
    ${doc && html`<${Crumbs} doc=${doc} />`}
    ${doc?.kind === 'text' && html`<${Banner} doc=${doc} />`}
    <div class="editor-body">
      <div class="cm-wrap" hidden=${!doc || doc.kind !== 'text'}><${EditorHost} /></div>
      ${placeholder && html`<div class="editor-placeholder">${placeholder}</div>`}
    </div>
  </section>`;
}

function StatusBar() {
  ed.version.value;
  const info = ed.info.value;
  const doc = activeDoc();
  const c = ed.cursor.value;
  const text = doc?.kind === 'text';
  return html`<footer class="ide-status">
    ${info?.conv.branch && html`<span class="ide-stat" title="Branch of this chat's worktree"><${Icon} name="git-branch" />${info.conv.branch}</span>`}
    ${ed.busy.value && html`<span class="ide-stat warn"><${Spinner} />Agent working · saving paused</span>`}
    ${info?.readOnly && html`<span class="ide-stat"><${Icon} name="shield-alert" />Read-only</span>`}
    <div class="spacer"></div>
    ${text && html`
      <span class="ide-stat">Ln ${c.line}, Col ${c.col}${c.sel ? ` (${c.sel} selected)` : ''}</span>
      <span class="ide-stat hide-mobile">${doc.indent === '\t' ? 'Tabs' : `Spaces: ${doc.indent.length}`}</span>
      <span class="ide-stat hide-mobile">${doc.crlf ? 'CRLF' : 'LF'}</span>
      <span class="ide-stat hide-mobile">UTF-8</span>
      <span class="ide-stat">${doc.langName}</span>
      <span class=${cx('ide-stat', doc.dirty && 'accent')}>${doc.saving ? 'Saving…' : doc.dirty ? 'Unsaved' : 'Saved'}</span>`}
  </footer>`;
}

/** A drag handle between two panes; `onMove(dx, dy)` gets the distance from where the drag started. */
function Resizer({ dir, onMove, onEnd }) {
  const down = (e) => {
    e.preventDefault();
    const x0 = e.clientX;
    const y0 = e.clientY;
    const el = e.currentTarget;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add(dir === 'v' ? 'resizing-v' : 'resizing-h');
    const move = (m) => onMove(m.clientX - x0, m.clientY - y0);
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-v', 'resizing-h');
      onEnd?.();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  return html`<div class=${cx('ide-resize', dir)} role="separator" aria-orientation=${dir === 'v' ? 'vertical' : 'horizontal'} onPointerDown=${down}></div>`;
}

export function CodeEditor({ id }) {
  const info = ed.info.value;
  const [filesShown, setFilesShown] = useState(pref('dalang-code-files', true));
  const [termShown, setTermShown] = useState(pref('dalang-code-term', false));
  const [termMax, setTermMax] = useState(false);
  const [treeW, setTreeW] = useState(pref('dalang-code-tree-w', 260));
  const [termH, setTermH] = useState(pref('dalang-code-term-h', 280));
  const sizes = useRef({ treeW, termH });
  sizes.current = { treeW, termH };
  const start = useRef(null);
  const pane = ed.pane.value;

  // Load the chat's folder, and reopen the files this tab had open last time.
  useEffect(() => {
    ed.convId = id;
    batch(() => { ed.info.value = null; ed.error.value = null; ed.docs.value = []; ed.active.value = null; });
    api(`/api/conversations/${id}/code`).then((i) => {
      batch(() => { ed.info.value = i; ed.busy.value = i.busy; });
      refreshGitMarks(id);
      // Tabs from last time come back; each reads its file when first shown.
      const saved = pref(`dalang-code-tabs:${id}`, null);
      const tabs = Array.isArray(saved?.tabs) ? saved.tabs.filter((p) => typeof p === 'string') : [];
      if (tabs.length) {
        ed.docs.value = tabs.map((p) => ({ path: p, name: nameOf(p), kind: 'loading', lazy: true, restored: true }));
        activate(tabs.includes(saved.active) ? saved.active : tabs[0]);
      } else if (mobile()) ed.pane.value = 'files';
    }, (e) => { ed.error.value = e.status === 404 ? 'This chat no longer exists.' : e.message; });
  }, [id]);

  const doc = activeDoc();

  useEffect(() => {
    const t = info && `${doc ? `${doc.dirty ? '● ' : ''}${doc.name} — ` : ''}${info.conv.title || 'New chat'} · ${info.project.name}`;
    document.title = t ? `${t} · Dalang` : 'Dalang';
  });

  // Watch for changes made outside the editor: open files often, the tree and git marks every third time.
  useEffect(() => {
    if (!info) return undefined;
    let n = 0;
    const tick = () => {
      if (document.hidden) return;
      poll();
      if (++n % 3 === 0) { refreshTree(id); refreshGitMarks(id); }
    };
    const timer = setInterval(tick, 4000);
    const focus = () => { poll(); refreshTree(id); refreshGitMarks(id); };
    addEventListener('focus', focus);
    return () => { clearInterval(timer); removeEventListener('focus', focus); };
  }, [info]);

  const toggleFiles = (v = !filesShown) => { setFilesShown(v); keep('dalang-code-files', v); };
  const toggleTerm = (v = !termShown) => {
    if (!info?.terminal) return;
    if (mobile()) { ed.pane.value = ed.pane.value === 'terminal' ? 'editor' : 'terminal'; return; }
    setTermShown(v);
    keep('dalang-code-term', v);
    if (!v) { setTermMax(false); requestAnimationFrame(() => view?.focus()); }
  };

  useEffect(() => {
    const key = (e) => {
      const mod = e.ctrlKey || e.metaKey;
      if (!mod) return;
      const k = e.key.toLowerCase();
      if (k === 'p' && !e.shiftKey) { e.preventDefault(); quickOpen.value = true; }
      else if (k === 's') { e.preventDefault(); save(activeDoc()); }
      else if (k === 'b' && !e.shiftKey && !e.target.closest?.('.term-panel')) { e.preventDefault(); toggleFiles(); }
      else if (e.code === 'Backquote') { e.preventDefault(); toggleTerm(); }
    };
    const leave = (e) => { if (ed.docs.value.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('keydown', key);
    addEventListener('beforeunload', leave);
    return () => { removeEventListener('keydown', key); removeEventListener('beforeunload', leave); };
  });

  const onRenamed = (from, to) => {
    for (const d of ed.docs.value) {
      if (d.path === from || d.path.startsWith(`${from}/`)) {
        const wasActive = ed.active.value === d.path;
        d.path = to + d.path.slice(from.length);
        d.name = nameOf(d.path);
        if (wasActive) ed.active.value = d.path;
      }
    }
    bump();
    persistTabs();
  };
  const onDeleted = (path) => {
    for (const d of [...ed.docs.value]) {
      if (d.path !== path && !d.path.startsWith(`${path}/`)) continue;
      if (d.dirty) d.deletedOnDisk = true; else close(d, true);
    }
    bump();
  };

  if (ed.error.value) {
    return html`<div class="ide-error"><${Empty} icon="circle-alert" title="The code editor cannot open">${ed.error.value}
      <a class="btn sm" href="/">Back to Dalang</a><//></div>`;
  }
  if (!info) return html`<div class="ide-error"><${Spinner} /></div>`;

  const canWrite = !info.readOnly && !ed.busy.value;
  const writeBlocked = info.readOnly ? 'read-only project: files cannot be changed here'
    : 'an agent is working in this folder: wait for its turn to finish or stop it';
  const panes = [['files', 'Files', 'folder'], ['editor', 'Editor', 'code-xml'], ...(info.terminal ? [['terminal', 'Terminal', 'terminal']] : [])];
  return html`<div class=${cx('ide', !filesShown && 'no-files', !termShown && 'no-term', termMax && 'term-max')} data-pane=${pane}
    style=${{ '--tree-w': `${treeW}px`, '--term-h': `${termH}px` }}>
    <header class="ide-head">
      <a class="ide-brand" href=${`/#c=${encodeURIComponent(id)}`} title="Back to the chat" aria-label="Back to the chat"><${Logo} size=${22} /></a>
      <div class="crumbs">
        <span class="crumb-project">${info.project.name}</span>
        <${Icon} name="chevron-right" class="tiny dim crumb-sep" />
        <span class="crumb-title" title=${info.conv.title || 'New chat'}>${info.conv.title || 'New chat'}</span>
      </div>
      ${info.conv.worktree && html`<span class="ide-chip" title="This chat works in its own worktree"><${Icon} name="git-branch" />${info.conv.branch}</span>`}
      <div class="spacer"></div>
      <button class="ide-search" onClick=${() => { quickOpen.value = true; }} title="Go to file (Ctrl+P)">
        <${Icon} name="search" /><span>Go to file</span><kbd class="hide-mobile">Ctrl P</kbd></button>
      <button class=${cx('icon-btn hide-mobile', filesShown && 'on')} aria-pressed=${filesShown} aria-label="Files" title="Files (Ctrl+B)" onClick=${() => toggleFiles()}><${Icon} name="panel-left" /></button>
      ${info.terminal && html`<button class=${cx('icon-btn hide-mobile', termShown && 'on')} aria-pressed=${termShown} aria-label="Terminal" title="Terminal (Ctrl+\`)" onClick=${() => toggleTerm()}><${Icon} name="panel-bottom" /></button>`}
    </header>
    <div class="ide-body">
      <div class="ide-files">
        <${FileTree} convId=${id} rootName=${info.root} canWrite=${canWrite} writeBlocked=${writeBlocked}
          onOpen=${openFile} onRenamed=${onRenamed} onDeleted=${onDeleted} />
      </div>
      <${Resizer} dir="v" onMove=${(dx) => {
        start.current ??= sizes.current.treeW;
        setTreeW(Math.min(Math.max(start.current + dx, 160), Math.min(640, innerWidth - 320)));
      }} onEnd=${() => { start.current = null; keep('dalang-code-tree-w', sizes.current.treeW); }} />
      <div class="ide-main">
        <${EditorArea} />
        ${info.terminal && html`
          <${Resizer} dir="h" onMove=${(_dx, dy) => {
            start.current ??= sizes.current.termH;
            setTermH(Math.min(Math.max(start.current - dy, 120), innerHeight - 200));
          }} onEnd=${() => { start.current = null; keep('dalang-code-term-h', sizes.current.termH); }} />
          <div class="ide-term"><${TerminalPanel} convId=${id} shown=${termShown || pane === 'terminal'} maximized=${termMax}
            onMaximize=${() => setTermMax(!termMax)} onHide=${() => toggleTerm(false)} /></div>`}
      </div>
    </div>
    <${StatusBar} />
    <nav class="ide-nav"><${Seg} value=${pane} label="Pane" options=${panes} onChange=${(v) => { ed.pane.value = v; }} /></nav>
    <${QuickOpen} convId=${id} onOpen=${openFile} />
  </div>`;
}

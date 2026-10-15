// The code editor: a chat's folder in its own browser tab, with the file tree (or Search) on the left, open files as
// tabs in the middle and terminals below (VS Code's layout and keys, kept as quiet as the rest of the panel). Phones
// get one pane at a time. Saving follows the agent's rules: never in a read-only project, and not while an agent works
// in the folder.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { batch, signal } from '../vendor/signals.js';
import * as cm from '../vendor/code/editor.js';
import { html, cx } from './lib.js';
import { api, downloadFile } from './api.js';
import { confirmDialog, Empty, Icon, Logo, Seg, Spinner } from './ui.js';
import { guarded, toast } from './store.js';
import { theme } from './theme.js';
import { copyText } from './code.js';
import { createState, EditorView, loadLanguage, languageOf, openSearchPanel, symbolsOf, wrapOn, wrapping } from './code-mirror.js';
import { beginNew, FileTree, refreshGitMarks, refreshTree, reveal, tree } from './code-files.js';
import { Keys, openPalette, Palette } from './code-palette.js';
import { search, SearchView } from './code-search.js';
import { focusTerminal, newTerminal, setTerminalFontSize, TerminalPanel } from './code-terminal.js';

const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const mobile = () => innerWidth <= 760;
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);

/**
 * Open files. A doc: { path, name, kind: 'loading'|'text'|'binary'|'large'|'error', state, lang, saved (the text last
 * read or written), mtime, dirty, changedOnDisk, deletedOnDisk, langName, error, reveal }. Docs are mutated in place
 * and `version` goes up when the tabs should re-render.
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
  /** the first key of a chord (Ctrl+K) while the second is awaited */
  chord: signal(null),
};
/** The one CodeMirror view; switching tabs swaps its state. `view.dalangDoc` is the doc it shows. */
let view = null;
/** Closed tabs, most recent last, for "Reopen Closed Editor". */
const closed = [];

const bump = () => { ed.version.value++; };
const docOf = (path) => ed.docs.value.find((d) => d.path === path);
const activeDoc = () => docOf(ed.active.value);
const stateOf = (doc) => (view?.dalangDoc === doc ? view.state : doc.state);
const readOnly = () => !!ed.info.value?.readOnly;
const textDoc = () => (view && activeDoc()?.kind === 'text' ? activeDoc() : null);

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

// VS Code's meaning for keys CodeMirror binds otherwise: Ctrl+G goes to a line.
const PRIORITY_KEYS = [{ key: 'Mod-g', preventDefault: true, run: () => { openPalette(':'); return true; } }];

function fill(doc, file) {
  doc.mtime = file.mtime;
  doc.size = file.size;
  if (file.tooLarge) { doc.kind = 'large'; return; }
  if (file.binary) { doc.kind = 'binary'; return; }
  const made = createState(file.content, doc.path, { readOnly: readOnly(), onSave: () => save(doc), onChange: (u) => onEdit(doc, u), keys: PRIORITY_KEYS });
  Object.assign(doc, { kind: 'text', state: made.state, lang: made.lang, crlf: made.crlf, indent: made.indent, saved: made.state.doc, dirty: false, changedOnDisk: false, deletedOnDisk: false });
  doc.langName = languageOf(doc.path)?.name || 'Plain Text';
  loadLanguage(view, doc, doc.path);
}

/** Open a file in a tab (or show its tab); `at` ({ line, col, len } or { pos, len }) selects a place in it. */
export function openFile(path, at) {
  if (mobile()) ed.pane.value = 'editor';
  if (!docOf(path)) ed.docs.value = [...ed.docs.value, { path, name: nameOf(path), kind: 'loading', lazy: true }];
  if (at) docOf(path).reveal = at;
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

/** Select a place in the shown file and scroll it to the middle. */
function revealAt(at) {
  if (!view) return;
  const doc = view.state.doc;
  let pos = at.pos;
  if (pos == null) {
    const line = doc.line(Math.min(Math.max(at.line, 1), doc.lines));
    pos = line.from + Math.min(Math.max((at.col || 1) - 1, 0), line.length);
  }
  pos = Math.min(pos, doc.length);
  const head = Math.min(pos + (at.len || 0), doc.length);
  view.dispatch({ selection: { anchor: pos, head }, effects: EditorView.scrollIntoView(pos, { y: 'center' }) });
  if (view.dalangDoc) view.dalangDoc.state = view.state;
  view.focus();
}

/** Put the doc into the view (text only) and focus it. */
function show(doc) {
  if (!view || doc.kind !== 'text') return;
  if (view.dalangDoc !== doc) {
    view.setState(doc.state);
    view.dalangDoc = doc;
  }
  if (doc.reveal) {
    const at = doc.reveal;
    doc.reveal = null;
    requestAnimationFrame(() => { if (view?.dalangDoc === doc) revealAt(at); });
  }
  const r = doc.state.selection.main;
  const line = doc.state.doc.lineAt(r.head);
  ed.cursor.value = { line: line.number, col: r.head - line.from + 1, sel: Math.abs(r.to - r.from) };
  if (!mobile()) requestAnimationFrame(() => view?.focus());
}

async function close(doc, force = false) {
  if (!doc) return false;
  if (!force && doc.dirty && !await confirmDialog({
    title: `Close ${doc.name}?`, message: 'It has changes that are not saved. Closing it throws them away.', confirmText: 'Discard changes', danger: true,
  })) return false;
  const list = ed.docs.value;
  const i = list.indexOf(doc);
  const next = list.filter((d) => d !== doc);
  if (view?.dalangDoc === doc) view.dalangDoc = null;
  closed.push(doc.path);
  if (closed.length > 30) closed.shift();
  batch(() => {
    ed.docs.value = next;
    if (ed.active.value === doc.path) ed.active.value = (next[i] || next[i - 1])?.path ?? null;
  });
  persistTabs();
  const now = activeDoc();
  if (now) { if (now.lazy) load(now); else show(now); }
  return true;
}

/** Close several tabs; with unsaved changes among them, ask once. */
async function closeMany(docs) {
  const dirty = docs.filter((d) => d.dirty);
  if (dirty.length && !await confirmDialog({
    title: `Close ${docs.length} ${docs.length === 1 ? 'tab' : 'tabs'}?`,
    message: `${dirty.map((d) => d.name).join(', ')} ${dirty.length === 1 ? 'has' : 'have'} changes that are not saved. Closing throws them away.`,
    confirmText: 'Discard changes', danger: true,
  })) return;
  for (const d of docs) await close(d, true);
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

async function saveAll() {
  const dirty = ed.docs.value.filter((d) => d.dirty);
  if (!dirty.length) { toast('nothing to save'); return; }
  for (const d of dirty) await save(d);
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

/** Word wrap on or off for every open file. */
function setWrap(on) {
  wrapOn.value = on;
  keep('dalang-code-wrap', on);
  const effects = wrapping.reconfigure(on ? EditorView.lineWrapping : []);
  for (const d of ed.docs.value) {
    if (d.kind !== 'text') continue;
    if (view?.dalangDoc === d) { view.dispatch({ effects }); d.state = view.state; } else d.state = d.state.update({ effects }).state;
  }
  bump();
}

// ---------- keys ----------

/** A key press as written in the command list: 'Ctrl+Shift+P', 'Alt+W', 'Ctrl+Alt+Left', 'Ctrl+`'. */
function comboOf(e) {
  const c = e.code;
  if (/^(Control|Shift|Alt|Meta|OS)/.test(c) || /^(Control|Shift|Alt|Meta)$/.test(e.key)) return null;
  const key = c.startsWith('Key') ? c.slice(3) : c.startsWith('Digit') ? c.slice(5) : c.startsWith('Arrow') ? c.slice(5)
    : c.startsWith('Numpad') && /\d$/.test(c) ? c.slice(-1)
      : { Backquote: '`', Equal: '=', Minus: '-', NumpadAdd: '=', NumpadSubtract: '-', BracketLeft: '[', BracketRight: ']',
        Backslash: '\\', Slash: '/', Period: '.', Comma: ',', Semicolon: ';', Quote: "'", Space: 'Space', NumpadEnter: 'Enter' }[c]
      || (e.key.length === 1 ? e.key.toUpperCase() : e.key);
  return [(e.ctrlKey || e.metaKey) && 'Ctrl', e.shiftKey && 'Shift', e.altKey && 'Alt', key].filter(Boolean).join('+');
}

/** Where the keyboard is: in a terminal, in a text field (not the editor's own search box), or elsewhere. */
const focusIn = (e) => (e.target.closest?.('.term-panel') ? 'terminal'
  : e.target.closest?.('input, textarea, select') && !e.target.closest('.cm-editor') ? 'field' : 'page');

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
      ${d.saving ? html`<${Spinner} class="tiny" />` : html`<button class="icon-btn xs editor-tab-close" aria-label=${`Close ${d.name}`} title="Close (Alt+W)"
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
          <span><${Keys} keys="Ctrl+P" /> Go to file</span>
          <span><${Keys} keys="Ctrl+Shift+P" /> All commands</span>
          <span><${Keys} keys="Ctrl+Shift+F" /> Search in files</span>
          ${ed.info.value?.terminal && html`<span><${Keys} keys="Ctrl+\`" /> Terminal</span>`}
        </div>
        <button class="btn sm" onClick=${() => openPalette('')}><${Icon} name="search" />Go to file</button>
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
    ${ed.chord.value && html`<span class="ide-stat accent">(${ed.chord.value}) was pressed. Waiting for the second key…</span>`}
    <div class="spacer"></div>
    ${text && html`
      <button class="ide-stat" title="Go to line (Ctrl+G)" onClick=${() => openPalette(':')}>Ln ${c.line}, Col ${c.col}${c.sel ? ` (${c.sel} selected)` : ''}</button>
      <span class="ide-stat hide-mobile">${doc.indent === '\t' ? 'Tabs' : `Spaces: ${doc.indent.length}`}</span>
      <span class="ide-stat hide-mobile">${doc.crlf ? 'CRLF' : 'LF'}</span>
      <span class="ide-stat hide-mobile">UTF-8</span>
      <button class="ide-stat hide-mobile" title="Toggle word wrap (Alt+Z)" onClick=${() => setWrap(!wrapOn.value)}>${wrapOn.value ? 'Wrap' : 'No wrap'}</button>
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
  const [side, setSide] = useState('files');
  const [termShown, setTermShown] = useState(pref('dalang-code-term', false));
  const [termMax, setTermMax] = useState(false);
  const [treeW, setTreeW] = useState(pref('dalang-code-tree-w', 260));
  const [termH, setTermH] = useState(pref('dalang-code-term-h', 280));
  const [fontPx, setFontPx] = useState(pref('dalang-code-fs', 13));
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

  // The editor's zoom: CodeMirror reads --code-fs, the terminals get the size directly.
  useEffect(() => {
    setTerminalFontSize(fontPx);
    requestAnimationFrame(() => view?.requestMeasure());
  }, [fontPx]);

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
    if (v) focusTerminal();
    else { setTermMax(false); requestAnimationFrame(() => view?.focus()); }
  };
  const showSide = (which) => {
    setSide(which);
    if (mobile()) ed.pane.value = 'files';
    else toggleFiles(true);
  };
  const zoom = (px) => { const v = Math.min(Math.max(px, 9), 28); setFontPx(v); keep('dalang-code-fs', v); };

  const canWrite = !!info && !info.readOnly && !ed.busy.value;
  const writeBlocked = info?.readOnly ? 'read-only project: files cannot be changed here'
    : 'an agent is working in this folder: wait for its turn to finish or stop it';

  /** Run a CodeMirror command on the open file, with the keyboard in it. */
  const inEditor = (command) => () => {
    if (!textDoc()) return;
    view.focus();
    command(view);
  };
  const tabStep = (step) => {
    const list = ed.docs.value;
    if (list.length < 2) return;
    const i = list.findIndex((d) => d.path === ed.active.value);
    activate(list[(i + step + list.length) % list.length].path);
  };
  const findInFiles = (replace) => {
    const sel = textDoc() && view.state.sliceDoc(view.state.selection.main.from, view.state.selection.main.to);
    if (sel && !sel.includes('\n')) search.query.value = sel;
    if (replace) search.showReplace.value = true;
    showSide('search');
    search.focus.value++;
  };

  /**
   * Everything the palette (Ctrl+Shift+P) lists, with VS Code's keys. `scope`: 'any' works even in a terminal or a
   * text field, 'page' everywhere but a terminal, 'editor' needs an open text file. Keys the editor handles itself
   * while it has the focus (Ctrl+D, Alt+↑ ...) run here when the focus is elsewhere.
   */
  const commands = [
    { id: 'quickOpen', title: 'Go to File…', keys: 'Ctrl+P', scope: 'any', run: () => openPalette('') },
    { id: 'commands', title: 'Show All Commands', keys: 'Ctrl+Shift+P', scope: 'any', run: () => openPalette('>') },
    { id: 'symbol', title: 'Go to Symbol in Editor…', keys: 'Ctrl+Shift+O', run: () => openPalette('@') },
    { id: 'line', title: 'Go to Line/Column…', keys: 'Ctrl+G', run: () => openPalette(':') },
    { id: 'save', title: 'File: Save', keys: 'Ctrl+S', scope: 'any', run: () => save(activeDoc()) },
    { id: 'saveAll', title: 'File: Save All', keys: 'Ctrl+K S', run: saveAll },
    { id: 'newFile', title: 'File: New File…', keys: 'Alt+N', run: () => { if (!canWrite) { toast(writeBlocked, 'err'); return; } showSide('files'); beginNew(id, 'file'); } },
    { id: 'newFolder', title: 'File: New Folder…', run: () => { if (!canWrite) { toast(writeBlocked, 'err'); return; } showSide('files'); beginNew(id, 'folder'); } },
    { id: 'revert', title: 'File: Revert File (reload from disk)', run: () => { const d = textDoc(); if (d) reload(d); } },
    { id: 'copyPath', title: 'File: Copy Path of Active File', keys: 'Shift+Alt+C', run: () => { const d = activeDoc(); if (d) copyText(d.path, 'path copied'); } },
    { id: 'reveal', title: 'File: Reveal Active File in Explorer', run: () => { const d = activeDoc(); if (d) { showSide('files'); reveal(id, d.path); } } },
    { id: 'download', title: 'File: Download Active File', run: () => { const d = activeDoc(); if (d) downloadFile(`/api/conversations/${id}/files/download?path=${encodeURIComponent(d.path)}`, d.name).catch((e) => toast(e.message, 'err')); } },
    { id: 'close', title: 'View: Close Editor', keys: 'Alt+W', run: () => close(activeDoc()) },
    { id: 'closeAll', title: 'View: Close All Editors', keys: 'Ctrl+K W', run: () => closeMany([...ed.docs.value]) },
    { id: 'closeSaved', title: 'View: Close Saved Editors', keys: 'Ctrl+K U', run: () => closeMany(ed.docs.value.filter((d) => !d.dirty)) },
    { id: 'closeOthers', title: 'View: Close Other Editors', run: () => closeMany(ed.docs.value.filter((d) => d.path !== ed.active.value)) },
    { id: 'reopen', title: 'View: Reopen Closed Editor', keys: 'Shift+Alt+T', run: () => { const p = closed.pop(); if (p) openFile(p); } },
    { id: 'nextTab', title: 'View: Open Next Editor', keys: 'Ctrl+Alt+Right', run: () => tabStep(1) },
    { id: 'prevTab', title: 'View: Open Previous Editor', keys: 'Ctrl+Alt+Left', run: () => tabStep(-1) },
    ...[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => ({ id: `tab${n}`, title: `View: Open Editor ${n}`, keys: `Alt+${n}`, hidden: true,
      run: () => { const d = n === 9 ? ed.docs.value.at(-1) : ed.docs.value[n - 1]; if (d) activate(d.path); } })),
    { id: 'sidebar', title: 'View: Toggle Side Bar', keys: 'Ctrl+B', run: () => toggleFiles() },
    { id: 'explorer', title: 'View: Show Explorer', keys: 'Ctrl+Shift+E', scope: 'any', run: () => {
      showSide('files');
      requestAnimationFrame(() => document.querySelector('.tree .tree-row.selected, .tree .tree-row')?.focus());
    } },
    { id: 'find', title: 'Find', keys: 'Ctrl+F', scope: 'editor', run: inEditor(openSearchPanel) },
    { id: 'replace', title: 'Replace', keys: 'Ctrl+H', scope: 'editor', run: inEditor(openSearchPanel) },
    { id: 'findNext', title: 'Find Next', keys: 'F3', scope: 'editor', run: inEditor(cm.findNext) },
    { id: 'findPrev', title: 'Find Previous', keys: 'Shift+F3', scope: 'editor', run: inEditor(cm.findPrevious) },
    { id: 'findInFiles', title: 'Search: Find in Files', keys: 'Ctrl+Shift+F', scope: 'any', run: () => findInFiles(false) },
    { id: 'replaceInFiles', title: 'Search: Replace in Files', keys: 'Ctrl+Shift+H', scope: 'any', run: () => findInFiles(true) },
    ...(info?.terminal ? [
      { id: 'terminal', title: 'View: Toggle Terminal', keys: 'Ctrl+`', scope: 'any', run: () => toggleTerm() },
      { id: 'newTerminal', title: 'Terminal: Create New Terminal', keys: 'Ctrl+Shift+`', scope: 'any', run: () => {
        if (mobile()) ed.pane.value = 'terminal'; else if (!termShown) toggleTerm(true);
        newTerminal(id).then(() => focusTerminal());
      } },
      { id: 'termMax', title: 'Terminal: Toggle Maximized Panel', run: () => { if (!termShown) toggleTerm(true); setTermMax(!termMax); } },
    ] : []),
    { id: 'wrap', title: 'View: Toggle Word Wrap', keys: 'Alt+Z', run: () => setWrap(!wrapOn.value) },
    { id: 'zoomIn', title: 'View: Zoom In (editor and terminal)', keys: 'Ctrl+=', scope: 'any', run: () => zoom(fontPx + 1) },
    { id: 'zoomOut', title: 'View: Zoom Out (editor and terminal)', keys: 'Ctrl+-', scope: 'any', run: () => zoom(fontPx - 1) },
    { id: 'zoomReset', title: 'View: Reset Zoom', keys: 'Ctrl+0', scope: 'any', run: () => zoom(13) },
    { id: 'theme', title: 'Preferences: Toggle Light/Dark Theme', run: () => { theme.value = document.documentElement.dataset.mode === 'dark' ? 'light' : 'dark'; } },
    { id: 'nextMatch', title: 'Add Selection to Next Find Match', keys: 'Ctrl+D', scope: 'editor', run: inEditor(cm.selectNextOccurrence) },
    { id: 'allMatches', title: 'Select All Occurrences of Find Match', keys: 'Ctrl+Shift+L', scope: 'editor', run: inEditor(cm.selectSelectionMatches) },
    { id: 'cursorAbove', title: 'Add Cursor Above', keys: 'Ctrl+Alt+Up', scope: 'editor', run: inEditor(cm.addCursorAbove) },
    { id: 'cursorBelow', title: 'Add Cursor Below', keys: 'Ctrl+Alt+Down', scope: 'editor', run: inEditor(cm.addCursorBelow) },
    { id: 'cursorUndo', title: 'Cursor Undo', keys: 'Ctrl+U', scope: 'editor', run: inEditor(cm.undoSelection) },
    { id: 'lineUp', title: 'Move Line Up', keys: 'Alt+Up', scope: 'editor', run: inEditor(cm.moveLineUp) },
    { id: 'lineDown', title: 'Move Line Down', keys: 'Alt+Down', scope: 'editor', run: inEditor(cm.moveLineDown) },
    { id: 'copyUp', title: 'Copy Line Up', keys: 'Shift+Alt+Up', scope: 'editor', run: inEditor(cm.copyLineUp) },
    { id: 'copyDown', title: 'Copy Line Down', keys: 'Shift+Alt+Down', scope: 'editor', run: inEditor(cm.copyLineDown) },
    { id: 'deleteLine', title: 'Delete Line', keys: 'Ctrl+Shift+K', scope: 'editor', run: inEditor(cm.deleteLine) },
    { id: 'insertBelow', title: 'Insert Line Below', keys: 'Ctrl+Enter', scope: 'editor', run: inEditor(cm.insertBlankLine) },
    { id: 'selectLine', title: 'Expand Line Selection', keys: 'Ctrl+L', scope: 'editor', run: inEditor(cm.selectLine) },
    { id: 'expandSel', title: 'Expand Selection', keys: 'Shift+Alt+Right', scope: 'editor', run: inEditor(cm.selectParentSyntax) },
    { id: 'comment', title: 'Toggle Line Comment', keys: 'Ctrl+/', scope: 'editor', run: inEditor(cm.toggleComment) },
    { id: 'blockComment', title: 'Toggle Block Comment', keys: 'Shift+Alt+A', scope: 'editor', run: inEditor(cm.toggleBlockComment) },
    { id: 'indent', title: 'Indent Line', keys: 'Ctrl+]', scope: 'editor', run: inEditor(cm.indentMore) },
    { id: 'outdent', title: 'Outdent Line', keys: 'Ctrl+[', scope: 'editor', run: inEditor(cm.indentLess) },
    { id: 'reindent', title: 'Reindent Lines', keys: 'Ctrl+Alt+\\', scope: 'editor', run: inEditor(cm.indentSelection) },
    { id: 'bracket', title: 'Go to Bracket', keys: 'Ctrl+Shift+\\', scope: 'editor', run: inEditor(cm.cursorMatchingBracket) },
    { id: 'fold', title: 'Fold', keys: 'Ctrl+Shift+[', scope: 'editor', run: inEditor(cm.foldCode) },
    { id: 'unfold', title: 'Unfold', keys: 'Ctrl+Shift+]', scope: 'editor', run: inEditor(cm.unfoldCode) },
    { id: 'foldAll', title: 'Fold All', keys: 'Ctrl+K Ctrl+0', scope: 'editor', run: inEditor(cm.foldAll) },
    { id: 'unfoldAll', title: 'Unfold All', keys: 'Ctrl+K Ctrl+J', scope: 'editor', run: inEditor(cm.unfoldAll) },
    { id: 'suggest', title: 'Trigger Suggest', keys: 'Ctrl+Space', scope: 'editor', run: inEditor(cm.startCompletion) },
  ];
  const byKeys = new Map(commands.filter((c) => c.keys).map((c) => [c.keys, c]));

  useEffect(() => {
    let chordTimer = 0;
    const key = (e) => {
      if (e.isComposing) return;
      const combo = comboOf(e);
      if (!combo) return;
      const where = focusIn(e);
      const allowed = (c) => c && (c.scope === 'any' || (where !== 'terminal' && (c.scope !== 'editor' || (where === 'page' && textDoc()))));
      if (ed.chord.value) {
        const full = `${ed.chord.value} ${combo}`;
        clearTimeout(chordTimer);
        ed.chord.value = null;
        e.preventDefault();
        const c = byKeys.get(full);
        if (allowed(c)) c.run(); else toast(`(${full}) is not a command`, 'err');
        return;
      }
      // The first half of a chord (not in a terminal, where Ctrl+K is the shell's).
      if (combo === 'Ctrl+K' && where !== 'terminal') {
        e.preventDefault();
        ed.chord.value = 'Ctrl+K';
        chordTimer = setTimeout(() => { ed.chord.value = null; }, 3000);
        return;
      }
      if (e.defaultPrevented) return; // the editor (or a field) already did it
      const c = byKeys.get(combo);
      if (!allowed(c)) return;
      e.preventDefault();
      c.run();
    };
    const leave = (e) => { if (ed.docs.value.some((d) => d.dirty)) { e.preventDefault(); e.returnValue = ''; } };
    addEventListener('keydown', key);
    addEventListener('beforeunload', leave);
    return () => { clearTimeout(chordTimer); removeEventListener('keydown', key); removeEventListener('beforeunload', leave); };
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

  const panes = [['files', 'Files', 'folder'], ['editor', 'Editor', 'code-xml'], ...(info.terminal ? [['terminal', 'Terminal', 'terminal']] : [])];
  return html`<div class=${cx('ide', !filesShown && 'no-files', !termShown && 'no-term', termMax && 'term-max')} data-pane=${pane}
    style=${{ '--tree-w': `${treeW}px`, '--term-h': `${termH}px`, '--code-fs': `${fontPx}px` }}>
    <header class="ide-head">
      <a class="ide-brand" href=${`/#c=${encodeURIComponent(id)}`} title="Back to the chat" aria-label="Back to the chat"><${Logo} size=${22} /></a>
      <div class="crumbs">
        <span class="crumb-project">${info.project.name}</span>
        <${Icon} name="chevron-right" class="tiny dim crumb-sep" />
        <span class="crumb-title" title=${info.conv.title || 'New chat'}>${info.conv.title || 'New chat'}</span>
      </div>
      ${info.conv.worktree && html`<span class="ide-chip" title="This chat works in its own worktree"><${Icon} name="git-branch" />${info.conv.branch}</span>`}
      <div class="spacer"></div>
      <button class="ide-search" onClick=${() => openPalette('')} title="Go to file (Ctrl+P); type > for commands">
        <${Icon} name="search" /><span>Go to file</span><kbd class="hide-mobile">Ctrl P</kbd></button>
      <button class="icon-btn hide-mobile" aria-label="All commands" title="All commands (Ctrl+Shift+P)" onClick=${() => openPalette('>')}><${Icon} name="chevron-right" /></button>
      <button class=${cx('icon-btn hide-mobile', filesShown && 'on')} aria-pressed=${filesShown} aria-label="Side bar" title="Side bar (Ctrl+B)" onClick=${() => toggleFiles()}><${Icon} name="panel-left" /></button>
      ${info.terminal && html`<button class=${cx('icon-btn hide-mobile', termShown && 'on')} aria-pressed=${termShown} aria-label="Terminal" title="Terminal (Ctrl+\`)" onClick=${() => toggleTerm()}><${Icon} name="panel-bottom" /></button>`}
    </header>
    <div class="ide-body">
      <div class="ide-files">
        <div class="side-tabs" role="tablist">
          <button role="tab" aria-selected=${side === 'files'} class=${cx(side === 'files' && 'active')} title="Explorer (Ctrl+Shift+E)" onClick=${() => setSide('files')}>
            <${Icon} name="folder" />Explorer</button>
          <button role="tab" aria-selected=${side === 'search'} class=${cx(side === 'search' && 'active')} title="Search (Ctrl+Shift+F)" onClick=${() => { setSide('search'); search.focus.value++; }}>
            <${Icon} name="search" />Search</button>
        </div>
        <div class="side-body" hidden=${side !== 'files'}>
          <${FileTree} convId=${id} rootName=${info.root} canWrite=${canWrite} writeBlocked=${writeBlocked}
            onOpen=${(p) => openFile(p)} onRenamed=${onRenamed} onDeleted=${onDeleted} />
        </div>
        <div class="side-body" hidden=${side !== 'search'}>
          <${SearchView} convId=${id} shown=${side === 'search'} canWrite=${canWrite} writeBlocked=${writeBlocked}
            onOpen=${openFile} onReplaced=${() => { poll(); refreshTree(id); refreshGitMarks(id); }} />
        </div>
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
    <${Palette} convId=${id} commands=${commands.filter((c) => !c.hidden)} recent=${ed.docs.value.map((d) => d.path)}
      symbols=${() => (textDoc() ? symbolsOf(view.state) : null)} lines=${() => (textDoc() ? view.state.doc.lines : null)}
      onOpenFile=${(p) => openFile(p)} onGoto=${(line, col) => revealAt({ line, col })}
      onSymbol=${(s) => revealAt({ pos: s.pos, len: s.name.length })} />
  </div>`;
}

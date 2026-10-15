// The code editor's file manager: a lazily loaded tree of the chat's folder with git's marks, and what can be done to
// a file or folder there (new, rename, delete, upload, download, copy path).
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { batch, signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api, currentToken, downloadFile, handleUnauthorized } from './api.js';
import { confirmDialog, Icon } from './ui.js';
import { guarded, toast } from './store.js';
import { copyText } from './code.js';

/** The tree: folder path -> its entries (loaded ones), which folders are open, the selected path and git's marks. */
export const tree = {
  dirs: signal(new Map()),
  open: signal(new Set([''])),
  selected: signal(null),
  /** path -> two-letter porcelain status, for files and (as 'dir') folders holding changed files */
  git: signal(new Map()),
  /** A row being typed: { kind: 'file'|'folder'|'rename', parent, path? } */
  editing: signal(null),
};

const join = (dir, name) => (dir ? `${dir}/${name}` : name);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);

export async function loadDir(convId, dir) {
  const r = await api(`/api/conversations/${convId}/fs/list?path=${encodeURIComponent(dir)}`);
  const next = new Map(tree.dirs.value);
  next.set(dir, r.entries);
  tree.dirs.value = next;
}

/** Reload every open folder (one that disappeared closes). */
export async function refreshTree(convId) {
  const open = [...tree.open.value];
  const gone = [];
  await Promise.all(open.map((d) => loadDir(convId, d).catch((e) => { if (e.status === 404) gone.push(d); })));
  if (gone.length) {
    const keep = new Set(tree.open.value);
    const dirs = new Map(tree.dirs.value);
    for (const d of gone) { keep.delete(d); dirs.delete(d); }
    batch(() => { tree.open.value = keep; tree.dirs.value = dirs; });
  }
}

/** git status → marks on files and on the folders above them. */
export async function refreshGitMarks(convId) {
  let s;
  try { s = await api(`/api/conversations/${convId}/git`); } catch { return; }
  const marks = new Map();
  for (const f of s.repo ? s.files : []) {
    const path = f.path.replace(/\/$/, '');
    marks.set(path, f.status);
    for (let d = parentOf(path); d; d = parentOf(d)) if (!marks.has(d)) marks.set(d, 'dir');
  }
  tree.git.value = marks;
}

const mark = (st) => (!st ? null : st === 'dir' ? ['•', 'modified'] : st === '??' ? ['U', 'untracked'] : st[0] === 'A' ? ['A', 'added']
  : st.includes('D') ? ['D', 'deleted'] : st.includes('R') ? ['R', 'renamed'] : ['M', 'modified']);

/** New things go into the selected folder, or next to the selected file. */
export function selectedDir() {
  const s = tree.selected.value;
  if (!s) return '';
  const parent = parentOf(s);
  const isDir = (tree.dirs.value.get(parent) || []).some((e) => e.name === nameOf(s) && e.dir);
  return isDir ? s : parent;
}

/** Start typing the name of a new file or folder in `parent` (default: next to the selection). */
export async function beginNew(convId, kind, parent = selectedDir()) {
  if (parent && !tree.open.value.has(parent)) await toggleDir(convId, parent, true);
  tree.editing.value = { kind, parent };
}

export async function toggleDir(convId, dir, open = !tree.open.value.has(dir)) {
  const next = new Set(tree.open.value);
  if (open) next.add(dir); else next.delete(dir);
  tree.open.value = next;
  if (open && !tree.dirs.value.has(dir)) await loadDir(convId, dir).catch((e) => toast(e.message, 'err'));
}

/** Open every folder above `path`, so it shows in the tree. */
export async function reveal(convId, path) {
  const dirs = [];
  for (let d = parentOf(path); d; d = parentOf(d)) dirs.unshift(d);
  for (const d of dirs) if (!tree.open.value.has(d)) await toggleDir(convId, d, true);
  tree.selected.value = path;
}

/** Upload files into a folder; one that exists there is only replaced after asking. */
export async function uploadInto(convId, dir, files, { onDone } = {}) {
  let done = 0;
  for (const file of files) {
    const send = async (replace) => {
      const form = new FormData();
      form.append('file', file, file.name);
      const res = await fetch(`/api/conversations/${convId}/fs/upload?dir=${encodeURIComponent(dir)}${replace ? '&replace=1' : ''}`,
        { method: 'POST', headers: { authorization: `Bearer ${currentToken()}` }, body: form });
      if (res.status === 401) { handleUnauthorized(); throw new Error('signed out'); }
      const body = await res.json().catch(() => ({}));
      return { status: res.status, body };
    };
    try {
      let r = await send(false);
      if (r.status === 409 && r.body.exists && await confirmDialog({
        title: `Replace ${file.name}?`, message: `${join(dir, file.name)} already exists. Uploading replaces its contents.`, confirmText: 'Replace', danger: true,
      })) r = await send(true);
      if (r.status === 201) done++;
      else if (!(r.status === 409 && r.body.exists)) toast(r.body.error || `upload failed (${r.status})`, 'err');
    } catch (e) { toast(e.message, 'err'); }
  }
  if (done) {
    toast(done === 1 ? 'uploaded 1 file' : `uploaded ${done} files`);
    if (!tree.open.value.has(dir)) await toggleDir(convId, dir, true);
    await loadDir(convId, dir).catch(() => {});
    onDone?.();
  }
}

function pickFiles(cb) {
  const input = document.createElement('input');
  input.type = 'file';
  input.multiple = true;
  input.onchange = () => { if (input.files?.length) cb([...input.files]); };
  input.click();
}

/** A menu at the pointer (right click or the row's ⋯), with the actions for one path. */
function ContextMenu({ at, onClose, children }) {
  const ref = useRef(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.bottom > innerHeight - 8) el.style.top = `${Math.max(8, innerHeight - r.height - 8)}px`;
    if (r.right > innerWidth - 8) el.style.left = `${Math.max(8, innerWidth - r.width - 8)}px`;
  }, [at]);
  useEffect(() => {
    const away = (e) => { if (!ref.current?.contains(e.target)) onClose(); };
    const esc = (e) => { if (e.key === 'Escape') onClose(); };
    document.addEventListener('pointerdown', away, true);
    document.addEventListener('keydown', esc);
    addEventListener('blur', onClose);
    return () => { document.removeEventListener('pointerdown', away, true); document.removeEventListener('keydown', esc); removeEventListener('blur', onClose); };
  }, []);
  return html`<div class="menu-pop ctx-menu" role="menu" ref=${ref} style=${{ left: `${at.x}px`, top: `${at.y}px` }} onClick=${onClose}>${children}</div>`;
}

const Item = ({ icon, danger, disabled, onClick, children, kbd }) => html`
  <button role="menuitem" class=${cx('menu-item', danger && 'danger')} disabled=${disabled} onClick=${onClick}>
    ${icon && html`<${Icon} name=${icon} />`}<span>${children}</span>${kbd && html`<kbd>${kbd}</kbd>`}
  </button>`;

/** A row being typed: a new file or folder, or a new name. Enter commits, Esc or leaving it cancels. */
function NameInput({ depth, icon, initial = '', onCommit, onCancel }) {
  const ref = useRef(null);
  const done = useRef(false);
  useLayoutEffect(() => {
    const el = ref.current;
    el.focus();
    const dot = initial.lastIndexOf('.');
    el.setSelectionRange(0, dot > 0 ? dot : initial.length);
  }, []);
  const finish = async (commit) => {
    if (done.current) return;
    done.current = true;
    const v = ref.current.value.trim();
    if (commit && v && v !== initial) { if (await onCommit(v) === false) { done.current = false; ref.current?.focus(); } } else onCancel();
  };
  return html`<div class="tree-row editing" style=${{ '--depth': depth }}>
    <span class="tree-twisty"></span><${Icon} name=${icon} class="tree-icon" />
    <input ref=${ref} class="tree-input" value=${initial} spellcheck="false" autocomplete="off" aria-label="Name"
      onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); finish(true); } else if (e.key === 'Escape') { e.preventDefault(); finish(false); } }}
      onBlur=${() => finish(true)} />
  </div>`;
}

/**
 * The tree. `onOpen(path)` opens a file in the editor; `onRenamed(from, to)` and `onDeleted(path)` let open tabs
 * follow; `canWrite` hides what the server would refuse (read-only project, an agent working).
 */
export function FileTree({ convId, rootName, canWrite, writeBlocked, onOpen, onRenamed, onDeleted }) {
  const [menu, setMenu] = useState(null);
  const [dropDir, setDropDir] = useState(null);
  const dirs = tree.dirs.value;
  const open = tree.open.value;
  const marks = tree.git.value;
  const editing = tree.editing.value;
  const selected = tree.selected.value;

  useEffect(() => {
    batch(() => { tree.dirs.value = new Map(); tree.open.value = new Set(['']); tree.selected.value = null; });
    loadDir(convId, '').catch((e) => toast(e.message, 'err'));
  }, [convId]);

  const blocked = () => { if (canWrite) return false; toast(writeBlocked, 'err'); return true; };

  const startNew = (kind, parent) => { if (!blocked()) beginNew(convId, kind, parent); };
  const create = guarded(async (kind, parent, name) => {
    const path = join(parent, name);
    try {
      await api(`/api/conversations/${convId}/fs/new`, { method: 'POST', body: { path, dir: kind === 'folder' } });
    } catch (e) { toast(e.message, 'err'); return false; }
    tree.editing.value = null;
    await loadDir(convId, parent);
    tree.selected.value = path;
    if (kind === 'file') onOpen(path);
    return true;
  });
  const rename = guarded(async (from, name) => {
    const to = join(parentOf(from), name);
    try {
      await api(`/api/conversations/${convId}/fs/rename`, { method: 'POST', body: { from, to } });
    } catch (e) { toast(e.message, 'err'); return false; }
    tree.editing.value = null;
    // Open folders inside the renamed one keep their place under the new name.
    const reopen = new Set([...tree.open.value].map((d) => (d === from || d.startsWith(`${from}/`) ? to + d.slice(from.length) : d)));
    batch(() => { tree.open.value = reopen; tree.selected.value = to; });
    await refreshTree(convId);
    onRenamed(from, to);
    return true;
  });
  const remove = guarded(async (path, isDir) => {
    if (blocked()) return;
    if (!await confirmDialog({
      title: `Delete ${nameOf(path)}?`, danger: true, confirmText: 'Delete',
      message: isDir ? `The folder ${path} and everything in it are deleted from the disk. This cannot be undone here.`
        : `${path} is deleted from the disk. This cannot be undone here.`,
    })) return;
    await api(`/api/conversations/${convId}/fs/delete`, { method: 'POST', body: { path } });
    await loadDir(convId, parentOf(path));
    onDeleted(path);
  });
  const upload = (dir) => { if (!blocked()) pickFiles((files) => uploadInto(convId, dir, files, { onDone: () => refreshGitMarks(convId) })); };
  const download = guarded((path) => downloadFile(`/api/conversations/${convId}/files/download?path=${encodeURIComponent(path)}`, nameOf(path)));

  const showMenu = (e, entry) => {
    e.preventDefault();
    e.stopPropagation();
    const r = e.currentTarget.getBoundingClientRect();
    const at = e.type === 'contextmenu' ? { x: e.clientX, y: e.clientY } : { x: r.left, y: r.bottom + 2 };
    if (entry) tree.selected.value = entry.path;
    setMenu({ at, entry });
  };

  const onDrop = (e, dir) => {
    e.preventDefault();
    e.stopPropagation();
    setDropDir(null);
    const files = [...(e.dataTransfer?.files || [])];
    if (files.length && !blocked()) uploadInto(convId, dir, files, { onDone: () => refreshGitMarks(convId) });
  };
  const dragOver = (e, dir) => {
    if (![...(e.dataTransfer?.types || [])].includes('Files')) return;
    e.preventDefault();
    e.stopPropagation();
    if (dropDir !== dir) setDropDir(dir);
  };

  const rows = [];
  const walk = (dir, depth) => {
    const ed = editing && editing.kind !== 'rename' && editing.parent === dir ? editing : null;
    if (ed) {
      rows.push(html`<${NameInput} key=${`new:${dir}`} depth=${depth} icon=${ed.kind === 'folder' ? 'folder' : 'file'}
        onCommit=${(name) => create(ed.kind, dir, name)} onCancel=${() => { tree.editing.value = null; }} />`);
    }
    const entries = dirs.get(dir);
    if (!entries) { if (open.has(dir)) rows.push(html`<div key=${`load:${dir}`} class="tree-row dim" style=${{ '--depth': depth }}><span class="tree-twisty"></span>Loading…</div>`); return; }
    for (const ent of entries) {
      const path = join(dir, ent.name);
      const entry = { ...ent, path };
      if (editing?.kind === 'rename' && editing.path === path) {
        rows.push(html`<${NameInput} key=${`ren:${path}`} depth=${depth} icon=${ent.dir ? 'folder' : 'file'} initial=${ent.name}
          onCommit=${(name) => rename(path, name)} onCancel=${() => { tree.editing.value = null; }} />`);
        continue;
      }
      const m = mark(marks.get(path));
      const isOpen = ent.dir && open.has(path);
      rows.push(html`<div key=${path} role="treeitem" aria-expanded=${ent.dir ? isOpen : undefined} aria-selected=${selected === path} tabindex="-1"
        class=${cx('tree-row', selected === path && 'selected', m && `git-${m[1]}`, ent.dir && dropDir === path && 'drop')}
        style=${{ '--depth': depth }} title=${path}
        onClick=${() => { tree.selected.value = path; if (ent.dir) toggleDir(convId, path); else onOpen(path); }}
        onContextMenu=${(e) => showMenu(e, entry)}
        onDragOver=${ent.dir ? (e) => dragOver(e, path) : undefined} onDragLeave=${ent.dir ? () => setDropDir(null) : undefined}
        onDrop=${ent.dir ? (e) => onDrop(e, path) : undefined}>
        <span class="tree-twisty">${ent.dir && html`<${Icon} name=${isOpen ? 'chevron-down' : 'chevron-right'} class="tiny" />`}</span>
        <${Icon} name=${ent.dir ? (isOpen ? 'folder-open' : 'folder') : 'file'} class="tree-icon" />
        <span class="tree-name">${ent.name}</span>
        ${m && html`<span class="tree-mark" title=${m[1]}>${m[0]}</span>`}
        <button class="icon-btn xs tree-more" aria-label=${`Actions for ${ent.name}`} onClick=${(e) => showMenu(e, entry)}><${Icon} name="ellipsis" /></button>
      </div>`);
      if (isOpen) walk(path, depth + 1);
    }
  };
  walk('', 0);

  const target = menu?.entry;
  const targetDir = target ? (target.dir ? target.path : parentOf(target.path)) : '';
  return html`<section class="files-pane" aria-label="Files">
    <div class="pane-head">
      <span class="pane-title" title=${rootName}>${rootName || 'Files'}</span>
      <div class="spacer"></div>
      <button class="icon-btn sm" aria-label="New file" title="New file" disabled=${!canWrite} onClick=${() => startNew('file', selectedDir())}><${Icon} name="file-plus" /></button>
      <button class="icon-btn sm" aria-label="New folder" title="New folder" disabled=${!canWrite} onClick=${() => startNew('folder', selectedDir())}><${Icon} name="folder-plus" /></button>
      <button class="icon-btn sm" aria-label="Upload files" title="Upload files" disabled=${!canWrite} onClick=${() => upload(selectedDir())}><${Icon} name="upload" /></button>
      <button class="icon-btn sm" aria-label="Refresh" title="Refresh" onClick=${guarded(async () => { await refreshTree(convId); await refreshGitMarks(convId); })}><${Icon} name="refresh-cw" /></button>
    </div>
    <div class=${cx('tree', dropDir === '' && 'drop')} role="tree" aria-label="Files"
      onContextMenu=${(e) => { if (e.target === e.currentTarget) showMenu(e, null); }}
      onDragOver=${(e) => dragOver(e, '')} onDragLeave=${(e) => { if (e.target === e.currentTarget) setDropDir(null); }} onDrop=${(e) => onDrop(e, '')}>
      ${rows}
      ${dirs.get('')?.length === 0 && !editing && html`<div class="tree-empty dim small">This folder is empty.</div>`}
    </div>
    ${menu && html`<${ContextMenu} at=${menu.at} onClose=${() => setMenu(null)}>
      ${target && !target.dir && html`<${Item} icon="file-pen" onClick=${() => onOpen(target.path)}>Open</${Item}>`}
      <${Item} icon="file-plus" disabled=${!canWrite} onClick=${() => startNew('file', targetDir)}>New file…</${Item}>
      <${Item} icon="folder-plus" disabled=${!canWrite} onClick=${() => startNew('folder', targetDir)}>New folder…</${Item}>
      <${Item} icon="upload" disabled=${!canWrite} onClick=${() => upload(targetDir)}>Upload files here…</${Item}>
      ${target && html`
        ${!target.dir && html`<${Item} icon="arrow-down-to-line" onClick=${() => download(target.path)}>Download</${Item}>`}
        <${Item} icon="copy" onClick=${() => copyText(target.path, 'path copied')}>Copy path</${Item}>
        <${Item} icon="pencil" disabled=${!canWrite} onClick=${() => { if (!blocked()) tree.editing.value = { kind: 'rename', path: target.path }; }}>Rename…</${Item}>
        <${Item} icon="trash-2" danger disabled=${!canWrite} onClick=${() => remove(target.path, target.dir)}>Delete</${Item}>`}
    </${ContextMenu}>`}
  </section>`;
}

// Stashes: uncommitted work put aside (new files too) and brought back later, here or in another chat of the same
// repository, since git keeps one list per repository. Each one lists its files, and a file opens to its diff.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Icon, Seg, Spinner } from './ui.js';
import { guarded, toast } from './store.js';
import { DiffView } from './diff.js';
import { plural } from './format.js';
import { opNote } from './git-sync.js';

const LETTER = { A: 'a', D: 'd', R: 'r' };
const when = (s) => new Date(s * 1000).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

export function Stashes({ id, changes, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [open, setOpen] = useState(null); // index of the stash whose files are shown
  const [file, setFile] = useState(null); // { index, path, diff }
  const [mode, setMode] = useState(innerWidth > 1100 ? 'split' : 'unified');
  const load = () => api(`/api/conversations/${id}/git/stashes`).then((l) => { setList(l); setOpen(null); setFile(null); }, (e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  const push = guarded(async () => {
    await api(`/api/conversations/${id}/git/stashes`, { method: 'POST', body: { message: message.trim() } });
    setMessage('');
    await load();
    await onDone('Changes stashed');
  });
  const apply = (s, pop) => guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/stashes/${s.index}/apply`, { method: 'POST', body: { pop } });
    await load();
    await onDone(opNote(r, pop ? 'Stash brought back and dropped' : 'Stash brought back (kept in the list)'));
  });
  const drop = (s) => guarded(async () => {
    if (!await confirmDialog({ title: 'Drop this stash?', message: `${s.message}\n\nIts changes are gone for good.`, confirmText: 'Drop', danger: true })) return;
    await api(`/api/conversations/${id}/git/stashes/${s.index}/drop`, { method: 'POST' });
    toast('Stash dropped');
    await load();
  });
  const show = (s, path) => {
    if (file?.index === s.index && file.path === path) { setFile(null); return; }
    setFile({ index: s.index, path, diff: null });
    api(`/api/conversations/${id}/git/stashes/${s.index}/diff?path=${encodeURIComponent(path)}`)
      .then((r) => setFile((f) => (f?.path === path ? { ...f, diff: r.diff } : f)), () => setFile((f) => (f?.path === path ? { ...f, diff: '' } : f)));
  };

  return html`<div class="dialog-body stash-dialog">
    <div class="dialog-head"><h2>Stashes</h2>
      ${file && html`<${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />`}
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <div class="row stash-new">
      <input value=${message} onInput=${(e) => setMessage(e.currentTarget.value)} placeholder="What is this work? (optional)" disabled=${!changes} />
      <${AsyncButton} class="btn primary sm" icon="archive" disabled=${!changes} onClick=${push}
        title=${changes ? 'Put every uncommitted change aside, new files too' : 'There are no uncommitted changes'}>Stash ${changes ? plural(changes, 'change') : 'changes'}<//>
    </div>
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="stash-list">
      ${!list ? !error && html`<div class="dim small"><${Spinner} /> Loading…</div>`
        : !list.length ? html`<div class="dim small">No stashes. Stashing puts the folder back as the last commit has it, and keeps the changes here to bring back later.</div>`
        : list.map((s) => html`<div key=${s.index} class=${cx('stash', open === s.index && 'open')}>
          <div class="stash-row">
            <button class="stash-title" onClick=${() => { setOpen(open === s.index ? null : s.index); setFile(null); }}>
              <${Icon} name=${open === s.index ? 'chevron-down' : 'chevron-right'} class="tiny" />
              <span class="stash-msg">${s.message}</span><span class="dim small">${plural(s.files.length, 'file')} · ${when(s.date)}</span>
            </button>
            <${AsyncButton} class="btn ghost sm" icon="undo-2" title="Bring the changes back and drop the stash" onClick=${apply(s, true)}>Pop<//>
            <${AsyncButton} class="btn ghost sm" title="Bring the changes back and keep the stash" onClick=${apply(s, false)}>Apply<//>
            <button class="icon-btn sm danger" aria-label="Drop this stash" title="Drop this stash" onClick=${drop(s)}><${Icon} name="trash-2" /></button>
          </div>
          ${open === s.index && html`<div class="stash-files">
            ${s.files.map((f) => html`<div key=${f.path}>
              <div class=${cx('file', file?.path === f.path && 'selected')} onClick=${() => show(s, f.path)}>
                <span class=${cx('fstat', LETTER[f.status] || 'm')}>${f.status}</span>
                <span class="fpath" title=${f.path}>${f.from ? `${f.from} → ` : ''}${f.path}</span>
              </div>
              ${file?.path === f.path && html`<div class="stash-diff">${file.diff == null
                ? html`<div class="pane-loading"><${Spinner} /> Loading diff…</div>` : html`<${DiffView} diff=${file.diff} path=${f.path} mode=${mode} />`}</div>`}
            </div>`)}
          </div>`}
        </div>`)}
    </div>
    <div class="dim small">Stashes belong to the repository: every chat working in it, worktree or not, sees the same list.</div>
  </div>`;
}

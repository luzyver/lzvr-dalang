// Checkpoints: the folder as it was right before and right after each agent turn, taken by the server without touching
// the branch or the index. A turn opens to the files it changed and their diffs, and the files can be put back as they
// were before it (or right after it). A restore can itself be undone.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Icon, Seg, Spinner } from './ui.js';
import { guarded } from './store.js';
import { DiffView, diffStats } from './diff.js';
import { dateTime, plural } from './format.js';

const LETTER = { A: 'a', D: 'd', R: 'r' };

function TurnFiles({ id, turn, mode }) {
  const [selected, setSelected] = useState(null);
  const [diffs, setDiffs] = useState({});
  const show = (path) => {
    setSelected(selected === path ? null : path);
    if (path in diffs) return;
    setDiffs((d) => ({ ...d, [path]: null }));
    api(`/api/conversations/${id}/git/checkpoints/${turn.turn}/diff?path=${encodeURIComponent(path)}`)
      .then((r) => setDiffs((d) => ({ ...d, [path]: r.diff })), () => setDiffs((d) => ({ ...d, [path]: '' })));
  };
  if (!turn.files.length) return html`<div class="dim small cp-none">This turn changed no files.</div>`;
  return html`<div class="stash-files">${turn.files.map((f) => {
    const d = diffs[f.path];
    const st = d ? diffStats(d) : null;
    return html`<div key=${f.path}>
      <div class=${cx('file', selected === f.path && 'selected')} onClick=${() => show(f.path)}>
        <span class=${cx('fstat', LETTER[f.status] || 'm')}>${f.status}</span>
        <span class="fpath" title=${f.path}>${f.from ? `${f.from} → ` : ''}${f.path}</span>
        ${st && html`<span class="diffstat">${st.add > 0 && html`<b class="add">+${st.add}</b>`}${st.del > 0 && html`<b class="del">−${st.del}</b>`}</span>`}
      </div>
      ${selected === f.path && html`<div class="stash-diff">${d == null
        ? html`<div class="pane-loading"><${Spinner} /> Loading diff…</div>` : html`<${DiffView} diff=${d} path=${f.path} mode=${mode} />`}</div>`}
    </div>`;
  })}</div>`;
}

export function Checkpoints({ id, onClose, onDone }) {
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [mode, setMode] = useState(innerWidth > 1100 ? 'split' : 'unified');
  const load = () => api(`/api/conversations/${id}/git/checkpoints`).then(setData, (e) => setError(e.message));
  useEffect(() => { load(); }, [id]);

  const restore = (t, to) => guarded(async () => {
    if (!await confirmDialog({
      title: to === 'before' ? 'Undo this turn?' : 'Go back to right after this turn?',
      message: `The files go back to how they were ${to === 'before' ? 'just before' : 'right after'} this turn: changes made since then, by you or later turns, are undone too. Commits and branches stay as they are.\n\nYou can undo the restore afterwards.`,
      confirmText: 'Restore', danger: true,
    })) return;
    const r = await api(`/api/conversations/${id}/git/checkpoints/${t.turn}/restore`, { method: 'POST', body: { to } });
    await load();
    await onDone(r.files ? `Restored ${plural(r.files, 'file')}` : 'Nothing to restore: the files already match');
  });
  const undo = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/checkpoints/undo`, { method: 'POST' });
    await load();
    await onDone(`Restore undone (${plural(r.files, 'file')})`);
  });

  return html`<div class="dialog-body stash-dialog">
    <div class="dialog-head"><h2>Agent checkpoints</h2>
      <div class="spacer"></div>
      ${open != null && html`<${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />`}
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <div class="dim small">The folder is saved right before and after every agent turn. Undo a turn to put its files back as they were before it.</div>
    ${data?.undo && html`<div class="row"><${AsyncButton} class="btn ghost sm" icon="rotate-ccw" title="Put the files back as they were before the last restore" onClick=${undo}>Undo the last restore<//></div>`}
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="stash-list">
      ${!data ? !error && html`<div class="dim small"><${Spinner} /> Loading…</div>`
        : !data.checkpoints.length ? html`<div class="dim small">No checkpoints yet: they are taken from the next agent turn on (not in read-only projects).</div>`
        : data.checkpoints.map((t, i) => html`<div key=${t.turn} class=${cx('stash', open === t.turn && 'open')}>
          <div class="stash-row">
            <button class="stash-title" onClick=${() => setOpen(open === t.turn ? null : t.turn)} title=${t.prompt}>
              <${Icon} name=${open === t.turn ? 'chevron-down' : 'chevron-right'} class="tiny" />
              <span class="stash-msg">${t.prompt}</span>
              <span class="dim small">${t.files.length ? plural(t.files.length, 'file') : 'no files'} · ${dateTime(t.started_at)}${i === 0 ? ' · latest' : ''}</span>
            </button>
            ${t.files.length > 0 && html`<${AsyncButton} class="btn ghost sm" icon="undo-2" title="Put the files back as they were before this turn" onClick=${restore(t, 'before')}>Undo turn<//>`}
            ${t.files.length > 0 && html`<${AsyncButton} class="btn ghost sm" title="Put the files back as they were right after this turn" onClick=${restore(t, 'after')}>After<//>`}
          </div>
          ${open === t.turn && html`<${TurnFiles} id=${id} turn=${t} mode=${mode} />`}
        </div>`)}
    </div>
  </div>`;
}

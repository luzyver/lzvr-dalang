// Pick the branch a chat's Merge Request goes into: any local branch or one on the remote, or back to the usual one
// (the branch a worktree chat started from, else the remote's default branch).
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html } from './lib.js';
import { api } from './api.js';
import { Icon, Modal, Spinner } from './ui.js';

/**
 * Whether a Merge Request may be opened (and its target picked) when `pr` is the one linked here and `state` what the
 * forge said of it (undefined until read, null if it could not be): only with none, or once it is merged or closed.
 */
export const targetFree = (pr, state) => !pr || state === 'merged' || state === 'closed';

export function MrBase({ id, branch, base, usual, picked, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = (fetch) => api(`/api/conversations/${id}/git/branches${fetch ? '?fetch=1' : ''}`).then(setList, (e) => setError(e.message));
  useEffect(() => { load(false).then(() => load(true)); }, [id]); // the local list at once, then again after a fetch
  const pick = (name) => async () => {
    setError('');
    try {
      const r = await api(`/api/conversations/${id}/git/mr-base`, { method: 'PUT', body: { base: name } });
      onClose();
      await onDone(`Merge Request goes into ${r.base || 'detached HEAD'}`);
    } catch (e) { setError(e.message); }
  };
  const name = q.trim().toLowerCase();
  const names = list ? [...new Set([...list.local, ...list.remote])].filter((b) => b !== branch && b.toLowerCase().includes(name)) : [];
  const remoteOnly = (b) => !list.local.includes(b);
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Merge into</h2><button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <input class="mono" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} autofocus placeholder="Find a branch" />
    ${picked && usual && html`<button class="btn ghost sm" onClick=${pick('')}><${Icon} name="rotate-ccw" />Back to ${usual}</button>`}
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="palette-list branch-list">
      ${!list ? html`<div class="dim small"><${Spinner} /> Loading…</div>`
        : names.map((b) => html`<div key=${b} class="branch-row">
          <button class="palette-item" disabled=${b === base} onClick=${pick(b)}>
            <${Icon} name=${b === base ? 'check' : 'git-branch'} /><span class="mono">${b}</span>
            ${b === usual && html`<span class="dim small">usual</span>`}${remoteOnly(b) && html`<span class="dim small">remote</span>`}</button>
        </div>`)}
    </div>
    <div class="dim small">The next Merge Request opens into it; one already open keeps its target.</div>
  </div>`;
}

/**
 * A plain chat on the default branch has no Merge Request to open by default: offer to pick a branch it would go into
 * (say main → develop).
 */
export function MrPick({ id, pick, onDone }) {
  const [open, setOpen] = useState(false);
  return html`<section class="branch-card">
    <div class="branch-line"><${Icon} name="git-branch" /><code>${pick.branch}</code><${Icon} name="chevron-right" class="tiny dim" />
      <button class="btn ghost sm branch-btn" title="Pick a branch to open a Merge Request into" onClick=${() => setOpen(true)}>
        <span>Merge into…</span><${Icon} name="chevron-down" class="tiny" /></button></div>
    <div class="dim small">${pick.branch} is the default branch: pick another branch to propose it into.</div>
    <${Modal} open=${open} label="Merge into" class="dialog" onClose=${() => setOpen(false)}>
      ${open && html`<${MrBase} id=${id} branch=${pick.branch} base=${null} usual=${pick.usual} picked=${false} onClose=${() => setOpen(false)} onDone=${onDone} />`}
    <//>
  </section>`;
}

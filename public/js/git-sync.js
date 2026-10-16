// Sync and conflicts in the Changes tab: how far the branch is from its remote and from the branch its Merge Request
// goes into, ways to bring either in (pull, rebase, merge), and, when one of those stopped on conflicts, settling the
// conflicted files one by one (or handing them to the chat's agent) before continuing or aborting.
import { html } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Icon, Menu, MenuItem } from './ui.js';
import { guarded, toast } from './store.js';
import { plural } from './format.js';

const CONFLICT = new Set(['DD', 'AU', 'UD', 'UA', 'DU', 'AA', 'UU']);
/** A file git stopped on: both sides changed it (`git status` codes with a U, AA or DD). */
export const isConflict = (f) => CONFLICT.has(f.status);

const OP = { merge: 'Merge', rebase: 'Rebase', 'cherry-pick': 'Cherry-pick', revert: 'Revert' };

/** Send the chat's agent a prompt; it joins the queue like one typed in the composer. */
export async function askAgent(id, prompt) {
  await api(`/api/conversations/${id}/prompts`, { method: 'POST', body: { prompt } });
  toast('Sent to the agent: follow it in the chat');
}

/** How an operation that may stop on conflicts went (sync, cherry-pick, revert, stash apply), for a toast. */
export const opNote = (r, done) => (r.result === 'conflicts' ? `Stopped on ${plural(r.conflicts.length, 'conflict')}: resolve them in the Changes tab`
  : r.result === 'up-to-date' ? 'Already up to date' : done);

/** Keep one side of a conflicted file, or mark it resolved once edited by hand. In a menu on its row. */
export function ConflictMenu({ id, f, after }) {
  const take = (t) => guarded(async () => {
    await api(`/api/conversations/${id}/git/conflicts/resolve`, { method: 'POST', body: { path: f.path, take: t } });
    await after(`${f.path}: ${t === 'resolved' ? 'marked resolved' : t === 'mine' ? 'kept this branch\'s side' : 'took the incoming side'}`);
  });
  return html`<span class="conflict-menu" onClick=${(e) => e.stopPropagation()}>
    <${Menu} label="Resolve this conflict" icon="git-merge" buttonClass="sm">
      <${MenuItem} icon="check" onClick=${take('mine')}>Keep this branch's side<//>
      <${MenuItem} icon="arrow-down-to-line" onClick=${take('theirs')}>Take the incoming side<//>
      <${MenuItem} icon="circle-check" title="After removing the conflict markers by hand (code editor or agent)" onClick=${take('resolved')}>Mark resolved<//>
    <//>
  </span>`;
}

const RESOLVE_PROMPT = (op, files) => `A git ${op} in this folder stopped on conflicts in:\n${files.map((f) => `- ${f}`).join('\n')}

Resolve every conflict: edit each file so that it keeps what both sides meant, remove all conflict markers (<<<<<<<, =======, >>>>>>>), make sure the result builds and its tests pass, then stage the files with \`git add\`. Do not commit, and do not run \`git ${op} --continue\` or \`--abort\`: I continue it myself from the panel.`;

/**
 * Above the file list: an operation waiting on conflicts, a remote branch with commits this one lacks, and a base branch
 * that moved on since this branch left it.
 */
export function SyncBanners({ id, s, after }) {
  const conflicts = s.files.filter(isConflict).map((f) => f.path);
  const sync = (from, mode) => guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/sync`, { method: 'POST', body: { from, mode } });
    await after(opNote(r, `${mode === 'rebase' ? 'Rebased onto' : 'Merged'} ${r.onto}`));
  });
  const forcePush = guarded(async () => {
    if (!await confirmDialog({
      title: `Replace ${s.upstream.name} with this branch?`,
      message: `For a branch you rebased: its commits replace the ${plural(s.upstream.behind, 'commit')} only the remote has. If someone else pushed there since the last fetch, the push is refused and nothing is lost.`,
      confirmText: 'Force push', danger: true,
    })) return;
    const r = await api(`/api/conversations/${id}/git/push`, { method: 'POST', body: { force: true } });
    await after(`Force-pushed to ${r.push.pushed}`);
  });
  const pull = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/pull`, { method: 'POST' });
    await after(r.commits ? `Pulled ${plural(r.commits, 'commit')} from ${r.from}` : `Already up to date with ${r.from}`);
  });
  const go = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/conflicts/continue`, { method: 'POST' });
    await after(opNote(r, `${OP[s.operation]} finished`));
  });
  const abort = guarded(async () => {
    if (!await confirmDialog({ title: `Abort the ${s.operation}?`, message: 'Everything goes back to how it was before it started, including the files resolved so far.', confirmText: 'Abort', danger: true })) return;
    await api(`/api/conversations/${id}/git/conflicts/abort`, { method: 'POST' });
    await after(`${OP[s.operation]} aborted`);
  });

  if (s.operation) {
    return html`<section class="sync-card warn">
      <div class="sync-line"><${Icon} name="triangle-alert" /><strong>${OP[s.operation]} in progress</strong>
        <span class="dim">· ${conflicts.length ? `${plural(conflicts.length, 'conflicted file')} left` : 'every conflict resolved'}</span></div>
      <div class="dim small">${conflicts.length
        ? 'Settle each file marked U below: keep one side, or edit it (code editor or agent) and mark it resolved. Then continue.'
        : `Continue to finish the ${s.operation}.`}</div>
      <div class="row">
        <${AsyncButton} class="btn primary sm" icon="play" disabled=${conflicts.length > 0} onClick=${go}>Continue<//>
        ${conflicts.length > 0 && html`<${AsyncButton} class="btn ghost sm" icon="bot" title="Let the chat's agent resolve the conflicts"
          onClick=${guarded(() => askAgent(id, RESOLVE_PROMPT(s.operation, conflicts)))}>Ask the agent<//>`}
        <div class="spacer"></div>
        <${AsyncButton} class="btn ghost danger sm" icon="x" onClick=${abort}>Abort<//>
      </div>
    </section>`;
  }

  const u = s.upstream;
  const base = s.mr && s.mr.behind > 0 && s.mr.base && s.mr.baseRef !== u?.name ? s.mr : null;
  return html`
    ${conflicts.length > 0 && html`<section class="sync-card warn">
      <div class="sync-line"><${Icon} name="triangle-alert" /><strong>${plural(conflicts.length, 'conflicted file')}</strong></div>
      <div class="dim small">Changes brought back (a stash, or uncommitted work put aside for a sync) clashed with the files here. Settle each file marked U below; the stash stays in the list until you drop it.</div>
      <div class="row"><${AsyncButton} class="btn ghost sm" icon="bot" title="Let the chat's agent resolve the conflicts"
        onClick=${guarded(() => askAgent(id, RESOLVE_PROMPT('stash apply', conflicts).replace(/Do not commit.*$/s, 'Do not commit: I review and commit it myself.')))}>Ask the agent<//></div>
    </section>`}
    ${u && u.behind > 0 && html`<section class="sync-card">
      <div class="sync-line"><${Icon} name="cloud-download" /><span><span class="mono">${u.name}</span> has ${plural(u.behind, 'commit')} this branch lacks${
        u.ahead > 0 ? html`, and this branch has ${plural(u.ahead, 'commit')} it lacks` : ''}</span></div>
      <div class="row">
        ${u.ahead === 0 ? html`<${AsyncButton} class="btn primary sm" icon="arrow-down-to-line" onClick=${pull}>Pull<//>` : html`
          <${AsyncButton} class="btn primary sm" icon="git-branch" title="Replay this branch's commits on top of the remote's" onClick=${sync('upstream', 'rebase')}>Rebase onto it<//>
          <${AsyncButton} class="btn ghost sm" icon="git-merge" title="Merge the remote's commits in (a merge commit)" onClick=${sync('upstream', 'merge')}>Merge it<//>
          ${s.mr ? html`<div class="spacer"></div>
            <${AsyncButton} class="btn ghost danger sm" icon="arrow-up-from-line" title="After a rebase: replace the remote branch with this one" onClick=${forcePush}>Force push<//>` : ''}`}
      </div>
    </section>`}
    ${base && html`<section class="sync-card">
      <div class="sync-line"><${Icon} name="git-compare" /><span><span class="mono">${base.base}</span> moved on: ${plural(base.behind, 'commit')} since this branch left it</span></div>
      <div class="row">
        <${AsyncButton} class="btn ghost sm" icon="git-branch" title=${`Replay this branch's commits on top of ${base.baseRef}`} onClick=${sync('base', 'rebase')}>Rebase onto ${base.base}<//>
        <${AsyncButton} class="btn ghost sm" icon="git-merge" title=${`Merge ${base.baseRef} into this branch`} onClick=${sync('base', 'merge')}>Merge ${base.base} in<//>
      </div>
    </section>`}`;
}

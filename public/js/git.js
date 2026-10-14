// The "Changes" page of a chat: what git sees in the folder its agent works in, with commit / revert / merge.
import { h, icon } from './dom.js';
import { api } from './api.js';
import { fileChange } from './chat.js';

const MAX_DIFFS = 50; // more files than this are listed without their diff

/** How the push after a commit or merge went, for the status line. */
const pushNote = (p) => (!p ? '' : p.error ? ` · push failed: ${p.error}` : p.pushed ? ` · pushed to ${p.pushed}` : ' · not pushed (no remote)');

/** git's two-letter status as the change kinds the diff view already labels. */
function kindOf(status) {
  if (status === '??' || status[0] === 'A') return 'add';
  if (status.includes('D')) return 'delete';
  return 'update';
}

/** `onChange` runs after anything that changed the files, e.g. to refresh the chat's change count. */
export function changesPage({ id, guarded, flash, close, onChange }) {
  const body = h('div', { class: 'page-body' }, h('div', { class: 'small' }, 'Loading…'));

  async function load() {
    const s = await api(`/api/conversations/${id}/git`);
    if (!s.repo) {
      body.replaceChildren(h('strong', {}, 'Changes'),
        h('div', { class: 'small' }, 'This folder is not a git repository, so there is nothing to commit or revert here.'),
        h('div', { class: 'row' }, h('button', { onclick: close }, 'Back to chat')));
      return;
    }
    const diffs = await Promise.all(s.files.slice(0, MAX_DIFFS).map((f) =>
      api(`/api/conversations/${id}/git/diff?path=${encodeURIComponent(f.path)}`).then((d) => d.diff, () => '')));
    const after = (fn, done) => guarded(async () => { if (await fn() === false) return; if (done) flash(done); onChange?.(); await load(); });

    const checks = s.files.map(() => h('input', { type: 'checkbox', checked: true, title: 'Include in the commit' }));
    const rows = s.files.map((f, i) => h('div', { class: 'gitfile' },
      checks[i],
      fileChange({ path: f.from || f.path, movePath: f.from ? f.path : undefined, kind: kindOf(f.status), diff: diffs[i] }),
      h('button', { class: 'danger', title: f.status === '??' ? 'Delete this new file' : 'Undo the changes to this file', onclick: after(async () => {
        if (!confirm(f.status === '??' ? `Delete the new file ${f.path}?` : `Undo every change to ${f.path}?`)) return false;
        await api(`/api/conversations/${id}/git/revert`, { method: 'POST', body: { paths: [f.path] } });
      }, `reverted ${f.path}`) }, 'Revert')));

    const message = h('textarea', { rows: '3', placeholder: 'Commit message' });
    const picked = () => s.files.filter((_, i) => checks[i].checked).map((f) => f.path);
    // The chat's own agent drafts it from the selected files' diffs and what the chat was asked to do.
    const generate = h('button', { title: 'Let the agent write a message for the selected files', onclick: guarded(async () => {
      const paths = picked();
      if (!paths.length) throw new Error('pick at least one file');
      generate.disabled = true;
      generate.textContent = 'Generating…';
      try {
        const r = await api(`/api/conversations/${id}/git/message`, { method: 'POST', body: paths.length < s.files.length ? { paths } : {} });
        message.value = r.message;
        message.focus();
      } finally {
        generate.disabled = false;
        generate.textContent = 'Generate message';
      }
    }) }, 'Generate message');
    const commit = after(async () => {
      if (!picked().length) throw new Error('pick at least one file');
      if (!message.value.trim()) throw new Error('write a commit message');
      const r = await api(`/api/conversations/${id}/git/commit`, {
        method: 'POST', body: { message: message.value.trim(), ...(picked().length < s.files.length && { paths: picked() }) },
      });
      flash(`committed ${r.commit}${pushNote(r.push)}`);
    });
    const discard = after(async () => {
      if (!confirm('Throw away every uncommitted change in this folder, including new files? This cannot be undone.')) return false;
      await api(`/api/conversations/${id}/git/discard`, { method: 'POST' });
    }, 'changes discarded');

    const w = s.worktree;
    // The merge commit's message; "Generate MR description" fills it from the description's Title and sections.
    const mergeMessage = h('textarea', { rows: '6', placeholder: `Merge commit message (empty: git's "Merge branch '${w?.branch}'")` });
    let mrDescription = '';
    const copyMr = h('button', { hidden: true, title: 'Copy the Merge Request description as Markdown', onclick: async () => {
      try { await navigator.clipboard.writeText(mrDescription); flash('MR description copied'); } catch { flash('copy failed'); }
    } }, 'Copy MR description');
    const generateMr = h('button', { title: 'Let the agent describe what this branch brings, as a Merge Request description', onclick: guarded(async () => {
      generateMr.disabled = true;
      generateMr.textContent = 'Generating…';
      try {
        const r = await api(`/api/conversations/${id}/git/mr-description`, { method: 'POST' });
        mrDescription = r.description;
        mergeMessage.value = r.message;
        copyMr.hidden = false;
      } finally {
        generateMr.disabled = false;
        generateMr.textContent = 'Generate MR description';
      }
    }) }, 'Generate MR description');
    // Pushes the branch and opens a Merge Request (GitLab) or pull request (GitHub) into the branch the chat started from.
    // The merge message above doubles as its text: the first line is the title, the rest the description.
    const createMr = w && after(async () => {
      if (!confirm(`Push ${w.branch} and open a Merge Request into ${w.base}?`)) return false;
      const [title = '', ...rest] = mergeMessage.value.trim().split('\n');
      const r = await api(`/api/conversations/${id}/git/pull-request`, { method: 'POST', body: { title: title.trim(), body: rest.join('\n').trim() } });
      flash(r.existed ? 'a Merge Request was already open for this branch' : `Merge Request opened${pushNote(r.push)}`);
    });
    const merge = w && after(async () => {
      if (!confirm(`Merge ${w.branch} into ${w.into} in the project folder?`)) return false;
      const r = await api(`/api/conversations/${id}/git/merge`, { method: 'POST', body: { message: mergeMessage.value } });
      flash(`merged into ${r.into}${pushNote(r.push)}`);
    });

    body.replaceChildren(
      h('div', { class: 'row githead' }, h('strong', {}, 'Changes'), h('span', { class: 'spacer' }),
        h('button', { onclick: guarded(load) }, 'Refresh'),
        h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, icon('x'))),
      h('div', { class: 'small' }, icon('git-branch'), ` ${s.branch || 'detached HEAD'}`,
        s.head ? ` · last commit ${s.head.hash} ${s.head.subject}` : ' · no commits yet'),
      w && h('div', { class: 'gitbox' },
        h('div', { class: 'small' }, `This chat works in its own worktree, branched from ${w.base || 'a detached HEAD'}. `,
          w.ahead ? `${w.ahead} commit${w.ahead === 1 ? '' : 's'} not in ${w.base || 'the project folder'} yet.` : 'Nothing to merge yet.'),
        w.ahead > 0 && mergeMessage,
        w.ahead > 0 && h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: merge }, `Merge into ${w.into || 'project branch'}`),
          !w.pr && w.base && h('button', { title: `Push ${w.branch} and open a Merge Request / pull request into ${w.base}; the message above is its title and description`, onclick: createMr },
            icon('git-pull-request'), ' Create Merge Request'),
          generateMr, copyMr),
        w.pr && h('a', { class: 'pr-link small', href: w.pr, target: '_blank', rel: 'noopener noreferrer' }, icon('git-pull-request'), ' View Merge Request: ', w.pr)),
      s.files.length
        ? h('div', { class: 'gitfiles' }, rows, s.files.length > MAX_DIFFS ? h('div', { class: 'small' }, `Diffs shown for the first ${MAX_DIFFS} files.`) : null)
        : h('div', { class: 'small' }, 'No uncommitted changes.'),
      s.files.length > 0 && h('div', { class: 'gitbox' }, message,
        h('div', { class: 'row' },
          h('button', { class: 'primary', onclick: commit }, 'Commit selected'),
          generate,
          h('span', { class: 'spacer' }),
          h('button', { class: 'danger', onclick: discard }, 'Discard all'))));
  }

  guarded(load)();
  return body;
}

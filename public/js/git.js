// The Changes tab: what git sees in the folder the chat's agent works in. Pick files, read their diffs, commit and push,
// revert, discard, pull, switch or create a branch, and open a Merge Request for the chat's branch.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Empty, Icon, Modal, Seg, Spinner } from './ui.js';
import { guarded, loadProjects, toast } from './store.js';
import { chat, refreshGit } from './chat-view.js';
import { DiffView, diffStats } from './diff.js';
import { copyText } from './code.js';
import { plural } from './format.js';

/** How the push after a commit or Merge Request went. */
const pushNote = (p) => (!p ? '' : p.error ? ` · push failed: ${p.error}` : p.pushed ? ` · pushed to ${p.pushed}` : ' · not pushed (no remote)');

const STATUS = (s) => (s === '??' || s[0] === 'A' ? ['A', 'added'] : s.includes('D') ? ['D', 'deleted'] : s.includes('R') ? ['R', 'renamed'] : ['M', 'modified']);

const splitPath = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

const MAX_DIFFS = 50; // more files than this are listed without their diff stats until opened

/** Diffs of the listed files, fetched again whenever the file list changes. `load(path)` fetches one on demand. */
function useDiffs(id, files) {
  const [diffs, setDiffs] = useState({});
  const fetchOne = (path) => {
    setDiffs((d) => (path in d ? d : { ...d, [path]: null }));
    api(`/api/conversations/${id}/git/diff?path=${encodeURIComponent(path)}`)
      .then((r) => setDiffs((d) => ({ ...d, [path]: r.diff })), () => setDiffs((d) => ({ ...d, [path]: '' })));
  };
  const key = files.map((f) => `${f.status}${f.path}`).join('\n');
  useEffect(() => {
    setDiffs({});
    files.slice(0, MAX_DIFFS).forEach((f) => fetchOne(f.path));
  }, [id, key]);
  return [diffs, (path) => { if (!(path in diffs)) fetchOne(path); }];
}

/**
 * Switch the project folder to another branch, or create one from the current HEAD. The box filters the list and is the
 * new branch's name. Remote branches without a local one are listed too: picking one creates it, tracking the remote.
 */
function Branches({ id, current, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = (fetch) => api(`/api/conversations/${id}/git/branches${fetch ? '?fetch=1' : ''}`).then(setList, (e) => setError(e.message));
  useEffect(() => { load(false).then(() => load(true)); }, [id]); // the local list at once, then again after a fetch
  const go = (name, create) => async () => {
    setError('');
    try {
      await api(`/api/conversations/${id}/git/branch`, { method: 'POST', body: { name, ...(create && { create }) } });
      onClose();
      await onDone(create ? `Created and switched to ${name}` : `Switched to ${name}`);
    } catch (e) { setError(e.message); }
  };
  // Local only; the remote keeps its copy. A branch with commits found nowhere else is deleted only after a second ask.
  const remove = (b) => async () => {
    if (!confirm(`Delete the local branch ${b}? The remote keeps its copy.`)) return;
    setError('');
    const del = (force) => api(`/api/conversations/${id}/git/branch/delete`, { method: 'POST', body: { name: b, ...(force && { force }) } });
    try {
      try { await del(false); } catch (e) {
        if (e.status !== 409) throw e;
        if (!confirm(`${e.message}. Delete ${b} anyway?`)) return;
        await del(true);
      }
      toast(`Deleted ${b}`);
      await load(false);
    } catch (e) { setError(e.message); }
  };
  const name = q.trim();
  const match = (b) => b.toLowerCase().includes(name.toLowerCase());
  const known = list && [...list.local, ...list.remote].includes(name);
  const item = (b, remote) => html`<div key=${(remote ? 'r:' : 'l:') + b} class="branch-row">
    <button class="palette-item" disabled=${b === current} onClick=${go(b)}>
      <${Icon} name=${b === current ? 'check' : 'git-branch'} /><span class="mono">${b}</span>${remote && html`<span class="dim small">remote</span>`}</button>
    ${!remote && b !== current && html`<button class="icon-btn sm danger" aria-label=${`Delete ${b}`} title="Delete this local branch" onClick=${remove(b)}><${Icon} name="trash-2" /></button>`}
  </div>`;
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Branches</h2><button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <input class="mono" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} autofocus placeholder="Find a branch, or name a new one" />
    ${name && list && !known && html`<${AsyncButton} class="btn primary sm" icon="plus" onClick=${go(name, true)}>Create branch ${name} from ${current || 'HEAD'}<//>`}
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="palette-list branch-list">
      ${!list ? html`<div class="dim small"><${Spinner} /> Loading…</div>` : html`
        ${list.local.filter(match).map((b) => item(b, false))}
        ${list.remote.filter(match).map((b) => item(b, true))}`}
    </div>
    <div class="dim small">Uncommitted changes come along to the other branch; git refuses the switch if they would be overwritten.</div>
  </div>`;
}

/** The chat's branch and where its Merge Request goes: a worktree chat's own branch, or the project folder's feature branch. */
function MergeRequest({ id, s, onDone }) {
  const w = s.mr;
  const [mrText, setMrText] = useState('');
  const [description, setDescription] = useState('');
  const generate = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/mr-description`, { method: 'POST' });
    setDescription(r.description);
    setMrText(r.message);
  });
  // Pushes the branch and opens a Merge Request (GitLab) or pull request (GitHub) into its target branch.
  const create = guarded(async () => {
    if (!confirm(`Push ${w.branch} and open a Merge Request into ${w.base}?`)) return;
    const [title = '', ...rest] = mrText.trim().split('\n');
    const r = await api(`/api/conversations/${id}/git/pull-request`, { method: 'POST', body: { title: title.trim(), body: rest.join('\n').trim() } });
    toast(r.existed ? 'A Merge Request was already open for this branch' : `Merge Request opened${pushNote(r.push)}`);
    await onDone();
  });
  return html`<section class="branch-card">
    <div class="branch-line"><${Icon} name="git-branch" /><code>${w.branch}</code><${Icon} name="chevron-right" class="tiny dim" /><code>${w.base || 'detached HEAD'}</code></div>
    <div class="dim small">${s.worktree ? 'Own worktree' : 'Project folder'} · ${w.ahead ? `${plural(w.ahead, 'commit')} not in ${w.base || 'the project folder'} yet` : 'nothing to propose yet'}</div>
    ${w.pr && html`<a class="mr-link" href=${w.pr} target="_blank" rel="noopener noreferrer"><${Icon} name="git-pull-request" /><span>${w.pr}</span><${Icon} name="external-link" class="tiny" /></a>`}
    ${w.ahead > 0 && html`<div class="mr-box">
      <textarea rows="4" value=${mrText} onInput=${(e) => setMrText(e.currentTarget.value)}
        placeholder="Merge Request title on the first line, description below (empty title: the last commit's subject)"></textarea>
      <div class="row">
        ${!w.pr && w.base && html`<${AsyncButton} class="btn primary sm" icon="git-pull-request" onClick=${create}>Create Merge Request<//>`}
        <${AsyncButton} class="btn ghost sm" icon="sparkles" busyText="Generating…" title="Let the agent describe what this branch brings" onClick=${generate}>Generate description<//>
        ${description && html`<button class="btn ghost sm" onClick=${() => copyText(description, 'MR description copied')}><${Icon} name="copy" />Copy Markdown</button>`}
      </div>
    </div>`}
  </section>`;
}

/** One file's diff in a dialog, with the previous / next changed file a click (or ← →) away. */
function DiffDialog({ files, current, diffs, mode, setMode, onPick, onRevert, onClose }) {
  const i = files.indexOf(current);
  const [letter, word] = STATUS(current.status);
  const d = diffs[current.path];
  const st = d ? diffStats(d) : null;
  const step = (by) => { const f = files[i + by]; if (f) onPick(f.path); };
  const onKeyDown = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); step(1); }
  };
  return html`<div class="diff-dialog" tabindex="-1" onKeyDown=${onKeyDown}>
    <div class="diff-dialog-head">
      <span class=${cx('fstat', letter.toLowerCase())} title=${word}>${letter}</span>
      <code class="diff-dialog-path" title=${current.from ? `${current.from} → ${current.path}` : current.path}>${current.from ? `${current.from} → ` : ''}${current.path}</code>
      ${st && html`<span class="diffstat">${st.add > 0 && html`<b class="add">+${st.add}</b>`}${st.del > 0 && html`<b class="del">−${st.del}</b>`}</span>`}
      <div class="spacer"></div>
      <${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />
      <div class="diff-nav">
        <button class="icon-btn sm" aria-label="Previous file" title="Previous file (←)" disabled=${i <= 0} onClick=${() => step(-1)}><${Icon} name="chevron-left" /></button>
        <span class="dim small">${i + 1} / ${files.length}</span>
        <button class="icon-btn sm" aria-label="Next file" title="Next file (→)" disabled=${i >= files.length - 1} onClick=${() => step(1)}><${Icon} name="chevron-right" /></button>
      </div>
      <button class="icon-btn sm danger" aria-label="Revert this file" title=${current.status === '??' ? 'Delete this new file' : 'Undo the changes to this file'} onClick=${onRevert}><${Icon} name="undo-2" /></button>
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
    </div>
    <div class="diff-dialog-body">
      ${d == null ? html`<div class="pane-loading"><${Spinner} /> Loading diff…</div>` : html`<${DiffView} diff=${d} path=${current.path} mode=${mode} />`}
    </div>
  </div>`;
}

export function ChangesPane({ id }) {
  const s = chat.git.value;
  const files = s?.files || [];
  const [unpicked, setUnpicked] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState(innerWidth > 1100 ? 'split' : 'unified');
  const [message, setMessage] = useState('');
  const [branching, setBranching] = useState(false);
  const [diffs, loadDiff] = useDiffs(id, files);

  useEffect(() => { setUnpicked(new Set()); setSelected(null); setMessage(''); setBranching(false); }, [id]);
  // The file whose diff is open in the dialog; it closes by itself when that file is no longer changed.
  const current = files.find((f) => f.path === selected) || null;
  useEffect(() => { if (current) loadDiff(current.path); }, [current?.path]);

  if (!s) return html`<div class="pane-loading"><${Spinner} /> Loading…</div>`;
  if (!s.repo) return html`<${Empty} icon="git-branch" title="Not a git repository">There is nothing to commit or revert in this chat's folder.<//>`;

  const picked = files.filter((f) => !unpicked.has(f.path)).map((f) => f.path);
  const togglePick = (path) => {
    const next = new Set(unpicked);
    if (next.has(path)) next.delete(path); else next.add(path);
    setUnpicked(next);
  };
  const after = async (done) => { if (done) toast(done); loadProjects().catch(() => {}); await refreshGit(id); };
  // Fast-forward only, so a pull never makes a merge commit.
  const pull = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/pull`, { method: 'POST' });
    await after(r.commits ? `Pulled ${plural(r.commits, 'commit')} from ${r.from}` : `Already up to date with ${r.from}`);
  });

  const generate = guarded(async () => {
    if (!picked.length) throw new Error('Pick at least one file');
    const r = await api(`/api/conversations/${id}/git/message`, { method: 'POST', body: picked.length < files.length ? { paths: picked } : {} });
    setMessage(r.message);
  });
  const commit = guarded(async () => {
    if (!picked.length) throw new Error('Pick at least one file');
    if (!message.trim()) throw new Error('Write a commit message');
    const r = await api(`/api/conversations/${id}/git/commit`, {
      method: 'POST', body: { message: message.trim(), ...(picked.length < files.length && { paths: picked }) },
    });
    setMessage('');
    await after(`Committed ${r.commit}${pushNote(r.push)}`);
  });
  const revert = (f) => guarded(async () => {
    if (!confirm(f.status === '??' ? `Delete the new file ${f.path}?` : `Undo every change to ${f.path}?`)) return;
    await api(`/api/conversations/${id}/git/revert`, { method: 'POST', body: { paths: [f.path] } });
    await after(`Reverted ${f.path}`);
  });
  const discard = guarded(async () => {
    if (!confirm('Throw away every uncommitted change in this folder, including new files? This cannot be undone.')) return;
    await api(`/api/conversations/${id}/git/discard`, { method: 'POST' });
    await after('Changes discarded');
  });

  const totals = files.reduce((t, f) => {
    const d = diffs[f.path];
    if (d) { const st = diffStats(d); t.add += st.add; t.del += st.del; }
    return t;
  }, { add: 0, del: 0 });
  const allPicked = picked.length === files.length;

  return html`<div class="changes">
    <div class="head-row">
      <div class="dim small">
        ${s.worktree
          ? html`<span title="A worktree chat stays on its own branch"><${Icon} name="git-branch" class="tiny" /> ${s.branch}</span>`
          : html`<button class="btn ghost sm branch-btn" title="Switch or create a branch" onClick=${() => setBranching(true)}>
              <${Icon} name="git-branch" class="tiny" /><span class="mono">${s.branch || 'detached HEAD'}</span><${Icon} name="chevron-down" class="tiny" /></button>`}
        <span>${s.head ? `${s.head.hash} ${s.head.subject}` : 'no commits yet'}</span>
      </div>
      <div>
        <${AsyncButton} class="icon-btn sm" icon="arrow-down-to-line" title="Pull: fast-forward this branch from the remote" onClick=${pull} />
        <button class="icon-btn sm" aria-label="Refresh" title="Refresh" onClick=${guarded(() => refreshGit(id))}><${Icon} name="refresh-cw" /></button>
      </div>
    </div>
    <${Modal} open=${branching} label="Branches" class="dialog" onClose=${() => setBranching(false)}>
      <${Branches} id=${id} current=${s.branch} onClose=${() => setBranching(false)} onDone=${after} />
    <//>
    ${s.mr && html`<${MergeRequest} key=${s.mr.branch} id=${id} s=${s} onDone=${() => after()} />`}
    ${!files.length ? html`<${Empty} icon="circle-check" title="No uncommitted changes">Everything in this folder is committed.<//>` : html`
      <section class="file-list">
        <div class="file-list-head">
          <label class="check"><input type="checkbox" checked=${allPicked} indeterminate=${!allPicked && picked.length > 0}
            onChange=${() => setUnpicked(allPicked ? new Set(files.map((f) => f.path)) : new Set())} /><span>${plural(files.length, 'file')}</span></label>
          <span class="diffstat">${totals.add > 0 && html`<b class="add">+${totals.add}</b>`}${totals.del > 0 && html`<b class="del">−${totals.del}</b>`}</span>
        </div>
        ${files.map((f) => {
          const [letter, word] = STATUS(f.status);
          const [dir, name] = splitPath(f.path);
          const d = diffs[f.path];
          const st = d ? diffStats(d) : null;
          return html`<div key=${f.path} class=${cx('file', f.path === current?.path && 'selected')} onClick=${() => setSelected(f.path)}>
            <input type="checkbox" title="Include in the commit" checked=${!unpicked.has(f.path)} onClick=${(e) => e.stopPropagation()} onChange=${() => togglePick(f.path)} />
            <span class=${cx('fstat', letter.toLowerCase())} title=${word}>${letter}</span>
            <span class="fpath" title=${f.from ? `${f.from} → ${f.path}` : f.path}><span class="dim">${dir}</span>${name}</span>
            ${st && html`<span class="diffstat">${st.add > 0 && html`<b class="add">+${st.add}</b>`}${st.del > 0 && html`<b class="del">−${st.del}</b>`}</span>`}
          </div>`;
        })}
      </section>
      <${Modal} open=${!!current} label="Diff" class="diff-modal" onClose=${() => setSelected(null)}>
        ${current && html`<${DiffDialog} files=${files} current=${current} diffs=${diffs} mode=${mode} setMode=${setMode}
          onPick=${setSelected} onRevert=${revert(current)} onClose=${() => setSelected(null)} />`}
      <//>
      <section class="commit-box">
        <div class="field-head"><span>Commit message</span>
          <${AsyncButton} class="btn ghost sm" icon="sparkles" busyText="Generating…" title="Let the agent write a message for the selected files" onClick=${generate}>Generate<//></div>
        <textarea rows="2" value=${message} placeholder="feat: …" onInput=${(e) => setMessage(e.currentTarget.value)}></textarea>
        <div class="row">
          <${AsyncButton} class="btn primary" icon="git-commit-horizontal" onClick=${commit} disabled=${!picked.length}>
            ${allPicked ? 'Commit & push' : `Commit ${picked.length} & push`}<//>
          <div class="spacer"></div>
          <button class="btn ghost danger sm" onClick=${discard}><${Icon} name="trash-2" />Discard all</button>
        </div>
      </section>`}
  </div>`;
}

// The Changes tab: what git sees in the folder the chat's agent works in. Pick files, read their diffs, commit and push,
// revert, discard, and for a worktree chat open a Merge Request.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Empty, Icon, Seg, Spinner } from './ui.js';
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

function Worktree({ id, s, onDone }) {
  const w = s.worktree;
  const [mrText, setMrText] = useState('');
  const [description, setDescription] = useState('');
  const generate = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/mr-description`, { method: 'POST' });
    setDescription(r.description);
    setMrText(r.message);
  });
  // Pushes the branch and opens a Merge Request (GitLab) or pull request (GitHub) into the branch the chat started from.
  const create = guarded(async () => {
    if (!confirm(`Push ${w.branch} and open a Merge Request into ${w.base}?`)) return;
    const [title = '', ...rest] = mrText.trim().split('\n');
    const r = await api(`/api/conversations/${id}/git/pull-request`, { method: 'POST', body: { title: title.trim(), body: rest.join('\n').trim() } });
    toast(r.existed ? 'A Merge Request was already open for this branch' : `Merge Request opened${pushNote(r.push)}`);
    await onDone();
  });
  return html`<section class="branch-card">
    <div class="branch-line"><${Icon} name="git-branch" /><code>${w.branch}</code><${Icon} name="chevron-right" class="tiny dim" /><code>${w.base || 'detached HEAD'}</code></div>
    <div class="dim small">Own worktree · ${w.ahead ? `${plural(w.ahead, 'commit')} not in ${w.base || 'the project folder'} yet` : 'nothing to propose yet'}</div>
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

export function ChangesPane({ id }) {
  const s = chat.git.value;
  const files = s?.files || [];
  const [unpicked, setUnpicked] = useState(new Set());
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState(innerWidth > 1500 ? 'split' : 'unified');
  const [message, setMessage] = useState('');
  const [diffs, loadDiff] = useDiffs(id, files);

  useEffect(() => { setUnpicked(new Set()); setSelected(null); setMessage(''); }, [id]);
  const current = files.find((f) => f.path === selected) || files[0];
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
      <div class="dim small"><${Icon} name="git-branch" class="tiny" /> ${s.branch || 'detached HEAD'}${s.head ? ` · ${s.head.hash} ${s.head.subject}` : ' · no commits yet'}</div>
      <button class="icon-btn sm" aria-label="Refresh" title="Refresh" onClick=${guarded(() => refreshGit(id))}><${Icon} name="refresh-cw" /></button>
    </div>
    ${s.worktree && html`<${Worktree} id=${id} s=${s} onDone=${() => after()} />`}
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
      ${current && html`<section class="diff">
        <div class="diff-toolbar">
          <code title=${current.path}>${current.path}</code>
          <${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />
          <button class="icon-btn sm danger" aria-label="Revert this file" title=${current.status === '??' ? 'Delete this new file' : 'Undo the changes to this file'} onClick=${revert(current)}><${Icon} name="undo-2" /></button>
        </div>
        ${diffs[current.path] == null ? html`<div class="pane-loading"><${Spinner} /> Loading diff…</div>` : html`<${DiffView} diff=${diffs[current.path]} path=${current.path} mode=${mode} />`}
      </section>`}
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

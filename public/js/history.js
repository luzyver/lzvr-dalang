// History: the commits of every branch in the chat's folder, newest first, with the branches drawn as a graph beside
// them (like `git log --graph`). Branch and tag names sit on the commits they point at. A commit opens to what it
// changed: its message, its files and each file's diff; from there it can be cherry-picked, reverted or tagged. Compare
// shows two branches, tags or commits side by side.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Icon, Seg, Spinner } from './ui.js';
import { guarded } from './store.js';
import { DiffView, diffStats } from './diff.js';
import { copyText } from './code.js';
import { Compare } from './compare.js';
import { opNote } from './git-sync.js';

const ROW = 30; // px per commit
const LANE = 14; // px between lanes
const COLORS = 8; // lane colours, .lane-0 … .lane-7 in app.css

/**
 * Lay the commits out in lanes. Each lane waits for one commit (the parent of the one above it); a commit takes the
 * lane that waits for it, its first parent carries on there, any other parent gets a lane of its own. For every row:
 * its lane `col` and the lines to draw, in lane units, from the top of the row (y 0) through its dot (y .5) to the
 * bottom (y 1).
 */
export function layout(commits) {
  let lanes = [];
  let width = 1;
  const rows = commits.map((c) => {
    const top = lanes;
    let col = top.indexOf(c.hash);
    if (col === -1) { col = top.indexOf(null); if (col === -1) col = top.length; }
    const next = top.map((h) => (h === c.hash ? null : h));
    const lines = [];
    top.forEach((h, i) => { if (h === c.hash) lines.push([i, 0, col, 0.5, i]); });
    const free = () => { const i = next.indexOf(null); return i === -1 ? next.length : i; };
    c.parents.forEach((p, k) => {
      let j = next.indexOf(p);
      if (k === 0 && j > col) { // another lane already waits for it: fold that one in here, so the line stays on the left
        lines.push([j, 0, col, 1, j]);
        next[j] = null;
        j = -1;
      }
      if (j === -1) { j = k === 0 ? col : free(); next[j] = p; }
      lines.push([col, 0.5, j, 1, k === 0 ? col : j]);
    });
    next.forEach((h, i) => { if (h && top[i] === h) lines.push([i, 0, i, 1, i]); }); // passing by
    while (next.length && next[next.length - 1] == null) next.pop();
    width = Math.max(width, top.length, next.length, col + 1);
    lanes = next;
    return { col, lines };
  });
  return { rows, width };
}

/** One row's slice of the graph: straight lines, bent ones where a lane joins or leaves, and the commit's dot. */
function Graph({ row, width, merge }) {
  const x = (lane) => LANE / 2 + lane * LANE;
  const y = (v) => v * ROW;
  return html`<svg class="graph" width=${width * LANE} height=${ROW} aria-hidden="true">
    ${row.lines.map(([a, ya, b, yb, color]) => {
      const d = a === b ? `M${x(a)} ${y(ya)}V${y(yb)}`
        : `M${x(a)} ${y(ya)}C${x(a)} ${y((ya + yb) / 2)} ${x(b)} ${y((ya + yb) / 2)} ${x(b)} ${y(yb)}`;
      return html`<path class=${`lane-${color % COLORS}`} d=${d} />`;
    })}
    <circle class=${cx(`lane-${row.col % COLORS}`, merge && 'merge')} cx=${x(row.col)} cy=${ROW / 2} r=${merge ? 3 : 4} />
  </svg>`;
}

const day = (s) => new Date(s * 1000).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });

/** A ref from `git log --decorate`: where HEAD is, a local branch, a remote one or a tag. */
function Ref({ name, remotes }) {
  const head = name.startsWith('HEAD -> ');
  const tag = name.startsWith('tag: ');
  const label = head ? name.slice(8) : tag ? name.slice(5) : name;
  const remote = !head && !tag && remotes.some((r) => label.startsWith(`${r}/`));
  return html`<span class=${cx('ref', head && 'head', tag && 'tag', remote && 'remote')} title=${name}>
    ${tag && html`<span class="dim">tag </span>`}${label}</span>`;
}

const STATUS = { A: 'added', D: 'deleted', R: 'renamed', C: 'copied', T: 'type changed' };
const MAX_DIFFS = 50; // files whose diff (and so their +/− counts) is fetched at once; the rest when opened

const Stats = ({ diff }) => {
  const st = diff ? diffStats(diff) : null;
  return st && html`<span class="diffstat">${st.add > 0 && html`<b class="add">+${st.add}</b>`}${st.del > 0 && html`<b class="del">−${st.del}</b>`}</span>`;
};

/** Tag a commit, annotated when there is a message, and push the tag along when asked. */
function TagForm({ id, hash, onClose, onDone }) {
  const [name, setName] = useState('');
  const [message, setMessage] = useState('');
  const [push, setPush] = useState(true);
  const save = guarded(async (e) => {
    e?.preventDefault();
    const r = await api(`/api/conversations/${id}/git/tags`, { method: 'POST', body: { name: name.trim(), hash, message: message.trim(), push } });
    onClose();
    await onDone(`Tagged ${r.tag}${!r.push ? '' : r.push.error ? ` · push failed: ${r.push.error}` : r.push.pushed ? ` · pushed to ${r.push.pushed}` : ' · not pushed (no remote)'}`);
  });
  return html`<form class="tag-form" onSubmit=${save}>
    <input class="mono" value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="v1.2.0" autofocus aria-label="Tag name" />
    <input value=${message} onInput=${(e) => setMessage(e.currentTarget.value)} placeholder="Message (optional: makes it annotated)" aria-label="Tag message" />
    <label class="check small"><input type="checkbox" checked=${push} onChange=${(e) => setPush(e.currentTarget.checked)} /><span>Push it</span></label>
    <${AsyncButton} class="btn primary sm" icon="tag" disabled=${!name.trim()} onClick=${save}>Tag<//>
    <button type="button" class="btn ghost sm" onClick=${onClose}>Cancel</button>
  </form>`;
}

/** What one commit changed: its message, the files (pick one) and that file's diff against the commit's first parent. */
export function CommitView({ id, hash, remotes, onBack, onDone, path: initialPath, backLabel = 'History' }) {
  const [c, setC] = useState(null);
  const [error, setError] = useState('');
  const [diffs, setDiffs] = useState({});
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState(innerWidth > 1100 ? 'split' : 'unified');
  const [tagging, setTagging] = useState(false);
  const fetchDiff = (path) => {
    setDiffs((d) => (path in d ? d : { ...d, [path]: null }));
    api(`/api/conversations/${id}/git/commits/${hash}/diff?path=${encodeURIComponent(path)}`)
      .then((r) => setDiffs((d) => ({ ...d, [path]: r.diff })), () => setDiffs((d) => ({ ...d, [path]: '' })));
  };
  useEffect(() => {
    setC(null); setDiffs({}); setSelected(null); setError(''); setTagging(false);
    api(`/api/conversations/${id}/git/commits/${hash}`).then((r) => {
      setC(r);
      setSelected(r.files.some((f) => f.path === initialPath) ? initialPath : r.files[0]?.path ?? null);
      r.files.slice(0, MAX_DIFFS).forEach((f) => fetchDiff(f.path));
    }, (e) => setError(e.message));
  }, [id, hash]);
  const pick = (path) => { setSelected(path); if (!(path in diffs)) fetchDiff(path); };
  const file = c?.files.find((f) => f.path === selected);
  const d = file && diffs[file.path];
  // Copy this commit onto the checked-out branch, or add one that undoes it. Either may stop on conflicts.
  const apply = (how) => guarded(async () => {
    const what = how === 'revert' ? 'Add a commit that undoes this one' : 'Copy this commit onto the checked-out branch';
    if (!await confirmDialog({ title: how === 'revert' ? 'Revert this commit?' : 'Cherry-pick this commit?', message: `${what}:\n${c.subject}`, confirmText: how === 'revert' ? 'Revert' : 'Cherry-pick' })) return;
    const r = await api(`/api/conversations/${id}/git/commits/${c.hash}/${how}`, { method: 'POST' });
    await onDone?.(opNote(r, `${how === 'revert' ? 'Reverted' : 'Cherry-picked'} as ${r.commit}`));
  });
  const head = html`<div class="dialog-head">
    <button class="btn ghost sm" onClick=${onBack}><${Icon} name="chevron-left" />${backLabel}</button>
    <div class="spacer"></div>
    ${c && onDone && html`<div class="commit-actions">
      <${AsyncButton} class="btn ghost sm" icon="git-commit-horizontal" title="Copy this commit onto the checked-out branch" onClick=${apply('cherry-pick')}>Cherry-pick<//>
      <${AsyncButton} class="btn ghost sm" icon="undo-2" title="Add a commit that undoes this one" onClick=${apply('revert')}>Revert<//>
      <button class="btn ghost sm" title="Tag this commit" onClick=${() => setTagging(!tagging)}><${Icon} name="tag" />Tag</button>
    </div>`}
    ${c?.files.length > 0 && html`<${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />`}
  </div>`;
  if (error) return html`${head}<div class="form-error">${error}</div>`;
  if (!c) return html`${head}<div class="dim small"><${Spinner} /> Loading…</div>`;
  return html`${head}
    ${tagging && html`<${TagForm} id=${id} hash=${c.hash} onClose=${() => setTagging(false)} onDone=${onDone} />`}
    <div class="commit-head">
      <div class="commit-subject">${c.refs.map((r) => html`<${Ref} name=${r} remotes=${remotes} />`)}${c.subject}</div>
      ${c.body && html`<pre class="commit-body">${c.body}</pre>`}
      <div class="log-meta dim">
        <button class="log-hash mono" title="Copy the full hash" onClick=${() => copyText(c.hash, 'Hash copied')}>${c.hash.slice(0, 7)}</button>
        <span>${c.author}</span><span>${new Date(c.date * 1000).toLocaleString()}</span>
        ${c.parents.length > 1 && html`<span>merge: changes against ${c.parents[0].slice(0, 7)}</span>`}
      </div>
    </div>
    ${!c.files.length ? html`<div class="dim small">This commit changed no files${c.parents.length > 1 ? ' against its first parent' : ''}.</div>` : html`
      <div class="commit-split">
        <div class="commit-files">
          ${c.files.map((f) => {
            const i = f.path.lastIndexOf('/');
            const letter = f.status in STATUS ? f.status : 'M';
            return html`<button key=${f.path} class=${cx('file', f.path === selected && 'selected')} onClick=${() => pick(f.path)}>
              <span class=${cx('fstat', (letter === 'C' || letter === 'T' ? 'M' : letter).toLowerCase())} title=${STATUS[letter] || 'modified'}>${letter}</span>
              <span class="fpath" title=${f.from ? `${f.from} → ${f.path}` : f.path}><span class="dim">${f.path.slice(0, i + 1)}</span>${f.path.slice(i + 1)}</span>
              <${Stats} diff=${diffs[f.path]} />
            </button>`;
          })}
        </div>
        <div class="commit-diff">
          ${file && html`<div class="commit-diff-path mono" title=${file.path}>${file.from ? `${file.from} → ` : ''}${file.path}</div>`}
          ${d == null ? html`<div class="pane-loading"><${Spinner} /> Loading diff…</div>` : html`<${DiffView} diff=${d} path=${file.path} mode=${mode} />`}
        </div>
      </div>`}`;
}

/** `onDone(message)`: something changed the folder (cherry-pick, revert, tag): refresh what shows it. */
export function History({ id, onClose, onDone }) {
  const [limit, setLimit] = useState(150);
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null); // the commit being looked at
  const [comparing, setComparing] = useState(false);
  const [version, setVersion] = useState(0);
  useEffect(() => {
    api(`/api/conversations/${id}/git/log?limit=${limit}`).then(setData, (e) => setError(e.message));
  }, [id, limit, version]);
  const done = async (message) => { setVersion((v) => v + 1); await onDone?.(message); };
  const { rows, width } = data ? layout(data.commits) : { rows: [], width: 1 };
  const shown = Math.min(width, 12); // a very wide graph would leave no room for the subjects
  // The comparison stays mounted under an opened commit, so going back finds it as it was.
  const compare = comparing && html`<div class="dialog-body history commit-view" hidden=${!!open}>
    <${Compare} id=${id} remotes=${data?.remotes || []} onBack=${() => setComparing(false)} onOpen=${setOpen} />
  </div>`;
  if (open) {
    return html`${compare}<div class="dialog-body history commit-view">
      <${CommitView} id=${id} hash=${open} remotes=${data?.remotes || []} onBack=${() => setOpen(null)} onDone=${done} backLabel=${comparing ? 'Compare' : 'History'} />
    </div>`;
  }
  if (comparing) return compare;
  return html`<div class="dialog-body history">
    <div class="dialog-head"><h2>History</h2>
      <div class="spacer"></div>
      <button class="btn ghost sm" title="Compare two branches, tags or commits" onClick=${() => setComparing(true)}><${Icon} name="git-compare" />Compare</button>
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    ${error && html`<div class="form-error">${error}</div>`}
    ${!data ? !error && html`<div class="dim small"><${Spinner} /> Loading…</div>`
      : !data.commits.length ? html`<div class="dim small">No commits yet.</div>`
      : html`<div class="log" style=${{ '--graph-w': `${shown * LANE}px` }}>
        ${data.commits.map((c, i) => html`<div key=${c.hash} class="log-row" title="Show what this commit changed" onClick=${() => setOpen(c.hash)}>
          <div class="log-graph"><${Graph} row=${rows[i]} width=${width} merge=${c.parents.length > 1} /></div>
          <div class="log-main">
            <span class="log-subject" title=${c.subject}>${c.refs.map((r) => html`<${Ref} name=${r} remotes=${data.remotes} />`)}${c.subject}</span>
            <span class="log-meta dim">
              <button class="log-hash mono" title="Copy the full hash" onClick=${(e) => { e.stopPropagation(); copyText(c.hash, 'Hash copied'); }}>${c.hash.slice(0, 7)}</button>
              <span>${c.author}</span><span title=${new Date(c.date * 1000).toLocaleString()}>${day(c.date)}</span>
            </span>
          </div>
        </div>`)}
      </div>
      ${data.more && html`<button class="btn ghost sm" onClick=${() => setLimit(limit * 2)}>Show older commits</button>`}`}
  </div>`;
}

// Compare: two branches, tags or commits side by side, as a Merge Request from one into the other would show them: the
// commits it would bring, and what it changes against their merge base, file by file.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Icon, Seg, Spinner } from './ui.js';
import { DiffView, diffStats } from './diff.js';
import { plural } from './format.js';

const LETTER = { A: 'a', D: 'd', R: 'r' };
const MAX_DIFFS = 50;

export function Compare({ id, remotes, onBack, onOpen }) {
  const [refs, setRefs] = useState([]);
  const [base, setBase] = useState('');
  const [head, setHead] = useState('');
  const [r, setR] = useState(null);
  const [error, setError] = useState('');
  const [selected, setSelected] = useState(null);
  const [diffs, setDiffs] = useState({});
  const [mode, setMode] = useState(innerWidth > 1100 ? 'split' : 'unified');

  useEffect(() => {
    Promise.all([api(`/api/conversations/${id}/git/branches`), api(`/api/conversations/${id}/git/tags`).catch(() => [])]).then(([b, tags]) => {
      const remote = remotes[0];
      setRefs([...b.local, ...(remote ? b.remote.map((x) => `${remote}/${x}`) : []), ...tags.map((t) => t.name)]);
      // From the checked-out branch into the default one; on the default branch itself, against its remote copy.
      const head0 = b.current || '';
      const main = ['main', 'master'].find((n) => b.local.includes(n) && n !== head0);
      setHead((h) => h || head0);
      setBase((x) => x || main || (remote && head0 ? `${remote}/${head0}` : b.local.find((n) => n !== head0) || ''));
    }, (e) => setError(e.message));
  }, [id]);

  const fetchDiff = (path, q) => {
    setDiffs((d) => (path in d ? d : { ...d, [path]: null }));
    api(`/api/conversations/${id}/git/compare/diff?${q}&path=${encodeURIComponent(path)}`)
      .then((x) => setDiffs((d) => ({ ...d, [path]: x.diff })), () => setDiffs((d) => ({ ...d, [path]: '' })));
  };
  const query = `base=${encodeURIComponent(base.trim())}&head=${encodeURIComponent(head.trim())}`;
  const run = async () => {
    setError('');
    setDiffs({});
    try {
      const x = await api(`/api/conversations/${id}/git/compare?${query}`);
      setR({ ...x, q: query });
      setSelected(x.files[0]?.path ?? null);
      x.files.slice(0, MAX_DIFFS).forEach((f) => fetchDiff(f.path, query));
    } catch (e) { setR(null); setError(e.message); }
  };
  const pick = (path) => { setSelected(path); if (!(path in diffs)) fetchDiff(path, r.q); };
  const file = r?.files.find((f) => f.path === selected);
  const d = file && diffs[file.path];

  return html`<div class="dialog-head">
      <button class="btn ghost sm" onClick=${onBack}><${Icon} name="chevron-left" />History</button>
      <h2>Compare</h2>
      <div class="spacer"></div>
      ${r?.files.length > 0 && html`<${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />`}
    </div>
    <datalist id="compare-refs">${refs.map((x) => html`<option value=${x} />`)}</datalist>
    <form class="row compare-form" onSubmit=${(e) => { e.preventDefault(); run(); }}>
      <input class="mono" list="compare-refs" value=${base} onInput=${(e) => setBase(e.currentTarget.value)} placeholder="into (base)" aria-label="Base" />
      <button type="button" class="icon-btn sm" aria-label="Swap" title="Swap" onClick=${() => { setBase(head); setHead(base); }}><${Icon} name="chevron-left" /></button>
      <input class="mono" list="compare-refs" value=${head} onInput=${(e) => setHead(e.currentTarget.value)} placeholder="from (head)" aria-label="Head" />
      <${AsyncButton} class="btn primary sm" icon="git-compare" disabled=${!base.trim() || !head.trim()} onClick=${run}>Compare<//>
    </form>
    ${error && html`<div class="form-error">${error}</div>`}
    ${r && html`<div class="dim small">${r.commits.length ? `${plural(r.commits.length, 'commit')} on ${r.head} that ${r.base} lacks` : `${r.head} has nothing ${r.base} lacks`}${
      r.behind ? ` · ${r.base} has ${plural(r.behind, 'commit')} ${r.head} lacks` : ''} · ${plural(r.files.length, 'file')} changed</div>
      ${r.commits.length > 0 && html`<div class="log compare-log">${r.commits.map((c) => html`<div key=${c.hash} class="log-row" title="Show what this commit changed" onClick=${() => onOpen(c.hash)}>
        <div class="log-main"><span class="log-subject">${c.subject}</span>
          <span class="log-meta dim"><span class="mono">${c.hash.slice(0, 7)}</span><span>${c.author}</span></span></div>
      </div>`)}</div>`}
      ${r.files.length > 0 && html`<div class="commit-split">
        <div class="commit-files">${r.files.map((f) => {
          const i = f.path.lastIndexOf('/');
          const st = diffs[f.path] ? diffStats(diffs[f.path]) : null;
          return html`<button key=${f.path} class=${cx('file', f.path === selected && 'selected')} onClick=${() => pick(f.path)}>
            <span class=${cx('fstat', LETTER[f.status] || 'm')}>${f.status}</span>
            <span class="fpath" title=${f.path}><span class="dim">${f.path.slice(0, i + 1)}</span>${f.path.slice(i + 1)}</span>
            ${st && html`<span class="diffstat">${st.add > 0 && html`<b class="add">+${st.add}</b>`}${st.del > 0 && html`<b class="del">−${st.del}</b>`}</span>`}
          </button>`;
        })}</div>
        <div class="commit-diff">
          ${file && html`<div class="commit-diff-path mono" title=${file.path}>${file.from ? `${file.from} → ` : ''}${file.path}</div>`}
          ${d == null ? html`<div class="pane-loading"><${Spinner} /> Loading diff…</div>` : html`<${DiffView} diff=${d} path=${file.path} mode=${mode} />`}
        </div>
      </div>`}`}`;
}

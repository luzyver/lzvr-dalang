// The code editor's Search view (Ctrl+Shift+F, or Ctrl+Shift+H with replace): find text in every file of the chat's
// folder, as in VS Code's sidebar: match case, whole word, regex, files to include and exclude, and replace all.
import { useEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { confirmDialog, Icon, Spinner } from './ui.js';
import { toast } from './store.js';

const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');

/** What the Search view holds, so it survives switching to Files and back. */
export const search = {
  query: signal(''),
  replace: signal(''),
  showReplace: signal(false),
  showFilters: signal(false),
  matchCase: signal(false),
  word: signal(false),
  regex: signal(false),
  include: signal(''),
  exclude: signal(''),
  /** { results, count, truncated } | { error } | null */
  result: signal(null),
  busy: signal(false),
  collapsed: signal(new Set()),
  /** goes up to focus the query box (Ctrl+Shift+F while the view is already open) */
  focus: signal(0),
};

const body = () => ({
  query: search.query.value, regex: search.regex.value, matchCase: search.matchCase.value, word: search.word.value,
  include: search.include.value, exclude: search.exclude.value,
});

let seq = 0;
export async function runSearch(convId) {
  const q = search.query.value;
  const mine = ++seq;
  if (!q) { search.result.value = null; search.busy.value = false; return; }
  search.busy.value = true;
  try {
    const r = await api(`/api/conversations/${convId}/fs/search`, { method: 'POST', body: body() });
    if (mine === seq) search.result.value = r;
  } catch (e) {
    if (mine === seq) search.result.value = { error: e.message };
  } finally {
    if (mine === seq) search.busy.value = false;
  }
}

/** The preview line with the match marked. */
function Preview({ m }) {
  const before = m.preview.slice(0, m.at);
  const hit = m.preview.slice(m.at, m.at + m.len);
  const after = m.preview.slice(m.at + m.len);
  const rep = search.showReplace.value && search.replace.value !== undefined;
  return html`<span class="sr-preview">${m.col - 1 > m.at ? '…' : ''}${before.trimStart()}<mark class=${cx(rep && 'del')}>${hit}</mark>${rep && html`<mark class="ins">${search.replace.value}</mark>`}${after}</span>`;
}

const Toggle = ({ on, title, label, onClick }) => html`<button class=${cx('sr-toggle', on.value && 'on')} title=${title} aria-pressed=${on.value} onClick=${onClick || (() => { on.value = !on.value; })}>${label}</button>`;

/**
 * `onOpen(path, { line, col, len })` opens a file at a match. `canWrite` / `writeBlocked`: replacing follows the
 * editor's rules. `onReplaced` lets open tabs pick up the new contents.
 */
export function SearchView({ convId, shown, canWrite, writeBlocked, onOpen, onReplaced }) {
  const input = useRef(null);
  const [replacing, setReplacing] = useState(false);
  const r = search.result.value;

  // Search as you type (a short pause first), and again when an option changes.
  const deps = [search.query.value, search.matchCase.value, search.word.value, search.regex.value, search.include.value, search.exclude.value];
  useEffect(() => {
    const t = setTimeout(() => runSearch(convId), 300);
    return () => clearTimeout(t);
  }, deps);

  useEffect(() => {
    if (!shown) return;
    const el = input.current;
    el?.focus();
    el?.select();
  }, [shown, search.focus.value]);

  const replaceAll = async () => {
    if (!canWrite) { toast(writeBlocked, 'err'); return; }
    if (!r?.results?.length) return;
    const n = r.count;
    const files = r.results.length;
    if (!await confirmDialog({
      title: `Replace ${n}${r.truncated ? '+' : ''} ${n === 1 ? 'match' : 'matches'}?`,
      message: `"${search.query.value}" becomes "${search.replace.value}" in ${files} ${files === 1 ? 'file' : 'files'}. Files with unsaved changes in the editor keep yours until you reload them.`,
      confirmText: 'Replace all', danger: true,
    })) return;
    setReplacing(true);
    try {
      const out = await api(`/api/conversations/${convId}/fs/replace`, {
        method: 'POST', body: { ...body(), replace: search.replace.value, paths: r.results.map((f) => f.path) },
      });
      toast(`replaced ${out.replacements} ${out.replacements === 1 ? 'match' : 'matches'} in ${out.files} ${out.files === 1 ? 'file' : 'files'}`);
      onReplaced?.();
      await runSearch(convId);
    } catch (e) { toast(e.message, 'err'); } finally { setReplacing(false); }
  };

  const toggleFile = (path) => {
    const next = new Set(search.collapsed.value);
    if (next.has(path)) next.delete(path); else next.add(path);
    search.collapsed.value = next;
  };
  const collapsed = search.collapsed.value;

  // Alt+C, Alt+W and Alt+R switch the options while typing in the view, as in VS Code.
  const keys = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey) return;
    const opt = { c: search.matchCase, w: search.word, r: search.regex }[e.key.toLowerCase()];
    if (opt) { e.preventDefault(); e.stopPropagation(); opt.value = !opt.value; }
  };

  return html`<section class="search-pane" aria-label="Search" onKeyDown=${keys}>
    <div class="pane-head">
      <span class="pane-title">Search</span>
      <div class="spacer"></div>
      ${search.busy.value && html`<${Spinner} class="tiny dim" />`}
      <button class="icon-btn sm" aria-label="Refresh" title="Search again" onClick=${() => runSearch(convId)}><${Icon} name="refresh-cw" /></button>
      <button class="icon-btn sm" aria-label="Collapse all" title="Collapse all" disabled=${!r?.results?.length}
        onClick=${() => { search.collapsed.value = new Set(r.results.map((f) => f.path)); }}><${Icon} name="minimize-2" /></button>
    </div>
    <div class="sr-form">
      <div class="sr-row">
        <button class="icon-btn xs sr-expand" aria-label="Toggle replace" title="Toggle replace (Ctrl+Shift+H)" aria-expanded=${search.showReplace.value}
          onClick=${() => { search.showReplace.value = !search.showReplace.value; }}><${Icon} name=${search.showReplace.value ? 'chevron-down' : 'chevron-right'} /></button>
        <div class="sr-field">
          <input ref=${input} placeholder="Search" value=${search.query.value} spellcheck="false" autocomplete="off" aria-label="Search"
            onInput=${(e) => { search.query.value = e.currentTarget.value; }}
            onKeyDown=${(e) => { if (e.key === 'Enter') runSearch(convId); }} />
          <${Toggle} on=${search.matchCase} title="Match case (Alt+C)" label="Aa" />
          <${Toggle} on=${search.word} title="Match whole word (Alt+W)" label=${html`<u>ab</u>`} />
          <${Toggle} on=${search.regex} title="Use regular expression (Alt+R)" label=".*" />
        </div>
      </div>
      ${search.showReplace.value && html`<div class="sr-row">
        <span class="sr-indent"></span>
        <div class="sr-field">
          <input placeholder=${search.regex.value ? 'Replace ($1, $& work)' : 'Replace'} value=${search.replace.value} spellcheck="false" autocomplete="off" aria-label="Replace"
            onInput=${(e) => { search.replace.value = e.currentTarget.value; }}
            onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) replaceAll(); }} />
          <button class="sr-toggle" title="Replace all (Ctrl+Enter)" aria-label="Replace all" disabled=${replacing || !r?.results?.length || !canWrite} onClick=${replaceAll}>
            ${replacing ? html`<${Spinner} class="tiny" />` : html`<${Icon} name="check" />`}</button>
        </div>
      </div>`}
      <div class="sr-row">
        <span class="sr-indent"></span>
        <button class="sr-more" onClick=${() => { search.showFilters.value = !search.showFilters.value; }}>
          ${search.showFilters.value ? 'Hide' : 'Files to include / exclude'}</button>
      </div>
      ${search.showFilters.value && html`
        <div class="sr-row"><span class="sr-indent"></span><input class="sr-filter" placeholder="files to include (e.g. src/**, *.ts)" value=${search.include.value}
          spellcheck="false" aria-label="Files to include" onInput=${(e) => { search.include.value = e.currentTarget.value; }} /></div>
        <div class="sr-row"><span class="sr-indent"></span><input class="sr-filter" placeholder="files to exclude (e.g. *.min.js, docs/)" value=${search.exclude.value}
          spellcheck="false" aria-label="Files to exclude" onInput=${(e) => { search.exclude.value = e.currentTarget.value; }} /></div>`}
    </div>
    <div class="sr-results">
      ${r?.error && html`<div class="sr-note err">${r.error}</div>`}
      ${r?.results && html`<div class="sr-note">${r.count ? `${r.count}${r.truncated ? '+' : ''} ${r.count === 1 ? 'result' : 'results'} in ${r.results.length} ${r.results.length === 1 ? 'file' : 'files'}${r.truncated ? ' (showing the first ones)' : ''}` : 'No results.'}</div>`}
      ${r?.results?.map((f) => html`<div key=${f.path} class="sr-file">
        <div class="sr-file-head" title=${f.path} onClick=${() => toggleFile(f.path)}>
          <${Icon} name=${collapsed.has(f.path) ? 'chevron-right' : 'chevron-down'} class="tiny" /><${Icon} name="file" class="tree-icon" />
          <span class="sr-file-name">${nameOf(f.path)}</span><span class="sr-file-dir">${parentOf(f.path)}</span>
          <span class="sr-count">${f.matches.length}</span>
        </div>
        ${!collapsed.has(f.path) && f.matches.map((m) => html`<div class="sr-match" title=${`${f.path}:${m.line}:${m.col}`}
          onClick=${() => onOpen(f.path, { line: m.line, col: m.col, len: m.len })}><${Preview} m=${m} /></div>`)}
      </div>`)}
    </div>
  </section>`;
}

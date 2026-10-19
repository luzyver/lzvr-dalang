// The SQL editor's result grid: rows of one result, a panel with the selected cell's whole value (JSON laid out), and,
// for a result that is a table's rows (SELECT * FROM a table with a primary key), a WHERE filter, sorting by a column
// on the server, and editing: change cells, add and delete rows, see the statements they make, then submit them in
// one transaction (after seeing them once more).
import { useEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { AsyncButton, Icon, Modal, Spinner } from './ui.js';
import { copyText } from './code.js';
import { toast } from './store.js';

/** Rows drawn at first (and per "show more"); a result may hold up to the row limit. */
const PAGE = 500;
/** An added row's cell nobody set: the column's default. */
const UNSET = Symbol('default');

const text = (v) => (v === null || v === UNSET ? null : String(v));
/** A value as JSON laid out, if it is an object or array in JSON; else null. */
function prettyJson(s) {
  const t = s?.trim();
  if (!t || (t[0] !== '{' && t[0] !== '[')) return null;
  try { return JSON.stringify(JSON.parse(t), null, 2); } catch { return null; }
}

/** The selected cell's column, type and whole value; editable cells get a text box, Set NULL and Apply. */
function ValuePanel({ col, value, editable, onApply, onClose }) {
  const s = text(value);
  const [draft, setDraft] = useState(s ?? '');
  const box = useRef(null);
  useEffect(() => { setDraft(s ?? ''); }, [s, col.name]);
  const json = prettyJson(s);
  return html`<aside class="sql-value" aria-label="Value">
    <div class="pane-head"><span class="pane-title" title=${col.type}>${col.name}</span><small class="dim mono">${col.type}</small><div class="spacer"></div>
      ${s != null && html`<button class="icon-btn xs" title="Copy the value" aria-label="Copy the value" onClick=${() => copyText(s, 'value copied')}><${Icon} name="copy" /></button>`}
      <button class="icon-btn xs" title="Close (Esc)" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    ${editable ? html`
      <textarea ref=${box} class="mono sql-value-edit" value=${draft} placeholder=${value === UNSET ? 'default' : s === null ? 'NULL' : ''}
        onInput=${(e) => setDraft(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); onApply(draft); } }}></textarea>
      <div class="row wrap sql-value-actions">
        <button class="btn primary sm" title="Ctrl+Enter" onClick=${() => onApply(draft)}>Apply</button>
        <button class="btn sm" onClick=${() => onApply(null)}>Set NULL</button>
        ${json && html`<button class="btn ghost sm" onClick=${() => setDraft(json)}>Lay out JSON</button>`}
      </div>`
      : s === null ? html`<div class="sql-value-body dim small"><em>${value === UNSET ? 'default' : 'NULL'}</em></div>`
        : html`<pre class="sql-value-body mono">${json ?? s}</pre>`}
    ${s != null && s.endsWith('…') && html`<div class="small dim sql-value-note">Long values are cut at 20 000 characters here.</div>`}
  </aside>`;
}

/** The statements the pending edits make, as the server would run them (values written in). */
function Statements({ list, error }) {
  if (error) return html`<div class="form-error" role="alert">${error}</div>`;
  if (!list) return html`<div class="pane-loading"><${Spinner} /></div>`;
  return html`<pre class="mono sql-preview">${list.join('\n')}</pre>`;
}

/**
 * One result. `table` (a table's own rows: { pk, where, order }) turns on the filter, server-side sorting and, unless
 * `readOnly`, editing. `onQuery({ where, order })` reads the table again; `onPreview(edits)` answers the statements
 * they make; `onSubmit(edits)` saves.
 */
export function ResultGrid({ r, table, readOnly, onQuery, onPreview, onSubmit }) {
  const [pages, setPages] = useState(1);
  const [sel, setSel] = useState(null); // { row, col } (rows past r.rows.length are added ones)
  const [changes, setChanges] = useState(new Map()); // row -> Map(col -> value)
  const [added, setAdded] = useState([]); // arrays of values (UNSET for untouched)
  const [deleted, setDeleted] = useState(new Set());
  const [where, setWhere] = useState(table?.where ?? '');
  const [localSort, setLocalSort] = useState(null); // { col, desc } for results that are not a table's rows
  const [showSql, setShowSql] = useState(false);
  const [preview, setPreview] = useState({ list: null, error: null });
  const [confirming, setConfirming] = useState(false);
  const [widths, setWidths] = useState({}); // column name -> px, or 'fit' (as wide as its values), set by dragging a header's edge
  useEffect(() => { setSel(null); setChanges(new Map()); setAdded([]); setDeleted(new Set()); setPages(1); setWhere(table?.where ?? ''); }, [r]);

  const editable = !!table && !readOnly;
  const pending = changes.size + added.length + deleted.size;
  const cols = r.columns;
  let rows = r.rows.map((row, i) => ({ i, row }));
  if (!table && localSort) {
    const k = localSort.col;
    const cmp = (a, b) => (a === null ? 1 : b === null ? -1 : typeof a === 'number' && typeof b === 'number' ? a - b : String(a).localeCompare(String(b), undefined, { numeric: true }));
    rows = [...rows].sort((a, b) => cmp(a.row[k], b.row[k]) * (localSort.desc ? -1 : 1));
  }
  const shown = rows.slice(0, pages * PAGE);
  const valueAt = (i, c) => (i >= r.rows.length ? added[i - r.rows.length][c] : changes.get(i)?.has(c) ? changes.get(i).get(c) : r.rows[i][c]);

  const apply = (v) => {
    const { row: i, col: c } = sel;
    if (i >= r.rows.length) {
      setAdded(added.map((a, k) => (k === i - r.rows.length ? a.map((x, j) => (j === c ? v : x)) : a)));
      return;
    }
    const next = new Map(changes);
    const m = new Map(next.get(i));
    // Back to what the database has: no change.
    if (text(v) === text(r.rows[i][c])) m.delete(c); else m.set(c, v);
    if (m.size) next.set(i, m); else next.delete(i);
    setChanges(next);
  };
  const addRow = () => {
    setAdded([...added, cols.map(() => UNSET)]);
    setSel({ row: r.rows.length + added.length, col: 0 });
  };
  const toggleDelete = () => {
    if (!sel) return;
    if (sel.row >= r.rows.length) { setAdded(added.filter((_, k) => k !== sel.row - r.rows.length)); setSel(null); return; }
    const next = new Set(deleted);
    if (next.has(sel.row)) next.delete(sel.row); else next.add(sel.row);
    setDeleted(next);
  };
  const revert = () => { setChanges(new Map()); setAdded([]); setDeleted(new Set()); };
  const keyOf = (i) => Object.fromEntries(table.pk.map((name) => [name, text(r.rows[i][cols.findIndex((c) => c.name === name)])]));
  const editsOf = () => [
    ...[...changes].filter(([i]) => !deleted.has(i)).map(([i, m]) => ({ kind: 'update', key: keyOf(i), set: Object.fromEntries([...m].map(([c, v]) => [cols[c].name, text(v)])) })),
    ...added.map((a) => ({ kind: 'insert', values: Object.fromEntries(a.map((v, c) => [cols[c].name, v]).filter(([, v]) => v !== UNSET).map(([k, v]) => [k, text(v)])) })),
    ...[...deleted].map((i) => ({ kind: 'delete', key: keyOf(i) })),
  ];
  // The statements, read again (shortly after the last edit) while the SQL pane or the confirmation shows them.
  useEffect(() => {
    if (!pending || !(showSql || confirming)) { setPreview({ list: null, error: null }); return undefined; }
    let live = true;
    const t = setTimeout(() => {
      onPreview(editsOf()).then((list) => { if (live) setPreview({ list, error: null }); }, (e) => { if (live) setPreview({ list: null, error: e.message }); });
    }, 250);
    return () => { live = false; clearTimeout(t); };
  }, [changes, added, deleted, showSql, confirming]);
  const submit = async () => {
    if (await onSubmit(editsOf())) { revert(); setConfirming(false); }
  };
  const sortBy = (c) => {
    if (table) {
      const o = table.order;
      const order = o?.col === cols[c].name ? (o.desc ? null : { col: cols[c].name, desc: true }) : { col: cols[c].name, desc: false };
      if (pending) { toast('submit or revert your changes first', 'err'); return; }
      onQuery({ where, order });
    } else {
      setLocalSort(localSort?.col === c ? (localSort.desc ? null : { col: c, desc: true }) : { col: c, desc: false });
    }
  };
  const sortOf = (c) => (table ? (table.order?.col === cols[c].name ? table.order : null) : localSort?.col === c ? localSort : null);

  useEffect(() => {
    const esc = (e) => { if (e.key === 'Escape' && sel && !e.defaultPrevented && !e.target.closest?.('.cm-editor, dialog')) setSel(null); };
    addEventListener('keydown', esc);
    return () => removeEventListener('keydown', esc);
  }, [sel]);

  const cell = (i, c, v) => {
    const s = text(v);
    const isSel = sel?.row === i && sel.col === c;
    const changed = i < r.rows.length && changes.get(i)?.has(c);
    const pick = () => setSel({ row: i, col: c });
    const cls = cx(typeof v === 'number' && 'num', isSel && 'sel', changed && 'changed');
    if (s === null) return html`<td class=${cx(cls, 'null')} style=${widthOf(c)} onClick=${pick}>${v === UNSET ? 'default' : 'NULL'}</td>`;
    return html`<td class=${cls} style=${widthOf(c)} onClick=${pick} onDblClick=${pick}>${s.length > 300 ? `${s.slice(0, 300)}…` : s}</td>`;
  };

  const widthOf = (c) => {
    const w = widths[cols[c].name];
    return w === 'fit' ? 'max-width: none' : w ? `width: ${w}px; min-width: ${w}px; max-width: ${w}px` : undefined;
  };
  // Drag a header's right edge to size its column; double-click it to fit the column's values (again: back to default).
  const resize = (e, c) => {
    e.preventDefault();
    e.stopPropagation();
    const el = e.currentTarget;
    const x0 = e.clientX;
    const w0 = el.parentElement.getBoundingClientRect().width;
    el.setPointerCapture(e.pointerId);
    document.body.classList.add('resizing-v');
    const move = (m) => setWidths((ws) => ({ ...ws, [cols[c].name]: Math.max(40, Math.round(w0 + m.clientX - x0)) }));
    const up = () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      document.body.classList.remove('resizing-v');
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
  };
  const fit = (e, c) => {
    e.stopPropagation();
    const name = cols[c].name;
    setWidths((ws) => { const next = { ...ws }; if (next[name] === 'fit') delete next[name]; else next[name] = 'fit'; return next; });
  };

  const selCol = sel && cols[sel.col];
  return html`<div class="sql-grid-area">
    ${table && html`<div class="sql-filter">
      <span class="sql-filter-label mono">WHERE</span>
      <input class="mono" value=${where} placeholder="a condition, e.g. id > 100 (Enter to apply)"
        onInput=${(e) => setWhere(e.currentTarget.value)}
        onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); if (pending) toast('submit or revert your changes first', 'err'); else onQuery({ where, order: table.order }); } }} />
      ${table.order && html`<span class="ide-chip" title="Sorted on the server">${table.order.col} ${table.order.desc ? '↓' : '↑'}</span>`}
      ${editable && html`
        <button class="btn sm" title="Add a row" onClick=${addRow}><${Icon} name="plus" />Add row</button>
        <button class="btn sm" title="Delete the selected row (again: keep it)" disabled=${!sel} onClick=${toggleDelete}><${Icon} name="trash-2" />Delete row</button>
        ${pending > 0 && html`
          <button class="btn ghost sm" onClick=${revert}><${Icon} name="undo-2" />Revert</button>
          <button class=${cx('btn sm', showSql && 'on')} aria-pressed=${showSql} title="The statements these changes make" onClick=${() => setShowSql(!showSql)}>
            <${Icon} name="code-xml" />SQL</button>
          <button class="btn primary sm" onClick=${() => setConfirming(true)}><${Icon} name="check" />Submit ${pending}</button>`}`}
    </div>`}
    ${editable && showSql && pending > 0 && html`<div class="sql-preview-pane">
      <div class="row small dim"><span>Runs in one transaction; the values go as parameters.</span><div class="spacer"></div>
        ${preview.list && html`<button class="btn ghost sm" onClick=${() => copyText(preview.list.join('\n'), 'SQL copied')}><${Icon} name="copy" />Copy</button>`}</div>
      <${Statements} ...${preview} />
    </div>`}
    <${Modal} open=${confirming && pending > 0} label="Submit changes" class="dialog sql-dialog" onClose=${() => setConfirming(false)}>
      <div class="dialog-body">
        <div class="dialog-head"><h2>Run ${pending} change${pending === 1 ? '' : 's'} on ${table?.table}?</h2>
          <button class="icon-btn" aria-label="Close" onClick=${() => setConfirming(false)}><${Icon} name="x" /></button></div>
        <p class="small dim">These run in one transaction: all of them or none. A row that changed or went meanwhile undoes them all. The values are sent as parameters; here they are written in.</p>
        <${Statements} ...${preview} />
        <div class="row">
          ${preview.list && html`<button class="btn ghost sm" onClick=${() => copyText(preview.list.join('\n'), 'SQL copied')}><${Icon} name="copy" />Copy</button>`}
          <div class="spacer"></div>
          <button class="btn" onClick=${() => setConfirming(false)}>Cancel</button>
          <${AsyncButton} class="btn primary" icon="play" disabled=${!preview.list} onClick=${submit}>Run<//>
        </div>
      </div>
    <//>
    <div class="sql-grid-body">
      <div class="sql-grid-wrap">
        <table class="sql-grid">
          <thead><tr><th class="rownum">#</th>${cols.map((col, c) => {
            const o = sortOf(c);
            return html`<th title=${`${col.type}${table ? ' · click to sort (on the server)' : ' · click to sort'}`} class="sortable" style=${widthOf(c)} onClick=${() => sortBy(c)}>
              <span>${col.name}</span>${table?.pk.includes(col.name) && html`<${Icon} name="key-round" class="tiny pk" />`}${col.type && html`<small>${col.type}</small>`}
              ${o && html`<span class="sort">${o.desc ? '↓' : '↑'}</span>`}
              <span class="sql-col-resize" title="Drag to resize · double-click to fit" onPointerDown=${(e) => resize(e, c)} onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => fit(e, c)}></span></th>`;
          })}</tr></thead>
          <tbody>
            ${shown.map(({ i, row }, n) => html`<tr key=${i} class=${cx(deleted.has(i) && 'deleted', sel?.row === i && 'sel-row')}><td class="rownum">${n + 1}</td>
              ${row.map((_, c) => cell(i, c, valueAt(i, c)))}</tr>`)}
            ${added.map((a, k) => html`<tr key=${`a${k}`} class=${cx('added', sel?.row === r.rows.length + k && 'sel-row')}><td class="rownum">+</td>
              ${a.map((v, c) => cell(r.rows.length + k, c, v))}</tr>`)}
          </tbody>
        </table>
        ${rows.length > shown.length && html`<div class="sql-more"><button class="btn sm" onClick=${() => setPages(pages + 1)}>Show ${Math.min(PAGE, rows.length - shown.length)} more of ${rows.length - shown.length}</button></div>`}
      </div>
      ${sel && selCol && html`<${ValuePanel} col=${selCol} value=${valueAt(sel.row, sel.col)}
        editable=${editable && !deleted.has(sel.row)} onApply=${apply} onClose=${() => setSel(null)} />`}
    </div>
  </div>`;
}

// Unified diffs (as the server sends them: hunks only, or a whole new file as `+` lines) shown unified or side by side,
// with line numbers and syntax highlighting.
import { html, cx } from './lib.js';
import { highlight, languageFor } from './highlight.js';

/** Hunks of rows { type: 'ctx'|'add'|'del'|'note', old, new, text }. */
export function parseDiff(diff) {
  const hunks = [];
  let cur = null;
  let oldNo = 1;
  let newNo = 1;
  for (const line of String(diff || '').split('\n')) {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)/.exec(line);
    if (m) {
      oldNo = Number(m[1]);
      newNo = Number(m[2]);
      cur = { header: line, rows: [] };
      hunks.push(cur);
      continue;
    }
    if (!cur) { cur = { header: null, rows: [] }; hunks.push(cur); }
    const sign = line[0];
    if (sign === '+') cur.rows.push({ type: 'add', new: newNo++, text: line.slice(1) });
    else if (sign === '-') cur.rows.push({ type: 'del', old: oldNo++, text: line.slice(1) });
    else if (sign === ' ') cur.rows.push({ type: 'ctx', old: oldNo++, new: newNo++, text: line.slice(1) });
    else if (line) cur.rows.push({ type: 'note', text: line.replace(/^\\ /, '') }); // "\ No newline at end of file", "… N more lines"
  }
  return hunks.filter((h) => h.header || h.rows.length);
}

export function diffStats(diff) {
  let add = 0;
  let del = 0;
  for (const l of String(diff || '').split('\n')) {
    if (l.startsWith('+')) add++;
    else if (l.startsWith('-')) del++;
  }
  return { add, del };
}

/** Pairs a hunk's rows for the split view: removed lines on the left beside the added lines that replace them. */
function pairs(rows) {
  const out = [];
  for (let i = 0; i < rows.length;) {
    const r = rows[i];
    if (r.type === 'ctx' || r.type === 'note') { out.push([r, r]); i++; continue; }
    const dels = [];
    const adds = [];
    for (; i < rows.length && rows[i].type === 'del'; i++) dels.push(rows[i]);
    for (; i < rows.length && rows[i].type === 'add'; i++) adds.push(rows[i]);
    for (let j = 0; j < Math.max(dels.length, adds.length); j++) out.push([dels[j] || null, adds[j] || null]);
  }
  return out;
}

function Code({ text, lang, type }) {
  const hl = highlight(text, lang);
  const cls = cx('code', type);
  return hl == null ? html`<td class=${cls}>${text}</td>` : html`<td class=${cls} dangerouslySetInnerHTML=${{ __html: hl }}></td>`;
}

/** `mode`: 'unified' | 'split'. */
export function DiffView({ diff, path, mode = 'unified' }) {
  const hunks = parseDiff(diff);
  const lang = languageFor(path);
  if (!hunks.length) return html`<div class="diff-empty">No text diff (binary, or nothing changed).</div>`;
  const split = mode === 'split';
  return html`<div class="diff-scroll"><table class=${cx('lines', split && 'split')}>
    ${split && html`<colgroup><col class="no" /><col /><col class="no" /><col /></colgroup>`}
    ${hunks.map((h, hi) => html`<tbody key=${hi}>
      ${h.header && html`<tr class="hunk"><td colspan=${split ? 4 : 3}>${h.header}</td></tr>`}
      ${split
        ? pairs(h.rows).map(([l, r]) => (l && l.type === 'note'
          ? html`<tr class="note"><td colspan="4">${l.text}</td></tr>`
          : html`<tr>
            <td class=${cx('no', l && l.type)}>${l?.old ?? ''}</td>
            ${l ? html`<${Code} text=${l.text} lang=${lang} type=${l.type} />` : html`<td class="code blank"></td>`}
            <td class=${cx('no', r && r.type)}>${r?.new ?? ''}</td>
            ${r ? html`<${Code} text=${r.text} lang=${lang} type=${r.type} />` : html`<td class="code blank"></td>`}
          </tr>`))
        : h.rows.map((r) => (r.type === 'note'
          ? html`<tr class="note"><td colspan="3">${r.text}</td></tr>`
          : html`<tr class=${r.type}><td class="no">${r.old ?? ''}</td><td class="no">${r.new ?? ''}</td><${Code} text=${r.text} lang=${lang} /></tr>`))}
    </tbody>`)}
  </table></div>`;
}

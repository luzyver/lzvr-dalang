// The code editor's palette, as in VS Code: one box whose first character picks what it does. Plain text goes to a file
// (Ctrl+P), `>` runs a command (Ctrl+Shift+P), `@` jumps to a symbol of the open file (Ctrl+Shift+O) and `:` to a line
// (Ctrl+G).
import { useEffect, useMemo, useRef, useState } from '../vendor/preact-hooks.js';
import { signal } from '../vendor/signals.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { Icon, Modal } from './ui.js';
import { toast } from './store.js';

/** The palette's text while it is open, else null. */
export const palette = signal(null);
export const openPalette = (text = '') => { palette.value = text; };

const nameOf = (p) => p.slice(p.lastIndexOf('/') + 1);
const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };

/** Characters of `q` in order in `text`; a higher score for matches in the last part, at word starts and in a row. */
export function fuzzyScore(text, q) {
  const p = text.toLowerCase();
  const nameAt = p.lastIndexOf('/') + 1;
  let score = 0;
  let at = -1;
  let run = 0;
  for (const ch of q.toLowerCase()) {
    if (ch === ' ') continue;
    const i = p.indexOf(ch, at + 1);
    if (i === -1) return -1;
    run = i === at + 1 ? run + 1 : 0;
    score += 1 + run * 2 + (i >= nameAt ? 2 : 0) + (i === 0 || '/._- '.includes(p[i - 1]) ? 3 : 0);
    at = i;
  }
  return score - text.length * 0.01;
}

const rank = (items, q, key) => (q.trim()
  ? items.map((it) => [it, fuzzyScore(key(it), q)]).filter(([, s]) => s >= 0).sort((a, b) => b[1] - a[1]).map(([it]) => it)
  : items);

/** A shortcut as keycaps: 'Ctrl+K S' → [Ctrl][K] [S]. */
export const Keys = ({ keys }) => keys && html`<span class="keys">${keys.split(' ').map((chord, i) => html`
  ${i > 0 && ' '}${chord.split(/\+(?!$)/).map((k) => html`<kbd>${k}</kbd>`)}`)}</span>`;

const SYMBOL_ICON = { class: 'square-code', type: 'square-code', method: 'code-xml', function: 'code-xml', variable: 'code-xml', module: 'folder', rule: 'palette' };

/**
 * `commands`: [{ id, title, keys?, run }]. `symbols()`: the open file's declarations, or null without a text file.
 * `lines()`: its line count, or null. `recent`: paths to list first when nothing is typed.
 */
export function Palette({ convId, commands, symbols, lines, recent, onOpenFile, onGoto, onSymbol }) {
  const text = palette.value;
  const shown = text !== null;
  const [files, setFiles] = useState(null);
  const [sel, setSel] = useState(0);
  const [syms, setSyms] = useState([]);
  const list = useRef(null);
  const input = useRef(null);
  const mode = !shown ? null : text.startsWith('>') ? 'command' : text.startsWith('@') ? 'symbol' : text.startsWith(':') ? 'line' : 'file';
  const q = mode === 'file' ? text : (text ?? '').slice(1);

  useEffect(() => {
    if (!shown) { setFiles(null); return; }
    input.current?.focus();
    api(`/api/conversations/${convId}/fs/files`).then((r) => setFiles(r.files), (e) => { toast(e.message, 'err'); setFiles([]); });
  }, [shown]);
  useEffect(() => { if (mode === 'symbol') setSyms(symbols() || []); }, [mode]);
  useEffect(() => { setSel(0); }, [text]);

  const items = useMemo(() => {
    if (mode === 'file') {
      if (!files) return null;
      if (!q.trim()) {
        const first = recent.filter((p) => files.includes(p));
        return [...first, ...files.filter((f) => !first.includes(f))].slice(0, 200).map((f) => ({ kind: 'file', key: f, path: f }));
      }
      return rank(files, q, (f) => f).slice(0, 200).map((f) => ({ kind: 'file', key: f, path: f }));
    }
    if (mode === 'command') {
      const used = pref('dalang-code-recent-commands', []);
      const sorted = q.trim() ? commands : [...commands].sort((a, b) => {
        const ia = used.indexOf(a.id);
        const ib = used.indexOf(b.id);
        return (ia === -1 ? 1e9 : ia) - (ib === -1 ? 1e9 : ib);
      });
      return rank(sorted, q, (c) => c.title).map((c) => ({ kind: 'command', key: c.id, cmd: c, recent: !q.trim() && used.includes(c.id) }));
    }
    if (mode === 'symbol') return rank(syms, q, (s) => s.name).map((s, i) => ({ kind: 'symbol', key: `${s.pos}:${i}`, sym: s }));
    return [];
  }, [mode, q, files, syms, commands]);

  useEffect(() => { list.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' }); }, [sel, items]);

  const close = () => { palette.value = null; };
  const total = lines();
  const lineTarget = () => {
    const m = /^\s*(\d+)?\s*(?:[:,]\s*(\d+))?\s*$/.exec(q);
    if (!m || !m[1] || total == null) return null;
    return { line: Math.min(Math.max(+m[1], 1), total), col: Math.max(+(m[2] || 1), 1) };
  };
  const pick = (it) => {
    if (mode === 'line') {
      const t = lineTarget();
      if (t) { close(); onGoto(t.line, t.col); }
      return;
    }
    if (!it) return;
    close();
    if (it.kind === 'file') onOpenFile(it.path);
    else if (it.kind === 'symbol') onSymbol(it.sym);
    else if (it.kind === 'command') {
      keep('dalang-code-recent-commands', [it.cmd.id, ...pref('dalang-code-recent-commands', []).filter((x) => x !== it.cmd.id)].slice(0, 12));
      // After the modal has closed, so a command that focuses something keeps the focus.
      requestAnimationFrame(() => it.cmd.run());
    }
  };
  const n = items?.length ?? 0;
  const placeholder = { file: 'Go to file… (> commands, @ symbols, : line)', command: 'Run a command…', symbol: 'Go to symbol…', line: 'Go to line…' }[mode];

  let body;
  if (mode === 'line') {
    const t = lineTarget();
    body = html`<div class="palette-empty">${total == null ? 'Open a text file to go to a line.'
      : t ? html`<button class="palette-item active" onClick=${() => pick()}><${Icon} name="chevron-right" />
          <span>Go to line ${t.line}${t.col > 1 ? `, column ${t.col}` : ''}</span></button>`
        : `Type a line number between 1 and ${total} (line:column also works).`}</div>`;
  } else if (items === null) body = html`<div class="palette-empty">Loading…</div>`;
  else if (!n) {
    body = html`<div class="palette-empty">${mode === 'symbol' ? (symbols() ? 'No symbols found in this file.' : 'Open a text file to see its symbols.')
      : mode === 'command' ? 'No matching command.' : 'No matching file.'}</div>`;
  } else {
    body = items.map((it, i) => {
      const common = { key: it.key, role: 'option', 'aria-selected': i === sel, class: cx('palette-item qo-item', i === sel && 'active'),
        onClick: () => pick(it), onMouseMove: () => { if (i !== sel) setSel(i); } };
      if (it.kind === 'file') {
        return html`<button ...${common}><${Icon} name="file" /><span class="qo-name">${nameOf(it.path)}</span>
          <span class="qo-dir">${parentOf(it.path)}</span>${recent.includes(it.path) && !q.trim() && html`<span class="qo-tag">open</span>`}</button>`;
      }
      if (it.kind === 'symbol') {
        return html`<button ...${common}><${Icon} name=${SYMBOL_ICON[it.sym.kind] || 'chevron-right'} /><span class="qo-name">${it.sym.name}</span>
          <span class="qo-dir">${it.sym.kind}</span><span class="qo-line">:${it.sym.line}</span></button>`;
      }
      return html`<button ...${common}><span class="qo-name qo-cmd">${it.cmd.title}</span>
        ${it.recent && html`<span class="qo-tag">recently used</span>`}<${Keys} keys=${it.cmd.keys} /></button>`;
    });
  }

  return html`<${Modal} open=${shown} onClose=${close} label="Command palette" class="palette qo">
    <div class="palette-input"><${Icon} name=${mode === 'command' ? 'chevron-right' : 'search'} />
      <input ref=${input} autofocus placeholder=${placeholder} value=${text ?? ''} spellcheck="false" autocomplete="off"
        onInput=${(e) => { palette.value = e.currentTarget.value; }}
        onKeyDown=${(e) => {
          if (e.key === 'ArrowDown') { e.preventDefault(); setSel((i) => Math.min(i + 1, n - 1)); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setSel((i) => Math.max(i - 1, 0)); }
          else if (e.key === 'PageDown') { e.preventDefault(); setSel((i) => Math.min(i + 10, n - 1)); }
          else if (e.key === 'PageUp') { e.preventDefault(); setSel((i) => Math.max(i - 10, 0)); }
          else if (e.key === 'Enter') { e.preventDefault(); pick(items?.[sel]); }
        }} />
    </div>
    <div class="palette-list" ref=${list} role="listbox">${body}</div>
  <//>`;
}

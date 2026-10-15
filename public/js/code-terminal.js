// The code editor's terminal panel: tabs of shells running on the server in the chat's folder (xterm.js over a
// WebSocket). A shell outlives this browser tab: reopening the editor re-attaches and replays its recent output.
import { useEffect, useRef } from '../vendor/preact-hooks.js';
import { signal } from '../vendor/signals.js';
import { FitAddon, Terminal } from '../vendor/code/editor.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { confirmDialog, Icon } from './ui.js';
import { guarded, toast } from './store.js';

// xterm.js's own stylesheet, once, when the editor loads.
if (!document.querySelector('link[href="/vendor/code/xterm.css"]')) {
  document.head.append(Object.assign(document.createElement('link'), { rel: 'stylesheet', href: '/vendor/code/xterm.css' }));
}

/** The open terminals ({ id, title, exitCode }) and the one shown. */
export const terms = { list: signal([]), active: signal(null), loaded: signal(false) };
/** id -> { xterm, fit, el, ws, opened, disposed } */
const sessions = new Map();

// ANSI colours that read well on the panel's light and dark backgrounds (Radix steps 9-11).
const ANSI = {
  light: {
    black: '#1c2024', red: '#ce2c31', green: '#18794e', yellow: '#ab6400', blue: '#0d74ce', magenta: '#8145b5', cyan: '#107d98', white: '#8b8d98',
    brightBlack: '#60646c', brightRed: '#e5484d', brightGreen: '#30a46c', brightYellow: '#cc4e00', brightBlue: '#0090ff', brightMagenta: '#8e4ec6', brightCyan: '#05a2c2', brightWhite: '#b9bbc6',
  },
  dark: {
    black: '#43484e', red: '#ff9592', green: '#3dd68c', yellow: '#ffca16', blue: '#70b8ff', magenta: '#d19dff', cyan: '#4ccce6', white: '#b0b4ba',
    brightBlack: '#777b84', brightRed: '#ffbdb8', brightGreen: '#b1f1cb', brightYellow: '#ffe770', brightBlue: '#c2e6ff', brightMagenta: '#ecd9fa', brightCyan: '#b6ecf7', brightWhite: '#edeef0',
  },
};

function themeNow() {
  const css = getComputedStyle(document.documentElement);
  const v = (name) => css.getPropertyValue(name).trim();
  const mode = document.documentElement.dataset.mode === 'dark' ? 'dark' : 'light';
  return {
    background: v('--bg'), foreground: v('--text'), cursor: v('--accent'), cursorAccent: v('--bg'),
    selectionBackground: v('--accent-soft-2'), selectionInactiveBackground: v('--surface-3'), ...ANSI[mode],
  };
}

// The terminals follow the theme and accent palette as they change.
new MutationObserver(() => { for (const s of sessions.values()) s.xterm.options.theme = themeNow(); })
  .observe(document.documentElement, { attributes: true, attributeFilter: ['data-mode', 'data-palette'] });

const send = (s, msg) => { if (s.ws?.readyState === WebSocket.OPEN) s.ws.send(JSON.stringify(msg)); };

function drop(id) {
  const s = sessions.get(id);
  if (s) {
    s.disposed = true;
    s.ws?.close();
    s.xterm.dispose();
    s.el.remove();
    sessions.delete(id);
  }
  terms.list.value = terms.list.value.filter((t) => t.id !== id);
  if (terms.active.value === id) terms.active.value = terms.list.value.at(-1)?.id ?? null;
}

const markExited = (id, exitCode) => {
  terms.list.value = terms.list.value.map((t) => (t.id === id ? { ...t, exitCode } : t));
};

/** Open the socket of a terminal (again after a drop): the server replays its recent output, so the screen is reset first. */
async function connect(s) {
  if (s.disposed) return;
  let ticket;
  try {
    ({ ticket } = await api(`/api/terminals/${s.id}/ticket`, { method: 'POST' }));
  } catch (e) {
    if (e.status === 404) { drop(s.id); return; }
    setTimeout(() => connect(s), 3000);
    return;
  }
  if (s.disposed) return;
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/api/terminals/socket?ticket=${encodeURIComponent(ticket)}`);
  s.ws = ws;
  ws.onopen = () => {
    s.xterm.reset();
    send(s, { t: 'r', c: s.xterm.cols, r: s.xterm.rows });
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    if (m.t === 'o') s.xterm.write(m.d);
    else if (m.t === 'x') {
      s.xterm.write(`\r\n\x1b[2m[process exited with code ${m.code}]\x1b[0m\r\n`);
      markExited(s.id, m.code);
    }
  };
  ws.onclose = (e) => {
    if (s.disposed || s.ws !== ws) return;
    if (e.code === 4404) drop(s.id); // closed here, in another tab, or by the server
    else setTimeout(() => connect(s), 1500);
  };
}

function session(info) {
  if (sessions.has(info.id)) return sessions.get(info.id);
  const xterm = new Terminal({
    fontFamily: "'Geist Mono', ui-monospace, 'Cascadia Code', Menlo, Consolas, monospace", fontSize: 13, lineHeight: 1.25,
    cursorBlink: true, scrollback: 5000, allowProposedApi: false, theme: themeNow(),
  });
  const fit = new FitAddon();
  xterm.loadAddon(fit);
  const el = document.createElement('div');
  el.className = 'term-screen';
  const s = { id: info.id, xterm, fit, el, ws: null, opened: false, disposed: false };
  // Ctrl+C copies when text is selected (and interrupts otherwise), as in Windows Terminal; Ctrl+Shift+C always copies.
  xterm.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !(e.ctrlKey || e.metaKey) || e.key.toLowerCase() !== 'c') return true;
    if (!e.shiftKey && !xterm.hasSelection()) return true;
    if (xterm.hasSelection()) navigator.clipboard?.writeText(xterm.getSelection()).catch(() => {});
    xterm.clearSelection();
    e.preventDefault();
    return false;
  });
  xterm.onData((d) => send(s, { t: 'i', d }));
  xterm.onResize(({ cols, rows }) => send(s, { t: 'r', c: cols, r: rows }));
  sessions.set(info.id, s);
  void connect(s);
  return s;
}

/** Fit the shown terminal to its box (only while it is visible: a hidden box measures zero). */
function fitActive(focus = false) {
  const s = sessions.get(terms.active.value);
  if (!s || !s.el.isConnected || !s.el.offsetHeight) return;
  if (!s.opened) { s.xterm.open(s.el); s.opened = true; }
  try { s.fit.fit(); } catch { /* not measurable yet */ }
  if (focus) s.xterm.focus();
}

let creating = false;
export const newTerminal = (convId) => guarded(async () => {
  if (creating) return;
  creating = true;
  try {
    const info = await api(`/api/conversations/${convId}/terminals`, { method: 'POST', body: { cols: 100, rows: 24 } });
    session(info);
    terms.list.value = [...terms.list.value, info];
    terms.active.value = info.id;
  } finally { creating = false; }
})();

async function closeTerminal(t) {
  if (t.exitCode === null && !await confirmDialog({
    title: `Close ${t.title}?`, message: 'Its shell and everything still running in it are stopped.', confirmText: 'Close terminal', danger: true,
  })) return;
  try { await api(`/api/terminals/${t.id}`, { method: 'DELETE' }); } catch (e) { if (e.status !== 404) { toast(e.message, 'err'); return; } }
  drop(t.id);
}

/** Load the terminals this chat already has (opened earlier, maybe in another tab). */
async function loadTerminals(convId) {
  const list = await api(`/api/conversations/${convId}/terminals`);
  for (const t of list) session(t);
  terms.list.value = list;
  if (!list.some((t) => t.id === terms.active.value)) terms.active.value = list.at(-1)?.id ?? null;
  terms.loaded.value = true;
}

export function TerminalPanel({ convId, shown, maximized, onMaximize, onHide }) {
  const host = useRef(null);
  const list = terms.list.value;
  const active = terms.active.value;

  useEffect(() => {
    loadTerminals(convId).catch((e) => toast(e.message, 'err'));
    return () => { for (const id of [...sessions.keys()]) drop(id); };
  }, [convId]);

  // The first time the panel shows with no terminal yet, open one (not again after the last one was closed).
  const loaded = terms.loaded.value;
  useEffect(() => {
    if (shown && loaded && !terms.list.peek().length) newTerminal(convId);
  }, [shown, loaded]);

  // Keep every screen in the host, showing only the active one; fit it whenever the panel changes size.
  useEffect(() => {
    const box = host.current;
    for (const s of sessions.values()) {
      if (s.el.parentNode !== box) box.append(s.el);
      s.el.hidden = s.id !== active;
    }
    requestAnimationFrame(() => fitActive(shown));
  }, [active, list.length, shown, maximized]);

  useEffect(() => {
    const ro = new ResizeObserver(() => fitActive());
    ro.observe(host.current);
    return () => ro.disconnect();
  }, []);

  return html`<section class="term-panel" aria-label="Terminal">
    <div class="pane-head term-head">
      <div class="term-tabs" role="tablist">
        ${list.map((t) => html`<div key=${t.id} role="tab" aria-selected=${t.id === active} class=${cx('term-tab', t.id === active && 'active', t.exitCode !== null && 'exited')}
          onClick=${() => { terms.active.value = t.id; }} onAuxClick=${(e) => { if (e.button === 1) closeTerminal(t); }}>
          <${Icon} name="terminal" /><span>${t.title}</span>
          <button class="icon-btn xs" aria-label=${`Close ${t.title}`} title="Close terminal" onClick=${(e) => { e.stopPropagation(); closeTerminal(t); }}><${Icon} name="x" /></button>
        </div>`)}
      </div>
      <button class="icon-btn sm" aria-label="New terminal" title="New terminal" onClick=${() => newTerminal(convId)}><${Icon} name="plus" /></button>
      <div class="spacer"></div>
      <button class="icon-btn sm hide-mobile" aria-label=${maximized ? 'Restore panel size' : 'Maximize panel'} title=${maximized ? 'Restore' : 'Maximize'} onClick=${onMaximize}>
        <${Icon} name=${maximized ? 'minimize-2' : 'maximize-2'} /></button>
      <button class="icon-btn sm hide-mobile" aria-label="Hide terminal" title="Hide terminal (Ctrl+\`)" onClick=${onHide}><${Icon} name="x" /></button>
    </div>
    <div class="term-host" ref=${host}>
      ${!list.length && html`<div class="term-empty dim small">No terminal open. <button class="btn sm" onClick=${() => newTerminal(convId)}><${Icon} name="plus" />New terminal</button></div>`}
    </div>
  </section>`;
}

// The SQL editor: the panel's database connections in their own browser tab (/sql), not tied to a chat. Connections and
// their tables on the left, query consoles as tabs in the middle, results below (DataGrip's layout, kept as quiet as
// the code editor). Admins add and change connections, including whether agents may use them. The result grid lives in
// sql-grid.js, "Ask the agent" in sql-ask.js.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { batch, signal } from '../vendor/signals.js';
import * as cm from '../vendor/code/editor.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Empty, Field, Icon, Logo, Menu, MenuItem, Modal, Resizer, Seg, Spinner } from './ui.js';
import { guarded, isAdmin, isOwner, toast } from './store.js';
import { copyText } from './code.js';
import { createState, EditorView } from './code-mirror.js';
import { ResultGrid } from './sql-grid.js';
import { AskAgent, contextFor } from './sql-ask.js';

const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const mobile = () => innerWidth <= 760;

const DRIVERS = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite' };
const PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306 };
const DIALECTS = { postgres: cm.PostgreSQL, mysql: cm.MySQL, mariadb: cm.MariaSQL, sqlite: cm.SQLite };
const ACCESS = { all: 'Everyone', admin: 'Owner and admins', owner: 'Owner only' };
const AGENT = { off: 'Off', 'read-only': 'Read-only', approve: 'Write with approval', 'read-write': 'Read and write' };
const AGENT_HINT = {
  off: 'Agents do not see this connection.',
  'read-only': 'Agents read through the gateway\'s MCP tools (db_list_connections, db_schema, db_query); the database refuses their writes.',
  approve: 'Agents read freely; a script that writes waits in Approvals until an admin runs or rejects it, and the outcome goes back to the agent\'s chat.',
  'read-write': 'Agents may change data and tables through the gateway\'s MCP tools.',
};
/** sql-formatter's names for the dialects. */
const FORMAT_LANG = { postgres: 'postgresql', mysql: 'mysql', mariadb: 'mariadb', sqlite: 'sqlite' };
const HISTORY = 'dalang-sql-history';
const LIMITS = [100, 500, 1000, 5000, 10000];

/**
 * A console: { id, connId, database ('' = the connection's own), title, text }. Its editor state lives in `states` (by id), its last run in `runs`:
 * { running, script, results, metas (per result: the table it shows, see tableMeta), error, index, readOnly, at,
 * shown (which result's tab; past the last one: the error's) }.
 */
const sq = {
  conns: signal(null),
  /** skey(connection, database) -> { loading, data, error } */
  schemas: signal(new Map()),
  /** connection id -> { loading, list, error }: the databases of a connection that opens every one */
  dbs: signal(new Map()),
  consoles: signal([]),
  active: signal(null),
  runs: signal(new Map()),
  /** tree nodes that are open: 'c:<conn>', 'd:<conn>:<db>', 's:<conn>:<db>:<schema>', 't:<conn>:<db>:<schema>:<table>' */
  open: signal(new Set(pref('dalang-sql-open', []))),
  limit: signal(pref('dalang-sql-limit', 500)),
  /** phones: which pane shows ('files' = Database, 'editor' = Query, 'terminal' = Results) */
  pane: signal('editor'),
  /** the connection dialog: { conn } to edit one, { conn: null } to add one */
  editing: signal(null),
  /** the agent log dialog: a connection id */
  log: signal(null),
  /** the history dialog is open */
  history: signal(false),
  /** "Ask the agent": { context, suggestion } */
  ask: signal(null),
  /** a script held because it would change every row: { list (from the server), conn, go() } */
  unsafe: signal(null),
};
/** console id -> the AbortController of its running query */
const ctrls = new Map();
const states = new Map();
/** console id -> the compartment its SQL language sits in */
const langs = new Map();
let view = null;

const connOf = (id) => sq.conns.value?.find((c) => c.id === id);
/** A PostgreSQL connection that opens every database on its server (each through its own connection). */
const multi = (conn) => conn?.driver === 'postgres' && !!conn.allDatabases;
/** The database a connection starts in. */
const ownDb = (conn) => conn.database || (multi(conn) ? 'postgres' : '');
/** The key of a database's tables in `sq.schemas`; db '' is the connection's own. */
const skey = (connId, db = '') => `${connId}/${db}`;
const dbParam = (db) => (db ? `?database=${encodeURIComponent(db)}` : '');
const activeConsole = () => sq.consoles.value.find((c) => c.id === sq.active.value);
const setRun = (id, patch) => {
  const next = new Map(sq.runs.value);
  next.set(id, { ...next.get(id), ...patch });
  sq.runs.value = next;
};

let saveTimer = 0;
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const consoles = sq.consoles.value.map((c) => ({ ...c, text: states.get(c.id)?.doc.toString() ?? c.text }));
    keep('dalang-sql-consoles', { consoles, active: sq.active.value });
  }, 400);
}

// ---------- statements ----------

/** Where each statement starts and ends, split on `;` outside strings and comments (as the server splits them). */
export function splitStatements(script, driver = 'postgres') {
  const my = driver === 'mysql' || driver === 'mariadb';
  const out = [];
  let start = 0;
  let code = false;
  let i = 0;
  const n = script.length;
  const end = (at) => { if (code) out.push({ from: start, to: at }); start = at + 1; code = false; };
  while (i < n) {
    const ch = script[i];
    const next = script[i + 1];
    if ((ch === '-' && next === '-') || (my && ch === '#')) { const nl = script.indexOf('\n', i); i = nl < 0 ? n : nl + 1; continue; }
    if (ch === '/' && next === '*') { const close = script.indexOf('*/', i + 2); i = close < 0 ? n : close + 2; continue; }
    if (ch === ';') { end(i); i++; continue; }
    if (!/\s/.test(ch)) code = true;
    if (ch === '\'' || ch === '"' || (my && ch === '`')) {
      const escapes = ch === '\'' && (my || (driver === 'postgres' && /[Ee]/.test(script[i - 1] ?? '') && !/\w/.test(script[i - 2] ?? '')));
      i++;
      while (i < n) {
        if (escapes && script[i] === '\\') { i += 2; continue; }
        if (script[i] === ch) { if (script[i + 1] === ch) { i += 2; continue; } break; }
        i++;
      }
      i++;
      continue;
    }
    if (ch === '$' && driver === 'postgres') {
      const m = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/.exec(script.slice(i, i + 64));
      if (m && !/\w/.test(script[i - 1] ?? '')) { const close = script.indexOf(m[0], i + m[0].length); i = close < 0 ? n : close + m[0].length; continue; }
    }
    i++;
  }
  end(n);
  return out;
}

/** The text to run: the selection, else the statement the cursor is in (or the last one before it). */
function currentStatement(state, driver) {
  const sel = state.selection.main;
  const text = state.doc.toString();
  if (!sel.empty) return text.slice(sel.from, sel.to);
  const all = splitStatements(text, driver);
  if (!all.length) return '';
  const pos = sel.head;
  const hit = all.find((s) => pos >= s.from && pos <= s.to + 1) || [...all].reverse().find((s) => s.to < pos) || all[0];
  return text.slice(hit.from, hit.to);
}

// ---------- data ----------

async function loadConns() {
  try { sq.conns.value = await api('/api/db/connections'); } catch (e) { sq.conns.value = sq.conns.value || []; toast(e.message, 'err'); }
}

/** skey -> the schema read in flight, so a second caller waits for the same one. */
const loadingSchemas = new Map();

function loadSchema(connId, db = '', force = false) {
  const key = skey(connId, db);
  const cur = sq.schemas.value.get(key);
  if (loadingSchemas.has(key)) return loadingSchemas.get(key);
  if (cur?.data && !force) return Promise.resolve();
  const set = (v) => { const m = new Map(sq.schemas.value); m.set(key, v); sq.schemas.value = m; };
  set({ ...cur, loading: true });
  const p = (async () => {
    try { set({ data: await api(`/api/db/connections/${connId}/schema${dbParam(db)}`) }); } catch (e) { set({ error: e.message }); }
    loadingSchemas.delete(key);
    const c = activeConsole();
    if (c?.connId === connId && (c.database || '') === db) applyLanguage();
  })();
  loadingSchemas.set(key, p);
  return p;
}

async function loadDatabases(connId, force = false) {
  const cur = sq.dbs.value.get(connId);
  if (cur && (cur.loading || (cur.list && !force))) return;
  const set = (v) => { const m = new Map(sq.dbs.value); m.set(connId, v); sq.dbs.value = m; };
  set({ ...cur, loading: true });
  try { set({ list: (await api(`/api/db/connections/${connId}/databases`)).databases }); } catch (e) { set({ error: e.message }); }
}

/** The SQL language of the active console's connection, completing its tables and columns. */
function applyLanguage() {
  const c = activeConsole();
  if (!view || !c) return;
  const conn = connOf(c.connId);
  const data = conn && sq.schemas.value.get(skey(conn.id, c.database || ''))?.data;
  const schema = {};
  for (const s of data?.schemas || []) {
    schema[s.name] = Object.fromEntries(s.tables.map((t) => [t.name, t.columns.map((col) => ({ label: col.name, detail: col.type, type: 'property' }))]));
  }
  const defaultSchema = conn?.driver === 'postgres' ? 'public' : conn?.driver === 'sqlite' ? 'main' : conn?.database || undefined;
  const support = cm.sql({ dialect: DIALECTS[conn?.driver] || cm.StandardSQL, schema, defaultSchema, upperCaseKeywords: true });
  view.dispatch({ effects: langs.get(c.id).reconfigure(support) });
  states.set(c.id, view.state);
}

// ---------- consoles ----------

let consoleSeq = 0;
const titleOf = (conn, db) => (conn ? (db ? `${conn.label} · ${db}` : conn.label) : 'Console');

/** `database`: another database of the connection ('' = its own). `name`: the tab's title instead of the connection's. */
function newConsole(connId, text = '', database = '', name = '') {
  const conn = connOf(connId);
  const db = conn && database !== ownDb(conn) ? database : '';
  const n = sq.consoles.value.filter((c) => c.connId === connId && (c.database || '') === db).length + 1;
  const title = name || `${titleOf(conn, db)}${conn && n > 1 ? ` (${n})` : ''}`;
  const c = { id: `q${Date.now().toString(36)}${consoleSeq++}`, connId, database: db, title, text };
  batch(() => {
    sq.consoles.value = [...sq.consoles.value, c];
    activate(c.id);
  });
  if (mobile()) sq.pane.value = 'editor';
  persist();
  return c;
}

function closeConsole(id) {
  const list = sq.consoles.value;
  const i = list.findIndex((c) => c.id === id);
  const next = list.filter((c) => c.id !== id);
  states.delete(id);
  langs.delete(id);
  batch(() => {
    sq.consoles.value = next;
    if (sq.active.value === id) activate(next[Math.min(i, next.length - 1)]?.id ?? null);
  });
  persist();
}

function stateFor(c) {
  let st = states.get(c.id);
  if (!st) {
    const made = createState(c.text, 'query.sql', {
      onSave: () => {},
      onChange: (u) => { states.set(c.id, u.state); if (u.docChanged) persist(); },
      keys: [
        { key: 'Mod-Enter', preventDefault: true, run: () => { run(false); return true; } },
        { key: 'Shift-Mod-Enter', preventDefault: true, run: () => { run(true); return true; } },
        { key: 'Shift-Alt-f', preventDefault: true, run: () => { formatSql(); return true; } },
        { key: 'Mod-Alt-l', preventDefault: true, run: () => { formatSql(); return true; } },
      ],
    });
    st = made.state;
    langs.set(c.id, made.lang);
    states.set(c.id, st);
  }
  return st;
}

function activate(id) {
  if (view && sq.active.value) {
    const prev = sq.consoles.value.find((c) => c.id === sq.active.value);
    if (prev) states.set(prev.id, view.state);
  }
  sq.active.value = id;
  persist();
  const c = activeConsole();
  if (!c || !view) return;
  view.setState(stateFor(c));
  if (c.connId) loadSchema(c.connId, c.database || '');
  if (multi(connOf(c.connId))) loadDatabases(c.connId);
  applyLanguage();
  if (!mobile()) view.focus();
}

function setConsoleConn(connId) {
  const c = activeConsole();
  if (!c) return;
  const conn = connOf(connId);
  sq.consoles.value = sq.consoles.value.map((x) => (x.id === c.id ? { ...x, connId, database: '', title: conn ? conn.label : x.title } : x));
  loadSchema(connId);
  if (multi(conn)) loadDatabases(connId);
  applyLanguage();
  persist();
}

function setConsoleDb(database) {
  const c = activeConsole();
  const conn = c && connOf(c.connId);
  if (!conn) return;
  const db = database === ownDb(conn) ? '' : database;
  sq.consoles.value = sq.consoles.value.map((x) => (x.id === c.id ? { ...x, database: db, title: titleOf(conn, db) } : x));
  loadSchema(conn.id, db);
  applyLanguage();
  persist();
}

// ---------- running ----------

const DDL = /^\s*(create|alter|drop|rename|truncate|comment)\b/im;

/** Always quoted: for SQL the editor writes itself (filters, sorting). */
const qi = (conn, name) => (conn.driver === 'mysql' || conn.driver === 'mariadb' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`);
const defaultSchema = (conn, db) => (conn.driver === 'postgres' ? 'public' : conn.driver === 'sqlite' ? 'main' : db || conn.database);

const IDENT = String.raw`(?:"(?:[^"]|"")+"|\x60[^\x60]+\x60|[A-Za-z_][\w$]*)`;
const TABLE_SELECT = new RegExp(String.raw`^\s*select\s+\*\s+from\s+(${IDENT})(?:\s*\.\s*(${IDENT}))?((?:\s+(?:where|order|limit)\b[\s\S]*)?)\s*;?\s*$`, 'i');
const WHERE_PART = /^\s*where\s+([\s\S]*?)(?:\s+order\s+by\s+[\s\S]*?)?(?:\s+limit\s+\d+(?:\s+offset\s+\d+)?)?\s*$/i;
const unquote = (x) => (/^"/.test(x) ? x.slice(1, -1).replace(/""/g, '"') : /^\x60/.test(x) ? x.slice(1, -1) : x);
const sameName = (x, name) => (/^["\x60]/.test(x) ? unquote(x) === name : x.toLowerCase() === name.toLowerCase());

/**
 * The table a result shows, when its statement is `SELECT * FROM <table> [WHERE ...] [ORDER BY ...] [LIMIT ...]` and the
 * table has a primary key that the result holds: { schema, table, pk, where, order }. Such a result can be filtered,
 * sorted on the server and edited.
 */
function tableMeta(conn, db, result) {
  const m = TABLE_SELECT.exec(result.sql);
  const data = sq.schemas.value.get(skey(conn.id, db))?.data;
  if (!m || !data || !result.columns.length) return null;
  const [, a, b, tail] = m;
  let hits = [];
  for (const sch of data.schemas) {
    for (const t of sch.tables) {
      if (t.kind === 'table' && (b ? sameName(a, sch.name) && sameName(b, t.name) : sameName(a, t.name))) hits.push({ schema: sch.name, t });
    }
  }
  if (!b && hits.length > 1) hits = hits.filter((h) => h.schema === defaultSchema(conn, db));
  if (hits.length !== 1) return null;
  const { schema, t } = hits[0];
  const pk = t.columns.filter((col) => col.pk).map((col) => col.name);
  if (!pk.length || !pk.every((n) => result.columns.some((col) => col.name === n))) return null;
  return { schema, table: t.name, pk, where: WHERE_PART.exec(tail)?.[1]?.trim() ?? '', order: null };
}

/** Remembers a run for the History dialog (the last 300, the same statement once). */
function remember(entry) {
  const list = pref(HISTORY, []);
  keep(HISTORY, [entry, ...list.filter((x) => !(x.sql === entry.sql && x.connId === entry.connId && x.database === entry.database))].slice(0, 300));
}

/**
 * Runs the statement at the cursor (or the selection), the whole console (`all`) or `script`. A script that would
 * change every row of a table first asks (the server holds it until `confirmed`).
 */
async function run(all, script, confirmed = false) {
  const c = activeConsole();
  if (!c || !view) return;
  const conn = connOf(c.connId);
  if (!conn) { toast('pick a connection for this console first', 'err'); return; }
  if (sq.runs.value.get(c.id)?.running) return;
  const sql = script ?? (all ? view.state.doc.toString() : currentStatement(view.state, conn.driver));
  if (!sql.trim()) { toast('nothing to run here', 'err'); return; }
  const db = c.database || '';
  const ac = new AbortController();
  ctrls.set(c.id, ac);
  const t0 = Date.now();
  const before = sq.runs.value.get(c.id);
  setRun(c.id, { running: true, at: t0, script: sql });
  if (mobile()) sq.pane.value = 'terminal';
  const note = (ok, rows) => remember({ sql: sql.trim(), connId: conn.id, database: db, at: t0, ms: Date.now() - t0, ok, rows });
  try {
    const r = await api(`/api/db/connections/${conn.id}/query`, { method: 'POST', signal: ac.signal, body: { sql, limit: sq.limit.value, ...(db && { database: db }), ...(confirmed && { confirmed }) } });
    // A table's rows need its primary key: the table list must be there to tell.
    await loadSchema(conn.id, db);
    const metas = r.results.map((x) => tableMeta(conn, db, x));
    setRun(c.id, { running: false, results: r.results, metas, error: null, readOnly: r.readOnly, shown: r.results.length - 1 });
    note(true, r.results.reduce((n, x) => n + x.rows.length, 0));
    if (r.results.some((x) => DDL.test(x.sql))) loadSchema(conn.id, db, true);
  } catch (e) {
    if (e.status === 409 && e.detail?.unsafe) {
      // Nothing ran: the results stay as they were until the user decides.
      setRun(c.id, { ...before, running: false });
      sq.unsafe.value = { list: e.detail.unsafe, conn: conn.label, go: () => { activate(c.id); run(false, sql, true); } };
      return;
    }
    // A failed statement still shows what ran before it.
    const results = e.detail?.results || [];
    const error = e.name === 'AbortError' ? 'Cancelled. The database was asked to stop the statement.' : e.message;
    setRun(c.id, { running: false, results, metas: [], error, index: e.detail?.index ?? results.length, shown: results.length });
    note(false, 0);
  } finally { if (ctrls.get(c.id) === ac) ctrls.delete(c.id); }
}

/** Stops the active console's query: the request closes and the server cancels the statement. */
function cancelRun() {
  const c = activeConsole();
  ctrls.get(c?.id)?.abort();
}

/** Reads a table result again with another filter or sort order (from the grid). */
async function requery(c, idx, meta, { where, order }) {
  const conn = connOf(c.connId);
  if (!conn) return;
  const ref = conn.driver === 'sqlite' ? qi(conn, meta.table) : `${qi(conn, meta.schema)}.${qi(conn, meta.table)}`;
  const sql = `SELECT * FROM ${ref}${where.trim() ? ` WHERE ${where.trim()}` : ''}${order ? ` ORDER BY ${qi(conn, order.col)} ${order.desc ? 'DESC' : 'ASC'}` : ''}`;
  try {
    const r = await api(`/api/db/connections/${conn.id}/query`, { method: 'POST', body: { sql, limit: sq.limit.value, ...(c.database && { database: c.database }) } });
    const cur = sq.runs.value.get(c.id);
    const results = cur.results.map((x, i) => (i === idx ? r.results[0] : x));
    const metas = cur.metas.map((x, i) => (i === idx ? { ...meta, where, order } : x));
    setRun(c.id, { results, metas, at: Date.now() });
  } catch (e) { toast(e.message, 'err'); }
}

/** Saves the grid's edits to its table, then reads the table again. True when saved. */
/** The statements the grid's edits make, as the server would run them (values written in), without running them. */
async function previewEdits(c, meta, edits) {
  const conn = connOf(c.connId);
  const r = await api(`/api/db/connections/${conn.id}/edit`, { method: 'POST', body: { ...(c.database && { database: c.database }), schema: meta.schema, table: meta.table, edits, preview: true } });
  return r.statements;
}

async function submitEdits(c, idx, meta, edits) {
  const conn = connOf(c.connId);
  try {
    const r = await api(`/api/db/connections/${conn.id}/edit`, { method: 'POST', body: { ...(c.database && { database: c.database }), schema: meta.schema, table: meta.table, edits } });
    toast(`${r.changed} row${r.changed === 1 ? '' : 's'} saved`);
    await requery(c, idx, meta, meta);
    return true;
  } catch (e) { toast(e.message, 'err'); return false; }
}

/** Lays out the selection, or the whole console, with sql-formatter (loaded on first use). */
async function formatSql() {
  const c = activeConsole();
  if (!view || !c) return;
  const conn = connOf(c.connId);
  try {
    const { format } = await import('../vendor/code/sqlfmt.js');
    const sel = view.state.selection.main;
    const [from, to] = sel.empty ? [0, view.state.doc.length] : [sel.from, sel.to];
    const out = format(view.state.sliceDoc(from, to), { language: FORMAT_LANG[conn?.driver] || 'sql', keywordCase: 'upper', tabWidth: 2 });
    view.dispatch({ changes: { from, to, insert: out } });
  } catch (e) { toast(`cannot format this: ${e.message}`, 'err'); }
}

/** "Ask the agent" about the active console's last run (its error, or the result shown). */
function askAboutRun() {
  const c = activeConsole();
  const conn = c && connOf(c.connId);
  if (!conn) return;
  const r = sq.runs.value.get(c.id);
  const results = r?.results || [];
  const onError = !!r?.error && !(r.shown < results.length);
  const shown = onError ? null : results[Math.min(r?.shown ?? 0, results.length - 1)];
  const sql = onError || !shown ? r?.script ?? currentStatement(view.state, conn.driver) : shown.sql;
  sq.ask.value = {
    suggestion: onError ? 'Why does this fail, and how do I fix it?' : '',
    context: contextFor({
      conn, engine: DRIVERS[conn.driver], database: c.database || (multi(conn) ? ownDb(conn) : ''), sql,
      error: onError ? r.error : null, result: shown, schemas: sq.schemas.value.get(skey(conn.id, c.database || ''))?.data?.schemas,
    }),
  };
}

// ---------- results ----------

const csvCell = (v) => (v === null ? '' : /[",\n\r]/.test(String(v)) ? `"${String(v).replace(/"/g, '""')}"` : String(v));
const toCsv = (r) => [r.columns.map((col) => csvCell(col.name)).join(','), ...r.rows.map((row) => row.map(csvCell).join(','))].join('\r\n');
const toTsv = (r) => [r.columns.map((col) => col.name).join('\t'), ...r.rows.map((row) => row.map((v) => (v === null ? '' : String(v).replace(/[\t\n]/g, ' '))).join('\t'))].join('\n');

function download(text, name) {
  const url = URL.createObjectURL(new Blob([text], { type: 'text/csv;charset=utf-8' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: name, hidden: true });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}

const summary = (r) => (r.columns.length
  ? `${r.rows.length}${r.truncated ? '+' : ''} row${r.rows.length === 1 ? '' : 's'}`
  : r.affected != null ? `${r.affected} row${r.affected === 1 ? '' : 's'} affected` : 'done');
const firstWord = (sql) => (/^\s*(\w+)/.exec(sql)?.[1] || 'SQL').toUpperCase();

function Results() {
  const c = activeConsole();
  const r = c && sq.runs.value.get(c.id);
  if (!c) return html`<div class="sql-results"><div class="term-empty dim small">No console open.</div></div>`;
  if (!r || (!r.running && !r.results && !r.error)) {
    return html`<div class="sql-results"><div class="term-empty dim small">
      <span>Run a statement with <kbd>Ctrl</kbd> <kbd>Enter</kbd>, or the whole console with <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd>.</span></div></div>`;
  }
  const results = r.results || [];
  const onError = !!r.error && !(r.shown < results.length);
  const idx = Math.min(r.shown ?? 0, results.length - 1);
  const shown = onError ? null : results[idx];
  const meta = shown && r.metas?.[idx];
  const conn = connOf(c.connId);
  const pick = (i) => setRun(c.id, { shown: i });
  return html`<div class="sql-results">
    <div class="pane-head term-head">
      <div class="term-tabs">
        ${results.map((x, i) => html`<div key=${i} class=${cx('term-tab', x === shown && 'active')} title=${x.sql} onClick=${() => pick(i)}>
          <${Icon} name=${x.columns.length ? 'table' : 'check'} /><span>${results.length > 1 ? `${i + 1} · ` : ''}${firstWord(x.sql)}</span></div>`)}
        ${r.error && html`<div class=${cx('term-tab err', onError && 'active')} onClick=${() => pick(results.length)}><${Icon} name="circle-alert" /><span>${results.length ? `${r.index + 1} · ` : ''}Error</span></div>`}
      </div>
      <div class="spacer"></div>
      ${r.running && html`<span class="dim small row"><${Spinner} /> Running…</span>
        <button class="btn sm" onClick=${cancelRun}><${Icon} name="square" />Cancel</button>`}
      ${!r.running && (shown || onError) && html`<button class="btn ghost sm" title="Send this query and its error or result to an agent" onClick=${askAboutRun}><${Icon} name="bot" />Ask the agent</button>`}
      ${shown?.columns.length > 0 && !r.running && html`
        <button class="icon-btn xs" title="Copy as TSV (pastes into a spreadsheet)" aria-label="Copy rows" onClick=${() => copyText(toTsv(shown), 'rows copied')}><${Icon} name="copy" /></button>
        <button class="icon-btn xs" title="Download CSV" aria-label="Download CSV" onClick=${() => download(toCsv(shown), `${c.title.replace(/[^\w-]+/g, '_')}.csv`)}><${Icon} name="arrow-down-to-line" /></button>`}
    </div>
    ${onError && html`<div class="sql-error" role="alert"><${Icon} name="circle-alert" /><div>
      ${results.length > 0 && html`<div class="small dim">Statement ${r.index + 1} failed; the ${results.length} before it ran.</div>`}
      <pre>${r.error}</pre></div></div>`}
    ${shown && (shown.columns.length
      ? html`<${ResultGrid} key=${`${r.at}:${idx}`} r=${shown} table=${meta} readOnly=${!!conn?.readOnly}
          onQuery=${(q) => requery(c, idx, meta, q)} onSubmit=${(edits) => submitEdits(c, idx, meta, edits)}
          onPreview=${(edits) => previewEdits(c, meta, edits)} />`
      : html`<div class="term-empty small"><${Icon} name="circle-check" /> ${summary(shown)}</div>`)}
    ${shown && html`<div class="sql-foot small dim">
      <span>${summary(shown)} · ${shown.ms} ms</span>
      ${shown.truncated && html`<span class="warn">Only the first ${shown.rows.length} rows (the row limit).</span>`}
      ${r.readOnly && html`<span><${Icon} name="eye" class="tiny" /> read-only connection</span>`}
      ${meta && !conn?.readOnly && html`<span><${Icon} name="pencil" class="tiny" /> ${meta.table}: click a cell to see or edit it</span>`}
      ${meta && html`<span class="mono sql-ran" title=${shown.sql}>${shown.sql}</span>
        <button class="icon-btn xs" title="Copy the query that read these rows" aria-label="Copy the query" onClick=${() => copyText(shown.sql, 'query copied')}><${Icon} name="copy" /></button>`}
      ${!meta && shown?.columns.length > 0 && html`<span>Click a cell to see its whole value</span>`}
    </div>`}
  </div>`;
}

// ---------- the tree of connections, schemas, tables and columns ----------

function toggleOpen(key, on) {
  const next = new Set(sq.open.value);
  if (on ?? !next.has(key)) next.add(key); else next.delete(key);
  sq.open.value = next;
  keep('dalang-sql-open', [...next]);
}

const quote = (conn, name) => (/^[a-z_][a-z0-9_]*$/.test(name) ? name : conn.driver === 'mysql' || conn.driver === 'mariadb' ? `\`${name}\`` : `"${name.replace(/"/g, '""')}"`);
function selectFrom(conn, schema, table) {
  const own = conn.driver === 'sqlite' || (conn.driver === 'postgres' && schema === 'public') || (conn.driver !== 'postgres' && schema === conn.database);
  return `SELECT * FROM ${own ? '' : `${quote(conn, schema)}.`}${quote(conn, table)} LIMIT 100;`;
}

/** '' for the connection's own database (how consoles and the schema cache name it), else the name. */
const dbKey = (conn, db) => (!db || db === ownDb(conn) ? '' : db);

function openTable(conn, db, schema, table) {
  const sql = selectFrom(conn, schema, table);
  const a = activeConsole();
  const c = a?.connId === conn.id && (a.database || '') === db ? a : newConsole(conn.id, '', db);
  if (c && view && sq.active.value === c.id) {
    const doc = view.state.doc;
    const at = doc.length;
    const insert = `${doc.length && !doc.toString().endsWith('\n') ? '\n' : ''}${sql}`;
    view.dispatch({ changes: { from: at, insert }, selection: { anchor: at + insert.length - sql.length, head: at + insert.length } });
    run(false);
  }
}

const agentTag = (conn) => conn.agent !== 'off'
  && html`<span class=${cx('sql-tag', conn.agent === 'read-write' && 'warn')} title=${`Agents: ${(AGENT[conn.agent] || conn.agent).toLowerCase()}`}><${Icon} name="bot" /></span>`;

/** The DDL of a table or view, in a new console (not run). */
async function openDdl(conn, db, schema, table) {
  try {
    const r = await api(`/api/db/connections/${conn.id}/ddl?schema=${encodeURIComponent(schema)}&table=${encodeURIComponent(table)}${db ? `&database=${encodeURIComponent(db)}` : ''}`);
    newConsole(conn.id, r.ddl, db, `DDL · ${table}`);
  } catch (e) { toast(e.message, 'err'); }
}

function askAboutTable(conn, db, schema, table) {
  const own = db || (multi(conn) ? ownDb(conn) : '');
  sq.ask.value = {
    suggestion: `What does ${table} hold, and how is it used?`,
    context: contextFor({ conn, engine: DRIVERS[conn.driver], database: own, sql: '', schemas: sq.schemas.value.get(skey(conn.id, db))?.data?.schemas, table: { schema, table } }),
  };
}
const note = (depth, cls, text) => html`<div class=${cx('tree-empty small', cls)} style=${{ paddingLeft: `${30 + depth * 14}px` }}>${text}</div>`;

/** The schemas (or, with only one, the tables) of one database, `depth` levels in. */
function Tables({ conn, db, depth }) {
  const s = sq.schemas.value.get(skey(conn.id, db));
  useEffect(() => { loadSchema(conn.id, db); }, [conn.id, db]);
  if (s?.error) return note(depth - 1, 'err', s.error);
  if (!s?.data) return s?.loading ? note(depth - 1, 'dim', 'Loading…') : null;
  const schemas = s.data.schemas;
  if (!schemas.length) return note(depth - 1, 'dim', 'No tables.');
  // One schema (SQLite, a MySQL connection to one database): its tables right under the connection.
  if (schemas.length === 1) return schemas[0].tables.map((t) => html`<${TableNode} key=${t.name} conn=${conn} db=${db} schema=${schemas[0].name} t=${t} depth=${depth} />`);
  return schemas.map((sch) => html`<${SchemaNode} key=${sch.name} conn=${conn} db=${db} sch=${sch} depth=${depth} />`);
}

/** The databases of a connection that opens every one on its server. */
function Databases({ conn }) {
  const d = sq.dbs.value.get(conn.id);
  useEffect(() => { loadDatabases(conn.id); }, [conn.id]);
  if (d?.error) return note(0, 'err', d.error);
  if (!d?.list) return note(0, 'dim', 'Loading…');
  return d.list.map((name) => html`<${DbNode} key=${name} conn=${conn} name=${name} />`);
}

function DbNode({ conn, name }) {
  const db = dbKey(conn, name);
  const key = `d:${conn.id}:${name}`;
  const open = sq.open.value.has(key);
  return html`<div>
    <div class="tree-row" style=${{ '--depth': 1 }} aria-expanded=${open} title="Double-click: a console on this database"
      onClick=${() => toggleOpen(key)} onDblClick=${() => newConsole(conn.id, '', name)}>
      <span class="tree-twisty"><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></span>
      <${Icon} name="database" class="tree-icon" /><span class="tree-name">${name}</span>
      ${!db && html`<span class="sql-type">default</span>`}
      ${sq.schemas.value.get(skey(conn.id, db))?.loading && html`<${Spinner} class="tiny" />`}
    </div>
    ${open && html`<${Tables} conn=${conn} db=${db} depth=${2} />`}
  </div>`;
}

function ConnNode({ conn }) {
  const key = `c:${conn.id}`;
  const open = sq.open.value.has(key);
  const loading = multi(conn) ? sq.dbs.value.get(conn.id)?.loading : sq.schemas.value.get(skey(conn.id))?.loading;
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: `Remove ${conn.label}?`, message: 'The connection and its agent log go. The database itself is untouched.', confirmText: 'Remove', danger: true })) return;
    await api(`/api/db/connections/${conn.id}`, { method: 'DELETE' });
    await loadConns();
  });
  // Every database (and table list) of it that was read before is read again.
  const refresh = () => {
    toggleOpen(key, true);
    if (multi(conn)) loadDatabases(conn.id, true);
    for (const k of sq.schemas.value.keys()) if (k.startsWith(`${conn.id}/`)) loadSchema(conn.id, k.slice(conn.id.length + 1), true);
    if (!multi(conn)) loadSchema(conn.id, '', true);
  };
  const where = conn.driver === 'sqlite' ? conn.file : `${conn.host}:${conn.port}/${multi(conn) ? '*' : conn.database}`;
  return html`<div>
    <div class="tree-row" style=${{ '--depth': 0 }} aria-expanded=${open} onClick=${() => toggleOpen(key)} onDblClick=${() => newConsole(conn.id)}>
      <span class="tree-twisty"><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></span>
      <${Icon} name="database" class="tree-icon" />
      <span class="tree-name" title=${`${DRIVERS[conn.driver]} · ${where}`}>${conn.label}</span>
      ${conn.readOnly && html`<span class="sql-tag" title="Read-only"><${Icon} name="eye" /></span>`}
      ${agentTag(conn)}
      ${loading && html`<${Spinner} class="tiny" />`}
      <span onClick=${(e) => e.stopPropagation()}>
        <${Menu} label="Connection options" buttonClass="xs tree-more">
          <${MenuItem} icon="square-code" onClick=${() => newConsole(conn.id)}>New console<//>
          <${MenuItem} icon="refresh-cw" onClick=${refresh}>Refresh<//>
          ${isAdmin.value && html`<div class="menu-sep"></div>
            <${MenuItem} icon="pencil" onClick=${() => { sq.editing.value = { conn }; }}>Edit connection<//>
            <${MenuItem} icon="history" onClick=${() => { sq.log.value = conn.id; }}>Agent queries<//>
            <${MenuItem} icon="trash-2" danger onClick=${remove}>Remove<//>`}
        <//>
      </span>
    </div>
    ${open && (multi(conn) ? html`<${Databases} conn=${conn} />` : html`<${Tables} conn=${conn} db="" depth=${1} />`)}
  </div>`;
}

function SchemaNode({ conn, db, sch, depth }) {
  const key = `s:${conn.id}:${db}:${sch.name}`;
  const open = sq.open.value.has(key);
  return html`<div>
    <div class="tree-row" style=${{ '--depth': depth }} aria-expanded=${open} onClick=${() => toggleOpen(key)}>
      <span class="tree-twisty"><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></span>
      <${Icon} name="folder" class="tree-icon" /><span class="tree-name">${sch.name}</span><span class="sr-count">${sch.tables.length}</span>
    </div>
    ${open && sch.tables.map((t) => html`<${TableNode} key=${t.name} conn=${conn} db=${db} schema=${sch.name} t=${t} depth=${depth + 1} />`)}
  </div>`;
}

function TableNode({ conn, db, schema, t, depth }) {
  const key = `t:${conn.id}:${db}:${schema}:${t.name}`;
  const open = sq.open.value.has(key);
  return html`<div>
    <div class="tree-row" style=${{ '--depth': depth }} aria-expanded=${open} title="Double-click: SELECT its first rows" onClick=${() => toggleOpen(key)} onDblClick=${() => openTable(conn, db, schema, t.name)}>
      <span class="tree-twisty"><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></span>
      <${Icon} name=${t.kind === 'view' ? 'eye' : 'table'} class="tree-icon" /><span class="tree-name">${t.name}</span>
      <span onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
        <${Menu} label="Table options" buttonClass="xs tree-more">
          <${MenuItem} icon="play" onClick=${() => openTable(conn, db, schema, t.name)}>Select first rows<//>
          <${MenuItem} icon="file" onClick=${() => openDdl(conn, db, schema, t.name)}>Show DDL<//>
          <${MenuItem} icon="bot" onClick=${() => askAboutTable(conn, db, schema, t.name)}>Ask the agent about it<//>
        <//>
      </span>
    </div>
    ${open && t.columns.map((col) => html`<div key=${col.name} class="tree-row sql-col" style=${{ '--depth': depth + 1 }}>
      <span class="tree-twisty"></span><${Icon} name=${col.pk ? 'key-round' : 'file'} class=${cx('tree-icon', col.pk && 'pk')} />
      <span class="tree-name">${col.name}</span><span class="sql-type">${col.type}${col.nullable ? '' : ' · not null'}</span>
    </div>`)}
  </div>`;
}

function Tree() {
  const conns = sq.conns.value;
  return html`<div class="files-pane">
    <div class="pane-head"><span class="pane-title">Database</span><div class="spacer"></div>
      ${isAdmin.value && html`<button class="icon-btn xs" title="Add a connection" aria-label="Add a connection" onClick=${() => { sq.editing.value = { conn: null }; }}><${Icon} name="plus" /></button>`}
      <button class="icon-btn xs" title="Reload connections" aria-label="Reload connections" onClick=${loadConns}><${Icon} name="refresh-cw" /></button>
    </div>
    <div class="tree">
      ${conns == null ? html`<div class="tree-empty"><${Spinner} /></div>`
        : conns.length ? conns.map((c) => html`<${ConnNode} key=${c.id} conn=${c} />`)
          : html`<div class="tree-empty small dim">${isAdmin.value ? 'No connections yet. Add one with the + above.' : 'No connections yet. An admin adds them.'}</div>`}
    </div>
  </div>`;
}

// ---------- the connection dialog (admins) ----------

function ConnectionForm({ conn }) {
  const [f, setF] = useState(() => ({
    id: conn?.id ?? '', label: conn?.label ?? '', driver: conn?.driver ?? 'postgres', host: conn?.host ?? 'localhost',
    port: conn?.port ? String(conn.port) : '', user: conn?.user ?? '', password: '', database: conn?.database ?? '',
    ssl: conn?.ssl ?? 'disable', file: conn?.file ?? '', access: conn?.access ?? 'admin', readOnly: conn?.readOnly ?? false,
    agent: conn?.agent ?? 'off', allDatabases: conn?.allDatabases ?? false,
  }));
  const [error, setError] = useState('');
  const [tested, setTested] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
  const sqlite = f.driver === 'sqlite';
  const close = () => { sq.editing.value = null; };
  const body = () => ({
    label: f.label.trim() || f.id, driver: f.driver, access: f.access, readOnly: f.readOnly, agent: f.agent,
    ...(sqlite ? { file: f.file.trim() } : {
      host: f.host.trim(), port: Number(f.port) || PORTS[f.driver], user: f.user.trim(), database: f.database.trim(), ssl: f.ssl,
      ...(f.password && { password: f.password }),
      ...(f.driver === 'postgres' && { allDatabases: f.allDatabases }),
    }),
  });
  const save = async () => {
    setError('');
    const id = (conn?.id ?? f.id).trim();
    try {
      if (!conn && sq.conns.value?.some((c) => c.id === id)) throw new Error(`there already is a connection named ${id}`);
      await api(`/api/db/connections/${encodeURIComponent(id)}`, { method: 'PUT', body: body() });
      await loadConns();
      loadSchema(id, '', true);
      if (f.driver === 'postgres' && f.allDatabases) loadDatabases(id, true);
      toast(`${f.label || id} saved`);
      close();
    } catch (e) { setError(e.message); }
  };
  const test = async () => {
    setTested(null);
    try { setTested({ ok: true, ...(await api('/api/db/test', { method: 'POST', body: { ...body(), ...(conn && { id: conn.id }) } })) }); } catch (e) { setTested({ ok: false, error: e.message }); }
  };
  const forgetPassword = guarded(async () => {
    await api(`/api/db/connections/${conn.id}`, { method: 'PUT', body: { ...body(), password: '' } });
    await loadConns();
    toast('Password removed');
  });
  const access = Object.keys(ACCESS).filter((k) => isOwner.value || k !== 'owner');
  return html`<div class="dialog-body sql-form">
    <div class="dialog-head"><h2>${conn ? `Edit ${conn.label}` : 'Add a connection'}</h2>
      <button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    <${Seg} label="Database engine" value=${f.driver} options=${Object.entries(DRIVERS)} onChange=${(v) => setF({ ...f, driver: v, port: '' })} />
    <div class="row wrap">
      ${!conn && html`<${Field} label="Name" hint="Lowercase letters, digits, - and _. Agents name it so.">
        <input class="mono" value=${f.id} onInput=${set('id')} placeholder="app-prod" autofocus /><//>`}
      <${Field} label="Label"><input value=${f.label} onInput=${set('label')} placeholder="App (production)" /><//>
    </div>
    ${sqlite ? html`<${Field} label="Database file" hint="An absolute path on the server.">
        <input class="mono" value=${f.file} onInput=${set('file')} placeholder="/srv/data/app.db" /><//>`
    : html`
      <div class="row wrap">
        <${Field} label="Host"><input class="mono" value=${f.host} onInput=${set('host')} placeholder="localhost" /><//>
        <${Field} label="Port"><input class="mono sql-port" inputmode="numeric" value=${f.port} onInput=${set('port')} placeholder=${String(PORTS[f.driver])} /><//>
      </div>
      <div class="row wrap">
        <${Field} label=${f.driver === 'postgres' && f.allDatabases ? 'Default database' : 'Database'}><input class="mono" value=${f.database} onInput=${set('database')} placeholder=${f.driver === 'postgres' ? 'postgres' : 'all databases'} /><//>
        <${Field} label="SSL"><select value=${f.ssl} onChange=${set('ssl')}>
          <option value="disable">Off</option><option value="require">On, any certificate</option><option value="verify-full">On, verified certificate</option></select><//>
      </div>
      <div class="row wrap">
        <${Field} label="User"><input class="mono" autocomplete="off" value=${f.user} onInput=${set('user')} /><//>
        <${Field} label="Password" hint=${conn?.hasPassword ? 'Saved. Leave empty to keep it.' : ''}>
          <input type="password" class="mono" autocomplete="new-password" value=${f.password} onInput=${set('password')} placeholder=${conn?.hasPassword ? '••••••••' : ''} /><//>
      </div>
      ${f.driver === 'postgres' && html`
        <label class="check small"><input type="checkbox" checked=${f.allDatabases} onChange=${set('allDatabases')} />
          Show every database on the server this user may connect to, not only the one above (agent access covers them too)</label>`}`}
    <div class="row wrap">
      <${Field} label="Who may open it"><select value=${f.access} onChange=${set('access')}>
        ${access.map((k) => html`<option value=${k}>${ACCESS[k]}</option>`)}</select><//>
    </div>
    <label class="check small"><input type="checkbox" checked=${f.readOnly} onChange=${(e) => setF({ ...f, readOnly: e.currentTarget.checked, agent: e.currentTarget.checked && (f.agent === 'read-write' || f.agent === 'approve') ? 'read-only' : f.agent })} />
      Read-only for everyone: the database refuses anything that writes</label>
    <div class="field"><span class="field-label">Agent access</span>
      <${Seg} small label="Agent access" value=${f.agent} onChange=${(v) => setF({ ...f, agent: v })}
        options=${Object.entries(AGENT).filter(([k]) => !(f.readOnly && (k === 'read-write' || k === 'approve')))} />
      <span class="field-hint">${AGENT_HINT[f.agent]}${f.agent !== 'off' ? ' Only agents working for someone who may open it; every query they run is logged, and statements that reach server files, programs or settings are refused. Chats reach these tools with MCP_INJECT=1.' : ''}</span>
    </div>
    ${f.agent !== 'off' && html`<p class="small dim">An agent with a shell can still reach a database it has the address and credentials of (a <span class="mono">.env</span> in its project, say). For a strict limit, give this connection a database user that may only read.</p>`}
    ${tested && (tested.ok ? html`<p class="small"><${Icon} name="circle-check" /> Connected: ${tested.version}</p>
      ${tested.warnings?.map((w) => html`<div class="sql-warning small" role="alert"><${Icon} name="triangle-alert" /><span>${w}${f.agent !== 'off' ? ' Agents have these rights too, whatever the agent access says.' : ''}</span></div>`)}`
      : html`<div class="form-error" role="alert">${tested.error}</div>`)}
    ${error && html`<div class="form-error" role="alert">${error}</div>`}
    <div class="row wrap">
      <${AsyncButton} class="btn" icon="refresh-cw" onClick=${test}>Test connection<//>
      ${conn?.hasPassword && !sqlite && html`<button class="btn ghost danger sm" onClick=${forgetPassword}>Remove password</button>`}
      <div class="spacer"></div>
      <button class="btn" onClick=${close}>Cancel</button>
      <${AsyncButton} class="btn primary" onClick=${save}>Save<//>
    </div>
  </div>`;
}

function AgentLog({ id }) {
  const [list, setList] = useState(null);
  useEffect(() => { api(`/api/db/connections/${id}/log`).then(setList).catch((e) => { toast(e.message, 'err'); setList([]); }); }, [id]);
  const close = () => { sq.log.value = null; };
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Agent queries: ${connOf(id)?.label ?? id}</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    ${list == null ? html`<div class="pane-loading"><${Spinner} /></div>`
      : !list.length ? html`<${Empty} icon="bot" title="No agent queries yet">The last 200 queries agents run here are listed.<//>`
        : html`<div class="sql-log">${list.map((q, i) => html`<div key=${i} class=${cx('sql-log-item', !q.ok && 'failed')}>
          <div class="small dim row wrap"><${Icon} name=${q.ok ? 'circle-check' : 'circle-alert'} class="tiny" />
            <span>${new Date(q.at).toLocaleString()}</span><span>· ${q.who || 'an agent'}</span>
            ${q.database && html`<span>· on <span class="mono">${q.database}</span></span>`}
            ${q.conv && html`<a href=${`/#c=${q.conv}`} target="_blank">· its chat</a>`}
            <span>· ${q.ok ? `${q.rows} rows` : 'failed'} · ${q.ms} ms</span></div>
          <pre class="mono">${q.sql}</pre>
          ${q.error && html`<div class="small err">${q.error}</div>`}
        </div>`)}</div>`}
  </div>`;
}

const rowsText = (n) => (n == null ? 'every row' : `all ${n.toLocaleString()} row${n === 1 ? '' : 's'}`);

/** A script that would change every row of a table: which statements, how many rows now, and Run anyway. */
function UnsafeConfirm({ list, conn, go }) {
  const close = () => { sq.unsafe.value = null; };
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Change every row?</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    <p class="small">${list.length === 1 ? 'This statement has' : 'These statements have'} no WHERE, so ${list.length === 1 ? 'it changes' : 'they change'} every row on <strong>${conn}</strong>:</p>
    ${list.map((u) => html`<div class="sql-warning small"><${Icon} name="triangle-alert" /><div>
      <strong>${u.kind === 'truncate' ? 'TRUNCATE' : u.kind.toUpperCase()} ${u.table}</strong>: ${u.kind === 'update' ? 'changes' : 'removes'} ${rowsText(u.rows)}.
      <pre class="mono sql-preview">${u.sql}</pre></div></div>`)}
    <p class="small dim">Nothing has run. Add a WHERE to touch only some rows; run it anyway only if every row is meant.</p>
    <div class="row end">
      <button class="btn" autofocus onClick=${close}>Cancel</button>
      <button class="btn primary danger" onClick=${() => { close(); go(); }}><${Icon} name="play" />Run anyway</button>
    </div>
  </div>`;
}

/** The runs of this browser, newest first: the active console's connection, or every one. Click to put one in the console. */
function History() {
  const c = activeConsole();
  const [all, setAll] = useState(!c?.connId);
  const [q, setQ] = useState('');
  const close = () => { sq.history.value = false; };
  const list = pref(HISTORY, []).filter((h) => (all || (h.connId === c?.connId && (h.database || '') === (c?.database || '')))
    && (!q || h.sql.toLowerCase().includes(q.toLowerCase()))).slice(0, 200);
  const put = (h, andRun) => {
    if (!view || !c) return;
    const doc = view.state.doc;
    const insert = `${doc.length && !doc.toString().endsWith('\n') ? '\n\n' : ''}${h.sql}`;
    view.dispatch({ changes: { from: doc.length, insert }, selection: { anchor: doc.length + insert.length - h.sql.length, head: doc.length + insert.length } });
    close();
    view.focus();
    if (andRun) run(false);
  };
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Query history</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    <div class="row wrap">
      <input class="sql-history-search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Search" autofocus />
      <label class="check small"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.currentTarget.checked)} />Every connection</label>
    </div>
    ${!list.length ? html`<${Empty} icon="history" title="Nothing here yet">Every query you run is kept in this browser (the last 300).<//>`
      : html`<div class="sql-log">${list.map((h, i) => html`<div key=${i} class=${cx('sql-log-item sql-history-item', !h.ok && 'failed')}>
        <div class="small dim row wrap"><${Icon} name=${h.ok ? 'circle-check' : 'circle-alert'} class="tiny" />
          <span>${new Date(h.at).toLocaleString()}</span>
          ${all && html`<span>· ${connOf(h.connId)?.label ?? h.connId}${h.database ? ` · ${h.database}` : ''}</span>`}
          <span>· ${h.ok ? `${h.rows} rows` : 'failed'} · ${h.ms} ms</span>
          <div class="spacer"></div>
          <button class="btn ghost sm" disabled=${!c} onClick=${() => put(h, false)}>Insert</button>
          <button class="btn sm" disabled=${!c || !connOf(c.connId)} onClick=${() => put(h, true)}><${Icon} name="play" />Run</button>
        </div>
        <pre class="mono">${h.sql}</pre>
      </div>`)}</div>`}
  </div>`;
}

// ---------- the page ----------

function EditorHost() {
  const host = useRef(null);
  useLayoutEffect(() => {
    view = new EditorView({ parent: host.current });
    const c = activeConsole();
    if (c) activate(c.id);
    return () => { if (view) { const a = activeConsole(); if (a) states.set(a.id, view.state); view.destroy(); view = null; } };
  }, []);
  return html`<div class="cm-host" ref=${host}></div>`;
}

function Toolbar() {
  const c = activeConsole();
  const conns = sq.conns.value || [];
  const conn = c && connOf(c.connId);
  const running = c && sq.runs.value.get(c.id)?.running;
  return html`<div class="sql-bar">
    <select class="sql-conn" aria-label="Connection" value=${c?.connId || ''} onChange=${(e) => setConsoleConn(e.currentTarget.value)}>
      ${!conn && html`<option value="">Pick a connection…</option>`}
      ${conns.map((x) => html`<option value=${x.id}>${x.label} (${DRIVERS[x.driver]})</option>`)}
    </select>
    ${multi(conn) && html`<select class="sql-conn sql-db" aria-label="Database" value=${c.database || ownDb(conn)} onChange=${(e) => setConsoleDb(e.currentTarget.value)}>
      ${[...new Set([ownDb(conn), ...(c.database ? [c.database] : []), ...(sq.dbs.value.get(conn.id)?.list || [])])]
        .map((name) => html`<option value=${name}>${name}</option>`)}
    </select>`}
    ${running ? html`<button class="btn sm" title="Stop the running statement" onClick=${cancelRun}><${Spinner} />Cancel</button>`
      : html`<button class="btn primary sm" disabled=${!conn} title="Run the statement at the cursor, or the selection (Ctrl+Enter)" onClick=${() => run(false)}>
        <${Icon} name="play" />Run</button>`}
    <button class="btn sm" disabled=${!conn || running} title="Run every statement in this console (Ctrl+Shift+Enter)" onClick=${() => run(true)}>Run all</button>
    <button class="icon-btn sm" title="Format the selection or the console (Shift+Alt+F)" aria-label="Format SQL" onClick=${formatSql}><${Icon} name="wrap-text" /></button>
    <button class="icon-btn sm" title="Query history" aria-label="Query history" onClick=${() => { sq.history.value = true; }}><${Icon} name="history" /></button>
    <div class="spacer"></div>
    ${conn?.readOnly && html`<span class="ide-chip" title="The database refuses writes on this connection"><${Icon} name="eye" />read-only</span>`}
    <label class="small dim sql-limit">Rows
      <select value=${sq.limit.value} onChange=${(e) => { sq.limit.value = Number(e.currentTarget.value); keep('dalang-sql-limit', sq.limit.value); }}>
        ${LIMITS.map((n) => html`<option value=${n}>${n}</option>`)}</select></label>
  </div>`;
}

function ConsoleTabs() {
  const list = sq.consoles.value;
  return html`<div class="editor-tabs" role="tablist">
    ${list.map((c) => html`<div key=${c.id} role="tab" aria-selected=${c.id === sq.active.value} class=${cx('editor-tab', c.id === sq.active.value && 'active')}
      title=${c.title} onClick=${() => activate(c.id)} onAuxClick=${(e) => { if (e.button === 1) closeConsole(c.id); }}>
      <${Icon} name="square-code" class="tiny dim" /><span class="editor-tab-name">${c.title}</span>
      <button class="icon-btn xs editor-tab-close" aria-label=${`Close ${c.title}`} onClick=${(e) => { e.stopPropagation(); closeConsole(c.id); }}><${Icon} name="x" /></button>
    </div>`)}
    <button class="icon-btn sm sql-new" title="New console" aria-label="New console" onClick=${() => newConsole(activeConsole()?.connId || sq.conns.value?.[0]?.id || '')}><${Icon} name="plus" /></button>
  </div>`;
}

export function SqlEditor() {
  const [treeW, setTreeW] = useState(pref('dalang-sql-tree-w', 280));
  const [resH, setResH] = useState(pref('dalang-sql-res-h', Math.round(innerHeight * 0.4)));
  const sizes = useRef({});
  sizes.current = { treeW, resH };
  const start = useRef(null);

  useEffect(() => {
    document.title = 'SQL Editor · Dalang';
    const saved = pref('dalang-sql-consoles', null);
    loadConns().then(() => {
      if (saved?.consoles?.length) {
        batch(() => { sq.consoles.value = saved.consoles; activate(saved.consoles.some((c) => c.id === saved.active) ? saved.active : saved.consoles[0].id); });
      } else if (sq.conns.value?.length) newConsole(sq.conns.value[0].id);
    });
    // The browser's own Ctrl+Enter / Ctrl+S do nothing useful here; outside the editor they run too.
    const key = (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      if (e.key === 'Enter' && !e.target.closest?.('.cm-editor, input, select, textarea, dialog')) { e.preventDefault(); run(e.shiftKey); }
      if (e.key.toLowerCase() === 's') e.preventDefault();
    };
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, []);

  const c = activeConsole();
  const conn = c && connOf(c.connId);
  const pane = sq.pane.value;
  const panes = [['files', 'Database', 'database'], ['editor', 'Query', 'square-code'], ['terminal', 'Results', 'table']];
  return html`<div class="ide sql" data-pane=${pane} style=${{ '--tree-w': `${treeW}px`, '--term-h': `${resH}px` }}>
    <header class="ide-head">
      <a class="ide-brand" href="/" title="Back to Dalang" aria-label="Back to Dalang"><${Logo} size=${22} /></a>
      <div class="crumbs"><span class="crumb-title">SQL Editor</span></div>
      <div class="spacer"></div>
      ${conn && html`<span class="ide-chip hide-mobile" title=${conn.driver === 'sqlite' ? conn.file : `${conn.host}:${conn.port}`}><${Icon} name="database" />${DRIVERS[conn.driver]} · ${c.database || conn.database || (multi(conn) ? ownDb(conn) : conn.label)}</span>`}
    </header>
    <div class="ide-body">
      <div class="ide-files"><${Tree} /></div>
      <${Resizer} dir="v" onMove=${(dx) => {
        start.current ??= sizes.current.treeW;
        setTreeW(Math.min(Math.max(start.current + dx, 180), Math.min(640, innerWidth - 320)));
      }} onEnd=${() => { start.current = null; keep('dalang-sql-tree-w', sizes.current.treeW); }} />
      <div class="ide-main">
        <div class="editor-area">
          <${ConsoleTabs} />
          ${c && html`<${Toolbar} />`}
          <div class="editor-body">
            <div class="cm-wrap" hidden=${!c}><${EditorHost} /></div>
            ${!c && html`<div class="editor-placeholder"><${Empty} icon="database" title="No console open">
              ${sq.conns.value?.length ? html`Double-click a connection, or <button class="btn sm" onClick=${() => newConsole(sq.conns.value[0].id)}>open a console</button>`
                : isAdmin.value ? html`<button class="btn sm" onClick=${() => { sq.editing.value = { conn: null }; }}><${Icon} name="plus" />Add a connection</button>` : 'An admin adds the connections.'}<//></div>`}
          </div>
        </div>
        <${Resizer} dir="h" onMove=${(_dx, dy) => {
          start.current ??= sizes.current.resH;
          setResH(Math.min(Math.max(start.current - dy, 120), innerHeight - 200));
        }} onEnd=${() => { start.current = null; keep('dalang-sql-res-h', sizes.current.resH); }} />
        <div class="ide-term"><${Results} /></div>
      </div>
    </div>
    <footer class="ide-status">
      ${conn ? html`<span class="ide-stat"><${Icon} name="database" />${conn.label}</span>
        <span class="ide-stat">${DRIVERS[conn.driver]}</span>
        ${conn.readOnly && html`<span class="ide-stat"><${Icon} name="eye" />Read-only</span>`}
        <span class=${cx('ide-stat', conn.agent === 'read-write' && 'warn')} title="What agents may do on this connection"><${Icon} name="bot" />Agents: ${(AGENT[conn.agent] || conn.agent).toLowerCase()}</span>`
        : html`<span class="ide-stat">No connection</span>`}
      <div class="spacer"></div>
      <span class="ide-stat hide-mobile">Ctrl+Enter run · Ctrl+Shift+Enter run all · Shift+Alt+F format</span>
    </footer>
    <nav class="ide-nav"><${Seg} value=${pane} label="Pane" options=${panes} onChange=${(v) => { sq.pane.value = v; }} /></nav>
    <${Modal} open=${!!sq.editing.value} label="Connection" class="dialog sql-dialog" onClose=${() => { sq.editing.value = null; }}>
      ${sq.editing.value && html`<${ConnectionForm} conn=${sq.editing.value.conn} />`}<//>
    <${Modal} open=${!!sq.log.value} label="Agent queries" class="dialog sql-dialog" onClose=${() => { sq.log.value = null; }}>
      ${sq.log.value && html`<${AgentLog} id=${sq.log.value} />`}<//>
    <${Modal} open=${!!sq.unsafe.value} label="Change every row?" class="dialog sql-dialog" onClose=${() => { sq.unsafe.value = null; }}>
      ${sq.unsafe.value && html`<${UnsafeConfirm} ...${sq.unsafe.value} />`}<//>
    <${Modal} open=${sq.history.value} label="Query history" class="dialog sql-dialog" onClose=${() => { sq.history.value = false; }}>
      ${sq.history.value && html`<${History} />`}<//>
    <${Modal} open=${!!sq.ask.value} label="Ask the agent" class="dialog sql-dialog" onClose=${() => { sq.ask.value = null; }}>
      ${sq.ask.value && html`<${AskAgent} ...${sq.ask.value} onClose=${() => { sq.ask.value = null; }} />`}<//>
  </div>`;
}

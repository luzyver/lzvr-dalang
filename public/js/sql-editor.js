// The SQL editor: the panel's database connections in their own browser tab (/sql), not tied to a chat. Connections and
// their tables on the left, query consoles as tabs in the middle, results below (DataGrip's layout, kept as quiet as
// the code editor). Admins add and change connections, including whether agents may use them. The result grid lives in
// sql-grid.js, "Ask the agent" in sql-ask.js.
import { useEffect, useLayoutEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { batch, signal } from '../vendor/signals.js';
import * as cm from '../vendor/code/editor.js';
import { html, cx } from './lib.js';
import { api, downloadFile } from './api.js';
import { AsyncButton, confirmDialog, ContextMenu, Empty, Field, Icon, Logo, Menu, MenuItem, Modal, Resizer, Seg, Spinner } from './ui.js';
import { guarded, isAdmin, isOwner, toast } from './store.js';
import { copyText } from './code.js';
import { createState, EditorView } from './code-mirror.js';
import { ResultGrid } from './sql-grid.js';
import { AskAgent, contextFor } from './sql-ask.js';
import { download, FORMATS, safeFileName } from './sql-export.js';
import { cacheForget, cacheGet, cachePut } from './sql-cache.js';

const pref = (k, v) => { try { const s = localStorage.getItem(k); return s == null ? v : JSON.parse(s); } catch { return v; } };
const keep = (k, v) => { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } };
const mobile = () => innerWidth <= 760;

const DRIVERS = { postgres: 'PostgreSQL', mysql: 'MySQL', mariadb: 'MariaDB', sqlite: 'SQLite', mongodb: 'MongoDB', redis: 'Redis' };
/** MongoDB (mongosh-style commands) and Redis (its commands, one per line): no SQL, so no SQL-only features. */
const noSql = (conn) => conn?.driver === 'mongodb' || conn?.driver === 'redis';
/** Each engine's logo (public/icons/db-*.svg, from Simple Icons), in its own colour (app.css). */
const ENGINE_ICONS = { postgres: 'db-postgresql', mysql: 'db-mysql', mariadb: 'db-mariadb', sqlite: 'db-sqlite', mongodb: 'db-mongodb', redis: 'db-redis' };
const EngineIcon = ({ driver, class: cls }) => html`<${Icon} name=${ENGINE_ICONS[driver] || 'database'} class=${cx('engine', `engine-${driver}`, cls)} />`;
const PORTS = { postgres: 5432, mysql: 3306, mariadb: 3306, mongodb: 27017, redis: 6379 };
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
 * A console: { id, connId, database ('' = the connection's own; MySQL: the database it starts in), schema (PostgreSQL: the
 * one unqualified names are looked up in first), title, text }. Its editor state lives in `states` (by id), its last run in `runs`:
 * { running, script, readOnly, tabs, active, error }. `tabs` keep the results of earlier runs: one per table (or per
 * query that reads no table of its own), { key, result, meta (the table it shows, see tableMeta), at }; running a query
 * on the same table refreshes its tab, one on another table adds a tab. Statements that return no rows share the
 * 'out' tab ({ key: 'out', output: [{ sql, text, ms }] }); `error` ({ message, index, done }) has the 'err' tab.
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
  /** the backups dialog (what agents' writes changed, kept before they ran): a connection id */
  backups: signal(null),
  /** the history dialog is open */
  history: signal(false),
  /** "Ask the agent": { context, suggestion } */
  ask: signal(null),
  /** a script held because it would change every row: { list (from the server), conn, go() } */
  unsafe: signal(null),
  /** the results fill the page (the console hides) */
  resMax: signal(false),
  /** the workspaces ({ id, name, conns }) and the one shown; each has its own consoles */
  workspaces: signal(null),
  ws: signal(null),
  /** the tree's right-click menu: { at: { x, y }, items } */
  ctx: signal(null),
  /** what the tree is searched for */
  find: signal(''),
  /** the download dialog: { format, result, ctx, name (suggested) } */
  download: signal(null),
  /** the workspace dialog: { mode: 'new' | 'rename' | 'conns' } */
  wsDialog: signal(null),
};
/** console id -> the AbortController of its running query */
const ctrls = new Map();
const states = new Map();
/** console id -> the compartment its SQL language sits in */
const langs = new Map();
let view = null;

const connOf = (id) => sq.conns.value?.find((c) => c.id === id);
const currentWs = () => sq.workspaces.value?.find((w) => w.id === sq.ws.value);
/** The connections of the workspace shown (those this user may open), in the workspace's order. */
const wsConns = () => {
  const w = currentWs();
  if (!w) return sq.conns.value || [];
  return w.conns.map(connOf).filter(Boolean);
};
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
const consolesKey = (ws) => `dalang-sql-consoles:${ws}`;
/** Keeps the shown workspace's consoles (their text, the active one) in this browser, now. */
function persistNow() {
  clearTimeout(saveTimer);
  if (!sq.ws.value) return;
  const consoles = sq.consoles.value.map((c) => ({ ...c, text: states.get(c.id)?.doc.toString() ?? c.text }));
  keep(consolesKey(sq.ws.value), { consoles, active: sq.active.value });
}
function persist() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(persistNow, 400);
}

// ---------- statements ----------

/** Where each statement starts and ends, split on `;` outside strings and comments (as the server splits them). */
export function splitStatements(script, driver = 'postgres') {
  if (driver === 'mongodb' || driver === 'redis') return splitNoSql(script, driver);
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

/**
 * Where each command starts and ends (as the server splits them, nosql.ts). MongoDB: at ; or at a line that starts a
 * new db. command, outside strings, comments and brackets. Redis: one per line; # and // lines are comments.
 */
function splitNoSql(script, driver) {
  const out = [];
  if (driver === 'redis') {
    let at = 0;
    for (const line of script.split('\n')) {
      const t = line.trim();
      if (t && !t.startsWith('#') && !t.startsWith('//')) out.push({ from: at + line.indexOf(t[0]), to: at + line.trimEnd().length });
      at += line.length + 1;
    }
    return out;
  }
  let start = 0;
  let depth = 0;
  let code = false;
  let i = 0;
  const n = script.length;
  const end = (at, next) => { if (code) out.push({ from: start, to: at }); start = next; code = false; };
  while (i < n) {
    const ch = script[i];
    if (ch === '/' && script[i + 1] === '/') { const nl = script.indexOf('\n', i); i = nl < 0 ? n : nl; continue; }
    if (ch === '/' && script[i + 1] === '*') { const close = script.indexOf('*/', i + 2); i = close < 0 ? n : close + 2; continue; }
    if (ch === '"' || ch === '\'' || ch === '`') {
      i++;
      while (i < n && script[i] !== ch) i += script[i] === '\\' ? 2 : 1;
      i++;
      code = true;
      continue;
    }
    if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
    else if (ch === ';' && depth === 0) { end(i, i + 1); i++; continue; }
    else if (ch === '\n' && depth === 0 && code && NEXT_COMMAND.test(script.slice(i + 1))) { end(i, i + 1); i++; continue; }
    if (!/\s/.test(ch)) code = true;
    i++;
  }
  end(n, n);
  return out.map((r) => tighten(script, r));
}

/** A line that starts a MongoDB command, after blank and comment lines. */
const NEXT_COMMAND = /^(?:[ \t]*(?:\/\/[^\n]*)?\r?\n)*\s*(db\s*[.[]|show\s|use\s)/;
/** A command's range without the blank and comment-only lines at its start and end. */
function tighten(script, r) {
  let { from, to } = r;
  for (;;) {
    const head = /^(?:\s*\/\/[^\n]*\n|\s+)/.exec(script.slice(from, to));
    if (!head || !head[0].length) break;
    from += head[0].length;
  }
  for (;;) {
    const tail = /(?:\n[ \t]*\/\/[^\n]*|\s+)$/.exec(script.slice(from, to));
    if (!tail || !tail[0].length) break;
    to -= tail[0].length;
  }
  return { from, to };
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

async function loadWorkspaces() {
  try { sq.workspaces.value = await api('/api/db/workspaces'); } catch (e) { sq.workspaces.value = sq.workspaces.value || []; toast(e.message, 'err'); }
}

/** Shows workspace `id` with its consoles (the shown one's are kept first). */
function openWorkspace(id) {
  const list = sq.workspaces.value || [];
  const w = list.find((x) => x.id === id) || list[0];
  if (!w) return;
  if (sq.ws.value === w.id && sq.consoles.value.length) return;
  persistNow();
  let saved = pref(consolesKey(w.id), null);
  // Consoles from before workspaces existed go to the first workspace opened.
  const old = pref('dalang-sql-consoles', null);
  if (!saved && old) { saved = old; try { localStorage.removeItem('dalang-sql-consoles'); } catch { /* private mode */ } }
  batch(() => {
    sq.ws.value = w.id;
    sq.consoles.value = saved?.consoles || [];
    activate(saved?.consoles?.some((c) => c.id === saved.active) ? saved.active : saved?.consoles?.[0]?.id ?? null);
  });
  keep('dalang-sql-ws', w.id);
  history.replaceState(null, '', `${location.pathname}#w=${encodeURIComponent(w.id)}`);
  if (!sq.consoles.value.length && wsConns().length) newConsole(wsConns()[0].id);
  persistNow();
}

/** Puts connection `connId` in the shown workspace (`on`) or takes it out. */
const setInWorkspace = (connId, on) => guarded(async () => {
  const w = currentWs();
  const conns = on ? [...new Set([...w.conns, connId])] : w.conns.filter((c) => c !== connId);
  await api(`/api/db/workspaces/${w.id}`, { method: 'PATCH', body: { conns } });
  await loadWorkspaces();
})();

async function loadConns() {
  try { sq.conns.value = await api('/api/db/connections'); } catch (e) { sq.conns.value = sq.conns.value || []; toast(e.message, 'err'); }
}

/** skey -> the schema read in flight, so a second caller waits for the same one. */
const loadingSchemas = new Map();

/** What was read about a database is read again by itself once it is this old (else on Refresh or after DDL). */
const STALE_MS = 7 * 24 * 3600 * 1000;
/** The key of a connection's database list in the browser's memory (sql-cache.js). */
const dbsKey = (connId) => `${connId}/\u0001databases`;

/**
 * The tables of a database: from memory, else from what this browser kept (shown at once; read again in the
 * background once a week old), else read from the server and kept. `force` (Refresh, DDL) reads it again, showing the
 * old list meanwhile.
 */
function loadSchema(connId, db = '', force = false) {
  const key = skey(connId, db);
  if (loadingSchemas.has(key)) return loadingSchemas.get(key);
  const cur = sq.schemas.value.get(key);
  if (cur?.data && !force) return Promise.resolve();
  const set = (v) => { const m = new Map(sq.schemas.value); m.set(key, v); sq.schemas.value = m; };
  const done = () => {
    loadingSchemas.delete(key);
    const c = activeConsole();
    if (c?.connId === connId && (c.database || '') === db) applyLanguage();
  };
  const p = (async () => {
    if (!force && !cur?.data) {
      const kept = await cacheGet(key);
      if (kept?.data) {
        set({ data: kept.data, at: kept.at });
        done();
        if (Date.now() - kept.at > STALE_MS) void loadSchema(connId, db, true);
        return;
      }
    }
    set({ ...sq.schemas.value.get(key), loading: true, error: null });
    try {
      const data = await api(`/api/db/connections/${connId}/schema${dbParam(db)}`);
      const at = Date.now();
      set({ data, at });
      void cachePut(key, data, at);
    } catch (e) {
      const old = sq.schemas.value.get(key);
      // A failed refresh keeps the list it had.
      if (old?.data) { set({ ...old, loading: false }); toast(e.message, 'err'); } else set({ error: e.message });
    }
    done();
  })();
  loadingSchemas.set(key, p);
  return p;
}

/** skey#schema -> the columns read in flight. */
const loadingColumns = new Map();

/**
 * Reads one schema's columns into the table list of its database, where a big database came without them (each
 * schema `loaded: false`). Resolves once they are there.
 */
function loadColumns(connId, db, name) {
  const key = `${skey(connId, db)}#${name}`;
  const sch = sq.schemas.value.get(skey(connId, db))?.data?.schemas.find((x) => x.name === name);
  if (!sch || sch.loaded) return Promise.resolve();
  if (loadingColumns.has(key)) return loadingColumns.get(key);
  const p = (async () => {
    try {
      const r = await api(`/api/db/connections/${connId}/schema?schema=${encodeURIComponent(name)}${db ? `&database=${encodeURIComponent(db)}` : ''}`);
      const cur = sq.schemas.value.get(skey(connId, db));
      if (cur?.data) {
        const fresh = r.schemas[0];
        const m = new Map(sq.schemas.value);
        const next = { ...cur, data: { schemas: cur.data.schemas.map((x) => (x.name !== name ? x : fresh ? { ...fresh, loaded: true } : { ...x, loaded: true })) } };
        m.set(skey(connId, db), next);
        sq.schemas.value = m;
        if (next.at) void cachePut(skey(connId, db), next.data, next.at);
      }
    } catch (e) { toast(e.message, 'err'); }
    loadingColumns.delete(key);
    const c = activeConsole();
    if (c?.connId === connId && (c.database || '') === db) applyLanguage();
  })();
  loadingColumns.set(key, p);
  return p;
}

/** The databases of a connection that opens every one: kept in this browser like the tables (see loadSchema). */
async function loadDatabases(connId, force = false) {
  const cur = sq.dbs.value.get(connId);
  if (cur && (cur.loading || (cur.list && !force))) return;
  const set = (v) => { const m = new Map(sq.dbs.value); m.set(connId, v); sq.dbs.value = m; };
  if (!force && !cur?.list) {
    const kept = await cacheGet(dbsKey(connId));
    if (kept?.data) {
      set({ list: kept.data, at: kept.at });
      if (Date.now() - kept.at > STALE_MS) void loadDatabases(connId, true);
      return;
    }
  }
  set({ ...sq.dbs.value.get(connId), loading: true, error: null });
  try {
    const list = (await api(`/api/db/connections/${connId}/databases`)).databases;
    const at = Date.now();
    set({ list, at });
    void cachePut(dbsKey(connId), list, at);
  } catch (e) {
    const old = sq.dbs.value.get(connId);
    if (old?.list) { set({ ...old, loading: false }); toast(e.message, 'err'); } else set({ error: e.message });
  }
}

/** Forgets what was read about a connection, here and in this browser (its address or database changed, or it went). */
async function forgetRead(connId) {
  await cacheForget(connId);
  const m = new Map(sq.schemas.value);
  for (const k of m.keys()) if (k.startsWith(`${connId}/`)) m.delete(k);
  sq.schemas.value = m;
  const d = new Map(sq.dbs.value);
  d.delete(connId);
  sq.dbs.value = d;
}

/** "read 3h ago", for the tree. */
function readAgo(at) {
  if (!at) return '';
  const s = Math.max(0, (Date.now() - at) / 1000);
  const n = s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
  return `read ${n}`;
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
  const defaultSchema = conn ? defaultSchemaOf(conn, c.database || '', c.schema) : undefined;
  const set = (support) => {
    if (!view || activeConsole()?.id !== c.id) return;
    view.dispatch({ effects: langs.get(c.id).reconfigure(support) });
    states.set(c.id, view.state);
  };
  if (conn?.driver === 'redis') { set([]); return; }
  if (conn?.driver === 'mongodb') {
    cm.LanguageDescription.matchLanguageName(cm.languages, 'JavaScript')?.load().then(set, () => set([]));
    return;
  }
  set(cm.sql({ dialect: DIALECTS[conn?.driver] || cm.StandardSQL, schema, defaultSchema, upperCaseKeywords: true }));
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

function setConsoleSchema(schema) {
  const c = activeConsole();
  if (!c) return;
  sq.consoles.value = sq.consoles.value.map((x) => (x.id === c.id ? { ...x, schema: schema === 'public' ? '' : schema } : x));
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

const DDL = /^\s*(create|alter|drop|rename|truncate|comment)\b|\.\s*(drop|createCollection|createView|renameCollection|dropDatabase)\s*\(/im;

/** Always quoted: for SQL the editor writes itself (filters, sorting). */
const qi = (conn, name) => (conn.driver === 'mysql' || conn.driver === 'mariadb' ? `\`${name.replace(/`/g, '``')}\`` : `"${name.replace(/"/g, '""')}"`);
/** The schema an unqualified table name means: the console's (PostgreSQL), its database (MySQL), SQLite's main. */
const defaultSchemaOf = (conn, db, schema) => (conn.driver === 'postgres' ? schema || 'public' : conn.driver === 'sqlite' ? 'main' : db || conn.database || undefined);

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
function tableMeta(conn, db, result, consoleSchema) {
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
  if (!b && hits.length > 1) hits = hits.filter((h) => h.schema === defaultSchemaOf(conn, db, consoleSchema));
  if (hits.length !== 1) return null;
  const { schema, t } = hits[0];
  const pk = t.columns.filter((col) => col.pk).map((col) => col.name);
  if (!pk.length || !pk.every((n) => result.columns.some((col) => col.name === n))) return null;
  return { schema, table: t.name, pk, where: WHERE_PART.exec(tail)?.[1]?.trim() ?? '', order: null };
}

/**
 * Reads the columns of the schemas the results' `SELECT * FROM <table>` may come from (a big database comes without
 * them), so tableMeta can tell the table's primary key.
 */
async function columnsFor(conn, db, results, consoleSchema) {
  const data = sq.schemas.value.get(skey(conn.id, db))?.data;
  if (!data) return;
  const want = new Set();
  for (const r of results) {
    const m = r.columns.length && TABLE_SELECT.exec(r.sql);
    if (!m) continue;
    const [, a, b] = m;
    const holding = data.schemas.filter((sch) => (b ? sameName(a, sch.name) : sch.tables.some((t) => sameName(a, t.name))));
    // An unqualified name in several schemas means the default one's table: only that schema is read.
    const own = !b && holding.find((sch) => sch.name === defaultSchemaOf(conn, db, consoleSchema));
    for (const sch of own ? [own] : holding) if (!sch.loaded) want.add(sch.name);
  }
  await Promise.all([...want].slice(0, 3).map((name) => loadColumns(conn.id, db, name)));
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
  const note = (ok, rows) => remember({ sql: sql.trim(), connId: conn.id, database: db, ws: sq.ws.value, at: t0, ms: Date.now() - t0, ok, rows });
  try {
    const r = await api(`/api/db/connections/${conn.id}/query`, { method: 'POST', signal: ac.signal, body: { sql, limit: sq.limit.value, ...(db && { database: db }), ...(conn.driver === 'postgres' && c.schema && { schema: c.schema }), ...(confirmed && { confirmed }) } });
    // A table's rows need its primary key: the table list (and on a big database its schema's columns) must be there.
    await loadSchema(conn.id, db);
    await columnsFor(conn, db, r.results, c.schema);
    setRun(c.id, { running: false, readOnly: r.readOnly, error: null, ...withResults(sq.runs.value.get(c.id), conn, db, r.results, c.schema) });
    note(true, r.results.reduce((n, x) => n + x.rows.length, 0));
    if (r.results.some((x) => DDL.test(x.sql))) loadSchema(conn.id, db, true);
  } catch (e) {
    if (e.status === 409 && e.detail?.unsafe) {
      // Nothing ran: the results stay as they were until the user decides.
      setRun(c.id, { ...before, running: false });
      sq.unsafe.value = { list: e.detail.unsafe, conn: conn.label, unit: conn.driver === 'mongodb' ? 'document' : conn.driver === 'redis' ? 'key' : 'row', go: () => { activate(c.id); run(false, sql, true); } };
      return;
    }
    // A failed statement still shows what ran before it, in tabs of their own.
    const results = e.detail?.results || [];
    const message = e.name === 'AbortError' ? 'Cancelled. The database was asked to stop the statement.' : e.message;
    const { tabs } = withResults(sq.runs.value.get(c.id), conn, db, results, c.schema);
    setRun(c.id, { running: false, tabs, active: 'err', error: { message, index: e.detail?.index ?? results.length, done: results.length } });
    note(false, 0);
  } finally { if (ctrls.get(c.id) === ac) ctrls.delete(c.id); }
}

const MAX_TABS = 12;
const squash = (sql) => sql.replace(/\s+/g, ' ').trim().toLowerCase();

/**
 * The run's tabs with `results` put in: a table's rows (or a query's) replace the tab that showed the same table (or
 * query), others go on the end; statements that return no rows fill the 'out' tab. The newest becomes the active one.
 */
function withResults(cur, conn, db, results, schema) {
  const tabs = [...(cur?.tabs || [])].filter((t) => t.key !== 'out' || !results.some((x) => !x.columns.length));
  const out = [];
  let active = cur?.active && cur.active !== 'err' ? cur.active : null;
  const at = Date.now();
  for (const result of results) {
    if (!result.columns.length) { out.push({ sql: result.sql, text: result.note ? `${summary(result)} · ${result.note}` : summary(result), ms: result.ms }); continue; }
    const meta = tableMeta(conn, db, result, schema);
    const key = meta ? `t:${db}:${meta.schema}.${meta.table}` : `q:${squash(result.sql)}`;
    const tab = { key, result, meta, at };
    const i = tabs.findIndex((t) => t.key === key);
    if (i >= 0) tabs[i] = tab; else tabs.push(tab);
    active = key;
  }
  if (out.length) { tabs.push({ key: 'out', output: out, at }); if (!active || results.every((x) => !x.columns.length)) active = 'out'; }
  // The oldest go first when there are too many (never the one just shown).
  while (tabs.length > MAX_TABS) tabs.splice(tabs.findIndex((t) => t.key !== active), 1);
  return { tabs, active };
}

function closeTab(c, key) {
  const cur = sq.runs.value.get(c.id);
  if (!cur) return;
  if (key === 'err') { setRun(c.id, { error: null, active: cur.tabs.at(-1)?.key ?? null }); return; }
  const i = cur.tabs.findIndex((t) => t.key === key);
  const tabs = cur.tabs.filter((t) => t.key !== key);
  const active = cur.active !== key ? cur.active : (tabs[Math.min(i, tabs.length - 1)]?.key ?? (cur.error ? 'err' : null));
  setRun(c.id, { tabs, active });
}

/** Stops the active console's query: the request closes and the server cancels the statement. */
function cancelRun() {
  const c = activeConsole();
  ctrls.get(c?.id)?.abort();
}

/** Reads a table result again with another filter or sort order (from the grid). */
async function requery(c, key, meta, { where, order }) {
  const conn = connOf(c.connId);
  if (!conn) return;
  const ref = conn.driver === 'sqlite' ? qi(conn, meta.table) : `${qi(conn, meta.schema)}.${qi(conn, meta.table)}`;
  const sql = `SELECT * FROM ${ref}${where.trim() ? ` WHERE ${where.trim()}` : ''}${order ? ` ORDER BY ${qi(conn, order.col)} ${order.desc ? 'DESC' : 'ASC'}` : ''}`;
  try {
    const r = await api(`/api/db/connections/${conn.id}/query`, { method: 'POST', body: { sql, limit: sq.limit.value, ...(c.database && { database: c.database }) } });
    const cur = sq.runs.value.get(c.id);
    setRun(c.id, { tabs: cur.tabs.map((t) => (t.key === key ? { ...t, result: r.results[0], meta: { ...meta, where, order }, at: Date.now() } : t)) });
  } catch (e) { toast(e.message, 'err'); }
}

/** The statements the grid's edits make, as the server would run them (values written in), without running them. */
async function previewEdits(c, meta, edits) {
  const conn = connOf(c.connId);
  const r = await api(`/api/db/connections/${conn.id}/edit`, { method: 'POST', body: { ...(c.database && { database: c.database }), schema: meta.schema, table: meta.table, edits, preview: true } });
  return r.statements;
}

/** Saves the grid's edits to its table, then reads the table again. True when saved. */
async function submitEdits(c, key, meta, edits) {
  const conn = connOf(c.connId);
  try {
    const r = await api(`/api/db/connections/${conn.id}/edit`, { method: 'POST', body: { ...(c.database && { database: c.database }), schema: meta.schema, table: meta.table, edits } });
    toast(`${r.changed} row${r.changed === 1 ? '' : 's'} saved`);
    await requery(c, key, meta, meta);
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
  const onError = r?.active === 'err' && !!r.error;
  const tab = !onError && r?.tabs?.find((t) => t.key === r.active);
  const shown = tab?.result ?? null;
  const sql = shown ? shown.sql : tab?.output ? tab.output.map((o) => o.sql).join(';\n') : r?.script ?? currentStatement(view.state, conn.driver);
  sq.ask.value = {
    suggestion: onError ? 'Why does this fail, and how do I fix it?' : '',
    context: contextFor({
      conn, engine: DRIVERS[conn.driver], database: c.database || (multi(conn) ? ownDb(conn) : ''), sql,
      error: onError ? r.error.message : null, result: shown, schemas: sq.schemas.value.get(skey(conn.id, c.database || ''))?.data?.schemas,
    }),
  };
}

// ---------- results ----------

/** Copy and Download, each a menu of the formats in sql-export.js. */
function ExportMenus({ result, tab, conn }) {
  const ctx = { driver: conn?.driver, table: tab.meta ? { schema: tab.meta.schema, table: tab.meta.table } : null, sheet: tabLabel(tab) };
  // The suggested name: the tab's, and when (the dialog lets one change it).
  const d = new Date();
  const p2 = (n) => String(n).padStart(2, '0');
  const name = `${safeFileName(tabLabel(tab)).replace(/\s+/g, '_') || 'result'}_${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}_${p2(d.getHours())}${p2(d.getMinutes())}`;
  const rows = `${result.rows.length}${result.truncated ? ' (the row limit)' : ''} row${result.rows.length === 1 ? '' : 's'}`;
  return html`
    <${Menu} icon="copy" label="Copy rows as…" buttonClass="xs">
      <div class="menu-label">Copy ${rows} as</div>
      ${FORMATS.filter((f) => f.copy).map((f) => html`<${MenuItem} key=${f.id} onClick=${() => copyText(f.build(result, ctx), `copied as ${f.label.replace(/ \(.*/, '')}`)}>${f.label}<//>`)}
    <//>
    <${Menu} icon="arrow-down-to-line" label="Download as…" buttonClass="xs">
      <div class="menu-label">Download ${rows} as</div>
      ${FORMATS.filter((f) => !(f.id === 'sql' && noSql(conn))).map((f) => html`<${MenuItem} key=${f.id} onClick=${() => { sq.download.value = { format: f, result, ctx, name }; }}>${f.label}<span class="dim mono menu-ext">.${f.ext}</span><//>`)}
    <//>`;
}

/** The file name of a download, suggested and changeable, then Download. */
function DownloadDialog({ format, result, ctx, name }) {
  const [file, setFile] = useState(name);
  const close = () => { sq.download.value = null; };
  const go = () => { download(format, result, ctx, file); close(); };
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Download ${format.label.replace(/ \(.*/, '')}</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    <${Field} label="File name" hint=${`${result.rows.length}${result.truncated ? ' (the row limit)' : ''} row${result.rows.length === 1 ? '' : 's'}. Characters a file name cannot hold become _.`}>
      <div class="sql-file-name">
        <input class="mono" value=${file} autofocus onFocus=${(e) => e.currentTarget.select()} onInput=${(e) => setFile(e.currentTarget.value)}
          onKeyDown=${(e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } }} />
        <span class="mono dim">.${format.ext}</span>
      </div><//>
    <div class="row end">
      <button class="btn" onClick=${close}>Cancel</button>
      <button class="btn primary" disabled=${!safeFileName(file)} onClick=${go}><${Icon} name="arrow-down-to-line" />Download</button>
    </div>
  </div>`;
}

const summary = (r) => (r.columns.length
  ? `${r.rows.length}${r.truncated ? '+' : ''} row${r.rows.length === 1 ? '' : 's'}`
  : r.affected != null ? `${r.affected} row${r.affected === 1 ? '' : 's'} affected` : 'done');
const firstWord = (sql) => (/^\s*(\w+)/.exec(sql)?.[1] || 'SQL').toUpperCase();

/** A tab's name: its table, or what its query reads from, or its first word. */
function tabLabel(t) {
  if (t.key === 'out') return 'Output';
  if (t.meta) return t.meta.table;
  // MongoDB: the collection and the method (users.find), or the database's method (getCollectionNames).
  const mongo = /^\s*db\s*(?:\.\s*getCollection\(\s*["']([^"']+)["']\s*\)|\[\s*["']([^"']+)["']\s*\]|\.\s*([\w$.]+?))\s*\.\s*(\w+)\s*\(/.exec(t.result.sql);
  if (mongo) return `${mongo[1] ?? mongo[2] ?? mongo[3]}.${mongo[4]}`;
  const dbCall = /^\s*db\s*\.\s*(\w+)\s*\(/.exec(t.result.sql) || /^\s*show\s+(\w+)/i.exec(t.result.sql);
  if (dbCall) return dbCall[1];
  const from = /\bfrom\s+((?:"[^"]+"|`[^`]+`|[\w$]+)(?:\.(?:"[^"]+"|`[^`]+`|[\w$]+))?)/i.exec(t.result.sql)?.[1];
  return from ? `${firstWord(t.result.sql)} ${from.replace(/["`]/g, '')}` : firstWord(t.result.sql);
}

/**
 * The results over the whole screen and back: everything else hides and the browser goes full screen (where it lets
 * the page). Ctrl+Shift+' (JetBrains' key for it); Esc, or leaving full screen, comes back.
 */
function toggleResMax(on = !sq.resMax.value) {
  sq.resMax.value = on;
  if (on && !document.fullscreenElement) document.documentElement.requestFullscreen?.().catch(() => {});
  if (!on && document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}
const MaxButton = () => html`<button class="icon-btn xs hide-mobile" aria-pressed=${sq.resMax.value}
  title=${sq.resMax.value ? 'Back (Esc)' : "Results full screen (Ctrl+Shift+')"}
  aria-label=${sq.resMax.value ? 'Restore the results' : 'Maximize the results'} onClick=${() => toggleResMax()}>
  <${Icon} name=${sq.resMax.value ? 'minimize-2' : 'maximize-2'} /></button>`;

function Results() {
  const c = activeConsole();
  const r = c && sq.runs.value.get(c.id);
  if (!c) return html`<div class="sql-results"><div class="term-empty dim small">No console open.</div></div>`;
  const tabs = r?.tabs || [];
  if (!r || (!r.running && !tabs.length && !r.error)) {
    return html`<div class="sql-results"><div class="term-empty dim small">
      <span>Run a statement with <kbd>Ctrl</kbd> <kbd>Enter</kbd>, or the whole console with <kbd>Ctrl</kbd> <kbd>Shift</kbd> <kbd>Enter</kbd>.</span></div></div>`;
  }
  const onError = r.active === 'err' && !!r.error;
  const tab = onError ? null : tabs.find((t) => t.key === r.active) || tabs.at(-1);
  const shown = tab?.result ?? null;
  const meta = tab?.meta ?? null;
  const conn = connOf(c.connId);
  const pick = (key) => setRun(c.id, { active: key });
  const close = (e, key) => { e.stopPropagation(); closeTab(c, key); };
  return html`<div class="sql-results">
    <div class="pane-head term-head">
      <div class="term-tabs">
        ${tabs.map((t) => html`<div key=${t.key} class=${cx('term-tab', t === tab && 'active')} title=${t.result?.sql ?? t.output.map((o) => o.sql).join(';\n')}
          onClick=${() => pick(t.key)} onAuxClick=${(e) => { if (e.button === 1) close(e, t.key); }}>
          <${Icon} name=${t.output ? 'check' : 'table'} /><span>${tabLabel(t)}</span>
          <button class="icon-btn xs term-tab-close" aria-label=${`Close ${tabLabel(t)}`} onClick=${(e) => close(e, t.key)}><${Icon} name="x" /></button></div>`)}
        ${r.error && html`<div class=${cx('term-tab err', onError && 'active')} onClick=${() => pick('err')}><${Icon} name="circle-alert" />
          <span>${r.error.done ? `${r.error.index + 1} · ` : ''}Error</span>
          <button class="icon-btn xs term-tab-close" aria-label="Close the error" onClick=${(e) => close(e, 'err')}><${Icon} name="x" /></button></div>`}
      </div>
      <div class="spacer"></div>
      <${MaxButton} />
      ${r.running && html`<span class="dim small row"><${Spinner} /> Running…</span>
        <button class="btn sm" onClick=${cancelRun}><${Icon} name="square" />Cancel</button>`}
      ${!r.running && (tab || onError) && html`<button class="btn ghost sm" title="Send this query and its error or result to an agent" onClick=${askAboutRun}><${Icon} name="bot" />Ask the agent</button>`}
      ${shown && !r.running && html`<${ExportMenus} result=${shown} tab=${tab} conn=${conn} />`}
    </div>
    ${onError && html`<div class="sql-error" role="alert"><${Icon} name="circle-alert" /><div>
      ${r.error.done > 0 && html`<div class="small dim">Statement ${r.error.index + 1} failed; the ${r.error.done} before it ran.</div>`}
      <pre>${r.error.message}</pre></div></div>`}
    ${tab?.output && html`<div class="sql-output">${tab.output.map((o, i) => html`<div key=${i} class="sql-output-item">
      <${Icon} name="circle-check" class="tiny ok" /><span>${o.text}</span><span class="dim">· ${o.ms} ms</span>
      <code class="mono dim" title=${o.sql}>${o.sql}</code></div>`)}</div>`}
    ${shown && html`<${ResultGrid} key=${`${tab.key}:${tab.at}`} r=${shown} table=${meta} readOnly=${!!conn?.readOnly}
      onQuery=${(q) => requery(c, tab.key, meta, q)} onSubmit=${(edits) => submitEdits(c, tab.key, meta, edits)}
      onPreview=${(edits) => previewEdits(c, meta, edits)} />`}
    ${shown && html`<div class="sql-foot small dim">
      <span>${summary(shown)} · ${shown.ms} ms</span>
      ${shown.note && html`<span>${shown.note}</span>`}
      ${shown.truncated && html`<span class="warn">Only the first ${shown.rows.length} rows (the row limit).</span>`}
      ${r.readOnly && html`<span><${Icon} name="eye" class="tiny" /> read-only connection</span>`}
      ${meta && !conn?.readOnly && html`<span><${Icon} name="pencil" class="tiny" /> ${meta.table}: click a cell to see or edit it</span>`}
      ${meta && html`<div class="sql-ran"><span class="mono">${shown.sql}</span>
        <button class="icon-btn xs" title="Copy the query that read these rows" aria-label="Copy the query" onClick=${() => copyText(shown.sql, 'query copied')}><${Icon} name="copy" /></button></div>`}
      ${!meta && html`<span>Click a cell to see its whole value</span>`}
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
/** A Redis key as a word of a command (quoted when it holds spaces or quotes). */
const redisWord = (k) => (/^[\w:.\-/@#$*{}|]+$/.test(k) ? k : `"${k.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`);
/** A Redis key's type, from the tree's list (its detail: "hash · ttl 30s"). */
function redisType(conn, schema, key) {
  for (const [k, v] of sq.schemas.value) {
    if (!k.startsWith(`${conn.id}/`)) continue;
    const t = v.data?.schemas.find((x) => x.name === schema)?.tables.find((x) => x.name === key);
    if (t) return (t.detail || '').split(' ')[0];
  }
  return '';
}
/** What opens a collection or key: its first documents, or the command that reads that type of key. */
function browseCommand(conn, schema, table) {
  if (conn.driver === 'mongodb') return `db.${/^[A-Za-z_$][\w$]*$/.test(table) ? table : `getCollection(${JSON.stringify(table)})`}.find({}).limit(100)`;
  const k = redisWord(table);
  return ({ string: `GET ${k}`, hash: `HGETALL ${k}`, list: `LRANGE ${k} 0 99`, set: `SSCAN ${k} 0 COUNT 100`, zset: `ZRANGE ${k} 0 99 WITHSCORES`,
    stream: `XRANGE ${k} - + COUNT 100` })[redisType(conn, schema, table)] || `TYPE ${k}`;
}

function selectFrom(conn, schema, table) {
  if (noSql(conn)) return browseCommand(conn, schema, table);
  const own = conn.driver === 'sqlite' || (conn.driver === 'postgres' && schema === 'public') || (conn.driver !== 'postgres' && schema === conn.database);
  return `SELECT * FROM ${own ? '' : `${quote(conn, schema)}.`}${quote(conn, table)} LIMIT 100;`;
}

/** '' for the connection's own database (how consoles and the schema cache name it), else the name. */
const dbKey = (conn, db) => (!db || db === ownDb(conn) ? '' : db);

function openTable(conn, db, schema, table) {
  const sql = selectFrom(conn, schema, table);
  // MongoDB and Redis run in the console's database: the schema the collection or key is in.
  const target = noSql(conn) ? dbKey(conn, schema) : db;
  const a = activeConsole();
  const c = a?.connId === conn.id && (a.database || '') === target ? a : newConsole(conn.id, '', target);
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

async function askAboutTable(conn, db, schema, table) {
  await loadColumns(conn.id, db, schema);
  const own = db || (multi(conn) ? ownDb(conn) : '');
  sq.ask.value = {
    suggestion: `What does ${table} hold, and how is it used?`,
    context: contextFor({ conn, engine: DRIVERS[conn.driver], database: own, sql: '', schemas: sq.schemas.value.get(skey(conn.id, db))?.data?.schemas, table: { schema, table } }),
  };
}
const note = (depth, cls, text) => html`<div class=${cx('tree-empty small', cls)} style=${{ paddingLeft: `${30 + depth * 14}px` }}>${text}</div>`;

// ---------- what can be done to a connection, database, schema or table (its ⋯ and its right click) ----------

/** Opens the tree's right-click menu at the pointer, instead of the browser's. */
function openCtx(e, items) {
  e.preventDefault();
  e.stopPropagation();
  sq.ctx.value = { at: { x: e.clientX, y: e.clientY }, items };
}

/** Every database (and table list) of a connection that was read before is read again. */
function refreshConn(conn) {
  toggleOpen(`c:${conn.id}`, true);
  if (multi(conn)) loadDatabases(conn.id, true);
  for (const k of sq.schemas.value.keys()) if (k.startsWith(`${conn.id}/`)) loadSchema(conn.id, k.slice(conn.id.length + 1), true);
  if (!multi(conn)) loadSchema(conn.id, '', true);
}

const removeConn = (conn) => guarded(async () => {
  if (!await confirmDialog({ title: `Remove ${conn.label}?`, message: 'The connection and its agent log go. The database itself is untouched.', confirmText: 'Remove', danger: true })) return;
  await api(`/api/db/connections/${conn.id}`, { method: 'DELETE' });
  await forgetRead(conn.id);
  await loadConns();
})();

const connItems = (conn) => html`
  <${MenuItem} icon="square-code" onClick=${() => newConsole(conn.id)}>New console<//>
  <${MenuItem} icon="refresh-cw" title="Read its databases, tables and columns again from the server" onClick=${() => refreshConn(conn)}>Refresh<//>
  <${MenuItem} icon="copy" onClick=${() => copyText(conn.id, 'name copied')}>Copy its name (for agents)<//>
  ${isAdmin.value && html`<div class="menu-sep"></div>
    <${MenuItem} icon="pencil" onClick=${() => { sq.editing.value = { conn }; }}>Edit connection<//>
    ${(sq.workspaces.value?.length ?? 0) > 1 && html`<${MenuItem} icon="x" onClick=${() => setInWorkspace(conn.id, false)}>Remove from this workspace<//>`}
    <${MenuItem} icon="history" onClick=${() => { sq.log.value = conn.id; }}>Agent queries<//>
    <${MenuItem} icon="archive" title="The rows agents' writes changed, kept before they ran" onClick=${() => { sq.backups.value = conn.id; }}>Backups<//>
    <${MenuItem} icon="trash-2" danger onClick=${() => removeConn(conn)}>Remove<//>`}`;

const dbItems = (conn, name) => html`
  <${MenuItem} icon="square-code" onClick=${() => newConsole(conn.id, '', name)}>New console on ${name}<//>
  <${MenuItem} icon="refresh-cw" onClick=${() => { toggleOpen(`d:${conn.id}:${name}`, true); loadSchema(conn.id, dbKey(conn, name), true); }}>Refresh its tables<//>
  <${MenuItem} icon="copy" onClick=${() => copyText(name, 'name copied')}>Copy name<//>`;

const schemaItems = (conn, db, name) => html`
  <${MenuItem} icon="refresh-cw" onClick=${() => loadSchema(conn.id, db, true)}>Refresh tables<//>
  <${MenuItem} icon="copy" onClick=${() => copyText(name, 'name copied')}>Copy name<//>`;

const tableItems = (conn, db, schema, t) => html`
  <${MenuItem} icon="play" onClick=${() => openTable(conn, db, schema, t.name)}>${conn.driver === 'redis' ? 'Read it' : conn.driver === 'mongodb' ? 'Find its first documents' : 'Select first rows'}<//>
  ${conn.driver !== 'redis' && html`<${MenuItem} icon="file" onClick=${() => openDdl(conn, db, schema, t.name)}>${conn.driver === 'mongodb' ? 'Show indexes and options' : 'Show DDL'}<//>`}
  <${MenuItem} icon="bot" onClick=${() => askAboutTable(conn, db, schema, t.name)}>Ask the agent about it<//>
  <div class="menu-sep"></div>
  <${MenuItem} icon="copy" onClick=${() => copyText(t.name, 'name copied')}>Copy name<//>
  <${MenuItem} icon="copy" onClick=${() => copyText(selectFrom(conn, schema, t.name).replace(/ LIMIT 100;$/, ';'), noSql(conn) ? 'command copied' : 'query copied')}>${noSql(conn) ? 'Copy command' : 'Copy SELECT'}<//>`;

/** The ⋯ of a row: the same menu as its right click (for touch screens and the keyboard). */
const More = ({ label, items }) => html`<span onClick=${(e) => e.stopPropagation()} onDblClick=${(e) => e.stopPropagation()}>
  <${Menu} label=${label} buttonClass="xs tree-more">${items}<//></span>`;

// ---------- the tree ----------

/** The schemas (or, with only one, the tables) of one database, `depth` levels in. */
function Tables({ conn, db, depth }) {
  const s = sq.schemas.value.get(skey(conn.id, db));
  useEffect(() => { loadSchema(conn.id, db); }, [conn.id, db]);
  if (s?.error) return note(depth - 1, 'err', s.error);
  if (!s?.data) return s?.loading ? note(depth - 1, 'dim', 'Loading…') : null;
  const schemas = s.data.schemas;
  if (!schemas.length) return note(depth - 1, 'dim', 'No tables.');
  if (schemas.length === 1 && !schemas[0].loaded) loadColumns(conn.id, db, schemas[0].name);
  // One schema (SQLite, a MySQL connection to one database): its tables right under the connection.
  if (schemas.length === 1) return schemas[0].tables.map((t) => html`<${TableNode} key=${t.name} conn=${conn} db=${db} schema=${schemas[0].name} loaded=${schemas[0].loaded} t=${t} depth=${depth} />`);
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
  const s = sq.schemas.value.get(skey(conn.id, db));
  return html`<div>
    <div class="tree-row" data-node=${key} style=${{ '--depth': 1 }} aria-expanded=${open} title="Double-click: a console on this database"
      onClick=${() => toggleOpen(key)} onDblClick=${() => newConsole(conn.id, '', name)} onContextMenu=${(e) => openCtx(e, dbItems(conn, name))}>
      <span class="tree-twisty"><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></span>
      <${Icon} name="database" class="tree-icon" /><span class="tree-name">${name}</span>
      ${!db && html`<span class="sql-type">default</span>`}
      ${open && s?.at && !s.loading && html`<span class="sql-read" title="When its tables were read; Refresh reads them again">${readAgo(s.at)}</span>`}
      ${s?.loading && html`<${Spinner} class="tiny" />`}
      <${More} label="Database options" items=${dbItems(conn, name)} />
    </div>
    ${open && html`<${Tables} conn=${conn} db=${db} depth=${2} />`}
  </div>`;
}

function ConnNode({ conn }) {
  const key = `c:${conn.id}`;
  const open = sq.open.value.has(key);
  const loading = multi(conn) ? sq.dbs.value.get(conn.id)?.loading : sq.schemas.value.get(skey(conn.id))?.loading;
  const readAt = multi(conn) ? sq.dbs.value.get(conn.id)?.at : sq.schemas.value.get(skey(conn.id))?.at;
  const where = conn.driver === 'sqlite' ? conn.file : `${conn.host}:${conn.port}/${multi(conn) ? '*' : conn.database}`;
  return html`<div>
    <div class="tree-row" data-node=${key} style=${{ '--depth': 0 }} aria-expanded=${open} onClick=${() => toggleOpen(key)}
      onDblClick=${() => newConsole(conn.id)} onContextMenu=${(e) => openCtx(e, connItems(conn))}>
      <span class="tree-twisty"><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></span>
      <${EngineIcon} driver=${conn.driver} class="tree-icon" />
      <span class="tree-name" title=${`${DRIVERS[conn.driver]} · ${where}`}>${conn.label}</span>
      ${conn.readOnly && html`<span class="sql-tag" title="Read-only"><${Icon} name="eye" /></span>`}
      ${agentTag(conn)}
      ${loading && html`<${Spinner} class="tiny" />`}
      ${open && !loading && readAt && html`<span class="sql-read" title="When it was read; Refresh (in its menu) reads it again">${readAgo(readAt)}</span>`}
      <${More} label="Connection options" items=${connItems(conn)} />
    </div>
    ${open && (multi(conn) ? html`<${Databases} conn=${conn} />` : html`<${Tables} conn=${conn} db="" depth=${1} />`)}
  </div>`;
}

function SchemaNode({ conn, db, sch, depth }) {
  const key = `s:${conn.id}:${db}:${sch.name}`;
  const open = sq.open.value.has(key);
  // A big database's columns come schema by schema, when one is opened.
  useEffect(() => { if (open && !sch.loaded) loadColumns(conn.id, db, sch.name); }, [open, sch.loaded]);
  return html`<div>
    <div class="tree-row" data-node=${key} style=${{ '--depth': depth }} aria-expanded=${open} onClick=${() => toggleOpen(key)}
      onContextMenu=${(e) => openCtx(e, schemaItems(conn, db, sch.name))}>
      <span class="tree-twisty"><${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></span>
      <${Icon} name=${noSql(conn) ? 'database' : 'folder'} class="tree-icon" /><span class="tree-name">${sch.name}</span><span class="sr-count">${(sch.size ?? sch.tables.length).toLocaleString()}</span>
      <${More} label="Schema options" items=${schemaItems(conn, db, sch.name)} />
    </div>
    ${open && sch.tables.map((t) => html`<${TableNode} key=${t.name} conn=${conn} db=${db} schema=${sch.name} loaded=${sch.loaded} t=${t} depth=${depth + 1} />`)}
    ${open && sch.more && note(depth, 'dim', `The first ${sch.tables.length.toLocaleString()} keys. Find others with SCAN 0 MATCH pattern* in a console.`)}
  </div>`;
}

function TableNode({ conn, db, schema, loaded, t, depth }) {
  const key = `t:${conn.id}:${db}:${schema}:${t.name}`;
  // A Redis key has a type and a time to live, not columns: it does not open.
  const redis = conn.driver === 'redis';
  const open = !redis && sq.open.value.has(key);
  return html`<div>
    <div class="tree-row" data-node=${key} style=${{ '--depth': depth }} aria-expanded=${redis ? undefined : open} title="Double-click: open it in a console"
      onClick=${() => { if (!redis) toggleOpen(key); }} onDblClick=${() => openTable(conn, db, schema, t.name)} onContextMenu=${(e) => openCtx(e, tableItems(conn, db, schema, t))}>
      <span class="tree-twisty">${!redis && html`<${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" />`}</span>
      <${Icon} name=${redis ? 'key-round' : t.kind === 'view' ? 'eye' : 'table'} class="tree-icon" /><span class="tree-name">${t.name}</span>
      ${t.detail && html`<span class="sql-type">${t.detail}</span>`}
      <${More} label="Table options" items=${tableItems(conn, db, schema, t)} />
    </div>
    ${open && !loaded && note(depth, 'dim', 'Loading columns…')}
    ${open && t.columns.map((col) => html`<div key=${col.name} class="tree-row sql-col" style=${{ '--depth': depth + 1 }}>
      <span class="tree-twisty"></span><${Icon} name=${col.pk ? 'key-round' : 'file'} class=${cx('tree-icon', col.pk && 'pk')} />
      <span class="tree-name">${col.name}</span><span class="sql-type">${col.type}${col.nullable ? '' : ' · not null'}</span>
    </div>`)}
  </div>`;
}

// ---------- finding a database or table ----------

const MAX_FOUND = 300;

/** `text` with the first occurrence of `q` marked. */
function marked(text, q) {
  const i = text.toLowerCase().indexOf(q);
  return i < 0 ? text : html`${text.slice(0, i)}<mark>${text.slice(i, i + q.length)}</mark>${text.slice(i + q.length)}`;
}

/**
 * Opens the tree down to a node found by the search (its connection, database, schema), clears the search and
 * scrolls to it.
 */
function reveal(keys, node) {
  for (const k of keys) toggleOpen(k, true);
  sq.find.value = '';
  setTimeout(() => {
    const el = document.querySelector(`.ide.sql .tree [data-node="${CSS.escape(node)}"]`);
    el?.scrollIntoView({ block: 'center' });
    el?.classList.add('flash');
    setTimeout(() => el?.classList.remove('flash'), 1200);
  }, 60);
}

/**
 * Every connection, database, schema and table of the workspace whose name has the search text, from the table lists
 * read so far (searching starts reading those of the connections not opened yet; databases of a server can be read
 * all at once from here).
 */
function Found({ q }) {
  const conns = wsConns();
  const needle = q.toLowerCase();
  // The table lists the search needs: every connection's (and the database list of those that open several).
  useEffect(() => { for (const c of conns) { if (multi(c)) loadDatabases(c.id); else loadSchema(c.id, ''); } }, [conns.map((c) => c.id).join()]);
  const out = [];
  let unread = 0;
  const add = (row) => { if (out.length < MAX_FOUND) out.push(row); else out.more = (out.more || 0) + 1; };
  for (const conn of conns) {
    const ck = `c:${conn.id}`;
    if (conn.label.toLowerCase().includes(needle)) add({ key: ck, driver: conn.driver, name: conn.label, where: DRIVERS[conn.driver], open: [], node: ck, items: connItems(conn) });
    const dbs = multi(conn) ? sq.dbs.value.get(conn.id)?.list || [] : [ownDb(conn)];
    for (const name of dbs) {
      const db = multi(conn) ? dbKey(conn, name) : '';
      const dk = `d:${conn.id}:${name}`;
      const path = multi(conn) ? [ck, dk] : [ck];
      if (multi(conn) && name.toLowerCase().includes(needle)) add({ key: dk, icon: 'database', name, where: conn.label, open: [ck], node: dk, items: dbItems(conn, name) });
      const data = sq.schemas.value.get(skey(conn.id, db))?.data;
      if (!data) { if (multi(conn)) unread++; continue; }
      const flat = data.schemas.length === 1;
      for (const sch of data.schemas) {
        const sk = `s:${conn.id}:${db}:${sch.name}`;
        const where = [conn.label, multi(conn) && name].filter(Boolean).join(' · ');
        if (!flat && sch.name.toLowerCase().includes(needle)) add({ key: sk, icon: 'folder', name: sch.name, where, open: path, node: sk, items: schemaItems(conn, db, sch.name) });
        for (const t of sch.tables) {
          if (!t.name.toLowerCase().includes(needle)) continue;
          add({
            key: `t:${conn.id}:${db}:${sch.name}:${t.name}`, icon: t.kind === 'view' ? 'eye' : 'table', name: t.name,
            where: flat ? where : `${where} · ${sch.name}`, open: flat ? path : [...path, sk], node: `t:${conn.id}:${db}:${sch.name}:${t.name}`,
            items: tableItems(conn, db, sch.name, t), dbl: () => openTable(conn, db, sch.name, t.name),
          });
        }
      }
    }
  }
  const readAll = () => {
    for (const conn of conns.filter(multi)) for (const name of sq.dbs.value.get(conn.id)?.list || []) loadSchema(conn.id, dbKey(conn, name));
  };
  return html`<div class="sql-found">
    ${out.map((r) => html`<div key=${r.key} class="tree-row sql-found-row" title=${r.dbl ? 'Click: show it in the tree · double-click: SELECT its first rows' : 'Click: show it in the tree'}
      onClick=${() => reveal(r.open, r.node)} onDblClick=${r.dbl} onContextMenu=${(e) => openCtx(e, r.items)}>
      ${r.driver ? html`<${EngineIcon} driver=${r.driver} class="tree-icon" />` : html`<${Icon} name=${r.icon} class="tree-icon" />`}
      <span class="tree-name">${marked(r.name, needle)}</span>
      <span class="sql-type">${r.where}</span>
    </div>`)}
    ${out.more > 0 && note(0, 'dim', `${out.more} more: type more of the name.`)}
    ${!out.length && note(0, 'dim', 'Nothing with that name in the tables read so far.')}
    ${unread > 0 && html`<div class="tree-empty small dim">${unread} database${unread === 1 ? '' : 's'} not read yet.
      <button class="btn ghost sm" onClick=${readAll}>Search ${unread === 1 ? 'it' : 'them'} too</button></div>`}
  </div>`;
}

function Tree() {
  const ready = sq.conns.value != null && sq.workspaces.value != null;
  const conns = wsConns();
  const others = (sq.conns.value || []).length > conns.length;
  const q = sq.find.value.trim();
  return html`<div class="files-pane">
    <div class="pane-head"><span class="pane-title">Database</span><div class="spacer"></div>
      ${isAdmin.value && others && html`<button class="icon-btn xs" title="Choose this workspace's connections" aria-label="Choose connections" onClick=${() => { sq.wsDialog.value = { mode: 'conns' }; }}><${Icon} name="sliders-horizontal" /></button>`}
      ${isAdmin.value && html`<button class="icon-btn xs" title="Add a connection" aria-label="Add a connection" onClick=${() => { sq.editing.value = { conn: null }; }}><${Icon} name="plus" /></button>`}
      <button class="icon-btn xs" title="Reload connections" aria-label="Reload connections" onClick=${() => { loadConns(); loadWorkspaces(); }}><${Icon} name="refresh-cw" /></button>
    </div>
    ${ready && conns.length > 0 && html`<div class="sql-find">
      <${Icon} name="search" class="tiny dim" />
      <input type="search" value=${sq.find.value} placeholder="Find a database or table" aria-label="Find a database or table"
        onInput=${(e) => { sq.find.value = e.currentTarget.value; }} onKeyDown=${(e) => { if (e.key === 'Escape') sq.find.value = ''; }} />
    </div>`}
    <div class="tree">
      ${!ready ? html`<div class="tree-empty"><${Spinner} /></div>`
        : q && conns.length ? html`<${Found} q=${q} />`
        : conns.length ? conns.map((c) => html`<${ConnNode} key=${c.id} conn=${c} />`)
          : html`<div class="tree-empty small dim">${!isAdmin.value ? 'No connections in this workspace yet. An admin adds them.' : html`
              No connections in this workspace yet.
              <div class="row wrap sql-ws-empty">
                <button class="btn sm" onClick=${() => { sq.editing.value = { conn: null }; }}><${Icon} name="plus" />New connection</button>
                ${others && html`<button class="btn sm" onClick=${() => { sq.wsDialog.value = { mode: 'conns' }; }}>Choose existing</button>`}
              </div>`}</div>`}
    </div>
    ${sq.ctx.value && html`<${ContextMenu} at=${sq.ctx.value.at} onClose=${() => { sq.ctx.value = null; }}>${sq.ctx.value.items}<//>`}
  </div>`;
}

/** New workspace, rename it, or pick its connections (admins). */
function WorkspaceDialog({ mode }) {
  const w = currentWs();
  const [name, setName] = useState(mode === 'rename' ? w?.name ?? '' : '');
  const [picked, setPicked] = useState(new Set(w?.conns ?? []));
  const [error, setError] = useState('');
  const close = () => { sq.wsDialog.value = null; };
  const save = async () => {
    setError('');
    try {
      if (mode === 'new') {
        const made = await api('/api/db/workspaces', { method: 'POST', body: { name } });
        await loadWorkspaces();
        openWorkspace(made.id);
        // A new workspace starts empty: pick its connections next.
        sq.wsDialog.value = (sq.conns.value || []).length ? { mode: 'conns' } : null;
        return;
      }
      await api(`/api/db/workspaces/${w.id}`, { method: 'PATCH', body: mode === 'rename' ? { name } : { conns: [...picked] } });
      await loadWorkspaces();
      if (mode === 'conns' && !sq.consoles.value.length && wsConns().length) newConsole(wsConns()[0].id);
      close();
    } catch (e) { setError(e.message); }
  };
  const toggle = (id) => { const next = new Set(picked); if (next.has(id)) next.delete(id); else next.add(id); setPicked(next); };
  const title = mode === 'new' ? 'New workspace' : mode === 'rename' ? 'Rename workspace' : `Connections in ${w?.name}`;
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>${title}</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    ${mode === 'conns' ? html`
      <p class="small dim">A connection can be in several workspaces. Who may open it is still set on the connection.</p>
      <div class="sql-ws-pick">${(sq.conns.value || []).map((c) => html`<label key=${c.id} class="check small">
        <input type="checkbox" checked=${picked.has(c.id)} onChange=${() => toggle(c.id)} />
        <${EngineIcon} driver=${c.driver} /><span>${c.label} <span class="dim">· ${DRIVERS[c.driver]}${c.database ? ` · ${c.database}` : ''}</span></span></label>`)}</div>`
      : html`<${Field} label="Name"><input value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="e.g. Production, Reports" autofocus
          onKeyDown=${(e) => { if (e.key === 'Enter') save(); }} /><//>`}
    ${error && html`<div class="form-error" role="alert">${error}</div>`}
    <div class="row end"><button class="btn" onClick=${close}>Cancel</button><${AsyncButton} class="btn primary" onClick=${save}>${mode === 'new' ? 'Create' : 'Save'}<//></div>
  </div>`;
}

/** The workspace picker in the header, with its menu for admins. */
function WorkspacePicker() {
  const list = sq.workspaces.value || [];
  const w = currentWs();
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: `Delete workspace ${w.name}?`, message: 'Its connections stay (in other workspaces and the server); its consoles in this browser go.', confirmText: 'Delete', danger: true })) return;
    await api(`/api/db/workspaces/${w.id}`, { method: 'DELETE' });
    try { localStorage.removeItem(consolesKey(w.id)); } catch { /* private mode */ }
    sq.consoles.value = [];
    sq.ws.value = null;
    await loadWorkspaces();
    openWorkspace(sq.workspaces.value[0]?.id);
  });
  if (!w) return null;
  return html`<div class="sql-ws">
    <select aria-label="Workspace" title="Workspace" value=${w.id} onChange=${(e) => openWorkspace(e.currentTarget.value)}>
      ${list.map((x) => html`<option value=${x.id}>${x.name}</option>`)}
    </select>
    ${isAdmin.value && html`<${Menu} label="Workspace options" buttonClass="sm">
      <${MenuItem} icon="plus" onClick=${() => { sq.wsDialog.value = { mode: 'new' }; }}>New workspace<//>
      <${MenuItem} icon="pencil" onClick=${() => { sq.wsDialog.value = { mode: 'rename' }; }}>Rename<//>
      <${MenuItem} icon="database" onClick=${() => { sq.wsDialog.value = { mode: 'conns' }; }}>Choose connections<//>
      ${list.length > 1 && html`<div class="menu-sep"></div><${MenuItem} icon="trash-2" danger onClick=${remove}>Delete workspace<//>`}
    <//>`}
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
  // The SSH tunnel; its secrets are never sent here, so their fields start empty (empty keeps the saved one).
  const [ssh, setSsh] = useState(() => ({
    enabled: conn?.ssh?.enabled ?? false, host: conn?.ssh?.host ?? '', port: conn?.ssh?.port ? String(conn.ssh.port) : '', user: conn?.ssh?.user ?? '',
    auth: conn?.ssh?.auth ?? 'password', password: '', privateKey: '', passphrase: '',
  }));
  const setS = (k) => (e) => setSsh({ ...ssh, [k]: e.currentTarget.type === 'checkbox' ? e.currentTarget.checked : e.currentTarget.value });
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
      ...((ssh.enabled || conn?.ssh) && { ssh: {
        enabled: ssh.enabled, host: ssh.host.trim(), port: Number(ssh.port) || 22, user: ssh.user.trim(), auth: ssh.auth,
        ...(ssh.password && { password: ssh.password }), ...(ssh.privateKey.trim() && { privateKey: ssh.privateKey }),
        ...(ssh.passphrase && { passphrase: ssh.passphrase }),
        // The server key the last successful test saw: trusted from now on.
        ...(tested?.ok && tested.sshHostKey && { hostKey: tested.sshHostKey }),
      } }),
    }),
  });
  /** A key file's text, into the private key field. */
  const loadKey = (e) => {
    const file = e.currentTarget.files?.[0];
    if (file) file.text().then((t) => setSsh((x) => ({ ...x, privateKey: t })));
    e.currentTarget.value = '';
  };
  const save = async () => {
    setError('');
    const id = (conn?.id ?? f.id).trim();
    try {
      if (!conn && sq.conns.value?.some((c) => c.id === id)) throw new Error(`there already is a connection named ${id}`);
      await api(`/api/db/connections/${encodeURIComponent(id)}`, { method: 'PUT', body: { ...body(), ...(!conn && sq.ws.value && { workspaces: [sq.ws.value] }) } });
      await loadWorkspaces();
      await loadConns();
      await forgetRead(id);
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
    <${Seg} label="Database engine" value=${f.driver} options=${Object.entries(DRIVERS).map(([k, label]) => [k, label, ENGINE_ICONS[k]])} onChange=${(v) => setF({ ...f, driver: v, port: '' })} />
    <div class="row wrap">
      ${!conn && html`<${Field} label="Name" hint="Lowercase letters, digits, - and _. Agents name it so.">
        <input class="mono" value=${f.id} onInput=${set('id')} placeholder="app-prod" autofocus /><//>`}
      <${Field} label="Label"><input value=${f.label} onInput=${set('label')} placeholder="App (production)" /><//>
    </div>
    ${sqlite ? html`<${Field} label="Database file" hint="An absolute path on the server.">
        <input class="mono" value=${f.file} onInput=${set('file')} placeholder="/srv/data/app.db" /><//>`
    : html`
      <div class="row wrap">
        <${Field} label=${noSql(f) ? 'Host or URI' : 'Host'}><input class="mono" value=${f.host} onInput=${set('host')}
          placeholder=${f.driver === 'mongodb' ? 'localhost or mongodb+srv://cluster…' : f.driver === 'redis' ? 'localhost or rediss://…' : 'localhost'} /><//>
        <${Field} label="Port"><input class="mono sql-port" inputmode="numeric" value=${f.port} onInput=${set('port')} placeholder=${String(PORTS[f.driver])} /><//>
      </div>
      <div class="row wrap">
        <${Field} label=${f.driver === 'postgres' && f.allDatabases ? 'Default database' : f.driver === 'redis' ? 'Database number' : f.driver === 'mongodb' ? 'Default database' : 'Database'}>
          <input class="mono" value=${f.database} onInput=${set('database')}
            placeholder=${f.driver === 'postgres' ? 'postgres' : f.driver === 'redis' ? '0' : f.driver === 'mongodb' ? 'none: pick one per console' : 'all databases'} /><//>
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
          Show every database on the server this user may connect to, not only the one above (agent access covers them too)</label>`}
      <label class="check small"><input type="checkbox" checked=${ssh.enabled} onChange=${setS('enabled')} />
        Connect through an SSH tunnel</label>
      ${ssh.enabled && html`<div class="sql-ssh">
        <span class="small dim">The database's host and port above are as the SSH server sees them (often <span class="mono">localhost</span>).</span>
        <div class="row wrap">
          <${Field} label="SSH host"><input class="mono" value=${ssh.host} onInput=${setS('host')} placeholder="bastion.example.com" /><//>
          <${Field} label="Port"><input class="mono sql-port" inputmode="numeric" value=${ssh.port} onInput=${setS('port')} placeholder="22" /><//>
        </div>
        <div class="row wrap">
          <${Field} label="SSH user"><input class="mono" autocomplete="off" value=${ssh.user} onInput=${setS('user')} placeholder="deploy" /><//>
          <div class="field"><span class="field-label">Sign in with</span>
            <${Seg} small label="SSH sign-in" value=${ssh.auth} onChange=${(v) => setSsh({ ...ssh, auth: v })} options=${[['password', 'Password'], ['key', 'Private key']]} /></div>
        </div>
        ${ssh.auth === 'password' ? html`<${Field} label="SSH password" hint=${conn?.ssh?.hasPassword ? 'Saved. Leave empty to keep it.' : ''}>
            <input type="password" class="mono" autocomplete="new-password" value=${ssh.password} onInput=${setS('password')} placeholder=${conn?.ssh?.hasPassword ? '••••••••' : ''} /><//>`
          : html`<div class="field"><span class="field-head">Private key
              <label class="btn ghost sm sql-key-file"><${Icon} name="upload" />Load a key file<input type="file" hidden onChange=${loadKey} /></label></span>
            <textarea class="mono sql-key" rows="4" spellcheck="false" value=${ssh.privateKey} onInput=${setS('privateKey')}
              placeholder=${conn?.ssh?.hasKey ? 'Saved; never shown. Paste another to replace it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'}></textarea>
            <span class="field-hint">The key file's text (id_ed25519, id_rsa, ...), not the .pub one.</span></div>
          <${Field} label="Passphrase" hint=${conn?.ssh?.hasPassphrase ? 'Saved. Leave empty to keep it.' : 'Only if the key has one.'}>
            <input type="password" class="mono" autocomplete="new-password" value=${ssh.passphrase} onInput=${setS('passphrase')} placeholder=${conn?.ssh?.hasPassphrase ? '••••••••' : ''} /><//>`}
        <span class="small dim">${conn?.ssh?.hostKey && !(tested?.sshHostKey && tested.sshHostKey !== conn.ssh.hostKey)
          ? html`Trusted server key: <span class="mono">${conn.ssh.hostKey}</span>`
          : 'The SSH server\'s key is trusted once you test the connection and save.'}</span>
      </div>`}`}
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
      ${tested.sshHostKey && html`<p class="small dim">Through SSH. Server key <span class="mono">${tested.sshHostKey}</span>${tested.sshHostKey === conn?.ssh?.hostKey ? ' (trusted)' : ': trusted when you save.'}</p>`}
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
            <span>· ${q.ok ? `${q.rows} rows` : 'failed'} · ${q.ms} ms</span>
            ${q.backup && html`<a onClick=${guarded(() => downloadFile(`/api/db/connections/${id}/backups/${q.backup}`, `${id}-${q.backup}`))}
              title="The rows it was about to change, kept before it ran">· backup (${q.backupRows} rows)</a>`}</div>
          <pre class="mono">${q.sql}</pre>
          ${q.error && html`<div class="small err">${q.error}</div>`}
        </div>`)}</div>`}
  </div>`;
}

/** The backups taken before agents' writes on a connection, newest first, each downloadable as JSON. */
function Backups({ id }) {
  const [list, setList] = useState(null);
  useEffect(() => { api(`/api/db/connections/${id}/backups`).then(setList).catch((e) => { toast(e.message, 'err'); setList([]); }); }, [id]);
  const close = () => { sq.backups.value = null; };
  const get = (b) => guarded(() => downloadFile(`/api/db/connections/${id}/backups/${b.file}`, `${id}-${b.file}`));
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Backups: ${connOf(id)?.label ?? id}</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    ${list == null ? html`<div class="pane-loading"><${Spinner} /></div>`
      : !list.length ? html`<${Empty} icon="archive" title="No backups yet">Before an agent's UPDATE, DELETE, TRUNCATE or DROP TABLE runs here, the rows it changes are kept and listed (the newest 200).<//>`
        : html`<div class="sql-log">${list.map((b) => html`<div key=${b.file} class="sql-log-item">
          <div class="small dim row wrap"><${Icon} name="archive" class="tiny" />
            <span>${new Date(b.at).toLocaleString()}</span><span>· ${b.who || 'an agent'}</span>
            ${b.approval && html`<span>· approval #${b.approval}</span>`}
            ${b.database && html`<span>· on <span class="mono">${b.database}</span></span>`}
            ${b.conv && html`<a href=${`/#c=${b.conv}`} target="_blank">· its chat</a>`}
            <span>· ${b.rows} rows of <span class="mono">${b.tables.join(', ')}</span></span>
            ${b.notBackedUp && html`<span class="err">· ${b.notBackedUp} statement(s) not backed up</span>`}
            <a onClick=${get(b)}>· download</a></div>
          <pre class="mono">${b.sql}</pre>
        </div>`)}</div>`}
  </div>`;
}

/** "all 9 rows" (documents on MongoDB, keys on Redis). */
const rowsText = (n, unit = 'row') => (n == null ? `every ${unit}` : `all ${n.toLocaleString()} ${unit}${n === 1 ? '' : 's'}`);

/** A script that would change every row of a table: which statements, how many rows now, and Run anyway. */
function UnsafeConfirm({ list, conn, unit, go }) {
  const close = () => { sq.unsafe.value = null; };
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Change every row?</h2><button class="icon-btn" aria-label="Close" onClick=${close}><${Icon} name="x" /></button></div>
    <p class="small">${list.length === 1 ? 'This changes' : 'These change'} everything in what ${list.length === 1 ? 'it names' : 'they name'} on <strong>${conn}</strong> (no WHERE, an empty filter, a drop or a flush):</p>
    ${list.map((u) => html`<div class="sql-warning small"><${Icon} name="triangle-alert" /><div>
      <strong>${unit !== 'row' ? u.sql.split(/[\s(]/)[0] : u.kind === 'truncate' ? 'TRUNCATE' : u.kind.toUpperCase()} ${u.table}</strong>: ${u.kind === 'update' ? 'changes' : 'removes'} ${rowsText(u.rows, unit)}.
      <pre class="mono sql-preview">${u.sql}</pre></div></div>`)}
    <p class="small dim">Nothing has run. Narrow it (a WHERE, a filter) to touch only some; run it anyway only if everything is meant.</p>
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
  const list = pref(HISTORY, []).filter((h) => (!h.ws || h.ws === sq.ws.value)
    && (all || (h.connId === c?.connId && (h.database || '') === (c?.database || '')))
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
      <label class="check small"><input type="checkbox" checked=${all} onChange=${(e) => setAll(e.currentTarget.checked)} />Every connection of this workspace</label>
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

/** Names as a Picker's options, each once. */
const names = (list) => [...new Set(list)].map((n) => ({ value: n, label: n }));
/** The most a Picker draws at once (type to narrow a longer list). */
const PICKER_MAX = 300;

/**
 * A list to pick from that typing narrows (the console's database or schema): a click opens it with the search box
 * focused, ↑ ↓ move, Enter picks, Esc closes.
 */
function Picker({ label, title, value, options, onPick }) {
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState('');
  const [hi, setHi] = useState(0);
  const wrap = useRef(null);
  const box = useRef(null);
  const listEl = useRef(null);
  const needle = q.trim().toLowerCase();
  const found = needle ? options.filter((o) => o.label.toLowerCase().includes(needle)) : options;
  const shown = found.slice(0, PICKER_MAX);
  const close = () => { setOpen(false); setQ(''); };
  const pick = (o) => { close(); if (o && o.value !== value) onPick(o.value); };
  useEffect(() => {
    if (!open) return undefined;
    box.current?.focus();
    const away = (e) => { if (!wrap.current?.contains(e.target)) close(); };
    document.addEventListener('pointerdown', away, true);
    return () => document.removeEventListener('pointerdown', away, true);
  }, [open]);
  // The current one is highlighted when it opens, the first match as soon as one types (at once, so a quick ↓ after
  // typing moves from there).
  const openIt = () => { setHi(Math.max(0, options.slice(0, PICKER_MAX).findIndex((o) => o.value === value))); setOpen(true); };
  const type = (v) => { setQ(v); setHi(0); };
  useEffect(() => { listEl.current?.children[hi]?.scrollIntoView({ block: 'nearest' }); }, [hi, open]);
  const key = (e) => {
    if (e.key === 'ArrowDown') { e.preventDefault(); setHi(Math.min(hi + 1, shown.length - 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setHi(Math.max(hi - 1, 0)); }
    else if (e.key === 'Enter') { e.preventDefault(); pick(shown[hi]); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  };
  const current = options.find((o) => o.value === value)?.label ?? value;
  return html`<div class="sql-picker" ref=${wrap}>
    <button type="button" class="sql-conn sql-db sql-picker-btn" aria-label=${label} title=${title} aria-haspopup="listbox" aria-expanded=${open}
      onClick=${() => (open ? close() : openIt())}>
      <span class="sql-picker-value">${current}</span><${Icon} name="chevron-down" class="tiny dim" />
    </button>
    ${open && html`<div class="sql-picker-pop">
      <div class="sql-find sql-picker-find"><${Icon} name="search" class="tiny dim" />
        <input ref=${box} value=${q} placeholder=${`Find a ${label.toLowerCase()}`} aria-label=${`Find a ${label.toLowerCase()}`}
          onInput=${(e) => type(e.currentTarget.value)} onKeyDown=${key} /></div>
      <div class="sql-picker-list" role="listbox" aria-label=${label} ref=${listEl}>
        ${shown.map((o, i) => html`<div key=${o.value} role="option" aria-selected=${o.value === value}
          class=${cx('sql-picker-item', i === hi && 'hi', o.value === value && 'on')}
          onMouseDown=${(e) => { e.preventDefault(); pick(o); }} onMouseEnter=${() => setHi(i)}>
          <${Icon} name="check" class=${cx('tiny', o.value !== value && 'invisible')} /><span>${needle ? marked(o.label, needle) : o.label}</span></div>`)}
      </div>
      ${!found.length && html`<div class="sql-picker-note small dim">Nothing matches.</div>`}
      ${found.length > shown.length && html`<div class="sql-picker-note small dim">${found.length - shown.length} more: type more of the name.</div>`}
    </div>`}
  </div>`;
}

function Toolbar() {
  const c = activeConsole();
  const conn0 = activeConsole() && connOf(activeConsole().connId);
  // The workspace's connections, and the console's own even if it left the workspace.
  const conns = [...wsConns(), ...(conn0 && !wsConns().includes(conn0) ? [conn0] : [])];
  const conn = c && connOf(c.connId);
  const running = c && sq.runs.value.get(c.id)?.running;
  // A picker of the database the console runs in: MySQL/MariaDB (USE), MongoDB (db.), Redis (SELECT).
  const my = conn && (conn.driver === 'mysql' || conn.driver === 'mariadb' || noSql(conn));
  // MySQL: its databases are the schemas of its table list; PostgreSQL: the schemas of the console's database.
  useEffect(() => { if (conn) loadSchema(conn.id, my ? '' : c.database || ''); }, [conn?.id, c?.database]);
  const myDatabases = conn?.driver === 'redis' ? Array.from({ length: 16 }, (_, i) => `db${i}`)
    : my ? (sq.schemas.value.get(skey(conn.id, ''))?.data?.schemas || []).map((x) => x.name) : [];
  const pgSchemas = conn?.driver === 'postgres' ? (sq.schemas.value.get(skey(conn.id, c.database || ''))?.data?.schemas || []).map((x) => x.name) : [];
  return html`<div class="sql-bar">
    <select class="sql-conn" aria-label="Connection" value=${c?.connId || ''} onChange=${(e) => setConsoleConn(e.currentTarget.value)}>
      ${!conn && html`<option value="">Pick a connection…</option>`}
      ${conns.map((x) => html`<option value=${x.id}>${x.label} (${DRIVERS[x.driver]})</option>`)}
    </select>
    ${multi(conn) && html`<${Picker} label="Database" title="The database this console runs in" value=${c.database || ownDb(conn)} onPick=${setConsoleDb}
      options=${names([ownDb(conn), ...(c.database ? [c.database] : []), ...(sq.dbs.value.get(conn.id)?.list || [])])} />`}
    ${my && html`<${Picker} label="Database"
      title=${conn.driver === 'redis' ? 'The database the commands run in (SELECT)' : conn.driver === 'mongodb' ? 'The database db. commands run in' : 'The database unqualified table names are in (USE)'}
      value=${c.database || conn.database || (conn.driver === 'redis' ? 'db0' : '')} onPick=${setConsoleDb}
      options=${[
        ...(!conn.database && conn.driver !== 'redis' ? [{ value: '', label: conn.driver === 'mongodb' ? 'No database (show dbs only)' : 'No database (write db.table)' }] : []),
        ...names([...(conn.database ? [conn.database] : []), ...(c.database ? [c.database] : []), ...myDatabases]),
      ]} />`}
    ${conn?.driver === 'postgres' && pgSchemas.length > 1 && html`<${Picker} label="Schema" title="The schema unqualified table names are looked up in first (search_path)"
      value=${c.schema || 'public'} onPick=${setConsoleSchema} options=${names(['public', ...(c.schema ? [c.schema] : []), ...pgSchemas])} />`}
    ${running ? html`<button class="btn sm" title="Stop the running statement" onClick=${cancelRun}><${Spinner} />Cancel</button>`
      : html`<button class="btn primary sm" disabled=${!conn} title="Run the statement at the cursor, or the selection (Ctrl+Enter)" onClick=${() => run(false)}>
        <${Icon} name="play" />Run</button>`}
    <button class="btn sm" disabled=${!conn || running} title="Run every statement in this console (Ctrl+Shift+Enter)" onClick=${() => run(true)}>Run all</button>
    ${!noSql(conn) && html`<button class="icon-btn sm" title="Format the selection or the console (Shift+Alt+F)" aria-label="Format SQL" onClick=${formatSql}><${Icon} name="wrap-text" /></button>`}
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
    <button class="icon-btn sm sql-new" title="New console" aria-label="New console" onClick=${() => newConsole(activeConsole()?.connId || wsConns()[0]?.id || '')}><${Icon} name="plus" /></button>
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
    // The workspace in the address (#w=...), else the one used last here, else the first.
    const fromHash = () => decodeURIComponent(/#w=([^&]+)/.exec(location.hash)?.[1] ?? '');
    Promise.all([loadConns(), loadWorkspaces()]).then(() => openWorkspace(fromHash() || pref('dalang-sql-ws', '')));
    const hash = () => { const id = fromHash(); if (id && id !== sq.ws.value) openWorkspace(id); };
    addEventListener('hashchange', hash);
    // The browser's own Ctrl+Enter / Ctrl+S do nothing useful here; outside the editor they run too.
    const key = (e) => {
      // Esc brings the console back, unless it closes something else first (a dialog, the value panel).
      if (e.key === 'Escape' && sq.resMax.value && !e.defaultPrevented && !e.target.closest?.('dialog') && !document.querySelector('.sql-value')) {
        toggleResMax(false);
        return;
      }
      if (!(e.ctrlKey || e.metaKey) || e.defaultPrevented) return;
      if (e.shiftKey && e.code === 'Quote') { e.preventDefault(); toggleResMax(); return; }
      if (e.key === 'Enter' && !e.target.closest?.('.cm-editor, input, select, textarea, dialog')) { e.preventDefault(); run(e.shiftKey); }
      if (e.key.toLowerCase() === 's') e.preventDefault();
    };
    // The browser's own Esc (or F11) leaves full screen without a key event for the page.
    const screen = () => { if (!document.fullscreenElement && sq.resMax.value) sq.resMax.value = false; };
    addEventListener('keydown', key);
    document.addEventListener('fullscreenchange', screen);
    return () => { removeEventListener('keydown', key); removeEventListener('hashchange', hash); document.removeEventListener('fullscreenchange', screen); };
  }, []);

  const c = activeConsole();
  const conn = c && connOf(c.connId);
  const pane = sq.pane.value;
  const panes = [['files', 'Database', 'database'], ['editor', 'Query', 'square-code'], ['terminal', 'Results', 'table']];
  return html`<div class=${cx('ide sql', sq.resMax.value && 'term-max')} data-pane=${pane} style=${{ '--tree-w': `${treeW}px`, '--term-h': `${resH}px` }}>
    <header class="ide-head">
      <a class="ide-brand" href="/" title="Back to Dalang" aria-label="Back to Dalang"><${Logo} size=${22} /></a>
      <div class="crumbs"><span class="crumb-title">SQL Editor</span><${Icon} name="chevron-right" class="tiny dim crumb-sep" /></div>
      <${WorkspacePicker} />
      <div class="spacer"></div>
      ${conn && html`<span class="ide-chip hide-mobile" title=${conn.driver === 'sqlite' ? conn.file : `${conn.host}:${conn.port}`}><${EngineIcon} driver=${conn.driver} />${DRIVERS[conn.driver]} · ${c.database || conn.database || (multi(conn) ? ownDb(conn) : conn.label)}</span>`}
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
              ${wsConns().length ? html`Double-click a connection, or <button class="btn sm" onClick=${() => newConsole(wsConns()[0].id)}>open a console</button>`
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
      ${conn ? html`<span class="ide-stat"><${EngineIcon} driver=${conn.driver} />${conn.label}</span>
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
    <${Modal} open=${!!sq.backups.value} label="Backups" class="dialog sql-dialog" onClose=${() => { sq.backups.value = null; }}>
      ${sq.backups.value && html`<${Backups} id=${sq.backups.value} />`}<//>
    <${Modal} open=${!!sq.wsDialog.value} label="Workspace" class="dialog sql-dialog" onClose=${() => { sq.wsDialog.value = null; }}>
      ${sq.wsDialog.value && html`<${WorkspaceDialog} key=${sq.wsDialog.value.mode} mode=${sq.wsDialog.value.mode} />`}<//>
    <${Modal} open=${!!sq.download.value} label="Download" class="dialog sql-dialog" onClose=${() => { sq.download.value = null; }}>
      ${sq.download.value && html`<${DownloadDialog} ...${sq.download.value} />`}<//>
    <${Modal} open=${!!sq.unsafe.value} label="Change every row?" class="dialog sql-dialog" onClose=${() => { sq.unsafe.value = null; }}>
      ${sq.unsafe.value && html`<${UnsafeConfirm} ...${sq.unsafe.value} />`}<//>
    <${Modal} open=${sq.history.value} label="Query history" class="dialog sql-dialog" onClose=${() => { sq.history.value = false; }}>
      ${sq.history.value && html`<${History} />`}<//>
    <${Modal} open=${!!sq.ask.value} label="Ask the agent" class="dialog sql-dialog" onClose=${() => { sq.ask.value = null; }}>
      ${sq.ask.value && html`<${AskAgent} ...${sq.ask.value} onClose=${() => { sq.ask.value = null; }} />`}<//>
  </div>`;
}

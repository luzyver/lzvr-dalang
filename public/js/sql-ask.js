// "Ask the agent" from the SQL editor: a question to a chat (an existing one or a new one in a project), with what the
// agent needs attached: the connection, the query, its error or the first rows of its result, and the tables involved.
// The chat opens in the panel's own tab afterwards.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Field, Icon, Spinner } from './ui.js';
import { toast } from './store.js';

const FENCE = '`'.repeat(3);
const SAMPLE_ROWS = 20;
const MAX_TABLES = 12;

/** Tables of `schemas` whose name appears in `sql` (or the one named `table`), as "schema.table: col type PK, ...". */
function tablesIn(sql, schemas, only) {
  const out = [];
  for (const s of schemas || []) {
    for (const t of s.tables) {
      const hit = only ? only.schema === s.name && only.table === t.name : new RegExp(`(^|[^\\w$])${t.name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}([^\\w$]|$)`, 'i').test(sql);
      if (hit) out.push(`- ${s.name}.${t.name}${t.kind === 'view' ? ' (view)' : ''}: ${t.columns.map((c) => `${c.name} ${c.type}${c.pk ? ' PK' : ''}`).join(', ')}`);
      if (out.length >= MAX_TABLES) return out;
    }
  }
  return out;
}

/** The context block appended to the question. */
export function contextFor({ conn, database, sql, error, result, schemas, table, engine }) {
  const where = `connection "${conn.id}" (${engine})${database ? `, database "${database}"` : ''}`;
  const parts = [`Context from Dalang's SQL editor: ${where}.`];
  if (sql?.trim()) parts.push(`Query:\n${FENCE}sql\n${sql.trim()}\n${FENCE}`);
  if (error) parts.push(`It failed with: ${error}`);
  if (result?.columns?.length) {
    const rows = result.rows.slice(0, SAMPLE_ROWS).map((r) => r.map((v) => (v === null ? 'NULL' : String(v).replace(/[\t\n]/g, ' ').slice(0, 200))).join('\t'));
    parts.push(`Result (${rows.length} of ${result.rows.length}${result.truncated ? '+' : ''} rows):\n${FENCE}text\n${[result.columns.map((c) => c.name).join('\t'), ...rows].join('\n')}\n${FENCE}`);
  } else if (result && result.affected != null) parts.push(`It changed ${result.affected} row(s).`);
  const tables = tablesIn(sql || '', schemas, table);
  if (tables.length) parts.push(`Tables:\n${tables.join('\n')}`);
  const mode = conn.readOnly || conn.agent === 'read-only' ? 'read-only' : conn.agent === 'approve' ? 'read, with writes held for an admin\'s approval' : 'read and write';
  parts.push(conn.agent === 'off'
    ? 'Agents cannot query this connection, so work from what is here.'
    : `You can query it yourself with the dalang MCP tools db_schema and db_query (connection "${conn.id}"${database ? `, database "${database}"` : ''}); for you it is ${mode}.`);
  return parts.join('\n\n');
}

/** The dialog: project, chat, question; `context` is appended. `onClose()` when done or cancelled. */
export function AskAgent({ context, suggestion, onClose }) {
  const [projects, setProjects] = useState(null);
  const [project, setProject] = useState(() => localStorage.getItem('dalang-sql-ask-project') || '');
  const [chats, setChats] = useState([]);
  const [chat, setChat] = useState('new');
  const [question, setQuestion] = useState(suggestion || '');
  const [showContext, setShowContext] = useState(false);
  useEffect(() => { api('/api/projects').then((list) => { setProjects(list); if (!list.some((p) => p.id === project)) setProject(list[0]?.id || ''); }).catch((e) => toast(e.message, 'err')); }, []);
  useEffect(() => {
    if (!project) { setChats([]); return; }
    api(`/api/projects/${project}/conversations`).then((list) => { setChats(list); setChat('new'); }).catch(() => setChats([]));
  }, [project]);
  const send = async () => {
    if (!question.trim()) { toast('write what the agent should do', 'err'); return; }
    if (!project) { toast('pick a project', 'err'); return; }
    // The panel tab opens before the awaits, or the browser counts it as a pop-up.
    const tab = window.open('', '_blank');
    try {
      const id = chat === 'new' ? (await api(`/api/projects/${project}/conversations`, { method: 'POST', body: {} })).id : chat;
      await api(`/api/conversations/${id}/prompts`, { method: 'POST', body: { prompt: `${question.trim()}\n\n---\n${context}` } });
      localStorage.setItem('dalang-sql-ask-project', project);
      if (tab) tab.location.href = `/#c=${encodeURIComponent(id)}`;
      toast('Sent to the agent');
      onClose();
    } catch (e) { tab?.close(); toast(e.message, 'err'); }
  };
  if (projects == null) return html`<div class="dialog-body"><div class="pane-loading"><${Spinner} /></div></div>`;
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Ask the agent</h2><button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    ${!projects.length ? html`<p class="dim">There is no project to ask in. An admin adds projects in the panel.</p>` : html`
      <div class="row wrap">
        <${Field} label="Project"><select value=${project} onChange=${(e) => setProject(e.currentTarget.value)}>
          ${projects.map((p) => html`<option value=${p.id}>${p.name}</option>`)}</select><//>
        <${Field} label="Chat"><select value=${chat} onChange=${(e) => setChat(e.currentTarget.value)}>
          <option value="new">New chat</option>
          ${chats.map((c) => html`<option value=${c.id}>${c.title || 'New chat'}</option>`)}</select><//>
      </div>
      <${Field} label="Question"><textarea rows="4" value=${question} onInput=${(e) => setQuestion(e.currentTarget.value)} autofocus
        placeholder="Why is this slow? / Fix this query / What does this table hold?"></textarea><//>
      <div>
        <button class="btn ghost sm" onClick=${() => setShowContext(!showContext)}><${Icon} name=${showContext ? 'chevron-down' : 'chevron-right'} />What is sent along</button>
        ${showContext && html`<pre class="mono sql-ask-context">${context}</pre>`}
      </div>
      <div class="row end">
        <button class="btn" onClick=${onClose}>Cancel</button>
        <${AsyncButton} class="btn primary" icon="bot" onClick=${send}>Send<//>
      </div>`}
  </div>`;
}

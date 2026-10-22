// Settings → MCP (the owner): ClickUp, code memory and the other MCP servers agents get. Every one is the owner's only
// unless marked "All users" (code memory is every user's, each on the projects they may open).
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Field, Icon, Seg, Spinner, Switch } from './ui.js';
import { guarded, toast } from './store.js';

/** The owner's ClickUp token, workspace and time zone, for the ClickUp Chat tools on /mcp (read-only unless sending is allowed). */
function ClickUpCard() {
  const [s, setS] = useState(null);
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);
  const load = (v) => { setS(v); setToken(''); setResult(null); };
  useEffect(() => { api('/api/settings/clickup').then(load).catch((e) => toast(e.message, 'err')); }, []);
  const set = (k) => (e) => setS({ ...s, [k]: e.currentTarget.value });
  const body = (extra) => ({ workspaceId: s.workspaceId, timeZone: s.timeZone, allUsers: s.allUsers, send: s.send, ...extra });
  // An empty token field keeps the saved token.
  const save = guarded(async () => {
    load(await api('/api/settings/clickup', { method: 'PUT', body: body(token.trim() ? { token } : {}) }));
    toast('ClickUp settings saved');
  });
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: 'Remove the ClickUp token?', message: 'The ClickUp tools stop working until a new one is saved.', confirmText: 'Remove', danger: true })) return;
    load(await api('/api/settings/clickup', { method: 'PUT', body: body({ token: '' }) }));
    toast('ClickUp token removed');
  });
  const test = async () => {
    try { setResult({ ok: true, ...(await api('/api/settings/clickup/test', { method: 'POST' })) }); }
    catch (e) { setResult({ ok: false, error: e.message }); }
  };
  if (s == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return html`<section class="form-card">
    <strong>ClickUp</strong>
    <span class="dim small">ClickUp Chat tools on this gateway's own MCP, e.g. "what did I work on last week?". Read-only unless sending is allowed below.
      Chats reach them only with <span class="mono">MCP_INJECT=1</span>.</span>
    <${Field} label="Personal API token" hint=${s.configured ? `Saved (${s.tokenHint}). Leave empty to keep it.` : 'ClickUp → Settings → Apps → API Token (pk_...).'}>
      <input type="password" class="mono" autocomplete="off" value=${token} onInput=${(e) => setToken(e.currentTarget.value)}
        placeholder=${s.configured ? '••••••••' : 'pk_...'} /><//>
    <${Field} label="Default workspace ID" hint="Empty = every workspace the token can see. A chat can still ask for a particular one.">
      <input class="mono" inputmode="numeric" value=${s.workspaceId} onInput=${set('workspaceId')} placeholder="all workspaces" /><//>
    <${Field} label="Time zone" hint="Message dates and times are given in it. Empty = your ClickUp profile's time zone.">
      <input list="clickup-zones" value=${s.timeZone} onInput=${set('timeZone')} placeholder="Asia/Jakarta" /><//>
    <datalist id="clickup-zones">${zones.map((z) => html`<option value=${z} />`)}</datalist>
    <label class="check small"><input type="checkbox" checked=${s.allUsers} onChange=${(e) => setS({ ...s, allUsers: e.currentTarget.checked })} />
      All users: admins' and devs' chats get it too, reading your ClickUp messages</label>
    <label class="check small"><input type="checkbox" checked=${s.send} onChange=${(e) => setS({ ...s, send: e.currentTarget.checked })} />
      Allow sending: chats that get these tools can also send ClickUp messages as you${s.allUsers ? ', including admins\' and devs\' chats' : ''}</label>
    <div class="row wrap">
      <${AsyncButton} class="btn primary sm" onClick=${save}>Save<//>
      <${AsyncButton} class="btn sm" icon="refresh-cw" onClick=${test} disabled=${!s.configured}>Test connection<//>
      ${s.configured && html`<button class="btn ghost danger sm" onClick=${remove}><${Icon} name="trash-2" />Remove token</button>`}
    </div>
    ${result && (result.ok
      ? html`<p class="small"><${Icon} name="circle-check" /> Connected as <strong>${result.user.username || result.user.email}</strong>
          with ${result.workspaces.length} workspace(s): ${result.workspaces.map((w) => `${w.name || 'unnamed'} (${w.id})`).join(', ')}.
          Time zone ${result.time_zone}.</p>`
      : html`<div class="form-error" role="alert">${result.error}</div>`)}
  </section>`;
}

/** "3 min ago" for a time in ms. */
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

/**
 * Code memory: the codebase-memory-mcp binary Dalang runs to keep a graph of every project's code, and each project's
 * index. Chats query it through this gateway's MCP (code_* tools), each on its own project.
 */
function CodeMemoryCard() {
  const [s, setS] = useState(null);
  const [result, setResult] = useState(null);
  const load = () => api('/api/settings/code-memory').then(setS).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  // While an index runs, look again every few seconds.
  const busy = s?.projects.some((p) => p.index?.status === 'indexing');
  useEffect(() => { if (!busy) return undefined; const t = setInterval(load, 3000); return () => clearInterval(t); }, [busy]);
  const set = (k) => (e) => setS({ ...s, [k]: e.currentTarget.value });
  const save = guarded(async (enabled = s.enabled) => {
    setS(await api('/api/settings/code-memory', { method: 'PUT', body: { enabled, command: s.command, cacheDir: s.cacheDir, runtimeDir: s.runtimeDir, hooks: s.hooks } }));
    toast(enabled ? 'Code memory saved: projects are being indexed' : 'Code memory saved');
  });
  const test = async () => {
    try { setResult({ ok: true, ...(await api('/api/settings/code-memory/test', { method: 'POST' })) }); }
    catch (e) { setResult({ ok: false, error: e.message }); }
  };
  const reindex = guarded(async (id) => {
    await api(`/api/settings/code-memory/projects/${encodeURIComponent(id)}/index`, { method: 'POST' });
    await load();
  });
  if (s == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  return html`<section class="form-card">
    <div class="row" style="justify-content: space-between">
      <strong>Code memory</strong>
      <${Switch} title=${s.enabled ? 'On' : 'Off'} checked=${s.enabled} onChange=${(v) => save(v)} />
    </div>
    <span class="dim small">A graph of every project's code (symbols, calls, imports, routes) from${' '}
      <a href="https://github.com/DeusData/codebase-memory-mcp" target="_blank" rel="noopener">codebase-memory-mcp</a>, built
      only when you click Index or Reindex below. Every user's chats query it as <span class="mono">code_*</span> tools on this gateway's MCP,
      each on its own project only. Chats reach them only with <span class="mono">MCP_INJECT=1</span>.</span>
    <${Field} label="Binary" hint="Path of codebase-memory-mcp on this machine (from its GitHub releases).">
      <input class="mono" value=${s.command} onInput=${set('command')} placeholder="/usr/local/bin/codebase-memory-mcp" /><//>
    <${Field} label="Cache folder" hint="CBM_CACHE_DIR: where the graphs live. Empty = ~/.cache/codebase-memory-mcp.">
      <input class="mono" value=${s.cacheDir} onInput=${set('cacheDir')} placeholder="default" /><//>
    <${Field} label="Runtime folder" hint="CBM_RUNTIME_DIR: only if CBM refuses its default because another account can write there.">
      <input class="mono" value=${s.runtimeDir} onInput=${set('runtimeDir')} placeholder="default" /><//>
    <label class="check small"><input type="checkbox" checked=${s.hooks} onChange=${(e) => setS({ ...s, hooks: e.currentTarget.checked })} />
      Hooks: next to each search (Claude Code: Grep, Glob, Bash; Codex: rg or grep in its shell), the agent also sees the
      matching symbols from the graph. Codex runs it with --dangerously-bypass-hook-trust, never in a repository with its own .codex hooks</label>
    <div class="row wrap">
      <${AsyncButton} class="btn primary sm" onClick=${() => save()}>Save<//>
      <${AsyncButton} class="btn sm" icon="refresh-cw" onClick=${test} disabled=${!s.command}>Test binary<//>
    </div>
    ${result && (result.ok ? html`<p class="small"><${Icon} name="circle-check" /> ${result.version}</p>`
      : html`<div class="form-error" role="alert">${result.error}</div>`)}
    ${s.enabled && !s.active && html`<div class="form-error" role="alert">Not running yet: check the binary and folders (Test binary), then Save.</div>`}
    ${s.enabled && html`<div>
      ${s.projects.map((p) => html`<div class="setting-row" key=${p.id}>
        <div><strong>${p.name}</strong>
          <div class="dim small">${!p.index ? 'Not indexed yet'
            : p.index.status === 'indexing' ? html`<${Spinner} /> Indexing…`
            : p.index.status === 'failed' ? html`<span class="note err">Failed: ${p.index.error}</span>`
            : html`${p.index.nodes.toLocaleString()} nodes, ${p.index.edges.toLocaleString()} edges · indexed ${ago(p.index.indexedAt)}${
              p.changed ? html` · <span class="pill warn">files changed since</span>` : ''}`}</div></div>
        <button class=${cx('btn sm', p.changed || !p.index?.graph ? '' : 'ghost')} disabled=${p.index?.status === 'indexing'} onClick=${() => reindex(p.id)}>
          <${Icon} name="refresh-cw" />${p.index?.graph ? 'Reindex' : 'Index'}</button>
      </div>`)}
    </div>`}
  </section>`;
}

/** Starting points for "Add"; every field stays editable. */
const TEMPLATES = [
  { name: 'context7', label: 'Context7', url: 'https://mcp.context7.com/mcp',
    note: 'Up-to-date library docs. The API key (context7.com) is optional and raises the rate limit.' },
  { name: 'playwright', label: 'Playwright', command: 'npx', args: ['-y', '@playwright/mcp@latest', '--headless', '--isolated'],
    note: 'A headless browser the agent drives. Needs a browser on this machine (npx playwright install chromium).' },
  { name: 'sentry', label: 'Sentry', command: 'npx', args: ['-y', '@sentry/mcp-server@latest'], env: ['SENTRY_ACCESS_TOKEN='],
    note: 'Errors and issues from Sentry. Needs a Sentry user auth token.' },
  { name: '', label: 'Custom', url: '' },
];

const path = (name) => `/api/settings/mcp-servers/${encodeURIComponent(name)}`;

/** Add a server (from `template`) or edit the saved one `s`. `onSaved(name)` once it is saved. */
function ServerForm({ s, template, taken, onSaved, onCancel }) {
  const t = s ? { ...s, env: s.envKeys } : template;
  const [f, setF] = useState({
    name: t.name || '', kind: t.command ? 'stdio' : 'http', url: t.url || '', token: '', command: t.command || '',
    args: (t.args || []).join('\n'), env: (t.env || []).join('\n'), allUsers: s ? s.allUsers : false,
  });
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const save = guarded(async () => {
    const name = f.name.trim();
    if (!s && taken.includes(name)) throw new Error(`there already is a server named ${name}`);
    // "KEY=value" sets a value; a bare "KEY" keeps the saved one.
    const env = Object.fromEntries(f.env.split('\n').map((l) => l.trim()).filter(Boolean)
      .map((l) => (l.includes('=') ? [l.slice(0, l.indexOf('=')).trim(), l.slice(l.indexOf('=') + 1)] : [l, null])));
    const common = { enabled: s ? s.enabled : true, allUsers: f.allUsers };
    await api(path(name), { method: 'PUT', body: f.kind === 'http'
      ? { ...common, url: f.url, ...(f.token.trim() && { token: f.token }) }
      : { ...common, command: f.command, args: f.args.split('\n').map((a) => a.trim()).filter(Boolean), env } });
    toast(`${name} saved`);
    onSaved(name);
  });
  return html`<section class="form-card">
    <strong>${s ? 'Connection' : template.name ? `Add ${template.label}` : 'Add a server'}</strong>
    ${template?.note && html`<span class="dim small">${template.note}</span>`}
    ${!s && html`<${Field} label="Name" hint="Lowercase letters, digits, - and _. The agent sees its tools as mcp__name.">
      <input class="mono" value=${f.name} onInput=${set('name')} placeholder="context7" /><//>`}
    <${Seg} small label="Transport" value=${f.kind} options=${[['http', 'HTTP'], ['stdio', 'Command (stdio)']]} onChange=${(v) => setF({ ...f, kind: v })} />
    ${f.kind === 'http' ? html`
      <${Field} label="URL"><input class="mono" value=${f.url} onInput=${set('url')} placeholder="https://example.com/mcp" /><//>
      <${Field} label="Bearer token" hint=${s?.tokenHint ? `Saved (${s.tokenHint}). Leave empty to keep it.` : 'Optional. Sent as Authorization: Bearer ...'}>
        <input type="password" class="mono" autocomplete="off" value=${f.token} onInput=${set('token')} placeholder=${s?.tokenHint ? '••••••••' : ''} /><//>`
    : html`
      <${Field} label="Command" hint="Started on this machine by the CLI, for every turn that gets the server.">
        <input class="mono" value=${f.command} onInput=${set('command')} placeholder="npx" /><//>
      <${Field} label="Arguments" hint="One per line.">
        <textarea class="mono" rows="3" value=${f.args} onInput=${set('args')}></textarea><//>
      <${Field} label="Environment" hint="KEY=value, one per line. Saved values are never shown: a line with only the name keeps it.">
        <textarea class="mono" rows="2" value=${f.env} onInput=${set('env')} placeholder="API_KEY=..."></textarea><//>`}
    <label class="check small"><input type="checkbox" checked=${f.allUsers} onChange=${(e) => setF({ ...f, allUsers: e.currentTarget.checked })} />
      All users: admins' and devs' chats get it too, with these credentials</label>
    <div class="row wrap">
      <${AsyncButton} class="btn primary sm" onClick=${save}>Save<//>
      ${onCancel && html`<button class="btn ghost sm" onClick=${onCancel}>Cancel</button>`}
    </div>
  </section>`;
}

/** One saved server's tab: on or off, remove, and its settings. */
function ServerTab({ s, onChange, onRemoved }) {
  // Saves the server back as it is, on or off (a null env value keeps the saved one).
  const toggle = guarded(async (enabled) => {
    const kind = s.url ? { url: s.url } : { command: s.command, args: s.args, env: Object.fromEntries(s.envKeys.map((k) => [k, null])) };
    await api(path(s.name), { method: 'PUT', body: { enabled, allUsers: s.allUsers, ...kind } });
    onChange();
  });
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: `Remove ${s.name}?`, message: 'Chats stop getting its tools from their next turn.', confirmText: 'Remove', danger: true })) return;
    await api(path(s.name), { method: 'DELETE' });
    onRemoved();
  });
  return html`
    <div class="setting-row">
      <div><strong class="mono">${s.name}</strong>
        <div class="dim small">${s.enabled ? 'On: given to' : 'Off. When on, given to'} ${s.allUsers ? 'every user\'s turns' : 'your turns only'}, its tools as <span class="mono">mcp__${s.name}</span>.</div></div>
      <div class="row">
        <${Switch} title=${s.enabled ? 'On' : 'Off'} checked=${s.enabled} onChange=${toggle} />
        <button class="icon-btn" aria-label=${`Remove ${s.name}`} title="Remove" onClick=${remove}><${Icon} name="trash-2" /></button>
      </div>
    </div>
    <${ServerForm} key=${s.name} s=${s} onSaved=${onChange} />`;
}

/** "+ Add": pick a template, then fill it in. */
function AddTab({ list, onSaved }) {
  const [template, setTemplate] = useState(null);
  if (template) return html`<${ServerForm} key=${template.label} template=${template} taken=${list.map((s) => s.name)} onSaved=${onSaved} onCancel=${() => setTemplate(null)} />`;
  return html`<section class="form-card">
    <strong>Add a server</strong>
    <span class="dim small">Given to Codex and Claude Code turns from their next turn on, read-only projects included.
      Their tools are approved up front, since a headless run cannot ask.</span>
    <div class="row wrap">
      ${TEMPLATES.filter((t) => !t.name || !list.some((s) => s.name === t.name)).map((t) => html`
        <button class="btn sm" title=${t.note} onClick=${() => setTemplate(t)}><${Icon} name="plus" />${t.label}</button>`)}
    </div>
  </section>`;
}

/** ClickUp, every saved server and "+ Add", one tab each. */
export function McpSection() {
  const [list, setList] = useState(null);
  const [tab, setTab] = useState('clickup');
  const load = () => api('/api/settings/mcp-servers').then(setList).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (list == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const server = list.find((s) => s.name === tab);
  const current = tab === 'clickup' || tab === 'code' || tab === 'add' || server ? tab : 'clickup';
  const tabs = [['clickup', 'ClickUp', true], ['code', 'Code memory', true], ...list.map((s) => [s.name, s.name, s.enabled]), ['add', 'Add', true]];
  return html`
    <p class="dim">Tools your chats' agents can use. They are yours: only turns you sent get them, unless one is marked
      <strong>All users</strong>. Prompts from admins and devs (and from agents and approvals) get only those.</p>
    <div class="tabs wrap" role="tablist" aria-label="MCP servers">
      ${tabs.map(([k, label, on]) => html`<button key=${k} role="tab" aria-selected=${current === k} class=${cx('tab', current === k && 'active', !on && 'off')}
        title=${on ? '' : 'Off'} onClick=${() => setTab(k)}>${k === 'add' && html`<${Icon} name="plus" />`}<span class=${cx(k !== 'clickup' && k !== 'code' && k !== 'add' && 'mono')}>${label}</span></button>`)}
    </div>
    ${current === 'clickup' ? html`<${ClickUpCard} />`
      : current === 'code' ? html`<${CodeMemoryCard} />`
      : current === 'add' ? html`<${AddTab} list=${list} onSaved=${async (name) => { await load(); setTab(name); }} />`
      : html`<${ServerTab} key=${server.name} s=${server} onChange=${load} onRemoved=${async () => { await load(); setTab('clickup'); }} />`}`;
}

// Settings → MCP (the owner): ClickUp and the other MCP servers agents get. Every one is the owner's only unless marked
// "All users".
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Field, Icon, Seg, Spinner, Switch } from './ui.js';
import { guarded, toast } from './store.js';

/** The owner's ClickUp token, workspace and time zone, for the read-only ClickUp Chat tools on /mcp. */
function ClickUpCard() {
  const [s, setS] = useState(null);
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);
  const load = (v) => { setS(v); setToken(''); setResult(null); };
  useEffect(() => { api('/api/settings/clickup').then(load).catch((e) => toast(e.message, 'err')); }, []);
  const set = (k) => (e) => setS({ ...s, [k]: e.currentTarget.value });
  const body = (extra) => ({ workspaceId: s.workspaceId, timeZone: s.timeZone, allUsers: s.allUsers, ...extra });
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
    <span class="dim small">Read-only ClickUp Chat tools on this gateway's own MCP, e.g. "what did I work on last week?".
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
  const current = tab === 'clickup' || tab === 'add' || server ? tab : 'clickup';
  const tabs = [['clickup', 'ClickUp', true], ...list.map((s) => [s.name, s.name, s.enabled]), ['add', 'Add', true]];
  return html`
    <p class="dim">Tools your chats' agents can use. They are yours: only turns you sent get them, unless one is marked
      <strong>All users</strong>. Prompts from admins and devs (and from agents and approvals) get only those.</p>
    <div class="tabs wrap" role="tablist" aria-label="MCP servers">
      ${tabs.map(([k, label, on]) => html`<button key=${k} role="tab" aria-selected=${current === k} class=${cx('tab', current === k && 'active', !on && 'off')}
        title=${on ? '' : 'Off'} onClick=${() => setTab(k)}>${k === 'add' && html`<${Icon} name="plus" />`}<span class=${cx(k !== 'clickup' && k !== 'add' && 'mono')}>${label}</span></button>`)}
    </div>
    ${current === 'clickup' ? html`<${ClickUpCard} />`
      : current === 'add' ? html`<${AddTab} list=${list} onSaved=${async (name) => { await load(); setTab(name); }} />`
      : html`<${ServerTab} key=${server.name} s=${server} onChange=${load} onRemoved=${async () => { await load(); setTab('clickup'); }} />`}`;
}

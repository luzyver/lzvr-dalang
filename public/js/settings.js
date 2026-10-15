// The Settings dialog: appearance and this device for everyone; defaults, generate prompts, accounts and users for admins;
// ClickUp for the owner.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Field, Icon, Modal, Seg, Spinner } from './ui.js';
import { guarded, isAdmin, isOwner, me, toast, ui } from './store.js';
import { PALETTES, THEMES, palette, theme } from './theme.js';
import { enableNotifications } from './notifications.js';
import { AccountsSection } from './accounts.js';
import { UsersSection } from './users.js';
import { signOut } from './session.js';

const EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

function Appearance() {
  return html`
    <div class="field"><span class="field-label">Theme</span><${Seg} label="Theme" value=${theme.value} options=${THEMES} onChange=${(v) => { theme.value = v; }} /></div>
    <div class="field"><span class="field-label">Accent palette</span>
      <div class="swatches" role="radiogroup" aria-label="Accent palette">
        ${PALETTES.map(([v, name, note]) => html`<button key=${v} role="radio" aria-checked=${palette.value === v} class=${cx(palette.value === v && 'active')} onClick=${() => { palette.value = v; }}>
          <span class=${`sw sw-${v}`}></span><span><strong>${name}</strong><span class="dim small">${note}</span></span>
          ${palette.value === v && html`<${Icon} name="check" class="sw-check" />`}
        </button>`)}
      </div>
    </div>`;
}

function Device() {
  return html`
    <div class="setting-row">
      <div><strong>Notifications</strong><div class="dim small">A push notification when a turn finishes, fails or needs input, on this device.</div></div>
      <${AsyncButton} class="btn" icon="bell" onClick=${guarded(async () => { await enableNotifications(); toast('Notifications on'); })}>Enable<//>
    </div>
    <div class="setting-row">
      <div><strong>Sign out</strong><div class="dim small">Signed in as ${me.value?.name} (${me.value?.role}).</div></div>
      <button class="btn danger" onClick=${signOut}><${Icon} name="log-out" />Sign out</button>
    </div>`;
}

/** Global model/effort defaults, one block per backend (a Codex model name means nothing to Claude Code). */
function DefaultsFor({ backend, title }) {
  const q = backend === 'claude' ? '?backend=claude' : '';
  const [models, setModels] = useState([]);
  const [model, setModel] = useState(null);
  const [effort, setEffort] = useState('');
  useEffect(() => {
    Promise.all([api(`/api/settings/default-model${q}`), api(`/api/settings/default-effort${q}`)])
      .then(([m, e]) => { setModel(m.model); setEffort(e.effort); }).catch((e) => toast(e.message, 'err'));
    api(`/api/models${q}`).then(setModels).catch(() => {});
  }, []);
  const save = guarded(async () => {
    await api('/api/settings/default-model', { method: 'PUT', body: { model, backend } });
    await api('/api/settings/default-effort', { method: 'PUT', body: { effort, backend } });
    toast(`${title} defaults saved`);
  });
  if (model == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const options = [['', `${title} default`], ...models.map((m) => [m.slug, `${m.name} (${m.slug})`])];
  if (model && !models.some((m) => m.slug === model)) options.push([model, model]);
  return html`<section class="form-card">
    <strong>${title}</strong>
    <div class="row wrap">
      <${Field} label="Model"><select value=${model} onChange=${(e) => setModel(e.currentTarget.value)}>${options.map(([v, l]) => html`<option value=${v}>${l}</option>`)}</select><//>
      <${Field} label="Reasoning effort"><select value=${effort} onChange=${(e) => setEffort(e.currentTarget.value)}>
        <option value="">${title} default</option>${EFFORTS.map((v) => html`<option value=${v}>${v}</option>`)}</select><//>
    </div>
    <div class="row"><${AsyncButton} class="btn primary sm" onClick=${save}>Save<//></div>
  </section>`;
}

const Defaults = () => html`
  <p class="dim">Used when a chat has no model or effort of its own. Leave a field on its default to let the CLI choose.</p>
  <${DefaultsFor} backend="codex" title="Codex" />
  <${DefaultsFor} backend="claude" title="Claude Code" />`;

/** The instructions the Changes tab's generate buttons give the agent, the same for Codex and Claude Code. Empty = built in. */
function PromptFor({ path, title, help }) {
  const [text, setText] = useState(null);
  const [builtIn, setBuiltIn] = useState('');
  useEffect(() => {
    api(`/api/settings/${path}`).then((r) => { setBuiltIn(r.default); setText(r.prompt || r.default); }).catch((e) => toast(e.message, 'err'));
  }, []);
  // Saving the built-in text unchanged stores nothing, so later updates of the default still apply.
  const save = guarded(async () => {
    await api(`/api/settings/${path}`, { method: 'PUT', body: { prompt: text.trim() === builtIn.trim() ? '' : text.trim() } });
    toast(`${title} prompt saved`);
  });
  if (text == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  return html`<section class="form-card">
    <strong>${title}</strong><span class="dim small">${help}</span>
    <textarea class="mono prompt-edit" rows="12" value=${text} onInput=${(e) => setText(e.currentTarget.value)}></textarea>
    <div class="row">
      <${AsyncButton} class="btn primary sm" onClick=${save}>Save<//>
      <button class="btn ghost sm" onClick=${() => setText(builtIn)} disabled=${text === builtIn}>Reset to default</button>
      ${text.trim() !== builtIn.trim() && html`<span class="dim small">Customised</span>`}
    </div>
  </section>`;
}

const COMMIT_HELP = '"Generate" in Changes. The selected files, their diffs, recent commits and the chat\'s last requests are appended.';
const MR_HELP = '"Generate description" in Changes, for a worktree chat or a feature branch. The branch\'s commits, its diff against the branch it merges into and the chat\'s last requests are appended. A "## Title" line becomes the Merge Request title.';

const Prompts = () => html`
  <p class="dim">Used by Codex and Claude Code alike, with the chat's own model.</p>
  <${PromptFor} path="commit-prompt" title="Commit message" help=${COMMIT_HELP} />
  <${PromptFor} path="mr-prompt" title="Merge Request description" help=${MR_HELP} />`;

/** The owner's ClickUp token and how overtime is judged, for the read-only ClickUp Chat tools on /mcp. */
function ClickUpSection() {
  const [s, setS] = useState(null);
  const [token, setToken] = useState('');
  const [result, setResult] = useState(null);
  const load = (v) => { setS(v); setToken(''); setResult(null); };
  useEffect(() => { api('/api/settings/clickup').then(load).catch((e) => toast(e.message, 'err')); }, []);
  const set = (k) => (e) => setS({ ...s, [k]: e.currentTarget.value });
  const body = (extra) => ({ workspaceId: s.workspaceId, timeZone: s.timeZone, workHours: s.workHours, ...extra });
  // An empty token field keeps the saved token.
  const save = guarded(async () => {
    load(await api('/api/settings/clickup', { method: 'PUT', body: body(token.trim() ? { token } : {}) }));
    toast('ClickUp settings saved');
  });
  const remove = guarded(async () => {
    if (!confirm('Remove the ClickUp token? The ClickUp tools stop working until a new one is saved.')) return;
    load(await api('/api/settings/clickup', { method: 'PUT', body: body({ token: '' }) }));
    toast('ClickUp token removed');
  });
  const test = async () => {
    try { setResult({ ok: true, ...(await api('/api/settings/clickup/test', { method: 'POST' })) }); }
    catch (e) { setResult({ ok: false, error: e.message }); }
  };
  if (s == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : [];
  return html`
    <p class="dim">Lets your chats read your ClickUp Chat messages, e.g. "when did I work overtime last month, and on what?".
      Read only, and only for you: other users' prompts never get it. Chats reach it through this gateway's MCP (<span class="mono">MCP_INJECT=1</span>).</p>
    <section class="form-card">
      <strong>Connection</strong>
      <${Field} label="Personal API token" hint=${s.configured ? `Saved (${s.tokenHint}). Leave empty to keep it.` : 'ClickUp → Settings → Apps → API Token (pk_...).'}>
        <input type="password" class="mono" autocomplete="off" value=${token} onInput=${(e) => setToken(e.currentTarget.value)}
          placeholder=${s.configured ? '••••••••' : 'pk_...'} /><//>
      <${Field} label="Default workspace ID" hint="Empty = every workspace the token can see. A chat can still ask for a particular one.">
        <input class="mono" inputmode="numeric" value=${s.workspaceId} onInput=${set('workspaceId')} placeholder="all workspaces" /><//>
    </section>
    <section class="form-card">
      <strong>Overtime</strong>
      <div class="row wrap">
        <${Field} label="Time zone" hint="Empty = your ClickUp profile's time zone.">
          <input list="clickup-zones" value=${s.timeZone} onInput=${set('timeZone')} placeholder="Asia/Jakarta" /><//>
        <${Field} label="Work hours" hint="Messages outside these hours, or on Saturday/Sunday, count as overtime.">
          <input class="mono" value=${s.workHours} onInput=${set('workHours')} placeholder=${s.defaultWorkHours} /><//>
      </div>
      <datalist id="clickup-zones">${zones.map((z) => html`<option value=${z} />`)}</datalist>
    </section>
    <div class="row wrap">
      <${AsyncButton} class="btn primary sm" onClick=${save}>Save<//>
      <${AsyncButton} class="btn sm" icon="refresh-cw" onClick=${test} disabled=${!s.configured}>Test connection<//>
      ${s.configured && html`<button class="btn ghost danger sm" onClick=${remove}><${Icon} name="trash-2" />Remove token</button>`}
    </div>
    ${result && (result.ok
      ? html`<p class="small"><${Icon} name="circle-check" /> Connected as <strong>${result.user.username || result.user.email}</strong>
          with ${result.workspaces.length} workspace(s): ${result.workspaces.map((w) => `${w.name || 'unnamed'} (${w.id})`).join(', ')}.
          Time zone ${result.time_zone}, work hours ${result.work_hours}.</p>`
      : html`<div class="form-error" role="alert">${result.error}</div>`)}`;
}

const SECTIONS = [
  ['appearance', 'Appearance', 'palette', Appearance, false],
  ['device', 'This device', 'monitor', Device, false],
  ['defaults', 'Model & effort', 'sliders-horizontal', Defaults, true],
  ['prompts', 'Generate prompts', 'sparkles', Prompts, true],
  ['codex', 'Codex accounts', 'key-round', () => html`<${AccountsSection} backend="codex" />`, true],
  ['claude', 'Claude Code accounts', 'key-round', () => html`<${AccountsSection} backend="claude" />`, true],
  ['users', 'Users', 'users', UsersSection, true],
  ['clickup', 'ClickUp', 'message-square', ClickUpSection, 'owner'],
];

function Settings() {
  const current = ui.settings.value;
  const visible = SECTIONS.filter((s) => !s[4] || (s[4] === 'owner' ? isOwner.value : isAdmin.value));
  const [, title, , Body] = visible.find((s) => s[0] === current) || visible[0];
  const go = (k) => { ui.settings.value = k; };
  return html`<div class="settings-layout">
    <nav class="settings-nav" aria-label="Settings sections">
      <div class="group-label">Settings</div>
      ${visible.map(([k, label, icon]) => html`<button key=${k} class=${cx('settings-link', k === current && 'active')} onClick=${() => go(k)}><${Icon} name=${icon} />${label}</button>`)}
    </nav>
    <div class="settings-main">
      <div class="dialog-head">
        <select class="settings-picker" aria-label="Settings section" value=${current} onChange=${(e) => go(e.currentTarget.value)}>
          ${visible.map(([k, label]) => html`<option value=${k}>${label}</option>`)}
        </select>
        <h2>${title}</h2>
        <button class="icon-btn" aria-label="Close settings" onClick=${() => { ui.settings.value = null; }}><${Icon} name="x" /></button>
      </div>
      <div class="settings-body"><${Body} key=${current} /></div>
    </div>
  </div>`;
}

export const SettingsModal = () => html`<${Modal} open=${ui.settings.value != null} label="Settings" class="settings" onClose=${() => { ui.settings.value = null; }}><${Settings} /><//>`;

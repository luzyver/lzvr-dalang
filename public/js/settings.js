// The Settings dialog: appearance and this device for everyone; defaults, generate prompts, accounts and users for admins;
// Git & forges for everyone (the owner: the server's setup) and MCP (ClickUp and other servers) for the owner.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, Field, Icon, Modal, Seg, Spinner } from './ui.js';
import { guarded, isAdmin, isOwner, me, toast, ui } from './store.js';
import { PALETTES, THEMES, palette, theme } from './theme.js';
import { enableNotifications } from './notifications.js';
import { AccountsSection } from './accounts.js';
import { UsersSection } from './users.js';
import { GitSection } from './git-auth.js';
import { McpSection } from './mcp-settings.js';
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

/**
 * The models agents may give the chats they start or run over MCP (create_conversation, set_model), weakest first, and
 * the highest effort. Agents start low and step up one model at a time when a result falls short.
 */
function AgentChoiceFor({ backend, title }) {
  const q = backend === 'claude' ? '?backend=claude' : '';
  const [models, setModels] = useState([]);
  const [list, setList] = useState(null);
  const [maxEffort, setMaxEffort] = useState('');
  const [pick, setPick] = useState('');
  useEffect(() => {
    api(`/api/settings/agent-models${q}`).then((r) => { setList(r.models); setMaxEffort(r.maxEffort); }).catch((e) => toast(e.message, 'err'));
    api(`/api/models${q}`).then(setModels).catch(() => {});
  }, []);
  // A slug typed but not yet added still counts: Save keeps what is on screen.
  const withPick = (l) => { const v = pick.trim(); return v && !l.includes(v) ? [...l, v] : l; };
  const save = guarded(async () => {
    const models = withPick(list);
    await api('/api/settings/agent-models', { method: 'PUT', body: { models, maxEffort, backend } });
    setList(models);
    setPick('');
    toast(`${title} agent models saved`);
  });
  if (list == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const nameOf = (slug) => models.find((m) => m.slug === slug)?.name ?? slug;
  const up = (i) => setList([...list.slice(0, i - 1), list[i], list[i - 1], ...list.slice(i + 1)]);
  const add = () => { setList(withPick(list)); setPick(''); };
  const left = models.filter((m) => !list.includes(m.slug));
  return html`<section class="form-card">
    <strong>${title}</strong>
    ${list.length > 0 && html`<span class="dim small">Top to bottom: cheapest (tried first) to strongest (when the work falls short).</span>`}
    ${list.length ? html`<ol class="agent-models">${list.map((slug, i) => html`<li key=${slug} class="row">
      <span class="grow">${nameOf(slug)} <span class="dim small mono">${slug}</span></span>
      ${list.length > 1 && (i === 0 || i === list.length - 1) && html`<span class="pill">${i === 0 ? 'first' : 'strongest'}</span>`}
      <button class="icon-btn sm" aria-label=${`Move ${slug} up`} title="Move up: cheaper, tried sooner" disabled=${i === 0} onClick=${() => up(i)}><${Icon} name="arrow-up" /></button>
      <button class="icon-btn sm danger" aria-label=${`Remove ${slug}`} onClick=${() => setList(list.filter((x) => x !== slug))}><${Icon} name="x" /></button>
    </li>`)}</ol>` : html`<span class="dim small">None: agents keep the default model.</span>`}
    <div class="row">
      ${left.length ? html`<select value="" onChange=${(e) => { const v = e.currentTarget.value; if (v) setList([...list, v]); }}>
        <option value="">Add a model…</option>${left.map((m) => html`<option value=${m.slug}>${m.name} (${m.slug})</option>`)}</select>`
        : html`<input class="mono" placeholder="model slug" value=${pick} onInput=${(e) => setPick(e.currentTarget.value)}
            onKeyDown=${(e) => { if (e.key === 'Enter') add(); }} />
          <button class="btn sm" disabled=${!pick.trim()} onClick=${add}><${Icon} name="plus" />Add</button>`}
    </div>
    <${Field} label="Highest reasoning effort"><select value=${maxEffort} onChange=${(e) => setMaxEffort(e.currentTarget.value)}>
      <option value="">None: agents keep the default</option>${EFFORTS.map((v) => html`<option value=${v}>${v}</option>`)}</select><//>
    <div class="row"><${AsyncButton} class="btn primary sm" onClick=${save}>Save<//></div>
  </section>`;
}

/** How far agents may go with sub-agents: how many per chat, how deep, and whether they may send them work unasked. */
function SubagentLimits() {
  const [p, setP] = useState(null);
  useEffect(() => {
    api('/api/settings/subagents').then((r) => setP({ ...r, guide: r.guide || r.defaultGuide })).catch((e) => toast(e.message, 'err'));
  }, []);
  // Saving the built-in guide unchanged stores nothing, so later updates of the default still apply.
  const save = guarded(async () => {
    const { defaultGuide, ...body } = p;
    await api('/api/settings/subagents', { method: 'PUT', body: { ...body, guide: p.guide.trim() === defaultGuide.trim() ? '' : p.guide.trim() } });
    toast('Orchestrator settings saved');
  });
  if (p == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const num = (k, max) => (e) => setP({ ...p, [k]: Math.max(0, Math.min(max, Number(e.currentTarget.value) || 0)) });
  return html`<section class="form-card">
    <strong>Orchestrator</strong>
    <span class="dim small">A chat's agent can hand parts of its task to sub-agents: it picks how many, for what and with which
      model, within these limits, and each one's answer comes back to it as a message.</span>
    <div class="field"><span class="field-label">When</span><${Seg} label="When agents start sub-agents" value=${p.mode}
      onChange=${(mode) => setP({ ...p, mode })} options=${[['asked', 'Only when asked'], ['auto', 'Agents decide themselves']]} /></div>
    ${p.mode === 'auto' && html`<span class="dim small">Every turn that may still start a sub-agent gets the guide below, plus
      its project, how many it may still start and the models it may pick. This can use more of the accounts' limits.</span>
      <textarea class="prompt-edit" rows="10" aria-label="Orchestrator guide" value=${p.guide} onInput=${(e) => setP({ ...p, guide: e.currentTarget.value })}></textarea>
      <div class="row">
        <button class="btn ghost sm" onClick=${() => setP({ ...p, guide: p.defaultGuide })} disabled=${p.guide === p.defaultGuide}>Reset guide to default</button>
        ${p.guide.trim() !== p.defaultGuide.trim() && html`<span class="dim small">Customised</span>`}
      </div>`}
    <div class="row wrap">
      <${Field} label="Sub-agents per chat" hint="0 turns sub-agents off"><input type="number" min="0" max="50" value=${p.maxChildren} onInput=${num('maxChildren', 50)} /><//>
      <${Field} label="Levels deep" hint="1: only a person's chat starts them"><input type="number" min="0" max="5" value=${p.maxDepth} onInput=${num('maxDepth', 5)} /><//>
    </div>
    <label class="row"><input type="checkbox" checked=${p.autoSend} onChange=${(e) => setP({ ...p, autoSend: e.currentTarget.checked })} />
      <span>Agents send their own sub-agents work without asking <span class="dim small">(same project only; off: each prompt waits in Approvals)</span></span></label>
    <div class="row"><${AsyncButton} class="btn primary sm" onClick=${save}>Save<//></div>
  </section>`;
}

/** Whether chat agents may commit and push themselves; by default the person does both from the chat's Changes tab. */
function AgentGit() {
  const [p, setP] = useState(null);
  useEffect(() => { api('/api/settings/agent-git').then(setP).catch((e) => toast(e.message, 'err')); }, []);
  const save = guarded(async (next) => {
    setP(next);
    await api('/api/settings/agent-git', { method: 'PUT', body: next });
    toast("Saved: applies from each chat's next turn");
  });
  if (p == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  return html`<section class="form-card">
    <strong>Commits and pushes</strong>
    <span class="dim small">Off: agents leave their changes for you to commit and push from the chat's Changes tab, as they are
      told, and their own git refuses (a pre-commit hook, and push URLs that lead nowhere). Your commits and pushes from the
      panel always work.</span>
    <label class="row"><input type="checkbox" checked=${p.commit} onChange=${(e) => save({ ...p, commit: e.currentTarget.checked })} />
      <span>Agents may commit</span></label>
    <label class="row"><input type="checkbox" checked=${p.push} onChange=${(e) => save({ ...p, push: e.currentTarget.checked })} />
      <span>Agents may push</span></label>
  </section>`;
}

const Defaults = () => html`
  <p class="dim">Used when a chat has no model or effort of its own. Leave a field on its default to let the CLI choose.</p>
  <${DefaultsFor} backend="codex" title="Codex" />
  <${DefaultsFor} backend="claude" title="Claude Code" />
  <p class="dim">Models agents may pick for the chats they start (sub-agents) or move up to, weakest first. Agents are told
    to start with the weakest that fits and step up one at a time only when the work falls short.</p>
  <${AgentChoiceFor} backend="codex" title="Codex: agents may pick" />
  <${AgentChoiceFor} backend="claude" title="Claude Code: agents may pick" />
  <${SubagentLimits} />
  <${AgentGit} />`;

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

const SECTIONS = [
  ['appearance', 'Appearance', 'palette', Appearance, false],
  ['device', 'This device', 'monitor', Device, false],
  ['defaults', 'Model & effort', 'sliders-horizontal', Defaults, true],
  ['prompts', 'Generate prompts', 'sparkles', Prompts, true],
  ['codex', 'Codex accounts', 'key-round', () => html`<${AccountsSection} backend="codex" />`, true],
  ['claude', 'Claude Code accounts', 'key-round', () => html`<${AccountsSection} backend="claude" />`, true],
  ['users', 'Users', 'users', UsersSection, true],
  ['git', 'Git & forges', 'git-branch', GitSection, false],
  ['mcp', 'MCP', 'wrench', McpSection, 'owner'],
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

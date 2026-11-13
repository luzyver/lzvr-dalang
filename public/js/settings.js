// The Settings dialog: appearance and this device for everyone; defaults, generate prompts, project memory, accounts and users for admins;
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
import { MemorySection } from './memory.js';
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

/** How far agents may go with sub-agents: how many per chat, how deep, and whether they may send them work unasked. */
function SubagentLimits() {
  const [p, setP] = useState(null);
  useEffect(() => { api('/api/settings/subagents').then(setP).catch((e) => toast(e.message, 'err')); }, []);
  const save = guarded(async () => {
    await api('/api/settings/subagents', { method: 'PUT', body: p });
    toast('Sub-agent settings saved');
  });
  if (p == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const num = (k, max) => (e) => setP({ ...p, [k]: Math.max(0, Math.min(max, Number(e.currentTarget.value) || 0)) });
  return html`<section class="form-card">
    <strong>Sub-agents</strong>
    <span class="dim small">A chat's agent can hand parts of its task to sub-agents. Whether to, for what and with which model
      it decides itself (the orchestrating-subagents skill), within these limits; a sub-agent never runs on a stronger model
      or a higher effort than the agent that starts it, and each one's answer comes back to it as a message.</span>
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

/** Impeccable's design detector: after an agent edits a UI file, its findings go into the agent's context. */
function DesignHook() {
  const [p, setP] = useState(null);
  useEffect(() => { api('/api/settings/design-hook').then(setP).catch((e) => toast(e.message, 'err')); }, []);
  const save = guarded(async (next) => {
    setP(next);
    await api('/api/settings/design-hook', { method: 'PUT', body: next });
    toast("Saved: applies from each chat's next turn");
  });
  if (p == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  return html`<section class="form-card">
    <strong>Design detector</strong>
    <span class="dim small">After an agent edits a UI file (HTML, CSS, JSX, Vue, ...), the Impeccable skill's detector checks it
      and tells the agent what to fix; at the end of the turn it makes a deeper pass. It never blocks an edit, stays silent on
      other files, and skips projects that install Impeccable's hook themselves. Its cache (.impeccable/hook.cache.json) is
      kept out of git changes.</span>
    <label class="row"><input type="checkbox" checked=${p.enabled} onChange=${(e) => save({ enabled: e.currentTarget.checked })} />
      <span>Check UI edits</span></label>
  </section>`;
}

/** The automatic reviewer: after a person's chat changes files, a read-only sub-chat checks the work and sends back what is wrong. */
function ReviewerSettings() {
  const [p, setP] = useState(null);
  const [models, setModels] = useState([]);
  useEffect(() => {
    api('/api/settings/reviewer').then((r) => setP({ ...r, guide: r.guide || r.defaultGuide })).catch((e) => toast(e.message, 'err'));
  }, []);
  // The models of the chosen agent, as in its defaults above.
  const backend = p?.backend;
  useEffect(() => {
    setModels([]);
    if (backend) api(`/api/models${backend === 'claude' ? '?backend=claude' : ''}`).then(setModels).catch(() => {});
  }, [backend]);
  // As with the orchestrator guide: the built-in guide unchanged stores nothing.
  const save = guarded(async () => {
    const { defaultGuide, ...body } = p;
    await api('/api/settings/reviewer', { method: 'PUT', body: { ...body, guide: p.guide.trim() === defaultGuide.trim() ? '' : p.guide.trim() } });
    toast('Reviewer settings saved');
  });
  if (p == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  return html`<section class="form-card">
    <strong>Reviewer</strong>
    <span class="dim small">After a turn of a person's chat that changed files, a second agent reads the change in a read-only
      sub-chat and checks it against the request. When it finds problems it sends them to the chat as a message, and the
      chat's agent fixes them, up to the rounds below per request.</span>
    <label class="row"><input type="checkbox" checked=${p.enabled} onChange=${(e) => setP({ ...p, enabled: e.currentTarget.checked })} />
      <span>Review the work of every chat automatically <span class="dim small">(uses more of the accounts' limits)</span></span></label>
    ${p.enabled && html`
      <div class="row wrap">
        <${Field} label="Agent" hint="Same as chat: the reviewed chat's agent and its defaults">
          <select value=${p.backend} onChange=${(e) => setP({ ...p, backend: e.currentTarget.value, model: '' })}>
            <option value="">Same as chat</option><option value="codex">Codex</option><option value="claude">Claude Code</option>
          </select><//>
        ${p.backend && html`
          <${Field} label="Model"><select value=${p.model} onChange=${(e) => setP({ ...p, model: e.currentTarget.value })}>
            <option value="">Default</option>${models.map((m) => html`<option value=${m.slug}>${m.name} (${m.slug})</option>`)}
            ${p.model && !models.some((m) => m.slug === p.model) && html`<option value=${p.model}>${p.model}</option>`}
          </select><//>
          <${Field} label="Effort"><select value=${p.effort} onChange=${(e) => setP({ ...p, effort: e.currentTarget.value })}>
            <option value="">Default</option>${EFFORTS.map((x) => html`<option value=${x}>${x}</option>`)}
          </select><//>`}
        <${Field} label="Rounds per request" hint="Reviews of one request at most"><input type="number" min="1" max="10" value=${p.maxRounds}
          onInput=${(e) => setP({ ...p, maxRounds: Math.max(1, Math.min(10, Number(e.currentTarget.value) || 1)) })} /><//>
      </div>
      <textarea class="prompt-edit" rows="6" aria-label="Reviewer guide" value=${p.guide} onInput=${(e) => setP({ ...p, guide: e.currentTarget.value })}></textarea>
      <div class="row">
        <button class="btn ghost sm" onClick=${() => setP({ ...p, guide: p.defaultGuide })} disabled=${p.guide === p.defaultGuide}>Reset guide to default</button>
        ${p.guide.trim() !== p.defaultGuide.trim() && html`<span class="dim small">Customised</span>`}
      </div>`}
    <div class="row"><${AsyncButton} class="btn primary sm" onClick=${save}>Save<//></div>
  </section>`;
}

/** Custom skills: instructions an admin writes here, run in any chat by typing `/custom <name>` at the start of a prompt. */
function CustomSkills() {
  const [list, setList] = useState(null);
  useEffect(() => { api('/api/settings/custom-skills').then(setList).catch((e) => toast(e.message, 'err')); }, []);
  const save = guarded(async () => {
    await api('/api/settings/custom-skills', { method: 'PUT', body: { skills: list } });
    toast('Custom skills saved');
  });
  if (list == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const edit = (i, patch) => setList(list.map((s, j) => (j === i ? { ...s, ...patch } : s)));
  return html`<section class="form-card">
    <strong>Custom skills</strong>
    <span class="dim small">Write instructions once, then run them in any chat by starting a message with <code>/custom name</code>;
      the rest of the message is the input. A name is letters, digits, "-" and "_".</span>
    ${list.map((s, i) => html`<div class="form-card" key=${i}>
      <div class="row wrap">
        <${Field} label="Name"><input value=${s.name} placeholder="release-notes" onInput=${(e) => edit(i, { name: e.currentTarget.value.trim() })} /><//>
        <${Field} label="Description"><input value=${s.description} onInput=${(e) => edit(i, { description: e.currentTarget.value })} /><//>
        <button class="btn danger sm" onClick=${() => setList(list.filter((_, j) => j !== i))}>Remove</button>
      </div>
      <textarea class="prompt-edit" rows="6" aria-label="Instructions of ${s.name || 'skill'}" value=${s.content} onInput=${(e) => edit(i, { content: e.currentTarget.value })}></textarea>
    </div>`)}
    <div class="row">
      <button class="btn ghost sm" onClick=${() => setList([...list, { name: '', description: '', content: '' }])}>Add skill</button>
      <${AsyncButton} class="btn primary sm" onClick=${save}>Save<//>
    </div>
  </section>`;
}

const Defaults = () => html`
  <p class="dim">Used when a chat has no model or effort of its own. Leave a field on its default to let the CLI choose.</p>
  <${DefaultsFor} backend="codex" title="Codex" />
  <${DefaultsFor} backend="claude" title="Claude Code" />
  <${SubagentLimits} />
  <${ReviewerSettings} />
  <${DesignHook} />
  <${AgentGit} />
  <${CustomSkills} />`;

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
  <p class="dim">Used by Codex and Claude Code alike: the chat's agent, with the default model and effort under "Model & effort" (not the chat's own).</p>
  <${PromptFor} path="commit-prompt" title="Commit message" help=${COMMIT_HELP} />
  <${PromptFor} path="mr-prompt" title="Merge Request description" help=${MR_HELP} />`;

const SECTIONS = [
  ['appearance', 'Appearance', 'palette', Appearance, false],
  ['device', 'This device', 'monitor', Device, false],
  ['defaults', 'Model & effort', 'sliders-horizontal', Defaults, true],
  ['prompts', 'Generate prompts', 'sparkles', Prompts, true],
  ['memory', 'Project memory', 'lightbulb', MemorySection, true],
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
      ${visible.map(([k, label, icon]) => html`<button key=${k} class=${cx('settings-link', k === current && 'active')} aria-current=${k === current ? 'page' : undefined}
        autofocus=${k === current} onClick=${() => go(k)}><${Icon} name=${icon} />${label}</button>`)}
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

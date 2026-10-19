// The SSH hosts page (admins): servers agents run shell commands on through the gateway's ssh_* MCP tools. Dalang
// keeps each login; agents see a host's name, label and note only, and the secrets are taken out of what commands print.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Field, Icon, Seg, Spinner } from './ui.js';
import { guarded, isOwner, toast, toggleSidebar } from './store.js';

const ACCESS = { all: 'Everyone', admin: 'Owner and admins', owner: 'Owner only' };
const AGENT = { off: 'Off', approve: 'Every command after approval', run: 'Run (dangerous ones after approval)' };
const AGENT_HINT = {
  off: 'Agents do not see this host.',
  approve: 'Each command waits in Approvals until an admin runs or rejects it; the outcome goes back to the agent\'s chat.',
  run: 'Agents run commands at once (ssh_exec), except those that read as dangerous (deleting files, stopping services, '
    + 'rebooting, changing users, sudoers or the firewall, removing packages or containers, piping into a shell, running a '
    + 'script file, ...), sudo or not: those wait in Approvals. Best effort, not a guarantee. Every command is logged below.',
};
const path = (id) => `/api/ssh/hosts/${encodeURIComponent(id)}`;

/** "3 min ago" for a time in ms. */
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

/** Add a host, or edit the saved one `h`. An empty secret field keeps the saved secret. */
function HostForm({ h, taken, onSaved, onCancel }) {
  const [f, setF] = useState({
    id: h?.id ?? '', label: h?.label ?? '', host: h?.host ?? '', port: h?.port ? String(h.port) : '', user: h?.user ?? '',
    auth: h?.auth ?? 'password', password: '', privateKey: '', passphrase: '', sudoPassword: '', note: h?.note ?? '',
    access: h?.access ?? 'admin', agent: h?.agent ?? 'approve', holdPatterns: (h?.holdPatterns ?? []).join('\n'),
  });
  // The key Test connection saw, trusted once the host is saved with it.
  const [tested, setTested] = useState(null);
  const set = (k) => (e) => setF({ ...f, [k]: e.currentTarget.value });
  const loadKey = (e) => {
    const file = e.currentTarget.files?.[0];
    if (file) file.text().then((t) => setF((x) => ({ ...x, privateKey: t })));
    e.currentTarget.value = '';
  };
  const body = () => {
    const secret = (k) => (f[k] ? { [k]: f[k] } : {});
    return {
      label: f.label.trim() || f.id.trim(), host: f.host.trim(), port: Number(f.port) || 22, user: f.user.trim(), auth: f.auth, note: f.note,
      access: f.access, agent: f.agent, holdPatterns: f.holdPatterns.split('\n').map((l) => l.trim()).filter(Boolean), ...secret('sudoPassword'),
      ...(f.auth === 'password' ? secret('password') : { ...secret('privateKey'), ...secret('passphrase') }),
    };
  };
  const id = (h?.id ?? f.id).trim();
  const test = async () => {
    try { setTested({ ok: true, ...(await api('/api/ssh/test', { method: 'POST', body: { ...body(), ...(h && { id: h.id }) } })) }); }
    catch (e) { setTested({ ok: false, error: e.message }); }
  };
  const save = guarded(async () => {
    if (!h && taken.includes(id)) throw new Error(`there already is a host named ${id}`);
    const saved = await api(path(id), { method: 'PUT', body: { ...body(), ...(tested?.ok && { hostKey: tested.hostKey }) } });
    toast(`${saved.label} saved`);
    onSaved(saved.id);
  });
  const access = Object.keys(ACCESS).filter((k) => k !== 'owner' || isOwner.value || h?.access === 'owner');
  const changedKey = tested?.ok && h?.hostKey && tested.hostKey !== h.hostKey;
  return html`<section class="form-card">
    <strong>${h ? 'Login' : 'Add a host'}</strong>
    ${!h && html`<${Field} label="Name" hint="Lowercase letters, digits, - and _. What agents call it (ssh_exec host).">
      <input class="mono" value=${f.id} onInput=${set('id')} placeholder="staging" /><//>`}
    <${Field} label="Label"><input value=${f.label} onInput=${set('label')} placeholder="Staging VM" /><//>
    <div class="ssh-addr">
      <${Field} label="Host"><input class="mono" value=${f.host} onInput=${set('host')} placeholder="10.0.0.12 or vm.example.com" /><//>
      <${Field} label="Port"><input class="mono" inputmode="numeric" value=${f.port} onInput=${set('port')} placeholder="22" /><//>
      <${Field} label="User"><input class="mono" value=${f.user} onInput=${set('user')} placeholder="deploy" /><//>
    </div>
    <${Seg} small label="Login with" value=${f.auth} options=${[['password', 'Password'], ['key', 'Private key']]} onChange=${(v) => setF({ ...f, auth: v })} />
    ${f.auth === 'password' ? html`<${Field} label="Password" hint=${h?.hasPassword ? 'Saved; never shown. Leave empty to keep it.' : ''}>
        <input type="password" class="mono" autocomplete="new-password" value=${f.password} onInput=${set('password')} placeholder=${h?.hasPassword ? '••••••••' : ''} /><//>`
      : html`<div class="field"><span class="field-head">Private key
          <label class="btn ghost sm sql-key-file"><${Icon} name="upload" />Load a key file<input type="file" hidden onChange=${loadKey} /></label></span>
        <textarea class="mono sql-key" rows="4" spellcheck="false" value=${f.privateKey} onInput=${set('privateKey')}
          placeholder=${h?.hasKey ? 'Saved; never shown. Paste another to replace it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'}></textarea>
        <span class="field-hint">The key file's text (id_ed25519, id_rsa, ...), not the .pub one.</span></div>
      <${Field} label="Passphrase" hint=${h?.hasPassphrase ? 'Saved. Leave empty to keep it.' : 'Only if the key has one.'}>
        <input type="password" class="mono" autocomplete="new-password" value=${f.passphrase} onInput=${set('passphrase')} placeholder=${h?.hasPassphrase ? '••••••••' : ''} /><//>`}
    <${Field} label="sudo password" hint=${h?.hasSudoPassword ? 'Saved. Leave empty to keep it.'
      : 'For agents\' sudo: true. Empty: the login password, or (key login) sudo must not ask for one.'}>
      <input type="password" class="mono" autocomplete="new-password" value=${f.sudoPassword} onInput=${set('sudoPassword')} placeholder=${h?.hasSudoPassword ? '••••••••' : ''} /><//>
    <${Field} label="What it is" hint="Told to agents, e.g. what runs there and where it lives. Never put secrets here.">
      <textarea rows="2" value=${f.note} onInput=${set('note')} placeholder="Staging web server; the app is in /opt/app, run by systemd as app.service"></textarea><//>
    <div class="row wrap">
      <${Field} label="Who may use it"><select value=${f.access} onChange=${set('access')}>
        ${access.map((k) => html`<option value=${k}>${ACCESS[k]}</option>`)}</select><//>
      <${Field} label="Agents"><select value=${f.agent} onChange=${set('agent')}>
        ${Object.entries(AGENT).map(([k, l]) => html`<option value=${k}>${l}</option>`)}</select><//>
    </div>
    <span class="dim small">${AGENT_HINT[f.agent]} "Who may use it" counts for the person an agent works for.</span>
    ${f.agent === 'run' && html`<${Field} label="Also hold for approval" hint="Regular expressions, one per line, case-insensitive: a command matching one waits too.">
      <textarea class="mono" rows="2" spellcheck="false" value=${f.holdPatterns} onInput=${set('holdPatterns')} placeholder=${'\\bnginx -s\n/opt/app/data'}></textarea><//>`}
    <span class="small dim">${tested?.ok ? html`Server key <span class="mono">${tested.hostKey}</span>${changedKey ? html` <span class="pill warn">changed</span>` : ''}: trusted once you save.`
      : h?.hostKey ? html`Trusted server key: <span class="mono">${h.hostKey}</span>`
      : 'The server\'s key is trusted once you test the connection and save; until then agents cannot use it.'}</span>
    ${tested && (tested.ok ? html`<p class="small"><${Icon} name="circle-check" /> Logged in${tested.info ? html`: <span class="mono">${tested.info}</span>` : ''}</p>`
      : html`<div class="form-error" role="alert">${tested.error}</div>`)}
    <div class="row wrap">
      <${AsyncButton} class="btn primary sm" onClick=${save}>Save<//>
      <${AsyncButton} class="btn sm" icon="refresh-cw" onClick=${test}>Test connection<//>
      ${onCancel && html`<button class="btn ghost sm" onClick=${onCancel}>Cancel</button>`}
    </div>
  </section>`;
}

/** The newest commands agents ran on a host. */
function HostLog({ id }) {
  const [log, setLog] = useState(null);
  const load = () => api(`${path(id)}/log`).then(setLog).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, [id]);
  return html`<section class="form-card">
    <div class="row" style="justify-content: space-between"><strong>Agent commands</strong>
      <button class="btn ghost sm" onClick=${load}><${Icon} name="refresh-cw" />Refresh</button></div>
    ${log == null ? html`<${Spinner} />` : !log.length ? html`<span class="dim small">None yet.</span>` : html`<div class="ssh-log">
      ${log.map((e, i) => html`<div class="ssh-log-row" key=${i}>
        <code class="mono small ssh-log-cmd">${e.sudo ? 'sudo ' : ''}${e.command}</code>
        <div class="dim small">${ago(e.at)} · ${e.who || 'an agent'} · ${e.ok ? `exit ${e.exitCode ?? 'none (cut off)'} · ${e.ms} ms`
          : html`<span class="note err">${e.error}</span>`}</div>
      </div>`)}</div>`}
  </section>`;
}

/** One saved host: its address, remove, its login and its log. */
function HostDetail({ h, onChange, onRemoved }) {
  const remove = guarded(async () => {
    if (!await confirmDialog({ title: `Remove ${h.label}?`, message: 'Agents lose it at once; its login and log are deleted.', confirmText: 'Remove', danger: true })) return;
    await api(path(h.id), { method: 'DELETE' });
    onRemoved();
  });
  return html`
    <div class="ssh-detail-head">
      <div class="ssh-detail-title"><strong>${h.label}</strong> <span class="mono dim small">${h.id}</span>
        <div class="dim small mono">${h.user}@${h.host}${h.port !== 22 ? `:${h.port}` : ''}</div></div>
      <button class="btn ghost danger sm" onClick=${remove}><${Icon} name="trash-2" />Remove</button>
    </div>
    <${HostForm} key=${h.id} h=${h} onSaved=${onChange} />
    <${HostLog} id=${h.id} />`;
}

const MODE_PILL = { off: ['', 'Off'], approve: ['accent', 'Approval'], run: ['warn', 'Run'] };

/** The SSH hosts page (admins): the hosts on the left, the one picked (or a new one) on the right. */
export function SshHostsView() {
  const [list, setList] = useState(null);
  const [sel, setSel] = useState(null);
  const load = () => api('/api/ssh/hosts').then(setList).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  const shown = list?.find((h) => h.id === sel) ?? (sel === 'add' ? null : list?.[0]);
  const adding = list != null && !shown;
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
      <div class="crumbs"><span class="crumb-title">SSH hosts</span></div>
      ${list?.length > 0 && html`<button class="btn sm" style="margin-left: auto" onClick=${() => setSel('add')}><${Icon} name="plus" />Add host</button>`}
    </header>
    <div class="thread"><div class="page ssh-page">
      <p class="dim">Servers and VMs agents may run shell commands on, through this gateway's MCP (<span class="mono">ssh_list_hosts</span>,${' '}
        <span class="mono">ssh_exec</span>). Dalang keeps the login: agents get a host's name, label and note only, never its
        address, user, password or key, and those are taken out of whatever a command prints. Chats reach them only with${' '}
        <span class="mono">MCP_INJECT=1</span>.</p>
      ${list == null ? html`<div class="pane-loading"><${Spinner} /></div>` : html`<div class=${cx('ssh-layout', !list.length && 'single')}>
        ${list.length > 0 && html`<nav class="ssh-list" aria-label="SSH hosts">
          ${list.map((h) => html`<button key=${h.id} class=${cx('ssh-item', shown?.id === h.id && 'active')} title=${h.label} onClick=${() => setSel(h.id)}>
            <span class="ssh-item-top"><strong>${h.label}</strong><span class=${cx('pill', MODE_PILL[h.agent][0])}>${MODE_PILL[h.agent][1]}</span></span>
            <span class="dim small mono">${h.id}${h.hostKey ? '' : ' · key not trusted'}</span>
          </button>`)}
          <button class=${cx('ssh-item add', adding && 'active')} onClick=${() => setSel('add')}><span class="ssh-item-top"><span><${Icon} name="plus" /> Add host</span></span></button>
        </nav>`}
        <div class="ssh-detail">
          ${shown ? html`<${HostDetail} key=${shown.id} h=${shown} onChange=${load} onRemoved=${async () => { await load(); setSel(null); }} />`
            : html`<${HostForm} key="add" taken=${list.map((h) => h.id)} onSaved=${async (id) => { await load(); setSel(id); }}
                onCancel=${list.length ? () => setSel(null) : null} />`}
        </div>
      </div>`}
    </div></div>
  </main>`;
}

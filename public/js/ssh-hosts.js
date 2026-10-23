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
const LOG_PAGE = 25;
const path = (id) => `/api/ssh/hosts/${encodeURIComponent(id)}`;

/** "3 min ago" for a time in ms. */
const ago = (ms) => {
  const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
  return s < 60 ? 'just now' : s < 3600 ? `${Math.round(s / 60)} min ago` : s < 86400 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} d ago`;
};

/** Add a host, or edit the saved one `h`. An empty secret field keeps the saved secret. */
function HostForm({ h, taken, keys, onSaved, onCancel, onKeys }) {
  const [f, setF] = useState({
    // The saved key it logs in with ('' = a key of its own); a new host starts on the first saved key there is.
    keyId: h ? h.keyId ?? '' : keys[0]?.id ?? '',
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
      ...(f.auth === 'password' ? secret('password') : f.keyId ? { keyId: f.keyId } : { keyId: '', ...secret('privateKey'), ...secret('passphrase') }),
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
      : html`<${Field} label="Key" hint=${html`Saved keys are kept once and picked by many hosts.${' '}
          <a href="#" onClick=${(e) => { e.preventDefault(); onKeys(); }}>Manage keys</a>`}>
        <select value=${f.keyId} onChange=${set('keyId')}>
          ${keys.map((k) => html`<option value=${k.id}>${k.label} (${k.id})</option>`)}
          ${h?.keyId && !keys.some((k) => k.id === h.keyId) && html`<option value=${h.keyId}>${h.keyId} (not visible to you)</option>`}
          <option value="">A key for this host only…</option>
        </select><//>
      ${!f.keyId && html`<div class="field"><span class="field-head">Private key
          <label class="btn ghost sm sql-key-file"><${Icon} name="upload" />Load a key file<input type="file" hidden onChange=${loadKey} /></label></span>
        <textarea class="mono sql-key" rows="4" spellcheck="false" value=${f.privateKey} onInput=${set('privateKey')}
          placeholder=${h?.hasKey && !h.keyId ? 'Saved; never shown. Paste another to replace it.' : '-----BEGIN OPENSSH PRIVATE KEY-----'}></textarea>
        <span class="field-hint">The key file's text (id_ed25519, id_rsa, ...), not the .pub one.</span></div>
      <${Field} label="Passphrase" hint=${h?.hasPassphrase && !h.keyId ? 'Saved. Leave empty to keep it.' : 'Only if the key has one.'}>
        <input type="password" class="mono" autocomplete="new-password" value=${f.passphrase} onInput=${set('passphrase')} placeholder=${h?.hasPassphrase && !h.keyId ? '••••••••' : ''} /><//>`}`}
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
  const [q, setQ] = useState('');
  const [max, setMax] = useState(LOG_PAGE);
  const load = () => api(`${path(id)}/log`).then(setLog).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, [id]);
  const needle = q.trim().toLowerCase();
  const hits = log?.filter((e) => !needle || `${e.command} ${e.who} ${e.error ?? ''}`.toLowerCase().includes(needle)) ?? [];
  return html`<section class="form-card">
    <div class="row wrap" style="justify-content: space-between"><strong>Agent commands${log?.length ? html` <span class="dim small">${log.length}</span>` : ''}</strong>
      <div class="row">
        ${log?.length > LOG_PAGE && html`<input class="ssh-search sm" type="search" value=${q} onInput=${(e) => { setQ(e.currentTarget.value); setMax(LOG_PAGE); }}
          placeholder="Filter commands" aria-label="Filter commands" />`}
        <button class="btn ghost sm" onClick=${load}><${Icon} name="refresh-cw" />Refresh</button></div></div>
    ${log == null ? html`<${Spinner} />` : !log.length ? html`<span class="dim small">None yet.</span>` : !hits.length ? html`<span class="dim small">No command matches.</span>` : html`<div class="ssh-log">
      ${hits.slice(0, max).map((e, i) => html`<div class="ssh-log-row" key=${i}>
        <code class="mono small ssh-log-cmd">${e.sudo ? 'sudo ' : ''}${e.command}</code>
        <div class="dim small">${ago(e.at)} · ${e.who || 'an agent'} · ${e.ok ? `exit ${e.exitCode ?? 'none (cut off)'} · ${e.ms} ms`
          : html`<span class="note err">${e.error}</span>`}</div>
      </div>`)}
      ${hits.length > max && html`<button class="btn ghost sm ssh-more" onClick=${() => setMax(max + LOG_PAGE)}>Show ${Math.min(LOG_PAGE, hits.length - max)} more (${hits.length - max} older)</button>`}</div>`}
  </section>`;
}

/** One saved host: its address, remove, its login and its log. */
function HostDetail({ h, keys, onChange, onRemoved, onKeys }) {
  const [tab, setTab] = useState('login');
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
    <${Seg} label="Show" value=${tab} options=${[['login', 'Login and access', 'key-round'], ['log', 'Agent commands', 'terminal']]} onChange=${setTab} />
    ${tab === 'login' ? html`<${HostForm} key=${h.id} h=${h} keys=${keys} onSaved=${onChange} onKeys=${onKeys} />` : html`<${HostLog} id=${h.id} />`}`;
}

const MODE_PILL = { off: ['', 'Off'], approve: ['accent', 'Approval'], run: ['warn', 'Run'] };

const copy = async (text, what) => {
  try { await navigator.clipboard.writeText(text); toast(what); } catch { toast('copy failed: the browser refused the clipboard', 'err'); }
};

/** Add or edit a saved key: pasted, loaded from a file, or generated here (then its public half goes in authorized_keys). */
function KeyForm({ k, taken, onSaved, onCancel }) {
  const [f, setF] = useState({ id: k?.id ?? '', label: k?.label ?? '', access: k?.access ?? 'admin', source: k ? 'keep' : 'paste', privateKey: '', passphrase: '' });
  const set = (n) => (e) => setF({ ...f, [n]: e.currentTarget.value });
  const loadKey = (e) => {
    const file = e.currentTarget.files?.[0];
    const name = file?.name.toLowerCase().replace(/\.[^.]*$/, '').replace(/[^a-z0-9_-]/g, '-').replace(/^[-_]+/, '').slice(0, 32);
    if (file) file.text().then((t) => setF((x) => ({ ...x, privateKey: t, ...(!x.id && name && { id: name }) })));
    e.currentTarget.value = '';
  };
  const id = (k?.id ?? f.id).trim();
  const save = guarded(async () => {
    if (!k && taken.includes(id)) throw new Error(`there already is a key named ${id}`);
    const secret = f.source === 'generate' ? { generate: true }
      : f.source === 'paste' ? { privateKey: f.privateKey, passphrase: f.passphrase }
      : f.passphrase ? { passphrase: f.passphrase } : {};
    const saved = await api(`/api/ssh/keys/${encodeURIComponent(id)}`, { method: 'PUT', body: { label: f.label.trim() || id, access: f.access, ...secret } });
    toast(f.source === 'generate' ? `${saved.label} made: copy its public key into each server's authorized_keys` : `${saved.label} saved`);
    onSaved(saved.id);
  });
  const access = Object.keys(ACCESS).filter((a) => a !== 'owner' || isOwner.value || k?.access === 'owner');
  const sources = k ? [['keep', 'Keep it'], ['paste', 'Replace it'], ['generate', 'Make a new one']] : [['paste', 'Paste or load'], ['generate', 'Generate (ed25519)']];
  return html`<section class="form-card">
    <strong>${k ? `Edit ${k.label}` : 'Add a key'}</strong>
    ${!k && html`<${Field} label="Name" hint="Lowercase letters, digits, - and _."><input class="mono" value=${f.id} onInput=${set('id')} placeholder="deploy-ed25519" /><//>`}
    <${Field} label="Label"><input value=${f.label} onInput=${set('label')} placeholder="Deploy key (all VMs)" /><//>
    <${Seg} small label="Key" value=${f.source} options=${sources} onChange=${(v) => setF({ ...f, source: v })} />
    ${f.source === 'paste' && html`<div class="field"><span class="field-head">Private key
        <label class="btn ghost sm sql-key-file"><${Icon} name="upload" />Load a key file<input type="file" hidden onChange=${loadKey} /></label></span>
      <textarea class="mono sql-key" rows="4" spellcheck="false" value=${f.privateKey} onInput=${set('privateKey')} placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"></textarea>
      <span class="field-hint">The key file's text (id_ed25519, id_rsa, ...), not the .pub one. Never shown again.</span></div>`}
    ${f.source !== 'generate' && html`<${Field} label="Passphrase" hint=${k?.hasPassphrase && f.source === 'keep' ? 'Saved. Leave empty to keep it.' : 'Only if the key has one.'}>
      <input type="password" class="mono" autocomplete="new-password" value=${f.passphrase} onInput=${set('passphrase')} placeholder=${k?.hasPassphrase && f.source === 'keep' ? '••••••••' : ''} /><//>`}
    ${f.source === 'generate' && html`<span class="small dim">Dalang makes a new ed25519 key${k ? ', replacing this one for every host on it' : ''}. Put its public key
      (shown after saving) in <span class="mono">~/.ssh/authorized_keys</span> on each server.</span>`}
    <${Field} label="Who may see and pick it"><select value=${f.access} onChange=${set('access')}>
      ${access.map((a) => html`<option value=${a}>${ACCESS[a]}</option>`)}</select><//>
    <div class="row wrap">
      <${AsyncButton} class="btn primary sm" onClick=${save}>Save<//>
      ${onCancel && html`<button class="btn ghost sm" onClick=${onCancel}>Cancel</button>`}
    </div>
  </section>`;
}

/** The Keys tab: saved private keys that hosts pick instead of each keeping a copy. */
function KeysPane({ keys, reload, onOpenHost }) {
  const [edit, setEdit] = useState(keys.length ? null : 'add');
  const remove = guarded(async (k) => {
    if (!await confirmDialog({ title: `Remove ${k.label}?`, message: 'Its private key is deleted from Dalang.', confirmText: 'Remove', danger: true })) return;
    await api(`/api/ssh/keys/${encodeURIComponent(k.id)}`, { method: 'DELETE' });
    await reload();
  });
  const done = async () => { await reload(); setEdit(null); };
  return html`<div class="ssh-keys">
    ${edit === 'add' ? html`<${KeyForm} key="add" taken=${keys.map((k) => k.id)} onSaved=${done} onCancel=${keys.length ? () => setEdit(null) : null} />`
      : html`<div><button class="btn sm" onClick=${() => setEdit('add')}><${Icon} name="plus" />Add key</button></div>`}
    ${keys.map((k) => (edit === k.id ? html`<${KeyForm} key=${k.id} k=${k} onSaved=${done} onCancel=${() => setEdit(null)} />` : html`<section class="form-card" key=${k.id}>
      <div class="ssh-detail-head">
        <div class="ssh-detail-title"><strong>${k.label}</strong> <span class="mono dim small">${k.id}</span>
          <div class="dim small mono">${k.fingerprint}${k.hasPassphrase ? ' · passphrase' : ''}${k.access !== 'admin' ? ` · ${ACCESS[k.access]}` : ''}</div></div>
        <div class="row">
          <button class="btn ghost sm" onClick=${() => setEdit(k.id)}>Edit</button>
          <button class="btn ghost danger sm" onClick=${() => remove(k)}><${Icon} name="trash-2" />Remove</button></div>
      </div>
      <div class="ssh-pub"><code class="mono small">${k.publicKey}</code>
        <button class="btn ghost sm" title="Copy for authorized_keys" onClick=${() => copy(k.publicKey, 'Public key copied')}><${Icon} name="copy" />Copy</button></div>
      <div class="dim small">${k.usedBy.length ? html`Used by ${k.usedBy.map((id, i) => html`${i ? ', ' : ''}<a href="#" class="mono" onClick=${(e) => { e.preventDefault(); onOpenHost(id); }}>${id}</a>`)}`
        : 'No host uses it yet.'}</div>
    </section>`))}
  </div>`;
}

/** The SSH hosts page (admins): Hosts (a searchable list on the left, the one picked or a new one on the right) and Keys. */
export function SshHostsView() {
  const [list, setList] = useState(null);
  const [keys, setKeys] = useState(null);
  const [sel, setSel] = useState(null);
  const [tab, setTab] = useState('hosts');
  const [q, setQ] = useState('');
  const load = () => api('/api/ssh/hosts').then(setList).catch((e) => toast(e.message, 'err'));
  const loadKeys = () => api('/api/ssh/keys').then(setKeys).catch((e) => toast(e.message, 'err'));
  const loadAll = () => Promise.all([load(), loadKeys()]);
  useEffect(() => { loadAll(); }, []);
  const shown = list?.find((h) => h.id === sel) ?? (sel === 'add' ? null : list?.[0]);
  const adding = list != null && !shown;
  const add = () => { setTab('hosts'); setSel('add'); };
  const openHost = (id) => { setTab('hosts'); setSel(id); };
  const needle = q.trim().toLowerCase();
  const hits = list?.filter((h) => !needle || `${h.id} ${h.label} ${h.note}`.toLowerCase().includes(needle)) ?? [];
  const ready = list != null && keys != null;
  return html`<main class="main">
    <header class="chat-head">
      <button class="icon-btn sidebar-toggle" aria-label="Show sidebar" onClick=${toggleSidebar}><${Icon} name="panel-left" /></button>
      <div class="crumbs"><span class="crumb-title">SSH hosts</span></div>
      ${ready && html`<div class="row" style="margin-left: auto">
        <${Seg} small label="Show" value=${tab} onChange=${setTab}
          options=${[['hosts', `Hosts${list.length ? ` · ${list.length}` : ''}`, 'terminal'], ['keys', `Keys${keys.length ? ` · ${keys.length}` : ''}`, 'key-round']]} />
        ${tab === 'hosts' && list.length > 0 && html`<button class=${cx('btn sm', adding && 'primary')} onClick=${add}><${Icon} name="plus" />Add host</button>`}</div>`}
    </header>
    <div class="thread"><div class="page ssh-page">
      ${tab === 'hosts' ? html`<p class="dim">Servers and VMs agents may run shell commands on, through this gateway's MCP (<span class="mono">ssh_list_hosts</span>,${' '}
        <span class="mono">ssh_exec</span>). Dalang keeps the login: agents get a host's name, label and note only, never its
        address, user, password or key, and those are taken out of whatever a command prints. Chats reach them only with${' '}
        <span class="mono">MCP_INJECT=1</span>.</p>`
      : html`<p class="dim">Private keys saved once and picked by many hosts (Login with: Private key). Replace one here and every host on it logs in
        with the new one. Agents never see them.</p>`}
      ${!ready ? html`<div class="pane-loading"><${Spinner} /></div>`
      : tab === 'keys' ? html`<${KeysPane} keys=${keys} reload=${loadAll} onOpenHost=${openHost} />`
      : html`<div class=${cx('ssh-layout', !list.length && 'single')}>
        ${list.length > 0 && html`<div class="ssh-side">
          ${(list.length > 5 || q) && html`<label class="ssh-find"><${Icon} name="search" />
            <input type="search" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} placeholder="Find a host" aria-label="Find a host" /></label>`}
          <nav class="ssh-list" aria-label="SSH hosts">
            ${hits.map((h) => html`<button key=${h.id} class=${cx('ssh-item', shown?.id === h.id && 'active')} title=${h.label} onClick=${() => setSel(h.id)}>
              <span class="ssh-item-top"><strong>${h.label}</strong><span class=${cx('pill', MODE_PILL[h.agent][0])}>${MODE_PILL[h.agent][1]}</span></span>
              <span class="dim small mono">${h.id}${h.hostKey ? '' : ' · key not trusted'}</span>
            </button>`)}
            ${!hits.length && html`<span class="dim small ssh-none">No host matches.</span>`}
          </nav></div>`}
        <div class="ssh-detail">
          ${shown ? html`<${HostDetail} key=${shown.id} h=${shown} keys=${keys} onChange=${loadAll} onKeys=${() => setTab('keys')}
              onRemoved=${async () => { await loadAll(); setSel(null); }} />`
            : html`<${HostForm} key="add" taken=${list.map((h) => h.id)} keys=${keys} onKeys=${() => setTab('keys')}
                onSaved=${async (id) => { await loadAll(); setSel(id); }} onCancel=${list.length ? () => setSel(null) : null} />`}
        </div>
      </div>`}
    </div></div>
  </main>`;
}

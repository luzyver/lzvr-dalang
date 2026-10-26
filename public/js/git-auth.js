// Settings → Git (owner): the server's commit identity, SSH keys and gh/glab logins, so pushing and opening Merge
// Requests can be set up without a shell on the VM. One tab per topic, each a list of rows like the commit card's.
import { useEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Empty, Icon, Menu, MenuItem, Seg, Spinner } from './ui.js';
import { guarded, toast } from './store.js';
import { copyText } from './code.js';

const FORGE = {
  github: {
    label: 'GitHub', cli: 'gh', host: 'github.com',
    tokenHint: 'Classic token with repo, read:org and gist (plus admin:public_key to upload SSH keys).',
  },
  gitlab: {
    label: 'GitLab', cli: 'glab', host: 'gitlab.com',
    tokenHint: 'Personal access token with the api scope (covers HTTPS pushes and SSH keys).',
  },
};

const TABS = [['identity', 'Identity', 'user'], ['ssh', 'SSH', 'key-round'], ['github', 'GitHub', 'git-pull-request'], ['gitlab', 'GitLab', 'git-pull-request']];

const base = (p) => p.split(/[\\/]/).pop();
const initials = (name) => {
  const w = name.trim().split(/[\s._-]+/).filter(Boolean).map((x) => [...x][0]);
  return (w.length > 1 ? w[0] + w[w.length - 1] : w[0] || '?').toUpperCase();
};

/** A tab's heading: what it is for, in one line. */
const Lead = ({ children }) => html`<p class="dim small git-lead">${children}</p>`;

/** "✓ name" or "✕ reason" at the end of a row. */
const Verdict = ({ ok, children, title }) => html`<span class=${cx('pill', ok ? 'ok' : 'warn', 'id-verified')} title=${title}>
  <${Icon} name=${ok ? 'circle-check' : 'circle-alert'} class="tiny" />${children}</span>`;

// ---- Identity ----------------------------------------------------------------------------------------------------------

function Identity({ identity, server, onSaved }) {
  const [name, setName] = useState(identity.name);
  const [email, setEmail] = useState(identity.email);
  const dirty = name !== identity.name || email !== identity.email;
  const save = guarded(async () => {
    onSaved(await api('/api/settings/git/identity', { method: 'PUT', body: { name, email } }));
    toast(server ? 'Global author saved' : 'Your author saved');
  });
  return html`
    <${Lead}>${server
      ? html`The author of your commits, for every repository that does not set its own (the Changes tab can).
        Stored as the server's <span class="mono">git config --global user.name / user.email</span>.`
      : html`The author of commits you make, from the Changes tab or through your prompts. A project can get another one
        from its Changes tab. Without one, git refuses to commit for you.`}<//>
    <div class="id-card">
      <div class="id-row">
        <span class=${cx('id-avatar', !identity.name && 'warn')}>${identity.name ? initials(identity.name) : html`<${Icon} name="circle-alert" />`}</span>
        <div class="id-main">
          <div class="id-title">${identity.name || 'No global author'}</div>
          <div class="id-sub"><span class="ellip">${identity.email || 'Commits fail until a name and email are set'}</span></div>
        </div>
      </div>
      <div class="id-form">
        <div class="id-form-fields">
          <label><span>Name</span><input value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="Your Name" /></label>
          <label><span>Email</span><input type="email" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} placeholder="you@example.com" /></label>
        </div>
        <div class="row"><div class="spacer"></div><${AsyncButton} class="btn primary sm" onClick=${save} disabled=${!dirty}>Save<//></div>
      </div>
    </div>`;
}

// ---- SSH ---------------------------------------------------------------------------------------------------------------

function NewKey({ keys, onDone, onCancel }) {
  const [name, setName] = useState(keys.some((k) => k.name === 'id_ed25519') ? 'id_ed25519_' : 'id_ed25519');
  const [comment, setComment] = useState('dalang');
  const create = guarded(async () => {
    const k = await api('/api/settings/git/ssh-keys', { method: 'POST', body: { name: name.trim(), comment } });
    toast(`${k.name} created`);
    await onDone();
  });
  return html`<div class="id-form">
    <div class="id-form-head"><strong>New SSH key</strong><span class="dim">ed25519, no passphrase. One key per account, e.g. id_ed25519_work.</span></div>
    <div class="id-form-fields">
      <label><span>File name</span><input class="mono" value=${name} onInput=${(e) => setName(e.currentTarget.value)} /></label>
      <label><span>Comment</span><input value=${comment} onInput=${(e) => setComment(e.currentTarget.value)} placeholder="dalang@vm" /></label>
    </div>
    <div class="row"><div class="spacer"></div>
      <button class="btn ghost sm" onClick=${onCancel}>Cancel</button>
      <${AsyncButton} class="btn primary sm" onClick=${create} disabled=${!name.trim()}>Create<//></div>
  </div>`;
}

function NewAlias({ keys, onDone, onCancel }) {
  const [alias, setAlias] = useState('');
  const [hostName, setHostName] = useState('github.com');
  const [key, setKey] = useState(keys[keys.length - 1]?.name ?? '');
  const add = guarded(async () => {
    await api('/api/settings/git/ssh-aliases', { method: 'POST', body: { alias: alias.trim(), hostName: hostName.trim(), key } });
    toast(`Alias ${alias.trim()} added`);
    await onDone();
  });
  return html`<div class="id-form">
    <div class="id-form-head"><strong>New alias</strong>
      <span class="dim">A remote <span class="mono">git@${alias.trim() || 'alias'}:owner/repo.git</span> then reaches ${hostName.trim() || 'the host'} with this key.</span></div>
    <div class="id-form-fields three">
      <label><span>Alias</span><input class="mono" value=${alias} onInput=${(e) => setAlias(e.currentTarget.value)} placeholder="github.com-work" /></label>
      <label><span>Real host</span><input class="mono" value=${hostName} onInput=${(e) => setHostName(e.currentTarget.value)} placeholder="github.com" /></label>
      <label><span>Key</span><select value=${key} onChange=${(e) => setKey(e.currentTarget.value)}>${keys.map((k) => html`<option value=${k.name}>${k.name}</option>`)}</select></label>
    </div>
    <div class="row"><div class="spacer"></div>
      <button class="btn ghost sm" onClick=${onCancel}>Cancel</button>
      <${AsyncButton} class="btn primary sm" onClick=${add} disabled=${!alias.trim() || !hostName.trim() || !key}>Add alias<//></div>
  </div>`;
}

/** `ssh -T` against a host or alias, with the answer kept per host so each row shows its own. */
function useSshTests() {
  const [results, setResults] = useState({});
  const test = (host) => guarded(async () => {
    const r = await api('/api/settings/git/ssh-test', { method: 'POST', body: { host } });
    setResults((x) => ({ ...x, [host]: r }));
  });
  return [results, test];
}

const TestResult = ({ r }) => (r.ok ? html`<${Verdict} ok title=${r.output}>${r.account || 'accepted'}<//>`
  : html`<${Verdict} ok=${false} title=${r.output}>refused<//>`);

function Ssh({ keys, aliases, server, onChange }) {
  const [adding, setAdding] = useState(null); // 'key' | 'alias' | null
  const [results, test] = useSshTests();
  const [host, setHost] = useState('github.com');
  const done = async () => { setAdding(null); await onChange(); };
  const removeAlias = (a) => guarded(async () => {
    if (!await confirmDialog({ title: `Remove alias ${a.alias}?`, message: `Its Host block is deleted from ~/.ssh/config. Remotes that use git@${a.alias}: stop working.`, confirmText: 'Remove', danger: true })) return;
    await api(`/api/settings/git/ssh-aliases/${encodeURIComponent(a.alias)}`, { method: 'DELETE' });
    await onChange();
  });
  return html`
    <${Lead}>For remotes like <span class="mono">git@host:owner/repo.git</span>. ${server
      ? html`Keys live in the server's <span class="mono">~/.ssh</span>;`
      : html`These keys and aliases are yours alone: pushes for you never use the server's <span class="mono">~/.ssh</span>.`}
      Add a public key to your account on the GitHub/GitLab tab or by hand.<//>

    <div class="git-group-head"><strong>Keys</strong>
      ${adding !== 'key' && html`<button class="btn ghost sm" onClick=${() => setAdding('key')}><${Icon} name="plus" />New key</button>`}</div>
    <div class="id-card">
      ${!keys.length && adding !== 'key' && html`<div class="id-row"><span class="dim small">No SSH key yet.</span></div>`}
      ${keys.map((k) => html`<div class="id-row" key=${k.name}>
        <span class="id-avatar icon"><${Icon} name="key-round" /></span>
        <div class="id-main">
          <div class="id-title"><span class="ellip mono">${k.name}</span><span class="chip">${k.type.replace(/^ssh-/, '')}</span></div>
          <div class="id-sub"><span class="ellip mono" title=${k.publicKey}>${k.fingerprint || k.comment}</span></div>
        </div>
        <button class="btn ghost sm" title="Copy the public key" onClick=${() => copyText(k.publicKey, 'public key copied')}><${Icon} name="copy" />Copy</button>
      </div>`)}
      ${adding === 'key' && html`<${NewKey} keys=${keys} onDone=${done} onCancel=${() => setAdding(null)} />`}
    </div>

    <div class="git-group-head"><strong>Aliases</strong>
      ${adding !== 'alias' && keys.length > 0 && html`<button class="btn ghost sm" onClick=${() => setAdding('alias')}><${Icon} name="plus" />New alias</button>`}</div>
    <div class="id-card">
      ${!aliases.length && adding !== 'alias' && html`<div class="id-row"><span class="dim small">${keys.length
        ? 'No aliases. Add one per account when several accounts share one forge.' : 'Create a key first.'}</span></div>`}
      ${aliases.map((a) => html`<div class="id-row" key=${a.alias}>
        <span class="id-avatar icon"><${Icon} name="git-branch" /></span>
        <div class="id-main">
          <div class="id-title"><span class="ellip mono">${a.alias}</span>${a.managed && html`<span class="chip accent" title="Added from this panel">Dalang</span>`}</div>
          <div class="id-sub"><span class="ellip mono">${a.hostName || a.alias}${a.port ? `:${a.port}` : ''}</span>
            ${a.identityFile && html`<span class="id-key ellip" title=${a.identityFile}><${Icon} name="key-round" class="tiny" />${base(a.identityFile)}</span>`}</div>
        </div>
        ${results[a.alias] ? html`<${TestResult} r=${results[a.alias]} />`
          : html`<${AsyncButton} class="btn ghost sm" icon="terminal" title="ssh -T through this alias" onClick=${test(a.alias)}>Test<//>`}
        <button class="icon-btn sm danger" aria-label=${`Remove ${a.alias}`} title="Remove" onClick=${removeAlias(a)}><${Icon} name="trash-2" /></button>
      </div>`)}
      ${adding === 'alias' && html`<${NewAlias} keys=${keys} onDone=${done} onCancel=${() => setAdding(null)} />`}
    </div>

    <div class="git-group-head"><strong>Test a host</strong></div>
    <div class="id-card">
      <div class="id-row">
        <input class="mono grow" list="ssh-hosts" value=${host} onInput=${(e) => setHost(e.currentTarget.value)} placeholder="github.com" aria-label="Host to test" />
        <datalist id="ssh-hosts">${['github.com', 'gitlab.com', ...aliases.map((a) => a.alias)].map((h) => html`<option value=${h} />`)}</datalist>
        ${results[host.trim()] && html`<${TestResult} r=${results[host.trim()]} />`}
        <${AsyncButton} class="btn sm" icon="terminal" onClick=${test(host.trim())} disabled=${!host.trim()}>Test<//>
      </div>
      ${results[host.trim()] && html`<pre class="ssh-out">${results[host.trim()].output}</pre>`}
    </div>
    <p class="dim small">Runs <span class="mono">ssh -T git@host</span>; a host seen for the first time is added to known_hosts.</p>`;
}

// ---- GitHub / GitLab ---------------------------------------------------------------------------------------------------

/** GitHub's one-time-code sign-in, polled until gh says it is done. */
function WebLogin({ host, https, onDone }) {
  const [login, setLogin] = useState(null);
  const timer = useRef(0);
  useEffect(() => () => clearInterval(timer.current), []);
  const poll = async (id) => {
    try {
      const s = await api(`/api/settings/git/login-web/${id}`);
      setLogin(s);
      if (s.status !== 'pending') { clearInterval(timer.current); if (s.status === 'success') toast(`Signed in to ${s.host}`); onDone(s.status === 'success'); }
    } catch (e) { clearInterval(timer.current); toast(e.message, 'err'); }
  };
  const start = guarded(async () => {
    const r = await api('/api/settings/git/login-web', { method: 'POST', body: { host: host.trim(), https } });
    clearInterval(timer.current);
    timer.current = setInterval(() => poll(r.id), 1500);
    await poll(r.id);
  });
  const cancel = guarded(async () => { await api(`/api/settings/git/login-web/${login.id}`, { method: 'DELETE' }); await poll(login.id); });
  const pending = login?.status === 'pending';
  if (!pending) {
    return html`<div class="git-alt">
      <${AsyncButton} class="btn sm" icon="external-link" onClick=${start} disabled=${!host.trim()}>Sign in with browser<//>
      <span class="dim small">Approve a one-time code on github.com instead of pasting a token.</span>
      ${login?.status === 'failed' && html`<div class="form-error">Failed: ${login.error || 'unknown error'}</div>`}
    </div>`;
  }
  return html`<div class="login-flow git-alt">
    <div class="row"><${Spinner} /><span class="small">Open the page, enter the code and approve.</span><div class="spacer"></div>
      <button class="btn ghost danger sm" onClick=${cancel}>Cancel</button></div>
    <div class="row wrap">
      ${login.code && html`<code class="login-code">${login.code}</code>
        <button class="btn sm" onClick=${() => copyText(login.code)}><${Icon} name="copy" />Copy code</button>`}
      ${login.url && /^https:\/\//.test(login.url) && html`<a class="btn primary sm" href=${login.url} target="_blank" rel="noopener noreferrer"><${Icon} name="external-link" />Open GitHub</a>`}
    </div>
  </div>`;
}

function SignIn({ forge, onDone, onCancel }) {
  const f = FORGE[forge];
  const [host, setHost] = useState(f.host);
  const [token, setToken] = useState('');
  const [https, setHttps] = useState(true);
  const [apiHttp, setApiHttp] = useState(false);
  const login = guarded(async () => {
    const status = await api('/api/settings/git/login', { method: 'POST', body: { forge, host: host.trim(), token: token.trim(), https, ...(forge === 'gitlab' && { apiHttp }) } });
    toast(`${f.cli} signed in to ${host.trim()}`);
    await onDone(status);
  });
  return html`<div class="id-form">
    <div class="id-form-head"><strong>Sign in to ${f.label}</strong><span class="dim">${f.tokenHint}</span></div>
    <div class="id-form-fields">
      <label><span>Host</span><input class="mono" value=${host} onInput=${(e) => setHost(e.currentTarget.value)} placeholder=${f.host} /></label>
      <label><span>Token</span><input type="password" class="mono" autocomplete="off" value=${token} onInput=${(e) => setToken(e.currentTarget.value)} placeholder="paste the token" /></label>
    </div>
    <label class="check small"><input type="checkbox" checked=${https} onChange=${(e) => setHttps(e.currentTarget.checked)} />Also use this login for git over HTTPS</label>
    ${forge === 'gitlab' && html`<label class="check small" title="For a GitLab that answers on http:// only (port 443 closed): the token then travels unencrypted"><input type="checkbox" checked=${apiHttp} onChange=${(e) => setApiHttp(e.currentTarget.checked)} />This GitLab is served over plain HTTP (no HTTPS)</label>`}
    <div class="row"><div class="spacer"></div>
      ${onCancel && html`<button class="btn ghost sm" onClick=${onCancel}>Cancel</button>`}
      <${AsyncButton} class="btn primary sm" icon="key-round" onClick=${login} disabled=${!token.trim() || !host.trim()}>Sign in with token<//></div>
    ${forge === 'github' && html`<${WebLogin} host=${host} https=${https} onDone=${(ok) => ok && onDone()} />`}
  </div>`;
}

function ForgeTab({ forge, keys, helpers, server, onHelpers }) {
  const f = FORGE[forge];
  const [status, setStatus] = useState(null);
  const [adding, setAdding] = useState(false);
  const load = () => api(`/api/settings/git/forges/${forge}`).then(setStatus).catch((e) => setStatus({ installed: true, accounts: [], output: e.message }));
  useEffect(() => { load(); }, [forge]);
  const httpsOn = (h) => helpers.some((x) => x.scope === `https://${h}` || (x.scope === '*' && x.helper.includes(f.cli)));

  const done = async (s) => { setAdding(false); if (s) setStatus(s); else await load(); await onHelpers(); };
  const logout = (a) => guarded(async () => {
    if (!await confirmDialog({ title: `Sign ${f.cli} out of ${a.host}?`, message: `Merge Requests (and git over HTTPS, if set up) stop working for ${a.host} until it signs in again.`, confirmText: 'Sign out', danger: true })) return;
    setStatus(await api('/api/settings/git/logout', { method: 'POST', body: { forge, host: a.host, user: a.user } }));
    await onHelpers();
  });
  const makeActive = (a) => guarded(async () => {
    setStatus(await api('/api/settings/git/switch', { method: 'POST', body: { host: a.host, user: a.user } }));
    toast(`${a.user} is now the active account on ${a.host}`);
  });
  const setupHttps = (a) => guarded(async () => {
    await api('/api/settings/git/https', { method: 'POST', body: { forge, host: a.host } });
    toast(`git over HTTPS to ${a.host} now signs in with ${f.cli}`);
    await onHelpers();
  });
  const upload = (a, key) => guarded(async () => {
    await api('/api/settings/git/upload-key', { method: 'POST', body: { forge, host: a.host, key, title: 'dalang' } });
    toast(`${key}.pub added to ${a.user} on ${a.host}`);
  });

  const lead = html`<${Lead}>Opens Merge Requests with <span class="mono">${f.cli}</span>, and can sign git in over HTTPS.
    ${server ? ` The login is kept by ${f.cli} itself, not by Dalang.` : ' The login is yours alone: the server\'s and other users\' are never used for you.'}<//>`;
  if (status == null) return html`${lead}<div class="id-card"><div class="id-row"><${Spinner} /><span class="dim small">Asking ${f.cli}…</span></div></div>`;
  if (!status.installed) {
    return html`${lead}<${Empty} icon="circle-alert" title=${`${f.cli} is not installed`}>Install it on the server (see "Merge Requests: gh and glab"
      in docs/guide.md), or point ${forge === 'github' ? 'GH_BIN' : 'GLAB_BIN'} at it, then restart Dalang.<//>`;
  }
  const none = !status.accounts.length;
  return html`${lead}
    <div class="git-group-head"><strong>Accounts</strong>
      ${!none && !adding && html`<button class="btn ghost sm" onClick=${() => setAdding(true)}><${Icon} name="plus" />Add account</button>`}</div>
    <div class="id-card">
      ${status.accounts.map((a) => html`<div class="id-row" key=${`${a.host}/${a.user}`}>
        <span class=${cx('id-avatar', !a.ok && 'warn')}>${initials(a.user)}</span>
        <div class="id-main">
          <div class="id-title"><span class="ellip">${a.user}</span>
            ${httpsOn(a.host) && html`<span class="chip" title="git over HTTPS to this host signs in with this login">HTTPS</span>`}
            ${!a.active && html`<span class="chip" title="Another account on this host is the active one">inactive</span>`}</div>
          <div class="id-sub"><span class="ellip mono">${a.host}</span>${!a.ok && html`<span class="warn">· login broken, sign in again</span>`}</div>
        </div>
        <${Menu} label=${`Actions for ${a.user}`} buttonClass="sm">
          ${forge === 'github' && !a.active && html`<${MenuItem} icon="check" onClick=${makeActive(a)}>Make active<//>`}
          ${!httpsOn(a.host) && html`<${MenuItem} icon="arrow-up" onClick=${setupHttps(a)}>Use for git over HTTPS<//>`}
          ${keys.map((k) => html`<${MenuItem} key=${k.name} icon="key-round" onClick=${upload(a, k.name)}>Add ${k.name} to this account<//>`)}
          <${MenuItem} icon="log-out" danger onClick=${logout(a)}>Sign out<//>
        <//>
      </div>`)}
      ${(none || adding) && html`<${SignIn} forge=${forge} onDone=${done} onCancel=${none ? null : () => setAdding(false)} />`}
    </div>
    ${status.output && html`<details class="login-log"><summary>${f.cli} auth status</summary><pre>${status.output}</pre></details>`}`;
}

export function GitSection() {
  const [s, setS] = useState(null);
  const [tab, setTab] = useState('identity');
  const load = () => api('/api/settings/git').then(setS).catch((e) => toast(e.message, 'err'));
  useEffect(() => { load(); }, []);
  if (s == null) return html`<div class="pane-loading"><${Spinner} /></div>`;
  const server = s.scope === 'server';
  return html`<div class="git-settings">
    <div class=${cx('git-scope', server ? 'server' : 'user')}>
      <${Icon} name=${server ? 'monitor' : 'user'} />
      <span>${server
        ? html`<strong>The server's setup.</strong> Your chats and pushes use it. Other users each set up their own here.`
        : html`<strong>Your own setup.</strong> Your commits, pushes and Merge Requests (and your prompts' agents) use only this, never the server's.`}</span>
    </div>
    <${Seg} label="Git settings" value=${tab} options=${TABS} onChange=${setTab} />
    ${tab === 'identity' && html`<${Identity} identity=${s.identity} server=${server} onSaved=${(identity) => setS({ ...s, identity })} />`}
    ${tab === 'ssh' && html`<${Ssh} keys=${s.keys} aliases=${s.aliases} server=${server} onChange=${load} />`}
    ${(tab === 'github' || tab === 'gitlab') && html`<${ForgeTab} key=${tab} forge=${tab} keys=${s.keys} helpers=${s.helpers} server=${server} onHelpers=${load} />`}
  </div>`;
}

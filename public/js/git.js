// The Changes tab: what git sees in the folder the chat's agent works in. Pick files (or some hunks of a file), read
// their diffs, commit (or amend) and push, undo the last commit, revert, discard, stash, fetch, pull and push, sync with
// the remote or the base branch and settle conflicts, switch or create a branch, browse the history, undo an agent
// turn from its checkpoints, and open, follow and merge a Merge Request for the chat's branch.
import { useEffect, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { AsyncButton, confirmDialog, Empty, Icon, Modal, Seg, Spinner } from './ui.js';
import { guarded, loadProjects, toast } from './store.js';
import { chat, refreshGit } from './chat-view.js';
import { DiffView, diffStats, parseDiff } from './diff.js';
import { copyText } from './code.js';
import { History } from './history.js';
import { plural } from './format.js';
import { ConflictMenu, isConflict, SyncBanners } from './git-sync.js';
import { Stashes } from './git-stash.js';
import { Checkpoints } from './checkpoints.js';
import { PrStatus } from './pr-status.js';

/** How the push after a commit or Merge Request went. */
const pushNote = (p) => (!p ? '' : p.error ? ` · push failed: ${p.error}` : p.pushed ? ` · pushed to ${p.pushed}` : ' · not pushed (no remote)');

const STATUS = (s) => (isConflict({ status: s }) ? ['U', 'conflict'] : s === '??' || s[0] === 'A' ? ['A', 'added'] : s.includes('D') ? ['D', 'deleted']
  : s.includes('R') ? ['R', 'renamed'] : ['M', 'modified']);

/** Files whose hunks can be committed one by one: changed files git already tracks (new, renamed and conflicted ones go whole). */
const hunkable = (f) => f.status !== '??' && f.status[0] !== 'A' && !f.from && !isConflict(f);

const PUSH_KEY = 'dalang.git.pushAfterCommit';

const splitPath = (p) => {
  const i = p.lastIndexOf('/');
  return i === -1 ? ['', p] : [p.slice(0, i + 1), p.slice(i + 1)];
};

const MAX_DIFFS = 50; // more files than this are listed without their diff stats until opened

/** The server's git.diffFingerprint: FNV-1a over the diff's UTF-16 code units, as hex. */
export function diffFingerprint(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) h = Math.imul(h ^ text.charCodeAt(i), 0x01000193);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/**
 * Diffs of the listed files, fetched again whenever git's status is read again (`version`), since a file can change
 * without its status changing (an agent turn, a terminal). A diff already shown stays until the new one arrives, and
 * diffs of files no longer listed are dropped. `load(path)` fetches one on demand.
 */
function useDiffs(id, files, version) {
  const [diffs, setDiffs] = useState({});
  const fetchOne = (path) => {
    setDiffs((d) => (path in d ? d : { ...d, [path]: null }));
    api(`/api/conversations/${id}/git/diff?path=${encodeURIComponent(path)}`)
      .then((r) => setDiffs((d) => ({ ...d, [path]: r.diff })), () => setDiffs((d) => ({ ...d, [path]: '' })));
  };
  useEffect(() => setDiffs({}), [id]);
  useEffect(() => {
    const listed = new Set(files.map((f) => f.path));
    setDiffs((d) => Object.fromEntries(Object.entries(d).filter(([p]) => listed.has(p))));
    // The first ones, and any other already opened.
    const paths = new Set([...files.slice(0, MAX_DIFFS).map((f) => f.path), ...Object.keys(diffs).filter((p) => listed.has(p))]);
    paths.forEach(fetchOne);
  }, [id, version]);
  return [diffs, (path) => { if (!(path in diffs)) fetchOne(path); }];
}

/**
 * Switch the project folder to another branch, or create one from the current HEAD. The box filters the list and is the
 * new branch's name. Remote branches without a local one are listed too: picking one creates it, tracking the remote.
 */
function Branches({ id, current, onClose, onDone }) {
  const [list, setList] = useState(null);
  const [q, setQ] = useState('');
  const [error, setError] = useState('');
  const load = (fetch) => api(`/api/conversations/${id}/git/branches${fetch ? '?fetch=1' : ''}`).then(setList, (e) => setError(e.message));
  useEffect(() => { load(false).then(() => load(true)); }, [id]); // the local list at once, then again after a fetch
  const go = (name, create) => async () => {
    setError('');
    try {
      await api(`/api/conversations/${id}/git/branch`, { method: 'POST', body: { name, ...(create && { create }) } });
      onClose();
      await onDone(create ? `Created and switched to ${name}` : `Switched to ${name}`);
    } catch (e) { setError(e.message); }
  };
  // Local only; the remote keeps its copy. A branch with commits found nowhere else is deleted only after a second ask.
  const remove = (b) => async () => {
    if (!await confirmDialog({ title: `Delete the local branch ${b}?`, message: 'The remote keeps its copy.', confirmText: 'Delete', danger: true })) return;
    setError('');
    const del = (force) => api(`/api/conversations/${id}/git/branch/delete`, { method: 'POST', body: { name: b, ...(force && { force }) } });
    try {
      try { await del(false); } catch (e) {
        if (e.status !== 409) throw e;
        if (!await confirmDialog({ title: `Delete ${b} anyway?`, message: `${e.message}.`, confirmText: 'Delete anyway', danger: true })) return;
        await del(true);
      }
      toast(`Deleted ${b}`);
      await load(false);
    } catch (e) { setError(e.message); }
  };
  const name = q.trim();
  const match = (b) => b.toLowerCase().includes(name.toLowerCase());
  const known = list && [...list.local, ...list.remote].includes(name);
  const item = (b, remote) => html`<div key=${(remote ? 'r:' : 'l:') + b} class="branch-row">
    <button class="palette-item" disabled=${b === current} onClick=${go(b)}>
      <${Icon} name=${b === current ? 'check' : 'git-branch'} /><span class="mono">${b}</span>${remote && html`<span class="dim small">remote</span>`}</button>
    ${!remote && b !== current && html`<button class="icon-btn sm danger" aria-label=${`Delete ${b}`} title="Delete this local branch" onClick=${remove(b)}><${Icon} name="trash-2" /></button>`}
  </div>`;
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Branches</h2><button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <input class="mono" value=${q} onInput=${(e) => setQ(e.currentTarget.value)} autofocus placeholder="Find a branch, or name a new one" />
    ${name && list && !known && html`<${AsyncButton} class="btn primary sm" icon="plus" onClick=${go(name, true)}>Create branch ${name} from ${current || 'HEAD'}<//>`}
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="palette-list branch-list">
      ${!list ? html`<div class="dim small"><${Spinner} /> Loading…</div>` : html`
        ${list.local.filter(match).map((b) => item(b, false))}
        ${list.remote.filter(match).map((b) => item(b, true))}`}
    </div>
    <div class="dim small">Uncommitted changes come along to the other branch; git refuses the switch if they would be overwritten.</div>
  </div>`;
}

/**
 * Rename a worktree chat's own branch, so it reads better than `dalang/<id>` on the remote. A pushed branch moves there
 * too; one with a Merge Request open cannot be renamed.
 */
function RenameBranch({ id, current, onClose, onDone }) {
  const [name, setName] = useState(current || '');
  const [error, setError] = useState('');
  const save = async (e) => {
    e?.preventDefault();
    const n = name.trim();
    if (!n || n === current) return onClose();
    setError('');
    try {
      const r = await api(`/api/conversations/${id}/git/branch/rename`, { method: 'POST', body: { name: n } });
      onClose();
      await onDone(`Renamed to ${n}${r.push ? pushNote(r.push) : ''}`);
    } catch (err) { setError(err.message); }
  };
  return html`<form class="dialog-body" onSubmit=${save}>
    <div class="dialog-head"><h2>Rename branch</h2><button type="button" class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <input class="mono" value=${name} onInput=${(e) => setName(e.currentTarget.value)} autofocus placeholder="feat/my-change" />
    ${error && html`<div class="form-error">${error}</div>`}
    <div class="row"><${AsyncButton} class="btn primary sm" icon="check" onClick=${save}>Rename<//></div>
    <div class="dim small">If the branch is already on the remote, it is pushed under the new name and the old one is deleted there.</div>
  </form>`;
}

/** The chat's branch and where its Merge Request goes: a worktree chat's own branch, or the project folder's feature branch. */
const FORGE_LABEL = { github: 'GitHub', gitlab: 'GitLab' };
const HELPER_LABEL = {
  gh: 'gh login', glab: 'glab login', manager: 'Credential Manager', store: 'stored password', cache: 'cached password', osxkeychain: 'macOS keychain',
};
const base = (p) => p.split(/[\\/]/).pop();
/** One or two letters for the author's avatar: the first of the first and of the last word. */
const initials = (name) => {
  const w = name.trim().split(/\s+/).filter(Boolean).map((x) => [...x][0]);
  return (w.length > 1 ? w[0] + w[w.length - 1] : w[0] || '?').toUpperCase();
};

/**
 * Which identity and credentials this folder's commits, pushes and Merge Requests use. The forge is asked who that
 * is only on "Verify" (ssh -T, gh/glab auth status), since that goes over the network.
 */
function useCredentials(id, branch) {
  const [c, setC] = useState(null);
  useEffect(() => {
    let live = true;
    setC(null);
    api(`/api/conversations/${id}/git/credentials`).then((v) => live && setC(v)).catch(() => live && setC(false));
    return () => { live = false; };
  }, [id, branch]);
  const check = guarded(async () => setC(await api(`/api/conversations/${id}/git/credentials?check=1`)));
  return [c, check, setC];
}

/** A verified account (✓ name) or why it could not be verified, at the end of a credentials row. */
const Verified = ({ ok, children, title }) => html`<span class=${cx('pill', ok ? 'ok' : 'warn', 'id-verified')} title=${title}>
  <${Icon} name=${ok ? 'circle-check' : 'circle-alert'} class="tiny" />${children}</span>`;

/**
 * The author of this repository's commits, set in its own config (`git config --local`) rather than the server's global
 * one. "Use global" drops the repository's own, and the global author applies again.
 */
function RepoAuthor({ id, c, onSaved, onClose }) {
  const local = c.localAuthor || { name: '', email: '' };
  const [name, setName] = useState(local.name || c.author?.name || '');
  const [email, setEmail] = useState(local.email || c.author?.email || '');
  const save = (n, e) => guarded(async () => {
    onSaved(await api(`/api/conversations/${id}/git/identity`, { method: 'PUT', body: { name: n.trim(), email: e.trim() } }));
    toast(n.trim() ? 'Author set for this repository' : 'This repository uses the global author again');
    onClose();
  });
  return html`<div class="id-form">
    <div class="id-form-head"><strong>Author for this repository</strong>
      <span class="dim">Saved in its <span class="mono">.git/config</span> (worktree chats share it). The global author is not changed.</span></div>
    <div class="id-form-fields">
      <label><span>Name</span><input value=${name} onInput=${(e) => setName(e.currentTarget.value)} placeholder="Your Name" /></label>
      <label><span>Email</span><input type="email" value=${email} onInput=${(e) => setEmail(e.currentTarget.value)} placeholder="you@example.com" /></label>
    </div>
    <div class="row">
      ${(local.name || local.email) && html`<${AsyncButton} class="btn ghost sm" icon="undo-2" onClick=${save('', '')}>Use global<//>`}
      <div class="spacer"></div>
      <button class="btn ghost sm" onClick=${onClose}>Cancel</button>
      <${AsyncButton} class="btn primary sm" onClick=${save(name, email)} disabled=${!name.trim() || !email.trim()}>Save<//>
    </div>
  </div>`;
}

/** Who commits and where the push goes, as a small card between the message and the commit button. */
function CommitCredentials({ id, c, onCheck, onSaved }) {
  const [editing, setEditing] = useState(false);
  useEffect(() => setEditing(false), [id]);
  if (!c) return html`<div class="id-card id-loading"><div class="id-row"><${Spinner} /><span class="dim small">Reading git config…</span></div></div>`;
  const a = c.author;
  const push = c.check?.push;
  // HTTPS through the gh/glab login: the forge account is also who pushes.
  const viaCli = c.transport === 'https' && c.forge && c.https.helperKind === c.forge.cli;
  const verifiable = c.transport === 'ssh' || viaCli;

  let via = null;
  if (c.transport === 'ssh') {
    const s = c.ssh;
    const keys = s.sshCommand ? [] : s.keys;
    via = html`<span class="chip">SSH</span>
      <span class="ellip mono" title=${`${s.user || 'git'}@${s.alias}${s.alias !== s.hostName ? ` → ${s.hostName}` : ''}${s.port !== '22' ? `:${s.port}` : ''}`}>${s.alias}${
        !s.alias.includes(s.hostName) ? html`<span class="faint"> → ${s.hostName}</span>` : ''}</span>
      ${s.sshCommand ? html`<span class="id-key ellip" title=${s.sshCommand}><${Icon} name="terminal" class="tiny" />core.sshCommand</span>`
        : keys.length ? html`<span class="id-key ellip" title=${keys.join('\n')}><${Icon} name="key-round" class="tiny" />${keys.map(base).join(', ')}</span>`
          : html`<span class="warn">no SSH key</span>`}`;
  } else if (c.transport === 'https') {
    const h = c.https;
    via = html`${h.scheme === 'http'
      ? html`<span class="chip warn" title="Plain HTTP: the password or token travels unencrypted. Use an https:// remote if the server offers it.">HTTP</span>`
      : html`<span class="chip">HTTPS</span>`}<span class="ellip mono">${h.host}</span>
      ${h.helper ? html`<span class="id-key ellip" title=${h.helper}><${Icon} name="key-round" class="tiny" />${HELPER_LABEL[h.helperKind] || 'credential helper'}${h.username ? ` · ${h.username}` : ''}</span>`
        : html`<span class="warn">no credential helper</span>`}`;
  } else if (c.transport === 'local') via = html`<span class="chip">LOCAL</span><span class="ellip mono">${c.remote.url}</span>`;

  const verified = push ? html`<${Verified} ok=${push.ok} title=${push.output}>${push.ok ? push.account || 'accepted' : 'refused'}<//>`
    : viaCli && c.check ? html`<${Verified} ok=${!!c.check.forgeAccount}>${c.check.forgeAccount || 'not signed in'}<//>` : null;

  return html`<div class="id-card">
    ${editing ? html`<${RepoAuthor} id=${id} c=${c} onSaved=${onSaved} onClose=${() => setEditing(false)} />` : html`<div class="id-row">
      <span class=${cx('id-avatar', !a && 'warn')}>${a ? initials(a.name) : html`<${Icon} name="circle-alert" />`}</span>
      <div class="id-main">
        ${a ? html`<div class="id-title">${a.name}<span class=${cx('chip', a.scope === 'local' && 'accent')} title=${a.scope === 'local' ? 'Set in this repository\'s .git/config' : 'From the server\'s global git config'}>${a.scope === 'local' ? 'This repo' : 'Global'}</span></div>
          <div class="id-sub"><span class="ellip">${a.email}</span></div>`
          : html`<div class="id-title warn">No commit author</div><div class="id-sub"><span class="ellip" title=${c.authorError}>Set one here or in Settings → Git & forges</span></div>`}
      </div>
      <button class="btn ghost sm" title="Use another author for this repository" onClick=${() => setEditing(true)}><${Icon} name="pencil" />${a ? 'Edit' : 'Set'}</button>
    </div>`}
    <div class="id-row">
      <span class="id-avatar icon"><${Icon} name="arrow-up" /></span>
      <div class="id-main">
        ${c.remote ? html`<div class="id-title"><span class="ellip mono" title=${c.remote.url}>${c.remote.branch}</span></div>
          <div class="id-sub">${via}</div>`
          : html`<div class="id-title">No remote</div><div class="id-sub">The commit stays on this server</div>`}
      </div>
      ${verified || (verifiable && html`<${AsyncButton} class="btn ghost sm" icon="shield-check" title="Ask the forge which account this is" onClick=${onCheck}>Verify<//>`)}
    </div>
  </div>`;
}

/** "gh · github.com ✓ luzyver" in the Merge Request card. */
function MrCredentials({ c, onCheck }) {
  if (!c?.remote) return null;
  if (!c.forge) return html`<div class="mr-cred warn small"><${Icon} name="circle-alert" class="tiny" />Cannot tell whether this server is GitHub or GitLab: sign gh or glab in to it under Settings → Git & forges.</div>`;
  const ch = c.check;
  return html`<div class="mr-cred">
    <span class="dim small">Opens with</span><span class="chip cli">${c.forge.cli}</span><span class="mono small ellip">${c.forge.host}</span>
    <div class="spacer"></div>
    ${!ch ? html`<${AsyncButton} class="btn ghost sm" icon="shield-check" title=${`Ask ${c.forge.cli} which account it is signed in as`} onClick=${onCheck}>Verify<//>`
      : ch.forgeInstalled === false ? html`<${Verified} ok=${false}>${c.forge.cli} not installed<//>`
        : html`<${Verified} ok=${!!ch.forgeAccount} title=${ch.forgeAccount ? '' : 'Sign in under Settings → Git & forges'}>${ch.forgeAccount || 'not signed in'}<//>`}
  </div>`;
}

function MergeRequest({ id, s, creds, onCheck, onDone }) {
  const w = s.mr;
  const [mrText, setMrText] = useState('');
  const [description, setDescription] = useState('');
  const generate = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/mr-description`, { method: 'POST' });
    setDescription(r.description);
    setMrText(r.message);
  });
  // Pushes the branch and opens a Merge Request (GitLab) or pull request (GitHub) into its target branch.
  const create = guarded(async () => {
    if (!await confirmDialog({ title: 'Open a Merge Request?', message: `Push ${w.branch} and open a Merge Request into ${w.base}.`, confirmText: 'Push and open' })) return;
    const [title = '', ...rest] = mrText.trim().split('\n');
    const r = await api(`/api/conversations/${id}/git/pull-request`, { method: 'POST', body: { title: title.trim(), body: rest.join('\n').trim() } });
    toast(r.existed ? 'A Merge Request was already open for this branch' : `Merge Request opened${pushNote(r.push)}`);
    await onDone();
  });
  return html`<section class="branch-card">
    <div class="branch-line"><${Icon} name="git-branch" /><code>${w.branch}</code><${Icon} name="chevron-right" class="tiny dim" /><code>${w.base || 'detached HEAD'}</code></div>
    <div class="dim small">${s.worktree ? 'Own worktree' : 'Project folder'} · ${w.ahead ? `${plural(w.ahead, 'commit')} not in ${w.base || 'the project folder'} yet` : 'nothing to propose yet'}</div>
    ${w.pr && html`<a class="mr-link" href=${w.pr} target="_blank" rel="noopener noreferrer"><${Icon} name="git-pull-request" /><span>${w.pr}</span><${Icon} name="external-link" class="tiny" /></a>`}
    ${w.pr && html`<${PrStatus} id=${id} url=${w.pr} onDone=${onDone} />`}
    ${w.ahead > 0 && !w.pr && html`<${MrCredentials} c=${creds} onCheck=${onCheck} />`}
    ${w.ahead > 0 && html`<div class="mr-box">
      <textarea rows="4" value=${mrText} onInput=${(e) => setMrText(e.currentTarget.value)}
        placeholder="Merge Request title on the first line, description below (empty title: the last commit's subject)"></textarea>
      <div class="row">
        ${!w.pr && w.base && html`<${AsyncButton} class="btn primary sm" icon="git-pull-request" onClick=${create}>Create Merge Request<//>`}
        <${AsyncButton} class="btn ghost sm" icon="sparkles" busyText="Generating…" title="Let the agent describe what this branch brings" onClick=${generate}>Generate description<//>
        ${description && html`<button class="btn ghost sm" onClick=${() => copyText(description, 'MR description copied')}><${Icon} name="copy" />Copy Markdown</button>`}
      </div>
    </div>`}
  </section>`;
}

/**
 * One file's diff in a dialog, with the previous / next changed file a click (or ← →) away. `picks`/`onPickHunk`: which
 * hunks go into the commit, for a file whose hunks can be picked.
 */
function DiffDialog({ files, current, diffs, mode, setMode, onPick, onRevert, onClose, picks, onPickHunk }) {
  const i = files.indexOf(current);
  const [letter, word] = STATUS(current.status);
  const d = diffs[current.path];
  const st = d ? diffStats(d) : null;
  const step = (by) => { const f = files[i + by]; if (f) onPick(f.path); };
  const onKeyDown = (e) => {
    if (e.target.closest('input, textarea, select')) return;
    if (e.key === 'ArrowLeft' || e.key === 'k') { e.preventDefault(); step(-1); }
    if (e.key === 'ArrowRight' || e.key === 'j') { e.preventDefault(); step(1); }
  };
  return html`<div class="diff-dialog" tabindex="-1" onKeyDown=${onKeyDown}>
    <div class="diff-dialog-head">
      <span class=${cx('fstat', letter.toLowerCase())} title=${word}>${letter}</span>
      <code class="diff-dialog-path" title=${current.from ? `${current.from} → ${current.path}` : current.path}>${current.from ? `${current.from} → ` : ''}${current.path}</code>
      ${st && html`<span class="diffstat">${st.add > 0 && html`<b class="add">+${st.add}</b>`}${st.del > 0 && html`<b class="del">−${st.del}</b>`}</span>`}
      <div class="spacer"></div>
      <${Seg} small label="Diff layout" value=${mode} onChange=${setMode} options=${[['unified', 'Unified'], ['split', 'Split']]} />
      <div class="diff-nav">
        <button class="icon-btn sm" aria-label="Previous file" title="Previous file (←)" disabled=${i <= 0} onClick=${() => step(-1)}><${Icon} name="chevron-left" /></button>
        <span class="dim small">${i + 1} / ${files.length}</span>
        <button class="icon-btn sm" aria-label="Next file" title="Next file (→)" disabled=${i >= files.length - 1} onClick=${() => step(1)}><${Icon} name="chevron-right" /></button>
      </div>
      <button class="icon-btn sm danger" aria-label="Revert this file" title=${current.status === '??' ? 'Delete this new file' : 'Undo the changes to this file'} onClick=${onRevert}><${Icon} name="undo-2" /></button>
      <button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button>
    </div>
    <div class="diff-dialog-body">
      ${d == null ? html`<div class="pane-loading"><${Spinner} /> Loading diff…</div>` : html`<${DiffView} diff=${d} path=${current.path} mode=${mode} picks=${picks} onPick=${onPickHunk} />`}
    </div>
  </div>`;
}

/** Change the last commit's message (an amend with nothing else in it). One already pushed is force-pushed. */
function EditMessage({ id, head, onClose, onDone }) {
  const [message, setMessage] = useState(head.body ? `${head.subject}\n\n${head.body}` : head.subject);
  const save = guarded(async () => {
    if (head.pushed && !await confirmDialog({
      title: 'It is already on the remote', message: 'The remote branch gets the reworded commit in its place (a force push, refused if someone pushed there since).', confirmText: 'Reword and push', danger: true,
    })) return;
    const r = await api(`/api/conversations/${id}/git/commit`, { method: 'POST', body: { message: message.trim(), amend: true, paths: [], ...(!head.pushed && { push: false }) } });
    onClose();
    await onDone(`Reworded as ${r.commit}${r.push ? pushNote(r.push) : ''}`);
  });
  return html`<div class="dialog-body">
    <div class="dialog-head"><h2>Reword the last commit</h2><button class="icon-btn" aria-label="Close" onClick=${onClose}><${Icon} name="x" /></button></div>
    <textarea class="mono" rows="6" value=${message} onInput=${(e) => setMessage(e.currentTarget.value)} autofocus></textarea>
    <div class="row end"><button class="btn" onClick=${onClose}>Cancel</button>
      <${AsyncButton} class="btn primary" icon="check" disabled=${!message.trim()} onClick=${save}>Save<//></div>
  </div>`;
}

export function ChangesPane({ id }) {
  const s = chat.git.value;
  const files = s?.files || [];
  const [unpicked, setUnpicked] = useState(new Set());
  // path → { picks: Set of hunk indexes, fp: fingerprint of the diff they were picked in }, for files only partly picked
  const [hunks, setHunks] = useState({});
  const [selected, setSelected] = useState(null);
  const [mode, setMode] = useState(innerWidth > 1100 ? 'split' : 'unified');
  const [message, setMessage] = useState('');
  const [amend, setAmend] = useState(false);
  const [pushAfter, setPushAfter] = useState(() => localStorage.getItem(PUSH_KEY) !== '0');
  const [dialog, setDialog] = useState(null); // 'branches' | 'rename' | 'history' | 'stash' | 'checkpoints' | 'reword'
  const [diffs, loadDiff] = useDiffs(id, files, s);
  const [creds, checkCreds, setCreds] = useCredentials(id, s?.branch);

  useEffect(() => { setUnpicked(new Set()); setHunks({}); setSelected(null); setMessage(''); setAmend(false); setDialog(null); }, [id]);
  // Hunk picks are for the diff they were made in: once a file's diff reads differently (or it is gone), its picks go.
  useEffect(() => {
    const stale = Object.keys(hunks).filter((p) => diffs[p] !== null && (diffs[p] === undefined || diffFingerprint(diffs[p]) !== hunks[p].fp));
    if (!stale.length) return;
    setHunks((h) => Object.fromEntries(Object.entries(h).filter(([p]) => !stale.includes(p))));
    toast(`${stale.join(', ')} changed: pick ${stale.length === 1 ? 'its' : 'their'} hunks again`, 'err');
  }, [diffs]);
  // The file whose diff is open in the dialog; it closes by itself when that file is no longer changed.
  const current = files.find((f) => f.path === selected) || null;
  useEffect(() => { if (current) loadDiff(current.path); }, [current?.path]);

  if (!s) return html`<div class="pane-loading"><${Spinner} /> Loading…</div>`;
  if (!s.repo) return html`<${Empty} icon="git-branch" title="Not a git repository">There is nothing to commit or revert in this chat's folder.<//>`;

  const picked = files.filter((f) => !unpicked.has(f.path)).map((f) => f.path);
  const togglePick = (path) => {
    const next = new Set(unpicked);
    if (next.has(path)) next.delete(path); else next.add(path);
    setUnpicked(next);
    if (hunks[path]) { const h = { ...hunks }; delete h[path]; setHunks(h); }
  };
  // The hunks of a file that go in: its own pick when partly picked, else all or none with the file.
  const hunkCount = (path) => (diffs[path] && !diffs[path].includes('\n… diff truncated') ? parseDiff(diffs[path]).length : 0);
  const picksFor = (f) => hunks[f.path]?.picks ?? new Set(unpicked.has(f.path) ? [] : Array.from({ length: hunkCount(f.path) }, (_, i) => i));
  const pickHunk = (f) => (i) => {
    const next = new Set(picksFor(f));
    if (next.has(i)) next.delete(i); else next.add(i);
    const h = { ...hunks };
    const u = new Set(unpicked);
    if (next.size === hunkCount(f.path)) { delete h[f.path]; u.delete(f.path); } // every hunk: the file whole
    else if (!next.size) { delete h[f.path]; u.add(f.path); } // none: the file stays out
    else { h[f.path] = { picks: next, fp: diffFingerprint(diffs[f.path]) }; u.delete(f.path); }
    setHunks(h);
    setUnpicked(u);
  };

  const after = async (done) => { if (done) toast(done); setHunks({}); loadProjects().catch(() => {}); await refreshGit(id); };
  const close = () => setDialog(null);
  // Fast-forward only, so a pull never makes a merge commit (the sync banner offers rebase or merge when it cannot).
  const pull = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/pull`, { method: 'POST' });
    await after(r.commits ? `Pulled ${plural(r.commits, 'commit')} from ${r.from}` : `Already up to date with ${r.from}`);
  });
  // Ask the remote what is new (ahead / behind), then read the folder again. Offline: the folder is still read.
  const refresh = async () => {
    try { await api(`/api/conversations/${id}/git/fetch`, { method: 'POST' }); } catch (e) { toast(e.message, 'err'); }
    await guarded(() => refreshGit(id))();
  };
  const push = guarded(async () => {
    const r = await api(`/api/conversations/${id}/git/push`, { method: 'POST' });
    await after(`Pushed to ${r.push.pushed}`);
  });

  const generate = guarded(async () => {
    if (!picked.length) throw new Error('Pick at least one file');
    const r = await api(`/api/conversations/${id}/git/message`, { method: 'POST', body: picked.length < files.length ? { paths: picked } : {} });
    setMessage(r.message);
  });
  const toggleAmend = (on) => {
    setAmend(on);
    if (on && !message.trim() && s.head) setMessage(s.head.body ? `${s.head.subject}\n\n${s.head.body}` : s.head.subject);
  };
  const togglePush = (on) => { setPushAfter(on); localStorage.setItem(PUSH_KEY, on ? '1' : '0'); };
  const commit = guarded(async () => {
    if (!picked.length && !amend) throw new Error('Pick at least one file');
    if (!message.trim()) throw new Error('Write a commit message');
    if (amend && s.head?.pushed && !await confirmDialog({
      title: 'Amend a pushed commit?', message: 'The last commit is already on the remote: the amended one replaces it there (a force push, refused if someone pushed there since).',
      confirmText: 'Amend and push', danger: true,
    })) return;
    const partly = Object.entries(hunks).filter(([p]) => picked.includes(p));
    const r = await api(`/api/conversations/${id}/git/commit`, {
      method: 'POST',
      body: {
        message: message.trim(), ...(amend && { amend }), ...(!pushAfter && !(amend && s.head?.pushed) && { push: false }),
        ...((picked.length < files.length || partly.length) && { paths: picked }),
        ...(partly.length && {
          hunks: Object.fromEntries(partly.map(([p, h]) => [p, [...h.picks]])),
          hunkDiffs: Object.fromEntries(partly.map(([p, h]) => [p, h.fp])),
        }),
      },
    });
    setMessage('');
    setAmend(false);
    await after(`${amend ? 'Amended as' : 'Committed'} ${r.commit}${r.push ? pushNote(r.push) : ''}`);
  });
  // Take the last commit back; its changes stay, uncommitted. A pushed one is asked about twice, as the remote moves too.
  const undo = guarded(async () => {
    if (!await confirmDialog({ title: 'Undo the last commit?', message: `${s.head.subject}\n\nIts changes stay in the folder, uncommitted.`, confirmText: 'Undo commit' })) return;
    const run = (force) => api(`/api/conversations/${id}/git/undo-commit`, { method: 'POST', body: force ? { force } : {} });
    let r;
    try { r = await run(false); } catch (e) {
      if (e.status !== 409) throw e;
      if (!await confirmDialog({
        title: 'It is already on the remote', message: `${e.message}. The remote branch moves back one commit as well (refused if someone pushed there since).`,
        confirmText: 'Undo here and on the remote', danger: true,
      })) return;
      r = await run(true);
    }
    await after(`Undid "${r.subject}"${r.push ? pushNote(r.push) : ''}`);
  });
  const revert = (f) => guarded(async () => {
    if (!await confirmDialog(f.status === '??'
      ? { title: 'Delete the new file?', message: f.path, confirmText: 'Delete', danger: true }
      : { title: 'Undo every change to this file?', message: f.path, confirmText: 'Undo changes', danger: true })) return;
    await api(`/api/conversations/${id}/git/revert`, { method: 'POST', body: { paths: [f.path] } });
    await after(`Reverted ${f.path}`);
  });
  const discard = guarded(async () => {
    if (!await confirmDialog({ title: 'Discard all changes?', message: 'Every uncommitted change in this folder is thrown away, including new files. Stash them instead to keep them aside.', confirmText: 'Discard', danger: true })) return;
    await api(`/api/conversations/${id}/git/discard`, { method: 'POST' });
    await after('Changes discarded');
  });

  const totals = files.reduce((t, f) => {
    const d = diffs[f.path];
    if (d) { const st = diffStats(d); t.add += st.add; t.del += st.del; }
    return t;
  }, { add: 0, del: 0 });
  const allPicked = picked.length === files.length && !Object.keys(hunks).length;
  const u = s.upstream;
  // Commits to push: ahead of the upstream, or a branch with commits that was never pushed.
  const toPush = !s.operation && s.hasRemote && s.branch && s.head ? (u ? u.ahead : -1) : 0;
  const what = amend ? 'Amend' : allPicked ? 'Commit' : picked.length === files.length ? 'Commit picked' : `Commit ${picked.length}`;

  return html`<div class="changes">
    <div class="head-row">
      <div class="head-branch dim small">
        ${s.worktree
          ? html`<button class="btn ghost sm branch-btn" title="Rename this chat's branch" onClick=${() => setDialog('rename')}>
              <${Icon} name="git-branch" class="tiny" /><span class="mono">${s.branch}</span><${Icon} name="file-pen" class="tiny" /></button>`
          : html`<button class="btn ghost sm branch-btn" title="Switch or create a branch" onClick=${() => setDialog('branches')}>
              <${Icon} name="git-branch" class="tiny" /><span class="mono">${s.branch || 'detached HEAD'}</span><${Icon} name="chevron-down" class="tiny" /></button>`}
        <button class="icon-btn sm" aria-label="History" title="History: the commits of every branch, compare branches" onClick=${() => setDialog('history')}><${Icon} name="history" /></button>
        <button class="icon-btn sm" aria-label="Stashes" title="Stashes: put changes aside, bring them back" onClick=${() => setDialog('stash')}><${Icon} name="archive" /></button>
        <button class="icon-btn sm" aria-label="Agent checkpoints" title="Agent checkpoints: what each turn changed, undo a turn" onClick=${() => setDialog('checkpoints')}><${Icon} name="rotate-ccw" /></button>
      </div>
      <div class="head-actions">
        <${AsyncButton} class="icon-btn sm" icon="refresh-cw" title="Fetch from the remote and refresh" onClick=${refresh} />
        <${AsyncButton} class="icon-btn sm" icon="arrow-down-to-line" title=${u?.behind ? `Pull ${plural(u.behind, 'commit')} from ${u.name} (fast-forward)` : 'Pull: fast-forward this branch from the remote'} onClick=${pull}>
          ${u?.behind > 0 && html`<span class="count">${u.behind}</span>`}<//>
        ${toPush !== 0 && html`<${AsyncButton} class="icon-btn sm" icon="arrow-up-from-line" title=${toPush > 0 ? `Push ${plural(toPush, 'commit')} to ${u.name}` : 'Publish this branch on the remote'} onClick=${push}>
          ${toPush > 0 && html`<span class="count">${toPush}</span>`}<//>`}
      </div>
    </div>
    <div class="head-commit dim small" title=${s.head ? `${s.head.hash} ${s.head.subject}` : ''}>
      ${s.head ? html`<span class="ellip"><span class="mono">${s.head.hash}</span> ${s.head.subject}</span>
        ${!s.operation && s.branch && !s.head.merge && html`<span class="head-commit-actions">
          <button class="icon-btn sm" aria-label="Reword the last commit" title="Reword the last commit" onClick=${() => setDialog('reword')}><${Icon} name="pencil" /></button>
          <${AsyncButton} class="icon-btn sm" icon="undo-2" title="Undo the last commit (its changes stay, uncommitted)" onClick=${undo} />
        </span>`}` : 'No commits yet'}
    </div>
    <${Modal} open=${dialog === 'history'} label="History" class="history-modal" onClose=${close}>
      <${History} id=${id} onClose=${close} onDone=${after} />
    <//>
    <${Modal} open=${dialog === 'branches'} label="Branches" class="dialog" onClose=${close}>
      <${Branches} id=${id} current=${s.branch} onClose=${close} onDone=${after} />
    <//>
    <${Modal} open=${dialog === 'rename'} label="Rename branch" class="dialog" onClose=${close}>
      <${RenameBranch} id=${id} current=${s.branch} onClose=${close} onDone=${after} />
    <//>
    <${Modal} open=${dialog === 'stash'} label="Stashes" class="history-modal" onClose=${close}>
      <${Stashes} id=${id} changes=${files.length} onClose=${close} onDone=${after} />
    <//>
    <${Modal} open=${dialog === 'checkpoints'} label="Agent checkpoints" class="history-modal" onClose=${close}>
      <${Checkpoints} id=${id} onClose=${close} onDone=${after} />
    <//>
    <${Modal} open=${dialog === 'reword'} label="Reword the last commit" class="dialog" onClose=${close}>
      ${s.head && html`<${EditMessage} id=${id} head=${s.head} onClose=${close} onDone=${after} />`}
    <//>
    <${SyncBanners} id=${id} s=${s} after=${after} />
    ${s.mr && html`<${MergeRequest} key=${s.mr.branch} id=${id} s=${s} creds=${creds} onCheck=${checkCreds} onDone=${after} />`}
    ${!files.length ? html`<${Empty} icon="circle-check" title="No uncommitted changes">Everything in this folder is committed.<//>` : html`
      <section class="file-list">
        <div class="file-list-head">
          <label class="check"><input type="checkbox" checked=${picked.length === files.length} indeterminate=${!allPicked && picked.length > 0}
            onChange=${() => { setHunks({}); setUnpicked(picked.length === files.length ? new Set(files.map((f) => f.path)) : new Set()); }} /><span>${plural(files.length, 'file')}</span></label>
          <span class="diffstat">${totals.add > 0 && html`<b class="add">+${totals.add}</b>`}${totals.del > 0 && html`<b class="del">−${totals.del}</b>`}</span>
        </div>
        ${files.map((f) => {
          const [letter, word] = STATUS(f.status);
          const [dir, name] = splitPath(f.path);
          const d = diffs[f.path];
          const st = d ? diffStats(d) : null;
          const part = hunks[f.path];
          return html`<div key=${f.path} class=${cx('file', f.path === current?.path && 'selected')} onClick=${() => setSelected(f.path)}>
            <input type="checkbox" title=${part ? `${plural(part.picks.size, 'hunk')} of ${hunkCount(f.path)} picked (open the diff to change)` : 'Include in the commit'}
              checked=${!unpicked.has(f.path)} indeterminate=${!!part} onClick=${(e) => e.stopPropagation()} onChange=${() => togglePick(f.path)} />
            <span class=${cx('fstat', letter.toLowerCase())} title=${word}>${letter}</span>
            <span class="fpath" title=${f.from ? `${f.from} → ${f.path}` : f.path}><span class="dim">${dir}</span>${name}</span>
            ${st && html`<span class="diffstat">${st.add > 0 && html`<b class="add">+${st.add}</b>`}${st.del > 0 && html`<b class="del">−${st.del}</b>`}</span>`}
            ${isConflict(f) && html`<${ConflictMenu} id=${id} f=${f} after=${after} />`}
          </div>`;
        })}
      </section>
      <${Modal} open=${!!current} label="Diff" class="diff-modal" onClose=${() => setSelected(null)}>
        ${current && html`<${DiffDialog} files=${files} current=${current} diffs=${diffs} mode=${mode} setMode=${setMode}
          onPick=${setSelected} onRevert=${revert(current)} onClose=${() => setSelected(null)}
          picks=${hunkable(current) && hunkCount(current.path) > 1 && !s.operation ? picksFor(current) : undefined} onPickHunk=${pickHunk(current)} />`}
      <//>`}
    ${(files.length > 0 || amend) && !s.operation && html`<section class="commit-box">
      <div class="field-head"><span>Commit message</span>
        <${AsyncButton} class="btn ghost sm" icon="sparkles" busyText="Generating…" title="Let the agent write a message for the selected files" onClick=${generate}>Generate<//></div>
      <textarea rows="2" value=${message} placeholder="feat: …" onInput=${(e) => setMessage(e.currentTarget.value)}></textarea>
      <${CommitCredentials} id=${id} c=${creds} onCheck=${checkCreds} onSaved=${setCreds} />
      <div class="commit-opts">
        ${s.head && !s.head.merge && s.branch && html`<label class="check small" title="Put the picked files into the last commit instead of a new one, with this message">
          <input type="checkbox" checked=${amend} onChange=${(e) => toggleAmend(e.currentTarget.checked)} /><span>Amend last commit</span></label>`}
        ${s.hasRemote && html`<label class="check small" title="Push to the remote right after committing">
          <input type="checkbox" checked=${pushAfter || (amend && s.head?.pushed)} disabled=${amend && s.head?.pushed} onChange=${(e) => togglePush(e.currentTarget.checked)} /><span>Push</span></label>`}
      </div>
      <div class="row">
        <${AsyncButton} class="btn primary" icon="git-commit-horizontal" onClick=${commit} disabled=${!picked.length && !amend}>
          ${what}${s.hasRemote && (pushAfter || (amend && s.head?.pushed)) ? ' & push' : ''}<//>
        <div class="spacer"></div>
        ${files.length > 0 && html`<button class="btn ghost danger sm" onClick=${discard}><${Icon} name="trash-2" />Discard all</button>`}
      </div>
    </section>`}
  </div>`;
}

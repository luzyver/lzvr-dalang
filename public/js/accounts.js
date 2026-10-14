// Codex / Claude Code accounts (admins): the list with usage meters, and adding one by running the CLI's login on the server.
import { h, icon } from './dom.js';
import { api, Unauthorized } from './api.js';

const resetIn = (ts) => {
  const m = Math.max(0, Math.round((ts * 1000 - Date.now()) / 60000));
  return m >= 1440 ? `${Math.floor(m / 1440)}d ${Math.floor((m % 1440) / 60)}h` : m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
};

function limitsTitle(l) {
  return l ? l.windows.map((w) => `${w.label}: ${Math.max(0, 100 - Math.round(w.usedPercent))}% left, resets ${new Date(w.resetsAt * 1000).toLocaleString()}`).join('\n') : '';
}

/** One bar per usage window (the share still left) as last reported by the CLI during a turn. A window past its reset counts as full. */
function limitBars(l) {
  if (!l) return h('div', { class: 'small' }, 'Usage appears after this account runs its first turn.');
  return h('div', { class: 'meters' }, l.windows.map((w) => {
    const over = w.resetsAt * 1000 < Date.now();
    const left = over ? 100 : Math.max(0, 100 - Math.round(w.usedPercent));
    return h('div', { class: 'meter', title: limitsTitle(l) },
      h('span', { class: 'meter-label' }, w.label),
      h('div', { class: 'meter-track' }, h('div', { class: `meter-fill ${left <= 10 ? 'hot' : left <= 30 ? 'warm' : ''}`, style: `width:${left}%` })),
      h('span', { class: 'meter-pct' }, `${left}%`),
      h('span', { class: 'meter-reset small' }, over ? 'reset' : `resets in ${resetIn(w.resetsAt)}`));
  }));
}

/** `backend`: 'codex' or 'claude'. Polling a login stops by itself once the page is left. */
export function accountsPage({ backend = 'codex', guarded, flash, close }) {
  const label = backend === 'claude' ? 'Claude Code' : 'Codex';
  const q = backend === 'claude' ? '?backend=claude' : '';
  const nameIn = h('input', { placeholder: 'account name (a-z, 0-9, - or _)' });
  const list = h('div', { class: 'acctlist' });
  const out = h('pre', { class: 'loginlog' });
  const link = h('div', { class: 'loginlink' });
  const msg = h('div', { class: 'small' });
  let id = null;
  let timer = null;

  const loadList = async () => {
    try {
      const accts = await api(`/api/accounts${q}`);
      list.replaceChildren(...accts.map((a) => h('div', { class: 'acct' }, h('div', { class: 'acct-head' },
        h('label', { class: 'switch', title: 'Use this account for new turns' },
          h('input', { type: 'checkbox', checked: a.enabled, onchange: guarded(async (e) => {
            await api(`/api/accounts/${encodeURIComponent(a.name)}/enabled`, { method: 'PUT', body: { enabled: e.target.checked, backend } });
            loadList();
          }) })),
        h('strong', {}, a.name),
        h('span', { class: 'small' }, !a.enabled ? 'off' : a.loggedIn === false ? 'not logged in' : a.blockedUntil ? 'at limit' : 'ready'),
        h('span', { class: 'spacer' }),
        a.blockedUntil && h('button', { onclick: guarded(async () => { await api('/api/accounts/unblock', { method: 'POST' }); loadList(); }) }, 'Unblock'),
        h('button', { class: 'danger', onclick: guarded(async () => {
          if (!confirm(`Remove account "${a.name}"? Its ${label} login is deleted from this server. Chats and projects stay.`)) return;
          await api(`/api/accounts/${encodeURIComponent(a.name)}${q}`, { method: 'DELETE' });
          flash(`removed ${a.name}`);
          loadList();
        }) }, 'Remove')),
        limitBars(a.limits))));
    } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
  };

  const poll = async () => {
    if (!out.isConnected) { clearInterval(timer); return; } // the page was left
    try {
      const s = await api(`/api/accounts/login/${id}`);
      // Only touch the DOM when something changed, so a selection in the log or the code survives polling.
      if (out.textContent !== s.output) out.textContent = s.output;
      const linkKey = `${s.url || ''}\n${s.code || ''}`;
      if (link.dataset.key !== linkKey) {
        link.dataset.key = linkKey;
        link.replaceChildren();
        if (s.url && /^https:\/\//.test(s.url)) link.append(h('a', { href: s.url, target: '_blank', rel: 'noopener noreferrer' }, 'Open the sign-in page'));
        if (s.code) link.append(' code: ', h('strong', { class: 'logincode' }, s.code), ' ', h('button', { onclick: async () => {
          try { await navigator.clipboard.writeText(s.code); flash('copied'); } catch { getSelection().selectAllChildren(link.querySelector('.logincode')); }
        } }, 'Copy'));
      }
      if (s.status !== 'pending') {
        clearInterval(timer);
        msg.textContent = s.status === 'success' ? `Account "${s.name}" added.` : s.status === 'cancelled' ? 'Cancelled.' : `Failed: ${s.error || 'unknown error'}`;
        startBtn.disabled = false;
        cancelBtn.hidden = true;
        loadList();
      }
    } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
  };
  const startBtn = h('button', { class: 'primary', onclick: guarded(async () => {
    msg.textContent = '';
    const r = await api('/api/accounts/login', { method: 'POST', body: { name: nameIn.value.trim(), backend } });
    id = r.id;
    startBtn.disabled = true;
    cancelBtn.hidden = false;
    clearInterval(timer);
    timer = setInterval(poll, 1500);
    poll();
  }) }, 'Start login');
  const codeIn = h('input', { placeholder: 'code from the sign-in page' });
  const codeRow = backend === 'claude' ? h('div', { class: 'row' }, codeIn, h('button', { onclick: guarded(async () => {
    await api(`/api/accounts/login/${id}/code`, { method: 'POST', body: { code: codeIn.value.trim() } });
    codeIn.value = '';
    poll();
  }) }, 'Send code')) : null;
  const cancelBtn = h('button', { class: 'danger', hidden: true, onclick: guarded(async () => {
    await api(`/api/accounts/login/${id}`, { method: 'DELETE' });
    poll();
  }) }, 'Cancel');

  loadList();
  return h('div', { class: 'page-body' },
    h('strong', {}, `${label} accounts`), list,
    h('strong', {}, 'Add an account'),
    h('div', { class: 'small' }, backend === 'claude'
      ? 'Runs "claude auth login" on the server. A browser window opens on that machine; sign in with the account you want to add (or open the link below). If the page shows a code instead of finishing, paste it here.'
      : 'Runs "codex login --device-auth" on the server. Open the link, enter the code and approve with the account you want to add.'),
    h('div', { class: 'row' }, nameIn, startBtn, cancelBtn, h('button', { class: 'iconbtn', 'aria-label': 'Close', onclick: close }, icon('x'))),
    link, codeRow, out, msg);
}

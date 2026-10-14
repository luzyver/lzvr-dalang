// The command palette (Ctrl/⌘ K): jump to a chat, search what was said in every chat, or run an action.
import { useEffect, useRef, useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api, Unauthorized } from './api.js';
import { Icon, Modal, Spinner } from './ui.js';
import { convs, isAdmin, newChat, openChat, openSettings, openView, projects, route, toggleInspector, ui } from './store.js';
import { theme } from './theme.js';
import { signOut } from './session.js';

/** `text` with every search word wrapped in <mark>, as vnodes. */
function marked(text, terms) {
  const words = terms.filter(Boolean).map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return text;
  return String(text).split(new RegExp(`(${words.join('|')})`, 'gi')).map((part, i) => (i % 2 ? html`<mark>${part}</mark>` : part));
}

function actions() {
  const list = [];
  const r = route.value;
  if (r.view === 'chat') {
    list.push({ id: 'changes', icon: 'git-branch', label: 'Open Changes', run: () => toggleInspector(true, 'changes') });
    list.push({ id: 'sched-chat', icon: 'clock', label: 'Schedule a prompt in this chat', run: () => toggleInspector(true, 'schedules') });
  }
  for (const p of projects.value) {
    list.push({ id: `new-${p.id}`, icon: 'plus', label: `New chat in ${p.name}`, run: () => newChat(p)() });
    list.push({ id: `wt-${p.id}`, icon: 'git-branch', label: `New chat in own worktree: ${p.name}`, run: () => newChat(p, true)() });
  }
  list.push({ id: 'schedules', icon: 'clock', label: 'Scheduled prompts', run: () => openView('schedules') });
  if (isAdmin.value) {
    list.push({ id: 'approvals', icon: 'shield-check', label: 'Approvals', run: () => openView('approvals') });
    list.push({ id: 'add-project', icon: 'folder-plus', label: 'Add project', run: () => { ui.addProject.value = true; } });
    list.push({ id: 'codex', icon: 'key-round', label: 'Settings: Codex accounts', run: () => openSettings('codex') });
    list.push({ id: 'claude', icon: 'key-round', label: 'Settings: Claude Code accounts', run: () => openSettings('claude') });
    list.push({ id: 'defaults', icon: 'sliders-horizontal', label: 'Settings: Model & effort defaults', run: () => openSettings('defaults') });
    list.push({ id: 'users', icon: 'users', label: 'Settings: Users', run: () => openSettings('users') });
  }
  list.push({ id: 'appearance', icon: 'palette', label: 'Settings: Appearance', run: () => openSettings('appearance') });
  list.push({ id: 'theme', icon: theme.value === 'dark' ? 'sun' : 'moon', label: `Switch to ${theme.value === 'dark' ? 'light' : 'dark'} theme`,
    run: () => { theme.value = theme.value === 'dark' ? 'light' : 'dark'; } });
  list.push({ id: 'signout', icon: 'log-out', label: 'Sign out', run: signOut });
  return list;
}

function Palette() {
  const [q, setQ] = useState('');
  const [active, setActive] = useState(0);
  const [hits, setHits] = useState(null); // server matches inside messages, null while none were asked for
  const [searching, setSearching] = useState(false);
  const listRef = useRef(null);
  const query = q.trim().toLowerCase();
  const terms = query.split(/\s+/).filter(Boolean);

  useEffect(() => {
    setActive(0);
    if (query.length < 2) { setHits(null); return undefined; }
    setSearching(true);
    let live = true;
    const t = setTimeout(() => {
      api(`/api/search?q=${encodeURIComponent(query)}`)
        .then((r) => { if (live) setHits(r.filter((x) => x.kind !== 'title')); })
        .catch((e) => { if (live && !(e instanceof Unauthorized)) setHits([]); })
        .finally(() => { if (live) setSearching(false); });
    }, 220);
    return () => { live = false; clearTimeout(t); };
  }, [query]);

  const allChats = projects.value.flatMap((p) => (convs.value.get(p.id) || []).map((c) => ({ p, c })));
  const matches = (s) => terms.every((t) => s.toLowerCase().includes(t));
  const chats = (query ? allChats.filter(({ p, c }) => matches(`${p.name} ${c.title || 'New chat'}`)) : allChats).slice(0, query ? 20 : 8);
  const acts = query ? actions().filter((a) => matches(a.label)) : actions().slice(0, 6);
  const groups = [
    ['Chats', chats.map(({ p, c }) => ({ key: `c${c.id}`, icon: c.worktree ? 'git-branch' : 'message-square', title: c.title || 'New chat', sub: p.name, dot: c.status, run: () => openChat(c.id) }))],
    ['Messages', (hits || []).map((x, i) => ({ key: `h${i}`, icon: x.kind === 'prompt' ? 'user' : 'bot', title: x.title || 'New chat', sub: x.project, snippet: x.text, run: () => openChat(x.conversation_id, x.event_id) }))],
    ['Actions', acts.map((a) => ({ key: a.id, icon: a.icon, title: a.label, run: a.run }))],
  ].filter(([, items]) => items.length);
  const flat = groups.flatMap(([, items]) => items);
  const pick = (it) => { ui.palette.value = false; it.run(); };

  useEffect(() => {
    listRef.current?.querySelector('.palette-item.active')?.scrollIntoView({ block: 'nearest' });
  }, [active]);

  const onKey = (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (flat.length) setActive((a) => (a + (e.key === 'ArrowDown' ? 1 : -1) + flat.length) % flat.length);
    } else if (e.key === 'Enter' && flat[active]) {
      e.preventDefault();
      pick(flat[active]);
    }
  };

  let n = -1;
  return html`<div class="palette-body">
    <div class="palette-input">
      <${Icon} name="search" />
      <input autofocus value=${q} placeholder="Search chats and messages, or type a command…" aria-label="Search" onInput=${(e) => setQ(e.currentTarget.value)} onKeyDown=${onKey} />
      ${searching ? html`<${Spinner} />` : html`<kbd>Esc</kbd>`}
    </div>
    <div class="palette-list" ref=${listRef} role="listbox">
      ${groups.map(([label, items]) => html`<div class="group-label">${label}</div>
        ${items.map((it) => {
          n++;
          const i = n;
          return html`<button key=${it.key} role="option" aria-selected=${i === active} class=${cx('palette-item', i === active && 'active')}
            onMouseMove=${() => { if (i !== active) setActive(i); }} onClick=${() => pick(it)}>
            ${it.dot ? html`<span class=${cx('dot', it.dot)}></span>` : html`<${Icon} name=${it.icon} />`}
            <div class="palette-text"><strong>${marked(it.title, terms)}</strong>
              ${(it.snippet || it.sub) && html`<span class="dim small">${it.sub}${it.snippet && html` · ${marked(it.snippet, terms)}`}</span>`}</div>
            ${i === active && html`<kbd>↵</kbd>`}
          </button>`;
        })}`)}
      ${!flat.length && html`<div class="palette-empty">${searching ? 'Searching…' : 'Nothing found.'}</div>`}
    </div>
  </div>`;
}

export function CommandPalette() {
  useEffect(() => {
    const key = (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'k') { e.preventDefault(); ui.palette.value = !ui.palette.value; }
    };
    document.addEventListener('keydown', key);
    return () => document.removeEventListener('keydown', key);
  }, []);
  return html`<${Modal} open=${ui.palette.value} label="Command palette" class="palette" onClose=${() => { ui.palette.value = false; }}><${Palette} /><//>`;
}

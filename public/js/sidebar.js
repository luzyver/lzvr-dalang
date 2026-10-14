// The sidebar: chat search, every project with its chats, and the Add project page.
import { h, icon } from './dom.js';
import { api, Unauthorized } from './api.js';

function addProjectPage({ close, onCreated }) {
  const nameIn = h('input', { placeholder: 'name' });
  const pathIn = h('input', { placeholder: 'path (absolute or under the root)' });
  const sbSel = h('select', {}, ['workspace-write', 'read-only', 'danger-full-access'].map((v) => h('option', { value: v }, v)));
  const backendSel = h('select', {}, [['codex', 'Codex'], ['claude', 'Claude Code']].map(([v, l]) => h('option', { value: v }, l)));
  const msg = h('div', { class: 'small' });
  const create = async () => {
    try {
      await api('/api/projects', { method: 'POST', body: { name: nameIn.value.trim(), path: pathIn.value.trim(), sandbox: sbSel.value, backend: backendSel.value } });
      close();
      await onCreated();
    } catch (e) { if (!(e instanceof Unauthorized)) msg.textContent = e.message; }
  };
  setTimeout(() => nameIn.focus());
  return h('div', { class: 'page-body' },
    h('strong', {}, 'Add project'),
    h('label', {}, 'Name', nameIn),
    h('label', {}, 'Folder', pathIn),
    h('label', {}, 'Agent (for every chat in this project)', backendSel),
    h('label', {}, 'Sandbox', sbSel),
    h('div', { class: 'row' }, h('button', { class: 'primary', onclick: create }, 'Create'), h('button', { onclick: close }, 'Cancel')),
    msg);
}

/**
 * Draws `state.projects` / `state.convs` (call `draw` after they change). `reload` refetches them, `leaveConv` closes the
 * open chat (it was deleted), `openSearch(query)` shows the search page.
 */
export function sidebar({ state, isAdmin, guarded, reload, openConv, leaveConv, openSearch, openPage, close }) {
  const el = h('aside');
  // Made once, so what is typed survives the sidebar being redrawn.
  const addProjectBtn = h('button', { class: 'add-project', onclick: () => openPage(addProjectPage({ close, onCreated: reload })) }, icon('plus'), 'Add project');
  const searchIn = h('input', { type: 'search', placeholder: 'Search chats', 'aria-label': 'Search chats' });
  searchIn.addEventListener('keydown', (e) => { if (e.key === 'Enter' && searchIn.value.trim()) openSearch(searchIn.value.trim()); });
  const searchBox = h('div', { class: 'side-search' }, searchIn,
    h('button', { class: 'iconbtn', title: 'Search chats', 'aria-label': 'Search', onclick: () => openSearch(searchIn.value.trim()) }, icon('search')));

  // `worktree`: the chat gets its own git branch and folder, so it cannot collide with other chats in the project.
  const newChat = (p, worktree = false) => guarded(async () => {
    const c = await api(`/api/projects/${p.id}/conversations`, { method: 'POST', body: worktree ? { worktree } : {} });
    await reload();
    openConv(c.id);
  });
  const deleteConv = (c) => guarded(async () => {
    if (!confirm(c.worktree
      ? `Delete this chat and its history? Its worktree is removed too: uncommitted changes there are lost. Branch ${c.branch} is deleted here and on the remote if it is merged, otherwise it stays.`
      : 'Delete this chat and its history? The project and its files stay.')) return;
    await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
    if (state.current === c.id) leaveConv();
    await reload();
  });
  const removeProject = (p) => guarded(async () => {
    if (!confirm(`Remove project "${p.name}" and its chats from the panel? Files stay untouched.`)) return;
    await api(`/api/projects/${p.id}`, { method: 'DELETE' });
    if ((state.convs.get(p.id) || []).some((c) => c.id === state.current)) leaveConv(); // else its stream keeps retrying a chat that no longer exists
    await reload();
  });

  function convRow(c) {
    const title = c.title || 'New chat';
    const shortTitle = title.length > 40 ? `${title.slice(0, 39)}…` : title;
    return h('div', { class: 'conv-row' },
      h('button', { class: `conv ${c.id === state.current ? 'active' : ''}`, onclick: () => openConv(c.id) },
        h('span', { class: `dot ${c.status}`, title: c.status }), h('span', { class: 'ct', title }, shortTitle),
        c.worktree && h('span', { class: 'conv-branch', title: `own worktree on ${c.branch}` }, icon('git-branch'))),
      h('button', { class: 'conv-delete', title: `Delete ${title}`, 'aria-label': `Delete chat ${title}`, onclick: deleteConv(c) }, icon('trash-2')));
  }

  function projectBlock(p) {
    const convs = state.convs.get(p.id) || [];
    const collapsed = state.collapsedProjects.has(p.id);
    return h('section', { class: 'proj' },
      h('div', { class: 'projhead' },
        h('button', { class: 'project-toggle', 'aria-expanded': String(!collapsed), onclick: () => {
          if (collapsed) state.collapsedProjects.delete(p.id); else state.collapsedProjects.add(p.id);
          draw();
        } },
          icon(collapsed ? 'chevron-right' : 'chevron-down'),
          icon('folder'),
          h('span', { class: 'pname' }, h('strong', {}, p.name), h('span', { class: `small backend-tag ${p.backend}` }, `${p.backend === 'claude' ? 'Claude Code' : 'Codex'} · ${p.sandbox}`))),
        h('button', { class: 'iconbtn', title: 'New chat', 'aria-label': 'New chat', onclick: newChat(p) }, icon('plus')),
        h('details', { class: 'more' }, h('summary', { 'aria-label': 'Project options' }, icon('ellipsis')),
          h('div', { class: 'pop' },
            h('button', { title: 'A new git branch and folder for this chat only; open a Merge Request for it from Changes', onclick: newChat(p, true) }, 'New chat in own worktree'),
            isAdmin && h('button', { class: 'danger', onclick: removeProject(p) }, 'Remove project')))),
      !collapsed && (convs.length ? h('div', { class: 'project-sessions' }, ...convs.map(convRow)) : h('div', { class: 'small hint' }, 'No chats yet')));
  }

  function draw() {
    const blocks = state.projects.map(projectBlock);
    el.replaceChildren(...[
      h('div', { class: 'explorer-head' }, h('span', {}, 'WORKSPACE'), h('span', { class: 'explorer-caption' }, `${state.projects.length} PROJECT${state.projects.length === 1 ? '' : 'S'}`)),
      searchBox, isAdmin ? addProjectBtn : null, ...blocks,
      !blocks.length ? h('div', { class: 'small empty-projects' }, 'No projects yet') : null].filter(Boolean));
  }

  return { el, draw };
}

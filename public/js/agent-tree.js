// Sub-agents and reviewers: chats an agent (or the automatic review) started under another chat. They stay out of the
// sidebar, which lists only the chats people started; the Agents tab in the inspector shows the whole tree of the open
// chat, from the chat a person started down: each node with what it runs on and where it stands, children foldable.
import { useState } from '../vendor/preact-hooks.js';
import { html, cx } from './lib.js';
import { api } from './api.js';
import { confirmDialog, Icon } from './ui.js';
import { goHome, guarded, loadProjects, openChat } from './store.js';
import { ago, isUnread, waitingIn } from './inbox.js';
import { descendants, family, rootOf } from './chat-family.js';
import { TurnsSection } from './agent-turns.js';

export { descendants, rootOf };

/** Delete a chat after asking (its worktree, if it has one, and its sub-agents go too); from the open one, go home. */
export const removeChat = (c, active) => guarded(async () => {
  const under = descendants(c.id);
  const worktrees = [c, ...under].filter((x) => x.worktree).length;
  const agents = under.length ? ` Its ${under.length === 1 ? 'sub-agent is' : `${under.length} sub-agents are`} deleted with it.` : '';
  if (!await confirmDialog({
    title: 'Delete this chat and its history?',
    message: (c.worktree
      ? `Its worktree is removed too: uncommitted changes there are lost. Branch ${c.branch} is deleted here and on the remote if it is merged, otherwise it stays.`
      : worktrees ? 'Sub-agent worktrees are removed too: uncommitted changes there are lost.' : 'The project and its files stay.') + agents,
    confirmText: 'Delete',
    danger: true,
  })) return;
  await api(`/api/conversations/${c.id}`, { method: 'DELETE' });
  if (active) goHome();
  await loadProjects();
});

const KIND = { reviewer: 'Reviewer' };

/**
 * Where a chat stands, for the label at the end of its row: waiting on a person, running, failed, done (its last turn
 * completed), stopped (cancelled or cut off by a restart), idle (not known yet) or not started.
 */
function stateOf(c) {
  if (waitingIn.value.get(c.id)) return { key: 'waiting', label: 'Needs approval', icon: 'shield-check' };
  if (c.status === 'running') return { key: 'running', label: 'Working', icon: 'loader-circle', spin: true };
  if (c.status === 'failed') return { key: 'failed', label: 'Failed', icon: 'circle-x' };
  if (c.last_turn === 'completed') return { key: 'done', label: 'Done', icon: 'check' };
  if (c.last_turn === 'cancelled' || c.last_turn === 'interrupted') return { key: 'stopped', label: 'Stopped', icon: 'circle-alert' };
  if (c.last_at) return { key: 'idle', label: 'Idle', icon: 'circle-dashed' };
  return { key: 'new', label: 'Not started', icon: 'circle-dashed' };
}

function AgentNode({ c, depth, current, rootProject, folded, toggle }) {
  const { byId, kids } = family.value;
  const children = kids.get(c.id) || [];
  const open = !folded.has(c.id);
  const active = c.id === current;
  const unread = isUnread(c);
  const state = stateOf(c);
  const title = c.title || (c.role === 'reviewer' ? 'Review' : 'New chat');
  const project = byId.get(c.id)?.project;
  const meta = [depth ? KIND[c.role] || 'Sub-agent' : 'Main chat', c.model, c.effort,
    project && project.id !== rootProject ? project.name : '', !open && `${children.length} folded`].filter(Boolean).join(' · ');
  return html`<li class="agent-node" role="treeitem" aria-expanded=${children.length ? open : undefined}>
    <div class=${cx('agent-row', depth === 0 && 'root', active && 'active', unread && 'unread')}>
      ${children.length
        ? html`<button class="agent-fold" aria-label=${open ? `Fold ${title}` : `Unfold ${title}`} onClick=${() => toggle(c.id)}>
            <${Icon} name=${open ? 'chevron-down' : 'chevron-right'} class="tiny" /></button>`
        : html`<span class="agent-fold" aria-hidden="true"><span class=${cx('dot', c.status, state.key === 'waiting' && 'waiting')}></span></span>`}
      <a class="agent-link" href=${`#c=${c.id}`} aria-current=${active ? 'page' : undefined} onClick=${(e) => { e.preventDefault(); openChat(c.id); }}>
        <span class="agent-main">
          <span class="agent-title" title=${title}>${title}</span>
          <span class="agent-meta">${meta}${c.worktree && html` <${Icon} name="git-branch" class="tiny" />`}</span>
        </span>
        <span class=${cx('agent-state', state.key)} title=${unread ? `${state.label}, not read yet` : state.label}>
          <span class="agent-state-label"><${Icon} name=${state.icon} class="tiny" spin=${state.spin} />${state.label}</span>
          ${state.key !== 'running' && c.last_at && html`<span class="agent-when">${ago(c.last_at)}</span>`}
        </span>
      </a>
      ${depth > 0 && html`<button class="icon-btn sm row-action" aria-label=${`Delete chat ${title}`} title="Delete chat"
        onClick=${removeChat(c, active)}><${Icon} name="trash-2" /></button>`}
    </div>
    ${children.length > 0 && open && html`<ul class="agent-kids" role="group">
      ${children.map((k) => html`<${AgentNode} key=${k.id} c=${k} depth=${depth + 1} current=${current} rootProject=${rootProject} folded=${folded} toggle=${toggle} />`)}
    </ul>`}
  </li>`;
}

/** "3 agents" and how many are working, waiting, failed and done, the ones that need a look first. */
function Summary({ agents }) {
  const n = { waiting: 0, running: 0, failed: 0, stopped: 0, done: 0 };
  for (const a of agents) { const k = stateOf(a).key; if (k in n) n[k]++; }
  const parts = [['waiting', 'need approval'], ['running', 'working'], ['failed', 'failed'], ['stopped', 'stopped'], ['done', 'done']].filter(([k]) => n[k]);
  return html`<div class="agents-head">
    <span class="agents-count">${agents.length} agent${agents.length > 1 ? 's' : ''}</span>
    ${parts.map(([k, word]) => html`<span class=${cx('agents-tally', k)}>${n[k]} ${word}</span>`)}
  </div>`;
}

/** The inspector's Agents tab: the open chat's tree, from the chat a person started down, the open one marked; then its turns. */
export function AgentsPane({ id }) {
  const [folded, setFolded] = useState(() => new Set());
  const toggle = (cid) => setFolded((f) => { const next = new Set(f); if (!next.delete(cid)) next.add(cid); return next; });
  const root = rootOf(id);
  if (!root) return html`<p class="agents-note">No agents.</p>`;
  const agents = descendants(root.conv.id);
  return html`<div class="agents">
    ${agents.length
      ? html`<${Summary} agents=${agents} />`
      : html`<p class="agents-note">No sub-agents or reviewers in this chat yet. They show up here when its agent starts one or the automatic review runs.</p>`}
    <ul class="agent-tree" role="tree" aria-label="Agents of this chat">
      <${AgentNode} c=${root.conv} depth=${0} current=${id} rootProject=${root.project.id} folded=${folded} toggle=${toggle} />
    </ul>
    <${TurnsSection} key=${root.conv.id} root=${root.conv} agents=${agents} />
  </div>`;
}

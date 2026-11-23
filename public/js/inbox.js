// Chats across projects by what they need from a person: waiting on an approval, failed, finished with an answer not
// read yet, running, or nothing for a while (archived). The sidebar's lists and the overview on Home read these.
import { computed } from '../vendor/signals.js';
import { approvals, clickupApprovals, dbApprovals, now, route, seen, sshApprovals } from './store.js';
import { descendants, family, isTop } from './chat-family.js';
import { toDate } from './format.js';

/** How long a chat (with its agents) stays idle before it moves to the archive. */
export const ARCHIVE_AFTER = 2 * 24 * 60 * 60 * 1000;

/** When a chat or one of its agents was last active: its last turn, or when it was made before any (SQLite UTC text). */
export const lastActive = (conv, agents = []) => [conv, ...agents]
  .reduce((at, c) => { const t = c.last_at || c.created_at || ''; return t > at ? t : at; }, '');

/**
 * The chats people started, each with its project, the chats under it (`agents`: sub-agents and reviewers, at any
 * depth and in any project; they are not listed on their own) and when any of them was last active, newest first.
 */
export const allChats = computed(() => [...family.value.byId.values()]
  .filter(({ conv }) => isTop(conv))
  .map(({ project, conv }) => { const agents = descendants(conv.id); return { project, conv, agents, at: lastActive(conv, agents) }; })
  .sort((a, b) => b.at.localeCompare(a.at)));

/** A chat that ended a turn since it was last open on this device (not the one in view). */
export const isUnread = (c) => !!c.last_at && c.status !== 'running' && !!seen.value && !(seen.value[c.id] >= c.last_at)
  && !(route.value.view === 'chat' && route.value.id === c.id);

/** chat id -> how many approvals wait in it (messages to it, database writes, SSH commands and ClickUp messages it asked for). */
export const waitingIn = computed(() => {
  const n = new Map();
  const add = (id) => { if (id) n.set(id, (n.get(id) || 0) + 1); };
  for (const a of approvals.value) add(a.to_conv);
  for (const a of dbApprovals.value) add(a.conv);
  for (const a of sshApprovals.value) add(a.conv);
  for (const a of clickupApprovals.value) if (a.status === 'pending') add(a.conv);
  return n;
});

/**
 * Why a chat needs a person, or '' when it does not: 'approval' | 'failed' | 'unread'. An approval one of its agents
 * waits for counts too; their failures and answers go to the chat above them, which reports on them.
 */
export function needs(c, agents = []) {
  if (waitingIn.value.get(c.id) || agents.some((a) => waitingIn.value.get(a.id))) return 'approval';
  if (c.status === 'failed') return 'failed';
  return isUnread(c) ? 'unread' : '';
}
const waitingAll = (x) => [x.conv, ...x.agents].reduce((n, c) => n + (waitingIn.value.get(c.id) || 0), 0);

const ORDER = { approval: 0, failed: 1, unread: 2 };

/**
 * A chat left alone for ARCHIVE_AFTER: neither it nor its agents ran since, and nothing in it waits for an approval.
 * It is not changed or hidden from search, only listed apart; its next turn brings it back.
 */
export function isArchived(x) {
  if ([x.conv, ...x.agents].some((c) => c.status === 'running' || waitingIn.value.get(c.id))) return false;
  const at = toDate(x.at);
  return !!at && now.value - at.getTime() > ARCHIVE_AFTER;
}

/** The chats people started, split into the ones in use and the archived ones, each newest activity first. */
export const chatLists = computed(() => {
  const active = [];
  const archived = [];
  for (const x of allChats.value) (isArchived(x) ? archived : active).push(x);
  return { active, archived };
});

/** The sidebar's and Home's groups of the chats in use: needs you (approvals first), running, and the rest by recent activity. */
export const byStatus = computed(() => {
  const attention = [];
  const running = [];
  const rest = [];
  for (const x of chatLists.value.active) {
    const why = needs(x.conv, x.agents);
    if (why) attention.push({ ...x, why, count: waitingAll(x) });
    else if (x.conv.status === 'running' || x.agents.some((a) => a.status === 'running')) running.push(x);
    else rest.push(x);
  }
  attention.sort((a, b) => ORDER[a.why] - ORDER[b.why]);
  return { attention, running, rest };
});

/** `now`, `5m`, `3h`, `2d`, then the date: how long ago a chat was last active. */
export function ago(value) {
  const d = toDate(value);
  if (!d) return '';
  const m = Math.floor((Date.now() - d.getTime()) / 60000);
  if (m < 1) return 'now';
  if (m < 60) return `${m}m`;
  if (m < 1440) return `${Math.floor(m / 60)}h`;
  if (m < 7 * 1440) return `${Math.floor(m / 1440)}d`;
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export const WHY = {
  approval: { label: 'Waiting for approval', icon: 'shield-check', tone: 'warn' },
  failed: { label: 'Failed', icon: 'circle-x', tone: 'err' },
  unread: { label: 'New answer', icon: 'message-square', tone: 'accent' },
};

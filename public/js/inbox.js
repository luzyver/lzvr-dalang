// Chats across projects by what they need from a person: waiting on an approval, failed, finished with an answer not
// read yet, running, or nothing for a while (archived). The sidebar's lists and the overview on Home read these.
import { computed } from '../vendor/signals.js';
import { approvals, clickupApprovals, dbApprovals, now, route, seen, sshApprovals } from './store.js';
import { descendants, family, isTop } from './chat-family.js';
import { toDate } from './format.js';

/** How long a chat (with its agents) stays idle before it moves to the archive. */
export const ARCHIVE_AFTER = 3 * 60 * 60 * 1000;

/** When a chat or one of its agents was last active: its latest turn or draft edit, falling back to creation (SQLite UTC text). */
export const lastActive = (conv, agents = []) => [conv, ...agents]
  .reduce((at, c) => {
    const turn = c.last_at || c.created_at || '';
    const latest = c.draft_updated_at > turn ? c.draft_updated_at : turn;
    return latest > at ? latest : at;
  }, '');

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
  // The ClickUp approvals endpoint returns all unresolved requests, including interrupted sends.
  for (const a of clickupApprovals.value) add(a.conv);
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

export const canArchive = (conv, agents) =>
  ![conv, ...agents].some((c) => c.status === 'running' || waitingIn.value.get(c.id));

/**
 * New activity in the family brings an archived chat back. Restoring an idle chat restarts its three-hour window.
 */
export function isArchived(x) {
  if (!canArchive(x.conv, x.agents)) return false;
  const restored = [x.conv, ...x.agents].reduce((last, c) => c.restored_at > last ? c.restored_at : last, '');
  const restoredAt = toDate(restored);
  if (restoredAt && now.value - restoredAt.getTime() < ARCHIVE_AFTER) return false;
  if (x.conv.archived_at && x.conv.archived_at >= x.at) return true;
  const at = toDate(restored > x.at ? restored : x.at);
  return !!at && now.value - at.getTime() >= ARCHIVE_AFTER;
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

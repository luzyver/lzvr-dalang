// Chats across projects by what they need from a person: waiting on an approval, failed, finished with an answer not
// read yet, running. The sidebar's "by status" list and the overview on Home read these.
import { computed } from '../vendor/signals.js';
import { approvals, convs, dbApprovals, projects, route, seen, sshApprovals } from './store.js';
import { toDate } from './format.js';

/** Every chat with its project, newest activity first. */
export const allChats = computed(() => projects.value
  .flatMap((project) => (convs.value.get(project.id) || []).map((conv) => ({ project, conv })))
  .sort((a, b) => (b.conv.last_at || '').localeCompare(a.conv.last_at || '')));

/** A chat that ended a turn since it was last open on this device (not the one in view). */
export const isUnread = (c) => !!c.last_at && c.status !== 'running' && !!seen.value && seen.value[c.id] !== c.last_at
  && !(route.value.view === 'chat' && route.value.id === c.id);

/** chat id -> how many approvals wait in it (messages to it, database writes and SSH commands it asked for). */
const waitingIn = computed(() => {
  const n = new Map();
  const add = (id) => { if (id) n.set(id, (n.get(id) || 0) + 1); };
  for (const a of approvals.value) add(a.to_conv);
  for (const a of dbApprovals.value) add(a.conv);
  for (const a of sshApprovals.value) add(a.conv);
  return n;
});

/** Why a chat needs a person, or '' when it does not: 'approval' | 'failed' | 'unread'. */
export function needs(c) {
  if (waitingIn.value.get(c.id)) return 'approval';
  if (c.status === 'failed') return 'failed';
  return isUnread(c) ? 'unread' : '';
}

const ORDER = { approval: 0, failed: 1, unread: 2 };

/** The sidebar's and Home's groups: needs you (approvals first), running, and the rest by recent activity. */
export const byStatus = computed(() => {
  const attention = [];
  const running = [];
  const rest = [];
  for (const x of allChats.value) {
    const why = needs(x.conv);
    if (why) attention.push({ ...x, why, count: waitingIn.value.get(x.conv.id) || 0 });
    else if (x.conv.status === 'running') running.push(x);
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

import type { FastifyInstance } from 'fastify';
import { type ClickUp, ClickUpUncertain, type Destination, MAX_SEND } from './clickup.js';
import type { Dispatcher } from './dispatcher.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

/**
 * ClickUp messages agents ask to send (clickup_send_message). They go out as the owner's ClickUp user, so each one waits
 * for the owner, who sees where it goes (workspace, channel or person, thread) and may change the text before sending.
 */
export interface ClickUpApproval {
  id: number; dest: Destination; content: string; who: string; conv: string | null; at: number;
  status: 'pending' | 'sending' | 'unknown' | 'sent' | 'rejected' | 'failed' | 'dismissed'; decidedAt?: number;
  /** The owner changed the text before sending. */
  edited?: boolean;
  /** What sending gave (or why it failed). */
  outcome?: string;
  messageId?: string | null;
}

const KEY = 'clickup_approvals';
const KEEP = 200;
const unresolved = (a: ClickUpApproval) => ['pending', 'sending', 'unknown'].includes(a.status);

export function readClickUpApprovals(store: Store): ClickUpApproval[] {
  try { return JSON.parse(store.getKv(KEY) ?? '[]'); } catch { return []; }
}
/** Keeps every unresolved one and the last 200 decided. */
function save(store: Store, list: ClickUpApproval[]): void {
  const decided = list.filter((a) => !unresolved(a)).slice(-KEEP);
  store.setKv(KEY, JSON.stringify(list.filter((a) => unresolved(a) || decided.includes(a))));
}
export function createClickUpApproval(store: Store, a: Pick<ClickUpApproval, 'dest' | 'content' | 'who' | 'conv'>): ClickUpApproval {
  const list = readClickUpApprovals(store);
  const next: ClickUpApproval = { ...a, id: Math.max(0, ...list.map((x) => x.id)) + 1, at: Date.now(), status: 'pending' };
  save(store, [...list, next]);
  return next;
}
/** Changes one approval in the list as stored now: others may have come or been decided meanwhile. */
function update(store: Store, id: number, patch: Partial<ClickUpApproval>): void {
  const list = readClickUpApprovals(store);
  const a = list.find((x) => x.id === id);
  if (!a) return;
  Object.assign(a, patch);
  save(store, list);
}
/** A send cut off by a restart may or may not have reached ClickUp. */
function recover(store: Store): void {
  const list = readClickUpApprovals(store);
  for (const a of list) if (a.status === 'sending') {
    a.status = 'unknown';
    a.outcome = 'Sending was interrupted. Check ClickUp before asking again; this message is not sent twice.';
  }
  save(store, list);
}

/** "#dev-team (Acme), in the thread of sari's message …" for chat messages and notifications. */
export function describeDestination(d: Destination): string {
  const where = `${d.to_user ? d.channel : `"${d.channel}"`} (${d.workspace})`;
  if (!d.reply_to) return where;
  return `${where}, in the thread of ${d.thread ? `${d.thread.author}'s message "${d.thread.preview.slice(0, 80)}"` : `message ${d.reply_to}`}`;
}

/**
 * The owner's ClickUp approvals. Other admins see none: the messages would go out as the owner. Approve sends the text
 * (as the owner may have changed it) and tells the chat that asked.
 */
export function clickupApprovalRoutes(app: FastifyInstance, d: { store: Store; dispatcher: Dispatcher; client: () => ClickUp | undefined }): void {
  const { store } = d;
  recover(store);
  const isOwner = (u?: AuthUser) => !!u && u.id === null;
  const requireOwner = async (req: { user?: AuthUser }, reply: { code(n: number): { send(b: unknown): unknown } }) => {
    if (!isOwner(req.user)) return reply.code(403).send({ error: 'owner only' });
  };

  app.get<{ Querystring: { status?: string } }>('/api/clickup/approvals', (req) => (!isOwner(req.user) ? [] : readClickUpApprovals(store)
    .filter((a) => (req.query.status ? a.status === req.query.status : unresolved(a))).reverse()));

  const tellChat = (a: ClickUpApproval, text: string) => {
    if (!a.conv || !store.getConversation(a.conv)) return;
    store.enqueue(a.conv, text, [], '', a.who);
    d.dispatcher.kick(a.conv);
  };
  const quote = (a: ClickUpApproval) => `\n\n${a.content.split('\n').map((l) => `> ${l}`).join('\n')}`;
  const sending = new Set<number>();

  const decide = (verb: 'approve' | 'reject' | 'dismiss') => async (req: { params: { id: string }; body?: unknown }, reply: any) => {
    const a = readClickUpApprovals(store).find((x) => x.id === Number(req.params.id));
    if (!a) return reply.code(404).send({ error: 'not found' });
    if (sending.has(a.id)) return reply.code(409).send({ error: 'already being sent' });
    if (a.status !== (verb === 'dismiss' ? 'unknown' : 'pending')) return reply.code(409).send({ error: `already ${a.status}` });
    const done = (patch: Partial<ClickUpApproval>) => {
      Object.assign(a, { decidedAt: Date.now(), ...patch });
      update(store, a.id, a);
    };
    const where = describeDestination(a.dest);
    if (verb === 'dismiss') {
      done({ status: 'dismissed' });
      tellChat(a, `[ClickUp] The owner closed your interrupted message to ${where}. Whether it reached ClickUp is unknown; it is not sent again.${quote(a)}`);
      return a;
    }
    if (verb === 'reject') {
      done({ status: 'rejected' });
      tellChat(a, `[ClickUp] The owner did not send your message to ${where}. Do not ask again unless you are told to.${quote(a)}`);
      return a;
    }
    const cu = d.client();
    if (!cu) return reply.code(409).send({ error: 'no ClickUp token saved; reject it instead' });
    const asked = (req.body as { content?: unknown } | null | undefined)?.content;
    const content = typeof asked === 'string' && asked.trim() ? asked.trim() : a.content; // the owner's own wording, if changed
    if (content.length > MAX_SEND) return reply.code(400).send({ error: `at most ${MAX_SEND} characters per message` });
    const edited = content !== a.content;
    done({ status: 'sending', content, ...(edited && { edited: true }) }); // persisted before the message goes out
    sending.add(a.id);
    try {
      const r = await cu.deliver(a.dest, content);
      done({ status: 'sent', messageId: r.id, outcome: `Sent ${r.date} ${r.time}` });
      tellChat(a, `[ClickUp] The owner approved your message to ${where}${edited ? ' (with the text changed as below)' : ''} and it was sent at ${r.date} ${r.time} (message ${r.id ?? 'id unknown'}).${quote(a)}`);
    } catch (e) {
      const msg = (e as Error).message;
      // Failing before the message went out, or ClickUp refusing it, means nothing was posted; a 5xx or timeout does not say.
      const unsure = e instanceof ClickUpUncertain;
      done({ status: unsure ? 'unknown' : 'failed', outcome: msg });
      tellChat(a, `[ClickUp] The owner approved your message to ${where}, but ${unsure ? 'whether it was sent is unknown; do not ask again, check ClickUp first' : 'it could not be sent'}: ${msg}${quote(a)}`);
    } finally {
      sending.delete(a.id);
    }
    return a;
  };
  app.post<{ Params: { id: string } }>('/api/clickup/approvals/:id/approve', { onRequest: requireOwner }, decide('approve'));
  app.post<{ Params: { id: string } }>('/api/clickup/approvals/:id/reject', { onRequest: requireOwner }, decide('reject'));
  app.post<{ Params: { id: string } }>('/api/clickup/approvals/:id/dismiss', { onRequest: requireOwner }, decide('dismiss'));
}

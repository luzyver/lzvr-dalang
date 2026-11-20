import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { type ClickUp, ClickUpUncertain, type Destination, MAX_SEND, type OutFile, type TaskRef } from './clickup.js';
import { type ClickUpAction, ClickUpWork } from './clickup-work.js';
import type { Dispatcher } from './dispatcher.js';
import { clickupUserKey } from './clickup-routes.js';
import type { Store } from './store.js';
import type { AuthUser } from './util.js';

/**
 * ClickUp messages agents ask to send (clickup_send_message) and changes they ask to make (a task, a comment, time, a
 * Doc: `action`). Each goes out as the ClickUp user of the person whose turn asked (`user`, their user key), so it
 * waits for that person, who sees where a message goes (workspace, channel or person, thread) and may change its text
 * before sending, or what a change does.
 */
export interface ClickUpApproval {
  id: number;
  /** Whose ClickUp it is sent as, and who alone sees and decides it. Absent on ones from before: the owner's. */
  user?: string;
  /** A message's destination; absent on a change. */
  dest?: Destination;
  /** A change instead of a message: `content` is then what it does, in words. */
  action?: ClickUpAction;
  clickupUserId?: string;
  content: string; who: string; conv: string | null; at: number;
  status: 'pending' | 'sending' | 'unknown' | 'sent' | 'rejected' | 'failed' | 'dismissed'; decidedAt?: number;
  /** The person changed the text before sending. */
  edited?: boolean;
  /** What sending gave (or why it failed). */
  outcome?: string;
  messageId?: string | null;
  /**
   * Files sent with it, copied when asked (see `filesDir`). A message's go into the message itself; a change's are
   * uploaded to `task` and named at the end of its comment.
   */
  files?: { name: string; size: number }[];
  task?: TaskRef;
}

/** Where an approval's files wait: what the person approves is what goes, even if the agent changes them meanwhile. */
const filesDir = (stateDir: string, id: number) => join(stateDir, 'clickup-files', String(id));
const dropFiles = (stateDir: string, id: number) => rmSync(filesDir(stateDir, id), { recursive: true, force: true });

const KEY = 'clickup_approvals';
/** The last id given out. */
const SEQ = 'clickup_approvals_seq';
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
export function createClickUpApproval(store: Store, a: Pick<ClickUpApproval, 'user' | 'clickupUserId' | 'dest' | 'action' | 'content' | 'who' | 'conv'> & {
  files?: OutFile[]; task?: TaskRef; stateDir?: string;
}): ClickUpApproval {
  const { files = [], task, stateDir, ...rest } = a;
  const list = readClickUpApprovals(store);
  // Never an id again, even after the highest one was removed with its user: a send still running ends on its own id.
  const id = Math.max(Number(store.getKv(SEQ)) || 0, ...list.map((x) => x.id)) + 1;
  store.setKv(SEQ, String(id));
  const next: ClickUpApproval = { ...rest, id, at: Date.now(), status: 'pending' };
  if (files.length) {
    if (!stateDir) throw new Error('files need a place to wait');
    const dir = filesDir(stateDir, next.id);
    rmSync(dir, { recursive: true, force: true }); // left by an approval of the same id from before a reset
    mkdirSync(dir, { recursive: true });
    files.forEach((f, i) => writeFileSync(join(dir, String(i)), f.data)); // by place: names may differ only in case
    Object.assign(next, { files: files.map((f) => ({ name: f.name, size: f.data.length })), ...(task && { task }) });
  }
  save(store, [...list, next]);
  return next;
}
/**
 * Changes one approval in the list as stored now: others may have come or been decided meanwhile. False when it is no
 * longer there (its user was removed while it was being sent).
 */
function update(store: Store, a: ClickUpApproval): boolean {
  const list = readClickUpApprovals(store);
  const at = list.findIndex((x) => x.id === a.id && x.at === a.at);
  if (at < 0) return false;
  list[at] = a;
  save(store, list);
  return true;
}
/** A user who is gone: nobody else may decide their requests, so they go too, with their files. */
export function forgetClickUpApprovals(store: Store, stateDir: string, userKey: string): void {
  const list = readClickUpApprovals(store);
  const theirs = list.filter((a) => a.user === userKey);
  if (!theirs.length) return;
  for (const a of theirs) dropFiles(stateDir, a.id);
  save(store, list.filter((a) => a.user !== userKey));
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
 * Each person's own ClickUp approvals. Nobody else sees or decides them, admins and the owner included: the messages
 * go out as that person. Approve sends the text (as they may have changed it) and tells the chat that asked.
 */
export function clickupApprovalRoutes(app: FastifyInstance, d: { store: Store; stateDir: string; dispatcher: Dispatcher; client: (userKey: string) => ClickUp | undefined }): void {
  const { store } = d;
  recover(store);
  const userOf = (a: ClickUpApproval) => a.user ?? 'owner';
  const mine = (a: ClickUpApproval, u?: AuthUser) => !!u && userOf(a) === clickupUserKey(u);

  app.get<{ Querystring: { status?: string } }>('/api/clickup/approvals', (req) => readClickUpApprovals(store)
    .filter((a) => mine(a, req.user) && (req.query.status ? a.status === req.query.status : unresolved(a))).reverse());

  const tellChat = (a: ClickUpApproval, text: string) => {
    if (!a.conv || !store.getConversation(a.conv)) return;
    store.enqueue(a.conv, text, [], '', a.who);
    d.dispatcher.kick(a.conv);
  };
  const quote = (a: ClickUpApproval) => `\n\n${a.content.split('\n').map((l) => `> ${l}`).join('\n')}`;
  const sending = new Set<number>();

  const decide = (verb: 'approve' | 'reject' | 'dismiss') => async (req: { params: { id: string }; body?: unknown; user?: AuthUser }, reply: any) => {
    const a = readClickUpApprovals(store).find((x) => x.id === Number(req.params.id) && mine(x, req.user)); // another person's is not there
    if (!a) return reply.code(404).send({ error: 'not found' });
    if (sending.has(a.id)) return reply.code(409).send({ error: 'already being sent' });
    if (a.status !== (verb === 'dismiss' ? 'unknown' : 'pending')) return reply.code(409).send({ error: `already ${a.status}` });
    const done = (patch: Partial<ClickUpApproval>) => {
      Object.assign(a, { decidedAt: Date.now(), ...patch });
      if (!update(store, a)) return; // gone with its user, files and all
      if (unresolved(a)) return;
      dropFiles(d.stateDir, a.id); // decided for good: its files are not sent again
      if (a.action) { // nor is its change made again: only its words stay, cut short (a Doc page may be long)
        const slim = { ...a.action, calls: [], details: a.action.details.map((x) => ({ ...x, value: x.value.slice(0, 2000) })) };
        if (update(store, { ...a, action: slim })) a.action = slim;
      }
    };
    const where = a.dest ? describeDestination(a.dest) : '';
    if (verb === 'dismiss') {
      done({ status: 'dismissed' });
      tellChat(a, a.action
        ? `[ClickUp] The person closed your interrupted change (${a.action.title}). Whether ClickUp made it is unknown; it is not made again.${quote(a)}`
        : `[ClickUp] The person closed your interrupted message to ${where}. Whether it reached ClickUp is unknown; it is not sent again.${quote(a)}`);
      return a;
    }
    if (verb === 'reject') {
      done({ status: 'rejected' });
      tellChat(a, a.action
        ? `[ClickUp] The person did not approve your change (${a.action.title}), so nothing was changed. Do not ask again unless you are told to.${quote(a)}`
        : `[ClickUp] The person did not send your message to ${where}. Do not ask again unless you are told to.${quote(a)}`);
      return a;
    }
    if (!a.clickupUserId) {
      return reply.code(409).send({ error: 'This request predates API-key routing. Reject it and ask again with the current ClickUp connection.' });
    }
    const cu = d.client(userOf(a));
    if (!cu) return reply.code(409).send({ error: 'ClickUp is not connected (Settings → MCP → ClickUp); connect it, or reject this' });
    if (a.dest && a.files?.length && !cu.hasMcp) return reply.code(409).send({ error: 'ClickUp MCP is not connected. Reconnect to send these files.' });
    let files: OutFile[];
    try {
      files = (a.files ?? []).map((f, i) => ({ name: f.name, data: readFileSync(join(filesDir(d.stateDir, a.id), String(i))) }));
    } catch {
      return reply.code(409).send({ error: 'its files are gone from the server; reject it instead' });
    }
    if (files.length && !a.action && a.task) {
      return reply.code(409).send({ error: 'this message was asked for with its files on a task, which is no longer done; reject it and ask again' });
    }
    if (a.action) {
      done({ status: 'sending' }); // persisted before the change is made
      sending.add(a.id);
      try {
        if ((await cu.user()).id !== a.clickupUserId) throw new Error('The ClickUp account changed since this approval was requested');
        const r = await new ClickUpWork(cu).perform(a.action, files, a.task);
        done({ status: 'sent', messageId: r.id, outcome: `Done ${r.date} ${r.time}${r.url ? `: ${r.url}` : ''}` });
        tellChat(a, `[ClickUp] The person approved your change (${a.action.title}) and it was made at ${r.date} ${r.time}${r.id ? ` (id ${r.id})` : ''}${r.url ? `: ${r.url}` : ''}${files.length ? `, with ${files.length} file(s) attached to task "${a.task!.name}"` : ''}.`);
      } catch (e) {
        const msg = (e as Error).message;
        const unsure = e instanceof ClickUpUncertain;
        done({ status: unsure ? 'unknown' : 'failed', outcome: msg });
        tellChat(a, `[ClickUp] The person approved your change (${a.action.title}), but ${unsure ? 'whether it was made is unknown; do not ask again, check ClickUp first' : 'it could not be made'}: ${msg}`);
      } finally {
        sending.delete(a.id);
      }
      return a;
    }
    if (!a.dest) return reply.code(409).send({ error: 'nothing to send; reject it instead' });
    const asked = (req.body as { content?: unknown } | null | undefined)?.content;
    const content = typeof asked === 'string' && asked.trim() ? asked.trim() : a.content; // the person's own wording, if changed
    if (content.length > MAX_SEND) return reply.code(400).send({ error: `at most ${MAX_SEND} characters per message` });
    const edited = content !== a.content;
    done({ status: 'sending', content, ...(edited && { edited: true }) }); // persisted before the message goes out
    sending.add(a.id);
    try {
      if ((await cu.user()).id !== a.clickupUserId) throw new Error('The ClickUp account changed since this approval was requested');
      const r = await cu.deliver(a.dest, content, files);
      done({ status: 'sent', messageId: r.id, outcome: `Sent ${r.date} ${r.time}` });
      tellChat(a, `[ClickUp] The person approved your message to ${where}${edited ? ' (with the text changed as below)' : ''} and it was sent at ${r.date} ${r.time} (message ${r.id ?? 'id unknown'})${files.length ? `, with ${files.length} file(s) in the message itself` : ''}.${quote(a)}`);
    } catch (e) {
      const msg = (e as Error).message;
      // Failing before the message went out, or ClickUp refusing it, means nothing was posted; a 5xx or timeout does not say.
      const unsure = e instanceof ClickUpUncertain;
      done({ status: unsure ? 'unknown' : 'failed', outcome: msg });
      tellChat(a, `[ClickUp] The person approved your message to ${where}, but ${unsure ? 'whether it was sent is unknown; do not ask again, check ClickUp first' : 'it could not be sent'}: ${msg}${quote(a)}`);
    } finally {
      sending.delete(a.id);
    }
    return a;
  };
  app.post<{ Params: { id: string } }>('/api/clickup/approvals/:id/approve', decide('approve'));
  app.post<{ Params: { id: string } }>('/api/clickup/approvals/:id/reject', decide('reject'));
  app.post<{ Params: { id: string } }>('/api/clickup/approvals/:id/dismiss', decide('dismiss'));
}

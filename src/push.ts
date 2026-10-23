import webpush from 'web-push';
import { loadConnections } from './databases.js';
import { loadHosts } from './ssh-hosts.js';
import { canAccess } from './util.js';
import type { Store } from './store.js';

export type PushSend = (sub: webpush.PushSubscription, payload: string) => Promise<void>;

export interface Notification {
  title: string; body: string; convId: string;
  /** Internal audience constraints, never included in the push payload. */
  audience?: { admin?: boolean; project?: string; conversation?: string; database?: string; host?: string };
}

export interface TurnEnd { convId: string; project: string; status: string; lastMessage: string }

/** What to tell the user when a turn ends; null means stay quiet. */
export function describeTurn(e: TurnEnd): Notification | null {
  if (e.status === 'cancelled') return null;
  if (e.status === 'failed') return { title: 'Failed', body: `${e.project}: the turn failed`, convId: e.convId };
  if (e.lastMessage.trim().endsWith('?')) return { title: 'Needs your input', body: `${e.project}: ${e.lastMessage.trim().slice(-120)}`, convId: e.convId };
  return { title: 'Finished', body: `${e.project}: the turn finished`, convId: e.convId };
}

export class Push {
  private send: PushSend;

  constructor(private store: Store, opts: { send?: PushSend; subject?: string } = {}) {
    const subject = opts.subject ?? 'mailto:admin@example.invalid';
    this.send = opts.send ?? (async (sub, payload) => {
      const k = this.keys();
      await webpush.sendNotification(sub, payload, { vapidDetails: { subject, publicKey: k.publicKey, privateKey: k.privateKey } });
    });
  }

  /** VAPID keys are generated once and kept in the database. */
  private keys(): { publicKey: string; privateKey: string } {
    const saved = this.store.getKv('vapid');
    if (saved) return JSON.parse(saved);
    const k = webpush.generateVAPIDKeys();
    this.store.setKv('vapid', JSON.stringify(k));
    return k;
  }

  publicKey(): string { return this.keys().publicKey; }

  async notify(n: Notification): Promise<void> {
    const { audience, ...message } = n;
    const payload = JSON.stringify(message);
    await Promise.allSettled(this.store.listPushSubs().map(async (s) => {
      const user = s.user_key === 'owner' ? { id: null, role: 'admin' as const } : this.store.getUser(s.user_key);
      if (!user || (audience?.admin && user.role !== 'admin')) return;
      const projects = [audience?.project];
      for (const id of [n.convId, audience?.conversation]) {
        if (!id) continue;
        const c = this.store.getConversation(id);
        if (!c) return;
        projects.push(c.project_id);
      }
      for (const id of projects) {
        if (!id) continue;
        const p = this.store.getProject(id);
        if (!p || !canAccess(user, p.access)) return;
      }
      if (audience?.database) {
        const c = loadConnections(this.store).find((c) => c.id === audience.database);
        if (!c || !canAccess(user, c.access)) return;
      }
      if (audience?.host) {
        const h = loadHosts(this.store).find((h) => h.id === audience.host);
        if (!h || !canAccess(user, h.access)) return;
      }
      // A missing scope must never turn a private event into a broadcast.
      if (!n.convId && !audience?.project && !audience?.database && !audience?.host) return;
      try {
        await this.send(JSON.parse(s.sub) as webpush.PushSubscription, payload);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.store.removePushSub(s.endpoint, s.user_key); // subscription is gone for good
      }
    }));
  }

  notifyTurn(e: TurnEnd): void {
    const n = describeTurn(e);
    if (n) void this.notify(n).catch((err) => console.error('push failed', err));
  }
}

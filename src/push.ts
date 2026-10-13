import webpush from 'web-push';
import type { Store } from './store.js';

export type PushSend = (sub: webpush.PushSubscription, payload: string) => Promise<void>;

export interface Notification { title: string; body: string; convId: string }

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
    const payload = JSON.stringify(n);
    await Promise.allSettled(this.store.listPushSubs().map(async (s) => {
      try {
        await this.send(JSON.parse(s.sub) as webpush.PushSubscription, payload);
      } catch (e) {
        const code = (e as { statusCode?: number }).statusCode;
        if (code === 404 || code === 410) this.store.removePushSub(s.endpoint); // subscription is gone for good
      }
    }));
  }

  notifyTurn(e: TurnEnd): void {
    const n = describeTurn(e);
    if (n) void this.notify(n).catch((err) => console.error('push failed', err));
  }
}

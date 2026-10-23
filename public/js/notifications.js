// Web Push for this device: a notification when a turn finishes, fails or needs input.
import { api } from './api.js';

function b64urlToBytes(s) {
  const pad = '='.repeat((4 - (s.length % 4)) % 4);
  const raw = atob((s + pad).replace(/-/g, '+').replace(/_/g, '/'));
  return Uint8Array.from(raw, (c) => c.charCodeAt(0));
}

export async function enableNotifications() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) throw new Error('this browser has no Web Push');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('notification permission denied');
  const reg = await navigator.serviceWorker.ready;
  const { publicKey } = await api('/api/push/key');
  const sub = await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64urlToBytes(publicKey) });
  await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

/** Also unsubscribe in the browser so an offline sign-out cannot leave notifications for the next person. */
export async function disableNotifications() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  if (!sub) return;
  try { await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } }); }
  finally { await sub.unsubscribe(); }
}

/** Rebind an existing browser subscription after sign-in (including subscriptions made before ownership was stored). */
export async function restoreNotifications() {
  if (!('serviceWorker' in navigator)) return;
  const reg = await navigator.serviceWorker.getRegistration();
  const sub = await reg?.pushManager?.getSubscription();
  if (sub) await api('/api/push/subscribe', { method: 'POST', body: { subscription: sub.toJSON() } });
}

import { api, publicApi, tokenStore } from './api.js';

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

export async function registerPasskey() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.parseCreationOptionsFromJSON) throw new Error('this browser has no passkey support');
  const opts = await api('/api/passkey/register/options', { method: 'POST', body: {} });
  const cred = await navigator.credentials.create({ publicKey: PublicKeyCredential.parseCreationOptionsFromJSON(opts) });
  await api('/api/passkey/register/verify', { method: 'POST', body: { response: cred.toJSON() } });
}

export async function loginWithPasskey() {
  if (!window.PublicKeyCredential || !PublicKeyCredential.parseRequestOptionsFromJSON) throw new Error('this browser has no passkey support');
  const opts = await publicApi('/api/auth/passkey/options', {});
  const cred = await navigator.credentials.get({ publicKey: PublicKeyCredential.parseRequestOptionsFromJSON(opts) });
  const { token } = await publicApi('/api/auth/passkey/verify', { response: cred.toJSON() });
  tokenStore.set(token);
}

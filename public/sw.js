// Service worker: makes the panel installable and shows Web Push notifications. It caches nothing.
self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let d = {};
  try { d = e.data.json(); } catch { /* payload is optional */ }
  e.waitUntil(self.registration.showNotification(d.title || 'Dalang', {
    body: d.body || '',
    tag: d.convId || 'dalang',
    icon: '/icon.svg',
    data: { convId: d.convId || null },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const convId = e.notification.data && e.notification.data.convId;
  e.waitUntil((async () => {
    // A code or SQL editor tab is not where a chat opens.
    const wins = (await self.clients.matchAll({ type: 'window', includeUncontrolled: true })).filter((w) => !/^\/(code|sql)\b/.test(new URL(w.url).pathname));
    for (const w of wins) {
      await w.focus();
      w.postMessage({ convId });
      return;
    }
    await self.clients.openWindow(convId ? `/#c=${convId}` : '/');
  })());
});

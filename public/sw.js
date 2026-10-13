// couchmatch — Service Worker nur für Push-Benachrichtigungen (kein Offline-Cache).

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let msg;
  try {
    msg = e.data.json();
  } catch {
    msg = { title: 'couchmatch', body: e.data?.text() || '' };
  }
  e.waitUntil((async () => {
    // Ist die App gerade sichtbar offen, reicht ein Hinweis dort
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const visible = wins.find((w) => w.visibilityState === 'visible' && w.focused);
    if (visible) return visible.postMessage({ type: 'push', msg });
    await self.registration.showNotification(msg.title, {
      body: msg.body,
      tag: msg.tag,
      renotify: Boolean(msg.tag),
      data: { url: msg.url || '/' },
      icon: '/icon-192.png',
      badge: '/badge-96.png',
    });
  })());
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => new URL(w.url).origin === self.location.origin);
    if (win) {
      await win.focus();
      return win.navigate(url);
    }
    return self.clients.openWindow(url);
  })());
});

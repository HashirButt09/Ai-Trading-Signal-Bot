/* Loaded into the PWA service worker (workbox importScripts). Shows server push notifications even when the app is closed. */
self.addEventListener('push', (event) => {
  let d = {};
  try {
    d = event.data ? event.data.json() : {};
  } catch (e) {
    d = { title: 'Signal Terminal', body: event.data ? event.data.text() : '' };
  }
  event.waitUntil(
    self.registration.showNotification(d.title || 'Signal Terminal', {
      body: d.body || '',
      tag: d.tag || 'signal',
      renotify: true,
      icon: '/icon-192.png',
      badge: '/icon-192.png',
      vibrate: [200, 100, 200],
      data: { url: d.url || '/', tag: d.tag || '' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';
  const id = event.notification.data && event.notification.data.tag;
  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((list) => {
      for (const c of list) {
        if ('focus' in c) {
          if (id) c.postMessage({ type: 'open-signal', id: id });
          return c.focus();
        }
      }
      return self.clients.openWindow(url);
    })
  );
});

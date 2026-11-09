// Workspace as an installed app: this service worker only keeps the app itself (its page and its
// script and style files) so it opens without a connection. Nothing from /api, mail, files or the
// sync addresses is ever stored here: those always go to the server.
const CACHE = 'workspace-app-v5';
const SKIP = /^\/(api|dav|ws|s|b|i|f|p|c|meet-ws)(\/|$)/; // live data and public share pages

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

// Shared to Workspace from another app (manifest share_target): kept on this device for Drive to
// offer saving (see src/shareinbox.js), never sent anywhere by this. Then Drive opens.
function keepShared(v) {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open('nw-share', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('pending');
    r.onerror = () => reject(r.error);
    r.onsuccess = () => { const t = r.result.transaction('pending', 'readwrite'); t.objectStore('pending').put(v, 'last'); t.oncomplete = resolve; t.onerror = () => reject(t.error); };
  });
}

self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method === 'POST' && new URL(req.url).pathname === '/share-target') {
    e.respondWith((async () => {
      try {
        const fd = await req.formData();
        const files = fd.getAll('files').filter((f) => f && typeof f === 'object' && f.size > 0);
        await keepShared({ files, title: String(fd.get('title') || ''), text: String(fd.get('text') || ''), url: String(fd.get('url') || ''), at: Date.now() });
      } catch { /* nothing kept: Drive just opens */ }
      return Response.redirect('/drive?shared=1', 303);
    })());
    return;
  }
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== self.location.origin || SKIP.test(url.pathname)) return;
  // Pages: the server first (so updates show at once); the last copy when there's no connection.
  if (req.mode === 'navigate') {
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put('/', copy)); }
      return res;
    }).catch(() => caches.match('/')));
    return;
  }
  // The app's files: their names change with every version, so a stored copy is always right.
  if (url.pathname.startsWith('/assets/')) {
    e.respondWith(caches.match(req).then((hit) => hit || fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); }
      return res;
    })));
    return;
  }
  // Icons and the like: the stored copy, refreshed in the background.
  if (/^\/(icons\/|favicon\.svg$|manifest\.webmanifest$|theme-init\.js$)/.test(url.pathname)) {
    e.respondWith(caches.match(req).then((hit) => {
      const fresh = fetch(req).then((res) => { if (res.ok) { const copy = res.clone(); caches.open(CACHE).then((c) => c.put(req, copy)); } return res; });
      return hit || fresh;
    }));
  }
});

// Notifications sent by the server (Web Push; see server/src/push.js): show them, and open the
// place they're about when clicked (in an open Workspace window if there is one).
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch { m = { title: e.data?.text() }; }
  if (Number.isFinite(m.badge) && self.navigator.setAppBadge) { try { (m.badge ? self.navigator.setAppBadge(m.badge) : self.navigator.clearAppBadge()).catch(() => {}); } catch { /* not supported */ } }
  e.waitUntil(self.registration.showNotification(m.title || 'Workspace', {
    body: m.body || '', tag: m.tag, renotify: !!m.tag, icon: '/icons/icon-192.png', badge: '/icons/icon-192.png', data: { link: m.link || '/' },
  }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const link = new URL(e.notification.data?.link || '/', self.location.origin).href;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then((wins) => {
    const w = wins.find((c) => c.url.startsWith(self.location.origin));
    if (w) return w.focus().then(() => w.navigate(link)).catch(() => self.clients.openWindow(link));
    return self.clients.openWindow(link);
  }));
});

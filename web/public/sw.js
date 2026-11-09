// Workspace as an installed app: this service worker only keeps the app itself (its page and its
// script and style files) so it opens without a connection. Nothing from /api, mail, files or the
// sync addresses is ever stored here: those always go to the server.
const CACHE = 'workspace-app-v1';
const SKIP = /^\/(api|dav|ws|s|b|i|f|p|meet-ws)(\/|$)/; // live data and public share pages

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(['/', '/manifest.webmanifest', '/favicon.svg'])).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});

self.addEventListener('fetch', (e) => {
  const req = e.request;
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

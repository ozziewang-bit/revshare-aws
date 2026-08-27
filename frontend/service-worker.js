const CACHE_VERSION = 'revshare-v130';
const SHELL = [
  '/', '/index.html', '/style.css', '/app.js', '/manifest.json', '/logo.png',
  '/lib/html2canvas.min.js', '/lib/jspdf.umd.min.js', '/lib/zip.js',
  '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'
];

// NO skipWaiting here on purpose. A new worker used to activate the moment it installed, so
// the cache flipped to the new build while the open tab carried on running the OLD JavaScript
// it had already parsed — the app looked updated to nobody until the user happened to reload.
// Now the new worker WAITS, the page notices it and asks the viewer to reload, and only then
// does it take over (see the SKIP_WAITING message below).
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
});

// Sent by the page when the viewer accepts the update. Activating here fires controllerchange
// in the page, which is what actually triggers the reload.
self.addEventListener('message', (e) => {
  if (e.data && e.data.type === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then(keys => Promise.all(keys.filter(k => k !== CACHE_VERSION).map(k => caches.delete(k)))));
  self.clients.claim();
});

self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  if (url.origin !== location.origin) return;            // pass through API calls
  e.respondWith(
    fetch(e.request).then(r => {
      const copy = r.clone();
      caches.open(CACHE_VERSION).then(c => c.put(e.request, copy));
      return r;
    }).catch(() => caches.match(e.request))
  );
});

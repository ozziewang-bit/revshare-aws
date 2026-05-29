const CACHE_VERSION = 'revshare-v10';
const SHELL = [
  '/', '/index.html', '/style.css', '/app.js', '/manifest.json',
  '/lib/html2canvas.min.js', '/lib/jspdf.umd.min.js',
  '/icon-192.png', '/icon-512.png', '/apple-touch-icon.png'
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE_VERSION).then(c => Promise.allSettled(SHELL.map(u => c.add(u)))));
  self.skipWaiting();
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

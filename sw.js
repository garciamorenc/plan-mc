const CACHE = 'plan-mc-v36';
const ASSETS = [
  './',
  './index.html',
  './app.js',
  './data.js',
  './catalog.js',
  './firebase-config.js',
  './manifest.webmanifest',
  './icon-192.png',
  './icon-512.png',
];

self.addEventListener('install', e => {
  e.waitUntil(caches.open(CACHE).then(c => c.addAll(ASSETS)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(ks => Promise.all(ks.filter(k => k !== CACHE).map(k => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', e => {
  if (e.request.method !== 'GET') return;
  const url = new URL(e.request.url);
  // No interceptar CDN de Firebase ni llamadas a googleapis: que pasen al network directamente.
  if (url.origin !== self.location.origin) return;
  // No interceptar las rutas de Firebase Auth (login con Google, redirect handler).
  if (url.pathname.startsWith('/__/')) return;
  e.respondWith(
    caches.match(e.request).then(r => r || fetch(e.request).catch(() => caches.match('./index.html')))
  );
});

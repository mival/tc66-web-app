// Service worker: cache the app shell for offline use.
// Change CACHE_VERSION to ship new files.
const CACHE_VERSION = 'tc66-v3';
const APP_SHELL = [
  './',
  'index.html',
  'battery.html',
  'css/style.css',
  'js/tc66.js',
  'js/chart.js',
  'js/app.js',
  'js/db.js',
  'js/battery.js',
  'js/uchart.js',
  'js/theme.js',
  'js/pwa.js',
  'js/vendor/uplot/uPlot.iife.min.js',
  'js/vendor/uplot/uPlot.min.css',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)).then(() => self.skipWaiting()));
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Serve same-origin GET requests from the cache first, then the network.
self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request).then((cached) => {
      if (cached) return cached;
      return fetch(request).then((response) => {
        if (response.ok && response.type === 'basic') {
          const copy = response.clone();
          caches.open(CACHE_VERSION).then((cache) => cache.put(request, copy));
        }
        return response;
      }).catch(() => cached);
    }),
  );
});

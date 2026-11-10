// Service worker: cache the app shell for offline use.
// Change CACHE_VERSION to ship new files.
// The deploy workflow replaces the version name with the git commit.
// A new name makes the service worker cache the new files.
const CACHE_VERSION = 'tc66-dev';
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
  'js/version.js',
  'js/update.js',
  'js/pwa.js',
  'js/vendor/uplot/uPlot.iife.min.js',
  'js/vendor/uplot/uPlot.min.css',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (event) => {
  // Do not skip the wait here. The page asks the user first.
  event.waitUntil(caches.open(CACHE_VERSION).then((cache) => cache.addAll(APP_SHELL)));
});

// The page sends this message when the user clicks "Update".
self.addEventListener('message', (event) => {
  if (event.data && event.data.type === 'SKIP_WAITING') self.skipWaiting();
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
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Let the version check go to the network. It must not use the cache.
  if (url.pathname.endsWith('/version.json')) return;
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

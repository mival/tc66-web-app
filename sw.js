// Service worker: cache the app shell for offline use.
//
// The service worker fetches the app files network-first with cache "no-cache".
// The server answers with a short 304 when a file did not change.
// Thus a new deploy shows on the next page load.
// The worker uses the cache when the network fails or gives no answer in 3 seconds.
//
// The deploy workflow replaces CACHE_VERSION with the git commit.
// A new name makes the service worker cache the new files and remove the old cache.
const CACHE_VERSION = 'tc66-dev';
const NETWORK_WAIT_MS = 3000;
const APP_SHELL = [
  './',
  'index.html',
  'battery.html',
  'help.html',
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

// Download every file from the server. "reload" skips the HTTP cache of the browser.
// GitHub Pages lets the browser keep a file for 10 minutes. Without "reload", the cache can get old files.
function cacheAppShell() {
  return caches.open(CACHE_VERSION)
    .then((cache) => cache.addAll(APP_SHELL.map((file) => new Request(file, { cache: 'reload' }))));
}

self.addEventListener('install', (event) => {
  // The fetch handler is network-first, so the new worker can take control at once.
  event.waitUntil(cacheAppShell().then(() => self.skipWaiting()));
});

// The page sends "refresh" when the user clicks "Reload" for a new version.
// The worker downloads all files again. Then it tells the page to reload.
self.addEventListener('message', (event) => {
  if (!event.data || event.data.type !== 'REFRESH') return;
  event.waitUntil(
    cacheAppShell()
      .catch(() => {})
      .then(() => event.source && event.source.postMessage({ type: 'REFRESHED' })),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_VERSION).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

// Get a file from the network first. Use the cache when the network fails or is too slow.
async function networkFirst(request) {
  const cache = await caches.open(CACHE_VERSION);
  // A navigation request cannot take other options. Make a new request from its URL.
  const networkRequest = request.mode === 'navigate'
    ? new Request(request.url, { cache: 'no-cache', credentials: 'same-origin' })
    : new Request(request, { cache: 'no-cache' });
  const network = fetch(networkRequest).then((response) => {
    if (response.ok && response.type === 'basic') cache.put(request, response.clone());
    return response;
  });
  network.catch(() => {}); // The code below handles the error. This stops an unhandled rejection.
  const timeout = new Promise((resolve) => setTimeout(resolve, NETWORK_WAIT_MS));
  try {
    const response = await Promise.race([network, timeout]);
    if (response) return response;
  } catch {
    // Offline. Use the cache.
  }
  const cached = await cache.match(request, { ignoreSearch: true });
  if (cached) return cached;
  if (request.mode === 'navigate') {
    const page = await cache.match('index.html');
    if (page) return page;
  }
  return network;
}

self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (request.method !== 'GET' || url.origin !== self.location.origin) return;
  // Let the version check go to the network. It must not use the cache.
  if (url.pathname.endsWith('/version.json')) return;
  event.respondWith(networkFirst(request));
});

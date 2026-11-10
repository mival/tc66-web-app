// Register the service worker for offline use. It needs a secure context (https or localhost).
// It does not work from a file:// path, so this script skips registration there.
(function () {
  'use strict';
  if (!('serviceWorker' in navigator)) return;
  if (location.protocol !== 'https:' && location.hostname !== 'localhost' && location.hostname !== '127.0.0.1') return;
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch((error) => {
      console.warn('Service worker registration failed:', error.message);
    });
  });
})();

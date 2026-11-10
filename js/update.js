// Show the build version. Check for a new version. Let the user update.
//
// The page shows the baked commit in the footer.
// The script fetches version.json from the server to find a new version.
// It also asks the service worker to check for a new copy.
// When a new version is ready, the script shows the "Update" button.
// The button activates the new service worker and reloads the page.
(function () {
  'use strict';

  var CHECK_INTERVAL_MS = 5 * 60 * 1000; // 5 minutes
  var baked = (window.APP_VERSION && window.APP_VERSION.commit) || 'dev';

  var badge = document.querySelector('[data-app-version]');
  var button = document.querySelector('[data-app-update]');

  var updateReady = false; // true when a new version is ready to apply
  var reloading = false;

  // The service worker needs a secure context. It fails on a file:// page.
  function swOk() {
    if (!('serviceWorker' in navigator)) return false;
    return location.protocol === 'https:' ||
      location.hostname === 'localhost' ||
      location.hostname === '127.0.0.1';
  }

  showBadge();
  if (button) button.addEventListener('click', applyUpdate);

  watchServiceWorker();
  checkVersionFile();
  setInterval(runCheck, CHECK_INTERVAL_MS);
  document.addEventListener('visibilitychange', function () {
    if (document.visibilityState === 'visible') runCheck();
  });

  // Write the build version into the footer.
  function showBadge() {
    if (!badge) return;
    var date = window.APP_VERSION && window.APP_VERSION.date;
    badge.textContent = date ? baked + ' (' + date + ')' : baked;
  }

  // Show the update button and keep the state.
  function markUpdateReady() {
    if (updateReady) return;
    updateReady = true;
    if (button) button.hidden = false;
  }

  // Run both checks together.
  function runCheck() {
    checkVersionFile();
    updateServiceWorker();
  }

  // Fetch version.json from the server. Compare it to the baked version.
  function checkVersionFile() {
    if (!('fetch' in window)) return;
    fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) return null;
        return response.json();
      })
      .then(function (data) {
        if (!data || !data.commit) return;
        if (baked !== 'dev' && data.commit !== baked) markUpdateReady();
      })
      .catch(function () {
        // The server may be offline. Try again on the next check.
      });
  }

  // Watch the service worker for a new copy that waits to activate.
  function watchServiceWorker() {
    if (!swOk()) return;

    navigator.serviceWorker.getRegistration().then(function (registration) {
      if (!registration) return;
      if (registration.waiting) markUpdateReady();
      registration.addEventListener('updatefound', function () {
        trackWorker(registration.installing);
      });
    });

    // The new service worker took control. Reload once to use it.
    navigator.serviceWorker.addEventListener('controllerchange', function () {
      if (reloading) return;
      reloading = true;
      window.location.reload();
    });
  }

  // Wait for a worker to finish install. Then mark the update as ready.
  function trackWorker(worker) {
    if (!worker) return;
    worker.addEventListener('statechange', function () {
      if (worker.state === 'installed' && navigator.serviceWorker.controller) {
        markUpdateReady();
      }
    });
  }

  // Ask the browser to check the server for a new service worker.
  function updateServiceWorker() {
    if (!swOk()) return;
    navigator.serviceWorker.getRegistration().then(function (registration) {
      if (registration) registration.update().catch(function () {});
    });
  }

  // Apply the update. Activate the waiting worker, or reload the page.
  function applyUpdate() {
    if (button) button.disabled = true;

    if (!swOk()) {
      window.location.reload();
      return;
    }

    navigator.serviceWorker.getRegistration().then(function (registration) {
      var waiting = registration && registration.waiting;
      if (waiting) {
        // The controllerchange handler reloads the page.
        waiting.postMessage({ type: 'SKIP_WAITING' });
        return;
      }
      if (registration) registration.update().catch(function () {});
      // No waiting worker. Reload to get the new files.
      window.setTimeout(function () {
        if (!reloading) window.location.reload();
      }, 1500);
    });
  }
})();

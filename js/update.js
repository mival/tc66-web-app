// Show the build version. Check for a new version. Let the user update.
//
// Each deploy writes the git commit into js/version.js and into version.json.
// The page shows its own commit in the footer.
// The script fetches version.json from the server and compares the two commits.
// It checks on load, when the page becomes visible, and every 30 minutes.
// When the commits are different, a banner offers to reload.
// The script never reloads by itself, so a running battery test does not stop.
// The footer has a "Check for updates" button.
(function () {
  'use strict';

  var CHECK_INTERVAL_MS = 30 * 60 * 1000; // 30 minutes
  var REFRESH_TIMEOUT_MS = 8000;
  var current = {
    commit: (window.APP_VERSION && window.APP_VERSION.commit) || 'dev',
    date: (window.APP_VERSION && window.APP_VERSION.date) || '',
  };
  var online = /^https?:$/.test(location.protocol);
  var latest = null;
  var dismissed = null; // the commit that the user closed the banner for

  var badge = document.querySelector('[data-app-version]');
  var checkButton = document.querySelector('[data-app-check]');
  var message = document.querySelector('[data-app-update-message]');

  showBadge();
  if (checkButton) {
    if (online) checkButton.hidden = false;
    checkButton.addEventListener('click', onCheckClick);
  }

  if (online) {
    window.addEventListener('load', function () { setTimeout(check, 3000); });
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') check();
    });
    setInterval(check, CHECK_INTERVAL_MS);
  }

  function label(version) {
    if (!version || version.commit === 'dev') return 'dev';
    return version.date ? version.commit + ' (' + version.date + ')' : version.commit;
  }

  // Write the build version into the footer.
  function showBadge() {
    if (badge) badge.textContent = label(current);
  }

  function isNewer(version) {
    return !!version && current.commit !== 'dev' && version.commit !== current.commit;
  }

  // Fetch version.json from the server. Return the data, or null when offline.
  function check() {
    if (!online || !('fetch' in window)) return Promise.resolve(null);
    return fetch('version.json?t=' + Date.now(), { cache: 'no-store' })
      .then(function (response) { return response.ok ? response.json() : null; })
      .then(function (data) {
        if (!data || !data.commit) return null;
        latest = data;
        if (isNewer(latest)) showBanner();
        return latest;
      })
      .catch(function () { return null; });
  }

  // Ask the service worker to download all files again. Then reload the page.
  function apply() {
    var worker = navigator.serviceWorker && navigator.serviceWorker.controller;
    if (!worker) { window.location.reload(); return; }
    var reloaded = false;
    function reload() {
      if (reloaded) return;
      reloaded = true;
      window.location.reload();
    }
    navigator.serviceWorker.addEventListener('message', function (event) {
      if (event.data && event.data.type === 'REFRESHED') reload();
    });
    setTimeout(reload, REFRESH_TIMEOUT_MS);
    worker.postMessage({ type: 'REFRESH' });
  }

  function showBanner() {
    if (!latest || dismissed === latest.commit) return;
    if (document.getElementById('update-banner')) return;
    var bar = document.createElement('div');
    bar.id = 'update-banner';
    bar.className = 'update-banner';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<span>A new version of the app is ready.</span>' +
      '<button type="button" class="primary" data-reload>Reload</button>' +
      '<button type="button" class="icon-button" data-close aria-label="Later">×</button>';
    bar.querySelector('[data-reload]').addEventListener('click', function (event) {
      event.target.textContent = 'Updating…';
      event.target.disabled = true;
      apply();
    });
    bar.querySelector('[data-close]').addEventListener('click', function () {
      dismissed = latest.commit;
      bar.remove();
    });
    document.body.appendChild(bar);
  }

  function showMessage(text) {
    if (!message) return;
    message.textContent = text;
    message.hidden = !text;
  }

  // Footer button: check now. When a new version is ready, the button applies it.
  function onCheckClick() {
    if (checkButton.dataset.ready) {
      checkButton.textContent = 'Updating…';
      checkButton.disabled = true;
      apply();
      return;
    }
    checkButton.disabled = true;
    showMessage('Checking…');
    check().then(function (version) {
      checkButton.disabled = false;
      if (!version) {
        showMessage('Cannot check. You may be offline.');
      } else if (!isNewer(version)) {
        showMessage('You have the latest version.');
      } else {
        showMessage('Version ' + label(version) + ' is available.');
        checkButton.textContent = 'Reload to update';
        checkButton.dataset.ready = '1';
      }
    });
  }
})();

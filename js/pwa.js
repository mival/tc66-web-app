// Register the service worker for offline use. It needs a secure context (https or localhost).
// It does not work from a file:// path, so this script skips registration there.
//
// Show an "Install" button in the header when the browser can install the app.
// The button opens the install dialog of the browser.
// The help page shows the install state and the steps for iOS.
(function () {
  'use strict';

  var secure = location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1';
  if ('serviceWorker' in navigator && secure) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('sw.js').catch(function (error) {
        console.warn('Service worker registration failed:', error.message);
      });
    });
  }

  var INSTALLED_TEXT = 'The app is installed. It opens in its own window and works offline.';
  var standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
  var ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);

  // Elements on the help page. They are not on the other pages.
  var status = document.querySelector('[data-install-status]');
  var iosSteps = document.querySelector('[data-install-ios]');
  var helpButton = document.querySelector('[data-install-button]');

  function setStatus(text) {
    if (status) status.textContent = text;
  }

  if (standalone) {
    setStatus(INSTALLED_TEXT);
    return;
  }
  if (ios && iosSteps) iosSteps.hidden = false;

  // Make the header button. It stays hidden until the browser offers the install.
  var actions = document.querySelector('.header-actions');
  var headerButton = null;
  if (actions) {
    headerButton = document.createElement('button');
    headerButton.type = 'button';
    headerButton.className = 'install-button';
    headerButton.textContent = 'Install';
    headerButton.title = 'Install the app on this device';
    headerButton.hidden = true;
    actions.insertBefore(headerButton, actions.querySelector('[data-theme-toggle]'));
  }
  var buttons = [headerButton, helpButton].filter(Boolean);

  var deferredPrompt = null;

  function showButtons(show) {
    buttons.forEach(function (button) { button.hidden = !show; });
  }

  window.addEventListener('beforeinstallprompt', function (event) {
    event.preventDefault();
    deferredPrompt = event;
    showButtons(true);
    setStatus('You can install the app on this device.');
  });

  buttons.forEach(function (button) {
    button.addEventListener('click', function () {
      if (!deferredPrompt) return;
      deferredPrompt.prompt();
      deferredPrompt.userChoice
        .catch(function () { return null; })
        .then(function (choice) {
          deferredPrompt = null;
          showButtons(false);
          if (choice && choice.outcome === 'accepted') setStatus(INSTALLED_TEXT);
        });
    });
  });

  window.addEventListener('appinstalled', function () {
    deferredPrompt = null;
    showButtons(false);
    setStatus(INSTALLED_TEXT);
  });
})();

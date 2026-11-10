// Shared color scheme control. Three states: auto, light and dark.
// "auto" follows the system. localStorage keeps the choice. The meta element applies it.
// The pre-paint inline script in each page sets the meta element before the first paint.
(function (globalScope) {
  'use strict';

  const STORAGE_KEY = 'color-scheme';
  const STATES = ['auto', 'light', 'dark'];
  const systemDarkQuery = matchMedia('(prefers-color-scheme: dark)');
  const changeListeners = new Set();

  function readState() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'light' || value === 'dark' || value === 'auto' ? value : 'auto';
    } catch {
      return 'auto';
    }
  }

  function writeState(state) {
    try {
      if (state === 'auto') localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, state);
    } catch {
      // Storage is blocked. The page still changes the scheme for this visit.
    }
  }

  function metaContent(state) {
    return state === 'light' ? 'light' : state === 'dark' ? 'dark' : 'light dark';
  }

  const STATE_LABELS = {
    auto: 'Theme: auto (follows the system)',
    light: 'Theme: light',
    dark: 'Theme: dark',
  };

  function updateButtons(state) {
    const nextState = STATES[(STATES.indexOf(state) + 1) % STATES.length];
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.dataset.state = state;
      button.setAttribute('aria-label', `${STATE_LABELS[state]}. Click for ${nextState}.`);
      const label = button.querySelector('[data-theme-label]');
      if (label) label.textContent = STATE_LABELS[state];
    }
  }

  function apply(state) {
    const meta = document.querySelector('meta[name="color-scheme"]');
    if (meta) meta.content = metaContent(state);
    updateButtons(state);
    for (const listener of changeListeners) {
      try { listener(state); } catch { /* a listener error must not stop the others */ }
    }
  }

  function cycle() {
    const nextState = STATES[(STATES.indexOf(readState()) + 1) % STATES.length];
    writeState(nextState);
    apply(nextState);
  }

  // onChange runs after each scheme change (for example to redraw charts).
  function init(onChange) {
    if (onChange) changeListeners.add(onChange);
    for (const button of document.querySelectorAll('[data-theme-toggle]')) {
      button.addEventListener('click', cycle);
    }
    // In auto mode the system can change at any time. Re-apply so the icon and the charts follow.
    systemDarkQuery.addEventListener('change', () => {
      updateButtons(readState());
      for (const listener of changeListeners) {
        try { listener(readState()); } catch { /* ignore */ }
      }
    });
    // Keep other tabs in sync.
    window.addEventListener('storage', (event) => {
      if (event.key === STORAGE_KEY || event.key === null) apply(readState());
    });
    apply(readState());
  }

  globalScope.Theme = { init, cycle, readState };
})(globalThis);

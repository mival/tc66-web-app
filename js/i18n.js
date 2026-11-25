// Language support: English (the source) and Czech.
// The page texts are English. This script translates them in the page:
// - text nodes and the attributes aria-label, title, placeholder, alt and aria-valuetext,
// - elements with data-i18n-html: the dictionary gives the whole HTML of the element (sentences with inline markup),
// - texts that the page scripts set later (status, toasts, badges): a MutationObserver translates them.
// The dictionary (js/i18n-cs.js) maps an English text to the Czech text. A pattern entry has placeholders
// like {count}. The technical log (#log) and pre elements stay in English.
// The language is Czech when the browser language is Czech, else English. The header button changes it,
// and localStorage keeps the choice.
(function (globalScope) {
  'use strict';

  const STORAGE_KEY = 'lang';
  const LANGUAGES = { en: 'English', cs: 'Česky' };
  const ATTRIBUTES = ['aria-label', 'title', 'placeholder', 'alt', 'aria-valuetext'];
  const SKIP_SELECTOR = 'script, style, pre, #log, [translate="no"], textarea';

  function storedLanguage() {
    try {
      const value = localStorage.getItem(STORAGE_KEY);
      return value === 'cs' || value === 'en' ? value : null;
    } catch {
      return null;
    }
  }

  function browserLanguage() {
    const languages = navigator.languages && navigator.languages.length ? navigator.languages : [navigator.language || 'en'];
    return languages.some((language) => /^cs\b/i.test(language)) ? 'cs' : 'en';
  }

  const lang = storedLanguage() || browserLanguage();
  const dictionary = (globalScope.I18N_DICTIONARIES && globalScope.I18N_DICTIONARIES[lang]) || null;

  // ---------- Lookup ----------

  const exact = new Map();
  const patterns = [];
  const html = new Map();
  if (dictionary) {
    for (const [english, translated] of Object.entries(dictionary.exact || {})) exact.set(english, translated);
    for (const [english, translated] of Object.entries(dictionary.html || {})) html.set(english, translated);
    // A pattern like "Reconnecting ({count}/12)…" becomes a regular expression with one group for each placeholder.
    for (const [english, translated] of Object.entries(dictionary.patterns || {})) {
      const names = [];
      const source = english.split(/(\{[a-z]+\})/i).map((part) => {
        const match = part.match(/^\{([a-z]+)\}$/i);
        if (match) {
          names.push(match[1]);
          return '(.+?)';
        }
        return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      }).join('');
      const fixedLength = english.replace(/\{[a-z]+\}/gi, '').length;
      patterns.push({ regex: new RegExp(`^${source}$`, 's'), names, translated, fixedLength });
    }
    // Try the most specific pattern first: "Firmware update failed: {a}" before "{a} failed: {b}".
    patterns.sort((left, right) => right.fixedLength - left.fixedLength);
  }

  const normalize = (text) => text.replace(/\s+/g, ' ').trim();

  // Translate one text. A placeholder value is translated too (for example "Output on" in "{a} failed: {b}").
  // A text that the dictionary does not know stays as it is.
  function t(text, depth = 0) {
    if (!dictionary || typeof text !== 'string') return text;
    const key = normalize(text);
    if (!key) return text;
    if (exact.has(key)) return exact.get(key);
    if (depth > 2) return text;
    for (const pattern of patterns) {
      const match = key.match(pattern.regex);
      if (!match) continue;
      let result = pattern.translated;
      pattern.names.forEach((name, index) => {
        result = result.split(`{${name}}`).join(t(match[index + 1], depth + 1));
      });
      return result;
    }
    return text;
  }

  // ---------- Page translation ----------

  function skip(element) {
    return !element || !!element.closest(SKIP_SELECTOR);
  }

  // Keep the spaces around a text node, so inline text stays separated from its neighbors.
  function translateTextNode(node) {
    if (skip(node.parentElement)) return;
    const original = node.nodeValue;
    const key = normalize(original);
    if (!key || !/[A-Za-z]/.test(key)) return;
    const translated = t(key);
    if (translated === key) return;
    const leading = /^\s/.test(original) ? ' ' : '';
    const trailing = /\s$/.test(original) ? ' ' : '';
    node.nodeValue = leading + translated + trailing;
  }

  function translateAttributes(element) {
    if (skip(element)) return;
    for (const name of ATTRIBUTES) {
      const value = element.getAttribute(name);
      if (!value) continue;
      const translated = t(value);
      if (translated !== value) element.setAttribute(name, translated);
    }
  }

  function translateHtmlElement(element) {
    const key = element.getAttribute('data-i18n-html');
    if (key && html.has(key)) element.innerHTML = html.get(key);
  }

  function translateTree(root) {
    if (!dictionary || !root) return;
    if (root.nodeType === Node.TEXT_NODE) {
      translateTextNode(root);
      return;
    }
    if (root.nodeType !== Node.ELEMENT_NODE) return;
    if (root.matches('[data-i18n-html]')) translateHtmlElement(root);
    root.querySelectorAll('[data-i18n-html]').forEach(translateHtmlElement);
    translateAttributes(root);
    root.querySelectorAll('*').forEach(translateAttributes);
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) translateTextNode(node);
  }

  // Translate the texts that the page scripts set later.
  function watch() {
    const observer = new MutationObserver((mutations) => {
      for (const mutation of mutations) {
        if (mutation.type === 'characterData') translateTextNode(mutation.target);
        else if (mutation.type === 'attributes') translateAttributes(mutation.target);
        else mutation.addedNodes.forEach(translateTree);
      }
    });
    observer.observe(document.body, {
      subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ATTRIBUTES,
    });
  }

  // ---------- Help page and links ----------

  // The Czech help is a separate page (help.cs.html), because its long texts have inline markup.
  function helpPage() {
    const file = location.pathname.split('/').pop() || '';
    if (lang === 'cs' && file === 'help.html') { location.replace('help.cs.html' + location.hash); return true; }
    if (lang === 'en' && file === 'help.cs.html') { location.replace('help.html' + location.hash); return true; }
    return false;
  }

  function rewriteHelpLinks() {
    if (lang !== 'cs') return;
    document.querySelectorAll('a[href^="help.html"]').forEach((link) => {
      link.setAttribute('href', link.getAttribute('href').replace(/^help\.html/, 'help.cs.html'));
    });
  }

  // ---------- Language button ----------

  function setLanguage(language) {
    try { localStorage.setItem(STORAGE_KEY, language); } catch { /* The choice applies to this page load only. */ }
    location.reload();
  }

  function addButton() {
    const actions = document.querySelector('.header-actions');
    if (!actions) return;
    const other = lang === 'cs' ? 'en' : 'cs';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'lang-button';
    button.lang = other;
    button.textContent = LANGUAGES[other];
    // The label is in the other language, so a user who does not read this one finds it.
    button.title = other === 'cs' ? 'Přepnout do češtiny' : 'Switch to English';
    button.setAttribute('aria-label', button.title);
    button.setAttribute('translate', 'no');
    button.addEventListener('click', () => setLanguage(other));
    actions.insertBefore(button, actions.querySelector('[data-theme-toggle]'));
  }

  // ---------- Start ----------

  globalScope.I18n = { lang, t, translate: translateTree };
  document.documentElement.lang = lang;
  if (helpPage()) return;
  addButton();
  if (dictionary) {
    rewriteHelpLinks();
    document.title = t(document.title);
    translateTree(document.body);
    watch();
  }
})(globalThis);

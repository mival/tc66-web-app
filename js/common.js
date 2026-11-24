// Shared page helpers: the log, the connection status, file downloads, short messages (toasts),
// the Connect/Disconnect button and the timer for the polling loops.
// This file is a classic script, so it works from file://.
(function (globalScope) {
  'use strict';

  const element = (id) => document.getElementById(id);

  // Add a line with the time to the log element. Keep the last maxLines lines.
  function addLogLine(message, { logId = 'log', maxLines = 300 } = {}) {
    const logElement = element(logId);
    if (!logElement) return;
    const line = `${new Date().toLocaleTimeString()}  ${message}\n`;
    logElement.textContent = (logElement.textContent + line).split('\n').slice(-maxLines).join('\n');
    logElement.scrollTop = logElement.scrollHeight;
  }

  // Show the connection status in the header. state: '' (neutral), 'on' or 'error'.
  function setStatus(text, state = '') {
    element('status-text').textContent = text;
    element('status-dot').className = 'dot' + (state ? ' ' + state : '');
  }

  // Show one button: Connect when disconnected, Disconnect when connected.
  // The "Choose port" button shows only when disconnected and a known port exists.
  function showConnected(connected) {
    const connect = element('connect');
    const disconnect = element('disconnect');
    connect.hidden = connected;
    connect.disabled = connected;
    disconnect.hidden = !connected;
    disconnect.disabled = !connected;
    const choose = element('choose-port');
    if (choose && connected) choose.hidden = true;
  }

  // Format seconds as m:ss or h:mm:ss.
  function formatDuration(totalSeconds) {
    const seconds = Math.max(0, Math.round(totalSeconds));
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const pad = (value) => String(value).padStart(2, '0');
    return hours ? `${hours}:${pad(minutes)}:${pad(seconds % 60)}` : `${minutes}:${pad(seconds % 60)}`;
  }

  function fileTimestamp() {
    const now = new Date();
    const pad = (value) => String(value).padStart(2, '0');
    const date = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}`;
    const time = `${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    return `${date}-${time}`;
  }

  function saveFile(fileName, content, mimeType) {
    const url = URL.createObjectURL(new Blob([content], { type: mimeType }));
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  // ---------- Toasts ----------

  // A toast is a short message near the top of the page. It closes by itself.
  // One live region announces each message to screen readers.
  let toastRegion = null;

  function toast(message, { kind = 'info', milliseconds = 6000 } = {}) {
    if (!toastRegion) {
      toastRegion = document.createElement('div');
      toastRegion.className = 'toast-region';
      toastRegion.setAttribute('role', 'status');
      toastRegion.setAttribute('aria-live', 'polite');
      document.body.append(toastRegion);
    }
    const item = document.createElement('div');
    item.className = `toast toast-${kind}`;
    const text = document.createElement('span');
    text.textContent = (kind === 'error' ? '⚠ ' : kind === 'success' ? '✓ ' : '') + message;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'toast-close';
    close.setAttribute('aria-label', 'Close the message');
    close.textContent = '×';
    const remove = () => item.remove();
    close.addEventListener('click', remove);
    item.append(text, close);
    toastRegion.append(item);
    // Keep at most 3 messages.
    while (toastRegion.children.length > 3) toastRegion.firstElementChild.remove();
    if (milliseconds > 0) setTimeout(remove, milliseconds);
    return item;
  }

  // ---------- Timer for polling loops ----------

  // Browsers slow down timers in a hidden tab, down to one per minute after some minutes.
  // A timer in a dedicated worker does not get this limit, so a long test keeps its sample rate.
  // If the page cannot start a worker, sleep() uses setTimeout.
  let worker;
  let nextTimerId = 1;
  const waiting = new Map();

  function startWorker() {
    if (worker !== undefined) return worker;
    worker = null;
    try {
      const source = 'onmessage = (event) => { setTimeout(() => postMessage(event.data.id), event.data.milliseconds); };';
      const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
      worker = new Worker(url);
      worker.onmessage = (event) => {
        const resolve = waiting.get(event.data);
        if (!resolve) return;
        waiting.delete(event.data);
        resolve();
      };
      worker.onerror = () => {
        // The worker failed. Release the waiting tasks and use setTimeout from now on.
        worker = null;
        waiting.forEach((resolve) => resolve());
        waiting.clear();
      };
    } catch {
      worker = null;
    }
    return worker;
  }

  function sleep(milliseconds) {
    const timerWorker = startWorker();
    if (!timerWorker) return new Promise((resolve) => setTimeout(resolve, milliseconds));
    return new Promise((resolve) => {
      const id = nextTimerId++;
      waiting.set(id, resolve);
      timerWorker.postMessage({ id, milliseconds: Math.max(0, milliseconds) });
    });
  }

  // ---------- Screen wake lock ----------

  // Keep the screen on, for example during a long test. The browser releases the lock when the tab is hidden,
  // so the lock comes back when the tab is visible again.
  const WakeLock = {
    sentinel: null,
    wanted: false,
    async acquire() {
      this.wanted = true;
      if (!('wakeLock' in navigator) || document.visibilityState !== 'visible' || this.sentinel) return;
      try {
        this.sentinel = await navigator.wakeLock.request('screen');
        this.sentinel.addEventListener('release', () => { this.sentinel = null; });
      } catch {
        this.sentinel = null; // The browser refused, for example on low battery. The test still runs.
      }
    },
    async release() {
      this.wanted = false;
      const sentinel = this.sentinel;
      this.sentinel = null;
      if (sentinel) await sentinel.release().catch(() => {});
    },
  };
  document.addEventListener('visibilitychange', () => {
    if (WakeLock.wanted && document.visibilityState === 'visible') WakeLock.acquire();
  });

  // ---------- Known ports and reconnect ----------

  function portInfo(port) {
    try { return typeof port.getInfo === 'function' ? port.getInfo() : {}; } catch { return {}; }
  }

  // Remember the port that connected last, so the next Connect can use it without the port chooser.
  // getInfo() is the only identity that the browser gives. It can be empty, for example for a Bluetooth COM port.
  function rememberPort(storageKey, port) {
    try { localStorage.setItem(storageKey, JSON.stringify(portInfo(port))); } catch { /* Storage is blocked. */ }
  }

  // Return the allowed port for this page, or null when the user must choose.
  // match(info) selects the ports for this page. With one match, use it.
  // With more matches, use the one that agrees with the remembered port, if exactly one does.
  async function findKnownPort(storageKey, match) {
    if (!('serial' in navigator) || typeof navigator.serial.getPorts !== 'function') return null;
    let ports;
    try { ports = (await navigator.serial.getPorts()).filter((port) => match(portInfo(port))); } catch { return null; }
    if (ports.length === 1) return ports[0];
    let remembered = null;
    try { remembered = localStorage.getItem(storageKey); } catch { /* Storage is blocked. */ }
    const same = ports.filter((port) => JSON.stringify(portInfo(port)) === remembered);
    return same.length === 1 ? same[0] : null;
  }

  // Try to connect again after a lost connection: when the browser reports the port again ('connect' event),
  // and every delay milliseconds, for at most `attempts` tries.
  // tryConnect(port) returns true when the connection works again.
  class Reconnector {
    constructor({ port, tryConnect, onGiveUp, attempts = 12, delay = 5000 }) {
      this.port = port;
      this.tryConnect = tryConnect;
      this.onGiveUp = onGiveUp || (() => {});
      this.attempts = attempts;
      this.delay = delay;
      this.active = false;
      this.busy = false;
      this.count = 0;
      this.onSerialConnect = (event) => { if (event.target === this.port) this.attempt(); };
    }

    start() {
      this.active = true;
      this.count = 0;
      if ('serial' in navigator) navigator.serial.addEventListener('connect', this.onSerialConnect);
      this.schedule();
    }

    stop() {
      this.active = false;
      clearTimeout(this.timer);
      if ('serial' in navigator) navigator.serial.removeEventListener('connect', this.onSerialConnect);
    }

    schedule() {
      clearTimeout(this.timer);
      if (this.active) this.timer = setTimeout(() => this.attempt(), this.delay);
    }

    async attempt() {
      if (!this.active || this.busy) return;
      this.busy = true;
      this.count++;
      let connected = false;
      try { connected = await this.tryConnect(this.port, this.count); } catch { connected = false; }
      this.busy = false;
      if (!this.active) return;
      if (connected) { this.stop(); return; }
      if (this.count >= this.attempts) { this.stop(); this.onGiveUp(); return; }
      this.schedule();
    }
  }

  // 'worker' or 'timeout'. The tests check that the worker timer starts.
  function timerKind() {
    return startWorker() ? 'worker' : 'timeout';
  }

  globalScope.App = {
    timerKind,
    portInfo,
    rememberPort,
    findKnownPort,
    Reconnector,
    element,
    addLogLine,
    setStatus,
    showConnected,
    formatDuration,
    fileTimestamp,
    saveFile,
    toast,
    sleep,
    WakeLock,
  };
})(globalThis);

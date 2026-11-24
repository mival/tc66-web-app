// End-to-end test for battery.html. Serves the project over HTTP, drives the page with a mock serial
// port, records a short auto test, and checks the saved session in IndexedDB.
// Run: BROWSER_PATH=<chrome> node test/battery.e2e.mjs
//
// The capacity math has coverage in test/db.test.js. This test covers the IndexedDB store and the UI.
// It uses one synchronous DevTools evaluate per page, which is stable in headless Chrome.
// CI runs the unit tests and the meter test. Run this one with: BROWSER_PATH=<chrome> node test/battery.e2e.mjs
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import { createChecks, finish, makeOutputDirectory, sleep, startBrowser, startStaticServer } from './lib/browser.mjs';

const require = createRequire(import.meta.url);
const TC66 = require('../js/tc66.js');
const outputDirectory = makeOutputDirectory('tc66-batt-');
const debugPort = 9341;

// Build a valid encrypted getva response for a chosen voltage and current.
function buildGetva(voltage, current) {
  const plain = Buffer.alloc(192);
  plain.write('pac1', 0); plain.write('TC66', 4); plain.write('1.17', 8);
  plain.writeUInt32LE(5795, 12); plain.writeUInt32LE(419, 44);
  plain.writeUInt32LE(Math.round(voltage * 1e4), 48);
  plain.writeUInt32LE(Math.round(current * 1e5), 52);
  plain.writeUInt32LE(Math.round(voltage * current * 1e4), 56);
  plain.write('pac2', 64); plain.writeUInt32LE(99999, 68); plain.writeUInt32LE(25, 92);
  plain.write('pac3', 128);
  for (const offset of [0, 64, 128]) plain.writeUInt32LE(TC66.crc16Modbus(plain, offset, 60), offset + 60);
  const cipher = crypto.createCipheriv('aes-256-ecb', Buffer.from(TC66.GETVA_KEY), null).setAutoPadding(false);
  return Buffer.concat([cipher.update(plain), cipher.final()]).toString('base64');
}

const mockSerialScript = `(() => {
  const ON = '${buildGetva(5.0, 2.0)}';
  const OFF = '${buildGetva(5.0, 0.0)}';
  const fromBase64 = (text) => Uint8Array.from(atob(text), (c) => c.charCodeAt(0));
  const serialLog = (window.__serialLog = []);
  let getvaCount = 0;
  class MockPort extends EventTarget {
    getInfo() { return { usbVendorId: 0x28e9, usbProductId: 0x018a }; }
    async open() {
      let controller;
      this.readable = new ReadableStream({ start: (c) => { controller = c; } });
      const reply = (bytes) => { try { controller.enqueue(bytes); } catch {} };
      this.writable = new WritableStream({ write: (data) => {
        const command = new TextDecoder().decode(data);
        serialLog.push(command);
        if (command === 'query') reply(new TextEncoder().encode('firm'));
        else if (command === 'getva') { getvaCount++; reply(fromBase64(getvaCount <= 3 ? ON : OFF)); }
      }});
    }
    async setSignals() {}
    async close() {}
  }
  const port = new MockPort();
  let allowed = false; // Like a real browser: getPorts() returns the port after the chooser.
  Object.defineProperty(navigator, 'serial', { value: {
    requestPort: async () => { allowed = true; return port; },
    getPorts: async () => (allowed ? [port] : []),
    addEventListener() {},
    removeEventListener() {},
  }});
  window.confirm = () => true;
})();`;

const server = await startStaticServer();
const { baseUrl } = server;
// Do one Runtime.evaluate per navigation. A second evaluate in the same window can stall in headless Chrome.
const browser = await startBrowser({ debugPort, outputDirectory });
const { send, evaluate, textOf, click, pageErrors } = browser;
const checks = createChecks();
const { check } = checks;
process.on('unhandledRejection', (error) => { console.error('unhandled rejection:', error && error.message); });

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mockSerialScript });

  // A test that was cut off: a session with no end and 3 samples at 1 A, 10 s apart (20 s of charge).
  // Do one evaluate per page load where possible. The first page writes the session.
  await send('Page.navigate', { url: `${baseUrl}/battery.html` });
  await sleep(1500);
  await evaluate(`(() => {
    const request = indexedDB.open('tc66-battery');
    request.onsuccess = () => {
      const database = request.result;
      const transaction = database.transaction(['sessions', 'samples'], 'readwrite');
      const add = transaction.objectStore('sessions').add({ name: 'Cut off', rated_mah: null, nominal_v: null, rated_wh: null,
        started_at: 1000, ended_at: null, sample_count: 0, mah: 0, wh: 0, note: null });
      add.onsuccess = () => {
        for (const t of [1000, 11000, 21000]) transaction.objectStore('samples').add({ session_id: add.result, t, v: 5, a: 1, w: 5 });
      };
      transaction.oncomplete = () => database.close();
    };
    return true;
  })()`);
  await sleep(1000);

  // The next page load closes the cut-off test. Read the results in one evaluate.
  await send('Page.navigate', { url: `${baseUrl}/battery.html` });
  await sleep(2000);
  const recovered = await evaluate(`(() => {
    const row = [...document.querySelectorAll('#history-body tr')].find((r) => r.cells[0].textContent === 'Cut off');
    return {
      databaseReady: document.getElementById('db-error').hidden,
      duration: row ? row.cells[2].textContent : null,
      mah: row ? row.cells[3].textContent : null,
      log: document.getElementById('log').textContent,
      toast: document.querySelector('.toast-region')?.textContent || '',
      timer: App.timerKind(),
    };
  })()`);
  check('database is ready', recovered.databaseReady === true);
  check('a test that was cut off is closed on load', recovered.duration === '0:20' && recovered.mah === '6',
    `${recovered.duration} ${recovered.mah}`);
  check('the page tells about the recovered test', /was not finished/.test(recovered.log) && /cut off/.test(recovered.toast));
  check('polling uses the worker timer', recovered.timer === 'worker');

  // Poll at 1 Hz. Set a rated capacity so the efficiency shows.
  await evaluate(`
    document.querySelector('input[name="sample-interval"][value="1000"]').checked = true;
    document.getElementById('rated-mah').value = '10000';
    document.getElementById('nominal-v').value = '3.7';
    document.getElementById('stop-hold').value = '1';
    document.getElementById('session-name').value = 'E2E bank';
  `);
  await click('#connect');
  // Record with no reads on the busy page: 3 samples at 2 A, then current drops to 0 and the test auto-stops.
  await sleep(7000);

  // Open a fresh, idle page. It loads the saved sessions from IndexedDB.
  // This page opens the session view, so it is the last page: leaving it can stall headless Chrome.
  await send('Page.navigate', { url: `${baseUrl}/battery.html` });
  await sleep(2000);
  const history = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#history-body tr')];
    const row = rows.find((r) => r.cells[0].textContent === 'E2E bank');
    const cells = row ? [...row.querySelectorAll('td')].map((c) => c.textContent) : [];
    if (row) row.querySelector('button').click();
    return { rows: rows.length, name: cells[0], duration: cells[2], mah: Number(cells[3]) };
  })()`);
  check('auto test saved one session', history.rows === 2 && history.name === 'E2E bank', `rows=${history.rows}`);
  check('session auto-stopped with a duration', !!history.duration && history.duration !== '–', history.duration);
  check('charge is measured and stored', history.mah > 0, `mAh=${history.mah}`);

  await sleep(1200); // Let the async view render. The no-errors check below catches a render failure.
  check('page has no errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  browser.close();
  server.close();
}
await finish({ failureCount: checks.failureCount, outputDirectory });

// End-to-end test for battery.html. Serves the project over HTTP, drives the page with a mock serial
// port, records a short auto test, and checks the saved session in IndexedDB.
// Run: BROWSER_PATH=<chrome> node test/battery.e2e.mjs
//
// The capacity math has coverage in test/db.test.js. This test covers the IndexedDB store and the UI.
// It uses one synchronous DevTools evaluate per page, which is stable in headless Chrome.
// CI runs the unit tests and the meter test. Run this one with: BROWSER_PATH=<chrome> node test/battery.e2e.mjs
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const TC66 = require('../js/tc66.js');
const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.join(testDirectory, '..');
const browserPath = process.env.BROWSER_PATH;
if (!browserPath) throw new Error('Set BROWSER_PATH to a Chrome binary.');
const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tc66-batt-'));
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
  Object.defineProperty(navigator, 'serial', { value: {
    requestPort: async () => port, getPorts: async () => [port], addEventListener() {},
  }});
  window.confirm = () => true;
})();`;

// Minimal static file server rooted at the project directory.
const mimeTypes = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.wasm': 'application/wasm', '.json': 'application/json' };
const server = createServer((req, res) => {
  const urlPath = decodeURIComponent(req.url.split('?')[0]);
  const filePath = path.join(projectDirectory, urlPath === '/' ? 'index.html' : urlPath);
  if (!filePath.startsWith(projectDirectory) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
  fs.createReadStream(filePath).pipe(res);
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const baseUrl = `http://127.0.0.1:${server.address().port}`;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const chrome = spawn(browserPath, [
  '--headless', `--remote-debugging-port=${debugPort}`, '--no-sandbox', `--user-data-dir=${outputDirectory}/profile`, 'about:blank',
], { stdio: 'ignore' });
chrome.on('error', (error) => { console.error(`Cannot start Chrome: ${error.message}`); process.exit(1); });

let socket;
for (let attempt = 0; attempt < 150 && !socket; attempt++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const page = targets.find((t) => t.type === 'page');
    if (page) socket = new WebSocket(page.webSocketDebuggerUrl);
  } catch { /* not ready */ }
  if (!socket) await sleep(100);
}
if (!socket) { chrome.kill(); throw new Error('Chrome did not start.'); }
await new Promise((resolve) => socket.addEventListener('open', resolve));

let messageId = 0;
const pending = new Map();
const pageErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pending.has(message.id)) { pending.get(message.id)(message); pending.delete(message.id); }
  if (message.method === 'Runtime.exceptionThrown') pageErrors.push(message.params.exceptionDetails.exception?.description || message.params.exceptionDetails.text);
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') pageErrors.push(message.params.args.map((a) => a.value ?? a.description).join(' '));
});
process.on('unhandledRejection', (error) => { console.error('unhandled rejection:', error && error.message); });
const sendOnce = (method, params, timeoutMs) => new Promise((resolve, reject) => {
  const id = ++messageId;
  const timer = setTimeout(() => { pending.delete(id); reject(new Error(`CDP ${method} timed out`)); }, timeoutMs);
  pending.set(id, (message) => { clearTimeout(timer); resolve(message); });
  socket.send(JSON.stringify({ id, method, params }));
});
const send = (method, params = {}) => sendOnce(method, params, 15000);
// Do one Runtime.evaluate per navigation. A second evaluate in the same window can stall in headless Chrome.
const evaluate = async (expression) => {
  const reply = await sendOnce('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true }, 15000);
  if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result.result.value;
};
const textOf = (id) => evaluate(`document.getElementById('${id}').textContent`);
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);

let failures = 0;
const check = (name, passed, info = '') => { console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${info ? '  ' + info : ''}`); if (!passed) failures++; };

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.addScriptToEvaluateOnNewDocument', { source: mockSerialScript });
  await send('Page.navigate', { url: `${baseUrl}/battery.html` });
  await sleep(600); // Let the page load and open IndexedDB.

  check('database is ready', (await evaluate(`document.getElementById('db-error').hidden`)) === true);

  // Poll at 1 Hz. Set a rated capacity so the efficiency shows.
  await evaluate(`
    document.getElementById('sample-interval').value = '1000';
    document.getElementById('rated-mah').value = '10000';
    document.getElementById('nominal-v').value = '3.7';
    document.getElementById('stop-hold').value = '1';
    document.getElementById('session-name').value = 'E2E bank';
  `);
  await click('#connect');
  // Record with no reads on the busy page: 3 samples at 2 A, then current drops to 0 and the test auto-stops.
  await sleep(7000);

  // Open a fresh, idle page. It loads the saved session from IndexedDB.
  await send('Page.navigate', { url: `${baseUrl}/battery.html` });
  await sleep(2000);
  // Use a single synchronous evaluate (reliable in headless Chrome). It reads the history row and
  // opens the session view. viewSession renders asynchronously; a view error shows in the no-errors check.
  const history = await evaluate(`(() => {
    const rows = [...document.querySelectorAll('#history-body tr')];
    const cells = rows[0] ? [...rows[0].querySelectorAll('td')].map((c) => c.textContent) : [];
    if (rows[0]) rows[0].querySelector('button').click();
    return { rows: rows.length, name: cells[0], duration: cells[2], mah: Number(cells[3]), wh: cells[4] };
  })()`);
  check('auto test saved one session', history.rows === 1, `rows=${history.rows}`);
  check('session keeps its name', history.name === 'E2E bank', history.name);
  check('session auto-stopped with a duration', !!history.duration && history.duration !== '–', history.duration);
  check('charge is measured and stored', history.mah > 0, `mAh=${history.mah}`);
  check('saved test persists after reload', history.rows === 1);

  await sleep(1200); // Let the async view render. The no-errors check below catches a render failure.
  check('page has no errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  socket.close();
  chrome.kill();
  server.close();
}
if (failures || process.env.SCREENSHOT) console.log('output:', outputDirectory);
else { await sleep(500); fs.rmSync(outputDirectory, { recursive: true, force: true }); }
process.exit(failures ? 1 : 0);

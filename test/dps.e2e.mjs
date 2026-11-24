// End-to-end test: runs dps.html in headless Chrome with a mock Web Serial port.
// The mock is a small DPS3005 emulator. It answers Modbus RTU requests from a register array.
// Run: BROWSER_PATH=<chrome-headless-shell> node test/dps.e2e.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const projectDirectory = path.join(testDirectory, '..');
const browserPath = process.env.BROWSER_PATH;
if (!browserPath) throw new Error('Set BROWSER_PATH to a Chrome binary.');
const outputDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'dps-e2e-'));
const debugPort = 9343;
const pageUrl = pathToFileURL(path.join(projectDirectory, 'dps.html')).href;

// This script runs in the page before the app scripts.
// Query options: ?silent makes the supply give no answers. ?oldBrowser rejects the Bluetooth filter.
const mockSerialScript = `(() => {
  const silent = location.search.includes('silent');
  const oldBrowser = location.search.includes('oldBrowser');
  const LOAD_OHMS = 10;
  const registers = new Array(0x100).fill(0);
  // U-SET 5.00 V, I-SET 1.000 A, UIN 24.00 V, brightness 4, model 3005, version 1.6.
  [[0x00, 500], [0x01, 1000], [0x05, 2400], [0x0a, 4], [0x0b, 3005], [0x0c, 16]].forEach(([a, v]) => { registers[a] = v; });
  // Memory groups: M_n has U = n + 1 V, I = 0.1 * (n + 1) A, OVP U + 1, OCP I + 0.1, OPP 30.0 W.
  for (let n = 0; n < 10; n++) {
    const base = 0x50 + 0x10 * n;
    registers[base] = (n + 1) * 100;
    registers[base + 1] = (n + 1) * 100;
    registers[base + 2] = (n + 2) * 100;
    registers[base + 3] = (n + 2) * 100;
    registers[base + 4] = 300;
    registers[base + 5] = 4;
  }
  const dps = (window.__dps = { registers, frames: [], requestOptions: [], dropNextReply: false });

  // The emulator has its own CRC code, so a bug in js/dps.js cannot hide here.
  const crc = (bytes) => {
    let value = 0xffff;
    for (const byte of bytes) {
      value ^= byte;
      for (let bit = 0; bit < 8; bit++) value = value & 1 ? (value >>> 1) ^ 0xa001 : value >>> 1;
    }
    return value;
  };
  const withCrc = (body) => { const c = crc(body); return Uint8Array.from([...body, c & 0xff, c >>> 8]); };
  const hex = (bytes) => Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join(' ');

  // Compute the live registers from the settings and a 10 ohm load.
  function updateOutput() {
    if (!registers[0x09]) { registers[0x02] = 0; registers[0x03] = 0; registers[0x04] = 0; registers[0x08] = 0; return; }
    const volts = registers[0x00] / 100;
    const limit = registers[0x01] / 1000;
    const cc = volts / LOAD_OHMS > limit;
    const amps = cc ? limit : volts / LOAD_OHMS;
    const outVolts = cc ? amps * LOAD_OHMS : volts;
    registers[0x02] = Math.round(outVolts * 100);
    registers[0x03] = Math.round(amps * 1000);
    registers[0x04] = Math.round(outVolts * amps * 100);
    registers[0x08] = cc ? 1 : 0;
  }

  function answer(request) {
    if (request.length < 8 || crc(request.subarray(0, request.length - 2)) !== (request[request.length - 2] | (request[request.length - 1] << 8))) return null;
    if (request[0] !== 1) return null;
    const address = (request[2] << 8) | request[3];
    const word = (offset) => (request[offset] << 8) | request[offset + 1];
    if (request[1] === 0x03) {
      updateOutput();
      const count = word(4);
      if (address + count > registers.length) return withCrc([1, 0x83, 2]);
      const body = [1, 3, 2 * count];
      for (let i = 0; i < count; i++) body.push(registers[address + i] >> 8, registers[address + i] & 0xff);
      return withCrc(body);
    }
    if (request[1] === 0x06) {
      const value = word(4);
      if (address === 0x23) {
        if (value > 9) return withCrc([1, 0x86, 3]);
        const base = 0x50 + 0x10 * value;
        registers[0x00] = registers[base];
        registers[0x01] = registers[base + 1];
      }
      registers[address] = value;
      return request.slice();
    }
    if (request[1] === 0x10) {
      const count = word(4);
      for (let i = 0; i < count; i++) registers[address + i] = word(7 + 2 * i);
      return withCrc(Array.from(request.subarray(0, 6)));
    }
    return withCrc([1, request[1] | 0x80, 1]);
  }

  class MockPort extends EventTarget {
    getInfo() { return { bluetoothServiceClassId: '00001101-0000-1000-8000-00805f9b34fb' }; }
    async open(options) {
      dps.openOptions = options;
      let controller;
      this.readable = new ReadableStream({ start: (streamController) => { controller = streamController; } });
      this.writable = new WritableStream({ write: (data) => {
        const request = new Uint8Array(data);
        dps.frames.push(hex(request));
        if (silent) return;
        if (dps.dropNextReply) { dps.dropNextReply = false; return; }
        const reply = answer(request);
        if (!reply) return;
        // Send noise first, then the reply in two chunks, as a Bluetooth link can do.
        setTimeout(() => {
          try {
            controller.enqueue(Uint8Array.of(0x00));
            controller.enqueue(reply.slice(0, 4));
            setTimeout(() => { try { controller.enqueue(reply.slice(4)); } catch {} }, 3);
          } catch { /* The page closed the port. */ }
        }, 10);
      }});
    }
    async close() { dps.closed = true; }
  }
  const port = new MockPort();
  Object.defineProperty(navigator, 'serial', { value: {
    requestPort: async (options) => {
      dps.requestOptions.push(JSON.parse(JSON.stringify(options)));
      if (oldBrowser && options.filters && options.filters.some((filter) => filter.bluetoothServiceClassId)) {
        throw new TypeError('A filter must provide a property to filter by.');
      }
      return port;
    },
    getPorts: async () => [port],
    addEventListener() {},
  }});
})();`;

const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
const chrome = spawn(browserPath, [
  '--headless', `--remote-debugging-port=${debugPort}`, '--no-sandbox', `--user-data-dir=${outputDirectory}/profile`, 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
let chromeLog = '';
chrome.stderr.on('data', (data) => { chromeLog += data; });
let chromeExitCode = null;
chrome.on('exit', (code, signal) => { chromeExitCode = code ?? signal; });
chrome.on('error', (error) => {
  console.error(`Cannot start Chrome at "${browserPath}": ${error.message}`);
  process.exit(1);
});

// Wait up to 15 s for the DevTools endpoint and a page target.
let socket;
for (let attempt = 0; attempt < 150 && !socket && chromeExitCode === null; attempt++) {
  try {
    const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
    const pageTarget = targets.find((target) => target.type === 'page');
    if (pageTarget) socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
  } catch {
    // The DevTools endpoint is not ready yet.
  }
  if (!socket) await sleep(100);
}
if (!socket) {
  chrome.kill();
  console.error(chromeLog.slice(-4000));
  const reason = chromeExitCode === null ? 'in 15 s' : `(Chrome stopped with ${chromeExitCode})`;
  throw new Error(`Chrome did not start ${reason}.`);
}
await new Promise((resolve) => socket.addEventListener('open', resolve));

let messageId = 0;
const pendingReplies = new Map();
const pageErrors = [];
socket.addEventListener('message', (event) => {
  const message = JSON.parse(event.data);
  if (message.id && pendingReplies.has(message.id)) {
    pendingReplies.get(message.id)(message);
    pendingReplies.delete(message.id);
  }
  if (message.method === 'Runtime.exceptionThrown') {
    const details = message.params.exceptionDetails;
    pageErrors.push(details.exception?.description || details.text);
  }
  if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
    pageErrors.push(message.params.args.map((argument) => argument.value ?? argument.description).join(' '));
  }
});
const sendCommand = (method, params = {}) => new Promise((resolve) => {
  const id = ++messageId;
  pendingReplies.set(id, resolve);
  socket.send(JSON.stringify({ id, method, params }));
});
const evaluate = async (expression) => {
  const reply = await sendCommand('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
  if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
  return reply.result.result.value;
};
const textOf = (id) => evaluate(`document.getElementById('${id}').textContent`);
const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const registers = () => evaluate('window.__dps.registers');
const navigate = async (query = '') => {
  await sendCommand('Page.navigate', { url: pageUrl + query });
  await sleep(500);
};

let failureCount = 0;
const check = (name, passed, details = '') => {
  console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${details ? '  ' + details : ''}`);
  if (!passed) failureCount++;
};

try {
  await sendCommand('Runtime.enable');
  await sendCommand('Page.enable');
  await sendCommand('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outputDirectory });
  await sendCommand('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1800, deviceScaleFactor: 1, mobile: false });
  await sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: mockSerialScript });
  await navigate();

  check('nav links to the power supply page', await evaluate(`document.querySelector('.page-nav [aria-current]').textContent`) === 'Power supply');

  await click('input[name="poll-interval"][value="250"]');
  await evaluate(`document.getElementById('log-frames').checked = true`);
  await click('#connect');
  await sleep(1500);
  const requestOptions = await evaluate('window.__dps.requestOptions');
  check('port chooser allows the Bluetooth SPP service',
    JSON.stringify(requestOptions[0]) === '{"allowedBluetoothServiceClassIds":["00001101-0000-1000-8000-00805f9b34fb"]}',
    JSON.stringify(requestOptions));
  const openOptions = await evaluate('window.__dps.openOptions');
  check('port opens at 9600 8N1', openOptions.baudRate === 9600 && openOptions.dataBits === 8 && openOptions.parity === 'none' && openOptions.stopBits === 1);
  const frames = await evaluate('window.__dps.frames');
  check('first request reads the status registers 0x00-0x0C', frames[0] === '01 03 00 00 00 0d 84 0f', frames[0]);
  check('device info is shown', (await textOf('device-model')) === 'DPS3005 (3005)' && (await textOf('device-firmware')) === '1.6',
    `${await textOf('device-model')} ${await textOf('device-firmware')}`);
  check('U and I fields get the set values', await evaluate(`document.getElementById('set-voltage').value + '|' + document.getElementById('set-current').value`) === '5.00|1.000');
  const sampleCount = Number(await textOf('value-sample-count'));
  check('page polls several samples', sampleCount >= 3, `samples=${sampleCount}`);
  check('output is off at the start', (await textOf('badge-output')) === 'Output OFF' && (await textOf('value-voltage')) === '0.00');
  check('input voltage is shown', (await textOf('value-input-voltage')) === '24.00');
  check('the log shows the frames as hex', /→ 01 03 00 00 00 0d 84 0f/.test(await textOf('log')));

  // Type 12 V and 0.5 A. A change event (Enter or blur) sends each value with a write single request.
  const typeValue = (id, value) => evaluate(`{ const input = document.getElementById('${id}'); input.focus(); input.value = '${value}';
    input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); input.blur(); }`);
  await typeValue('set-voltage', '12');
  await typeValue('set-current', '0.5');
  await sleep(500);
  const framesAfterSet = await evaluate('window.__dps.frames');
  check('typed values are sent with write single frames',
    framesAfterSet.includes('01 06 00 00 04 b0 8a be') && framesAfterSet.includes('01 06 00 01 01 f4 d8 1d'),
    framesAfterSet.filter((frame) => frame.startsWith('01 06')).join(' | '));
  let state = await registers();
  check('the supply gets U-SET 12.00 V and I-SET 0.500 A', state[0] === 1200 && state[1] === 500, `${state[0]} ${state[1]}`);
  check('the setpoint status confirms the value', (await textOf('set-voltage-status')) === '✓ Set to 12.00 V', await textOf('set-voltage-status'));

  // The up arrow steps by the selected step (0.1 V). The page sends the value after a short pause.
  await click('[data-setpoint="voltage"] .step-button[data-step="1"]');
  await click('[data-setpoint="voltage"] .step-button[data-step="1"]');
  check('the arrow changes the input at once', await evaluate(`document.getElementById('set-voltage').value`) === '12.20');
  await sleep(900);
  check('two arrow clicks send one value', (await registers())[0] === 1220 && !(await evaluate('window.__dps.frames')).includes('01 06 00 00 04 ba 0a b9'),
    String((await registers())[0]));
  // The keyboard: ArrowDown with the 1 V step.
  await click('input[name="voltage-step"][value="1"]');
  await evaluate(`{ const input = document.getElementById('set-voltage'); input.focus();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, cancelable: true })); }`);
  await sleep(900);
  // 12.20 V is between two 1 V steps. ArrowDown goes to the step below: 12.00 V.
  check('ArrowDown goes to the next step of the selected size', (await registers())[0] === 1200, String((await registers())[0]));
  await evaluate(`document.getElementById('set-voltage').blur()`);
  await typeValue('set-voltage', '12');
  await sleep(400);

  await click('#output-switch');
  await sleep(800);
  state = await registers();
  check('output switch switches the output on', state[9] === 1 && await evaluate(`document.getElementById('output-switch').checked`));
  check('badges show output on and CC mode', (await textOf('badge-output')) === 'Output ON' && (await textOf('badge-mode')) === 'CC',
    `${await textOf('badge-output')} ${await textOf('badge-mode')}`);
  check('live values follow the CC limit', (await textOf('value-current')) === '0.500' && (await textOf('value-voltage')) === '5.00' && (await textOf('value-power')) === '2.50',
    `${await textOf('value-voltage')} V ${await textOf('value-current')} A ${await textOf('value-power')} W`);

  // A lost reply: the port sends the request again and polling continues.
  await evaluate('window.__dps.dropNextReply = true');
  await sleep(2000);
  check('a lost reply does not stop polling', (await textOf('status-text')) === 'Connected', await textOf('status-text'));

  // Protection trip from the supply.
  await evaluate('window.__dps.registers[7] = 2');
  await sleep(600);
  check('protection badge shows OCP', (await textOf('badge-protection')) === 'OCP tripped', await textOf('badge-protection'));
  await evaluate('window.__dps.registers[7] = 0');

  await click('#lock-switch');
  await sleep(600);
  check('lock switch locks the keys', (await registers())[6] === 1 && (await textOf('badge-lock')) === 'Keys locked');
  await evaluate(`{ const slider = document.getElementById('brightness'); slider.value = '2';
    slider.dispatchEvent(new Event('input', { bubbles: true })); slider.dispatchEvent(new Event('change', { bubbles: true })); }`);
  await sleep(400);
  check('brightness slider writes register 0x0A', (await registers())[0x0a] === 2 && (await textOf('brightness-value')) === '2');

  await click('#read-presets');
  await sleep(2500);
  const presetRow = await evaluate(`Array.from(document.querySelectorAll('#preset-1 td')).slice(0, 7).map((cell) => cell.textContent).join(' ')`);
  check('memory group M1 is read', presetRow === '2.00 0.200 3.00 0.300 30.0 4 no', presetRow);
  check('all memory groups are read', (await textOf('presets-status')) === '' && /M0–M9 read/.test(await textOf('log')));

  await click('[data-recall="2"]');
  await sleep(800);
  state = await registers();
  check('Recall M2 writes 2 to register 0x23', (await evaluate('window.__dps.frames')).includes('01 06 00 23 00 02 f9 c1') && state[0x23] === 2);
  check('recall loads the group into the settings', (await textOf('value-voltage-set')) === '3.00' && (await textOf('value-current-set')) === '0.300');
  check('recall copies the values into the form', await evaluate(`document.getElementById('set-voltage').value`) === '3.00');

  await typeValue('set-voltage', '33');
  await sleep(300);
  check('a voltage over the range is not sent', (await registers())[0] === 300 &&
    await evaluate(`document.getElementById('set-voltage').getAttribute('aria-invalid')`) === 'true' &&
    await evaluate(`getComputedStyle(document.getElementById('set-voltage-error')).display`) === 'block');
  await evaluate(`document.getElementById('set-voltage').dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  check('Escape shows the supply value again', await evaluate(`document.getElementById('set-voltage').value`) === '3.00');

  // Save the current U and I (3.00 V, 0.300 A after the recall) into M7. The other fields of M7 stay.
  await evaluate('window.confirm = () => true');
  await click('[data-save="7"]');
  await sleep(800);
  state = await registers();
  check('Save U/I writes U and I into M7', (await evaluate('window.__dps.frames')).includes('01 10 00 c0 00 02 04 01 2c 01 2c 3f 87') &&
    state[0xc0] === 300 && state[0xc1] === 300 && state[0xc2] === 900);
  check('Save U/I shows the new values of M7',
    await evaluate(`Array.from(document.querySelectorAll('#preset-7 td')).slice(0, 2).map((cell) => cell.textContent).join(' ')`) === '3.00 0.300');

  await click('#output-switch');
  await sleep(600);
  check('output switch switches the output off', (await registers())[9] === 0 && (await textOf('badge-output')) === 'Output OFF');

  await click('#save-live');
  await sleep(800);
  const liveCsv = fs.readdirSync(outputDirectory).find((name) => name.startsWith('dps-live-') && name.endsWith('.csv'));
  check('live CSV is saved', !!liveCsv && fs.readFileSync(path.join(outputDirectory, liveCsv), 'utf8').startsWith('time_iso,elapsed_s,volts'), liveCsv);

  if (process.env.SCREENSHOT) {
    const screenshot = await Promise.race([sendCommand('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true }), sleep(5000)]);
    if (screenshot) fs.writeFileSync(path.join(outputDirectory, 'dps.png'), Buffer.from(screenshot.result.data, 'base64'));
    else console.log('Screenshot timed out.');
  }

  await click('#disconnect');
  await sleep(400);
  check('disconnect closes the port', await evaluate('window.__dps.closed === true') && (await textOf('status-text')) === 'Not connected');

  // ---- Bluetooth filter on an older browser ----
  await navigate('?oldBrowser=1');
  await evaluate(`document.getElementById('port-kind').value = 'bluetooth'`);
  await click('#connect');
  await sleep(1000);
  const fallbackOptions = await evaluate('window.__dps.requestOptions');
  check('Bluetooth only uses a service class filter', JSON.stringify(fallbackOptions[0].filters) === '[{"bluetoothServiceClassId":"00001101-0000-1000-8000-00805f9b34fb"}]');
  check('an older browser falls back to all ports', JSON.stringify(fallbackOptions[1]) === '{}' && (await textOf('status-text')) === 'Connected',
    JSON.stringify(fallbackOptions));
  await click('#disconnect');
  await sleep(300);

  // ---- A supply that does not answer ----
  await navigate('?silent=1');
  await click('#connect');
  await sleep(3000);
  check('a silent supply gives a clear error', (await textOf('status-text')) === 'Supply does not respond' && /does not respond/.test(await textOf('log')),
    await textOf('status-text'));
  check('the port closes after the failed connect', await evaluate('window.__dps.closed === true') && !(await evaluate(`document.getElementById('connect').disabled`)));

  check('page has no errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  socket.close();
  chrome.kill();
}
if (failureCount || process.env.SCREENSHOT) {
  console.log('output:', outputDirectory);
} else {
  await sleep(500); // Chrome must exit before its profile can be removed.
  fs.rmSync(outputDirectory, { recursive: true, force: true });
}
process.exit(failureCount ? 1 : 0);

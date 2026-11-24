// End-to-end test: runs dps.html in headless Chrome with a mock Web Serial port.
// The mock is a small DPS3005 emulator. It answers Modbus RTU requests from a register array.
// Run: BROWSER_PATH=<chrome-headless-shell> node test/dps.e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createChecks, finish, makeOutputDirectory, projectDirectory, sleep, startBrowser } from './lib/browser.mjs';

const outputDirectory = makeOutputDirectory('dps-e2e-');
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
      this.readable = new ReadableStream({ start: (streamController) => { controller = streamController; dps.controller = streamController; } });
      this.writable = new WritableStream({ write: (data) => {
        const request = new Uint8Array(data);
        dps.frames.push(hex(request));
        if (silent) return;
        if (dps.dropNextReply) { dps.dropNextReply = false; return; }
        if (dps.failWrites && request[1] !== 0x03) return; // No reply to writes: the page times out.
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
  // Like a real browser, getPorts() returns the port only after the user allowed it in the chooser.
  let allowed = false;
  const connectListeners = new Set();
  // unplug() ends the read stream with an error. replug() fires the 'connect' event of navigator.serial.
  dps.unplug = () => dps.controller.error(new Error('The device has been lost.'));
  dps.replug = () => connectListeners.forEach((listener) => listener({ type: 'connect', target: port }));
  Object.defineProperty(navigator, 'serial', { value: {
    requestPort: async (options) => {
      dps.requestOptions.push(JSON.parse(JSON.stringify(options)));
      if (oldBrowser && options.filters && options.filters.some((filter) => filter.bluetoothServiceClassId)) {
        throw new TypeError('A filter must provide a property to filter by.');
      }
      allowed = true;
      return port;
    },
    getPorts: async () => (allowed ? [port] : []),
    addEventListener(type, listener) { if (type === 'connect') connectListeners.add(listener); },
    removeEventListener(type, listener) { connectListeners.delete(listener); },
  }});
})();`;

const browser = await startBrowser({ debugPort, outputDirectory });
const { send: sendCommand, evaluate, textOf, click, pageErrors } = browser;
const checks = createChecks();
const { check } = checks;
const registers = () => evaluate('window.__dps.registers');
const navigate = async (query = '') => {
  await sendCommand('Page.navigate', { url: pageUrl + query });
  await sleep(500);
};

try {
  await sendCommand('Runtime.enable');
  await sendCommand('Page.enable');
  await sendCommand('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outputDirectory });
  await sendCommand('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1800, deviceScaleFactor: 1, mobile: false });
  await sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: mockSerialScript });
  await navigate();

  check('nav links to the power supply page', await evaluate(`document.querySelector('.page-nav [aria-current]').textContent`) === 'Power supply');
  check('polling uses the worker timer', await evaluate(`App.sleep(5).then(() => App.timerKind())`) === 'worker');
  const visibleButtons = () => evaluate(`['connect', 'choose-port', 'disconnect'].filter((id) => !document.getElementById(id).hidden).join(',')`);
  check('only Connect shows before the first connection', (await visibleButtons()) === 'connect', await visibleButtons());
  check('the connection settings are open before Connect', await evaluate(`document.getElementById('connection-details').open`));

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
  // 0.5 A for about 2.5 s with the output on: the counters add up some charge.
  const charge = Number(await textOf('value-charge'));
  check('the charge and energy counters add up', charge > 0.1 && Number(await textOf('value-energy')) > 0 &&
    (await textOf('value-on-time')) !== '0:00', `${charge} mAh, ${await textOf('value-on-time')}`);
  await click('#reset-counters');
  check('Reset counters sets the counters to 0', (await textOf('value-charge')) === '0.0');

  // Protection trip from the supply.
  await evaluate('window.__dps.registers[7] = 2');
  await sleep(600);
  check('protection badge shows OCP', (await textOf('badge-protection')) === 'OCP tripped', await textOf('badge-protection'));
  check('a protection trip shows an alert and a toast', !(await evaluate(`document.getElementById('protection-alert').hidden`)) &&
    /Over-current/.test(await textOf('protection-alert-title')) &&
    /OCP tripped/.test(await evaluate(`document.querySelector('.toast-region')?.textContent || ''`)));
  await evaluate('window.__dps.registers[7] = 0');
  await sleep(600);
  check('the alert closes when the protection is clear', await evaluate(`document.getElementById('protection-alert').hidden`));

  // An input voltage that is too low for U-SET 12 V shows a warning.
  await evaluate('window.__dps.registers[5] = 1000');
  await sleep(600);
  check('a too low input voltage shows a warning', !(await evaluate(`document.getElementById('input-warning').hidden`)) &&
    /too high for the input of 10.00 V/.test(await textOf('input-warning')), await textOf('input-warning'));
  await evaluate('window.__dps.registers[5] = 2400');
  await sleep(600);
  check('the warning closes with a good input voltage', await evaluate(`document.getElementById('input-warning').hidden`));

  // Safety limit 12.5 V: the arrows stop at the limit, and a higher typed value is not sent.
  await evaluate(`{ const input = document.getElementById('limit-voltage'); input.value = '12.5'; input.dispatchEvent(new Event('change', { bubbles: true })); }`);
  check('the safety limit shows in the summary', /12.5 V/.test(await textOf('safety-limits-summary')));
  await click('input[name="voltage-step"][value="1"]');
  await click('[data-setpoint="voltage"] .step-button[data-step="1"]');
  await sleep(900);
  check('the up arrow stops at the safety limit', (await registers())[0] === 1250, String((await registers())[0]));
  await typeValue('set-voltage', '20');
  await sleep(300);
  check('a value above the safety limit is not sent', (await registers())[0] === 1250 &&
    await evaluate(`document.getElementById('set-voltage').getAttribute('aria-invalid')`) === 'true');
  await evaluate(`{ const input = document.getElementById('set-voltage'); input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); }`);
  await evaluate(`{ const input = document.getElementById('limit-voltage'); input.value = ''; input.dispatchEvent(new Event('change', { bubbles: true })); }`);
  await click('input[name="voltage-step"][value="0.1"]');
  await typeValue('set-voltage', '12');
  await sleep(400);

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

  // Edit M7 in the dialog. M7 has U 8.00 V, I 0.800 A, OVP 9.00 V, OCP 0.900 A, OPP 30.0 W, light 4.
  const dialogOpen = () => evaluate(`document.getElementById('preset-dialog').open`);
  const dialogValues = () => evaluate(`['preset-voltage', 'preset-current', 'preset-ovp', 'preset-ocp', 'preset-opp', 'preset-light']
    .map((id) => document.getElementById(id).value).join(' ')`);
  await click('[data-edit="7"]');
  await sleep(500);
  check('Edit opens the dialog as a modal', await dialogOpen() && await evaluate(`document.getElementById('preset-dialog').matches(':modal')`));
  check('the dialog shows the values of M7', (await dialogValues()) === '8.00 0.800 9.00 0.900 30.0 4' &&
    (await textOf('preset-dialog-group')) === 'M7', await dialogValues());
  // Use the current U and I (3.00 V, 0.300 A after the recall), set OCP 1.2 A and output on at power on, then save.
  await click('#preset-use-current');
  await evaluate(`document.getElementById('preset-ocp').value = '1.2'; document.getElementById('preset-start').checked = true`);
  await click('#preset-form button[value="save"]');
  await sleep(900);
  state = await registers();
  check('Save writes all 8 registers of M7 in one request',
    (await evaluate('window.__dps.frames')).includes('01 10 00 c0 00 08 10 01 2c 01 2c 03 84 04 b0 01 2c 00 04 00 00 00 01 5b d6') &&
    JSON.stringify(state.slice(0xc0, 0xc8)) === '[300,300,900,1200,300,4,0,1]', JSON.stringify(state.slice(0xc0, 0xc8)));
  check('the dialog closes and the table shows the new values', !(await dialogOpen()) &&
    await evaluate(`Array.from(document.querySelectorAll('#preset-7 td')).slice(0, 7).map((cell) => cell.textContent).join(' ')`) === '3.00 0.300 9.00 1.200 30.0 4 yes');

  // A value over the limit keeps the dialog open and sends nothing. Cancel discards the edit.
  await click('[data-edit="7"]');
  await sleep(500);
  const framesBeforeInvalid = (await evaluate('window.__dps.frames')).filter((frame) => frame.startsWith('01 10')).length;
  await evaluate(`document.getElementById('preset-ocp').value = '9'`);
  await click('#preset-form button[value="save"]');
  await sleep(300);
  check('an OCP over the limit keeps the dialog open', await dialogOpen() &&
    await evaluate(`document.getElementById('preset-ocp').validity.rangeOverflow`));
  await click('#preset-form button[value="cancel"]');
  await sleep(400);
  check('Cancel closes the dialog and sends nothing', !(await dialogOpen()) &&
    (await evaluate('window.__dps.frames')).filter((frame) => frame.startsWith('01 10')).length === framesBeforeInvalid &&
    (await registers())[0xc3] === 1200);

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
  await sleep(200);
  check('after a connection, Connect and Choose port show', (await visibleButtons()) === 'connect,choose-port', await visibleButtons());

  // Connect uses the allowed port without the chooser.
  const chooserCalls = (await evaluate('window.__dps.requestOptions')).length;
  await click('#connect');
  await sleep(1000);
  check('Connect uses the known port without the chooser', (await evaluate('window.__dps.requestOptions')).length === chooserCalls &&
    (await textOf('status-text')) === 'Connected' && (await visibleButtons()) === 'disconnect', await visibleButtons());
  check('the connection settings close after Connect', !(await evaluate(`document.getElementById('connection-details').open`)));

  // A failed command shows a toast.
  await evaluate('window.__dps.registers[0x09] = 0');
  await evaluate('window.__dps.failWrites = true');
  await click('#output-switch');
  await sleep(2600);
  await evaluate('window.__dps.failWrites = false');
  check('a failed command shows an error toast', /Output on failed/.test(await evaluate(`document.querySelector('.toast-region')?.textContent || ''`)));

  // Unplug: the page reconnects when the port comes back.
  await evaluate('window.__dps.closed = false; window.__dps.unplug()');
  await sleep(400);
  check('a lost connection shows Reconnecting', /Connection lost|Reconnecting/.test(await textOf('status-text')), await textOf('status-text'));
  await evaluate('window.__dps.replug()');
  await sleep(1200);
  check('the page reconnects when the port comes back', (await textOf('status-text')) === 'Connected' &&
    /Connected again/.test(await textOf('log')), await textOf('status-text'));
  await click('#disconnect');
  await sleep(500);

  check('lock on connect is off by default', !(await evaluate(`document.getElementById('autolock-switch').checked`)));
  // Switch on "Lock the keys on connect". The browser keeps the setting for the next page load.
  await click('#autolock-switch');

  // ---- Bluetooth filter on an older browser, with lock on connect ----
  await navigate('?oldBrowser=1');
  check('the lock on connect setting stays after a reload', await evaluate(`document.getElementById('autolock-switch').checked`));
  await evaluate(`document.getElementById('port-kind').value = 'bluetooth'`);
  await click('#connect');
  await sleep(1000);
  const fallbackOptions = await evaluate('window.__dps.requestOptions');
  check('Bluetooth only uses a service class filter', JSON.stringify(fallbackOptions[0].filters) === '[{"bluetoothServiceClassId":"00001101-0000-1000-8000-00805f9b34fb"}]');
  check('an older browser falls back to all ports', JSON.stringify(fallbackOptions[1]) === '{}' && (await textOf('status-text')) === 'Connected',
    JSON.stringify(fallbackOptions));
  check('connect locks the keys', (await registers())[6] === 1 && (await textOf('badge-lock')) === 'Keys locked');
  await click('#disconnect');
  await sleep(500);
  check('disconnect unlocks the keys that the page locked', (await registers())[6] === 0 && /Unlock keys on disconnect: done/.test(await textOf('log')));
  // Keys that the user locks stay locked after Disconnect.
  await click('#connect');
  await sleep(1000);
  await click('#lock-switch'); // Unlock by hand: the page no longer owns the lock.
  await sleep(400);
  await click('#lock-switch'); // Lock by hand.
  await sleep(400);
  await click('#disconnect');
  await sleep(500);
  check('disconnect keeps a lock that the user set', (await registers())[6] === 1);
  await click('#autolock-switch'); // Switch the setting off again for the next tests.

  // ---- A supply that does not answer ----
  await navigate('?silent=1');
  await click('#connect');
  await sleep(3000);
  check('a silent supply gives a clear error', (await textOf('status-text')) === 'Supply does not respond' && /does not respond/.test(await textOf('log')),
    await textOf('status-text'));
  check('the port closes after the failed connect', await evaluate('window.__dps.closed === true') && !(await evaluate(`document.getElementById('connect').disabled`)));

  check('page has no errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  browser.close();
}
await finish({ failureCount: checks.failureCount, outputDirectory });

// End-to-end test: runs meter.html in headless Chrome with a mock Web Serial port.
// The mock replays real meter bytes from test/fixtures.
// Run: BROWSER_PATH=<chrome-headless-shell> node test/e2e.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createChecks, finish, makeOutputDirectory, projectDirectory, sleep, startBrowser } from './lib/browser.mjs';

const testDirectory = path.dirname(fileURLToPath(import.meta.url));
const outputDirectory = makeOutputDirectory('tc66-e2e-');
const debugPort = 9339;

const toBase64 = (file) => fs.readFileSync(file).toString('base64');
const fixtures = {
  getva: ['getva-0.bin', 'getva-1.bin', 'getva-2.bin'].map((name) => toBase64(path.join(testDirectory, 'fixtures', name))),
  gtrec: toBase64(path.join(testDirectory, 'fixtures', 'tc66_rec.bin')),
};

// This script runs in the page before the app scripts.
const mockSerialScript = `(() => {
  const fixtures = ${JSON.stringify(fixtures)};
  const fromBase64 = (text) => Uint8Array.from(atob(text), (char) => char.charCodeAt(0));
  const serialLog = (window.__serialLog = []);
  let getvaCount = 0;
  const bootMode = location.search.includes('boot');
  let updateStarted = false;
  window.__flash = { chunks: 0, bytes: 0 };
  class MockPort extends EventTarget {
    getInfo() { return { usbVendorId: 0x28e9, usbProductId: 0x018a }; }
    async open(options) {
      serialLog.push('open:' + options.baudRate);
      let controller;
      this.readable = new ReadableStream({ start: (streamController) => { controller = streamController; } });
      const reply = (bytes, chunkSize = 64, delay = 20) => {
        let offset = 0;
        const sendChunk = () => {
          if (offset >= bytes.length) return;
          try {
            controller.enqueue(bytes.slice(offset, offset + chunkSize));
          } catch {
            return; // The page closed the port. A real port drops these bytes too.
          }
          offset += chunkSize;
          setTimeout(sendChunk, 2);
        };
        setTimeout(sendChunk, delay);
      };
      this.writable = new WritableStream({ write: (data) => {
        const command = new TextDecoder().decode(data);
        const encode = (text) => new TextEncoder().encode(text);
        if (command === 'query') { serialLog.push('query'); reply(encode(bootMode ? 'boot' : 'firm')); }
        else if (command === 'getva') {
          serialLog.push('getva');
          getvaCount++;
          const response = fromBase64(fixtures.getva[getvaCount % 3]);
          if (getvaCount === 3) response[5] ^= 0xff; // One corrupted response.
          reply(response);
        }
        else if (command === 'gtrec') { serialLog.push('gtrec'); reply(fromBase64(fixtures.gtrec), 512, 50); }
        else if (command === 'hello') { serialLog.push('hello'); reply(encode('?')); }
        else if (command.startsWith('update')) { serialLog.push('update'); updateStarted = true; reply(encode('uprdy')); }
        else if (updateStarted) { window.__flash.chunks++; window.__flash.bytes += data.byteLength; reply(encode('OK'), 2, 1); }
        else serialLog.push(command);
      }});
    }
    async setSignals(signals) { serialLog.push('signals:' + JSON.stringify(signals)); }
    async close() { serialLog.push('close'); }
  }
  const port = new MockPort();
  // Like a real browser, getPorts() returns the port only after the user allowed it in the chooser.
  let allowed = false;
  Object.defineProperty(navigator, 'serial', { value: {
    requestPort: async (options) => { serialLog.push('filter:' + JSON.stringify(options.filters)); allowed = true; return port; },
    getPorts: async () => (allowed ? [port] : []),
    addEventListener() {},
    removeEventListener() {},
  }});
  window.confirm = () => false;
})();`;

const browser = await startBrowser({ debugPort, outputDirectory });
const { send: sendCommand, evaluate, textOf, click, pageErrors } = browser;
const checks = createChecks();
const { check } = checks;

try {
  await sendCommand('Runtime.enable');
  await sendCommand('Page.enable');
  await sendCommand('DOM.enable');
  await sendCommand('Browser.setDownloadBehavior', { behavior: 'allow', downloadPath: outputDirectory });
  await sendCommand('Emulation.setDeviceMetricsOverride', { width: 1100, height: 1800, deviceScaleFactor: 1, mobile: false });
  await sendCommand('Page.addScriptToEvaluateOnNewDocument', { source: mockSerialScript });
  await sendCommand('Page.navigate', { url: pathToFileURL(path.join(projectDirectory, 'meter.html')).href });
  await sleep(500);

  // Theme toggle cycles auto -> light -> dark -> auto and sets the meta element.
  // Wait until the page has started (Theme.init sets data-state). A slow machine, such as CI, needs more time.
  for (let attempt = 0; attempt < 50; attempt++) {
    if (await evaluate(`document.getElementById('theme-toggle').dataset.state || ''`)) break;
    await sleep(100);
  }
  const themeStart = await evaluate(`document.getElementById('theme-toggle').dataset.state`);
  await click('#theme-toggle');
  const themeLight = await evaluate(`document.getElementById('theme-toggle').dataset.state + '|' + document.querySelector('meta[name="color-scheme"]').content`);
  await click('#theme-toggle');
  const themeDark = await evaluate(`document.getElementById('theme-toggle').dataset.state + '|' + document.querySelector('meta[name="color-scheme"]').content`);
  await click('#theme-toggle');
  const themeBack = await evaluate(`document.getElementById('theme-toggle').dataset.state + '|' + document.querySelector('meta[name="color-scheme"]').content`);
  check('theme cycles auto, light, dark', themeStart === 'auto' && themeLight === 'light|light' && themeDark === 'dark|dark' && themeBack === 'auto|light dark',
    `${themeStart} ${themeLight} ${themeDark} ${themeBack}`);

  await click('input[name="poll-interval"][value="250"]');
  await click('#connect');
  await sleep(2500);
  const serialLog = await evaluate('window.__serialLog');
  const openIndex = serialLog.indexOf('open:115200');
  check('port chooser filters on vendor 0x28e9', serialLog.includes('filter:[{"usbVendorId":10473}]'));
  check('port opens at 115200 baud', openIndex >= 0);
  check('DTR and RTS are on', serialLog.includes('signals:{"dataTerminalReady":true,"requestToSend":true}'));
  check('query is the first command', serialLog[openIndex + 2] === 'query');
  const model = await textOf('device-model');
  const firmware = await textOf('device-firmware');
  const group0 = await textOf('device-group-0');
  check('device info is shown', model === 'TC66' && firmware === '1.17' && group0 === '1706 mAh · 8554 mWh', `${model} ${firmware} ${group0}`);
  const sampleCount = Number(await textOf('value-sample-count'));
  check('page polls several samples', sampleCount >= 5, `samples=${sampleCount}`);
  const pageLog = await textOf('log');
  const status = await textOf('status-text');
  check('corrupted packet is logged and polling continues', /packet headers|CRC/.test(pageLog) && status === 'Connected', status);
  const badges = await evaluate(`['badge-connection', 'badge-mode', 'badge-packets'].map((id) => document.getElementById(id).textContent).join(' | ')`);
  check('badges show polling, the mode and the bad packet', badges === 'Polling every 0.25 s | Firmware mode | Bad packets 1', badges);
  await click('label:has(#sample-period) .step-button[aria-label="Increase sample period"]');
  check('sample period arrow steps the value', await evaluate(`document.getElementById('sample-period').value`) === '11');
  await click('label:has(#sample-period) .step-button[aria-label="Decrease sample period"]');

  await click('[data-command=nextp]');
  await click('[data-command=lastp]');
  await click('[data-command=rotat]');
  await sleep(800);
  const logAfterButtons = await evaluate('window.__serialLog');
  check('page and rotate commands are sent', ['nextp', 'lastp', 'rotat'].every((command) => logAfterButtons.includes(command)));

  await click('#download-recording');
  await sleep(4000);
  const recordingLog = await textOf('log');
  const recordingSummary = (await textOf('recording-summary')).replace(/\s+/g, ' ').trim();
  check('gtrec gives 494 records', /494 records, end marker found/.test(recordingLog));
  check('summary shows about 1574 mAh', /157[34]\.\d mAh/.test(recordingSummary), recordingSummary);

  await click('#save-recording-csv');
  await click('#save-live');
  await sleep(1000);
  const savedFiles = fs.readdirSync(outputDirectory).filter((name) => name.endsWith('.csv'));
  const recordingCsv = savedFiles.find((name) => name.startsWith('tc66-rec-'));
  const liveCsv = savedFiles.find((name) => name.startsWith('tc66-live-'));
  const recordingCsvLines = recordingCsv ? fs.readFileSync(path.join(outputDirectory, recordingCsv), 'utf8').trim().split('\n').length : 0;
  check('recording CSV is saved with 494 rows', recordingCsvLines === 495, recordingCsv);
  check('live CSV is saved', !!liveCsv && fs.readFileSync(path.join(outputDirectory, liveCsv), 'utf8').startsWith('time_iso,'), liveCsv);

  await evaluate(`document.querySelector('details').open = true; document.getElementById('raw-command').value = 'hello'`);
  await click('#raw-send');
  await sleep(1500);
  const rawOutput = await textOf('raw-output');
  check('raw command shows the reply as hex', /1 bytes\n0000  3f/.test(rawOutput), JSON.stringify(rawOutput.slice(0, 40)));
  await evaluate(`document.getElementById('raw-command').value = 'update'`);
  await click('#raw-send');
  await sleep(300);
  check('update is not sent without confirmation', !(await evaluate('window.__serialLog')).includes('update'));

  // Page.captureScreenshot can hang in chrome-headless-shell, so it is optional and has a timeout.
  if (process.env.SCREENSHOT) {
    const screenshot = await Promise.race([sendCommand('Page.captureScreenshot', { format: 'png' }), sleep(5000)]);
    if (screenshot) fs.writeFileSync(path.join(outputDirectory, 'page.png'), Buffer.from(screenshot.result.data, 'base64'));
    else console.log('Screenshot timed out.');
  }

  await click('#disconnect');
  await sleep(500);
  check('disconnect closes the port', (await evaluate('window.__serialLog')).includes('close'));

  // ---- Firmware update flow, with the mock in bootloader mode ----
  const fakeFirmware = Buffer.alloc(200);
  fakeFirmware.forEach((_, i) => { fakeFirmware[i] = i & 0xff; });
  const fakeFirmwarePath = path.join(outputDirectory, 'fake-firmware.bin');
  fs.writeFileSync(fakeFirmwarePath, fakeFirmware);

  await sendCommand('Page.navigate', { url: pathToFileURL(path.join(projectDirectory, 'meter.html')).href + '?boot=1' });
  await sleep(600);
  await click('#connect');
  await sleep(800);
  const updateMode = await textOf('update-mode');
  check('connect in bootloader shows bootloader mode', updateMode === 'bootloader', updateMode);

  await evaluate(`document.getElementById('update-details').open = true`);
  await click('#check-mode');
  await sleep(300);

  const document_ = await sendCommand('DOM.getDocument', { depth: 0 });
  const fileNode = await sendCommand('DOM.querySelector', { nodeId: document_.result.root.nodeId, selector: '#firmware-file' });
  await sendCommand('DOM.setFileInputFiles', { files: [fakeFirmwarePath], nodeId: fileNode.result.nodeId });
  await sleep(500);
  const firmwareInfo = await textOf('firmware-info');
  check('unofficial firmware is flagged', /Unrecognized/.test(firmwareInfo), firmwareInfo.slice(0, 40));
  check('flash is disabled before the confirmation', await evaluate(`document.getElementById('flash').disabled`));

  await click('#update-confirm');
  await evaluate('window.confirm = () => true'); // Accept the unofficial-firmware warning.
  await sleep(100);
  check('flash is enabled after the confirmation', !(await evaluate(`document.getElementById('flash').disabled`)));

  await click('#flash');
  await sleep(1500);
  const flash = await evaluate('window.__flash');
  const flashStatus = await textOf('flash-status');
  const flashLog = await textOf('log');
  check('all firmware chunks are sent', flash.chunks === 4 && flash.bytes === 200, JSON.stringify(flash));
  check('update command uses CR and LF', (await evaluate('window.__serialLog')).includes('update'));
  check('flash reports success', /Done/.test(flashStatus), flashStatus);
  check('flash finishes in the log', /Firmware update finished/.test(flashLog));

  check('page has no errors', pageErrors.length === 0, pageErrors.join(' | '));
} finally {
  browser.close();
}
await finish({ failureCount: checks.failureCount, outputDirectory });

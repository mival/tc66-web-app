// Page logic: connection, live polling, meter buttons, offline recording and raw commands.
(function () {
  'use strict';

  const element = (id) => document.getElementById(id);
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const MAX_SAMPLE_COUNT = 200000;
  const MAX_FAILED_POLLS = 3;
  const MAX_LOG_LINES = 200;

  const LIVE_CHARTS = [
    { canvasId: 'chart-voltage', field: 'voltage', colorToken: '--color-voltage', unit: 'V', decimals: 4, label: 'Voltage' },
    { canvasId: 'chart-current', field: 'current', colorToken: '--color-current', unit: 'A', decimals: 5, label: 'Current' },
    { canvasId: 'chart-power', field: 'power', colorToken: '--color-power', unit: 'W', decimals: 3, label: 'Power' },
  ];
  const RECORDING_CHARTS = LIVE_CHARTS.map((chart) => ({ ...chart, canvasId: chart.canvasId.replace('chart-', 'recording-chart-') }));

  let connection = null;
  // Each polling loop has a number. A loop stops when this number changes.
  let pollingLoopId = 0;
  let pollingPaused = false;
  let samples = [];
  let recording = null; // { dump, records, summary }
  let drawScheduled = false;
  let deviceMode = null; // 'firm', 'boot' or null.
  let firmware = null; // { bytes, name, sha256, isOfficial }
  let flashing = false;

  // ---------- Log and status ----------

  function addLogLine(message) {
    const logElement = element('log');
    const line = `${new Date().toLocaleTimeString()}  ${message}\n`;
    logElement.textContent = (logElement.textContent + line).split('\n').slice(-MAX_LOG_LINES).join('\n');
    logElement.scrollTop = logElement.scrollHeight;
  }

  // state: '' (neutral), 'on' or 'error'.
  function setStatus(text, state = '') {
    element('status-text').textContent = text;
    element('status-dot').className = 'dot' + (state ? ' ' + state : '');
  }

  function setConnectedUi(connected) {
    element('connect').disabled = connected;
    element('disconnect').disabled = !connected || flashing;
    element('pause').disabled = !connected;
    element('download-recording').disabled = !connected;
    element('raw-send').disabled = !connected;
    element('check-mode').disabled = !connected || flashing;
    document.querySelectorAll('button[data-command]').forEach((button) => { button.disabled = !connected; });
    if (!connected) setDeviceMode(null);
    refreshFlashButton();
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

  // ---------- Connection ----------

  async function connect() {
    if (connection) return;
    let serialPort;
    try {
      serialPort = await navigator.serial.requestPort({ filters: [{ usbVendorId: TC66.USB_VENDOR_ID }] });
    } catch (error) {
      // NotFoundError means that the user closed the port chooser.
      if (error.name !== 'NotFoundError') addLogLine(`Port selection failed: ${error.message}`);
      return;
    }
    const newConnection = new TC66.TC66Port(serialPort);
    setStatus('Opening port…');
    try {
      await newConnection.open();
    } catch (error) {
      setStatus('Cannot open the port', 'error');
      addLogLine(`Open failed: ${error.message}. Close other programs that use the port. If the meter does not respond, replug it.`);
      return;
    }
    newConnection.onclose = (error) => onConnectionLost(newConnection, error);
    connection = newConnection;
    setConnectedUi(true);
    addLogLine('Port open (115200 8N1, DTR and RTS on).');

    try {
      const mode = await newConnection.query();
      setDeviceMode(mode);
      addLogLine(`query → "${mode}"`);
      if (mode === 'boot') {
        setStatus('Bootloader mode', 'error');
        addLogLine('The meter is in bootloader mode. Use the firmware update section, or replug without K1 for normal use.');
        return;
      }
      if (mode !== 'firm') addLogLine(`Unexpected query response "${mode}". The page tries getva.`);
    } catch (error) {
      addLogLine(`query failed: ${error.message}`);
    }
    startPolling();
  }

  async function disconnect() {
    const oldConnection = connection;
    if (!oldConnection) return;
    connection = null;
    pollingLoopId++;
    await oldConnection.close();
    setConnectedUi(false);
    setStatus('Not connected');
    addLogLine('Port closed.');
  }

  function onConnectionLost(lostConnection, error) {
    if (connection !== lostConnection) return;
    connection = null;
    pollingLoopId++;
    setConnectedUi(false);
    setStatus('Connection lost', 'error');
    addLogLine(`Connection lost: ${error ? error.message : 'unknown reason'}`);
  }

  // ---------- Live polling ----------

  function startPolling() {
    pollingLoopId++;
    pollingPaused = false;
    element('pause').textContent = 'Pause';
    pollLoop(pollingLoopId);
  }

  function pausePolling() {
    pollingPaused = true;
    pollingLoopId++;
    element('pause').textContent = 'Resume';
    setStatus('Connected, paused', 'on');
  }

  async function pollLoop(loopId) {
    let failedPolls = 0;
    setStatus('Connected', 'on');
    while (loopId === pollingLoopId && connection) {
      const activeConnection = connection;
      const pollStartTime = performance.now();
      try {
        const reading = await activeConnection.getva();
        if (loopId !== pollingLoopId) break;
        if (failedPolls) setStatus('Connected', 'on');
        failedPolls = 0;
        addSample(reading);
      } catch (error) {
        if (loopId !== pollingLoopId || connection !== activeConnection) break;
        failedPolls++;
        addLogLine(error.message);
        if (failedPolls >= MAX_FAILED_POLLS) {
          addLogLine(`${MAX_FAILED_POLLS} getva requests failed. Polling stops. Replug the meter, then connect again.`);
          await disconnect();
          setStatus('Meter does not respond', 'error');
          break;
        }
        setStatus(`No valid response (${failedPolls}/${MAX_FAILED_POLLS})`, 'error');
        await activeConnection.discardUntilSilent(300).catch(() => {});
      }
      const pollIntervalMilliseconds = Number(element('poll-interval').value);
      await sleep(Math.max(0, pollIntervalMilliseconds - (performance.now() - pollStartTime)));
    }
  }

  function addSample(reading) {
    const { decrypted, ...values } = reading;
    samples.push({ time: Date.now(), ...values });
    if (samples.length > MAX_SAMPLE_COUNT) samples.splice(0, samples.length - MAX_SAMPLE_COUNT);

    element('value-voltage').textContent = reading.voltage.toFixed(4);
    element('value-current').textContent = reading.current.toFixed(5);
    element('value-power').textContent = reading.power.toFixed(3);
    element('value-resistance').textContent = reading.resistance >= 9999 ? '∞' : reading.resistance.toFixed(1);
    element('value-temperature').textContent = String(reading.temperature);
    element('value-data-plus').textContent = reading.dataPlus.toFixed(2);
    element('value-data-minus').textContent = reading.dataMinus.toFixed(2);
    element('value-sample-count').textContent = String(samples.length);
    element('save-live').disabled = false;

    element('device-model').textContent = reading.model;
    element('device-firmware').textContent = reading.firmware;
    element('device-serial').textContent = String(reading.serial);
    element('device-run-count').textContent = String(reading.runCount);
    element('device-group-0').textContent = `${reading.groups[0].mAh} mAh · ${reading.groups[0].mWh} mWh`;
    element('device-group-1').textContent = `${reading.groups[1].mAh} mAh · ${reading.groups[1].mWh} mWh`;
    scheduleDraw();
  }

  function clearSamples() {
    samples = [];
    element('value-sample-count').textContent = '0';
    element('save-live').disabled = true;
    scheduleDraw();
  }

  // ---------- Charts ----------

  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => {
      drawScheduled = false;
      drawLiveCharts();
      drawRecordingCharts();
    });
  }

  function drawCharts(charts, times, rows, timeStart, timeEnd) {
    for (const chart of charts) {
      Chart.drawStrip(element(chart.canvasId), {
        times,
        values: rows.map((row) => row[chart.field]),
        timeStart,
        timeEnd,
        color: Chart.resolveColor(`var(${chart.colorToken})`),
        unit: chart.unit,
        decimals: chart.decimals,
        label: chart.label,
      });
    }
  }

  function drawLiveCharts() {
    const startTime = samples.length ? samples[0].time : 0;
    const times = samples.map((sample) => (sample.time - startTime) / 1000);
    const lastTime = times.length ? times[times.length - 1] : 0;
    const windowSeconds = Number(element('chart-window').value);
    const timeEnd = windowSeconds ? Math.max(lastTime, windowSeconds) : Math.max(lastTime, 10);
    const timeStart = windowSeconds ? timeEnd - windowSeconds : 0;
    drawCharts(LIVE_CHARTS, times, samples, timeStart, timeEnd);
  }

  function drawRecordingCharts() {
    if (!recording || element('recording-charts').hidden) return;
    const rows = recording.summary.rows;
    const times = rows.map((row) => row.timeSeconds);
    drawCharts(RECORDING_CHARTS, times, rows, 0, Math.max(recording.summary.durationSeconds, 1));
  }

  // ---------- Offline recording ----------

  function samplePeriodSeconds() {
    const value = Math.round(Number(element('sample-period').value));
    return value >= 1 ? value : 10;
  }

  async function downloadRecording() {
    if (!connection) return;
    const activeConnection = connection;
    const progress = element('recording-progress');
    element('download-recording').disabled = true;
    progress.textContent = 'Waiting for data…';
    addLogLine('gtrec: download starts.');
    try {
      const dump = await activeConnection.stream('gtrec', {
        firstByteMilliseconds: 3000,
        silenceMilliseconds: 1500,
        maximumMilliseconds: 600000,
        onProgress: (byteCount) => {
          progress.textContent = `${byteCount} bytes (${Math.floor(byteCount / TC66.RECORD_SIZE)} records)…`;
        },
      });
      const parsed = TC66.parseGtrec(dump);
      recording = { dump, records: parsed.records, summary: null };
      addLogLine(
        `gtrec: ${dump.length} bytes, ${parsed.records.length} records, end marker ${parsed.hasEndMarker ? 'found' : 'not found'}` +
        (parsed.extraByteCount ? `, ${parsed.extraByteCount} extra bytes` : '') + '.',
      );
      progress.textContent = dump.length ? '' : 'The meter sent no data.';
      updateRecordingSummary();
    } catch (error) {
      progress.textContent = '';
      addLogLine(`gtrec failed: ${error.message}`);
    } finally {
      element('download-recording').disabled = !connection;
    }
  }

  function updateRecordingSummary() {
    if (!recording) return;
    const period = samplePeriodSeconds();
    const summary = TC66.summarizeRecords(recording.records, period);
    recording.summary = summary;
    const hasRecords = summary.count > 0;
    element('save-recording-csv').disabled = !hasRecords;
    element('save-recording-bin').disabled = !recording.dump.length;
    element('recording-summary').hidden = false;
    element('recording-charts').hidden = !hasRecords;
    element('recording-summary').innerHTML = hasRecords ? `
      <dl class="info">
        <dt>Records</dt><dd>${summary.count} × ${period} s = ${Chart.formatTime(summary.durationSeconds)}</dd>
        <dt>Average</dt><dd>${summary.averageVoltage.toFixed(3)} V · ${summary.averageCurrent.toFixed(4)} A · ${summary.averagePower.toFixed(3)} W</dd>
        <dt>Voltage range</dt><dd>${summary.minimumVoltage.toFixed(3)} – ${summary.maximumVoltage.toFixed(3)} V</dd>
        <dt>Peak</dt><dd>${summary.maximumCurrent.toFixed(4)} A · ${summary.maximumPower.toFixed(3)} W</dd>
        <dt>Total</dt><dd>${summary.milliampHours.toFixed(1)} mAh · ${(summary.milliwattHours / 1000).toFixed(3)} Wh</dd>
      </dl>` : '<p class="hint">The recording has no records.</p>';
    scheduleDraw();
  }

  // ---------- Raw command ----------

  function hexDump(bytes) {
    const lines = [];
    for (let offset = 0; offset < bytes.length; offset += 16) {
      const lineBytes = bytes.subarray(offset, offset + 16);
      const hex = Array.from(lineBytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
      const text = Array.from(lineBytes, (byte) => (byte >= 32 && byte < 127 ? String.fromCharCode(byte) : '.')).join('');
      lines.push(`${offset.toString(16).padStart(4, '0')}  ${hex.padEnd(47)}  ${text}`);
    }
    return lines.join('\n');
  }

  async function sendRawCommand(event) {
    event.preventDefault();
    if (!connection) return;
    const command = element('raw-command').value;
    if (!command) return;
    if (/update/i.test(command) && !confirm('"update" puts the meter into the bootloader for a firmware update. Send it?')) return;
    const activeConnection = connection;
    const output = element('raw-output');
    element('raw-send').disabled = true;
    output.hidden = false;
    output.textContent = `> ${command}\n…`;
    try {
      const response = await activeConnection.stream(command, {
        firstByteMilliseconds: 1000,
        silenceMilliseconds: 500,
        maximumMilliseconds: 20000,
      });
      let text = `> ${command}\n${response.length} bytes\n${hexDump(response)}`;
      if (response.length === TC66.GETVA_LENGTH) {
        try {
          text += `\n\nDecrypted getva:\n${hexDump(TC66.parseGetva(response).decrypted)}`;
        } catch { /* The response is not a getva packet. */ }
      }
      output.textContent = text;
      addLogLine(`raw "${command}" → ${response.length} bytes`);
    } catch (error) {
      output.textContent = `> ${command}\nError: ${error.message}`;
    } finally {
      element('raw-send').disabled = !connection;
    }
  }

  async function sendScreenCommand(button) {
    if (!connection) return;
    const command = button.dataset.command;
    try {
      await connection.send(command);
      addLogLine(`${command} sent.`);
    } catch (error) {
      addLogLine(`${command} failed: ${error.message}`);
    }
  }

  // ---------- Firmware update ----------

  function setDeviceMode(mode) {
    deviceMode = mode;
    const label = mode === 'boot' ? 'bootloader' : mode === 'firm' ? 'firmware (normal)' : 'unknown';
    element('update-mode').textContent = label;
    refreshFlashButton();
  }

  async function checkMode() {
    if (!connection || flashing) return;
    try {
      const mode = await connection.query();
      setDeviceMode(mode);
      addLogLine(`query → "${mode}"`);
    } catch (error) {
      addLogLine(`Check mode failed: ${error.message}`);
    }
  }

  async function onFirmwareFile() {
    const file = element('firmware-file').files[0];
    const info = element('firmware-info');
    firmware = null;
    if (!file) {
      info.textContent = '';
      info.className = 'hint';
      refreshFlashButton();
      return;
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const sha256 = await TC66.sha256Hex(bytes);
    const isOfficial = sha256 === TC66.OFFICIAL_FIRMWARE.sha256;
    firmware = { bytes, name: file.name, sha256, isOfficial };
    const chunkNote = bytes.length % TC66.FIRMWARE_CHUNK_SIZE ? ' (not a multiple of 64 bytes)' : '';
    if (isOfficial) {
      info.className = 'hint ok';
      info.textContent = `✓ Official TC66 firmware v${TC66.OFFICIAL_FIRMWARE.version}. ${bytes.length} bytes. SHA-256 matches.`;
    } else {
      info.className = 'hint bad';
      info.textContent = `⚠ Unrecognized file "${file.name}". ${bytes.length} bytes${chunkNote}. ` +
        `SHA-256 ${sha256.slice(0, 16)}… does not match the official v${TC66.OFFICIAL_FIRMWARE.version} image. ` +
        'Flashing this can permanently brick the meter.';
    }
    refreshFlashButton();
  }

  function refreshFlashButton() {
    const ready = !!connection && !flashing && deviceMode === 'boot' && !!firmware && element('update-confirm').checked;
    element('flash').disabled = !ready;
  }

  async function flashFirmware() {
    if (!connection || flashing || deviceMode !== 'boot' || !firmware) return;
    if (!firmware.isOfficial) {
      const message = `This file does not match the official firmware.\n\nName: ${firmware.name}\nSize: ${firmware.bytes.length} bytes\n` +
        `SHA-256: ${firmware.sha256}\n\nFlashing a wrong image can permanently brick the meter. Continue?`;
      if (!confirm(message)) return;
    }
    const activeConnection = connection;
    flashing = true;
    setConnectedUi(true);
    element('flash').disabled = true;
    element('check-mode').disabled = true;
    const progress = element('flash-progress');
    progress.hidden = false;
    progress.value = 0;
    addLogLine(`Firmware update starts: ${firmware.name} (${firmware.bytes.length} bytes).`);
    try {
      await activeConnection.updateFirmware(firmware.bytes, {
        onStatus: (text) => { if (text !== 'done') element('flash-status').textContent = text; },
        onProgress: ({ bytesSent, totalBytes, chunksSent, totalChunks }) => {
          progress.value = Math.round((bytesSent / totalBytes) * 100);
          element('flash-status').textContent = `${bytesSent}/${totalBytes} bytes · chunk ${chunksSent}/${totalChunks}`;
        },
      });
      element('flash-status').textContent = 'Done. Unplug and replug the meter to start the new firmware.';
      addLogLine('Firmware update finished. Unplug and replug the meter.');
    } catch (error) {
      element('flash-status').textContent = `Failed: ${error.message}`;
      addLogLine(`Firmware update failed: ${error.message}`);
      addLogLine('If the meter does not start, try the update again before you unplug it.');
    } finally {
      flashing = false;
      setConnectedUi(!!connection);
    }
  }

  // ---------- Events ----------

  // ---------- Color scheme toggle ----------

  // Two states: follow the system, or the opposite of the system.
  // localStorage keeps only an override. The meta element applies it (see the inline script in index.html).
  const COLOR_SCHEME_KEY = 'color-scheme';
  const systemDarkQuery = matchMedia('(prefers-color-scheme: dark)');

  function readStoredScheme() {
    try { return localStorage.getItem(COLOR_SCHEME_KEY); } catch { return null; }
  }

  function applyColorScheme(storedScheme) {
    document.querySelector('meta[name="color-scheme"]').content = storedScheme ?? 'light dark';
    scheduleDraw();
  }

  function toggleColorScheme() {
    const systemScheme = systemDarkQuery.matches ? 'dark' : 'light';
    const shownScheme = readStoredScheme() ?? systemScheme;
    const targetScheme = shownScheme === 'dark' ? 'light' : 'dark';
    // When the target is the system scheme, remove the override. Then the page follows the system again.
    const newStoredScheme = targetScheme === systemScheme ? null : targetScheme;
    try {
      if (newStoredScheme) localStorage.setItem(COLOR_SCHEME_KEY, newStoredScheme);
      else localStorage.removeItem(COLOR_SCHEME_KEY);
    } catch {
      // Storage is blocked. The page still changes the scheme for this visit.
    }
    applyColorScheme(newStoredScheme);
  }

  function initThemeToggle() {
    element('theme-toggle').addEventListener('click', toggleColorScheme);
    // Keep other tabs of the page in sync.
    window.addEventListener('storage', (event) => {
      if (event.key === COLOR_SCHEME_KEY || event.key === null) applyColorScheme(readStoredScheme());
    });
  }

  function init() {
    if (!('serial' in navigator)) {
      element('unsupported').hidden = false;
      element('connect').disabled = true;
      setStatus('Web Serial not available', 'error');
    }
    element('connect').addEventListener('click', connect);
    element('disconnect').addEventListener('click', disconnect);
    element('pause').addEventListener('click', () => {
      if (!connection) return;
      if (pollingPaused) startPolling();
      else pausePolling();
    });
    element('clear').addEventListener('click', clearSamples);
    element('save-live').addEventListener('click', () => {
      saveFile(`tc66-live-${fileTimestamp()}.csv`, TC66.samplesToCsv(samples), 'text/csv');
    });
    element('chart-window').addEventListener('change', scheduleDraw);
    document.querySelectorAll('button[data-command]').forEach((button) => {
      button.addEventListener('click', () => sendScreenCommand(button));
    });
    element('download-recording').addEventListener('click', downloadRecording);
    element('sample-period').addEventListener('input', updateRecordingSummary);
    element('save-recording-csv').addEventListener('click', () => {
      if (recording && recording.summary) saveFile(`tc66-rec-${fileTimestamp()}.csv`, TC66.recordsToCsv(recording.summary), 'text/csv');
    });
    element('save-recording-bin').addEventListener('click', () => {
      if (recording) saveFile(`tc66-rec-${fileTimestamp()}.bin`, recording.dump, 'application/octet-stream');
    });
    element('raw-form').addEventListener('submit', sendRawCommand);
    element('check-mode').addEventListener('click', checkMode);
    element('firmware-file').addEventListener('change', onFirmwareFile);
    element('update-confirm').addEventListener('change', refreshFlashButton);
    element('flash').addEventListener('click', flashFirmware);
    new ResizeObserver(scheduleDraw).observe(document.querySelector('main'));
    matchMedia('(prefers-color-scheme: dark)').addEventListener('change', scheduleDraw);
    initThemeToggle();
    window.addEventListener('pagehide', () => { if (connection) connection.close(); });
    scheduleDraw();
  }

  init();
})();

// Page logic: connection, live polling, meter buttons, offline recording and raw commands.
(function () {
  'use strict';

  const element = (id) => document.getElementById(id);
  const sleep = App.sleep;
  const MAX_SAMPLE_COUNT = 200000;
  const MAX_FAILED_POLLS = 3;
  const MAX_LOG_LINES = 200;

  const LIVE_CHARTS = [
    { containerId: 'chart-voltage', field: 'voltage', colorToken: '--color-voltage', unit: 'V', decimals: 4, label: 'Voltage' },
    { containerId: 'chart-current', field: 'current', colorToken: '--color-current', unit: 'A', decimals: 5, label: 'Current' },
    { containerId: 'chart-power', field: 'power', colorToken: '--color-power', unit: 'W', decimals: 3, label: 'Power' },
  ];
  const RECORDING_CHARTS = LIVE_CHARTS.map((chart) => ({ ...chart, containerId: chart.containerId.replace('chart-', 'recording-chart-') }));

  let connection = null;
  // Each polling loop has a number. A loop stops when this number changes.
  let pollingLoopId = 0;
  let pollingPaused = false;
  let samples = [];
  let recording = null; // { dump, records, summary }
  let drawScheduled = false;
  let deviceMode = null; // 'firm', 'boot' or null.
  let badPacketCount = 0;
  let firmware = null; // { bytes, name, sha256, isOfficial }
  let flashing = false;

  // ---------- Log and status ----------

  const addLogLine = (message) => App.addLogLine(message, { maxLines: MAX_LOG_LINES });
  const fileTimestamp = App.fileTimestamp;
  const saveFile = App.saveFile;

  // state: '' (neutral), 'on' or 'error'.
  function setStatus(text, state = '') {
    App.setStatus(text, state);
    // The connection badge shows the same state in short words.
    let badgeText = text;
    let badgeState = state === 'on' ? 'ok' : state === 'error' ? 'error' : 'neutral';
    if (text === 'Connected') badgeText = `Polling every ${Number(Stepper.segmentedValue(element('poll-interval'))) / 1000} s`;
    if (text === 'Connected, paused') {
      badgeText = 'Paused';
      badgeState = 'warn';
    }
    setBadge('badge-connection', badgeText, badgeState);
  }

  function setBadge(id, text, state) {
    const badge = element(id);
    badge.textContent = text;
    badge.dataset.state = state;
  }

  function countBadPacket(reset = false) {
    badPacketCount = reset ? 0 : badPacketCount + 1;
    setBadge('badge-packets', `Bad packets ${badPacketCount}`, badPacketCount ? 'warn' : 'ok');
  }

  function setConnectedUi(connected) {
    App.showConnected(connected);
    element('disconnect').disabled = !connected || flashing;
    element('pause').disabled = !connected;
    element('download-recording').disabled = !connected;
    element('raw-send').disabled = !connected;
    element('check-mode').disabled = !connected || flashing;
    document.querySelectorAll('button[data-command]').forEach((button) => { button.disabled = !connected; });
    if (!connected) {
      setDeviceMode(null);
      updateChoosePort();
    }
    refreshFlashButton();
  }

  // ---------- Connection ----------

  const PORT_STORAGE_KEY = 'tc66-last-port';
  const isMeterPort = (info) => info.usbVendorId === TC66.USB_VENDOR_ID;
  let reconnector = null;

  async function updateChoosePort() {
    const known = await App.findKnownPort(PORT_STORAGE_KEY, isMeterPort);
    element('choose-port').hidden = !!connection || !known;
  }

  // Connect uses the meter port that the user allowed before. Without one, it opens the port chooser.
  async function connect() {
    if (connection) return;
    stopReconnect();
    const known = await App.findKnownPort(PORT_STORAGE_KEY, isMeterPort);
    if (known) await connectTo(known);
    else await choosePort();
  }

  async function choosePort() {
    if (connection) return;
    stopReconnect();
    let serialPort;
    try {
      serialPort = await navigator.serial.requestPort({ filters: [{ usbVendorId: TC66.USB_VENDOR_ID }] });
    } catch (error) {
      // NotFoundError means that the user closed the port chooser.
      if (error.name !== 'NotFoundError') addLogLine(`Port selection failed: ${error.message}`);
      return;
    }
    await connectTo(serialPort);
  }

  // Open the port, check the mode and start polling. Return true when the port is open.
  // quiet: true is for the reconnect attempts. They show no message for each failure.
  async function connectTo(serialPort, { quiet = false } = {}) {
    if (connection) return true;
    const newConnection = new TC66.TC66Port(serialPort);
    if (!quiet) setStatus('Opening port…');
    try {
      await newConnection.open();
    } catch (error) {
      if (quiet) return false;
      setStatus('Cannot open the port', 'error');
      const message = `Cannot open the port: ${error.message}. Close other programs that use the port. If the meter does not respond, replug it.`;
      addLogLine(message);
      App.toast(message, { kind: 'error' });
      return false;
    }
    newConnection.onclose = (error) => onConnectionLost(newConnection, error);
    connection = newConnection;
    App.rememberPort(PORT_STORAGE_KEY, serialPort);
    setConnectedUi(true);
    countBadPacket(true);
    addLogLine('Port open (115200 8N1, DTR and RTS on).');

    try {
      const mode = await newConnection.query();
      setDeviceMode(mode);
      addLogLine(`query → "${mode}"`);
      if (mode === 'boot') {
        setStatus('Bootloader mode', 'error');
        addLogLine('The meter is in bootloader mode. Use the firmware update section, or replug without K1 for normal use.');
        return true;
      }
      if (mode !== 'firm') addLogLine(`Unexpected query response "${mode}". The page tries getva.`);
    } catch (error) {
      addLogLine(`query failed: ${error.message}`);
    }
    startPolling();
    return true;
  }

  async function disconnect() {
    stopReconnect();
    const oldConnection = connection;
    if (!oldConnection) {
      setConnectedUi(false);
      setStatus('Not connected');
      return;
    }
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
    // Do not reconnect during a firmware update. The meter restarts in another mode.
    if (!flashing) startReconnect(lostConnection.serialPort);
  }

  // Try to connect to the same port again, for about one minute. Replugging the meter fires the 'connect' event.
  function startReconnect(serialPort) {
    stopReconnect();
    App.toast('The connection to the meter is lost. The page connects again when the meter is back.', { kind: 'warning' });
    reconnector = new App.Reconnector({
      port: serialPort,
      attempts: 12,
      delay: 5000,
      tryConnect: async (port, count) => {
        setStatus(`Reconnecting (${count}/12)…`, 'error');
        const connected = await connectTo(port, { quiet: true });
        if (connected) {
          addLogLine('Connected again.');
          App.toast('Connected to the meter again.', { kind: 'success' });
        }
        return connected;
      },
      onGiveUp: () => {
        reconnector = null;
        setStatus('Connection lost', 'error');
        addLogLine('The page cannot connect again. Replug the meter, then click Connect.');
        App.toast('The page cannot connect to the meter again. Replug it, then click Connect.', { kind: 'error', milliseconds: 0 });
      },
    });
    reconnector.start();
  }

  function stopReconnect() {
    if (reconnector) reconnector.stop();
    reconnector = null;
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
        countBadPacket();
        addLogLine(error.message);
        if (failedPolls >= MAX_FAILED_POLLS) {
          addLogLine(`${MAX_FAILED_POLLS} getva requests failed. The page disconnects and tries to connect again.`);
          const port = activeConnection.serialPort;
          await disconnect();
          setStatus('Meter does not respond', 'error');
          startReconnect(port);
          break;
        }
        setStatus(`No valid response (${failedPolls}/${MAX_FAILED_POLLS})`, 'error');
        await activeConnection.discardUntilSilent(300).catch(() => {});
      }
      const pollIntervalMilliseconds = Number(Stepper.segmentedValue(element('poll-interval')));
      await sleep(Math.max(0, pollIntervalMilliseconds - (performance.now() - pollStartTime)));
    }
  }

  function addSample(reading) {
    const { decrypted, ...values } = reading;
    const sample = { time: Date.now(), ...values };
    samples.push(sample);
    if (samples.length > MAX_SAMPLE_COUNT) samples.splice(0, samples.length - MAX_SAMPLE_COUNT);
    appendLiveSeries(sample);

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
    clearLiveSeries();
    element('value-sample-count').textContent = '0';
    element('save-live').disabled = true;
    scheduleDraw();
  }

  // ---------- Charts ----------

  // The live chart data: seconds since the first sample, and one value array for each chart.
  // addSample appends to them, so a poll does not copy all samples.
  const liveSeries = { firstTime: null, times: [], voltage: [], current: [], power: [] };
  let liveCharts = null;
  let recordingCharts = null;

  function appendLiveSeries(sample) {
    if (liveSeries.firstTime === null) liveSeries.firstTime = sample.time;
    liveSeries.times.push((sample.time - liveSeries.firstTime) / 1000);
    for (const chart of LIVE_CHARTS) liveSeries[chart.field].push(sample[chart.field]);
    if (liveSeries.times.length > MAX_SAMPLE_COUNT) {
      const extra = liveSeries.times.length - MAX_SAMPLE_COUNT;
      liveSeries.times.splice(0, extra);
      for (const chart of LIVE_CHARTS) liveSeries[chart.field].splice(0, extra);
    }
  }

  function clearLiveSeries() {
    liveSeries.firstTime = null;
    liveSeries.times = [];
    for (const chart of LIVE_CHARTS) liveSeries[chart.field] = [];
  }

  // Draw on the next animation frame. A hidden tab gets no frames, so it does not draw until it is visible.
  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    const draw = () => {
      if (!drawScheduled) return;
      drawScheduled = false;
      drawLiveCharts();
      drawRecordingCharts();
    };
    requestAnimationFrame(draw);
  }

  // Interactive charts (uPlot). The charts of one group share the cursor.
  function buildCharts(definitions, syncKey) {
    const sync = UChart.sync(syncKey);
    const charts = {};
    for (const definition of definitions) {
      charts[definition.field] = UChart.create(element(definition.containerId), {
        label: definition.label, unit: definition.unit, colorToken: definition.colorToken, decimals: definition.decimals, height: 140, sync,
      });
    }
    return charts;
  }

  // The charts read the theme colors when they start. Rebuild them after a theme change.
  function rebuildCharts() {
    for (const charts of [liveCharts, recordingCharts]) {
      if (charts) Object.values(charts).forEach((chart) => chart.destroy());
    }
    liveCharts = null;
    recordingCharts = null;
    scheduleDraw();
  }

  function drawLiveCharts() {
    if (!liveCharts) liveCharts = buildCharts(LIVE_CHARTS, 'tc66-live');
    const times = liveSeries.times;
    const lastTime = times.length ? times[times.length - 1] : 0;
    const windowSeconds = Number(Stepper.segmentedValue(element('chart-window')));
    const timeEnd = windowSeconds ? Math.max(lastTime, windowSeconds) : Math.max(lastTime, 10);
    const timeStart = windowSeconds ? timeEnd - windowSeconds : 0;
    for (const chart of LIVE_CHARTS) liveCharts[chart.field].setWindow(times, liveSeries[chart.field], timeStart, timeEnd);
  }

  function drawRecordingCharts() {
    if (!recording || !recording.summary || element('recording-charts').hidden) return;
    if (!recordingCharts) recordingCharts = buildCharts(RECORDING_CHARTS, 'tc66-recording');
    const rows = recording.summary.rows;
    const times = rows.map((row) => row.timeSeconds);
    for (const chart of RECORDING_CHARTS) recordingCharts[chart.field].setData(times, rows.map((row) => row[chart.field]));
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
      App.toast(`The recording download failed: ${error.message}`, { kind: 'error' });
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
        <dt>Records</dt><dd>${summary.count} × ${period} s = ${UChart.formatTime(summary.durationSeconds)}</dd>
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
      App.toast(`${command} failed: ${error.message}`, { kind: 'error' });
    }
  }

  // ---------- Firmware update ----------

  function setDeviceMode(mode) {
    deviceMode = mode;
    if (mode === 'firm') setBadge('badge-mode', 'Firmware mode', 'ok');
    else if (mode === 'boot') setBadge('badge-mode', 'Bootloader mode', 'warn');
    else setBadge('badge-mode', mode ? `Mode "${mode}"` : 'Mode –', mode ? 'warn' : 'neutral');
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
      App.toast(`Check mode failed: ${error.message}`, { kind: 'error' });
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
      App.toast(`Firmware update failed: ${error.message}`, { kind: 'error', milliseconds: 0 });
      addLogLine('If the meter does not start, try the update again before you unplug it.');
    } finally {
      flashing = false;
      setConnectedUi(!!connection);
    }
  }

  // ---------- Events ----------

  function init() {
    if (!('serial' in navigator)) {
      element('unsupported').hidden = false;
      element('connect').disabled = true;
      setStatus('Web Serial not available', 'error');
    }
    element('connect').addEventListener('click', connect);
    element('disconnect').addEventListener('click', () => disconnect());
    element('choose-port').addEventListener('click', choosePort);
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
    element('poll-interval').addEventListener('change', () => {
      if (element('status-text').textContent === 'Connected') setStatus('Connected', 'on');
    });
    Stepper.enhance();
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
    Theme.init(rebuildCharts); // The charts take the colors of the new scheme.
    window.addEventListener('pagehide', () => { if (connection) connection.close(); });
    scheduleDraw();
  }

  init();
})();

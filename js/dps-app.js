// Power supply page logic: connection, live polling, output control, device settings and memory groups.
(function () {
  'use strict';

  const element = (id) => document.getElementById(id);
  const MAX_SAMPLE_COUNT = 200000;
  const MAX_FAILED_POLLS = 3;
  const MAX_LOG_LINES = 300;

  const LIVE_CHARTS = [
    { canvasId: 'chart-voltage', field: 'voltage', colorToken: '--color-voltage', unit: 'V', decimals: 2, label: 'Output voltage' },
    { canvasId: 'chart-current', field: 'current', colorToken: '--color-current', unit: 'A', decimals: 3, label: 'Output current' },
    { canvasId: 'chart-power', field: 'power', colorToken: '--color-power', unit: 'W', decimals: 2, label: 'Power' },
    { canvasId: 'chart-input-voltage', field: 'inputVoltage', colorToken: '--color-input', unit: 'V', decimals: 2, label: 'Input voltage' },
  ];

  let connection = null;
  let poller = null;
  let samples = [];
  let lastStatus = null;
  let fillSetInputs = true; // Copy U-SET and I-SET into the form on the next reading.
  let drawScheduled = false;
  let readingPresets = false;

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
    element('disconnect').disabled = !connected;
    element('pause').disabled = !connected;
    element('apply-set').disabled = !connected;
    element('output-toggle').disabled = !connected;
    element('lock-toggle').disabled = !connected;
    element('brightness').disabled = !connected;
    element('read-presets').disabled = !connected || readingPresets;
    ['port-kind', 'baud-rate', 'slave-address'].forEach((id) => { element(id).disabled = connected; });
    document.querySelectorAll('button[data-recall]').forEach((button) => { button.disabled = !connected; });
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

  // The port chooser shows wired ports and Bluetooth serial ports.
  // allowedBluetoothServiceClassIds lets newer Chrome open an RFCOMM service directly.
  async function requestSerialPort() {
    const bluetoothOnly = element('port-kind').value === 'bluetooth';
    const options = { allowedBluetoothServiceClassIds: [DPS.BLUETOOTH_SPP_UUID] };
    if (bluetoothOnly) options.filters = [{ bluetoothServiceClassId: DPS.BLUETOOTH_SPP_UUID }];
    try {
      return await navigator.serial.requestPort(options);
    } catch (error) {
      // An older browser does not know the Bluetooth filter and rejects it with a TypeError.
      if (error.name !== 'TypeError') throw error;
      addLogLine('This browser cannot filter Bluetooth ports. The chooser shows all ports.');
      return navigator.serial.requestPort({});
    }
  }

  function describePort(serialPort) {
    const info = typeof serialPort.getInfo === 'function' ? serialPort.getInfo() : {};
    if (info.bluetoothServiceClassId) return 'Bluetooth RFCOMM';
    if (info.usbVendorId !== undefined) return `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}`;
    return 'serial port';
  }

  async function connect() {
    if (connection) return;
    let serialPort;
    try {
      serialPort = await requestSerialPort();
    } catch (error) {
      // NotFoundError means that the user closed the port chooser.
      if (error.name !== 'NotFoundError') addLogLine(`Port selection failed: ${error.message}`);
      return;
    }
    const slaveAddress = Math.round(Number(element('slave-address').value)) || DPS.DEFAULT_SLAVE_ADDRESS;
    const baudRate = Number(element('baud-rate').value) || DPS.DEFAULT_BAUD_RATE;
    const newConnection = new DPS.DPSPort(serialPort, { slaveAddress, baudRate });
    setStatus('Opening port…');
    try {
      await newConnection.open();
    } catch (error) {
      setStatus('Cannot open the port', 'error');
      addLogLine(`Open failed: ${error.message}. Close other programs and the phone app. For Bluetooth, make sure that the supply is on and paired.`);
      return;
    }
    newConnection.onclose = (error) => onConnectionLost(newConnection, error);
    newConnection.ontraffic = (direction, bytes) => {
      if (element('log-frames').checked) addLogLine(`${direction === 'tx' ? '→' : '←'} ${DPS.toHex(bytes)}`);
    };
    connection = newConnection;
    setConnectedUi(true);
    addLogLine(`Port open (${describePort(serialPort)}, ${baudRate} 8N1, slave ${slaveAddress}).`);
    setStatus('Waiting for the supply…');

    try {
      const status = await newConnection.readStatus();
      showDevice(newConnection.scaling, status);
      addLogLine(`Supply found: ${newConnection.scaling.name}, firmware ${status.version}.`);
      if (!newConnection.scaling.known) addLogLine('Unknown model. The page uses the DPS3005 scaling. Check the values against the supply display.');
      else if (!newConnection.scaling.confirmed) addLogLine(`The register scaling of the ${newConnection.scaling.name} is not confirmed. Check the values against the supply display.`);
      addSample(status);
    } catch (error) {
      addLogLine(`The supply does not respond: ${error.message}`);
      addLogLine('Check the baud rate and the slave address. For Bluetooth, the supply must be on and no other device can be connected.');
      await disconnect();
      setStatus('Supply does not respond', 'error');
      return;
    }
    startPolling();
  }

  async function disconnect() {
    const oldConnection = connection;
    if (!oldConnection) return;
    connection = null;
    stopPolling();
    await oldConnection.close();
    setConnectedUi(false);
    setStatus('Not connected');
    addLogLine('Port closed.');
  }

  function onConnectionLost(lostConnection, error) {
    if (connection !== lostConnection) return;
    connection = null;
    stopPolling();
    setConnectedUi(false);
    setStatus('Connection lost', 'error');
    addLogLine(`Connection lost: ${error ? error.message : 'unknown reason'}`);
  }

  // ---------- Live polling ----------

  function startPolling() {
    if (!connection) return;
    stopPolling();
    const activeConnection = connection;
    poller = new DPS.Poller({
      read: () => activeConnection.readStatus(),
      interval: () => Number(element('poll-interval').value),
      maxFailures: MAX_FAILED_POLLS,
      onReading: (status) => {
        if (connection !== activeConnection) return;
        setStatus('Connected', 'on');
        addSample(status);
      },
      onError: (error, failures) => {
        if (connection !== activeConnection) return;
        addLogLine(error.message);
        setStatus(`No valid response (${failures}/${MAX_FAILED_POLLS})`, 'error');
      },
      onGiveUp: async () => {
        if (connection !== activeConnection) return;
        addLogLine(`${MAX_FAILED_POLLS} reads failed. Polling stops. Check the supply, then connect again.`);
        await disconnect();
        setStatus('Supply does not respond', 'error');
      },
    });
    poller.start();
    element('pause').textContent = 'Pause';
    setStatus('Connected', 'on');
  }

  function stopPolling() {
    if (poller) poller.stop();
    poller = null;
  }

  function togglePause() {
    if (!connection) return;
    if (poller) {
      stopPolling();
      element('pause').textContent = 'Resume';
      setStatus('Connected, paused', 'on');
    } else {
      startPolling();
    }
  }

  // ---------- Display ----------

  function formatValue(value, decimals) {
    return Number.isFinite(value) ? value.toFixed(decimals) : '–';
  }

  function scalingDecimals() {
    return connection ? connection.scaling : DPS.modelScaling(3005);
  }

  function showDevice(scaling, status) {
    element('device-model').textContent = `${scaling.name} (${status.model})`;
    element('device-firmware').textContent = status.version;
    element('device-range').textContent = `0–${scaling.maxVoltage} V · 0–${scaling.maxCurrent} A`;
    element('set-voltage').max = String(scaling.maxVoltage);
    element('set-current').max = String(scaling.maxCurrent);
    element('set-voltage').step = String(10 ** -scaling.voltageDecimals);
    element('set-current').step = String(10 ** -scaling.currentDecimals);
  }

  function setBadge(id, text, state) {
    const badge = element(id);
    badge.textContent = text;
    badge.dataset.state = state;
  }

  function addSample(status) {
    lastStatus = status;
    samples.push({ time: Date.now(), ...status });
    if (samples.length > MAX_SAMPLE_COUNT) samples.splice(0, samples.length - MAX_SAMPLE_COUNT);
    const { voltageDecimals, currentDecimals, powerDecimals } = scalingDecimals();

    element('value-voltage').textContent = formatValue(status.voltage, voltageDecimals);
    element('value-current').textContent = formatValue(status.current, currentDecimals);
    element('value-power').textContent = formatValue(status.power, powerDecimals);
    element('value-input-voltage').textContent = formatValue(status.inputVoltage, 2);
    element('value-voltage-set').textContent = formatValue(status.voltageSet, voltageDecimals);
    element('value-current-set').textContent = formatValue(status.currentSet, currentDecimals);
    element('value-sample-count').textContent = String(samples.length);
    element('save-live').disabled = false;

    setBadge('badge-output', status.outputOn ? 'Output ON' : 'Output OFF', status.outputOn ? 'on' : 'off');
    setBadge('badge-mode', status.mode, status.mode === 'CC' ? 'warn' : 'ok');
    setBadge('badge-protection', status.protection === 'OK' ? 'Protection OK' : `${status.protection} tripped`,
      status.protection === 'OK' ? 'ok' : 'error');
    setBadge('badge-lock', status.locked ? 'Keys locked' : 'Keys free', status.locked ? 'warn' : 'neutral');

    const outputButton = element('output-toggle');
    outputButton.textContent = status.outputOn ? 'Output: on — switch off' : 'Output: off — switch on';
    outputButton.dataset.state = status.outputOn ? 'on' : 'off';
    element('lock-toggle').textContent = status.locked ? 'Unlock keys' : 'Lock keys';
    const brightness = element('brightness');
    if (document.activeElement !== brightness) brightness.value = String(status.brightness);

    if (fillSetInputs) {
      fillSetInputs = false;
      element('set-voltage').value = status.voltageSet.toFixed(voltageDecimals);
      element('set-current').value = status.currentSet.toFixed(currentDecimals);
    }
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
    });
  }

  function drawLiveCharts() {
    const startTime = samples.length ? samples[0].time : 0;
    const times = samples.map((sample) => (sample.time - startTime) / 1000);
    const lastTime = times.length ? times[times.length - 1] : 0;
    const windowSeconds = Number(element('chart-window').value);
    const timeEnd = windowSeconds ? Math.max(lastTime, windowSeconds) : Math.max(lastTime, 10);
    const timeStart = windowSeconds ? timeEnd - windowSeconds : 0;
    for (const chart of LIVE_CHARTS) {
      Chart.drawStrip(element(chart.canvasId), {
        times,
        values: samples.map((sample) => sample[chart.field]),
        timeStart,
        timeEnd,
        color: Chart.resolveColor(`var(${chart.colorToken})`),
        unit: chart.unit,
        decimals: chart.decimals,
        label: chart.label,
      });
    }
  }

  // ---------- Commands ----------

  // Run a write command. Log the result. The next poll shows the new state.
  async function runCommand(description, action) {
    if (!connection) return false;
    try {
      await action(connection);
      addLogLine(`${description}: done.`);
      return true;
    } catch (error) {
      addLogLine(`${description} failed: ${error.message}`);
      return false;
    }
  }

  async function applySetValues(event) {
    event.preventDefault();
    const volts = Number(element('set-voltage').value);
    const amps = Number(element('set-current').value);
    const { voltageDecimals, currentDecimals } = scalingDecimals();
    await runCommand(`Set U = ${volts.toFixed(voltageDecimals)} V, I = ${amps.toFixed(currentDecimals)} A`,
      (port) => port.setVoltageAndCurrent(volts, amps));
  }

  function toggleOutput() {
    const switchOn = !(lastStatus && lastStatus.outputOn);
    return runCommand(`Output ${switchOn ? 'on' : 'off'}`, (port) => port.setOutput(switchOn));
  }

  function toggleLock() {
    const lock = !(lastStatus && lastStatus.locked);
    return runCommand(lock ? 'Lock keys' : 'Unlock keys', (port) => port.setLock(lock));
  }

  function changeBrightness() {
    const level = Number(element('brightness').value);
    return runCommand(`Brightness ${level}`, (port) => port.setBrightness(level));
  }

  // ---------- Memory groups ----------

  function buildPresetTable() {
    const body = element('preset-body');
    body.textContent = '';
    for (let index = 0; index < DPS.PRESET_COUNT; index++) {
      const row = document.createElement('tr');
      row.id = `preset-${index}`;
      row.innerHTML = `<th scope="row">M${index}</th>` + '<td>–</td>'.repeat(7) +
        `<td><button type="button" data-recall="${index}" disabled>Recall</button></td>`;
      body.append(row);
    }
  }

  function showPreset(index, preset) {
    const { voltageDecimals, currentDecimals } = scalingDecimals();
    const cells = element(`preset-${index}`).querySelectorAll('td');
    const values = [
      preset.voltageSet.toFixed(voltageDecimals),
      preset.currentSet.toFixed(currentDecimals),
      preset.overVoltage.toFixed(voltageDecimals),
      preset.overCurrent.toFixed(currentDecimals),
      preset.overPower.toFixed(1),
      String(preset.brightness),
      preset.outputOnStart ? 'yes' : 'no',
    ];
    values.forEach((value, cellIndex) => { cells[cellIndex].textContent = value; });
  }

  async function readPresets() {
    if (!connection || readingPresets) return;
    const activeConnection = connection;
    readingPresets = true;
    element('read-presets').disabled = true;
    const status = element('presets-status');
    let failed = 0;
    try {
      for (let index = 0; index < DPS.PRESET_COUNT; index++) {
        if (connection !== activeConnection) break;
        status.textContent = `Reading M${index}…`;
        try {
          showPreset(index, await activeConnection.readPreset(index));
        } catch (error) {
          failed++;
          addLogLine(`Read M${index} failed: ${error.message}`);
        }
      }
      status.textContent = failed ? `${failed} groups failed. See the log.` : '';
      if (!failed) addLogLine('Memory groups M0–M9 read.');
    } finally {
      readingPresets = false;
      element('read-presets').disabled = !connection;
    }
  }

  async function recallPreset(index) {
    const done = await runCommand(`Recall M${index}`, (port) => port.recallPreset(index));
    if (done) fillSetInputs = true;
  }

  // ---------- Events ----------

  function init() {
    if (!('serial' in navigator)) {
      element('unsupported').hidden = false;
      element('connect').disabled = true;
      setStatus('Web Serial not available', 'error');
    }
    buildPresetTable();
    element('connect').addEventListener('click', connect);
    element('disconnect').addEventListener('click', disconnect);
    element('pause').addEventListener('click', togglePause);
    element('clear').addEventListener('click', clearSamples);
    element('save-live').addEventListener('click', () => {
      saveFile(`dps-live-${fileTimestamp()}.csv`, DPS.samplesToCsv(samples), 'text/csv');
    });
    element('chart-window').addEventListener('change', scheduleDraw);
    element('set-form').addEventListener('submit', applySetValues);
    element('output-toggle').addEventListener('click', toggleOutput);
    element('lock-toggle').addEventListener('click', toggleLock);
    element('brightness').addEventListener('change', changeBrightness);
    element('read-presets').addEventListener('click', readPresets);
    element('preset-body').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-recall]');
      if (button) recallPreset(Number(button.dataset.recall));
    });
    new ResizeObserver(scheduleDraw).observe(document.querySelector('main'));
    Theme.init(scheduleDraw); // Redraw the charts when the scheme changes.
    window.addEventListener('pagehide', () => { if (connection) connection.close(); });
    setConnectedUi(false);
    scheduleDraw();
  }

  init();
})();

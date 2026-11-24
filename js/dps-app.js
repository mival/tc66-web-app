// Power supply page logic: connection, live polling, output control, device settings and memory groups.
(function () {
  'use strict';

  const element = (id) => document.getElementById(id);
  const TC66_USB_VENDOR_ID = 0x28e9;
  const MAX_SAMPLE_COUNT = 200000;
  const MAX_FAILED_POLLS = 3;
  const MAX_LOG_LINES = 300;
  const SEND_DELAY_MILLISECONDS = 350; // Pause after the last step before the page sends the value.
  const REPEAT_DELAY_MILLISECONDS = 400; // Hold time before an arrow button repeats.
  const REPEAT_INTERVAL_MILLISECONDS = 90;

  const LIVE_CHARTS = [
    { containerId: 'chart-voltage', field: 'voltage', colorToken: '--color-voltage', unit: 'V', decimals: 2, label: 'Output voltage' },
    { containerId: 'chart-current', field: 'current', colorToken: '--color-current', unit: 'A', decimals: 3, label: 'Output current' },
    { containerId: 'chart-power', field: 'power', colorToken: '--color-power', unit: 'W', decimals: 2, label: 'Power' },
    { containerId: 'chart-input-voltage', field: 'inputVoltage', colorToken: '--color-input', unit: 'V', decimals: 2, label: 'Input voltage' },
  ];

  // The two setpoints. Each one has an input, arrow buttons, a step size and a status line.
  const SETPOINTS = {
    voltage: {
      inputId: 'set-voltage', statusId: 'set-voltage-status', stepName: 'voltage-step', unit: 'V', name: 'Voltage',
      field: 'voltageSet', decimalsKey: 'voltageDecimals', maxKey: 'maxVoltage',
      write: (port, value) => port.setVoltage(value),
    },
    current: {
      inputId: 'set-current', statusId: 'set-current-status', stepName: 'current-step', unit: 'A', name: 'Current limit',
      field: 'currentSet', decimalsKey: 'currentDecimals', maxKey: 'maxCurrent',
      write: (port, value) => port.setCurrent(value),
    },
  };
  for (const setpoint of Object.values(SETPOINTS)) {
    setpoint.timer = null;
    setpoint.pending = false; // A value waits to be sent or is being sent.
    setpoint.lastSent = null;
    setpoint.sequence = 0; // Counts the scheduled sends. A finished send checks that no newer one started.
  }

  let connection = null;
  let poller = null;
  let samples = [];
  let lastStatus = null;
  let fillSetInputs = true; // Copy U-SET and I-SET into the inputs on the next reading, even if one has focus.
  let drawScheduled = false;
  let readingPresets = false;
  let switchBusy = false;
  let lockedByPage = false; // The page locked the keys on connect, so Disconnect unlocks them.
  const AUTOLOCK_STORAGE_KEY = 'dps-autolock';

  // ---------- Log and status ----------

  const addLogLine = (message) => App.addLogLine(message, { maxLines: MAX_LOG_LINES });
  const setStatus = App.setStatus;
  const fileTimestamp = App.fileTimestamp;
  const saveFile = App.saveFile;

  function setConnectedUi(connected) {
    App.showConnected(connected);
    element('pause').disabled = !connected;
    element('output-switch').disabled = !connected;
    element('lock-switch').disabled = !connected;
    element('brightness').disabled = !connected;
    element('read-presets').disabled = !connected || readingPresets;
    for (const setpoint of Object.values(SETPOINTS)) {
      const input = element(setpoint.inputId);
      input.disabled = !connected;
      input.closest('.setpoint').querySelectorAll('button, input[type="radio"]').forEach((control) => { control.disabled = !connected; });
      if (!connected) {
        clearTimeout(setpoint.timer);
        setpoint.pending = false;
        element(setpoint.statusId).textContent = '';
      }
    }
    ['port-kind', 'baud-rate', 'slave-address'].forEach((id) => { element(id).disabled = connected; });
    document.querySelectorAll('button[data-recall], button[data-edit]').forEach((button) => { button.disabled = !connected; });
    if (!connected && element('preset-dialog').open) element('preset-dialog').close();
    // The connection settings are open while the page is not connected, because you need them before Connect.
    element('connection-details').open = !connected;
    if (!connected) {
      fillSetInputs = true;
      element('output-state').textContent = '–';
      updateChoosePort();
    }
  }

  // ---------- Connection ----------

  const PORT_STORAGE_KEY = 'dps-last-port';
  // The supply is any serial port that is not the TC66C meter (USB vendor 0x28e9).
  const isSupplyPort = (info) => info.usbVendorId !== TC66_USB_VENDOR_ID;
  let reconnector = null;

  // "Choose port…" shows when Connect would use a known port. It lets the user pick another one.
  async function updateChoosePort() {
    const known = await App.findKnownPort(PORT_STORAGE_KEY, isSupplyPort);
    element('choose-port').hidden = !!connection || !known;
  }

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
    const info = App.portInfo(serialPort);
    if (info.bluetoothServiceClassId) return 'Bluetooth RFCOMM';
    if (info.usbVendorId !== undefined) return `USB ${info.usbVendorId.toString(16).padStart(4, '0')}:${(info.usbProductId || 0).toString(16).padStart(4, '0')}`;
    return 'serial port';
  }

  // Connect uses the port of the supply that the user allowed before. Without one, it opens the port chooser.
  async function connect() {
    if (connection) return;
    stopReconnect();
    const known = await App.findKnownPort(PORT_STORAGE_KEY, isSupplyPort);
    if (known) await connectTo(known);
    else await choosePort();
  }

  async function choosePort() {
    if (connection) return;
    stopReconnect();
    let serialPort;
    try {
      serialPort = await requestSerialPort();
    } catch (error) {
      // NotFoundError means that the user closed the port chooser.
      if (error.name !== 'NotFoundError') addLogLine(`Port selection failed: ${error.message}`);
      return;
    }
    await connectTo(serialPort);
  }

  // Open the port and read the supply. Return true when the supply answers.
  // quiet: true is for the reconnect attempts. They show no message for each failure.
  async function connectTo(serialPort, { quiet = false } = {}) {
    if (connection) return true;
    const slaveAddress = Math.round(Number(element('slave-address').value)) || DPS.DEFAULT_SLAVE_ADDRESS;
    const baudRate = Number(element('baud-rate').value) || DPS.DEFAULT_BAUD_RATE;
    const newConnection = new DPS.DPSPort(serialPort, { slaveAddress, baudRate });
    if (!quiet) setStatus('Opening port…');
    try {
      await newConnection.open();
    } catch (error) {
      if (quiet) return false;
      setStatus('Cannot open the port', 'error');
      const message = `Cannot open the port: ${error.message}. Close other programs and the phone app. For Bluetooth, make sure that the supply is on and paired.`;
      addLogLine(message);
      App.toast(message, { kind: 'error' });
      return false;
    }
    newConnection.onclose = (error) => onConnectionLost(newConnection, error);
    newConnection.ontraffic = (direction, bytes) => {
      if (element('log-frames').checked) addLogLine(`${direction === 'tx' ? '→' : '←'} ${DPS.toHex(bytes)}`);
    };
    connection = newConnection;
    App.rememberPort(PORT_STORAGE_KEY, serialPort);
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
      await disconnect({ unlock: false });
      setStatus('Supply does not respond', 'error');
      if (!quiet) {
        const hint = 'Check the baud rate and the slave address. For Bluetooth, the supply must be on and no other device can be connected.';
        addLogLine(hint);
        App.toast(`The supply does not respond. ${hint}`, { kind: 'error' });
      }
      return false;
    }
    if (element('autolock-switch').checked) await lockOnConnect(lastStatus);
    startPolling();
    return true;
  }

  // Lock the keys if they are free. Remember that the page locked them.
  async function lockOnConnect(status) {
    if (!connection || !status || status.locked) return;
    lockedByPage = await runCommand('Lock keys on connect', (port) => port.setLock(true));
  }

  // unlock: false skips the unlock, for example when the supply does not respond.
  async function disconnect({ unlock = true } = {}) {
    stopReconnect();
    const oldConnection = connection;
    if (!oldConnection) {
      setConnectedUi(false);
      setStatus('Not connected');
      return;
    }
    connection = null;
    stopPolling();
    if (unlock && lockedByPage) {
      try {
        await oldConnection.setLock(false);
        addLogLine('Unlock keys on disconnect: done.');
      } catch (error) {
        addLogLine(`Unlock keys on disconnect failed: ${error.message}`);
      }
    }
    lockedByPage = false;
    await oldConnection.close();
    setConnectedUi(false);
    setStatus('Not connected');
    addLogLine('Port closed.');
  }

  function onConnectionLost(lostConnection, error) {
    if (connection !== lostConnection) return;
    connection = null;
    lockedByPage = false;
    stopPolling();
    setConnectedUi(false);
    setStatus('Connection lost', 'error');
    addLogLine(`Connection lost: ${error ? error.message : 'unknown reason'}`);
    startReconnect(lostConnection.serialPort);
  }

  // Try to connect to the same port again, for about one minute.
  function startReconnect(serialPort) {
    stopReconnect();
    App.toast('The connection to the supply is lost. The page tries to connect again.', { kind: 'warning' });
    reconnector = new App.Reconnector({
      port: serialPort,
      attempts: 12,
      delay: 5000,
      tryConnect: async (port, count) => {
        setStatus(`Reconnecting (${count}/12)…`, 'error');
        const connected = await connectTo(port, { quiet: true });
        if (connected) {
          addLogLine('Connected again.');
          App.toast('Connected to the supply again.', { kind: 'success' });
        }
        return connected;
      },
      onGiveUp: () => {
        reconnector = null;
        setStatus('Connection lost', 'error');
        addLogLine('The page cannot connect again. Check the supply, then click Connect.');
        App.toast('The page cannot connect to the supply again. Check the supply, then click Connect.', { kind: 'error', milliseconds: 0 });
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
    if (!connection) return;
    stopPolling();
    const activeConnection = connection;
    poller = new DPS.Poller({
      read: () => activeConnection.readStatus(),
      interval: () => Number(Stepper.segmentedValue(element('poll-interval'))),
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
        addLogLine(`${MAX_FAILED_POLLS} reads failed. The page disconnects and tries to connect again.`);
        const port = activeConnection.serialPort;
        await disconnect({ unlock: false });
        setStatus('Supply does not respond', 'error');
        startReconnect(port);
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

  function currentScaling() {
    return connection ? connection.scaling : DPS.modelScaling(3005);
  }

  function showDevice(scaling, status) {
    element('device-model').textContent = `${scaling.name} (${status.model})`;
    element('device-firmware').textContent = status.version;
    element('device-range').textContent = `0–${scaling.maxVoltage} V · 0–${scaling.maxCurrent} A`;
    for (const setpoint of Object.values(SETPOINTS)) {
      element(setpoint.inputId).step = String(10 ** -scaling[setpoint.decimalsKey]);
    }
    element('limit-voltage').max = String(scaling.maxVoltage);
    element('limit-current').max = String(scaling.maxCurrent);
    applyLimits();
  }

  // ---------- Safety limits ----------

  const LIMITS_STORAGE_KEY = 'dps-limits';
  const LIMIT_INPUTS = { voltageSet: 'limit-voltage', currentSet: 'limit-current' };

  // The user limit of a setpoint field, or Infinity when the field is empty.
  function userLimit(field) {
    const input = element(LIMIT_INPUTS[field]);
    return input.value === '' || !input.validity.valid ? Infinity : Number(input.value);
  }

  // The highest value that the page sends: the model range or the user limit, whichever is lower.
  function highestValue(setpoint) {
    return Math.min(currentScaling()[setpoint.maxKey], userLimit(setpoint.field));
  }

  // Put the limits on the setpoint inputs and the memory group dialog, and show them in the summary.
  function applyLimits() {
    for (const setpoint of Object.values(SETPOINTS)) {
      const highest = highestValue(setpoint);
      element(setpoint.inputId).max = String(highest);
      element(setpoint.inputId).closest('.setpoint').querySelector('[data-max]').textContent = String(highest);
    }
    const parts = [];
    if (userLimit('voltageSet') !== Infinity) parts.push(`${userLimit('voltageSet')} V`);
    if (userLimit('currentSet') !== Infinity) parts.push(`${userLimit('currentSet')} A`);
    element('safety-limits-summary').textContent = parts.length ? `at most ${parts.join(' · ')}` : 'none';
    element('safety-limits').classList.toggle('active', parts.length > 0);
  }

  function initLimits() {
    try {
      const saved = JSON.parse(localStorage.getItem(LIMITS_STORAGE_KEY) || '{}');
      if (saved.voltage != null) element('limit-voltage').value = saved.voltage;
      if (saved.current != null) element('limit-current').value = saved.current;
    } catch {
      // Storage is blocked or the value is not valid. Start with no limits.
    }
    for (const id of Object.values(LIMIT_INPUTS)) {
      element(id).addEventListener('change', () => {
        try {
          localStorage.setItem(LIMITS_STORAGE_KEY, JSON.stringify({
            voltage: element('limit-voltage').value === '' ? null : element('limit-voltage').value,
            current: element('limit-current').value === '' ? null : element('limit-current').value,
          }));
        } catch {
          // The limits apply to this visit only.
        }
        applyLimits();
      });
    }
    applyLimits();
  }

  // ---------- Warnings ----------

  let lastProtection = 'OK';

  // Show a banner while a protection is tripped. Show a toast once, when it trips.
  function showProtection(status) {
    const tripped = status.protection !== 'OK';
    element('protection-alert').hidden = !tripped;
    if (tripped) {
      const names = { OVP: 'Over-voltage protection (OVP)', OCP: 'Over-current protection (OCP)', OPP: 'Over-power protection (OPP)' };
      element('protection-alert-title').textContent = `${names[status.protection] || status.protection} tripped.`;
      element('protection-alert-text').textContent =
        ' The supply switched the output off. Remove the cause, then switch the output on again. You can change the limit in a memory group or on the supply.';
      if (lastProtection === 'OK') App.toast(`${status.protection} tripped. The output is off.`, { kind: 'error', milliseconds: 10000 });
    }
    lastProtection = status.protection;
  }

  // The supply is a step-down converter. Its output is at most about the input voltage / 1.1.
  function showInputWarning(status) {
    const highestOutput = status.inputVoltage / 1.1;
    const tooHigh = status.inputVoltage > 0 && status.voltageSet > highestOutput + 0.05;
    const warning = element('input-warning');
    warning.hidden = !tooHigh;
    if (tooHigh) {
      warning.textContent = `⚠ U-SET ${status.voltageSet.toFixed(2)} V is too high for the input of ${status.inputVoltage.toFixed(2)} V. ` +
        `The output can reach about ${highestOutput.toFixed(1)} V. Use an adapter with at least ${(status.voltageSet * 1.1).toFixed(1)} V.`;
    }
  }

  // ---------- Charge and energy counters ----------

  // The supply does not count charge and energy, so the page adds them up (trapezoid rule).
  // A gap of more than MAX_GAP_MS adds nothing, because the current during the gap is not known.
  const MAX_GAP_MS = 30000;
  const counters = { mAh: 0, wh: 0, onMilliseconds: 0, previous: null };

  function addToCounters(time, status) {
    const previous = counters.previous;
    if (previous) {
      const dt = time - previous.time;
      if (dt > 0 && dt <= MAX_GAP_MS) {
        const hours = dt / 3600000;
        counters.mAh += ((status.current + previous.current) / 2) * hours * 1000;
        counters.wh += ((status.power + previous.power) / 2) * hours;
        if (status.outputOn && previous.outputOn) counters.onMilliseconds += dt;
      }
    }
    counters.previous = { time, current: status.current, power: status.power, outputOn: status.outputOn };
    showCounters();
  }

  function showCounters() {
    element('value-charge').textContent = counters.mAh.toFixed(1);
    element('value-energy').textContent = counters.wh.toFixed(3);
    element('value-on-time').textContent = App.formatDuration(counters.onMilliseconds / 1000);
  }

  function resetCounters() {
    counters.mAh = 0;
    counters.wh = 0;
    counters.onMilliseconds = 0;
    counters.previous = null;
    showCounters();
    addLogLine('Counters reset.');
  }

  function setBadge(id, text, state) {
    const badge = element(id);
    badge.textContent = text;
    badge.dataset.state = state;
  }

  function addSample(status) {
    lastStatus = status;
    const time = Date.now();
    addToCounters(time, status);
    showProtection(status);
    showInputWarning(status);
    const sample = { time, ...status, mAh: counters.mAh, wh: counters.wh };
    samples.push(sample);
    if (samples.length > MAX_SAMPLE_COUNT) samples.splice(0, samples.length - MAX_SAMPLE_COUNT);
    appendLiveSeries(sample);
    const scaling = currentScaling();
    const { voltageDecimals, currentDecimals, powerDecimals } = scaling;

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

    if (!switchBusy) {
      element('output-switch').checked = status.outputOn;
      element('lock-switch').checked = status.locked;
    }
    element('output-state').textContent = status.outputOn ? 'on' : 'off';
    document.querySelector('.output-panel').dataset.output = status.outputOn ? 'on' : 'off';

    const brightness = element('brightness');
    if (document.activeElement !== brightness) {
      brightness.value = String(status.brightness);
      showBrightness();
    }

    // Show the supply value in an input, unless the user edits it or a value waits to be sent.
    for (const setpoint of Object.values(SETPOINTS)) {
      const input = element(setpoint.inputId);
      // An invalid entry stays with its error message until the user corrects it or presses Escape.
      const editing = document.activeElement === input || setpoint.pending || input.getAttribute('aria-invalid') === 'true';
      if (fillSetInputs || !editing) {
        input.value = status[setpoint.field].toFixed(scaling[setpoint.decimalsKey]);
        markInvalid(input, false);
      }
    }
    fillSetInputs = false;
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
  const liveSeries = { firstTime: null, times: [] };
  LIVE_CHARTS.forEach((chart) => { liveSeries[chart.field] = []; });
  let liveCharts = null;

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
    };
    requestAnimationFrame(draw);
  }

  // The charts read the theme colors when they start. Rebuild them after a theme change.
  function rebuildCharts() {
    if (liveCharts) Object.values(liveCharts).forEach((chart) => chart.destroy());
    liveCharts = null;
    scheduleDraw();
  }

  function drawLiveCharts() {
    if (!liveCharts) {
      const sync = UChart.sync('dps-live');
      liveCharts = {};
      for (const chart of LIVE_CHARTS) {
        liveCharts[chart.field] = UChart.create(element(chart.containerId), {
          label: chart.label, unit: chart.unit, colorToken: chart.colorToken, decimals: chart.decimals, height: 130, sync,
        });
      }
    }
    const times = liveSeries.times;
    const lastTime = times.length ? times[times.length - 1] : 0;
    const windowSeconds = Number(Stepper.segmentedValue(element('chart-window')));
    const timeEnd = windowSeconds ? Math.max(lastTime, windowSeconds) : Math.max(lastTime, 10);
    const timeStart = windowSeconds ? timeEnd - windowSeconds : 0;
    for (const chart of LIVE_CHARTS) liveCharts[chart.field].setWindow(times, liveSeries[chart.field], timeStart, timeEnd);
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
      App.toast(`${description} failed: ${error.message}`, { kind: 'error' });
      return false;
    }
  }

  // ---------- Setpoints ----------

  // Show or remove the error state of an input. The error text is linked with aria-describedby only while it shows.
  function markInvalid(input, invalid) {
    input.setAttribute('aria-invalid', invalid ? 'true' : 'false');
    const errorId = input.dataset.error;
    const ids = (input.getAttribute('aria-describedby') || '').split(/\s+/).filter((id) => id && id !== errorId);
    if (invalid) ids.push(errorId);
    input.setAttribute('aria-describedby', ids.join(' '));
  }

  function stepSize(setpoint) {
    const checked = document.querySelector(`input[name="${setpoint.stepName}"]:checked`);
    return checked ? Number(checked.value) : 1;
  }

  // Change the value by a number of steps. Clamp it to the model range. Send it after a short pause.
  function nudge(setpoint, stepCount) {
    if (!connection) return;
    const input = element(setpoint.inputId);
    const scaling = currentScaling();
    const decimals = scaling[setpoint.decimalsKey];
    const step = stepSize(setpoint);
    const current = Number(input.value) || 0;
    // Snap to the step grid first, so 5.03 + 0.1 gives 5.1, not 5.13.
    const snapped = stepCount > 0 ? Math.floor(current / step + 1e-9) * step : Math.ceil(current / step - 1e-9) * step;
    const base = Math.abs(snapped - current) > 1e-9 ? snapped : current;
    const next = Math.min(highestValue(setpoint), Math.max(0, base + stepCount * step));
    input.value = next.toFixed(decimals);
    markInvalid(input, false);
    scheduleSend(setpoint, SEND_DELAY_MILLISECONDS);
  }

  function scheduleSend(setpoint, delay) {
    clearTimeout(setpoint.timer);
    setpoint.pending = true;
    setpoint.sequence++;
    element(setpoint.statusId).textContent = delay ? 'Waiting…' : '';
    setpoint.timer = setTimeout(() => sendSetpoint(setpoint), delay);
  }

  async function sendSetpoint(setpoint) {
    clearTimeout(setpoint.timer);
    const input = element(setpoint.inputId);
    const status = element(setpoint.statusId);
    if (!connection) {
      setpoint.pending = false;
      return;
    }
    if (input.value === '' || !input.validity.valid) {
      setpoint.pending = false;
      status.textContent = '';
      markInvalid(input, true);
      return;
    }
    markInvalid(input, false);
    const scaling = currentScaling();
    const value = Number(input.value);
    const text = `${value.toFixed(scaling[setpoint.decimalsKey])} ${setpoint.unit}`;
    // Do not send the same value again, for example on Enter and then on blur.
    const deviceValue = lastStatus ? lastStatus[setpoint.field] : null;
    if (value === setpoint.lastSent && value === deviceValue) {
      setpoint.pending = false;
      return;
    }
    status.textContent = `Sending ${text}…`;
    const sequence = setpoint.sequence;
    const sent = await runCommand(`${setpoint.name} ${text}`, (port) => setpoint.write(port, value));
    if (sent) setpoint.lastSent = value;
    // A new step during the write starts a new send. Then the value still waits and the status stays.
    if (sequence !== setpoint.sequence) return;
    setpoint.pending = false;
    status.textContent = sent ? `✓ Set to ${text}` : `Failed to set ${text}. See the log.`;
  }

  // An arrow button steps once on a click and repeats while the pointer holds it.
  function bindStepButton(button, setpoint) {
    const direction = Number(button.dataset.step);
    let delayTimer = null;
    let repeatTimer = null;
    let repeated = false;
    const stop = () => {
      clearTimeout(delayTimer);
      clearInterval(repeatTimer);
      delayTimer = null;
      repeatTimer = null;
    };
    button.addEventListener('pointerdown', (event) => {
      if (event.button !== 0 || button.disabled) return;
      repeated = false;
      stop();
      delayTimer = setTimeout(() => {
        repeated = true;
        nudge(setpoint, direction);
        repeatTimer = setInterval(() => nudge(setpoint, direction), REPEAT_INTERVAL_MILLISECONDS);
      }, REPEAT_DELAY_MILLISECONDS);
    });
    ['pointerup', 'pointerleave', 'pointercancel', 'blur'].forEach((type) => button.addEventListener(type, stop));
    // A click comes from a short press, Enter or Space. After a repeat, the click is not a new step.
    button.addEventListener('click', () => {
      if (repeated) {
        repeated = false;
        return;
      }
      nudge(setpoint, direction);
    });
    button.addEventListener('contextmenu', (event) => event.preventDefault());
  }

  function bindSetpoint(setpoint) {
    const input = element(setpoint.inputId);
    const fieldset = input.closest('.setpoint');
    fieldset.querySelectorAll('.step-button').forEach((button) => bindStepButton(button, setpoint));
    input.addEventListener('keydown', (event) => {
      const steps = { ArrowUp: 1, ArrowDown: -1, PageUp: 10, PageDown: -10 }[event.key];
      if (steps) {
        event.preventDefault(); // The native number input steps by its own step attribute. Use the selected step.
        nudge(setpoint, steps);
      } else if (event.key === 'Enter') {
        event.preventDefault();
        sendSetpoint(setpoint);
      } else if (event.key === 'Escape') {
        // Discard the edit and show the supply value again.
        clearTimeout(setpoint.timer);
        setpoint.pending = false;
        if (lastStatus) input.value = lastStatus[setpoint.field].toFixed(currentScaling()[setpoint.decimalsKey]);
        markInvalid(input, false);
        element(setpoint.statusId).textContent = '';
      }
    });
    input.addEventListener('input', () => {
      setpoint.pending = true; // Keep the typed text until Enter or blur.
      element(setpoint.statusId).textContent = 'Press Enter to send.';
      if (input.validity.valid) markInvalid(input, false);
    });
    input.addEventListener('change', () => sendSetpoint(setpoint));
    // The mouse wheel must not change the value of a supply by accident.
    input.addEventListener('wheel', (event) => { if (document.activeElement === input) event.preventDefault(); }, { passive: false });
  }

  // ---------- Switches and brightness ----------

  async function onSwitchChange(switchElement, describe, action) {
    const wanted = switchElement.checked;
    switchBusy = true;
    switchElement.disabled = true;
    const done = await runCommand(describe(wanted), (port) => action(port, wanted));
    switchBusy = false;
    switchElement.disabled = !connection;
    if (!done) switchElement.checked = !wanted;
  }

  function showBrightness() {
    const slider = element('brightness');
    element('brightness-value').textContent = slider.value;
    const progress = ((Number(slider.value) - Number(slider.min)) / (Number(slider.max) - Number(slider.min))) * 100;
    slider.style.setProperty('--slider-progress', `${progress}%`);
    slider.setAttribute('aria-valuetext', `Level ${slider.value} of ${slider.max}`);
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
        `<td class="preset-actions"><button type="button" data-recall="${index}" disabled>Recall</button>` +
        `<button type="button" data-edit="${index}" disabled aria-label="Edit M${index}">Edit</button></td>`;
      body.append(row);
    }
  }

  function showPreset(index, preset) {
    const { voltageDecimals, currentDecimals } = currentScaling();
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

  // ---------- Memory group editor ----------

  // The dialog fields and the number of decimals of each one.
  const PRESET_FIELDS = [
    { id: 'preset-voltage', field: 'voltageSet', decimals: (scaling) => scaling.voltageDecimals },
    { id: 'preset-current', field: 'currentSet', decimals: (scaling) => scaling.currentDecimals },
    { id: 'preset-ovp', field: 'overVoltage', decimals: (scaling) => scaling.voltageDecimals },
    { id: 'preset-ocp', field: 'overCurrent', decimals: (scaling) => scaling.currentDecimals },
    { id: 'preset-opp', field: 'overPower', decimals: () => 1 },
    { id: 'preset-light', field: 'brightness', decimals: () => 0 },
  ];
  let editedPresetIndex = null;

  // Read the group from the supply, put its values into the dialog and open the dialog.
  async function openPresetEditor(index, button) {
    if (!connection) return;
    const activeConnection = connection;
    button.disabled = true;
    let preset;
    try {
      preset = await activeConnection.readPreset(index);
    } catch (error) {
      addLogLine(`Read M${index} failed: ${error.message}`);
      return;
    } finally {
      button.disabled = !connection;
    }
    if (connection !== activeConnection) return;
    showPreset(index, preset);
    const scaling = currentScaling();
    const limits = DPS.presetLimits(scaling);
    element('preset-form').reset(); // Clears the values and the error state of the last edit.
    for (const { id, field, decimals } of PRESET_FIELDS) {
      const input = element(id);
      const places = decimals(scaling);
      // U and I also respect the safety limits of the page.
      const userMax = LIMIT_INPUTS[field] ? userLimit(field) : Infinity;
      input.max = String(Math.min(limits[field], userMax));
      input.step = String(10 ** -places);
      input.value = preset[field].toFixed(places);
    }
    element('preset-mpre').checked = preset.memoryPreset !== 0;
    element('preset-start').checked = preset.outputOnStart;
    element('preset-dialog-group').textContent = `M${index}`;
    element('preset-dialog-note').hidden = index !== 0;
    editedPresetIndex = index;
    const dialog = element('preset-dialog');
    dialog.returnValue = '';
    dialog.showModal();
  }

  function presetFromDialog() {
    const preset = {};
    for (const { id, field } of PRESET_FIELDS) preset[field] = Number(element(id).value);
    preset.memoryPreset = element('preset-mpre').checked ? 1 : 0;
    preset.outputOnStart = element('preset-start').checked;
    return preset;
  }

  // The form submits after the browser checked the fields. Only "Save to supply" saves.
  // Escape and Cancel close the dialog and discard the edit.
  // The page uses 'submit', not the 'close' event of the dialog: 'submit' comes at once and names the button.
  async function onPresetFormSubmit(event) {
    const choice = event.submitter ? event.submitter.value : '';
    const index = editedPresetIndex;
    editedPresetIndex = null;
    if (choice !== 'save' || index === null || !connection) return;
    const activeConnection = connection;
    const preset = presetFromDialog();
    const done = await runCommand(`Save M${index}`, (port) => port.writePreset(index, preset));
    if (!done || connection !== activeConnection) return;
    if (index === 0) fillSetInputs = true; // M0 is the active group. Show its new U and I in the setpoints.
    try {
      showPreset(index, await activeConnection.readPreset(index));
    } catch (error) {
      addLogLine(`Read M${index} failed: ${error.message}`);
    }
  }

  function useCurrentSetpoints() {
    if (!lastStatus) return;
    const scaling = currentScaling();
    element('preset-voltage').value = lastStatus.voltageSet.toFixed(scaling.voltageDecimals);
    element('preset-current').value = lastStatus.currentSet.toFixed(scaling.currentDecimals);
  }

  async function recallPreset(index) {
    const done = await runCommand(`Recall M${index}`, (port) => port.recallPreset(index));
    if (done) fillSetInputs = true;
  }

  // ---------- Lock the keys on connect ----------

  // localStorage keeps the setting. It can be blocked, for example in a private window. Then the switch starts off.
  function initAutolock() {
    const autolockSwitch = element('autolock-switch');
    try {
      autolockSwitch.checked = localStorage.getItem(AUTOLOCK_STORAGE_KEY) === 'on';
    } catch {
      autolockSwitch.checked = false;
    }
    autolockSwitch.addEventListener('change', () => {
      try {
        localStorage.setItem(AUTOLOCK_STORAGE_KEY, autolockSwitch.checked ? 'on' : 'off');
      } catch {
        // The setting applies to this visit only.
      }
      // Switched on while connected: lock the keys now.
      if (autolockSwitch.checked) lockOnConnect(lastStatus);
    });
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
    element('disconnect').addEventListener('click', () => disconnect());
    element('choose-port').addEventListener('click', choosePort);
    element('pause').addEventListener('click', togglePause);
    element('clear').addEventListener('click', clearSamples);
    element('save-live').addEventListener('click', () => {
      saveFile(`dps-live-${fileTimestamp()}.csv`, DPS.samplesToCsv(samples), 'text/csv');
    });
    element('chart-window').addEventListener('change', scheduleDraw);
    Object.values(SETPOINTS).forEach(bindSetpoint);
    element('output-switch').addEventListener('change', (event) => onSwitchChange(event.target,
      (on) => `Output ${on ? 'on' : 'off'}`, (port, on) => port.setOutput(on)));
    element('lock-switch').addEventListener('change', () => { lockedByPage = false; });
    element('lock-switch').addEventListener('change', (event) => onSwitchChange(event.target,
      (locked) => (locked ? 'Lock keys' : 'Unlock keys'), (port, locked) => port.setLock(locked)));
    element('brightness').addEventListener('input', showBrightness);
    element('brightness').addEventListener('change', changeBrightness);
    element('read-presets').addEventListener('click', readPresets);
    element('preset-form').addEventListener('submit', onPresetFormSubmit);
    element('preset-use-current').addEventListener('click', useCurrentSetpoints);
    Stepper.enhance();
    initAutolock();
    initLimits();
    element('reset-counters').addEventListener('click', resetCounters);
    element('preset-body').addEventListener('click', (event) => {
      const recallButton = event.target.closest('button[data-recall]');
      if (recallButton) recallPreset(Number(recallButton.dataset.recall));
      const editButton = event.target.closest('button[data-edit]');
      if (editButton) openPresetEditor(Number(editButton.dataset.edit), editButton);
    });
    Theme.init(rebuildCharts); // The charts take the colors of the new scheme.
    window.addEventListener('pagehide', () => { if (connection) connection.close(); });
    setConnectedUi(false);
    showBrightness();
    scheduleDraw();
  }

  init();
})();

// Power supply page logic: connection, live polling, output control, device settings and memory groups.
(function () {
  'use strict';

  const element = (id) => document.getElementById(id);
  const MAX_SAMPLE_COUNT = 200000;
  const MAX_FAILED_POLLS = 3;
  const MAX_LOG_LINES = 300;
  const SEND_DELAY_MILLISECONDS = 350; // Pause after the last step before the page sends the value.
  const REPEAT_DELAY_MILLISECONDS = 400; // Hold time before an arrow button repeats.
  const REPEAT_INTERVAL_MILLISECONDS = 90;

  const LIVE_CHARTS = [
    { canvasId: 'chart-voltage', field: 'voltage', colorToken: '--color-voltage', unit: 'V', decimals: 2, label: 'Output voltage' },
    { canvasId: 'chart-current', field: 'current', colorToken: '--color-current', unit: 'A', decimals: 3, label: 'Output current' },
    { canvasId: 'chart-power', field: 'power', colorToken: '--color-power', unit: 'W', decimals: 2, label: 'Power' },
    { canvasId: 'chart-input-voltage', field: 'inputVoltage', colorToken: '--color-input', unit: 'V', decimals: 2, label: 'Input voltage' },
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
    document.querySelectorAll('button[data-recall], button[data-save]').forEach((button) => { button.disabled = !connected; });
    if (!connected) {
      fillSetInputs = true;
      element('output-state').textContent = '–';
    }
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

  function currentScaling() {
    return connection ? connection.scaling : DPS.modelScaling(3005);
  }

  function showDevice(scaling, status) {
    element('device-model').textContent = `${scaling.name} (${status.model})`;
    element('device-firmware').textContent = status.version;
    element('device-range').textContent = `0–${scaling.maxVoltage} V · 0–${scaling.maxCurrent} A`;
    for (const setpoint of Object.values(SETPOINTS)) {
      const input = element(setpoint.inputId);
      input.max = String(scaling[setpoint.maxKey]);
      input.step = String(10 ** -scaling[setpoint.decimalsKey]);
      input.closest('.setpoint').querySelector('[data-max]').textContent = String(scaling[setpoint.maxKey]);
    }
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
    const windowSeconds = Number(Stepper.segmentedValue(element('chart-window')));
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
    const next = Math.min(scaling[setpoint.maxKey], Math.max(0, base + stepCount * step));
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
        `<button type="button" data-save="${index}" disabled aria-label="Save the current U and I into M${index}">Save U/I</button></td>`;
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

  // Save the current U-SET and I-SET of the supply into a group. The other fields of the group do not change.
  async function savePreset(index) {
    if (!connection || !lastStatus) return;
    const { voltageDecimals, currentDecimals } = currentScaling();
    const volts = lastStatus.voltageSet;
    const amps = lastStatus.currentSet;
    const text = `${volts.toFixed(voltageDecimals)} V and ${amps.toFixed(currentDecimals)} A`;
    const question = index === 0
      ? `Save ${text} into M0?\n\nThe supply loads M0 at power on. The OVP, OCP and OPP limits of M0 do not change.`
      : `Save ${text} into M${index}?\n\nThe OVP, OCP and OPP limits of M${index} do not change.`;
    if (!confirm(question)) return;
    const activeConnection = connection;
    const done = await runCommand(`Save ${text} into M${index}`, (port) => port.savePresetSetpoints(index, volts, amps));
    if (!done || connection !== activeConnection) return;
    try {
      showPreset(index, await activeConnection.readPreset(index));
    } catch (error) {
      addLogLine(`Read M${index} failed: ${error.message}`);
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
    Object.values(SETPOINTS).forEach(bindSetpoint);
    element('output-switch').addEventListener('change', (event) => onSwitchChange(event.target,
      (on) => `Output ${on ? 'on' : 'off'}`, (port, on) => port.setOutput(on)));
    element('lock-switch').addEventListener('change', (event) => onSwitchChange(event.target,
      (locked) => (locked ? 'Lock keys' : 'Unlock keys'), (port, locked) => port.setLock(locked)));
    element('brightness').addEventListener('input', showBrightness);
    element('brightness').addEventListener('change', changeBrightness);
    element('read-presets').addEventListener('click', readPresets);
    element('preset-body').addEventListener('click', (event) => {
      const recallButton = event.target.closest('button[data-recall]');
      if (recallButton) recallPreset(Number(recallButton.dataset.recall));
      const saveButton = event.target.closest('button[data-save]');
      if (saveButton) savePreset(Number(saveButton.dataset.save));
    });
    new ResizeObserver(scheduleDraw).observe(document.querySelector('main'));
    Theme.init(scheduleDraw); // Redraw the charts when the scheme changes.
    window.addEventListener('pagehide', () => { if (connection) connection.close(); });
    setConnectedUi(false);
    showBrightness();
    scheduleDraw();
  }

  init();
})();

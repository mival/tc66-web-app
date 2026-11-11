// Battery test page: record a discharge to SQLite, show live capacity, and graph saved tests.
(function () {
  'use strict';

  const element = (id) => document.getElementById(id);
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
  const LIVE_BUFFER_LIMIT = 4000; // Samples kept for the idle live charts.
  const DB_FLUSH_INTERVAL_MS = 15000; // Write buffered samples to the database at most this often.
  const ETA_WINDOW_MS = 5 * 60 * 1000; // The remaining-time estimate uses the average power of this period.
  const ETA_MIN_DATA_MS = 20000; // Show no estimate until the test has this much data.

  const CHART_SERIES = [
    { field: 'v', suffix: 'voltage', colorToken: '--color-voltage', unit: 'V', decimals: 3, label: 'Voltage' },
    { field: 'a', suffix: 'current', colorToken: '--color-current', unit: 'A', decimals: 4, label: 'Current' },
    { field: 'w', suffix: 'power', colorToken: '--color-power', unit: 'W', decimals: 3, label: 'Power' },
    { field: 'mAh', suffix: 'mah', colorToken: '--color-success', unit: 'mAh', decimals: 0, label: 'Charge' },
  ];

  let connection = null;
  let pollingLoopId = 0;
  let db = null;
  let liveBuffer = [];
  let recording = null; // { sessionId, startedAt, samples, pending, totalMah, totalWh, ratedWh, prev, lastFlush, energyMarks }
  let autoBelowSince = null;
  let selectedSessionId = null;
  let drawScheduled = false;
  let liveCharts = null;
  let viewCharts = null;

  // ---------- Log and status ----------

  function addLogLine(message) {
    const logElement = element('log');
    const line = `${new Date().toLocaleTimeString()}  ${message}\n`;
    logElement.textContent = (logElement.textContent + line).split('\n').slice(-200).join('\n');
    logElement.scrollTop = logElement.scrollHeight;
  }

  function setStatus(text, state = '') {
    element('status-text').textContent = text;
    element('status-dot').className = 'dot' + (state ? ' ' + state : '');
  }

  // ---------- Database ----------

  async function initDatabase() {
    try {
      db = await TC66DB_API.TC66DB.open({});
      await refreshHistory();
    } catch (error) {
      element('db-error').hidden = false;
      element('db-error').textContent =
        'Cannot start the database. A private window may block storage. ' +
        'Live measurement still works, but tests cannot be saved. Details: ' + error.message;
      addLogLine(`Database init failed: ${error.message}`);
    }
  }

  // ---------- Connection ----------

  async function connect() {
    if (connection) return;
    let serialPort;
    try {
      serialPort = await navigator.serial.requestPort({ filters: [{ usbVendorId: TC66.USB_VENDOR_ID }] });
    } catch (error) {
      if (error.name !== 'NotFoundError') addLogLine(`Port selection failed: ${error.message}`);
      return;
    }
    const newConnection = new TC66.TC66Port(serialPort);
    setStatus('Opening port…');
    try {
      await newConnection.open();
    } catch (error) {
      setStatus('Cannot open the port', 'error');
      addLogLine(`Open failed: ${error.message}. Close other programs that use the port.`);
      return;
    }
    newConnection.onclose = (error) => onConnectionLost(newConnection, error);
    connection = newConnection;
    element('connect').disabled = true;
    element('disconnect').disabled = false;
    addLogLine('Port open (115200 8N1, DTR and RTS on).');
    try {
      const mode = await newConnection.query();
      addLogLine(`query → "${mode}"`);
      if (mode === 'boot') {
        setStatus('Bootloader mode', 'error');
        addLogLine('The meter is in bootloader mode. Replug it without K1 for normal use.');
        return;
      }
    } catch (error) {
      addLogLine(`query failed: ${error.message}`);
    }
    setStatus('Connected', 'on');
    element('test-status').textContent = 'Ready. Start a test, or enable automatic start.';
    refreshTestButtons();
    startPolling();
  }

  async function disconnect() {
    const current = connection;
    if (!current) return;
    if (recording) await stopTest('disconnect');
    connection = null;
    pollingLoopId++;
    await current.close();
    element('connect').disabled = false;
    element('disconnect').disabled = true;
    setStatus('Not connected');
    addLogLine('Port closed.');
    refreshTestButtons();
  }

  function onConnectionLost(lost, error) {
    if (connection !== lost) return;
    if (recording) stopTest('connection lost').catch(() => {});
    connection = null;
    pollingLoopId++;
    element('connect').disabled = false;
    element('disconnect').disabled = true;
    setStatus('Connection lost', 'error');
    addLogLine(`Connection lost: ${error ? error.message : 'unknown reason'}`);
    refreshTestButtons();
  }

  // ---------- Polling ----------

  function startPolling() {
    const loopId = ++pollingLoopId;
    pollLoop(loopId);
  }

  async function pollLoop(loopId) {
    let failures = 0;
    while (loopId === pollingLoopId && connection) {
      const active = connection;
      const startTime = performance.now();
      try {
        const reading = await active.getva();
        if (loopId !== pollingLoopId) break;
        failures = 0;
        onSample(reading);
      } catch (error) {
        if (loopId !== pollingLoopId || connection !== active) break;
        failures++;
        addLogLine(error.message);
        if (failures >= 3) { addLogLine('Three reads failed. Polling stops.'); await disconnect(); break; }
        await active.discardUntilSilent(300).catch(() => {});
      }
      const interval = Number(element('sample-interval').value);
      await sleep(Math.max(0, interval - (performance.now() - startTime)));
    }
  }

  function onSample(reading) {
    const sample = { t: Date.now(), v: reading.voltage, a: reading.current, w: reading.power };
    element('stat-v').textContent = reading.voltage.toFixed(4);
    element('stat-a').textContent = reading.current.toFixed(5);
    element('stat-w').textContent = reading.power.toFixed(3);

    liveBuffer.push(sample);
    if (liveBuffer.length > LIVE_BUFFER_LIMIT) liveBuffer.splice(0, liveBuffer.length - LIVE_BUFFER_LIMIT);

    const autoMode = element('auto-mode').checked;
    const startThreshold = Number(element('start-threshold').value);
    if (!recording && autoMode && reading.current >= startThreshold) {
      startTest(true);
    }

    if (recording) {
      addRecordingSample(sample);
      if (autoMode) handleAutoStop(reading.current);
    }
    scheduleDraw();
  }

  // ---------- Recording ----------

  let startingTest = false;

  async function startTest(auto = false) {
    if (recording || startingTest || !connection) return;
    if (!db) { element('test-status').textContent = 'The database is not ready. Tests cannot be saved.'; return; }
    startingTest = true;
    const name = element('session-name').value.trim() || `Test ${new Date().toLocaleString()}`;
    const ratedMah = element('rated-mah').value ? Number(element('rated-mah').value) : null;
    const nominalV = element('nominal-v').value ? Number(element('nominal-v').value) : null;
    const ratedWh = ratedMah != null && nominalV != null ? (ratedMah * nominalV) / 1000 : null;
    const startedAt = Date.now();
    // Set the recording state now. Samples buffer while createSession resolves.
    recording = { sessionId: null, startedAt, samples: [], pending: [], totalMah: 0, totalWh: 0, ratedWh, prev: null, lastFlush: startedAt, energyMarks: [] };
    liveBuffer = [];
    autoBelowSince = null;
    element('test-status').textContent = `Recording "${name}"${auto ? ' (auto start)' : ''}…`;
    refreshTestButtons();
    try {
      recording.sessionId = await db.createSession({ name, ratedMah, nominalV, startedAt });
      addLogLine(`Test "${name}" started${auto ? ' automatically' : ''}.`);
    } catch (error) {
      recording = null;
      element('test-status').textContent = `Cannot start the test: ${error.message}`;
      addLogLine(`Cannot create the test: ${error.message}`);
      refreshTestButtons();
    } finally {
      startingTest = false;
    }
  }

  function addRecordingSample(sample) {
    recording.samples.push(sample);
    recording.pending.push(sample);
    // Integrate between the last two samples (trapezoid rule).
    if (recording.prev) {
      const dtHours = (sample.t - recording.prev.t) / 3600000;
      if (dtHours > 0) {
        recording.totalMah += ((sample.a + recording.prev.a) / 2) * dtHours * 1000;
        recording.totalWh += ((sample.w + recording.prev.w) / 2) * dtHours;
      }
    }
    recording.prev = sample;
    // Keep the cumulative energy for the estimate window, plus one older mark as the window start.
    const marks = recording.energyMarks;
    marks.push({ t: sample.t, wh: recording.totalWh });
    while (marks.length > 2 && sample.t - marks[1].t >= ETA_WINDOW_MS) marks.shift();
    updateLiveStats();
    if (sample.t - recording.lastFlush >= DB_FLUSH_INTERVAL_MS) flushPending();
  }

  function flushPending() {
    if (!db || !recording || recording.sessionId == null || !recording.pending.length) return;
    const batch = recording.pending;
    recording.pending = [];
    recording.lastFlush = Date.now();
    db.addSamples(recording.sessionId, batch).catch((error) => addLogLine(`Cannot save samples: ${error.message}`));
  }

  function updateLiveStats() {
    const durationS = recording.samples.length ? (recording.prev.t - recording.startedAt) / 1000 : 0;
    element('stat-time').textContent = UChart.formatTime(durationS);
    element('stat-mah').textContent = recording.totalMah.toFixed(1);
    element('stat-wh').textContent = recording.totalWh.toFixed(3);
    const eff = TC66DB_API.efficiency(recording.totalWh, recording.ratedWh);
    element('stat-eff').textContent = eff != null ? `${eff.toFixed(1)} %` : '–';
    updateRemaining();
  }

  // Estimate the remaining time from the rated energy and the average power of the last minutes.
  // The rated energy is the rated mAh at the cell voltage. It does not include conversion losses,
  // so the real remaining time is usually shorter.
  function updateRemaining() {
    const valueElement = element('stat-eta');
    const noteElement = element('stat-eta-note');
    const show = (value, note) => { valueElement.textContent = value; noteElement.textContent = note; };
    if (!recording) { show('–', element('rated-mah').value ? '' : 'set the rated capacity'); return; }
    if (recording.ratedWh == null || recording.ratedWh <= 0) { show('–', 'needs a rated capacity'); return; }
    const remainingWh = recording.ratedWh - recording.totalWh;
    if (remainingWh <= 0) { show('0:00', 'past the rating'); return; }
    const marks = recording.energyMarks;
    const first = marks[0];
    const last = marks[marks.length - 1];
    const spanMs = last.t - first.t;
    if (spanMs < ETA_MIN_DATA_MS) { show('…', 'measuring'); return; }
    const averageW = (last.wh - first.wh) / (spanMs / 3600000);
    if (!(averageW > 0.01)) { show('–', 'no load'); return; }
    const remainingS = (remainingWh / averageW) * 3600;
    const endsAt = new Date(last.t + remainingS * 1000);
    const sameDay = endsAt.toDateString() === new Date().toDateString();
    const clock = endsAt.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    const day = sameDay ? '' : `${endsAt.toLocaleDateString([], { weekday: 'short' })} `;
    show(UChart.formatTime(remainingS), `ends ~${day}${clock} at ${averageW.toFixed(2)} W`);
  }

  function handleAutoStop(current) {
    const stopThreshold = Number(element('stop-threshold').value);
    const holdSeconds = Number(element('stop-hold').value);
    if (current < stopThreshold) {
      if (autoBelowSince == null) autoBelowSince = Date.now();
      else if (Date.now() - autoBelowSince >= holdSeconds * 1000) stopTest('auto stop');
    } else {
      autoBelowSince = null;
    }
  }

  async function stopTest(reason = 'manual') {
    if (!recording) return;
    const finished = recording;
    recording = null;
    autoBelowSince = null;
    updateRemaining();
    if (db && finished.sessionId != null) {
      try {
        if (finished.pending.length) await db.addSamples(finished.sessionId, finished.pending);
        await db.endSession(finished.sessionId, {
          endedAt: Date.now(),
          mAh: finished.totalMah,
          wh: finished.totalWh,
          sampleCount: finished.samples.length,
        });
      } catch (error) {
        addLogLine(`Cannot finish the test: ${error.message}`);
      }
    }
    element('test-status').textContent =
      `Test done (${reason}): ${finished.totalMah.toFixed(1)} mAh, ${finished.totalWh.toFixed(3)} Wh.`;
    addLogLine(`Test stopped (${reason}): ${finished.samples.length} samples, ${finished.totalMah.toFixed(1)} mAh.`);
    await refreshHistory();
    refreshTestButtons();
  }

  function refreshTestButtons() {
    element('start-test').disabled = !connection || !!recording || !db;
    element('stop-test').disabled = !recording;
  }

  // ---------- Charts ----------

  function scheduleDraw() {
    if (drawScheduled) return;
    drawScheduled = true;
    requestAnimationFrame(() => { drawScheduled = false; drawLiveCharts(); });
  }

  // Build the four charts in the containers with the given id prefix. They share a cursor.
  function buildCharts(prefix) {
    const sync = UChart.sync(prefix || 'live');
    const charts = {};
    for (const series of CHART_SERIES) {
      charts[series.field] = UChart.create(element(`${prefix}chart-${series.suffix}`), {
        label: series.label, unit: series.unit, colorToken: series.colorToken, decimals: series.decimals, sync,
      });
    }
    return charts;
  }

  // Add elapsed time and cumulative mAh, then set the data on each chart.
  function setChartData(charts, samples) {
    const rows = TC66DB_API.integrateTimeSeries(samples).rows;
    const times = rows.map((r) => r.elapsedS);
    for (const series of CHART_SERIES) charts[series.field].setData(times, rows.map((r) => r[series.field]));
  }

  function drawLiveCharts() {
    if (!liveCharts) liveCharts = buildCharts('');
    setChartData(liveCharts, recording ? recording.samples : liveBuffer);
  }

  // Remove the charts so they rebuild with the new theme colors.
  function rebuildCharts() {
    if (liveCharts) { Object.values(liveCharts).forEach((chart) => chart.destroy()); liveCharts = null; }
    if (viewCharts) { Object.values(viewCharts).forEach((chart) => chart.destroy()); viewCharts = null; }
    scheduleDraw();
    if (selectedSessionId != null) viewSession(selectedSessionId);
  }

  // ---------- History ----------

  function formatDate(ms) {
    return new Date(ms).toLocaleString();
  }

  async function refreshHistory() {
    if (!db) return;
    const sessions = await db.listSessions();
    const body = element('history-body');
    body.textContent = '';
    element('history-empty').hidden = sessions.length > 0;
    element('history-table').hidden = sessions.length === 0;
    for (const session of sessions) {
      const eff = TC66DB_API.efficiency(session.wh, session.ratedWh);
      const row = document.createElement('tr');
      row.dataset.id = session.id;
      if (session.id === selectedSessionId) row.classList.add('selected');
      const durationS = session.endedAt ? (session.endedAt - session.startedAt) / 1000 : 0;
      const cells = [
        session.name,
        formatDate(session.startedAt),
        UChart.formatTime(durationS),
        session.mAh ? session.mAh.toFixed(0) : '–',
        session.wh ? session.wh.toFixed(2) : '–',
        eff != null ? `${eff.toFixed(0)} %` : '–',
      ];
      for (const text of cells) {
        const cell = document.createElement('td');
        cell.textContent = text;
        row.append(cell);
      }
      const actionCell = document.createElement('td');
      const viewButton = document.createElement('button');
      viewButton.textContent = 'View';
      viewButton.addEventListener('click', () => viewSession(session.id));
      actionCell.append(viewButton);
      row.append(actionCell);
      body.append(row);
    }
  }

  async function viewSession(id) {
    if (!db) return;
    selectedSessionId = id;
    const session = (await db.listSessions()).find((s) => s.id === id);
    if (!session) return;
    const samples = await db.getSamples(id);
    const integrated = TC66DB_API.integrateTimeSeries(samples);
    const eff = TC66DB_API.efficiency(integrated.wh, session.ratedWh);
    element('view-session').hidden = false;
    element('view-title').textContent = session.name;
    const ratedText = session.ratedMah != null
      ? `${session.ratedMah} mAh @ ${session.nominalV} V = ${session.ratedWh.toFixed(1)} Wh`
      : 'not set';
    element('view-stats').innerHTML = `
      <dt>Started</dt><dd>${formatDate(session.startedAt)}</dd>
      <dt>Duration</dt><dd>${UChart.formatTime(integrated.durationS)} · ${integrated.count} samples</dd>
      <dt>Delivered</dt><dd>${integrated.mAh.toFixed(1)} mAh · ${integrated.wh.toFixed(3)} Wh</dd>
      <dt>Average</dt><dd>${integrated.avgVoltage.toFixed(3)} V · voltage ${integrated.minVoltage.toFixed(3)}–${integrated.maxVoltage.toFixed(3)} V</dd>
      <dt>Peak</dt><dd>${integrated.maxCurrent.toFixed(4)} A · ${integrated.maxPower.toFixed(3)} W</dd>
      <dt>Rated</dt><dd>${ratedText}</dd>
      <dt>Efficiency</dt><dd>${eff != null ? `${eff.toFixed(1)} % of the rating` : 'needs a rated capacity'}</dd>`;
    if (!viewCharts) viewCharts = buildCharts('view-');
    setChartData(viewCharts, samples);
    await refreshHistory();
    element('view-session').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  function sessionCsv(session, samples) {
    const rows = TC66DB_API.integrateTimeSeries(samples).rows;
    const lines = ['time_iso,elapsed_s,volts,amps,watts,mAh,wh'];
    for (const r of rows) {
      lines.push([new Date(r.t).toISOString(), r.elapsedS.toFixed(3), r.v.toFixed(4), r.a.toFixed(5), r.w.toFixed(4), r.mAh.toFixed(2), r.wh.toFixed(4)].join(','));
    }
    return lines.join('\n') + '\n';
  }

  function saveFile(name, content, type) {
    const url = URL.createObjectURL(new Blob([content], { type }));
    const link = document.createElement('a');
    link.href = url;
    link.download = name;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 10000);
  }

  function slug(text) {
    return text.replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').toLowerCase() || 'test';
  }

  // ---------- Events ----------

  function init() {
    if (!('serial' in navigator)) {
      element('unsupported').hidden = false;
      element('connect').disabled = true;
      setStatus('Web Serial not available', 'error');
    }
    element('connect').addEventListener('click', connect);
    element('disconnect').addEventListener('click', disconnect);
    Theme.init(rebuildCharts); // Rebuild the charts with the new colors when the scheme changes.
    element('start-test').addEventListener('click', () => startTest(false));
    element('stop-test').addEventListener('click', () => stopTest('manual'));
    element('export-db').addEventListener('click', async () => {
      if (!db) return;
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '');
      const data = await db.exportData();
      saveFile(`tc66-battery-${stamp}.json`, JSON.stringify(data), 'application/json');
    });
    element('import-db').addEventListener('change', async (event) => {
      const file = event.target.files[0];
      if (!file || !db) return;
      if (!confirm('Import replaces all saved tests. Export first if you want a backup. Continue?')) {
        event.target.value = '';
        return;
      }
      try {
        await db.importData(JSON.parse(await file.text()));
        selectedSessionId = null;
        element('view-session').hidden = true;
        await refreshHistory();
        element('history-status').textContent = `Imported "${file.name}".`;
        addLogLine(`Tests imported from "${file.name}".`);
      } catch (error) {
        element('history-status').textContent = `Import failed: ${error.message}`;
        addLogLine(`Import failed: ${error.message}`);
      }
      event.target.value = '';
    });
    element('rename-session').addEventListener('click', async () => {
      if (!db || selectedSessionId == null) return;
      const session = (await db.listSessions()).find((s) => s.id === selectedSessionId);
      const name = prompt('New name for the test:', session ? session.name : '');
      if (name) { await db.renameSession(selectedSessionId, name.trim()); await viewSession(selectedSessionId); }
    });
    element('delete-session').addEventListener('click', async () => {
      if (!db || selectedSessionId == null) return;
      if (!confirm('Delete this test and its samples? This cannot be undone.')) return;
      await db.deleteSession(selectedSessionId);
      addLogLine(`Test ${selectedSessionId} deleted.`);
      selectedSessionId = null;
      element('view-session').hidden = true;
      await refreshHistory();
    });
    element('download-session-csv').addEventListener('click', async () => {
      if (!db || selectedSessionId == null) return;
      const session = (await db.listSessions()).find((s) => s.id === selectedSessionId);
      if (!session) return;
      saveFile(`tc66-${slug(session.name)}.csv`, sessionCsv(session, await db.getSamples(selectedSessionId)), 'text/csv');
    });
    new ResizeObserver(scheduleDraw).observe(document.querySelector('main'));
    window.addEventListener('pagehide', () => { if (connection) connection.close(); });
    element('rated-mah').addEventListener('input', () => { if (!recording) updateRemaining(); });
    updateRemaining();
    scheduleDraw();
    initDatabase();
  }

  init();
})();

// IndexedDB storage for battery test sessions. No external dependency.
// A session holds the test metadata. Samples hold the time series.
// This file works in the browser (classic script). Node loads it (require) for the pure-function tests.
(function (globalScope) {
  'use strict';

  // ---------- Capacity math (pure, testable in Node) ----------

  // Integrate a time series into charge (mAh) and energy (Wh).
  // samples: [{ t (ms), v, a, w }], sorted by time. Uses the trapezoid rule.
  // Returns totals and the per-sample cumulative values, for a graph.
  function integrateTimeSeries(samples) {
    let mAh = 0;
    let wh = 0;
    let minVoltage = Infinity, maxVoltage = -Infinity, maxCurrent = 0, maxPower = 0;
    const rows = [];
    for (let i = 0; i < samples.length; i++) {
      const s = samples[i];
      if (i > 0) {
        const dtHours = (s.t - samples[i - 1].t) / 3600000; // ms to hours
        if (dtHours > 0) {
          mAh += ((s.a + samples[i - 1].a) / 2) * dtHours * 1000;
          wh += ((s.w + samples[i - 1].w) / 2) * dtHours;
        }
      }
      minVoltage = Math.min(minVoltage, s.v);
      maxVoltage = Math.max(maxVoltage, s.v);
      maxCurrent = Math.max(maxCurrent, s.a);
      maxPower = Math.max(maxPower, s.w);
      rows.push({ ...s, elapsedS: samples.length ? (s.t - samples[0].t) / 1000 : 0, mAh, wh });
    }
    const count = samples.length;
    return {
      rows,
      count,
      durationS: count ? (samples[count - 1].t - samples[0].t) / 1000 : 0,
      mAh,
      wh,
      minVoltage: count ? minVoltage : 0,
      maxVoltage: count ? maxVoltage : 0,
      maxCurrent,
      maxPower,
      avgVoltage: count ? samples.reduce((sum, s) => sum + s.v, 0) / count : 0,
    };
  }

  // Compute efficiency against a rated capacity. deliveredWh / ratedWh.
  function efficiency(deliveredWh, ratedWh) {
    if (!ratedWh || ratedWh <= 0) return null;
    return (deliveredWh / ratedWh) * 100;
  }

  // ---------- IndexedDB store ----------

  const DEFAULT_DB_NAME = 'tc66-battery';
  const DB_VERSION = 1;
  const EXPORT_FORMAT = 'tc66-battery';

  function requestResult(request) {
    return new Promise((resolve, reject) => {
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  function transactionDone(transaction) {
    return new Promise((resolve, reject) => {
      transaction.oncomplete = () => resolve();
      transaction.onerror = () => reject(transaction.error);
      transaction.onabort = () => reject(transaction.error);
    });
  }

  function openDatabase(name) {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open(name, DB_VERSION);
      request.onupgradeneeded = () => {
        const database = request.result;
        if (!database.objectStoreNames.contains('sessions')) {
          const store = database.createObjectStore('sessions', { keyPath: 'id', autoIncrement: true });
          store.createIndex('started_at', 'started_at');
        }
        if (!database.objectStoreNames.contains('samples')) {
          const store = database.createObjectStore('samples', { keyPath: 'id', autoIncrement: true });
          store.createIndex('session_id', 'session_id');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Map a stored session row to the shape the page uses.
  function mapSession(row) {
    return {
      id: row.id,
      name: row.name,
      ratedMah: row.rated_mah,
      nominalV: row.nominal_v,
      ratedWh: row.rated_wh,
      startedAt: row.started_at,
      endedAt: row.ended_at,
      sampleCount: row.sample_count,
      mAh: row.mah,
      wh: row.wh,
      note: row.note,
    };
  }

  class TC66DB {
    constructor(database) {
      this.database = database;
    }

    static async open({ dbName = DEFAULT_DB_NAME } = {}) {
      return new TC66DB(await openDatabase(dbName));
    }

    // Start a session. meta: { name, ratedMah, nominalV, note, startedAt }. Returns the new id.
    async createSession(meta) {
      const ratedMah = meta.ratedMah != null ? meta.ratedMah : null;
      const nominalV = meta.nominalV != null ? meta.nominalV : null;
      const row = {
        name: meta.name || 'Test',
        rated_mah: ratedMah,
        nominal_v: nominalV,
        rated_wh: ratedMah != null && nominalV != null ? (ratedMah * nominalV) / 1000 : null,
        started_at: meta.startedAt || Date.now(),
        ended_at: null,
        sample_count: 0,
        mah: 0,
        wh: 0,
        note: meta.note || null,
      };
      const transaction = this.database.transaction('sessions', 'readwrite');
      const id = await requestResult(transaction.objectStore('sessions').add(row));
      await transactionDone(transaction);
      return id;
    }

    // Insert many samples in one transaction.
    async addSamples(sessionId, samples) {
      if (!samples.length) return;
      const transaction = this.database.transaction('samples', 'readwrite');
      const store = transaction.objectStore('samples');
      for (const sample of samples) {
        store.add({ session_id: sessionId, t: sample.t, v: sample.v, a: sample.a, w: sample.w });
      }
      await transactionDone(transaction);
    }

    async addSample(sessionId, sample) {
      return this.addSamples(sessionId, [sample]);
    }

    // Store the final totals.
    endSession(sessionId, { endedAt, mAh, wh, sampleCount }) {
      return new Promise((resolve, reject) => {
        const transaction = this.database.transaction('sessions', 'readwrite');
        const store = transaction.objectStore('sessions');
        const getRequest = store.get(sessionId);
        getRequest.onsuccess = () => {
          const row = getRequest.result;
          if (row) {
            row.ended_at = endedAt || Date.now();
            row.mah = mAh || 0;
            row.wh = wh || 0;
            row.sample_count = sampleCount || 0;
            store.put(row);
          }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
        transaction.onabort = () => reject(transaction.error);
      });
    }

    renameSession(sessionId, name) {
      return new Promise((resolve, reject) => {
        const transaction = this.database.transaction('sessions', 'readwrite');
        const store = transaction.objectStore('sessions');
        const getRequest = store.get(sessionId);
        getRequest.onsuccess = () => {
          const row = getRequest.result;
          if (row) { row.name = name; store.put(row); }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }

    deleteSession(sessionId) {
      return new Promise((resolve, reject) => {
        const transaction = this.database.transaction(['sessions', 'samples'], 'readwrite');
        transaction.objectStore('sessions').delete(sessionId);
        const cursorRequest = transaction.objectStore('samples').index('session_id').openCursor(IDBKeyRange.only(sessionId));
        cursorRequest.onsuccess = () => {
          const cursor = cursorRequest.result;
          if (cursor) { cursor.delete(); cursor.continue(); }
        };
        transaction.oncomplete = () => resolve();
        transaction.onerror = () => reject(transaction.error);
      });
    }

    async listSessions() {
      const transaction = this.database.transaction('sessions', 'readonly');
      const rows = await requestResult(transaction.objectStore('sessions').getAll());
      await transactionDone(transaction);
      return rows.map(mapSession).sort((a, b) => b.startedAt - a.startedAt);
    }

    async getSamples(sessionId) {
      const transaction = this.database.transaction('samples', 'readonly');
      const rows = await requestResult(transaction.objectStore('samples').index('session_id').getAll(IDBKeyRange.only(sessionId)));
      await transactionDone(transaction);
      return rows.map((row) => ({ t: row.t, v: row.v, a: row.a, w: row.w })).sort((a, b) => a.t - b.t);
    }

    // Export the whole database as a plain object (for a JSON file).
    async exportData() {
      const transaction = this.database.transaction(['sessions', 'samples'], 'readonly');
      const sessions = await requestResult(transaction.objectStore('sessions').getAll());
      const samples = await requestResult(transaction.objectStore('samples').getAll());
      await transactionDone(transaction);
      return { format: EXPORT_FORMAT, version: 1, sessions, samples };
    }

    // Replace the whole database with imported data. New ids avoid clashes with the key generator.
    async importData(data) {
      if (!data || data.format !== EXPORT_FORMAT) throw new Error('Not a TC66 battery export file.');
      let transaction = this.database.transaction(['sessions', 'samples'], 'readwrite');
      transaction.objectStore('sessions').clear();
      transaction.objectStore('samples').clear();
      await transactionDone(transaction);

      const idMap = new Map();
      transaction = this.database.transaction('sessions', 'readwrite');
      const sessionStore = transaction.objectStore('sessions');
      for (const session of data.sessions || []) {
        const { id, ...rest } = session;
        const request = sessionStore.add(rest);
        request.onsuccess = () => idMap.set(id, request.result);
      }
      await transactionDone(transaction);

      transaction = this.database.transaction('samples', 'readwrite');
      const sampleStore = transaction.objectStore('samples');
      for (const sample of data.samples || []) {
        const { id, session_id: sessionId, ...rest } = sample;
        sampleStore.add({ session_id: idMap.get(sessionId) != null ? idMap.get(sessionId) : sessionId, ...rest });
      }
      await transactionDone(transaction);
    }

    close() {
      this.database.close();
    }
  }

  const api = { TC66DB, integrateTimeSeries, efficiency };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalScope.TC66DB_API = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);

// Tests for the capacity math in js/db.js. The IndexedDB store runs only in the browser,
// so the session store has coverage in test/battery.e2e.mjs instead.
// Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DB = require('../js/db.js');

test('integrateTimeSeries gives exact values for a constant load', () => {
  // 1 A at 5 V for one hour: 1000 mAh and 5 Wh.
  const samples = [];
  for (let second = 0; second <= 3600; second++) samples.push({ t: second * 1000, v: 5, a: 1, w: 5 });
  const result = DB.integrateTimeSeries(samples);
  assert.ok(Math.abs(result.mAh - 1000) < 1e-6, `mAh ${result.mAh}`);
  assert.ok(Math.abs(result.wh - 5) < 1e-6, `wh ${result.wh}`);
  assert.equal(result.durationS, 3600);
  assert.equal(result.rows[result.rows.length - 1].mAh.toFixed(3), '1000.000');
});

test('integrateTimeSeries matches the real recording total', () => {
  const TC66 = require('../js/tc66.js');
  const dump = new Uint8Array(fs.readFileSync(path.join(__dirname, 'fixtures', 'tc66_rec.bin')));
  const { records } = TC66.parseGtrec(dump);
  const samples = records.map((r, i) => ({ t: i * 10000, v: r.voltage, a: r.current, w: r.power }));
  const result = DB.integrateTimeSeries(samples);
  assert.ok(Math.abs(result.mAh - 1574) < 5, `mAh ${result.mAh}`);
});

test('integrateTimeSeries handles an empty series and a single sample', () => {
  const empty = DB.integrateTimeSeries([]);
  assert.equal(empty.count, 0);
  assert.equal(empty.mAh, 0);
  const single = DB.integrateTimeSeries([{ t: 0, v: 5, a: 1, w: 5 }]);
  assert.equal(single.count, 1);
  assert.equal(single.mAh, 0); // One sample gives no interval.
});

test('efficiency compares delivered energy to the rating', () => {
  assert.equal(DB.efficiency(37, 37), 100);
  assert.equal(DB.efficiency(18.5, 37), 50);
  assert.equal(DB.efficiency(5, null), null);
  assert.equal(DB.efficiency(5, 0), null);
});

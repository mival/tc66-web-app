// Unit tests for js/tc66.js. Run: node --test test/
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const TC66 = require('../js/tc66.js');

const fixturePath = (name) => path.join(__dirname, 'fixtures', name);
const readFixture = (name) => new Uint8Array(fs.readFileSync(fixturePath(name)));

test('AES-256-ECB decryption gives the same result as node:crypto', () => {
  for (let blockCount = 1; blockCount <= 20; blockCount++) {
    const key = crypto.randomBytes(32);
    const plaintext = crypto.randomBytes(16 * blockCount);
    const cipher = crypto.createCipheriv('aes-256-ecb', key, null).setAutoPadding(false);
    const encrypted = Buffer.concat([cipher.update(plaintext), cipher.final()]);
    const decrypted = TC66.aes256EcbDecrypt(new Uint8Array(key), new Uint8Array(encrypted));
    assert.deepEqual(Buffer.from(decrypted), plaintext);
  }
});

test('getva dumps from the meter decode to plausible values', () => {
  for (const name of ['getva-0.bin', 'getva-1.bin', 'getva-2.bin']) {
    const response = readFixture(name);
    const decipher = crypto.createDecipheriv('aes-256-ecb', Buffer.from(TC66.GETVA_KEY), null).setAutoPadding(false);
    const expected = Buffer.concat([decipher.update(response), decipher.final()]);
    const reading = TC66.parseGetva(response);
    assert.deepEqual(Buffer.from(reading.decrypted), expected);
    assert.equal(reading.model, 'TC66');
    assert.equal(reading.firmware, '1.17');
    assert.equal(reading.serial, 5795);
    assert.deepEqual(reading.crcValid, [true, true, true]);
    assert.ok(reading.voltage >= 0 && reading.voltage < 30, `voltage ${reading.voltage}`);
    assert.ok(reading.temperature > -40 && reading.temperature < 100, `temperature ${reading.temperature}`);
  }
});

test('getva rejects corrupted data', () => {
  const badHeader = readFixture('getva-0.bin');
  badHeader[0] ^= 0xff;
  assert.throws(() => TC66.parseGetva(badHeader), /packet headers/);
  assert.throws(() => TC66.parseGetva(badHeader.subarray(0, 100)), /100 of 192/);
  // Change one byte in the last block of pac2: the header stays correct, the CRC does not.
  const badCrc = readFixture('getva-0.bin');
  badCrc[127] ^= 0x01;
  assert.throws(() => TC66.parseGetva(badCrc), /CRC/);
});

test('gtrec dump matches the CSV from the PowerShell script', () => {
  const dump = readFixture('tc66_rec.bin');
  const { records, hasEndMarker, extraByteCount } = TC66.parseGtrec(dump);
  assert.equal(hasEndMarker, true);
  assert.equal(extraByteCount, 0);
  assert.equal(records.length, 494);
  const csvLines = fs.readFileSync(fixturePath('tc66_rec.csv'), 'utf8').trim().split(/\r?\n/).slice(1);
  assert.equal(csvLines.length, 494);
  csvLines.forEach((line, index) => {
    const [csvIndex, , volts, amps] = line.split(',').map(Number);
    assert.equal(csvIndex, index);
    assert.ok(Math.abs(records[index].voltage - volts) < 1e-9);
    assert.ok(Math.abs(records[index].current - amps) < 1e-9);
  });
  const summary = TC66.summarizeRecords(records, 10);
  assert.equal(summary.durationSeconds, 4940);
  assert.ok(Math.abs(summary.milliampHours - 1574) < 2, `mAh ${summary.milliampHours}`);
  const outputLines = TC66.recordsToCsv(summary).trim().split('\n');
  assert.equal(outputLines[0], 'idx,time_s,volts,amps,watts,mAh,mWh');
  assert.equal(outputLines.length, 495);
});

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

test('sha256Hex matches a known value', async () => {
  const digest = await TC66.sha256Hex(new TextEncoder().encode('abc'));
  assert.equal(digest, 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

// Build a TC66Port with a fake writer that answers the bootloader protocol.
function makeFakePort(answer) {
  const port = new TC66.TC66Port({});
  port.closing = false;
  const encode = (text) => new TextEncoder().encode(text);
  port.writer = {
    write: async (bytes) => {
      const copy = new Uint8Array(bytes.slice());
      const text = String.fromCharCode.apply(null, copy);
      port.__writes.push(copy);
      const reply = answer(text, copy);
      if (reply) port.addReceivedChunk(encode(reply));
    },
  };
  port.__writes = [];
  return port;
}

test('updateFirmware follows the bootloader protocol', async () => {
  const firmware = new Uint8Array(200); // 4 chunks: 64, 64, 64, 8.
  firmware.forEach((_, i) => { firmware[i] = i & 0xff; });
  const port = makeFakePort((text) => {
    if (text === 'query') return 'boot';
    if (text === 'update\r\n') return 'uprdy';
    return 'OK'; // Every chunk is acknowledged.
  });
  const progress = [];
  const result = await port.updateFirmware(firmware, { onProgress: (p) => progress.push(p) });
  assert.equal(result.totalChunks, 4);
  assert.equal(result.totalBytes, 200);
  const writes = port.__writes;
  assert.equal(String.fromCharCode(...writes[0]), 'query');
  assert.equal(String.fromCharCode(...writes[1]), 'update\r\n');
  assert.equal(writes.length, 6); // query, update, 4 chunks.
  assert.equal(writes[2].length, 64);
  assert.equal(writes[5].length, 8); // The last chunk is short.
  assert.equal(progress.length, 4);
  assert.equal(progress[3].bytesSent, 200);
});

test('updateFirmware stops when the meter is not in bootloader mode', async () => {
  const port = makeFakePort((text) => (text === 'query' ? 'firm' : 'OK'));
  await assert.rejects(() => port.updateFirmware(new Uint8Array(64)), /not bootloader mode/);
});

test('updateFirmware stops when a chunk is not acknowledged', async () => {
  let chunkCount = 0;
  const port = makeFakePort((text) => {
    if (text === 'query') return 'boot';
    if (text === 'update\r\n') return 'uprdy';
    chunkCount++;
    return chunkCount === 2 ? 'NO' : 'OK'; // The second chunk fails.
  });
  await assert.rejects(() => port.updateFirmware(new Uint8Array(200)), /chunk 2 of 4/);
});

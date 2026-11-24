// Unit tests for js/dps.js. Run: node --test test/dps.test.js
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const DPS = require('../js/dps.js');

const fixtures = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'dps-frames.json'), 'utf8'));
const frame = (name) => DPS.fromHex(fixtures[name]);
const hex = (bytes) => DPS.toHex(bytes);
const closeTo = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} is not ${expected}`);

// ---------- CRC and frames ----------

test('CRC-16/MODBUS gives the standard check value', () => {
  assert.equal(DPS.crc16Modbus(new TextEncoder().encode('123456789')), 0x4b37);
});

test('all fixture frames have a valid CRC', () => {
  for (const [name, text] of Object.entries(fixtures)) {
    if (name.startsWith('_')) continue;
    assert.ok(DPS.hasValidCrc(DPS.fromHex(text)), name);
  }
  const broken = frame('status_cv_on');
  broken[5] ^= 0x01;
  assert.equal(DPS.hasValidCrc(broken), false);
});

test('request builders give the fixture frames', () => {
  assert.equal(hex(DPS.buildReadRequest(1, 0, 10)), fixtures.canonical_read_request);
  assert.equal(hex(DPS.buildWriteSingleRequest(1, 1, 3)), fixtures.canonical_write_request);
  assert.equal(hex(DPS.buildReadRequest(1, DPS.REGISTER.VOLTAGE_SET, DPS.STATUS_REGISTER_COUNT)), fixtures.status_request);
  assert.equal(hex(DPS.buildReadRequest(1, DPS.presetAddress(1), DPS.PRESET_REGISTER_COUNT)), fixtures.preset_m1_request);
  assert.equal(hex(DPS.buildWriteSingleRequest(1, DPS.REGISTER.ONOFF, 1)), fixtures.write_onoff_request);
  assert.equal(hex(DPS.buildWriteMultipleRequest(1, 0, [1200, 1500])), fixtures.write_uset_iset_request);
  assert.equal(hex(DPS.buildWriteSingleRequest(1, DPS.REGISTER.EXTRACT_MEMORY, 3)), fixtures.recall_m3_request);
});

test('request builders reject values that do not fit', () => {
  assert.throws(() => DPS.buildReadRequest(256, 0, 1), RangeError);
  assert.throws(() => DPS.buildReadRequest(1, 0, 0), RangeError);
  assert.throws(() => DPS.buildReadRequest(1, 0, 126), RangeError);
  assert.throws(() => DPS.buildWriteSingleRequest(1, 0, 65536), RangeError);
  assert.throws(() => DPS.buildWriteSingleRequest(1, 0, -1), RangeError);
  assert.throws(() => DPS.buildWriteMultipleRequest(1, 0, []), RangeError);
});

test('expected response length follows the function code', () => {
  assert.equal(DPS.expectedResponseLength(frame('status_request')), 31);
  assert.equal(DPS.expectedResponseLength(frame('write_onoff_request')), 8);
  assert.equal(DPS.expectedResponseLength(frame('write_uset_iset_request')), 8);
});

// ---------- Response search and parse ----------

test('findResponseFrame waits for a complete frame', () => {
  const request = frame('status_request');
  const response = frame('status_cv_on');
  for (let length = 0; length < response.length; length++) {
    assert.equal(DPS.findResponseFrame(request, response.subarray(0, length)), null, `length ${length}`);
  }
  const found = DPS.findResponseFrame(request, response);
  assert.equal(found.end, response.length);
  assert.equal(hex(found.frame), fixtures.status_cv_on);
});

test('findResponseFrame skips noise before the frame', () => {
  const request = frame('status_request');
  const response = frame('status_cv_on');
  // Noise that starts like a response: slave 1, function 3, but a wrong CRC.
  const noise = Uint8Array.of(0x00, 0xff, 0x01, 0x03, 0x02, 0x00);
  const bytes = new Uint8Array(noise.length + response.length + 3);
  bytes.set(noise);
  bytes.set(response, noise.length);
  bytes.set([0xaa, 0xbb, 0xcc], noise.length + response.length);
  const found = DPS.findResponseFrame(request, bytes);
  assert.ok(found);
  assert.equal(hex(found.frame), fixtures.status_cv_on);
  assert.equal(found.end, noise.length + response.length);
});

test('findResponseFrame finds an exception response', () => {
  const found = DPS.findResponseFrame(frame('status_request'), frame('exception_illegal_address'));
  assert.equal(hex(found.frame), fixtures.exception_illegal_address);
});

test('parseResponse reads the registers of a status response', () => {
  const { registers } = DPS.parseResponse(frame('status_request'), frame('status_cv_on'));
  assert.deepEqual(registers, [500, 1000, 498, 512, 255, 1210, 0, 0, 0, 1, 4, 3005, 16]);
});

test('parseResponse checks the echo of a write', () => {
  assert.deepEqual(DPS.parseResponse(frame('write_onoff_request'), frame('write_onoff_request')), { address: 9, value: 1 });
  assert.deepEqual(DPS.parseResponse(frame('write_uset_iset_request'), frame('write_uset_iset_response')), { address: 0, value: 2 });
  const otherValue = DPS.buildWriteSingleRequest(1, DPS.REGISTER.ONOFF, 0);
  assert.throws(() => DPS.parseResponse(frame('write_onoff_request'), otherValue), /different value/);
  const otherAddress = DPS.buildWriteSingleRequest(1, DPS.REGISTER.LOCK, 1);
  assert.throws(() => DPS.parseResponse(frame('write_onoff_request'), otherAddress), /different register address/);
});

test('parseResponse throws a ModbusException for an exception frame', () => {
  assert.throws(
    () => DPS.parseResponse(frame('status_request'), frame('exception_illegal_address')),
    (error) => error instanceof DPS.ModbusException && error.exceptionCode === 2 && /illegal data address/.test(error.message),
  );
});

test('parseResponse rejects a wrong slave, a wrong function and a bad CRC', () => {
  const fromSlave2 = DPS.appendCrc(Uint8Array.of(2, 6, 0, 9, 0, 1));
  assert.throws(() => DPS.parseResponse(frame('write_onoff_request'), fromSlave2), /slave 2/);
  assert.throws(() => DPS.parseResponse(frame('status_request'), frame('write_onoff_request')), /function 0x6/);
  const broken = frame('status_cv_on');
  broken[10] ^= 0x10;
  assert.throws(() => DPS.parseResponse(frame('status_request'), broken), /CRC/);
});

// ---------- Decoding and encoding ----------

test('decodeStatus decodes a DPS3005 in CV mode with the output on', () => {
  const { registers } = DPS.parseResponse(frame('status_request'), frame('status_cv_on'));
  const status = DPS.decodeStatus(registers);
  closeTo(status.voltageSet, 5);
  closeTo(status.currentSet, 1);
  closeTo(status.voltage, 4.98);
  closeTo(status.current, 0.512);
  closeTo(status.power, 2.55);
  closeTo(status.inputVoltage, 12.1);
  assert.equal(status.locked, false);
  assert.equal(status.protection, 'OK');
  assert.equal(status.mode, 'CV');
  assert.equal(status.outputOn, true);
  assert.equal(status.brightness, 4);
  assert.equal(status.model, 3005);
  assert.equal(status.version, '1.6');
});

test('decodeStatus decodes CC mode, OCP and the key lock', () => {
  const { registers } = DPS.parseResponse(frame('status_request'), frame('status_cc_ocp_locked'));
  const status = DPS.decodeStatus(registers);
  closeTo(status.voltage, 11.04);
  closeTo(status.current, 0.5);
  closeTo(status.power, 5.52);
  closeTo(status.inputVoltage, 24);
  assert.equal(status.locked, true);
  assert.equal(status.protectionCode, 2);
  assert.equal(status.protection, 'OCP');
  assert.equal(status.mode, 'CC');
  assert.equal(DPS.protectionName(1), 'OVP');
  assert.equal(DPS.protectionName(3), 'OPP');
  assert.equal(DPS.protectionName(9), 'unknown (9)');
});

test('decodeStatus uses the scaling of the model', () => {
  const registers = [500, 1000, 498, 512, 255, 1210, 0, 0, 0, 1, 4, 5020, 16];
  const status = DPS.decodeStatus(registers);
  closeTo(status.current, 5.12); // DPS5020: 2 decimals.
  closeTo(status.power, 25.5); // DPS5020: 1 decimal.
  assert.throws(() => DPS.decodeStatus([1, 2, 3]), /13 registers/);
});

test('modelScaling gives the DPS3005 scaling for an unknown model', () => {
  assert.equal(DPS.modelScaling(3005).name, 'DPS3005');
  assert.equal(DPS.modelScaling(3005).known, true);
  const unknown = DPS.modelScaling(1234);
  assert.equal(unknown.known, false);
  assert.equal(unknown.currentDecimals, 3);
  assert.match(unknown.name, /DPS1234/);
});

test('decodePreset decodes a memory group', () => {
  const { registers } = DPS.parseResponse(frame('preset_m1_request'), frame('preset_m1'));
  const preset = DPS.decodePreset(registers, DPS.modelScaling(3005));
  closeTo(preset.voltageSet, 12);
  closeTo(preset.currentSet, 2);
  closeTo(preset.overVoltage, 13);
  closeTo(preset.overCurrent, 2.1);
  closeTo(preset.overPower, 30);
  assert.equal(preset.brightness, 4);
  assert.equal(preset.outputOnStart, false);
});

test('presetAddress gives 0x50 + 0x10 * n', () => {
  assert.equal(DPS.presetAddress(0), 0x50);
  assert.equal(DPS.presetAddress(9), 0xe0);
  assert.throws(() => DPS.presetAddress(10), RangeError);
  assert.throws(() => DPS.presetAddress(-1), RangeError);
});

test('toRegister rounds and checks the range', () => {
  assert.equal(DPS.toRegister(12.345, 2), 1235);
  assert.equal(DPS.toRegister(0.1 + 0.2, 3), 300);
  assert.throws(() => DPS.toRegister(700, 2), RangeError);
  assert.throws(() => DPS.toRegister(-0.01, 2), RangeError);
  assert.throws(() => DPS.toRegister(NaN, 2), RangeError);
});

test('samplesToCsv writes one row for each sample', () => {
  const { registers } = DPS.parseResponse(frame('status_request'), frame('status_cv_on'));
  const status = DPS.decodeStatus(registers);
  const csv = DPS.samplesToCsv([{ time: 0, ...status }, { time: 1500, ...status, mAh: 0.21, wh: 0.00106 }]).trim().split('\n');
  assert.equal(csv[0], 'time_iso,elapsed_s,volts,amps,watts,input_volts,set_volts,set_amps,mode,protection,output,mAh,Wh');
  assert.equal(csv.length, 3);
  assert.equal(csv[1].endsWith(',0.00,0.0000'), true); // A sample with no counters gives 0.
  assert.equal(csv[2], '1970-01-01T00:00:01.500Z,1.500,4.98,0.512,2.55,12.10,5.00,1.000,CV,OK,1,0.21,0.0011');
});

// ---------- Transport ----------

// Build a DPSPort with a fake writer. answer(request) returns the reply bytes, or null for no reply.
function makeFakePort(answer, options = {}) {
  const port = new DPS.DPSPort({}, { timeoutMilliseconds: 100, gapMilliseconds: 0, ...options });
  port.writes = [];
  port.inFlight = 0;
  port.maxInFlight = 0;
  port.writer = {
    write: async (bytes) => {
      const request = new Uint8Array(bytes);
      port.writes.push(hex(request));
      port.inFlight++;
      port.maxInFlight = Math.max(port.maxInFlight, port.inFlight);
      const reply = answer(request, port.writes.length);
      // Reply in two chunks, as a serial port can do.
      setTimeout(() => {
        port.inFlight--;
        if (!reply) return;
        port.addReceivedBytes(reply.subarray(0, 3));
        setTimeout(() => port.addReceivedBytes(reply.subarray(3)), 2);
      }, 5);
    },
  };
  return port;
}

// A small DPS emulator: echo writes and answer reads from a register array.
function emulator(registers) {
  return (request) => {
    const address = (request[2] << 8) | request[3];
    if (request[1] === 0x03) {
      const count = (request[4] << 8) | request[5];
      const body = [request[0], 3, 2 * count];
      for (let i = 0; i < count; i++) body.push((registers[address + i] ?? 0) >> 8, (registers[address + i] ?? 0) & 0xff);
      return DPS.appendCrc(Uint8Array.from(body));
    }
    if (request[1] === 0x06) {
      registers[address] = (request[4] << 8) | request[5];
      return request.slice();
    }
    if (request[1] === 0x10) {
      const count = (request[4] << 8) | request[5];
      for (let i = 0; i < count; i++) registers[address + i] = (request[7 + 2 * i] << 8) | request[8 + 2 * i];
      return DPS.appendCrc(request.slice(0, 6));
    }
    return null;
  };
}

test('DPSPort reads the status and sets the scaling from the model', async () => {
  const registers = [500, 1000, 498, 512, 255, 1210, 0, 0, 0, 1, 4, 3005, 16];
  const port = makeFakePort(emulator(registers));
  const status = await port.readStatus();
  closeTo(status.voltage, 4.98);
  assert.equal(port.scaling.name, 'DPS3005');
  assert.deepEqual(port.writes, [fixtures.status_request]);
});

test('DPSPort sends one request at a time', async () => {
  const registers = new Array(0xf0).fill(0);
  registers[0x0b] = 3005;
  const port = makeFakePort(emulator(registers));
  await Promise.all([
    port.readStatus(),
    port.setOutput(true),
    port.setVoltageAndCurrent(12, 1.5),
    port.readPreset(1),
    port.recallPreset(3),
    port.setLock(true),
    port.setBrightness(2),
  ]);
  assert.equal(port.maxInFlight, 1);
  assert.equal(port.writes.length, 7);
  assert.equal(port.writes[2], fixtures.write_uset_iset_request);
  assert.equal(port.writes[3], fixtures.preset_m1_request);
  assert.equal(port.writes[4], fixtures.recall_m3_request);
  assert.equal(registers[DPS.REGISTER.ONOFF], 1);
  assert.equal(registers[DPS.REGISTER.VOLTAGE_SET], 1200);
  assert.equal(registers[DPS.REGISTER.CURRENT_SET], 1500);
  assert.equal(registers[DPS.REGISTER.EXTRACT_MEMORY], 3);
  assert.equal(registers[DPS.REGISTER.LOCK], 1);
  assert.equal(registers[DPS.REGISTER.BRIGHTNESS], 2);
});

test('encodePreset is the reverse of decodePreset', () => {
  const scaling = DPS.modelScaling(3005);
  const registers = [1234, 1500, 1300, 1600, 300, 4, 1, 0];
  assert.deepEqual(DPS.encodePreset(DPS.decodePreset(registers, scaling), scaling), registers);
});

test('encodePreset checks the model limits', () => {
  const scaling = DPS.modelScaling(3005);
  const valid = { voltageSet: 12, currentSet: 1, overVoltage: 13, overCurrent: 1.1, overPower: 20, brightness: 3, memoryPreset: 0, outputOnStart: false };
  assert.deepEqual(DPS.presetLimits(scaling), { voltageSet: 32, currentSet: 5, overVoltage: 33, overCurrent: 5.1, overPower: 161, brightness: 5 });
  assert.throws(() => DPS.encodePreset({ ...valid, voltageSet: 32.5 }, scaling), /voltage must be 0-32 V/);
  assert.throws(() => DPS.encodePreset({ ...valid, overCurrent: 5.2 }, scaling), /OCP must be 0-5.1 A/);
  assert.throws(() => DPS.encodePreset({ ...valid, overPower: 162 }, scaling), /OPP must be 0-161 W/);
  assert.throws(() => DPS.encodePreset({ ...valid, brightness: 2.5 }, scaling), /whole number/);
  assert.throws(() => DPS.encodePreset({ ...valid, overVoltage: NaN }, scaling), /OVP/);
  assert.deepEqual(DPS.encodePreset({ ...valid, memoryPreset: 1, outputOnStart: true }, scaling).slice(5), [3, 1, 1]);
});

test('DPSPort writes all 8 registers of a memory group in one request', async () => {
  const registers = new Array(0xf0).fill(0);
  registers[0x0b] = 3005;
  const port = makeFakePort(emulator(registers));
  const preset = { voltageSet: 12.34, currentSet: 1.5, overVoltage: 13, overCurrent: 1.6, overPower: 30, brightness: 2, memoryPreset: 1, outputOnStart: false };
  await port.writePreset(2, preset);
  assert.equal(port.writes[0], hex(DPS.buildWriteMultipleRequest(1, 0x70, [1234, 1500, 1300, 1600, 300, 2, 1, 0])));
  assert.deepEqual(registers.slice(0x70, 0x78), [1234, 1500, 1300, 1600, 300, 2, 1, 0]);
  await assert.rejects(() => port.writePreset(10, preset), RangeError);
  await assert.rejects(() => port.writePreset(1, { ...preset, overCurrent: 9 }), /OCP/);
  assert.equal(port.writes.length, 1);
});

test('DPSPort rejects a set value outside the model range before it sends', async () => {
  const port = makeFakePort(emulator([]));
  await assert.rejects(() => port.setVoltage(33), /0-32 V/);
  await assert.rejects(() => port.setCurrent(5.5), /0-5 A/);
  await assert.rejects(() => port.setVoltageAndCurrent(5, -1), /0-5 A/);
  await assert.rejects(() => port.setBrightness(6), /0-5/);
  await assert.rejects(() => port.recallPreset(10), RangeError);
  assert.equal(port.writes.length, 0);
});

test('DPSPort times out, then sends the request again', async () => {
  const registers = [500, 1000, 498, 512, 255, 1210, 0, 0, 0, 1, 4, 3005, 16];
  const reply = emulator(registers);
  const port = makeFakePort((request, writeCount) => (writeCount === 1 ? null : reply(request)));
  const status = await port.readStatus();
  closeTo(status.current, 0.512);
  assert.equal(port.writes.length, 2);
});

test('DPSPort gives up after the last attempt', async () => {
  const port = makeFakePort(() => null);
  await assert.rejects(() => port.readStatus(), /No valid response in 100 ms/);
  assert.equal(port.writes.length, 2);
  // The queue continues after a failure.
  const working = makeFakePort(emulator([0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 3005, 10]));
  await assert.rejects(() => working.setVoltage(99));
  assert.equal((await working.readStatus()).version, '1.0');
});

test('DPSPort does not send again after an exception response', async () => {
  const port = makeFakePort(() => frame('exception_illegal_address'));
  await assert.rejects(() => port.readStatus(), DPS.ModbusException);
  assert.equal(port.writes.length, 1);
});

// ---------- Poller ----------

test('Poller calls onReading and stops after maxFailures errors in a row', async () => {
  let calls = 0;
  const readings = [];
  const errors = [];
  let gaveUp = null;
  const poller = new DPS.Poller({
    read: async () => {
      calls++;
      if (calls <= 2 || calls === 4) return calls;
      throw new Error(`fail ${calls}`);
    },
    onReading: (reading) => readings.push(reading),
    onError: (error, failures) => errors.push(failures),
    onGiveUp: (error) => { gaveUp = error.message; },
    interval: () => 1,
    maxFailures: 2,
  });
  await poller.start();
  assert.deepEqual(readings, [1, 2, 4]);
  assert.deepEqual(errors, [1, 1, 2]); // The success at call 4 sets the count back to 0.
  assert.equal(gaveUp, 'fail 6');
  assert.equal(poller.running, false);
});

test('Poller.stop ignores the result of a read in progress', async () => {
  const readings = [];
  let release;
  const poller = new DPS.Poller({
    read: () => new Promise((resolve) => { release = resolve; }),
    onReading: (reading) => readings.push(reading),
    interval: () => 1,
  });
  const finished = poller.start();
  poller.stop();
  release('late');
  await finished;
  assert.deepEqual(readings, []);
});

// DPS power supply protocol core: Modbus RTU frames, CRC, register decoding, the Web Serial transport and the poller.
// The RDTech / RuiDeng DPS3005 (and the DPS family) is a Modbus RTU slave.
// This file is a classic script. The page loads it with <script src>, so it works from file://.
// Node loads it with require() for the unit tests.
(function (globalScope) {
  'use strict';

  // ---------- Modbus RTU ----------

  const FUNCTION_READ_HOLDING_REGISTERS = 0x03;
  const FUNCTION_WRITE_SINGLE_REGISTER = 0x06;
  const FUNCTION_WRITE_MULTIPLE_REGISTERS = 0x10;
  const EXCEPTION_FLAG = 0x80;
  const EXCEPTION_FRAME_LENGTH = 5;
  const MAX_READ_COUNT = 125; // Modbus limit for function 0x03.
  const MAX_WRITE_COUNT = 123; // Modbus limit for function 0x10.

  const EXCEPTION_NAMES = {
    1: 'illegal function',
    2: 'illegal data address',
    3: 'illegal data value',
    4: 'slave device failure',
    6: 'slave device busy',
  };

  // CRC-16/MODBUS (reflected polynomial 0xA001, initial value 0xFFFF).
  // The frame sends the CRC low byte first.
  function crc16Modbus(bytes, offset = 0, length = bytes.length - offset) {
    let crc = 0xffff;
    for (let i = offset; i < offset + length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc;
  }

  // Add the CRC to the frame body. Return a new array.
  function appendCrc(body) {
    const frame = new Uint8Array(body.length + 2);
    frame.set(body);
    const crc = crc16Modbus(body);
    frame[body.length] = crc & 0xff;
    frame[body.length + 1] = crc >>> 8;
    return frame;
  }

  // Return true if the last 2 bytes of the frame are the correct CRC.
  function hasValidCrc(frame) {
    if (frame.length < 4) return false;
    const crc = crc16Modbus(frame, 0, frame.length - 2);
    return frame[frame.length - 2] === (crc & 0xff) && frame[frame.length - 1] === crc >>> 8;
  }

  function checkByte(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 0xff) throw new RangeError(`${name} must be 0-255, not ${value}.`);
  }

  function checkWord(value, name) {
    if (!Number.isInteger(value) || value < 0 || value > 0xffff) throw new RangeError(`${name} must be 0-65535, not ${value}.`);
  }

  function buildReadRequest(slaveAddress, startAddress, count) {
    checkByte(slaveAddress, 'Slave address');
    checkWord(startAddress, 'Register address');
    if (!Number.isInteger(count) || count < 1 || count > MAX_READ_COUNT) throw new RangeError(`Register count must be 1-${MAX_READ_COUNT}.`);
    return appendCrc(Uint8Array.of(
      slaveAddress, FUNCTION_READ_HOLDING_REGISTERS, startAddress >>> 8, startAddress & 0xff, count >>> 8, count & 0xff,
    ));
  }

  function buildWriteSingleRequest(slaveAddress, address, value) {
    checkByte(slaveAddress, 'Slave address');
    checkWord(address, 'Register address');
    checkWord(value, 'Register value');
    return appendCrc(Uint8Array.of(
      slaveAddress, FUNCTION_WRITE_SINGLE_REGISTER, address >>> 8, address & 0xff, value >>> 8, value & 0xff,
    ));
  }

  function buildWriteMultipleRequest(slaveAddress, startAddress, values) {
    checkByte(slaveAddress, 'Slave address');
    checkWord(startAddress, 'Register address');
    if (!values.length || values.length > MAX_WRITE_COUNT) throw new RangeError(`Register count must be 1-${MAX_WRITE_COUNT}.`);
    const body = new Uint8Array(7 + 2 * values.length);
    body.set([slaveAddress, FUNCTION_WRITE_MULTIPLE_REGISTERS, startAddress >>> 8, startAddress & 0xff,
      values.length >>> 8, values.length & 0xff, 2 * values.length]);
    values.forEach((value, index) => {
      checkWord(value, 'Register value');
      body[7 + 2 * index] = value >>> 8;
      body[8 + 2 * index] = value & 0xff;
    });
    return appendCrc(body);
  }

  const readWord = (bytes, offset) => (bytes[offset] << 8) | bytes[offset + 1];

  // Return the length of a normal response to the request.
  function expectedResponseLength(request) {
    switch (request[1]) {
      case FUNCTION_READ_HOLDING_REGISTERS: return 5 + 2 * readWord(request, 4);
      case FUNCTION_WRITE_SINGLE_REGISTER: return 8;
      case FUNCTION_WRITE_MULTIPLE_REGISTERS: return 8;
      default: throw new Error(`Function 0x${request[1].toString(16)} is not supported.`);
    }
  }

  class ModbusException extends Error {
    constructor(functionCode, exceptionCode) {
      const name = EXCEPTION_NAMES[exceptionCode] || 'unknown exception';
      super(`Modbus exception ${exceptionCode} (${name}) for function 0x${functionCode.toString(16).padStart(2, '0')}.`);
      this.name = 'ModbusException';
      this.functionCode = functionCode;
      this.exceptionCode = exceptionCode;
    }
  }

  // Look for the response to the request in the received bytes.
  // The scan skips bytes that cannot start the response, for example noise from a Bluetooth module.
  // Return { frame, end } when it finds a frame with a correct CRC.
  // Return null when no complete frame is in the bytes yet.
  function findResponseFrame(request, bytes) {
    const slaveAddress = request[0];
    const functionCode = request[1];
    const normalLength = expectedResponseLength(request);
    for (let start = 0; start + 1 < bytes.length; start++) {
      if (bytes[start] !== slaveAddress) continue;
      const receivedFunction = bytes[start + 1];
      let length;
      if (receivedFunction === functionCode) length = normalLength;
      else if (receivedFunction === (functionCode | EXCEPTION_FLAG)) length = EXCEPTION_FRAME_LENGTH;
      else continue;
      if (start + length > bytes.length) continue; // Not complete yet. A later start can still be complete.
      const frame = bytes.subarray(start, start + length);
      if (hasValidCrc(frame)) return { frame, end: start + length };
    }
    return null;
  }

  // Check a complete response frame against the request.
  // Return { registers } for function 0x03, or the echoed { address, value } for 0x06 and 0x10.
  // For 0x10 the value is the register count.
  // Throw a ModbusException for an exception response and an Error for a bad frame.
  function parseResponse(request, frame) {
    if (!hasValidCrc(frame)) throw new Error('The response has an incorrect CRC.');
    if (frame[0] !== request[0]) throw new Error(`The response is from slave ${frame[0]}, not ${request[0]}.`);
    const functionCode = request[1];
    if (frame[1] === (functionCode | EXCEPTION_FLAG)) throw new ModbusException(functionCode, frame[2]);
    if (frame[1] !== functionCode) {
      throw new Error(`The response has function 0x${frame[1].toString(16)}, not 0x${functionCode.toString(16)}.`);
    }
    const length = expectedResponseLength(request);
    if (frame.length !== length) throw new Error(`The response has ${frame.length} bytes, not ${length}.`);
    if (functionCode === FUNCTION_READ_HOLDING_REGISTERS) {
      const count = readWord(request, 4);
      if (frame[2] !== 2 * count) throw new Error(`The response byte count is ${frame[2]}, not ${2 * count}.`);
      const registers = [];
      for (let index = 0; index < count; index++) registers.push(readWord(frame, 3 + 2 * index));
      return { registers };
    }
    if (readWord(frame, 2) !== readWord(request, 2)) throw new Error('The response has a different register address.');
    if (readWord(frame, 4) !== readWord(request, 4)) throw new Error('The response has a different value or count.');
    return { address: readWord(frame, 2), value: readWord(frame, 4) };
  }

  function toHex(bytes) {
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join(' ');
  }

  function fromHex(text) {
    const clean = text.replace(/[^0-9a-f]/gi, '');
    if (clean.length % 2) throw new Error('The hex text has an odd number of digits.');
    const bytes = new Uint8Array(clean.length / 2);
    for (let i = 0; i < bytes.length; i++) bytes[i] = parseInt(clean.slice(2 * i, 2 * i + 2), 16);
    return bytes;
  }

  // ---------- DPS registers ----------

  const REGISTER = {
    VOLTAGE_SET: 0x00,
    CURRENT_SET: 0x01,
    VOLTAGE_OUT: 0x02,
    CURRENT_OUT: 0x03,
    POWER: 0x04,
    VOLTAGE_IN: 0x05,
    LOCK: 0x06,
    PROTECT: 0x07,
    CV_CC: 0x08,
    ONOFF: 0x09,
    BRIGHTNESS: 0x0a,
    MODEL: 0x0b,
    VERSION: 0x0c,
    // Write 0-9 to load the memory group M0-M9 into the active settings.
    // Not confirmed on the hardware yet. See NOTES.md.
    EXTRACT_MEMORY: 0x23,
  };
  const STATUS_REGISTER_COUNT = 13; // 0x00-0x0C.

  // Memory groups M0-M9: 8 registers each, at 0x50 + 0x10 * n.
  // The fields are U-SET, I-SET, S-OVP, S-OCP, S-OPP, B-LED, M-PRE and S-INI.
  const PRESET_BASE = 0x50;
  const PRESET_STRIDE = 0x10;
  const PRESET_COUNT = 10;
  const PRESET_REGISTER_COUNT = 8;
  const OVER_POWER_DECIMALS = 1; // S-OPP has 1 decimal.

  const PROTECTION_NAMES = ['OK', 'OVP', 'OCP', 'OPP'];
  const MAX_BRIGHTNESS = 5;

  // Scaling per model: the number of decimals in each register.
  // DPS3005 and DPS5005 agree with public register tables (DPS5005_pyGUI).
  // The other models are not confirmed. Their current and power need fewer decimals to fit into 16 bits.
  const MODELS = {
    3005: { name: 'DPS3005', maxVoltage: 30, maxCurrent: 5, voltageDecimals: 2, currentDecimals: 3, powerDecimals: 2, confirmed: true },
    5005: { name: 'DPS5005', maxVoltage: 50, maxCurrent: 5, voltageDecimals: 2, currentDecimals: 3, powerDecimals: 2, confirmed: true },
    8005: { name: 'DPS8005', maxVoltage: 80, maxCurrent: 5, voltageDecimals: 2, currentDecimals: 3, powerDecimals: 2, confirmed: false },
    5015: { name: 'DPS5015', maxVoltage: 50, maxCurrent: 15, voltageDecimals: 2, currentDecimals: 2, powerDecimals: 1, confirmed: false },
    5020: { name: 'DPS5020', maxVoltage: 50, maxCurrent: 20, voltageDecimals: 2, currentDecimals: 2, powerDecimals: 1, confirmed: false },
  };

  // Return the scaling for a model number. An unknown model gets the DPS3005 scaling and known: false.
  function modelScaling(modelNumber) {
    const model = MODELS[modelNumber];
    if (model) return { ...model, modelNumber, known: true };
    return { ...MODELS[3005], name: `DPS${modelNumber} (unknown)`, modelNumber, known: false, confirmed: false };
  }

  const scale = (raw, decimals) => raw / 10 ** decimals;

  // Change a physical value into a register value. Throw a RangeError if it does not fit into 16 bits.
  function toRegister(value, decimals, name = 'Value') {
    if (typeof value !== 'number' || !Number.isFinite(value)) throw new RangeError(`${name} is not a number.`);
    const raw = Math.round(value * 10 ** decimals);
    if (raw < 0 || raw > 0xffff) throw new RangeError(`${name} ${value} is out of range.`);
    return raw;
  }

  function protectionName(code) {
    return PROTECTION_NAMES[code] || `unknown (${code})`;
  }

  // Decode the registers 0x00-0x0C. Without a scaling, the function uses the model register.
  function decodeStatus(registers, scaling = modelScaling(registers[REGISTER.MODEL])) {
    if (registers.length < STATUS_REGISTER_COUNT) throw new Error(`The status needs ${STATUS_REGISTER_COUNT} registers, not ${registers.length}.`);
    const { voltageDecimals, currentDecimals, powerDecimals } = scaling;
    const protectionCode = registers[REGISTER.PROTECT];
    const versionRaw = registers[REGISTER.VERSION];
    return {
      voltageSet: scale(registers[REGISTER.VOLTAGE_SET], voltageDecimals),
      currentSet: scale(registers[REGISTER.CURRENT_SET], currentDecimals),
      voltage: scale(registers[REGISTER.VOLTAGE_OUT], voltageDecimals),
      current: scale(registers[REGISTER.CURRENT_OUT], currentDecimals),
      power: scale(registers[REGISTER.POWER], powerDecimals),
      inputVoltage: scale(registers[REGISTER.VOLTAGE_IN], 2),
      locked: registers[REGISTER.LOCK] !== 0,
      protectionCode,
      protection: protectionName(protectionCode),
      mode: registers[REGISTER.CV_CC] === 1 ? 'CC' : 'CV',
      outputOn: registers[REGISTER.ONOFF] !== 0,
      brightness: registers[REGISTER.BRIGHTNESS],
      model: registers[REGISTER.MODEL],
      versionRaw,
      version: (versionRaw / 10).toFixed(1),
    };
  }

  // Decode the 8 registers of one memory group.
  function decodePreset(registers, scaling) {
    if (registers.length < PRESET_REGISTER_COUNT) throw new Error(`A memory group needs ${PRESET_REGISTER_COUNT} registers.`);
    const { voltageDecimals, currentDecimals } = scaling;
    return {
      voltageSet: scale(registers[0], voltageDecimals),
      currentSet: scale(registers[1], currentDecimals),
      overVoltage: scale(registers[2], voltageDecimals),
      overCurrent: scale(registers[3], currentDecimals),
      overPower: scale(registers[4], OVER_POWER_DECIMALS),
      brightness: registers[5],
      memoryPreset: registers[6],
      outputOnStart: registers[7] !== 0,
    };
  }

  function presetAddress(index) {
    if (!Number.isInteger(index) || index < 0 || index >= PRESET_COUNT) throw new RangeError(`The memory group must be 0-${PRESET_COUNT - 1}.`);
    return PRESET_BASE + PRESET_STRIDE * index;
  }

  function samplesToCsv(samples) {
    const lines = ['time_iso,elapsed_s,volts,amps,watts,input_volts,set_volts,set_amps,mode,protection,output'];
    const startTime = samples.length ? samples[0].time : 0;
    for (const sample of samples) {
      lines.push([
        new Date(sample.time).toISOString(),
        ((sample.time - startTime) / 1000).toFixed(3),
        sample.voltage.toFixed(2),
        sample.current.toFixed(3),
        sample.power.toFixed(2),
        sample.inputVoltage.toFixed(2),
        sample.voltageSet.toFixed(2),
        sample.currentSet.toFixed(3),
        sample.mode,
        sample.protection,
        sample.outputOn ? 1 : 0,
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }

  // ---------- Web Serial transport ----------

  // Serial Port Profile (SPP) UUID. Chrome can open a Bluetooth RFCOMM service with this ID.
  const BLUETOOTH_SPP_UUID = '00001101-0000-1000-8000-00805f9b34fb';
  const DEFAULT_BAUD_RATE = 9600;
  const DEFAULT_SLAVE_ADDRESS = 1;

  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function withTimeout(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // One DPS connection. All requests go through one queue, so only one request is in flight.
  class DPSPort {
    // options: { slaveAddress, baudRate, timeoutMilliseconds, gapMilliseconds }
    constructor(serialPort, options = {}) {
      this.serialPort = serialPort;
      this.slaveAddress = options.slaveAddress ?? DEFAULT_SLAVE_ADDRESS;
      this.baudRate = options.baudRate ?? DEFAULT_BAUD_RATE;
      // Bluetooth adds latency. 1 s is enough for one request at 9600 baud.
      this.timeoutMilliseconds = options.timeoutMilliseconds ?? 1000;
      // Modbus RTU needs 3.5 characters of silence between frames (4 ms at 9600 baud). The gap adds a margin.
      this.gapMilliseconds = options.gapMilliseconds ?? 20;
      this.scaling = modelScaling(3005);
      this.reader = null;
      this.writer = null;
      this.readLoopFinished = null;
      this.closing = false;
      this.received = new Uint8Array(0);
      this.wakeWaitingTask = null;
      this.requestQueue = Promise.resolve();
      this.onclose = null; // Called with an Error when the connection stops without close().
      this.ontraffic = null; // Called with ('tx' or 'rx', bytes), for example for a log.
    }

    async open() {
      await this.serialPort.open({
        baudRate: this.baudRate, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 4096,
      });
      try {
        this.writer = this.serialPort.writable.getWriter();
        this.reader = this.serialPort.readable.getReader();
      } catch (error) {
        await this.serialPort.close().catch(() => {});
        throw error;
      }
      this.readLoopFinished = this.readLoop();
    }

    async readLoop() {
      let readError = null;
      try {
        for (;;) {
          const { value, done } = await this.reader.read();
          if (done) break;
          if (value && value.length) this.addReceivedBytes(value);
        }
      } catch (error) {
        if (!this.closing) readError = error;
      } finally {
        try { this.reader.releaseLock(); } catch { /* The lock is already free. */ }
      }
      if (!this.closing) {
        this.closing = true;
        await this.releasePort();
        if (this.onclose) this.onclose(readError || new Error('The serial port stopped sending data.'));
      }
    }

    addReceivedBytes(chunk) {
      const joined = new Uint8Array(this.received.length + chunk.length);
      joined.set(this.received);
      joined.set(chunk, this.received.length);
      this.received = joined;
      if (this.wakeWaitingTask) {
        const wake = this.wakeWaitingTask;
        this.wakeWaitingTask = null;
        wake();
      }
    }

    // Resolve when new data arrives or when the time is over.
    waitForData(milliseconds) {
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          this.wakeWaitingTask = null;
          resolve();
        }, Math.max(0, milliseconds));
        this.wakeWaitingTask = () => {
          clearTimeout(timer);
          resolve();
        };
      });
    }

    // Add a task to the request queue.
    enqueue(task) {
      const result = this.requestQueue.then(task);
      this.requestQueue = result.catch(() => {});
      return result;
    }

    // Send one request frame and wait for its response frame. Return the parsed response.
    // With attempts > 1, the port sends the request again after a timeout or a bad frame.
    // Use more than 1 attempt only for a request that gives the same result when it runs two times.
    transact(request, { attempts = 1, timeoutMilliseconds = this.timeoutMilliseconds } = {}) {
      return this.enqueue(async () => {
        let lastError;
        for (let attempt = 1; attempt <= attempts; attempt++) {
          if (this.closing) throw new Error('The port is closed.');
          try {
            return await this.transactOnce(request, timeoutMilliseconds);
          } catch (error) {
            lastError = error;
            if (error instanceof ModbusException) throw error; // The device answered. A new attempt does not help.
          }
        }
        throw lastError;
      });
    }

    // Call this only inside a queued task.
    async transactOnce(request, timeoutMilliseconds) {
      this.received = new Uint8Array(0); // Discard old bytes, for example a late response.
      if (this.ontraffic) this.ontraffic('tx', request);
      await withTimeout(this.writer.write(request), 2000, 'The write timed out.');
      const deadline = performance.now() + timeoutMilliseconds;
      let found = null;
      while (!this.closing) {
        found = findResponseFrame(request, this.received);
        if (found) break;
        const remaining = deadline - performance.now();
        if (remaining <= 0) break;
        await this.waitForData(remaining);
      }
      if (!found) {
        const partial = this.received.length ? ` Received: ${toHex(this.received.subarray(0, 32))}` : '';
        throw new Error(`No valid response in ${timeoutMilliseconds} ms (function 0x${request[1].toString(16).padStart(2, '0')}).${partial}`);
      }
      const frame = found.frame.slice();
      this.received = this.received.slice(found.end);
      if (this.ontraffic) this.ontraffic('rx', frame);
      await sleep(this.gapMilliseconds);
      return parseResponse(request, frame);
    }

    async readRegisters(startAddress, count) {
      const response = await this.transact(buildReadRequest(this.slaveAddress, startAddress, count), { attempts: 2 });
      return response.registers;
    }

    // A write sets an absolute value, so a second attempt is safe.
    writeRegister(address, value) {
      return this.transact(buildWriteSingleRequest(this.slaveAddress, address, value), { attempts: 2 });
    }

    writeRegisters(startAddress, values) {
      return this.transact(buildWriteMultipleRequest(this.slaveAddress, startAddress, values), { attempts: 2 });
    }

    // Read the registers 0x00-0x0C. The port uses the model register to set the scaling.
    async readStatus() {
      const registers = await this.readRegisters(REGISTER.VOLTAGE_SET, STATUS_REGISTER_COUNT);
      if (registers[REGISTER.MODEL] !== this.scaling.modelNumber) this.scaling = modelScaling(registers[REGISTER.MODEL]);
      return decodeStatus(registers, this.scaling);
    }

    voltageToRegister(volts) {
      if (!(volts >= 0 && volts <= this.scaling.maxVoltage)) throw new RangeError(`The voltage must be 0-${this.scaling.maxVoltage} V.`);
      return toRegister(volts, this.scaling.voltageDecimals, 'Voltage');
    }

    currentToRegister(amps) {
      if (!(amps >= 0 && amps <= this.scaling.maxCurrent)) throw new RangeError(`The current must be 0-${this.scaling.maxCurrent} A.`);
      return toRegister(amps, this.scaling.currentDecimals, 'Current');
    }

    async setVoltage(volts) {
      return this.writeRegister(REGISTER.VOLTAGE_SET, this.voltageToRegister(volts));
    }

    async setCurrent(amps) {
      return this.writeRegister(REGISTER.CURRENT_SET, this.currentToRegister(amps));
    }

    // Write U-SET and I-SET in one request (function 0x10).
    async setVoltageAndCurrent(volts, amps) {
      return this.writeRegisters(REGISTER.VOLTAGE_SET, [this.voltageToRegister(volts), this.currentToRegister(amps)]);
    }

    async setOutput(on) {
      return this.writeRegister(REGISTER.ONOFF, on ? 1 : 0);
    }

    async setLock(locked) {
      return this.writeRegister(REGISTER.LOCK, locked ? 1 : 0);
    }

    async setBrightness(level) {
      if (!Number.isInteger(level) || level < 0 || level > MAX_BRIGHTNESS) throw new RangeError(`The brightness must be 0-${MAX_BRIGHTNESS}.`);
      return this.writeRegister(REGISTER.BRIGHTNESS, level);
    }

    async readPreset(index) {
      const registers = await this.readRegisters(presetAddress(index), PRESET_REGISTER_COUNT);
      return decodePreset(registers, this.scaling);
    }

    // Write U-SET and I-SET into a memory group (function 0x10).
    // The other 6 registers of the group (OVP, OCP, OPP, B-LED, M-PRE, S-INI) do not change.
    async savePresetSetpoints(index, volts, amps) {
      return this.writeRegisters(presetAddress(index), [this.voltageToRegister(volts), this.currentToRegister(amps)]);
    }

    // Load the memory group into the active settings.
    async recallPreset(index) {
      presetAddress(index); // Check the range.
      return this.writeRegister(REGISTER.EXTRACT_MEMORY, index);
    }

    async releasePort() {
      try { if (this.writer) this.writer.releaseLock(); } catch { /* The lock is already free. */ }
      try { await this.serialPort.close(); } catch { /* The port is already closed. */ }
    }

    async close() {
      if (this.closing) return;
      this.closing = true;
      if (this.wakeWaitingTask) this.wakeWaitingTask();
      try { if (this.reader) await this.reader.cancel(); } catch { /* The reader is already closed. */ }
      if (this.readLoopFinished) await this.readLoopFinished;
      await this.releasePort();
    }
  }

  // ---------- Polling loop ----------

  // The poller calls read() again and again. It waits interval() milliseconds from the start of one read to the next.
  // After maxFailures failed reads in a row, the loop stops and calls onGiveUp.
  class Poller {
    // options: { read, onReading, onError, onGiveUp, interval, maxFailures }
    constructor(options) {
      this.read = options.read;
      this.onReading = options.onReading || (() => {});
      this.onError = options.onError || (() => {});
      this.onGiveUp = options.onGiveUp || (() => {});
      this.interval = options.interval || (() => 500);
      this.maxFailures = options.maxFailures ?? 3;
      this.loopId = 0;
      this.running = false;
      this.finished = Promise.resolve();
    }

    start() {
      this.loopId++;
      this.running = true;
      this.finished = this.loop(this.loopId);
      return this.finished;
    }

    // Stop the loop. A read in progress can finish, but the poller ignores its result.
    stop() {
      this.loopId++;
      this.running = false;
    }

    async loop(loopId) {
      let failures = 0;
      while (loopId === this.loopId) {
        const startTime = performance.now();
        try {
          const reading = await this.read();
          if (loopId !== this.loopId) break;
          failures = 0;
          this.onReading(reading);
        } catch (error) {
          if (loopId !== this.loopId) break;
          failures++;
          this.onError(error, failures);
          if (failures >= this.maxFailures) {
            this.stop();
            this.onGiveUp(error);
            break;
          }
        }
        await sleep(Math.max(0, this.interval() - (performance.now() - startTime)));
      }
    }
  }

  const api = {
    crc16Modbus,
    appendCrc,
    hasValidCrc,
    buildReadRequest,
    buildWriteSingleRequest,
    buildWriteMultipleRequest,
    expectedResponseLength,
    findResponseFrame,
    parseResponse,
    ModbusException,
    toHex,
    fromHex,
    REGISTER,
    STATUS_REGISTER_COUNT,
    PRESET_BASE,
    PRESET_STRIDE,
    PRESET_COUNT,
    PRESET_REGISTER_COUNT,
    MAX_BRIGHTNESS,
    MODELS,
    modelScaling,
    toRegister,
    protectionName,
    decodeStatus,
    decodePreset,
    presetAddress,
    samplesToCsv,
    DPSPort,
    Poller,
    BLUETOOTH_SPP_UUID,
    DEFAULT_BAUD_RATE,
    DEFAULT_SLAVE_ADDRESS,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalScope.DPS = api;
})(globalThis);

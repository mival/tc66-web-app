// TC66C protocol core: AES-256 decryption, packet parsers, CSV export and the Web Serial transport.
// This file is a classic script. The page loads it with <script src>, so it works from file://.
// Node loads it with require() for the unit tests.
(function (globalScope) {
  'use strict';

  // ---------- AES-256 decryption (ECB, no padding) ----------
  // WebCrypto has no ECB mode, so this file has a small AES decryptor.

  function multiplyInGaloisField(left, right) {
    let product = 0;
    for (let bit = 0; bit < 8; bit++) {
      if (right & 1) product ^= left;
      const highBitSet = left & 0x80;
      left = (left << 1) & 0xff;
      if (highBitSet) left ^= 0x1b;
      right >>= 1;
    }
    return product;
  }

  const SUBSTITUTION_BOX = new Uint8Array(256);
  const INVERSE_SUBSTITUTION_BOX = new Uint8Array(256);
  (function buildSubstitutionBoxes() {
    // The multiplicative inverse in GF(2^8) is value^254.
    const multiplicativeInverse = (value) => {
      if (value === 0) return 0;
      let result = 1;
      for (let step = 0; step < 254; step++) result = multiplyInGaloisField(result, value);
      return result;
    };
    for (let value = 0; value < 256; value++) {
      const inverse = multiplicativeInverse(value);
      let substituted = inverse;
      let rotated = inverse;
      for (let step = 0; step < 4; step++) {
        rotated = ((rotated << 1) | (rotated >> 7)) & 0xff;
        substituted ^= rotated;
      }
      substituted ^= 0x63;
      SUBSTITUTION_BOX[value] = substituted;
      INVERSE_SUBSTITUTION_BOX[substituted] = value;
    }
  })();

  const MULTIPLY_BY_9 = new Uint8Array(256);
  const MULTIPLY_BY_11 = new Uint8Array(256);
  const MULTIPLY_BY_13 = new Uint8Array(256);
  const MULTIPLY_BY_14 = new Uint8Array(256);
  for (let value = 0; value < 256; value++) {
    MULTIPLY_BY_9[value] = multiplyInGaloisField(value, 9);
    MULTIPLY_BY_11[value] = multiplyInGaloisField(value, 11);
    MULTIPLY_BY_13[value] = multiplyInGaloisField(value, 13);
    MULTIPLY_BY_14[value] = multiplyInGaloisField(value, 14);
  }

  const AES_ROUND_COUNT = 14; // AES-256
  const AES_BLOCK_SIZE = 16;

  function expandKey256(key) {
    if (key.length !== 32) throw new Error('AES-256 key must have 32 bytes');
    const keyWordCount = 8;
    const totalWordCount = 4 * (AES_ROUND_COUNT + 1);
    const roundKeys = new Uint8Array(totalWordCount * 4);
    roundKeys.set(key);
    let roundConstant = 1;
    for (let wordIndex = keyWordCount; wordIndex < totalWordCount; wordIndex++) {
      let word = roundKeys.slice((wordIndex - 1) * 4, wordIndex * 4);
      if (wordIndex % keyWordCount === 0) {
        word = Uint8Array.of(
          SUBSTITUTION_BOX[word[1]] ^ roundConstant,
          SUBSTITUTION_BOX[word[2]],
          SUBSTITUTION_BOX[word[3]],
          SUBSTITUTION_BOX[word[0]],
        );
        roundConstant = multiplyInGaloisField(roundConstant, 2);
      } else if (wordIndex % keyWordCount === 4) {
        word = word.map((byte) => SUBSTITUTION_BOX[byte]);
      }
      for (let byteIndex = 0; byteIndex < 4; byteIndex++) {
        roundKeys[wordIndex * 4 + byteIndex] = roundKeys[(wordIndex - keyWordCount) * 4 + byteIndex] ^ word[byteIndex];
      }
    }
    return roundKeys;
  }

  // State layout: state[row + 4 * column].
  function decryptBlock(roundKeys, input, inputOffset, output, outputOffset) {
    const state = new Uint8Array(AES_BLOCK_SIZE);
    const shifted = new Uint8Array(AES_BLOCK_SIZE);
    for (let i = 0; i < AES_BLOCK_SIZE; i++) state[i] = input[inputOffset + i] ^ roundKeys[AES_ROUND_COUNT * AES_BLOCK_SIZE + i];
    for (let round = AES_ROUND_COUNT - 1; round >= 0; round--) {
      // InvShiftRows and InvSubBytes.
      for (let column = 0; column < 4; column++) {
        for (let row = 0; row < 4; row++) {
          shifted[row + 4 * column] = INVERSE_SUBSTITUTION_BOX[state[row + 4 * ((column - row + 4) % 4)]];
        }
      }
      // AddRoundKey.
      for (let i = 0; i < AES_BLOCK_SIZE; i++) state[i] = shifted[i] ^ roundKeys[round * AES_BLOCK_SIZE + i];
      if (round === 0) break;
      // InvMixColumns.
      for (let column = 0; column < 4; column++) {
        const base = 4 * column;
        const [b0, b1, b2, b3] = [state[base], state[base + 1], state[base + 2], state[base + 3]];
        state[base] = MULTIPLY_BY_14[b0] ^ MULTIPLY_BY_11[b1] ^ MULTIPLY_BY_13[b2] ^ MULTIPLY_BY_9[b3];
        state[base + 1] = MULTIPLY_BY_9[b0] ^ MULTIPLY_BY_14[b1] ^ MULTIPLY_BY_11[b2] ^ MULTIPLY_BY_13[b3];
        state[base + 2] = MULTIPLY_BY_13[b0] ^ MULTIPLY_BY_9[b1] ^ MULTIPLY_BY_14[b2] ^ MULTIPLY_BY_11[b3];
        state[base + 3] = MULTIPLY_BY_11[b0] ^ MULTIPLY_BY_13[b1] ^ MULTIPLY_BY_9[b2] ^ MULTIPLY_BY_14[b3];
      }
    }
    output.set(state, outputOffset);
  }

  function aes256EcbDecrypt(key, encrypted) {
    if (encrypted.length % AES_BLOCK_SIZE !== 0) throw new Error('AES data length must be a multiple of 16');
    const roundKeys = expandKey256(key);
    const decrypted = new Uint8Array(encrypted.length);
    for (let offset = 0; offset < encrypted.length; offset += AES_BLOCK_SIZE) {
      decryptBlock(roundKeys, encrypted, offset, decrypted, offset);
    }
    return decrypted;
  }

  // ---------- TC66C packets ----------

  const GETVA_KEY = Uint8Array.of(
    0x58, 0x21, 0xfa, 0x56, 0x01, 0xb2, 0xf0, 0x26, 0x87, 0xff, 0x12, 0x04, 0x62, 0x2a, 0x4f, 0xb0,
    0x86, 0xf4, 0x02, 0x60, 0x81, 0x6f, 0x9a, 0x0b, 0xa7, 0xf1, 0x06, 0x61, 0x9a, 0xb8, 0x72, 0x88,
  );
  const GETVA_LENGTH = 192;
  const PACKET_SIZE = 64;
  const PACKET_CRC_OFFSET = 60;
  const RECORD_SIZE = 8;
  const RECORD_END_MARKER = 'reck';

  function readAscii(bytes, offset, length) {
    let text = '';
    for (let i = offset; i < offset + length; i++) text += String.fromCharCode(bytes[i]);
    return text;
  }

  // CRC-16/MODBUS (reflected polynomial 0xA001, initial value 0xFFFF).
  function crc16Modbus(bytes, offset, length) {
    let crc = 0xffff;
    for (let i = offset; i < offset + length; i++) {
      crc ^= bytes[i];
      for (let bit = 0; bit < 8; bit++) crc = crc & 1 ? (crc >>> 1) ^ 0xa001 : crc >>> 1;
    }
    return crc;
  }

  // Decrypt and decode a 192-byte getva response.
  // Throws an Error if the packet headers or the CRCs are not correct.
  function parseGetva(response) {
    const receivedLength = response ? response.length : 0;
    if (receivedLength < GETVA_LENGTH) throw new Error(`getva: received ${receivedLength} of ${GETVA_LENGTH} bytes`);
    const decrypted = aes256EcbDecrypt(GETVA_KEY, response.subarray(0, GETVA_LENGTH));
    const packetOffsets = [0, PACKET_SIZE, 2 * PACKET_SIZE];
    const headers = packetOffsets.map((offset) => readAscii(decrypted, offset, 4));
    if (headers.join() !== 'pac1,pac2,pac3') {
      throw new Error(`getva: incorrect packet headers (${JSON.stringify(headers)})`);
    }
    const view = new DataView(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
    const readUint32 = (offset) => view.getUint32(offset, true);
    // Each 64-byte packet ends with a uint32 LE CRC-16/MODBUS of its first 60 bytes.
    const crcValid = packetOffsets.map(
      (offset) => crc16Modbus(decrypted, offset, PACKET_CRC_OFFSET) === readUint32(offset + PACKET_CRC_OFFSET),
    );
    if (!crcValid.every(Boolean)) throw new Error(`getva: incorrect CRC (valid packets: ${JSON.stringify(crcValid)})`);
    return {
      model: readAscii(decrypted, 4, 4).replace(/\0+$/, ''),
      firmware: readAscii(decrypted, 8, 4).replace(/\0+$/, ''),
      serial: readUint32(12),
      runCount: readUint32(44),
      voltage: readUint32(48) * 1e-4,
      current: readUint32(52) * 1e-5,
      power: readUint32(56) * 1e-4,
      resistance: readUint32(68) * 1e-1,
      groups: [
        { mAh: readUint32(72), mWh: readUint32(76) },
        { mAh: readUint32(80), mWh: readUint32(84) },
      ],
      temperature: (readUint32(88) === 1 ? -1 : 1) * readUint32(92),
      dataPlus: readUint32(96) * 1e-2,
      dataMinus: readUint32(100) * 1e-2,
      crcValid,
      decrypted,
    };
  }

  // Decode a gtrec dump. Each record has uint32 LE voltage (x1e-4 V) and uint32 LE current (x1e-5 A).
  // The dump can end with the ASCII marker "reck".
  function parseGtrec(dump) {
    let dataLength = dump.length;
    let hasEndMarker = false;
    if (dataLength >= 4 && readAscii(dump, dataLength - 4, 4) === RECORD_END_MARKER) {
      dataLength -= 4;
      hasEndMarker = true;
    }
    const recordCount = Math.floor(dataLength / RECORD_SIZE);
    const view = new DataView(dump.buffer, dump.byteOffset, dump.byteLength);
    const records = [];
    for (let index = 0; index < recordCount; index++) {
      const voltage = view.getUint32(index * RECORD_SIZE, true) * 1e-4;
      const current = view.getUint32(index * RECORD_SIZE + 4, true) * 1e-5;
      records.push({ voltage, current, power: voltage * current });
    }
    return { records, hasEndMarker, extraByteCount: dataLength - recordCount * RECORD_SIZE };
  }

  // Add time and cumulative charge / energy to the records. Each record counts for one sample period.
  function summarizeRecords(records, samplePeriodSeconds) {
    let totalMilliampHours = 0;
    let totalMilliwattHours = 0;
    let minimumVoltage = Infinity;
    let maximumVoltage = -Infinity;
    let maximumCurrent = 0;
    let maximumPower = 0;
    const rows = records.map((record, index) => {
      totalMilliampHours += (record.current * samplePeriodSeconds) / 3.6;
      totalMilliwattHours += (record.power * samplePeriodSeconds) / 3.6;
      minimumVoltage = Math.min(minimumVoltage, record.voltage);
      maximumVoltage = Math.max(maximumVoltage, record.voltage);
      maximumCurrent = Math.max(maximumCurrent, record.current);
      maximumPower = Math.max(maximumPower, record.power);
      return {
        index,
        timeSeconds: index * samplePeriodSeconds,
        ...record,
        milliampHours: totalMilliampHours,
        milliwattHours: totalMilliwattHours,
      };
    });
    const count = records.length;
    const average = (field) => (count ? records.reduce((sum, record) => sum + record[field], 0) / count : 0);
    return {
      rows,
      count,
      durationSeconds: count * samplePeriodSeconds,
      averageVoltage: average('voltage'),
      averageCurrent: average('current'),
      averagePower: average('power'),
      minimumVoltage: count ? minimumVoltage : 0,
      maximumVoltage: count ? maximumVoltage : 0,
      maximumCurrent,
      maximumPower,
      milliampHours: totalMilliampHours,
      milliwattHours: totalMilliwattHours,
    };
  }

  function recordsToCsv(summary) {
    const lines = ['idx,time_s,volts,amps,watts,mAh,mWh'];
    for (const row of summary.rows) {
      lines.push([
        row.index,
        row.timeSeconds,
        row.voltage.toFixed(4),
        row.current.toFixed(5),
        row.power.toFixed(4),
        row.milliampHours.toFixed(2),
        row.milliwattHours.toFixed(2),
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }

  function samplesToCsv(samples) {
    const lines = ['time_iso,elapsed_s,volts,amps,watts,ohms,temp_c,dplus_v,dminus_v,g0_mAh,g0_mWh,g1_mAh,g1_mWh'];
    const startTime = samples.length ? samples[0].time : 0;
    for (const sample of samples) {
      lines.push([
        new Date(sample.time).toISOString(),
        ((sample.time - startTime) / 1000).toFixed(3),
        sample.voltage.toFixed(4),
        sample.current.toFixed(5),
        sample.power.toFixed(4),
        sample.resistance.toFixed(1),
        sample.temperature,
        sample.dataPlus.toFixed(2),
        sample.dataMinus.toFixed(2),
        sample.groups[0].mAh,
        sample.groups[0].mWh,
        sample.groups[1].mAh,
        sample.groups[1].mWh,
      ].join(','));
    }
    return lines.join('\n') + '\n';
  }

  // ---------- Web Serial transport ----------

  const USB_VENDOR_ID = 0x28e9;
  const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

  function withTimeout(promise, milliseconds, message) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), milliseconds);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
  }

  // One TC66C connection. All commands go through one queue, so only one command is active at a time.
  class TC66Port {
    constructor(serialPort) {
      this.serialPort = serialPort;
      this.reader = null;
      this.writer = null;
      this.readLoopFinished = null;
      this.closing = false;
      this.receivedChunks = [];
      this.receivedLength = 0;
      this.lastReceiveTime = 0;
      this.wakeWaitingTask = null;
      this.commandQueue = Promise.resolve();
      this.onclose = null; // Called with an Error when the connection stops without close().
    }

    async open() {
      await this.serialPort.open({
        baudRate: 115200, dataBits: 8, stopBits: 1, parity: 'none', flowControl: 'none', bufferSize: 65536,
      });
      try {
        await this.serialPort.setSignals({ dataTerminalReady: true, requestToSend: true });
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
          if (value && value.length) this.addReceivedChunk(value);
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

    addReceivedChunk(chunk) {
      this.receivedChunks.push(chunk);
      this.receivedLength += chunk.length;
      this.lastReceiveTime = performance.now();
      if (this.wakeWaitingTask) {
        const wake = this.wakeWaitingTask;
        this.wakeWaitingTask = null;
        wake();
      }
    }

    takeReceivedBytes() {
      const bytes = new Uint8Array(this.receivedLength);
      let offset = 0;
      for (const chunk of this.receivedChunks) {
        bytes.set(chunk, offset);
        offset += chunk.length;
      }
      this.receivedChunks = [];
      this.receivedLength = 0;
      return bytes;
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

    async write(command) {
      if (this.closing) throw new Error('The port is closed.');
      await withTimeout(this.writer.write(new TextEncoder().encode(command)), 2000, `Write of "${command}" timed out.`);
    }

    // Add a task to the command queue.
    enqueue(task) {
      const result = this.commandQueue.then(task);
      this.commandQueue = result.catch(() => {});
      return result;
    }

    // Send a command and wait for a fixed number of bytes.
    request(command, expectedLength, timeoutMilliseconds = 1500) {
      return this.enqueue(async () => {
        this.takeReceivedBytes();
        await this.write(command);
        const deadline = performance.now() + timeoutMilliseconds;
        while (this.receivedLength < expectedLength && !this.closing) {
          const remaining = deadline - performance.now();
          if (remaining <= 0) break;
          await this.waitForData(remaining);
        }
        const response = this.takeReceivedBytes();
        if (response.length < expectedLength) {
          throw new Error(`${command}: received ${response.length} of ${expectedLength} bytes in ${timeoutMilliseconds} ms`);
        }
        return response;
      });
    }

    // Send a command and read until the device is silent for silenceMilliseconds.
    // onProgress gets the number of received bytes.
    stream(command, { firstByteMilliseconds = 3000, silenceMilliseconds = 1500, maximumMilliseconds = 300000, onProgress } = {}) {
      return this.enqueue(async () => {
        this.takeReceivedBytes();
        await this.write(command);
        const startTime = performance.now();
        const parts = [];
        let totalLength = 0;
        let lastDataTime = startTime;
        while (!this.closing) {
          const now = performance.now();
          const waitUntil = totalLength === 0 ? startTime + firstByteMilliseconds : lastDataTime + silenceMilliseconds;
          if (now >= waitUntil || now - startTime >= maximumMilliseconds) break;
          await this.waitForData(Math.min(waitUntil, startTime + maximumMilliseconds) - now);
          if (this.receivedLength) {
            const chunk = this.takeReceivedBytes();
            parts.push(chunk);
            totalLength += chunk.length;
            lastDataTime = this.lastReceiveTime;
            if (onProgress) onProgress(totalLength);
          }
        }
        const response = new Uint8Array(totalLength);
        let offset = 0;
        for (const part of parts) {
          response.set(part, offset);
          offset += part.length;
        }
        return response;
      });
    }

    // Send a command that has no response.
    send(command, settleMilliseconds = 150) {
      return this.enqueue(async () => {
        await this.write(command);
        await sleep(settleMilliseconds);
        this.takeReceivedBytes();
      });
    }

    // Wait until the device is silent, then discard the received bytes.
    discardUntilSilent(silenceMilliseconds = 300) {
      return this.enqueue(async () => {
        do {
          this.takeReceivedBytes();
          await this.waitForData(silenceMilliseconds);
        } while (this.receivedLength && !this.closing);
        this.takeReceivedBytes();
      });
    }

    async query() {
      const response = await this.request('query', 4, 1500);
      return readAscii(response, 0, 4);
    }

    async getva() {
      return parseGetva(await this.request('getva', GETVA_LENGTH, 1500));
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

  const api = {
    aes256EcbDecrypt,
    crc16Modbus,
    parseGetva,
    parseGtrec,
    summarizeRecords,
    recordsToCsv,
    samplesToCsv,
    TC66Port,
    USB_VENDOR_ID,
    GETVA_KEY,
    GETVA_LENGTH,
    RECORD_SIZE,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else globalScope.TC66 = api;
})(globalThis);

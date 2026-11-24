# TC66C Web Serial — findings handoff

Findings from a Windows-side session (2026-11-10) that talked to the meter on the Windows host.

## Device
- **RDTech / RuiDeng TC66C** USB-C meter, connected to the **Windows host** (not WSL) on **COM5**.
- Windows device: `GD32 Virtual Com Port (COM5)`, GigaDevice, USB `VID_28E9&PID_018A`, instance serial `TC66`.
- Reported over serial: model `TC66`, firmware **1.17**, device serial **5795**, run count 419.
- Note: WSL does not see COM5 unless passed through (usbipd-win). A browser app on Windows (Chrome/Edge) can use it directly via Web Serial.

## Serial protocol (confirmed working)
- 115200 8N1, set **DTR and RTS on**. Commands are plain ASCII, no terminator.
- **Always use read/write timeouts.** A first attempt with no timeouts hung and the meter **froze**; Windows then returned
  "device does not exist" (error 55) on open. Fixed with `pnputil /restart-device "USB\VID_28E9&PID_018A\TC66"`
  (and/or replugging the meter).

| Command | Response |
|---|---|
| `query` | 4 ASCII bytes: `firm` (normal firmware) or `boot` (bootloader) |
| `getva` | 192 bytes, AES-256-ECB encrypted, no padding |
| `gtrec` | Offline recording, **unencrypted**, 8 bytes/record; stream until ~1.5 s silence |
| `nextp` / `lastp` | Next / previous screen page |
| `rotat` | Rotate screen |
| `update` | Enters bootloader for firmware update — **don't send casually** |

No serial command for resetting the mAh/mWh groups is known. Reset is done on the device buttons.

### getva decryption
AES key (32 bytes):
```
58 21 fa 56 01 b2 f0 26 87 ff 12 04 62 2a 4f b0
86 f4 02 60 81 6f 9a 0b a7 f1 06 61 9a b8 72 88
```
Decrypted 192 bytes = three 64-byte packets starting `pac1`, `pac2`, `pac3`. All fields are uint32 little-endian:

| Offset | Field | Scale |
|---|---|---|
| 0 | `pac1` | |
| 4 | model (4 ASCII) | |
| 8 | firmware (4 ASCII, e.g. `1.17`) | |
| 12 | serial | |
| 44 | run count | |
| 48 | voltage | ×1e-4 V |
| 52 | current | ×1e-5 A |
| 56 | power | ×1e-4 W |
| 64 | `pac2` | |
| 68 | load resistance | ×1e-1 Ω |
| 72 / 76 | group 0 mAh / mWh | |
| 80 / 84 | group 1 mAh / mWh | |
| 88 | temperature sign (1 = negative) | |
| 92 | temperature | °C |
| 96 | D+ | ×1e-2 V |
| 100 | D− | ×1e-2 V |

Each 64-byte packet ends at offset 60 with a uint32 LE CRC-16/MODBUS of its first 60 bytes.
This is confirmed on 3 live dumps (2026-11-10). The page rejects packets with a bad CRC.

`nextp`, `lastp` and `rotat` send no reply bytes (confirmed on the meter).

### gtrec format
Each record: uint32 LE voltage ×1e-4 V, uint32 LE current ×1e-5 A. The stream ended with 4 extra ASCII bytes
`reck`, probably an end marker, not a record. Sample period is set on the device. The user's meter uses **10 s**.

## Data pulled from the meter
The dumps are test fixtures in `test/fixtures/`. The local `research/` folder (not in git) has the scripts and firmware files.
- `tc66_rec.bin`: raw `gtrec` dump (3956 bytes = 494 records + `reck`)
- `tc66_rec.csv`: `idx,time_s,volts,amps,watts` (10 s period)
- `getva-0.bin` … `getva-2.bin`: raw encrypted `getva` responses (meter idle, 0 V)
- Recording: steady ~5.02 V / 1.147 A / 5.76 W for ~82 min, giving ~1574 mAh / ~7.90 Wh.
  The meter's group 0 counter showed 1706 mAh / 8554 mWh.
- `tc66.ps1` / `tc66rec.ps1`: PowerShell scripts used (live read + recording dump). **Bug note:** PowerShell variables
  are case-insensitive. Don't use `$v` and `$V` together; that doubled values in an earlier run.

## Firmware
- Latest known: **1.18** (2022-12-05, no release notes). Meter has 1.17, which already fixed false PD detection via A-to-C adapters.
- Flash via the official RDTech PC software ("Firmware Upgrade"), or bootloader mode (hold K1 while plugging in) +
  [skgsergio/tc66c-toolkit](https://github.com/skgsergio/tc66c-toolkit). Use official firmware files only.

### Firmware files (local `research/firmware/`, not in git)
- `TC66.bin` v1.18 from the RDTech update server. The tc66c-toolkit copy is byte-identical. Sources and SHA-256 are in `SOURCES.md`.
- The file is encrypted. It has high entropy and repeated 16-byte blocks, which suggests a block cipher in ECB mode.
- The getva key does not decrypt it. No public source gives the firmware key. The bootloader decrypts the file on the device.
- So `strings` on the file gives no command names. No source documents commands other than the 7 above.
  The BLE variant uses a `b` prefix and `\r\n` (`bgetva`, `bnextp`, ...).
- Possible next steps: dump the GD32 flash (SWD), or capture the USB traffic of the official PC software.

## Existing browser app
- [serial.combien-consomme.fr](https://serial.combien-consomme.fr/) ([source](https://github.com/fqueze/webserial-power-profiling)),
  by Florian Quèze (Mozilla). Supports TC66C (USB `28e9:*`, `RuiDengDriver`). It does live sampling, resets its own samples,
  and exports CSV or Firefox Profiler format.
  It **has no** page/rotate controls and **no** `gtrec` offline-record download. A good reference for the Web Serial + driver structure.
- Web Serial works in Chrome/Edge and Firefox 151+, not Safari. It needs a secure context (`https://` or a local file / localhost).

## Planned app (what to build here)
Local HTML page using Web Serial that provides:
- live V / A / W / D+ / D− / temperature with a graph (poll `getva`, decrypt with WebCrypto AES. Note WebCrypto has no ECB mode,
  so emulate it with AES-CBC and a zero IV, one 16-byte block at a time, or use a small AES library)
- buttons: next page, previous page, rotate
- download of the offline recording (`gtrec`) to CSV with a configurable sample period (default 10 s)
- per-device info (model, firmware, serial, run count, group counters)

## DPS3005 power supply (added 2026-11-24)

The user's unit advertises over classic Bluetooth (SPP/RFCOMM, not BLE) as `DPS3005_001`, address `00:BA:57:57:CC:9B`.
It was not paired with the Windows laptop at the time of writing. WSL cannot pair it.

### Connection
- Modbus RTU, slave address 1, 9600 8N1 by default. The supply setup menu can change the address and the baud rate.
  DPS5005_pyGUI reports that 2400 and 19200 baud may not work. 4800 and 9600 work.
- Windows: a paired SPP device gets an incoming and an outgoing Bluetooth COM port. Web Serial opens the outgoing one.
- Newer Chrome can open the RFCOMM service directly with
  `requestPort({ allowedBluetoothServiceClassIds: ['00001101-0000-1000-8000-00805f9b34fb'] })`.
  The page uses this option. "Bluetooth only" adds a `bluetoothServiceClassId` filter.
  An older browser rejects that filter with a `TypeError`. Then the page shows all ports.
- The Bluetooth module accepts one connection. Close the phone app first.
- The page does not call `setSignals()` (DTR/RTS). Modbus RTU does not need them, and a Bluetooth port may not support them.

### Protocol
- Functions: 0x03 read holding registers, 0x06 write single register, 0x10 write multiple registers.
- CRC-16/MODBUS, low byte first. The same CRC protects the TC66 `getva` packets.
- An exception response has the function code with bit 0x80 set and one exception code byte.
- `js/dps.js` sends one request at a time, with a 1 s timeout and a 20 ms gap after each response.
  Reads and writes get a second attempt after a timeout. All writes set absolute values, so a repeated write is safe.
  The response search skips noise bytes before the frame.

### Register map (DPS3005)

| Address | Name | Scale | Notes |
|---|---|---|---|
| 0x00 | U-SET | V/100 | R/W |
| 0x01 | I-SET | A/1000 | R/W |
| 0x02 | UOUT | V/100 | R |
| 0x03 | IOUT | A/1000 | R |
| 0x04 | POWER | W/100 | R |
| 0x05 | UIN | V/100 | R |
| 0x06 | LOCK | 0/1 | R/W, key lock |
| 0x07 | PROTECT | | 0 OK, 1 OVP, 2 OCP, 3 OPP |
| 0x08 | CV/CC | | 0 CV, 1 CC |
| 0x09 | ONOFF | 0/1 | R/W, output |
| 0x0A | B_LED | 0-5 | R/W, brightness |
| 0x0B | MODEL | | 3005 |
| 0x0C | VERSION | /10 | e.g. 16 = 1.6 |
| 0x23 | EXTRACT_M | 0-9 | W, recall memory group |
| 0x50 + 0x10·n | M0-M9 | | 8 registers per group, see below |

Memory group fields: U-SET (V/100), I-SET (A/1000), S-OVP (V/100), S-OCP (A/1000), S-OPP (W/10), B-LED, M-PRE, S-INI
(output state at power on). M0 is the group that the supply loads at power on.

Sources: [DPS5005_pyGUI](https://github.com/lambcutlet/DPS5005_pyGUI) (`dps_modbus.py`, `dps5005_limits.ini`) for the
DPS5005, which has the same registers and scaling as the DPS3005.

**Not confirmed yet (check on the real supply):**
- The PROTECT and CV/CC values. They come from the RDTech protocol document, which was not found online in this session.
- Recall with register 0x23. DPS5005_pyGUI limits this register to 0-1. The page writes 0-9.
- The 0x10 stride of the memory groups. DPS5005_pyGUI reads only M0 at 0x50-0x57.
- Save U/I: the page writes U-SET and I-SET of a group with function 0x10 (2 registers at 0x50 + 0x10·n).
  Check that the supply keeps the values after a power cycle.
- The scaling of DPS5015, DPS5020 and DPS8005 in `MODELS` (`js/dps.js`). They are estimates.

### Hardware test checklist
1. Pair `DPS3005_001` in Windows (PIN usually 1234). Close the phone app.
2. Open `dps.html` in Chrome or Edge on Windows. Turn on "Show the Modbus frames" in the log.
3. Connect with the outgoing Bluetooth COM port. Then try "Bluetooth (RFCOMM) only".
4. Compare U, I, P, UIN, CV/CC and the firmware version with the supply display.
5. Set 5 V / 0.1 A with no load, switch the output on and off, lock and unlock the keys, change the brightness.
6. Read M0-M9 and compare with the supply. Recall M1 and check U-SET and I-SET.
7. Short the output through a resistor with a low I-SET to see CC. Set a low OCP to see the protection state.
8. Save the frame log as a fixture for `test/fixtures/dps-frames.json`.

## Follow-up ideas (not implemented)

### Combined TC66 + DPS automated test
Use the DPS3005 as a programmable source and the TC66C as an independent meter on the same circuit.
Both run in one page with two serial ports, one queue each.
- **Meter calibration check:** step the DPS output (for example 5, 9, 12, 20 V into a fixed load).
  Compare the TC66 voltage and current with the DPS values at each step. Report the offset and the gain error.
- **CC charge or load test:** use the DPS in CC mode to charge a cell or a power bank at a fixed current.
  The TC66 counts mAh and Wh. Stop at a voltage limit or when the current falls below a threshold.
- **Cable resistance:** source a fixed current through a USB cable. The DPS reads the voltage at its output,
  the TC66 at the far end. The difference divided by the current is the cable resistance.
- Points to solve: time alignment of the two sample streams, safe limits (OVP and OCP set before the output goes on),
  and an emergency stop that switches the DPS output off when a check fails or a port disconnects.
- The battery test page (`js/db.js`) can store these runs. `DPS.Poller` and `TC66Port` can share the timing code.

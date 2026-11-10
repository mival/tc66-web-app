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

# SerialBench

Bench instruments in the browser. SerialBench reads the RDTech TC66C USB-C meter, runs power bank capacity tests and controls the RDTech DPS3005 power supply.
It uses the Web Serial API. It needs no server and no build step.

Online version: <https://mival.github.io/tc66-web-app/>. You can also open `index.html` from a local folder.
The start page (`index.html`) links to each tool.

## Features

- Live voltage, current, power, load resistance, temperature, D+ and D− with interactive charts.
- Next page, previous page and rotate buttons for the meter screen.
- Download of the offline recording (`gtrec`) to CSV or raw `.bin`, with a sample period that you set.
- Device information: model, firmware, serial, run count and the two mAh/mWh groups.
- An "Advanced" console that sends a raw ASCII command and shows the reply as hex.
- Light and dark theme. The header button cycles auto, light and dark. "Auto" follows the system setting.
- A layout for phones and tablets.
- A battery test page (`battery.html`) for power bank capacity. See below.
- A power supply page (`dps.html`) for the RDTech DPS3005. See below.
- A Progressive Web App (PWA). You can install it and use it offline.
- A version badge in the footer. The app checks for a new version and shows a reload banner.
- An "Install" button in the header when the browser can install the app.
- English and Czech. The app uses Czech when the browser language is Czech. The header button changes the language.

On all device pages:

- **Connect** uses the port that you allowed before, without the port chooser. **Choose port…** selects another one.
- After a lost connection, the page connects again when the device is back (for about one or two minutes).
- Errors show as a short message (toast) near the top, not only in the log.
- Polling uses a timer in a web worker. A hidden tab keeps its sample rate, so a long test does not slow down.
- The charts show only the selected time window. Move the mouse over a chart to read the values.
  Drag sideways to zoom. Double click to reset.

## Battery test

`battery.html` records a discharge test and computes the capacity of a power bank.

- Discharge the power bank through a load. The meter measures the output.
- The page adds up the charge (mAh) and the energy (Wh) with the trapezoid rule.
- Enter the rated capacity to see the efficiency against the rating.
- With a rated capacity, the page estimates the remaining time. It uses the average power of the last 5 minutes. Conversion losses can make the real time shorter.
- Automatic start and stop: the test starts when the current rises above a threshold and stops when it falls below one.
- Each test is saved in the browser with IndexedDB. No server is needed.
- A test continues after a short connection loss. A gap of more than 30 s adds no charge.
- The screen stays on during a test (screen wake lock). The page warns before you close the tab during a test.
- A test that was cut off (for example a closed tab) is closed on the next page load, with the saved samples.
- The "Saved tests" list shows each test. Select one to graph it and read its totals.
- Interactive charts (uPlot). Move the mouse over a chart to read the values. Drag sideways to zoom. Double click to reset.
- Export or import all tests as a JSON file. Download a test as CSV.

The data stays in the browser. To see a test on another device, export the JSON and import it there.

## Power supply (DPS3005)

`dps.html` controls an RDTech DPS3005 power supply over Modbus RTU.

- Live output voltage, output current, power and input voltage, with charts.
- Charge (mAh), energy (Wh) and output-on time, counted by the page. The supply does not count them.
- The CV/CC mode, the protection state (OVP, OCP, OPP), the output state and the key lock.
- Set the voltage and the current limit with arrow buttons, the arrow keys or a typed value. Choose the step size.
- Switch the output on and off, lock the keys, set the brightness.
- Safety limits: the page does not send a voltage or a current limit above the values that you set.
- A banner shows when a protection trips. A warning shows when U-SET is too high for the input voltage.
- An option locks the keys when the page connects and unlocks them on disconnect.
- Read the memory groups M0-M9, recall one of them, or edit one in a dialog: U, I, OVP, OCP, OPP, light, M-PRE and output on start.
- Save the live samples as CSV.
- A wired COM port, a paired Bluetooth COM port, or a direct Bluetooth RFCOMM port in newer Chrome.

The default settings are 9600 baud, 8N1 and slave address 1. The page sends one request at a time.
For Bluetooth on Windows, pair the supply first (PIN usually `1234`) and close the phone app.
Then select the outgoing Bluetooth COM port. The help page has the steps.

The DPS3005 scaling agrees with public register tables. The scaling of other DPS models is not confirmed.
`NOTES.md` has the register map.

## Use

1. Connect the meter to Windows. WSL does not see the COM port.
2. Open the online version or the local `index.html` in Chrome or Edge. Then select **Meter**.
3. Click **Connect**, then select "GD32 Virtual Com Port".
4. Close other programs that use the port before you connect.

For the offline recording, set the sample period to the value on the meter. The meter does not send it.

## Files

| Path | Content |
|---|---|
| `index.html` | Start page: links to the tools |
| `meter.html` | Meter page markup |
| `battery.html` | Battery test page markup |
| `dps.html` | Power supply page markup |
| `css/style.css` | Styles, light and dark color scheme, phone layout |
| `js/common.js` | Shared page helpers: log, status, toasts, Connect button, known ports and reconnect, worker timer, wake lock |
| `js/tc66.js` | AES-256 decryption, packet parsers, CSV export, serial transport |
| `js/stepper.js` | Arrow buttons for number inputs, value of a segmented control |
| `js/uchart.js` | Interactive uPlot chart wrapper with a time window (all pages) |
| `js/vendor/uplot/` | uPlot chart library |
| `js/app.js` | Meter page logic |
| `js/db.js` | IndexedDB session store and capacity integrator |
| `js/battery.js` | Battery test page logic |
| `js/dps.js` | Modbus RTU frames and CRC, DPS register decoding, serial transport with a request queue, poller |
| `js/dps-app.js` | Power supply page logic |
| `js/theme.js` | Color scheme toggle (auto, light, dark) |
| `js/i18n.js` | Language choice and page translation (English, Czech) |
| `js/i18n-cs.js` | Czech texts: whole texts, texts with values, sentences with markup |
| `js/pwa.js` | Service worker registration |
| `js/version.js` | Build version, set by the deploy workflow |
| `js/update.js` | Version badge, version check and update banner |
| `version.json` | Version file for the periodic check |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | PWA files |
| `help.cs.html` | Czech help page. Keep it in step with `help.html`. |
| `img/` | Photos of the TC66C and the DPS front panel (help page and start page) |
| `test/` | Unit tests, end-to-end tests, meter fixtures, Modbus fixture frames |
| `test/lib/browser.mjs` | Shared end-to-end test code: Chrome, DevTools calls, checks, static server |
| `research/` | Local research files (not in git): scripts, firmware images |

## Tests

Run the unit tests:

```sh
node --test test/tc66.test.js test/db.test.js test/dps.test.js
```

Run the end-to-end test. It starts headless Chrome with a mock serial port that replays real meter bytes:

```sh
BROWSER_PATH=/path/to/chrome node test/e2e.mjs
```

Set `SCREENSHOT=1` to keep a screenshot and the saved CSV files.

There is also a battery page end-to-end test. Run it with the same `BROWSER_PATH`:

```sh
BROWSER_PATH=/path/to/chrome node test/battery.e2e.mjs
```

The power supply end-to-end test uses a DPS3005 emulator as the mock serial port:

```sh
BROWSER_PATH=/path/to/chrome node test/dps.e2e.mjs
```

The tests work with the full Chrome binary (as in CI) and with `chrome-headless-shell`.
Headless Chrome gives no animation frames to a page that DevTools controls, so the tests do not check the chart drawing.

## Deployment

The `Pages` workflow (`.github/workflows/pages.yml`) runs the unit tests and the meter, power supply and battery end-to-end tests on each push
and pull request. On a push to `main`, it then publishes the pages, `css/`, `js/`, `img/` and the PWA files to GitHub Pages.

The build step writes the git commit and the date into `js/version.js` and `version.json`. It also sets a new service
worker cache name. The page shows the version in the footer. The page fetches `version.json` to find a new version.
The page checks on load, when it becomes visible, and every 30 minutes.
When a new version is ready, a banner asks the user to reload. The page does not reload by itself.
The service worker fetches the app files network-first with cache `no-cache`.
GitHub Pages lets the browser keep a file for 10 minutes. `no-cache` makes the browser ask the server each time.
The service worker uses its cache only offline, or when the server gives no answer in 3 seconds.

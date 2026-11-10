# TC66C Web Serial

A web page for the RDTech TC66C USB-C meter. The page uses the Web Serial API. It needs no server and no build step.

Online version: <https://mival.github.io/tc66-web-app/>. You can also open `index.html` from a local folder.

## Features

- Live voltage, current, power, load resistance, temperature, D+ and D− with charts.
- Next page, previous page and rotate buttons for the meter screen.
- Download of the offline recording (`gtrec`) to CSV or raw `.bin`, with a sample period that you set.
- Device information: model, firmware, serial, run count and the two mAh/mWh groups.
- An "Advanced" console that sends a raw ASCII command and shows the reply as hex.
- Light and dark theme. The header button cycles auto, light and dark. "Auto" follows the system setting.
- A layout for phones and tablets.
- A battery test page (`battery.html`) for power bank capacity. See below.
- A Progressive Web App (PWA). You can install it and use it offline.

## Battery test

`battery.html` records a discharge test and computes the capacity of a power bank.

- Discharge the power bank through a load. The meter measures the output.
- The page adds up the charge (mAh) and the energy (Wh) with the trapezoid rule.
- Enter the rated capacity to see the efficiency against the rating.
- Automatic start and stop: the test starts when the current rises above a threshold and stops when it falls below one.
- Each test is saved in the browser with IndexedDB. No server is needed.
- The "Saved tests" list shows each test. Select one to graph it and read its totals.
- Interactive charts (uPlot). Move the mouse over a chart to read the values. Drag sideways to zoom. Double click to reset.
- Export or import all tests as a JSON file. Download a test as CSV.

The data stays in the browser. To see a test on another device, export the JSON and import it there.

## Use

1. Connect the meter to Windows. WSL does not see the COM port.
2. Open the online version or the local `index.html` in Chrome or Edge.
3. Click **Connect**, then select "GD32 Virtual Com Port".
4. Close other programs that use the port before you connect.

For the offline recording, set the sample period to the value on the meter. The meter does not send it.

## Files

| Path | Content |
|---|---|
| `index.html` | Meter page markup |
| `battery.html` | Battery test page markup |
| `css/style.css` | Styles, light and dark color scheme, phone layout |
| `js/tc66.js` | AES-256 decryption, packet parsers, CSV export, serial transport |
| `js/chart.js` | Canvas strip chart (meter page) |
| `js/uchart.js` | Interactive uPlot chart wrapper (battery page) |
| `js/vendor/uplot/` | uPlot chart library |
| `js/app.js` | Meter page logic |
| `js/db.js` | IndexedDB session store and capacity integrator |
| `js/battery.js` | Battery test page logic |
| `js/theme.js` | Color scheme toggle (auto, light, dark) |
| `js/pwa.js` | Service worker registration |
| `sw.js`, `manifest.webmanifest`, `icon.svg` | PWA files |
| `test/` | Unit tests, end-to-end tests, meter fixtures |
| `research/` | Local research files (not in git): scripts, firmware images |

## Tests

Run the unit tests:

```sh
node --test test/tc66.test.js test/db.test.js
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

## Deployment

The `Pages` workflow (`.github/workflows/pages.yml`) runs the unit tests and the meter end-to-end test on each push
and pull request. On a push to `main`, it then publishes the pages, `css/`, `js/` and the PWA files to GitHub Pages.

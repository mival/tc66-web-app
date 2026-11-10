# TC66C Web Serial

A web page for the RDTech TC66C USB-C meter. The page uses the Web Serial API. It needs no server and no build step.

Online version: <https://mival.github.io/tc66-web-app/>. You can also open `index.html` from a local folder.

## Features

- Live voltage, current, power, load resistance, temperature, D+ and D− with charts.
- Next page, previous page and rotate buttons for the meter screen.
- Download of the offline recording (`gtrec`) to CSV or raw `.bin`, with a sample period that you set.
- Device information: model, firmware, serial, run count and the two mAh/mWh groups.
- An "Advanced" console that sends a raw ASCII command and shows the reply as hex.
- Light and dark theme. The page follows the system setting. The header button selects the other theme for this browser.
- A layout for phones and tablets.

## Use

1. Connect the meter to Windows. WSL does not see the COM port.
2. Open the online version or the local `index.html` in Chrome or Edge.
3. Click **Connect**, then select "GD32 Virtual Com Port".
4. Close other programs that use the port before you connect.

For the offline recording, set the sample period to the value on the meter. The meter does not send it.

## Files

| Path | Content |
|---|---|
| `index.html` | Page markup |
| `css/style.css` | Styles, light and dark color scheme, phone layout |
| `js/tc66.js` | AES-256 decryption, packet parsers, CSV export, serial transport |
| `js/chart.js` | Canvas strip chart |
| `js/app.js` | Page logic |
| `test/` | Unit tests, end-to-end test, meter fixtures |
| `research/` | Local research files (not in git): scripts, firmware images |

## Tests

Run the unit tests:

```sh
node --test test/tc66.test.js
```

Run the end-to-end test. It starts headless Chrome with a mock serial port that replays real meter bytes:

```sh
BROWSER_PATH=/path/to/chrome node test/e2e.mjs
```

Set `SCREENSHOT=1` to keep a screenshot and the saved CSV files.

## Deployment

The `Pages` workflow (`.github/workflows/pages.yml`) runs the tests on each push and pull request.
On a push to `main`, it then publishes `index.html`, `css/` and `js/` to GitHub Pages.

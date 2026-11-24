// Shared code for the end-to-end tests: start headless Chrome, talk to it over the DevTools protocol,
// serve the project over HTTP, count the checks and remove the output folder.
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const projectDirectory = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
export const sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

export function makeOutputDirectory(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Start Chrome and connect to its first page. Returns the DevTools helpers.
// Each call has a timeout, so a stuck page fails the test instead of hanging it.
export async function startBrowser({ debugPort, outputDirectory, timeoutMilliseconds = 15000 }) {
  const browserPath = process.env.BROWSER_PATH;
  if (!browserPath) throw new Error('Set BROWSER_PATH to a Chrome binary.');
  const chrome = spawn(browserPath, [
    '--headless', `--remote-debugging-port=${debugPort}`, '--no-sandbox', `--user-data-dir=${outputDirectory}/profile`, 'about:blank',
  ], { stdio: ['ignore', 'ignore', 'pipe'] });
  // Keep the Chrome log. The test shows it if Chrome does not start.
  let chromeLog = '';
  chrome.stderr.on('data', (data) => { chromeLog += data; });
  let chromeExitCode = null;
  chrome.on('exit', (code, signal) => { chromeExitCode = code ?? signal; });
  chrome.on('error', (error) => {
    console.error(`Cannot start Chrome at "${browserPath}": ${error.message}`);
    process.exit(1);
  });

  // Wait up to 15 s for the DevTools endpoint and a page target.
  let socket;
  for (let attempt = 0; attempt < 150 && !socket && chromeExitCode === null; attempt++) {
    try {
      const targets = await (await fetch(`http://127.0.0.1:${debugPort}/json`)).json();
      const pageTarget = targets.find((target) => target.type === 'page');
      if (pageTarget) socket = new WebSocket(pageTarget.webSocketDebuggerUrl);
    } catch {
      // The DevTools endpoint is not ready yet.
    }
    if (!socket) await sleep(100);
  }
  if (!socket) {
    chrome.kill();
    console.error(chromeLog.slice(-4000));
    const reason = chromeExitCode === null ? 'in 15 s' : `(Chrome stopped with ${chromeExitCode})`;
    throw new Error(`Chrome did not start ${reason}.`);
  }
  await new Promise((resolve) => socket.addEventListener('open', resolve));

  let messageId = 0;
  const pendingReplies = new Map();
  const pageErrors = [];
  socket.addEventListener('message', (event) => {
    const message = JSON.parse(event.data);
    if (message.id && pendingReplies.has(message.id)) {
      pendingReplies.get(message.id)(message);
      pendingReplies.delete(message.id);
    }
    if (message.method === 'Runtime.exceptionThrown') {
      const details = message.params.exceptionDetails;
      pageErrors.push(details.exception?.description || details.text);
    }
    if (message.method === 'Runtime.consoleAPICalled' && message.params.type === 'error') {
      pageErrors.push(message.params.args.map((argument) => argument.value ?? argument.description).join(' '));
    }
  });

  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const id = ++messageId;
    const timer = setTimeout(() => {
      pendingReplies.delete(id);
      reject(new Error(`DevTools call ${method} timed out.`));
    }, timeoutMilliseconds);
    pendingReplies.set(id, (message) => {
      clearTimeout(timer);
      resolve(message);
    });
    socket.send(JSON.stringify({ id, method, params }));
  });
  const evaluate = async (expression) => {
    const reply = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (reply.result.exceptionDetails) throw new Error(JSON.stringify(reply.result.exceptionDetails));
    return reply.result.result.value;
  };
  const textOf = (id) => evaluate(`document.getElementById('${id}').textContent`);
  const click = (selector) => evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
  const close = () => {
    socket.close();
    chrome.kill();
  };
  return { send, evaluate, textOf, click, pageErrors, close };
}

// Count the checks and print each result.
export function createChecks() {
  let failureCount = 0;
  return {
    check(name, passed, details = '') {
      console.log(`${passed ? 'PASS' : 'FAIL'} ${name}${details ? '  ' + details : ''}`);
      if (!passed) failureCount++;
    },
    get failureCount() { return failureCount; },
  };
}

// A small static file server for the project folder. Some features (IndexedDB, service worker) need http.
export async function startStaticServer() {
  const mimeTypes = {
    '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
    '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.webmanifest': 'application/manifest+json',
  };
  const server = createServer((request, response) => {
    const urlPath = decodeURIComponent(request.url.split('?')[0]);
    const filePath = path.join(projectDirectory, urlPath === '/' ? 'index.html' : urlPath);
    if (!filePath.startsWith(projectDirectory) || !fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
      response.writeHead(404);
      response.end('not found');
      return;
    }
    response.writeHead(200, { 'content-type': mimeTypes[path.extname(filePath)] || 'application/octet-stream' });
    fs.createReadStream(filePath).pipe(response);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { baseUrl: `http://127.0.0.1:${server.address().port}`, close: () => server.close() };
}

// Keep the output folder when a check failed or SCREENSHOT is set. Then exit with the test result.
export async function finish({ failureCount, outputDirectory }) {
  if (failureCount || process.env.SCREENSHOT) {
    console.log('output:', outputDirectory);
  } else {
    await sleep(500); // Chrome must exit before its profile can be removed.
    fs.rmSync(outputDirectory, { recursive: true, force: true });
  }
  process.exit(failureCount ? 1 : 0);
}

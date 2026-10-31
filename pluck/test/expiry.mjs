// Verifies the expired-session state with a short-lived server on port 7778.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));
const PORT = 7778;
const server = spawn('node', ['server/index.js'], {
  cwd: path.resolve('.'),
  env: { ...process.env, PORT: String(PORT), PLUCK_SESSION_SECONDS: '25' },
  stdio: ['ignore', fs.openSync('server.ttl.out.txt', 'w'), fs.openSync('server.ttl.err.txt', 'w')],
});
for (let i = 0; i < 40; i++) {
  await delay(400);
  try {
    const h = await (await fetch(`http://127.0.0.1:${PORT}/api/health`)).json();
    if (h.ok) { console.log('server up, sessionSeconds', h.sessionSeconds); break; }
  } catch { /* not yet */ }
}

const CHROME = process.env.PLUCK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pluck-ttl-'));
const child = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1000', '--remote-debugging-port=0', 'about:blank',
], { stdio: 'ignore' });

let port = 0;
for (let i = 0; i < 60 && !port; i++) {
  await delay(250);
  const f = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(f)) { const [p] = fs.readFileSync(f, 'utf8').split('\n'); if (p) port = Number(p); }
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq; pending.set(id, res); ws.send(JSON.stringify({ id, method, params }));
});
const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

await send('Page.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/` });
await delay(1500);
await evalJs(`document.querySelector('#page-url').value = 'https://www.w3schools.com/html/html5_video.asp';
  document.querySelector('#capture-form').requestSubmit();`);
await delay(6000);
console.log('timer at start', await evalJs(`document.querySelector('#timer-value')?.textContent`));
console.log('pill', await evalJs(`document.querySelector('#live-pill')?.textContent.trim()`));

for (let i = 0; i < 12; i++) {
  await delay(4000);
  const open = await evalJs(`getComputedStyle(document.querySelector('#monitor-veil')).visibility === 'visible'`);
  if (open) {
    console.log('veil after', (i + 1) * 4, 's');
    console.log('  veil text', await evalJs(`document.querySelector('#veil-text')?.textContent?.trim()`));
    console.log('  end action', await evalJs(`document.querySelector('#end-session')?.textContent?.trim()`));
    console.log('  status', await evalJs(`document.querySelector('#status-line')?.textContent?.trim()`));
    console.log('  pill', await evalJs(`document.querySelector('#live-pill')?.textContent.trim()`));
    break;
  }
  console.log('t+' + (i + 1) * 4, 's pill', await evalJs(`document.querySelector('#live-pill')?.textContent.trim()`),
    'timer', await evalJs(`document.querySelector('#timer-value')?.textContent`),
    'veilHidden', await evalJs(`document.querySelector('#monitor-veil')?.hidden`),
    'veilGone', await evalJs(`document.querySelector('#monitor-veil')?.classList.contains('is-gone')`),
    'line', await evalJs(`document.querySelector('#status-line')?.textContent?.trim()`),
    'endBtn', await evalJs(`document.querySelector('#end-session')?.textContent?.trim()`));
}

ws.close();
child.kill();
server.kill();
await delay(500);
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* temp */ }
process.exit(0);

// Exercises the secondary UI: notes reveal, preview dialog, filter chips and sort.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.PLUCK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pluck-ui-'));
const child = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1000', '--remote-debugging-port=0', 'about:blank',
], { stdio: 'ignore' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

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
await send('Runtime.enable');
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });
await send('Page.navigate', { url: 'http://127.0.0.1:7777/' });
await delay(1600);

console.log('faq before', await evalJs(`document.querySelectorAll('.faq details[open]').length`));
await evalJs(`document.querySelectorAll('.faq summary')[2].click()`);
await delay(300);
console.log('faq after', await evalJs(`document.querySelectorAll('.faq details[open]').length`));

await evalJs(`document.querySelector('#page-url').value = ${JSON.stringify(process.env.TEST_PAGE || 'https://bitmovin.com/demos/stream-test')};
  document.querySelector('#capture-form').requestSubmit();`);
for (let i = 0; i < 40; i++) {
  await delay(1000);
  const n = await evalJs(`document.querySelectorAll('.signal').length`);
  if (n >= 2) break;
}
console.log('signals', await evalJs(`document.querySelectorAll('.signal').length`));

// notes reveal
const noteBtn = await evalJs(`(() => { const b = [...document.querySelectorAll('button, a')].find(x => /\\bshow\\b/i.test(x.textContent) && x.offsetParent); if (!b) return 'none'; b.click(); return b.className + ':' + b.textContent.trim(); })()`);
await delay(600);
console.log('notes button', noteBtn, '| rows now', await evalJs(`document.querySelectorAll('.signal').length`));

// filter chips
console.log('chips', await evalJs(`[...document.querySelectorAll('[data-filter]')].map(b => b.dataset.filter + (b.classList.contains('is-on') ? '*' : '')).join(',')`));
await evalJs(`document.querySelector('[data-filter="hls"]')?.click()`);
await delay(300);
console.log('after hls chip', await evalJs(`document.querySelectorAll('.signal').length`));
await evalJs(`document.querySelector('[data-filter="all"]')?.click()`);
await delay(200);

// preview
const hasPreview = await evalJs(`Boolean(document.querySelector('.signal [data-act="preview"]:not([disabled])'))`);
console.log('preview enabled', hasPreview);
if (!hasPreview) {
  // fall back to the first enabled preview anywhere
  console.log('preview buttons', await evalJs(`document.querySelectorAll('[data-act="preview"]').length`));
}
await evalJs(`document.querySelector('.signal [data-act="preview"]:not([disabled])')?.click()`);
await delay(900);
console.log('dialog open', await evalJs(`Boolean(document.querySelector('.preview-dialog[open]'))`),
  '| video src', await evalJs(`document.querySelector('.preview-dialog video')?.currentSrc?.slice(0, 60) || ''`),
  '| readyState', await evalJs(`document.querySelector('.preview-dialog video')?.readyState`));
await evalJs(`document.querySelector('.preview-dialog [data-close], .preview-dialog .dialog-close, .preview-dialog button')?.click()`);
await delay(400);
console.log('dialog closed', await evalJs(`!document.querySelector('.preview-dialog[open]')`));

ws.close();
child.kill();
await delay(400);
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* temp */ }
process.exit(0);

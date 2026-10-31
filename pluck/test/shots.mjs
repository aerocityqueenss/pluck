// UI capture: opens the local app in an isolated Chrome and shoots both views.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const APP = process.env.APP || 'http://127.0.0.1:7777/';
const PAGE = process.env.PAGE || 'https://bitmovin.com/demos/stream-test';
const OUT = path.join(process.cwd(), 'test', 'shots');
const CHROME = 'C:/Program Files/Google/Chrome/Application/chrome.exe';

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pluck-shot-'));
  const child = spawn(CHROME, [
    '--remote-debugging-port=0', '--remote-allow-origins=*', `--user-data-dir=${profile}`,
    '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run',
    '--window-size=1440,1000', '--app=about:blank',
  ], { stdio: ['ignore', 'ignore', 'ignore'], windowsHide: true });

  const portFile = path.join(profile, 'DevToolsActivePort');
  let port = 0;
  for (let i = 0; i < 200; i++) {
    if (fs.existsSync(portFile)) { port = Number(fs.readFileSync(portFile, 'utf8').split('\n')[0]); if (port) break; }
    await delay(100);
  }
  if (!port) throw new Error('no debug port');

  const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const page = list.find((t) => t.type === 'page');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });

  let id = 0;
  const pending = new Map();
  const logs = [];
  ws.addEventListener('message', (ev) => {
    const msg = JSON.parse(ev.data);
    if (msg.id) { const p = pending.get(msg.id); if (p) { pending.delete(msg.id); msg.error ? p.reject(new Error(msg.error.message)) : p.resolve(msg.result); } return; }
    if (msg.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(msg.params.type)) {
      logs.push(`${msg.params.type}: ${msg.params.args.map((a) => a.value ?? a.description ?? a.type).join(' ')}`);
    }
    if (msg.method === 'Runtime.exceptionThrown') {
      logs.push(`exception: ${msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text}`);
    }
    if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error') logs.push(`log: ${msg.params.entry.text} ${msg.params.entry.url || ''}`);
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const mid = ++id;
    pending.set(mid, { resolve, reject });
    ws.send(JSON.stringify({ id: mid, method, params }));
  });

  await send('Page.enable');
  await send('Runtime.enable');
  await send('Log.enable');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  const shoot = async (name, full = false) => {
    const res = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: full, fromSurface: true });
    fs.writeFileSync(path.join(OUT, `${name}.png`), Buffer.from(res.data, 'base64'));
    console.log('shot', name);
  };

  await send('Page.navigate', { url: APP });
  await delay(2200);
  await shoot('landing');

  // measure hero + typography facts
  const metrics = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      scrollH: document.documentElement.scrollHeight,
      heroFont: getComputedStyle(document.querySelector('.hero-title')).fontFamily,
      heroSize: getComputedStyle(document.querySelector('.hero-title')).fontSize,
      bodyBg: getComputedStyle(document.body).backgroundColor,
      overflowX: document.documentElement.scrollWidth > window.innerWidth,
      fontsLoaded: [...document.fonts].map(f => f.family + ':' + f.status).slice(0,6)
    })`, returnByValue: true,
  });
  console.log('metrics', metrics.result.value);

  // full page at its natural height (a taller viewport distorts the capture)
  const fullH = Math.min(Math.round(metrics.result.value ? JSON.parse(metrics.result.value).scrollH : 3000), 4200);
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: fullH, deviceScaleFactor: 1, mobile: false });
  await delay(700);
  await shoot('landing-full');
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false });

  // start a session through the real form
  await send('Runtime.evaluate', { expression: `(() => {
    const input = document.querySelector('#page-url');
    input.focus();
    input.value = ${JSON.stringify(PAGE)};
    input.dispatchEvent(new Event('input', { bubbles: true }));
    document.querySelector('#capture-form').requestSubmit();
  })()` });
  await delay(11000);
  await shoot('session');

  const rects = await send('Runtime.evaluate', {
    expression: `(() => {
      const box = (sel) => { const el = document.querySelector(sel); if (!el) return null;
        const r = el.getBoundingClientRect();
        return [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)]; };
      const cs = (sel, props) => { const el = document.querySelector(sel); if (!el) return null;
        const s = getComputedStyle(el); return props.map((p) => p + '=' + s.getPropertyValue(p)).join(' '); };
      return JSON.stringify({
        monitor: box('.monitor'), toolbar: box('.monitor-chrome'), readout: box('#url-readout'),
        dock: box('.dock'), row: box('.signal'), rowMeta: box('.signal-meta'), rowActions: box('.signal-actions'),
        readoutStyle: cs('#url-readout', ['flex-grow', 'flex-basis', 'max-width', 'text-overflow']),
        rowNameW: (() => { const n = document.querySelector('.signal-name'); return n ? Math.round(n.getBoundingClientRect().width) : 0; })(),
        metaScroll: (() => { const m = document.querySelector('.signal-meta'); return m ? [m.scrollWidth, m.clientWidth] : null; })()
      });
    })()`, returnByValue: true,
  });
  console.log('rects', rects.result.value);

  await send('Runtime.evaluate', { expression: `(() => {
    const take = document.querySelector('.signal [data-act="take"]');
    if (take) take.click();
  })()` });
  await delay(2600);
  await shoot('session-prep');

  await send('Runtime.evaluate', { expression: `(() => {
    const start = document.querySelector('[data-prep="start"]');
    if (start) start.click();
  })()` });
  await delay(7000);
  await send('Runtime.evaluate', { expression: `document.querySelector('#transfers').scrollIntoView({ block: 'end' })` });
  await delay(600);
  await shoot('session-transfers');

  const state = await send('Runtime.evaluate', {
    expression: `JSON.stringify({
      signals: document.querySelectorAll('.signal').length,
      names: [...document.querySelectorAll('.signal-name')].map(e => e.textContent),
      metas: [...document.querySelectorAll('.signal-meta')].map(e => e.textContent.trim()),
      prepOpen: !document.querySelector('#prep').hidden,
      status: document.querySelector('#status-line').textContent,
      timer: document.querySelector('#timer-value').textContent
    })`, returnByValue: true,
  });
  console.log('session state', state.result.value);

  await delay(4000);
  await shoot('session-download');
  const after = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ transfers: document.querySelectorAll('.transfer').length, meta: [...document.querySelectorAll('.transfer-meta')].map(e => e.textContent.trim()) })`,
    returnByValue: true,
  });
  console.log('transfers', after.result.value);

  // wait for the transfer to finish so the done state is captured too
  for (let i = 0; i < 60; i++) {
    const done = await send('Runtime.evaluate', {
      expression: `Boolean(document.querySelector('.transfer.is-done, .transfer.is-error'))`, returnByValue: true,
    });
    if (done.result.value) break;
    await delay(2000);
  }
  const finished = await send('Runtime.evaluate', {
    expression: `JSON.stringify({ done: document.querySelectorAll('.transfer.is-done').length,
      actions: [...document.querySelectorAll('.transfer-actions')].map(e => e.textContent.trim()),
      name: document.querySelector('.transfer-name')?.textContent })`, returnByValue: true,
  });
  console.log('finished', finished.result.value);
  await send('Runtime.evaluate', { expression: `document.querySelector('#transfers').scrollIntoView({ block: 'end' })` });
  await delay(500);
  await shoot('session-done');

  // mobile pass
  await send('Emulation.setDeviceMetricsOverride', { width: 414, height: 900, deviceScaleFactor: 1, mobile: true });
  await delay(900);
  await shoot('session-mobile');
  await delay(200);

  console.log('CONSOLE', logs.slice(0, 12));
  ws.close();
  child.kill();
  await delay(600);
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 8, retryDelay: 250 }); } catch { /* profile stays in temp */ }
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });

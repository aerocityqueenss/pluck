'use strict';
// Isolated Chrome instance + a small Chrome DevTools Protocol client (no npm deps).
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const CANDIDATES = [
  process.env.PLUCK_CHROME,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Google/Chrome/Application/chrome.exe'),
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

function platformName() {
  if (process.platform === 'darwin') return 'MacIntel';
  if (process.platform === 'linux') return 'Linux x86_64';
  return 'Win32';
}

function findChrome() {
  for (const c of CANDIDATES) if (c && fs.existsSync(c)) return c;
  throw new Error('Chrome not found. Set PLUCK_CHROME to your Chrome/Edge executable.');
}

function delay(ms) { return new Promise((r) => setTimeout(r, ms)); }

class Cdp {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    this.ws.addEventListener('message', (ev) => this._onMessage(ev.data));
    this.ws.addEventListener('close', () => { this.closed = true; this._failAll(new Error('CDP socket closed')); });
    this.ws.addEventListener('error', () => { this.closed = true; this._failAll(new Error('CDP socket error')); });
  }

  ready() {
    if (this.ws.readyState === 1) return Promise.resolve();
    return new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('CDP connection failed')), { once: true });
    });
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  _onMessage(raw) {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (msg.id) {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || JSON.stringify(msg.error)));
      else p.resolve(msg.result);
      return;
    }
    const list = this.handlers.get(msg.method);
    if (list) for (const fn of list) { try { fn(msg.params, msg.sessionId); } catch { /* handler error */ } }
    const wild = this.handlers.get('*');
    if (wild) for (const fn of wild) { try { fn(msg); } catch { /* ignore */ } }
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, []);
    this.handlers.get(method).push(fn);
    return () => {
      const l = this.handlers.get(method);
      if (l) { const i = l.indexOf(fn); if (i >= 0) l.splice(i, 1); }
    };
  }

  send(method, params = {}, timeoutMs = 20000) {
    if (this.closed) return Promise.reject(new Error('CDP socket closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP timeout: ${method}`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

class Chrome {
  constructor(opts = {}) {
    this.headless = opts.headless !== false;
    this.width = opts.width || 1280;
    this.height = opts.height || 720;
    this.userAgent = opts.userAgent || null;
    this.profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pluck-profile-'));
    this.port = 0;
    this.child = null;
    this.cdp = null;
    this.targetId = null;
    this.logs = [];
  }

  async launch() {
    const exe = findChrome();
    const args = [
      '--remote-debugging-port=0',
      '--remote-allow-origins=*',
      `--user-data-dir=${this.profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-sync',
      '--disable-background-networking',
      '--disable-background-timer-throttling',
      '--disable-renderer-backgrounding',
      '--disable-backgrounding-occluded-windows',
      '--disable-features=Translate,MediaRouter,OptimizationHints',
      '--autoplay-policy=no-user-gesture-required',
      '--disable-blink-features=AutomationControlled',
      '--mute-audio',
      '--no-default-browser-check',
      '--hide-scrollbars',
      '--disable-pinch',
      '--overscroll-history-navigation=0',
      '--lang=en-US',
      `--window-size=${this.width},${this.height + 90}`,
      '--app=about:blank',
    ];
    if (this.headless) args.push('--headless=new', '--disable-gpu');
    // Small /dev/shm on virtual machines and containers makes the renderer die mid-page.
    if (process.platform === 'linux') args.push('--disable-dev-shm-usage');
    // Only when the host cannot give Chrome a usable sandbox (containers, some VPS images
    // running as root). Off by default: the sandbox is worth keeping.
    if (process.env.PLUCK_NO_SANDBOX === '1') args.push('--no-sandbox', '--disable-setuid-sandbox');
    if (this.userAgent) args.push(`--user-agent=${this.userAgent}`);

    this.child = spawn(exe, args, { stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true });
    this.child.stderr.on('data', (d) => {
      const line = String(d).trim();
      if (line) { this.logs.push(line.slice(0, 300)); if (this.logs.length > 40) this.logs.shift(); }
    });
    this.child.on('exit', () => { this.exited = true; });

    const portFile = path.join(this.profileDir, 'DevToolsActivePort');
    for (let i = 0; i < 200; i++) {
      if (fs.existsSync(portFile)) {
        const txt = fs.readFileSync(portFile, 'utf8').trim().split('\n');
        if (txt[0]) { this.port = Number(txt[0]); break; }
      }
      if (this.exited) throw new Error('Chromium exited during startup');
      await delay(100);
    }
    if (!this.port) throw new Error('Chromium did not expose a debugging port');

    // Find or create the page target.
    let targets = await this._httpJson('/json/list');
    let page = targets.find((t) => t.type === 'page');
    if (!page) {
      await fetch(`http://127.0.0.1:${this.port}/json/new?about:blank`, { method: 'PUT' }).catch(() => {});
      await delay(300);
      targets = await this._httpJson('/json/list');
      page = targets.find((t) => t.type === 'page');
    }
    if (!page) throw new Error('No page target in Chromium');
    this.targetId = page.id;
    this.cdp = new Cdp(page.webSocketDebuggerUrl);
    await this.cdp.ready();

    // Headless Chrome advertises "HeadlessChrome" in its UA, and plenty of sites
    // answer that with a bot challenge instead of the page. Ask Chrome for its own
    // UA string and drop the token, so the version and client hints still line up.
    if (!this.userAgent) {
      const version = await this.cdp.send('Browser.getVersion').catch(() => null);
      const ua = version?.userAgent ? version.userAgent.replace('HeadlessChrome', 'Chrome') : '';
      if (ua) {
        await this.cdp.send('Emulation.setUserAgentOverride', {
          userAgent: ua,
          acceptLanguage: 'en-US,en;q=0.9',
          platform: platformName(),
        }).catch(() => {});
      }
    }
    return this;
  }

  async _httpJson(p) {
    const res = await fetch(`http://127.0.0.1:${this.port}${p}`);
    if (!res.ok) throw new Error(`Chromium HTTP ${res.status} for ${p}`);
    return res.json();
  }

  async cookiesFor(url) {
    try {
      const { cookies } = await this.cdp.send('Network.getCookies', { urls: [url] });
      return cookies.map((c) => `${c.name}=${c.value}`).join('; ');
    } catch { return ''; }
  }

  async close() {
    try { await this.cdp?.send('Browser.close', {}, 3000); } catch { /* ignore */ }
    this.cdp?.close();
    await delay(150);
    try { if (this.child && !this.exited) this.child.kill(); } catch { /* ignore */ }
    for (let i = 0; i < 25; i++) {
      try { fs.rmSync(this.profileDir, { recursive: true, force: true }); return; } catch { await delay(120); }
    }
  }
}

module.exports = { Chrome, Cdp, findChrome, delay };

'use strict';
// A live browser session: screencast out, input in, network sniffing, navigation guard, jobs.
const { Chrome, delay } = require('./browser');
const A = require('./analyze');
const { Job, newId } = require('./download');

const FRAME_MAGIC = 0x56;
const FRAME_VERSION = 1;
const FRAME_HEADER = 8;
const MIN_FRAME_GAP_MS = 55;
const GESTURE_WINDOW_MS = 12000;
const PLACEHOLDER_TITLES = new Set(['', 'new tab', 'about:blank', 'untitled', 'loading…', 'loading']);

const KEYMAP = {
  Enter: ['Enter', 13, 'Enter'], Backspace: ['Backspace', 8, 'Backspace'], Tab: ['Tab', 9, 'Tab'],
  Escape: ['Escape', 27, 'Escape'], Delete: ['Delete', 46, 'Delete'], Home: ['Home', 36, 'Home'],
  End: ['End', 35, 'End'], PageUp: ['PageUp', 33, 'PageUp'], PageDown: ['PageDown', 34, 'PageDown'],
  ArrowUp: ['ArrowUp', 38, 'ArrowUp'], ArrowDown: ['ArrowDown', 40, 'ArrowDown'],
  ArrowLeft: ['ArrowLeft', 37, 'ArrowLeft'], ArrowRight: ['ArrowRight', 39, 'ArrowRight'],
  ' ': [' ', 32, 'Space'], Shift: ['Shift', 16, 'ShiftLeft'], Control: ['Control', 17, 'ControlLeft'],
  Alt: ['Alt', 18, 'AltLeft'], Meta: ['Meta', 91, 'MetaLeft'],
};

function keyPayload(key, type) {
  if (KEYMAP[key]) {
    const [k, vk, code] = KEYMAP[key];
    return { type, key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
  }
  if (typeof key === 'string' && key.length === 1) {
    const upper = key.toUpperCase();
    const vk = upper.charCodeAt(0);
    const isLetter = /[A-Z]/.test(upper);
    const isDigit = /[0-9]/.test(key);
    const code = isLetter ? `Key${upper}` : isDigit ? `Digit${key}` : `Key${upper}`;
    const base = { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk };
    if (type === 'keyDown') base.text = key;
    return base;
  }
  return { type, key: String(key || '').slice(0, 8) };
}

class Session {
  constructor(opts = {}) {
    this.id = opts.id || newId();
    this.startUrl = opts.url || '';
    this.createdAt = Date.now();
    this.ttlSeconds = opts.ttlSeconds || 300;
    this.expiresAt = this.createdAt + this.ttlSeconds * 1000;
    this.onEvent = opts.onEvent || (() => {});
    this.onDestroy = opts.onDestroy || (() => {});
    this.chrome = null;
    this.socket = null;
    this.videos = new Map();
    this.videoOrder = [];
    this.requestMeta = new Map();
    this.lastFrame = null;
    this.lastFrameSentAt = 0;
    this.pendingFrame = null;
    this.frameTimer = null;
    this.popupCount = 0;
    this.disposed = false;
    this.currentUrl = this.startUrl;
    this.pendingNav = null;
    this.navSeq = 0;
    this.lastGestureAt = 0;
    this.jobs = new Map();
    this.ready = false;
    this.lastTitle = '';
    this.probeQueue = [];
    this.probing = false;
    this.pageHost = '';
    this.expiryTimer = null;
  }

  emit(type, data) {
    try { this.onEvent(this, { type, ...data }); } catch { /* ignore */ }
  }

  async start() {
    this.chrome = new Chrome({ headless: process.env.PLUCK_HEADFUL !== '1' });
    await this.chrome.launch();
    const cdp = this.chrome.cdp;
    this.cdp = cdp;

    cdp.on('Page.screencastFrame', (p) => this._onScreencastFrame(p));
    cdp.on('Network.requestWillBeSent', (p) => this._onRequest(p));
    cdp.on('Network.responseReceived', (p) => this._onResponse(p));
    cdp.on('Page.frameNavigated', (p) => {
      if (p.frame && !p.frame.parentId) { this.currentUrl = p.frame.url; this.emit('pageInfo', { url: p.frame.url, title: this.lastTitle }); }
    });
    cdp.on('Page.loadEventFired', () => { this._refreshPageInfo(); this._scanDom(); });
    cdp.on('Runtime.consoleAPICalled', () => {});
    cdp.on('Target.targetCreated', (p) => this._onTargetCreated(p));
    cdp.on('Fetch.requestPaused', (p) => this._onFetchPaused(p).catch(() => {}));

    await cdp.send('Page.enable');
    await cdp.send('Network.enable', { maxTotalBufferSize: 20 * 1024 * 1024, maxResourceBufferSize: 4 * 1024 * 1024, maxPostDataSize: 65536 });
    await cdp.send('Runtime.enable');
    await cdp.send('Target.setDiscoverTargets', { discover: true }).catch(() => {});
    await cdp.send('Emulation.setDeviceMetricsOverride', {
      width: 1280, height: 720, deviceScaleFactor: 1, mobile: false,
    }).catch(() => {});
    await this._startGuardedNavigation();
    await this.cdp.send('Page.startScreencast', {
      format: 'jpeg', quality: 62, maxWidth: 1280, maxHeight: 720, everyNthFrame: 1,
    }).catch(() => {});
    await this.navigate(this.startUrl);
    this.ready = true;
    this.emit('ready', {
      session: {
        id: this.id, url: this.startUrl, host: A.hostOf(this.startUrl),
        expiresAt: this.expiresAt, ttlSeconds: this.ttlSeconds, width: 1280, height: 720,
      },
    });
    this._startExpiry();
    this._domScanTimer = setInterval(() => this._scanDom().catch(() => {}), 3000);
  }

  async _startGuardedNavigation() {
    try {
      const tree = await this.cdp.send('Page.getFrameTree').catch(() => null);
      this.mainFrameId = tree?.frameTree?.frame?.id || null;
      await this.cdp.send('Fetch.enable', {
        patterns: [{ urlPattern: '*', resourceType: 'Document', requestStage: 'Request' }],
      });
      this.guarded = true;
    } catch { this.guarded = false; }
  }

  _startExpiry() {
    this.expiryTimer = setInterval(() => {
      if (this.disposed) return;
      const left = Math.max(0, Math.round((this.expiresAt - Date.now()) / 1000));
      this.emit('session', { secondsLeft: left, expiresAt: this.expiresAt });
      if (left <= 0) { this.emit('expired', { reason: 'expired' }); this.dispose('expired'); }
    }, 1000);
  }

  async navigate(url) {
    let target = String(url || '').trim();
    if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
    try {
      const u = new URL(target);
      if (!/^https?:$/.test(u.protocol)) throw new Error('bad protocol');
      this.currentUrl = u.toString();
      this.pageHost = u.hostname;
    } catch {
      this.emit('error', { message: 'That does not look like a web address.' });
      return;
    }
    try {
      await this.cdp.send('Page.navigate', { url: this.currentUrl }, 30000);
      this.emit('navigating', { url: this.currentUrl });
    } catch (err) {
      this.emit('error', { message: `Could not open that page: ${err.message}` });
    }
  }

  async _refreshPageInfo() {
    try {
      const { result } = await this.cdp.send('Runtime.evaluate', {
        expression: `JSON.stringify({t: document.title || '', u: location.href})`,
        returnByValue: true,
      });
      const info = JSON.parse(result.value || '{}');
      const next = String(info.t || '').trim();
      if (info.u) this.currentUrl = info.u;
      if (next) this.lastTitle = next;
      if (next) this._retitlePlaceholders(next);
      this.emit('pageInfo', { title: this.lastTitle, url: this.currentUrl });
    } catch { /* page busy */ }
  }

  // Streams caught during navigation keep the blank-tab title; give them the real one.
  _retitlePlaceholders(title) {
    for (const video of this.videos.values()) {
      if (video.title && !PLACEHOLDER_TITLES.has(video.title.toLowerCase())) continue;
      video.title = title;
      this.emit('videoUpdate', { video });
    }
  }

  /* ------------------------------ screencast ----------------------------- */

  _onScreencastFrame(params) {
    this.cdp.send('Page.screencastFrameAck', { sessionId: params.sessionId }).catch(() => {});
    const meta = params.metadata || {};
    const width = Math.round(meta.deviceWidth || 1280);
    const height = Math.round(meta.deviceHeight || 720);
    const jpeg = Buffer.from(params.data, 'base64');
    this.lastFrame = { jpeg, width, height };
    this._pumpFrame();
  }

  _pumpFrame() {
    if (this.disposed || !this.socket || !this.lastFrame) return;
    const now = Date.now();
    const wait = MIN_FRAME_GAP_MS - (now - this.lastFrameSentAt);
    if (wait > 0) {
      if (!this.frameTimer) {
        this.frameTimer = setTimeout(() => { this.frameTimer = null; this._pumpFrame(); }, wait);
      }
      return;
    }
    const { jpeg, width, height } = this.lastFrame;
    const header = Buffer.alloc(FRAME_HEADER);
    header.writeUInt8(FRAME_MAGIC, 0);
    header.writeUInt8(FRAME_VERSION, 1);
    header.writeUInt16LE(width, 2);
    header.writeUInt16LE(height, 4);
    header.writeUInt16LE(0, 6);
    this.lastFrameSentAt = now;
    this.socket?.send(Buffer.concat([header, jpeg]));
  }

  /* ------------------------------ detection ------------------------------ */

  _onRequest(params) {
    const h = params.request.headers || {};
    this.requestMeta.set(params.requestId, {
      url: params.request.url,
      resourceType: params.type,
      headers: {
        referer: h.Referer || h.referer || '',
        origin: h.Origin || h.origin || '',
        cookie: h.Cookie || h.cookie || '',
        accept: h.Accept || h.accept || '',
        'accept-language': h['Accept-Language'] || h['accept-language'] || '',
      },
    });
    if (this.requestMeta.size > 600) {
      const first = this.requestMeta.keys().next().value;
      this.requestMeta.delete(first);
    }
  }

  _onResponse(params) {
    const meta = this.requestMeta.get(params.requestId);
    const url = params.response.url;
    const mime = params.response.mimeType || (params.response.headers['content-type'] || '');
    const resType = params.type || meta?.resourceType;
    const kind = A.classify({ url, mime, resourceType: resType });
    if (!kind) return;
    if (params.response.status >= 400) return;

    const size = A.sizeFromHeaders(params.response.headers);
    const existing = this.videos.get(url);
    if (existing) {
      let changed = false;
      if (!existing.estimate_size && size) { existing.estimate_size = size; changed = true; }
      if (changed) this.emit('videoUpdate', { video: existing });
      return;
    }

    const headers = params.response.headers || {};
    const video = {
      id: newId().slice(0, 9),
      url,
      ext: kind.ext,
      kind: kind.kind,
      title: this.lastTitle || '',
      website: this.currentUrl,
      domain: A.hostOf(this.currentUrl) || A.hostOf(url),
      contentType: params.response.headers['content-type'] || mime,
      requestHeaders: meta?.headers || {},
      responseHeaders: subsetHeaders(headers),
      estimate_size: size,
      quality: '',
      width: 0,
      height: 0,
      duration: 0,
      thumbnail: this.lastFrameThumbnail(),
      detectedAt: Date.now(),
      detectedAfterUserClick: Date.now() - this.lastGestureAt < GESTURE_WINDOW_MS,
      verifiedPlaylist: false,
      encrypted: false,
      status: 'new',
    };
    video.highlight = false;
    this.videos.set(url, video);
    this.videoOrder.push(url);
    this.emit('video', { video: { ...video } });
    this._queueProbe(video);
  }

  lastFrameThumbnail() {
    if (!this.lastFrame) return '';
    return `data:image/jpeg;base64,${this.lastFrame.jpeg.toString('base64')}`;
  }

  _queueProbe(video) {
    if (video.kind === 'segment') return;
    this.probeQueue.push(video);
    if (!this.probing) this._drainProbes();
  }

  async _drainProbes() {
    this.probing = true;
    while (this.probeQueue.length && !this.disposed) {
      const video = this.probeQueue.shift();
      try {
        const headers = video.requestHeaders || {};
        let info = {};
        if (video.kind === 'hls') info = await A.probeHls(video.url, headers, { signal: AbortSignal.timeout(15000) });
        else if (video.kind === 'dash') info = await A.probeDash(video.url, headers, { signal: AbortSignal.timeout(15000) });
        else info = await A.probeMp4(video.url, headers, { signal: AbortSignal.timeout(15000) });
        if (this.disposed) break;
        if (info.height) { video.height = info.height; video.width = info.width || 0; }
        if (!video.quality && (info.quality || info.height)) video.quality = info.quality || A.qualityLabel(info.width, info.height);
        if (info.duration && !video.duration) video.duration = info.duration;
        if (info.estimate_size && (!video.estimate_size || info.estimate_size > video.estimate_size)) {
          video.estimate_size = info.estimate_size;
        }
        if (info.verifiedPlaylist) video.verifiedPlaylist = true;
        if (info.encrypted) video.encrypted = true;
        if (info.audioOnly) video.audioOnly = true;
        if (Array.isArray(info.variants) && info.variants.length) video.variants = info.variants;
        video.status = 'ready';
        this.emit('videoUpdate', { video: { ...video } });
      } catch {
        video.status = 'ready';
        this.emit('videoUpdate', { video: { ...video } });
      }
    }
    this.probing = false;
  }

  async _scanDom() {
    if (!this.ready || this.disposed) return;
    let found = [];
    try {
      const { result } = await this.cdp.send('Runtime.evaluate', {
        expression: `(function(){
          const out = [];
          const push = (u, w, h, d) => { if (u && /^https?:/i.test(u)) out.push({u, w: w||0, h: h||0, d: d||0}); };
          for (const v of document.querySelectorAll('video')) {
            push(v.currentSrc || v.src, v.videoWidth, v.videoHeight, v.duration);
            for (const s of v.querySelectorAll('source')) push(s.src, v.videoWidth, v.videoHeight, v.duration);
          }
          for (const s of document.querySelectorAll('source[src]')) {
            const v = s.closest('video');
            push(s.src, v ? v.videoWidth : 0, v ? v.videoHeight : 0, v ? v.duration : 0);
          }
          for (const a of document.querySelectorAll('a[href]')) {
            if (/\\.(mp4|webm|m3u8|mpd|mov|m4v)(\\?|$)/i.test(a.href)) push(a.href, 0, 0, 0);
          }
          if (performance && performance.getEntriesByType) {
            for (const e of performance.getEntriesByType('resource')) {
              if (/\\.(mp4|webm|m3u8|mpd|ts|m4s)(\\?|$)/i.test(e.name)) push(e.name, 0, 0, 0);
            }
          }
          return JSON.stringify(out.slice(0, 120));
        })()`,
        returnByValue: true,
      }, 8000);
      found = JSON.parse(result.value || '[]');
    } catch { return; }

    for (const item of found) {
      const url = item.u;
      if (this.videos.has(url)) {
        const v = this.videos.get(url);
        let changed = false;
        if (item.d > 0 && !v.duration) { v.duration = Math.round(item.d * 1000) / 1000; changed = true; }
        if (item.h > 0 && !v.height) { v.height = item.h; v.width = item.w; v.quality = v.quality || A.qualityLabel(item.w, item.h); changed = true; }
        if (changed) this.emit('videoUpdate', { video: { ...v } });
        continue;
      }
      const kind = A.classify({ url, mime: '', resourceType: '' });
      if (!kind) continue;
      const video = {
        id: newId().slice(0, 9),
        url,
        ext: kind.ext,
        kind: kind.kind,
        title: this.lastTitle || '',
        website: this.currentUrl,
        domain: A.hostOf(this.currentUrl) || A.hostOf(url),
        contentType: '',
        requestHeaders: {},
        responseHeaders: {},
        estimate_size: 0,
        quality: item.h ? A.qualityLabel(item.w, item.h) : '',
        width: item.w || 0,
        height: item.h || 0,
        duration: item.d ? Math.round(item.d * 1000) / 1000 : 0,
        thumbnail: this.lastFrameThumbnail(),
        detectedAt: Date.now(),
        detectedAfterUserClick: false,
        verifiedPlaylist: false,
        encrypted: false,
        status: 'new',
      };
      this.videos.set(url, video);
      this.videoOrder.push(url);
      this.emit('video', { video: { ...video } });
      this._queueProbe(video);
    }
  }

  /* ---------------------------- navigation guard -------------------------- */

  _onTargetCreated(params) {
    const t = params.targetInfo || {};
    if (t.type !== 'page') return;
    if (t.targetId === this.chrome?.targetId) return;
    if (t.openerId) {
      this.popupCount += 1;
      this.cdp.send('Target.closeTarget', { targetId: t.targetId }).catch(() => {});
      this.emit('popupBlocked', { count: this.popupCount });
    }
  }

  async _onFetchPaused(params) {
    const isDocument = params.resourceType === 'Document';
    const isMainFrame = !params.frameId || !this.mainFrameId || params.frameId === this.mainFrameId;
    if (!isDocument || !isMainFrame || !this.guarded) {
      await this.cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }
    let host = '';
    try { host = new URL(params.request.url).hostname; } catch { /* keep empty */ }

    const pageHost = this.pageHost || A.hostOf(this.currentUrl);
    const sameSite = !host || !pageHost || host === pageHost || host.endsWith(`.${pageHost}`) || pageHost.endsWith(`.${host}`);
    if (sameSite) {
      await this.cdp.send('Fetch.continueRequest', { requestId: params.requestId }).catch(() => {});
      return;
    }

    const gestureRecent = Date.now() - this.lastGestureAt < GESTURE_WINDOW_MS;
    if (!gestureRecent) {
      // Unsolicited cross-site jump (usually an ad overlay). The document never loads,
      // so the current page stays exactly as it is.
      await this.cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }).catch(() => {});
      this.emit('navigationBlocked', { hostname: host, restoredUrl: this.currentUrl });
      return;
    }

    // A real click asked for this: hold it until the visitor decides.
    const existing = this.pendingNav;
    if (existing) {
      if (existing.hostname === host) {
        await this.cdp.send('Fetch.failRequest', { requestId: params.requestId, errorReason: 'Aborted' }).catch(() => {});
        return;
      }
      await this.cdp.send('Fetch.failRequest', { requestId: existing.requestId, errorReason: 'Aborted' }).catch(() => {});
      this.pendingNav = null;
    }
    this.navSeq += 1;
    const id = `nav${this.navSeq}`;
    this.pendingNav = { id, requestId: params.requestId, hostname: host, url: params.request.url };
    this.emit('navigationApprovalRequired', { id, hostname: host, url: params.request.url });
    const pending = this.pendingNav;
    setTimeout(() => {
      if (this.pendingNav && this.pendingNav.id === id) {
        this.cdp.send('Fetch.failRequest', { requestId: pending.requestId, errorReason: 'Aborted' }).catch(() => {});
        this.pendingNav = null;
        this.emit('navigationApprovalResolved', { id, allowed: false, reason: 'timeout' });
      }
    }, 30000);
  }

  async decideNavigation(id, allow) {
    const pending = this.pendingNav;
    if (!pending || pending.id !== id) return;
    this.pendingNav = null;
    if (allow) {
      this.pageHost = pending.hostname;
      this.currentUrl = pending.url;
      this.lastGestureAt = 0;
      await this.cdp.send('Fetch.continueRequest', { requestId: pending.requestId }).catch(() => {});
      this.emit('navigationApprovalResolved', { id, allowed: true });
    } else {
      await this.cdp.send('Fetch.failRequest', { requestId: pending.requestId, errorReason: 'Aborted' }).catch(() => {});
      this.emit('navigationApprovalResolved', { id, allowed: false, reason: 'denied' });
    }
  }

  /* -------------------------------- input -------------------------------- */

  async input(msg) {
    if (!this.cdp || this.disposed) return;
    const type = msg.type;
    const x = Math.round(Number(msg.x) || 0);
    const y = Math.round(Number(msg.y) || 0);
    if (type === 'mousemove' || type === 'mousedown' || type === 'mouseup') this.lastGestureAt = Date.now();
    if (type === 'keydown') this.lastGestureAt = Date.now();
    try {
      switch (type) {
        case 'mousemove':
          await this.cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none', buttons: 0 });
          return;
        case 'mousedown':
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mousePressed', x, y, button: msg.button || 'left', buttons: buttonMask(msg.button), clickCount: 1,
          });
          return;
        case 'mouseup':
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseReleased', x, y, button: msg.button || 'left', buttons: 0, clickCount: 1,
          });
          return;
        case 'wheel':
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: x || 640, y: y || 360,
            deltaX: Number(msg.deltaX) || 0, deltaY: Number(msg.deltaY) || 0,
          });
          return;
        case 'keydown':
          await this.cdp.send('Input.dispatchKeyEvent', keyPayload(msg.key, 'keyDown'));
          return;
        case 'keyup':
          await this.cdp.send('Input.dispatchKeyEvent', keyPayload(msg.key, 'keyUp'));
          return;
        case 'text':
          await this.cdp.send('Input.insertText', { text: String(msg.text || '') });
          return;
        case 'back':
          await this.cdp.send('Runtime.evaluate', { expression: 'history.back()' });
          return;
        case 'forward':
          await this.cdp.send('Runtime.evaluate', { expression: 'history.forward()' });
          return;
        case 'reload':
          await this.cdp.send('Page.reload', {});
          return;
        case 'scroll':
          await this.cdp.send('Input.dispatchMouseEvent', {
            type: 'mouseWheel', x: 640, y: 360, deltaX: 0, deltaY: Number(msg.deltaY) || 0,
          });
          return;
        default:
          return;
      }
    } catch { /* input during navigation */ }
  }

  /* -------------------------------- jobs --------------------------------- */

  getVideo(videoId) {
    for (const v of this.videos.values()) if (v.id === videoId) return v;
    return null;
  }

  async prepare(videoId) {
    const video = this.getVideo(videoId);
    if (!video) throw new Error('That stream is not part of this session any more.');
    if (video.kind === 'hls') {
      const headers = await this._downloadHeaders(video);
      const parsed = await A.probeHls(video.url, headers, { signal: AbortSignal.timeout(15000) });
      return { kind: 'hls', variants: parsed.variants || [], duration: parsed.duration || video.duration, encrypted: Boolean(parsed.encrypted) };
    }
    if (video.kind === 'dash') {
      const headers = await this._downloadHeaders(video);
      const parsed = await A.probeDash(video.url, headers, { signal: AbortSignal.timeout(15000) });
      return { kind: 'dash', variants: parsed.variants || [], duration: parsed.duration || video.duration, encrypted: false };
    }
    return { kind: 'progressive', variants: [], duration: video.duration, encrypted: false };
  }

  async _downloadHeaders(video) {
    const headers = { ...(video.requestHeaders || {}) };
    try {
      const cookie = await this.chrome.cookiesFor(video.url);
      if (cookie) headers.cookie = cookie;
    } catch { /* no cookies */ }
    if (!headers.referer && video.website) headers.referer = video.website;
    return headers;
  }

  async createJob(videoId, opts = {}) {
    const video = this.getVideo(videoId);
    if (!video) throw new Error('That stream is not part of this session any more.');
    const headers = await this._downloadHeaders(video);
    const kind = video.kind === 'segment' ? 'progressive' : video.kind;
    const variantUrl = opts.variantUrl || '';
    const variant = variantUrl ? (video.variants || []).find((v) => v.url === variantUrl) : null;
    const job = new Job({
      sessionId: this.id,
      videoId: video.id,
      kind,
      url: video.url,
      variantUrl,
      headers,
      filename: opts.filename || defaultFilename(video, this.lastTitle, variant),
      threads: opts.threads,
      chunkMB: opts.chunkMB,
      sendHeaders: opts.sendHeaders !== false,
      onUpdate: (j) => this.emit('job', { job: j.snapshot() }),
    });
    this.jobs.set(job.id, job);
    job.run();
    this.emit('job', { job: job.snapshot() });
    return job;
  }

  /* -------------------------------- socket -------------------------------- */

  attach(ws) {
    this.socket = ws;
    ws.sendJSON({
      type: 'session',
      session: {
        id: this.id, url: this.currentUrl, host: A.hostOf(this.currentUrl) || A.hostOf(this.startUrl),
        expiresAt: this.expiresAt, secondsLeft: Math.max(0, Math.round((this.expiresAt - Date.now()) / 1000)),
        width: 1280, height: 720, popupCount: this.popupCount,
      },
      videos: this.videoOrder.map((u) => ({ ...this.videos.get(u) })),
      jobs: [...this.jobs.values()].map((j) => j.snapshot()),
    });
    this._pumpFrame();
  }

  detach() {
    this.socket = null;
  }

  async dispose(reason = 'closed') {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.expiryTimer);
    clearInterval(this._domScanTimer);
    if (this.frameTimer) clearTimeout(this.frameTimer);
    for (const job of this.jobs.values()) if (job.status === 'running' || job.status === 'queued') job.cancel();
    try { this.socket?.sendJSON({ type: 'closed', reason }); } catch { /* ignore */ }
    try { await this.chrome?.close(); } catch { /* ignore */ }
    this.emit('disposed', { reason });
    try { this.onDestroy(this); } catch { /* ignore */ }
  }
}

function buttonMask(button) {
  if (button === 'right') return 2;
  if (button === 'middle') return 4;
  return 1;
}

function subsetHeaders(h) {
  const keep = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified', 'content-disposition'];
  const out = {};
  for (const k of keep) if (h[k]) out[k] = h[k];
  return out;
}

function slugify(input) {
  const cleaned = String(input || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/['\u2019"]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (cleaned || 'video').slice(0, 90).replace(/-+$/, '') || 'video';
}

const GENERIC = new Set(['download', 'file', 'index', 'index.php', 'remote_control', 'remote_control.php', 'stream', 'video', 'playlist', 'master', 'index.m3u8']);

// A page title carries the human name of the thing; the site name after a separator does not.
function cleanTitle(title) {
  const first = String(title || '').split(/\s+[|\u2013\u2014\-·:]\s+|\s+[|\u2013\u2014·]\s*/)[0].trim();
  return first.replace(/\s+/g, ' ');
}

function looksHashed(name) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}/i.test(name) || /^[0-9a-f]{16,}$/i.test(name) || name.length > 70;
}

function defaultFilename(video, pageTitle, variant) {
  const host = A.hostOf(video.website) || A.hostOf(video.url) || 'video';
  const own = String(video.title || '').trim();
  const title = cleanTitle(!own || PLACEHOLDER_TITLES.has(own.toLowerCase()) ? pageTitle : own);
  let base = '';

  if (title && title.length >= 3 && !GENERIC.has(title.toLowerCase())) base = title;

  if (!base) {
    try {
      const p = new URL(video.url).pathname.split('/').filter(Boolean).pop() || '';
      const decoded = decodeURIComponent(p).replace(/\.[a-z0-9]{2,5}$/i, '');
      if (decoded && !GENERIC.has(decoded.toLowerCase()) && !looksHashed(decoded)) base = decoded;
    } catch { /* ignore */ }
  }
  if (!base && video.quality) base = video.quality;
  if (!base) base = 'stream';

  // Two rows of the same title must not collide in the downloads folder, and the tag has to
  // name the rendition that was actually fetched, not the best one the playlist offered.
  const picked = variant && variant.name ? variant.name : video.quality;
  let name = slugify(base);
  const tag = video.audioOnly ? 'audio' : (/^\d{3,4}p$/.test(picked || '') ? picked : '');
  if (tag && !name.includes(tag)) name = `${name}-${tag}`;
  return `[${host}] ${name}.mp4`;
}

module.exports = { Session, defaultFilename, slugify, delay };

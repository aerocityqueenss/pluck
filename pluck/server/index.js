'use strict';
const http = require('node:http');
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');
const { URL } = require('node:url');
const ws = require('./ws');
const auth = require('./auth');
const { Session } = require('./session');
const { getFfmpeg } = require('./download');
const { findChrome } = require('./browser');

const PORT = Number(process.env.PORT || process.env.PLUCK_PORT || 7777);
const HOST = process.env.HOST || '127.0.0.1';
const PUBLIC = path.join(__dirname, '..', 'public');
const SESSION_SECONDS = Number(process.env.PLUCK_SESSION_SECONDS || 300);
const MAX_SESSIONS = Number(process.env.PLUCK_MAX_SESSIONS || 3);
const NEEDS_PASSWORD = auth.init(process.env.PLUCK_PASSWORD);

const sessions = new Map();
const jobs = new Map();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.txt': 'text/plain; charset=utf-8',
  '.webmanifest': 'application/manifest+json',
};

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    'cache-control': 'no-store',
  });
  res.end(payload);
}

async function readJson(req, limit = 1024 * 256) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new Error('Request body too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new Error('Invalid JSON body'); }
}

function broadcast(session, event) {
  if (!session.socket) return;
  try { session.socket.sendJSON(event); } catch { /* ignore */ }
}

function publicVideo(video) {
  // Thumbnails are large; strip them from every update except the first sighting.
  const copy = { ...video };
  return copy;
}

async function createSession(url, ttlSeconds) {
  if (sessions.size >= MAX_SESSIONS) {
    const oldest = [...sessions.values()].sort((a, b) => a.createdAt - b.createdAt)[0];
    if (oldest) await oldest.dispose('replaced');
  }
  const session = new Session({
    url,
    ttlSeconds: ttlSeconds || SESSION_SECONDS,
    onEvent: (s, event) => {
      if (event.type === 'video' || event.type === 'videoUpdate') {
        broadcast(s, { type: event.type, video: publicVideo(event.video) });
        return;
      }
      broadcast(s, event);
    },
    onDestroy: (s) => { sessions.delete(s.id); },
  });
  sessions.set(session.id, session);
  await session.start();
  return session;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const p = url.pathname;

  if (!auth.check(req)) return auth.challenge(res);
  auth.grant(req, res);

  try {
    if (p === '/api/health' && req.method === 'GET') {
      let chrome = null;
      try { chrome = path.basename(findChrome()); } catch { chrome = null; }
      return json(res, 200, {
        ok: true,
        chrome,
        ffmpeg: getFfmpeg(),
        sessions: sessions.size,
        sessionSeconds: SESSION_SECONDS,
        version: '1.0.0',
      });
    }

    if (p === '/api/session' && req.method === 'POST') {
      const body = await readJson(req);
      const target = String(body.url || '').trim();
      if (!target) return json(res, 400, { error: 'Paste a page URL first.' });
      let normalised = target;
      if (!/^https?:\/\//i.test(normalised)) normalised = `https://${normalised}`;
      try {
        const u = new URL(normalised);
        if (!/^https?:$/.test(u.protocol)) throw new Error('bad');
      } catch {
        return json(res, 400, { error: 'That does not look like a web address.' });
      }
      const session = await createSession(normalised, Number(body.ttlSeconds) || 0);
      return json(res, 200, { session: { id: session.id, expiresAt: session.expiresAt, ttlSeconds: session.ttlSeconds } });
    }

    const sessionMatch = /^\/api\/session\/([A-Za-z0-9_-]+)(\/[a-z]+)?$/.exec(p);
    if (sessionMatch) {
      const session = sessions.get(sessionMatch[1]);
      if (!session) return json(res, 404, { error: 'That session has ended.' });
      const action = sessionMatch[2] || '';

      if (!action && req.method === 'DELETE') {
        await session.dispose('user');
        return json(res, 200, { ok: true });
      }
      if (action === '/prepare' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const info = await session.prepare(String(body.videoId || ''));
          return json(res, 200, info);
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (action === '/job' && req.method === 'POST') {
        const body = await readJson(req);
        try {
          const job = await session.createJob(String(body.videoId || ''), body.options || {});
          jobs.set(job.id, job);
          return json(res, 200, { job: job.snapshot() });
        } catch (err) {
          return json(res, 400, { error: err.message });
        }
      }
      if (action === '/navigate' && req.method === 'POST') {
        const body = await readJson(req);
        await session.navigate(String(body.url || ''));
        return json(res, 200, { ok: true });
      }
      return json(res, 405, { error: 'Method not allowed' });
    }

    const previewMatch = /^\/api\/session\/([A-Za-z0-9_-]+)\/preview\/([A-Za-z0-9_-]+)$/.exec(p);
    if (previewMatch) {
      const session = sessions.get(previewMatch[1]);
      if (!session) return json(res, 404, { error: 'That session has ended.' });
      const video = session.getVideo(previewMatch[2]);
      if (!video) return json(res, 404, { error: 'That stream is gone.' });
      const headers = await session._downloadHeaders(video);
      const upstream = await fetch(video.url, {
        headers: { ...headers, ...(req.headers.range ? { range: req.headers.range } : {}) },
        redirect: 'follow',
      }).catch(() => null);
      if (!upstream) return json(res, 502, { error: 'The source did not answer.' });
      const out = {
        'content-type': upstream.headers.get('content-type') || 'video/mp4',
        'accept-ranges': upstream.headers.get('accept-ranges') || 'bytes',
        'cache-control': 'no-store',
      };
      for (const h of ['content-length', 'content-range']) {
        const v = upstream.headers.get(h);
        if (v) out[h] = v;
      }
      res.writeHead(upstream.status, out);
      if (!upstream.body) { res.end(); return undefined; }
      for await (const chunk of upstream.body) {
        if (!res.write(chunk)) await new Promise((r) => res.once('drain', r));
      }
      res.end();
      return undefined;
    }

    const jobMatch = /^\/api\/job\/([A-Za-z0-9_-]+)(\/cancel|\/file|\/probe)?$/.exec(p);
    if (jobMatch) {
      const job = jobs.get(jobMatch[1]);
      if (!job) return json(res, 404, { error: 'That download is gone.' });
      const action = jobMatch[2] || '';
      if (action === '/cancel' && req.method === 'POST') {
        job.cancel();
        return json(res, 200, { job: job.snapshot() });
      }
      if (action === '/file' && req.method === 'GET') {
        if (job.status !== 'done' || !job.outPath) return json(res, 409, { error: 'This download is not ready yet.' });
        const stat = await fsp.stat(job.outPath);
        const name = job.outName || 'video.mp4';
        const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
        res.writeHead(200, {
          'content-type': job.mime || 'application/octet-stream',
          'content-length': stat.size,
          'accept-ranges': 'bytes',
          'content-disposition': `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`,
          'cache-control': 'no-store',
        });
        fs.createReadStream(job.outPath).pipe(res);
        return undefined;
      }
      return json(res, 200, { job: job.snapshot() });
    }

    // Static files
    let filePath = p === '/' ? '/index.html' : p;
    filePath = decodeURIComponent(filePath);
    const resolved = path.join(PUBLIC, path.normalize(filePath).replace(/^([/\\])+/, ''));
    if (!resolved.startsWith(PUBLIC)) return json(res, 403, { error: 'Forbidden' });
    try {
      const stat = await fsp.stat(resolved);
      if (stat.isDirectory()) return json(res, 404, { error: 'Not found' });
      const ext = path.extname(resolved).toLowerCase();
      res.writeHead(200, {
        'content-type': MIME[ext] || 'application/octet-stream',
        'content-length': stat.size,
        'cache-control': ext === '.html' ? 'no-store' : 'public, max-age=3600',
      });
      fs.createReadStream(resolved).pipe(res);
      return undefined;
    } catch {
      // SPA fallback
      const html = path.join(PUBLIC, 'index.html');
      const data = await fsp.readFile(html);
      res.writeHead(200, { 'content-type': MIME['.html'], 'content-length': data.length });
      res.end(data);
      return undefined;
    }
  } catch (err) {
    return json(res, 500, { error: err.message || 'Server error' });
  }
});

ws.attach(server, (socket, req) => {
  const params = new URL(req.url, 'http://localhost').searchParams;  const id = params.get('session');
  const session = id ? sessions.get(id) : null;
  if (!session) {
    socket.sendJSON({ type: 'error', message: 'That session has ended.' });
    socket.close(1008, 'no session');
    return;
  }
  session.attach(socket);
  socket.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return; }
    if (!msg || typeof msg !== 'object') return;
    switch (msg.type) {
      case 'mousemove':
      case 'mousedown':
      case 'mouseup':
      case 'wheel':
      case 'keydown':
      case 'keyup':
      case 'text':
      case 'back':
      case 'forward':
      case 'reload':
      case 'scroll':
        session.input(msg).catch(() => {});
        break;
      case 'input':
        if (msg.input && typeof msg.input === 'object') session.input(msg.input).catch(() => {});
        break;
      case 'navigate':
        session.navigate(msg.url).catch(() => {});
        break;
      case 'navigationDecision':
        session.decideNavigation(msg.id, Boolean(msg.allow)).catch(() => {});
        break;
      case 'close':
        session.dispose('user');
        break;
      default:
        break;
    }
  });
  socket.on('close', () => { if (session.socket === socket) session.detach(); });
}, '/ws', {
  authorize: (req) => auth.check(req),
  reject: (socket) => auth.rejectUpgrade(socket),
});

const heartbeat = setInterval(() => {
  for (const s of sessions.values()) {
    try { s.socket?.ping(); } catch { /* ignore */ }
  }
}, 25000);

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE' && !server.__retried) {
    server.__retried = true;
    const next = PORT + 1;
    process.stdout.write(`\n  Port ${PORT} is busy, trying ${next}…\n`);
    server.listen(next, HOST, () => announce(next));
    return;
  }
  throw err;
});

function announce(port) {
  const banner = [
    '',
    '  PLUCK · local stream extractor',
    `  http://${HOST}:${port}`,
    `  Chrome: ${(() => { try { return findChrome(); } catch (e) { return `missing (${e.message})`; } })()}`,
    `  ffmpeg: ${getFfmpeg() || 'not found — HLS output will stay .ts'}`,
    NEEDS_PASSWORD ? '  Access: password required (PLUCK_PASSWORD)' : '  Access: open, anyone who reaches this port is you',
    '',
  ].join('\n');
  process.stdout.write(`${banner}\n`);
}

server.listen(PORT, HOST, () => announce(PORT));

async function shutdown() {
  clearInterval(heartbeat);
  for (const s of sessions.values()) await s.dispose('shutdown').catch(() => {});
  for (const j of jobs.values()) j.destroy();
  server.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

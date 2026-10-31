'use strict';
// Download jobs: parallel ranged progressive fetch, HLS (TS + fMP4) and DASH, remuxed with ffmpeg.
const fs = require('node:fs');
const fsp = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');
const A = require('./analyze');

const CHUNK_MB_DEFAULT = 20;
const THREADS_DEFAULT = 4;
const SEGMENT_CONCURRENCY = 6;

let ffmpegPath = null;
let ffmpegChecked = false;
function getFfmpeg() {
  if (ffmpegChecked) return ffmpegPath;
  ffmpegChecked = true;
  const candidates = [process.env.PLUCK_FFMPEG, 'ffmpeg'];
  for (const c of candidates) {
    if (!c) continue;
    try {
      const r = spawnSync(c, ['-version'], { stdio: 'ignore', windowsHide: true, timeout: 8000 });
      if (r.status === 0) { ffmpegPath = c; break; }
    } catch { /* keep looking */ }
  }
  return ffmpegPath;
}

function newId() { return crypto.randomBytes(9).toString('base64url'); }

async function pool(items, limit, worker, signal) {
  let index = 0;
  const runners = new Array(Math.min(limit, items.length)).fill(0).map(async () => {
    while (true) {
      if (signal?.aborted) return;
      const i = index++;
      if (i >= items.length) return;
      await worker(items[i], i);
    }
  });
  await Promise.all(runners);
}

class Job {
  constructor(opts) {
    this.id = opts.id || newId();
    this.sessionId = opts.sessionId || null;
    this.videoId = opts.videoId || '';
    this.kind = opts.kind; // 'progressive' | 'hls' | 'dash'
    this.url = opts.url;
    this.variantUrl = opts.variantUrl || '';
    this.headers = opts.headers || {};
    this.filename = opts.filename || 'video.mp4';
    this.threads = Math.max(1, Math.min(16, Number(opts.threads) || THREADS_DEFAULT));
    this.chunkMB = Math.max(1, Math.min(64, Number(opts.chunkMB) || CHUNK_MB_DEFAULT));
    this.sendHeaders = opts.sendHeaders !== false;
    this.status = 'queued';
    this.bytes = 0;
    this.total = 0;
    this.message = 'Queued';
    this.error = null;
    this.outPath = null;
    this.outName = this.filename;
    this.mime = 'video/mp4';
    this.startedAt = 0;
    this.finishedAt = 0;
    this.samples = [];
    this.units = null;
    this.dir = path.join(os.tmpdir(), `pluck-dl-${this.id}`);
    this.controller = new AbortController();
    this.onUpdate = opts.onUpdate || (() => {});
    this.chapters = null;
  }

  snapshot() {
    const elapsed = this.startedAt ? (Date.now() - this.startedAt) / 1000 : 0;
    return {
      id: this.id,
      sessionId: this.sessionId,
      videoId: this.videoId,
      kind: this.kind,
      status: this.status,
      bytes: this.bytes,
      total: this.total,
      percent: this.total
        ? Math.min(100, Math.round((this.bytes / this.total) * 1000) / 10)
        : (this.units && this.units.total ? Math.min(100, Math.round((this.units.done / this.units.total) * 1000) / 10) : null),
      units: this.units,
      message: this.message,
      error: this.error,
      filename: this.filename,
      speed: this.speed || 0,
      elapsed: Math.round(elapsed),
      threads: this.threads,
      chunkMB: this.chunkMB,
      sendHeaders: this.sendHeaders,
      hasFfmpeg: Boolean(getFfmpeg()),
      downloadUrl: this.status === 'done' ? `/api/job/${this.id}/file` : null,
    };
  }

  _emit() { try { this.onUpdate(this); } catch { /* ignore */ } }

  _mark(bytes) {
    this.bytes += bytes;
    const now = Date.now();
    this.samples.push([now, this.bytes]);
    if (this.samples.length > 24) this.samples.shift();
    const [t0, b0] = this.samples[0];
    const dt = (now - t0) / 1000;
    if (dt > 0.6) this.speed = Math.max(0, (this.bytes - b0) / dt);
    this._emit();
  }

  cancel() {
    if (this.status === 'done' || this.status === 'error') return;
    this.status = 'cancelled';
    this.message = 'Cancelled';
    this.controller.abort();
    this._emit();
  }

  reqHeaders(extra = {}) {
    const h = { 'user-agent': A.UA };
    if (this.sendHeaders) {
      for (const k of ['referer', 'origin', 'cookie', 'accept', 'accept-language']) {
        if (this.headers[k]) h[k] = this.headers[k];
      }
    }
    return { ...h, ...extra };
  }

  async run() {
    this.startedAt = Date.now();
    this.status = 'running';
    this._emit();
    try {
      await fsp.mkdir(this.dir, { recursive: true });
      if (this.kind === 'progressive') await this._progressive();
      else if (this.kind === 'hls') await this._hls();
      else if (this.kind === 'dash') await this._dash();
      else throw new Error(`Unknown job kind ${this.kind}`);
      if (this.status === 'cancelled') throw new Error('cancelled');
      this.status = 'done';
      this.finishedAt = Date.now();
      this.message = 'Ready';
      this._cleanupTemps();
      this._emit();
    } catch (err) {
      if (this.status === 'cancelled' || this.controller.signal.aborted) {
        this.status = 'cancelled';
        this.message = 'Cancelled';
      } else {
        this.status = 'error';
        this.error = friendlyError(err);
        this.message = this.error;
      }
      this._cleanupTemps();
      this._emit();
    }
  }

  _cleanupTemps() {
    try {
      for (const f of fs.readdirSync(this.dir)) {
        if (f === path.basename(this.outPath || '')) continue;
        fs.rmSync(path.join(this.dir, f), { force: true, recursive: true });
      }
    } catch { /* ignore */ }
  }

  destroy() {
    try { fs.rmSync(this.dir, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  /* ----------------------------- progressive ----------------------------- */

  async _probeTotal() {
    try {
      const res = await fetch(this.url, {
        headers: this.reqHeaders({ range: 'bytes=0-0' }),
        signal: this.controller.signal,
        redirect: 'follow',
      });
      const cr = res.headers.get('content-range');
      if (cr) {
        const m = /\/(\d+)\s*$/.exec(cr);
        if (m) return Number(m[1]);
      }
      const len = res.headers.get('content-length');
      if (res.status === 200 && len) return Number(len);
      return 0;
    } catch { return 0; }
  }

  async _progressive() {
    const total = await this._probeTotal();
    this.total = total;
    this.message = total ? 'Downloading in parallel chunks' : 'Downloading';
    this._emit();

    const outPath = path.join(this.dir, 'payload.bin');
    this.outPath = outPath;
    const fh = await fsp.open(outPath, 'w');

    try {
      if (!total) {
        // No range support: single stream.
        const res = await fetch(this.url, { headers: this.reqHeaders(), signal: this.controller.signal, redirect: 'follow' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        let last = 0;
        for await (const chunk of res.body) {
          await fh.write(chunk);
          const bytes = chunk.length;
          this.total = 0;
          this.bytes += bytes;
          if (Date.now() - last > 250) { last = Date.now(); this._emit(); }
        }
        return;
      }

      const chunkSize = this.chunkMB * 1024 * 1024;
      const ranges = [];
      for (let start = 0; start < total; start += chunkSize) {
        ranges.push([start, Math.min(total - 1, start + chunkSize - 1)]);
      }
      let done = 0;
      await pool(ranges, this.threads, async ([start, end]) => {
        if (this.controller.signal.aborted) return;
        let attempt = 0;
        while (true) {
          try {
            const res = await fetch(this.url, {
              headers: this.reqHeaders({ range: `bytes=${start}-${end}` }),
              signal: this.controller.signal,
              redirect: 'follow',
            });
            if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
            const buf = Buffer.from(await res.arrayBuffer());
            await fh.write(buf, 0, buf.length, start);
            this._mark(buf.length);
            done += 1;
            this.message = `Chunk ${done}/${ranges.length}`;
            return;
          } catch (err) {
            if (this.controller.signal.aborted) throw err;
            if (++attempt >= 3) throw err;
            await new Promise((r) => setTimeout(r, 600 * attempt));
          }
        }
      }, this.controller.signal);
    } finally {
      await fh.close();
    }

    const finalName = this._extensionFor(this.url);
    const finalPath = path.join(this.dir, `final${finalName}`);
    await fsp.rename(outPath, finalPath);
    this.outPath = finalPath;
    this.mime = finalName === '.webm' ? 'video/webm' : 'video/mp4';
    this.outName = ensureExt(this.filename, finalName);
  }

  _extensionFor(url) {
    const ext = A.extOf(url);
    if (ext === 'webm') return '.webm';
    if (ext === 'mov') return '.mov';
    if (ext === 'mkv') return '.mkv';
    return '.mp4';
  }

  /* --------------------------------- HLS --------------------------------- */

  async _hls() {
    const target = this.variantUrl || this.url;
    this.message = 'Reading playlist';
    this._emit();
    const text = await A.httpText(target, this.reqHeaders(), { signal: this.controller.signal });
    let playlist = A.parseM3u8(text, target);
    if (playlist.master) {
      const best = playlist.variants[0];
      if (!best) throw new Error('Playlist has no variants');
      const mediaText = await A.httpText(best.url, this.reqHeaders(), { signal: this.controller.signal });
      playlist = A.parseM3u8(mediaText, best.url);
    }
    if (!playlist.segments || !playlist.segments.length) throw new Error('Playlist has no segments');

    const segs = playlist.segments;
    this.total = 0;
    this.bytes = 0;
    this.units = { done: 0, total: segs.length, label: 'segments' };
    this.message = `Fetching ${segs.length} segments`;

    const keyCache = new Map();
    const getKey = async (uri) => {
      if (keyCache.has(uri)) return keyCache.get(uri);
      const res = await fetch(uri, { headers: this.reqHeaders(), signal: this.controller.signal });
      if (!res.ok) throw new Error(`Key HTTP ${res.status}`);
      const buf = Buffer.from(await res.arrayBuffer());
      keyCache.set(uri, buf);
      return buf;
    };

    const buffers = new Array(segs.length);
    let done = 0;
    const useInit = Boolean(playlist.initSegment);
    await pool(segs, SEGMENT_CONCURRENCY, async (seg, i) => {
      if (this.controller.signal.aborted) return;
      let attempt = 0;
      while (true) {
        try {
          const res = await fetch(seg.url, { headers: this.reqHeaders(), signal: this.controller.signal, redirect: 'follow' });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          let buf = Buffer.from(await res.arrayBuffer());
          if (seg.key && seg.key.method === 'AES-128' && seg.key.uri) {
            const key = await getKey(seg.key.uri);
            let iv;
            if (seg.key.iv) {
              iv = Buffer.from(seg.key.iv.replace(/^0x/i, '').padStart(32, '0'), 'hex');
            } else {
              iv = Buffer.alloc(16);
              iv.writeUInt32BE(seg.seq, 12);
            }
            const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
            buf = Buffer.concat([decipher.update(buf), decipher.final()]);
          }
          buffers[i] = buf;
          this._mark(buf.length);
          done += 1;
          this.units.done = done;
          this.message = `Segment ${done}/${segs.length}`;
          return;
        } catch (err) {
          if (this.controller.signal.aborted) throw err;
          if (++attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }, this.controller.signal);

    this.message = 'Joining segments';
    this._emit();

    const ext = useInit ? '.mp4' : '.ts';
    const joined = path.join(this.dir, `joined${ext}`);
    const out = await fsp.open(joined, 'w');
    try {
      if (useInit) {
        const initRes = await fetch(playlist.initSegment, { headers: this.reqHeaders(), signal: this.controller.signal });
        if (initRes.ok) await out.write(Buffer.from(await initRes.arrayBuffer()));
      }
      for (const buf of buffers) if (buf && buf.length) await out.write(buf);
    } finally {
      await out.close();
    }

    const finalPath = path.join(this.dir, 'final.mp4');
    const ff = getFfmpeg();
    if (!ff) {
      const fallback = path.join(this.dir, 'final.ts');
      await fsp.rename(joined, fallback);
      this.outPath = fallback;
      this.mime = 'video/mp2t';
      this.outName = ensureExt(this.filename, '.ts');
      this.message = 'ffmpeg not found — saved the raw transport stream';
      return;
    }
    this.message = 'Remuxing to MP4 with ffmpeg';
    this._emit();
    await this._ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', joined, '-c', 'copy', '-movflags', '+faststart', finalPath]);
    this.outPath = finalPath;
    this.mime = 'video/mp4';
    this.outName = ensureExt(this.filename, '.mp4');
    await fsp.rm(joined, { force: true });
  }

  /* --------------------------------- DASH -------------------------------- */

  _dashUrlsFor(rep, mpd) {
    const urls = [];
    let initUrl = null;
    if (rep.template && rep.template.media) {
      const t = rep.template;
      const count = t.duration ? Math.max(1, Math.ceil((mpd.duration * t.timescale) / t.duration)) : 1;
      if (t.init) {
        initUrl = A.absUrl(rep.baseUrl, A.fillTemplate(t.init, { RepresentationID: rep.id, Bandwidth: rep.bandwidth }));
      }
      for (let n = t.startNumber; n < t.startNumber + count; n++) {
        urls.push(A.absUrl(rep.baseUrl, A.fillTemplate(t.media, {
          Number: n, RepresentationID: rep.id, Bandwidth: rep.bandwidth, Time: (n - t.startNumber) * t.duration,
        })));
      }
    } else if (rep.segmentUrls.length) {
      for (const s of rep.segmentUrls) urls.push(A.absUrl(rep.baseUrl, s));
    } else if (rep.baseUrl) {
      urls.push(rep.baseUrl);
    }
    return { urls, initUrl };
  }

  async _fetchDashRep(rep, mpd, outFile) {
    const { urls, initUrl } = this._dashUrlsFor(rep, mpd);
    if (!urls.length) throw new Error('Could not resolve segment URLs');
    const buffers = new Array(urls.length);
    let local = 0;
    await pool(urls, SEGMENT_CONCURRENCY, async (u, i) => {
      if (this.controller.signal.aborted) return;
      let attempt = 0;
      while (true) {
        try {
          const res = await fetch(u, { headers: this.reqHeaders(), signal: this.controller.signal, redirect: 'follow' });
          if (!res.ok) throw new Error(`Fragment HTTP ${res.status}`);
          const buf = Buffer.from(await res.arrayBuffer());
          buffers[i] = buf;
          local += 1;
          if (this.units) this.units.done = (this.units.done || 0) + 1;
          this._mark(buf.length);
          this.message = `${rep.audio ? 'Audio' : 'Video'} fragment ${local}/${urls.length}`;
          return;
        } catch (err) {
          if (this.controller.signal.aborted) throw err;
          if (++attempt >= 3) throw err;
          await new Promise((r) => setTimeout(r, 500 * attempt));
        }
      }
    }, this.controller.signal);

    const out = await fsp.open(outFile, 'w');
    try {
      if (initUrl) {
        const res = await fetch(initUrl, { headers: this.reqHeaders(), signal: this.controller.signal });
        if (res.ok) await out.write(Buffer.from(await res.arrayBuffer()));
      }
      for (const b of buffers) if (b && b.length) await out.write(b);
    } finally {
      await out.close();
    }
    return outFile;
  }

  async _dash() {
    const target = this.variantUrl || this.url;
    this.message = 'Reading manifest';
    this._emit();
    const text = await A.httpText(target, this.reqHeaders(), { signal: this.controller.signal });
    const mpd = A.parseMpd(text, target);
    const rep = mpd.reps[0];
    if (!rep) throw new Error('Manifest has no video representation');
    const audio = mpd.audioReps && mpd.audioReps.length ? mpd.audioReps[0] : null;

    const vCount = this._dashUrlsFor(rep, mpd).urls.length;
    const aCount = audio ? this._dashUrlsFor(audio, mpd).urls.length : 0;
    this.total = 0;
    this.bytes = 0;
    this.units = { done: 0, total: vCount + aCount, label: 'fragments' };
    this.message = `Fetching ${vCount + aCount} fragments`;

    const videoFile = await this._fetchDashRep(rep, mpd, path.join(this.dir, 'video.mp4'));
    let audioFile = null;
    if (audio) {
      try {
        audioFile = await this._fetchDashRep(audio, mpd, path.join(this.dir, 'audio.mp4'));
      } catch { audioFile = null; }
    }

    const finalPath = path.join(this.dir, 'final.mp4');
    const ff = getFfmpeg();
    if (!ff) {
      this.outPath = videoFile;
      this.mime = 'video/mp4';
      this.outName = ensureExt(this.filename, '.mp4');
      this.message = 'ffmpeg not found — fragments joined without remux';
      return;
    }
    this.message = audioFile ? 'Muxing video and audio' : 'Remuxing to MP4 with ffmpeg';
    this._emit();
    if (audioFile) {
      await this._ffmpeg([
        '-y', '-hide_banner', '-loglevel', 'error',
        '-i', videoFile, '-i', audioFile,
        '-map', '0:v:0', '-map', '1:a:0', '-c', 'copy', '-movflags', '+faststart', finalPath,
      ]);
    } else {
      await this._ffmpeg(['-y', '-hide_banner', '-loglevel', 'error', '-i', videoFile, '-c', 'copy', '-movflags', '+faststart', finalPath]);
    }
    this.outPath = finalPath;
    this.mime = 'video/mp4';
    this.outName = ensureExt(this.filename, '.mp4');
    await fsp.rm(videoFile, { force: true });
    if (audioFile) await fsp.rm(audioFile, { force: true });
  }

  _ffmpeg(args) {
    const ff = getFfmpeg();
    return new Promise((resolve, reject) => {
      const child = spawn(ff, args, { windowsHide: true });
      let err = '';
      child.stderr.on('data', (d) => { err += String(d).slice(0, 500); });
      child.on('error', reject);
      child.on('exit', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`ffmpeg failed (${code}): ${err.slice(0, 200) || 'unknown error'}`));
      });
    });
  }
}

function ensureExt(name, ext) {
  const base = String(name || 'video').replace(/\.(mp4|webm|mov|mkv|ts|m4v)$/i, '');
  return `${base}${ext}`;
}

function friendlyError(err) {
  const m = String(err?.message || err);
  if (m === 'cancelled') return 'Cancelled';
  if (/HTTP 403/.test(m)) return 'The source refused the request (HTTP 403). Retry with session headers enabled.';
  if (/HTTP 404/.test(m)) return 'The stream URL expired (HTTP 404). Re-detect the video and try again.';
  if (/HTTP 401/.test(m)) return 'The source needs a login (HTTP 401). Open the site in the live browser and sign in first.';
  if (/fetch failed|ENOTFOUND|EAI_AGAIN|ETIMEDOUT/i.test(m)) return 'Network error while reaching the source.';
  if (/aborted/i.test(m)) return 'Cancelled';
  return m.slice(0, 240);
}

module.exports = { Job, getFfmpeg, newId };

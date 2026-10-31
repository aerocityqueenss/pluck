'use strict';
// Media classification + metadata probing: MP4 atoms, HLS playlists, DASH manifests.
const crypto = require('node:crypto');

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36';

const VIDEO_EXT = new Set(['mp4', 'm4v', 'webm', 'mov', 'mkv', 'ogv', 'ogg', 'flv', 'wmv', '3gp', 'avi']);
const PLAYLIST_EXT = new Set(['m3u8', 'm3u']);
const DASH_EXT = new Set(['mpd']);
const SEGMENT_EXT = new Set(['ts', 'm4s', 'm4f', 'cmfv', 'cmfa', 'aac', 'm4a', 'vtt', 'key']);

function extOf(url) {
  try {
    const clean = url.split('#')[0].split('?')[0];
    const m = /\.([a-z0-9]{2,5})$/i.exec(clean);
    return m ? m[1].toLowerCase() : '';
  } catch { return ''; }
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

/**
 * Decide whether a network response is a downloadable video artifact and how to label it.
 * Returns null when the response is not video-like.
 */
function classify({ url, mime, resourceType }) {
  if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;
  if (!/^https?:/i.test(url)) return null;
  const ext = extOf(url);
  const m = String(mime || '').toLowerCase();

  if (PLAYLIST_EXT.has(ext) || m.includes('mpegurl')) return { ext: 'hls', kind: 'hls' };
  if (DASH_EXT.has(ext) || m.includes('dash+xml')) return { ext: 'mpd', kind: 'dash' };
  if (SEGMENT_EXT.has(ext)) {
    if (ext === 'ts') return { ext: 'ts', kind: 'segment' };
    if (ext === 'm4s' || ext === 'm4f') return { ext: 'm4s', kind: 'segment' };
    return null;
  }
  if (VIDEO_EXT.has(ext)) return { ext: ext === 'm4v' ? 'mp4' : ext, kind: 'progressive' };
  if (m.startsWith('video/')) {
    if (m.includes('mp2t')) return { ext: 'ts', kind: 'segment' };
    if (m.includes('mp4')) return { ext: 'stream', kind: 'progressive' };
    if (m.includes('webm')) return { ext: 'webm', kind: 'progressive' };
    return { ext: 'stream', kind: 'progressive' };
  }
  if (resourceType === 'Media' && /octet-stream/.test(m) && VIDEO_EXT.has(ext)) {
    return { ext: 'stream', kind: 'progressive' };
  }
  return null;
}

function sizeFromHeaders(headers = {}) {
  const range = headers['content-range'];
  if (range) {
    const m = /\/(\d+)\s*$/.exec(range);
    if (m) return Number(m[1]);
  }
  const len = headers['content-length'];
  if (len && /^\d+$/.test(String(len).trim())) return Number(len);
  return 0;
}

function qualityLabel(width, height) {
  const h = Number(height) || 0;
  if (!h) return '';
  const ladder = [144, 240, 360, 480, 540, 720, 1080, 1440, 2160, 4320];
  let best = ladder[0];
  for (const l of ladder) if (Math.abs(l - h) < Math.abs(best - h)) best = l;
  if (Math.abs(best - h) > Math.max(24, h * 0.12)) return `${h}p`;
  return `${best}p`;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => (n < 10 ? `0${n}` : `${n}`);
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

async function httpText(url, headers, ctx = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers },
    signal: ctx.signal,
    redirect: 'follow',
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function httpRange(url, headers, start, end, ctx = {}) {
  const res = await fetch(url, {
    headers: { 'user-agent': UA, ...headers, range: `bytes=${start}-${end}` },
    signal: ctx.signal,
    redirect: 'follow',
  });
  if (!res.ok && res.status !== 206) throw new Error(`HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  return { buf, headers: Object.fromEntries(res.headers), status: res.status };
}

/* ------------------------------- MP4 probing ------------------------------- */

function* atoms(buf, start = 0, end = buf.length) {
  let off = start;
  while (off + 8 <= end) {
    let size = buf.readUInt32BE(off);
    const type = buf.toString('latin1', off + 4, off + 8);
    let header = 8;
    if (size === 1) {
      if (off + 16 > end) return;
      size = Number(buf.readBigUInt64BE(off + 8));
      header = 16;
    } else if (size === 0) {
      size = end - off;
    }
    if (size < header || off + size > end) return;
    yield { type, start: off + header, end: off + size, size };
    off += size;
  }
}

function findAtom(buf, pathArr, start = 0, end = buf.length) {
  for (const a of atoms(buf, start, end)) {
    if (a.type === pathArr[0]) {
      if (pathArr.length === 1) return a;
      const nested = findAtom(buf, pathArr.slice(1), a.start, a.end);
      if (nested) return nested;
    }
  }
  return null;
}

function readMvhd(buf, atom) {
  const v = buf.readUInt8(atom.start);
  if (v === 1) {
    const timescale = buf.readUInt32BE(atom.start + 4 + 16);
    const dur = Number(buf.readBigUInt64BE(atom.start + 4 + 20));
    return { timescale, duration: dur / timescale };
  }
  const timescale = buf.readUInt32BE(atom.start + 4 + 8);
  const dur = buf.readUInt32BE(atom.start + 4 + 12);
  return { timescale, duration: dur / timescale };
}

function readTkhd(buf, atom) {
  const v = buf.readUInt8(atom.start);
  const wOff = atom.start + (v === 1 ? 88 : 76);
  if (wOff + 8 > atom.end) return null;
  const width = buf.readUInt32BE(wOff) / 65536;
  const height = buf.readUInt32BE(wOff + 4) / 65536;
  return { width: Math.round(width), height: Math.round(height) };
}

function readMoov(buf) {
  const out = {};
  const moov = findAtom(buf, ['moov']);
  if (!moov) return out;
  const mvhd = findAtom(buf, ['moov', 'mvhd'], moov.start, moov.end);
  if (mvhd) {
    try {
      const { duration } = readMvhd(buf, mvhd);
      if (Number.isFinite(duration) && duration > 0) out.duration = Math.round(duration * 1000) / 1000;
    } catch { /* damaged atom */ }
  }
  // First trak that carries a usable tkhd gives the presentation size.
  for (const trak of atoms(buf, moov.start, moov.end)) {
    if (trak.type !== 'trak') continue;
    const tkhd = findAtom(buf, ['tkhd'], trak.start, trak.end);
    if (!tkhd) continue;
    try {
      const dims = readTkhd(buf, tkhd);
      if (dims && dims.width > 0 && dims.height > 0) { out.width = dims.width; out.height = dims.height; break; }
    } catch { /* ignore */ }
  }
  return out;
}

async function probeMp4(url, headers, ctx) {
  const out = {};
  let buf = null;
  let total = 0;
  try {
    const res = await fetch(url, { method: 'HEAD', headers: { 'user-agent': UA, ...headers }, signal: ctx.signal, redirect: 'follow' });
    total = Number(res.headers.get('content-length')) || 0;
    const cr = res.headers.get('content-range');
    if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) total = Number(m[1]); }
    if (total) out.estimate_size = total;
  } catch { /* HEAD unsupported */ }

  try {
    const rangeRes = await httpRange(url, headers, 0, 1024 * 1023, ctx);
    buf = rangeRes.buf;
    const cr = rangeRes.headers['content-range'];
    if (cr) { const m = /\/(\d+)\s*$/.exec(cr); if (m) out.estimate_size = Number(m[1]); }
  } catch {
    try {
      const res = await fetch(url, { headers: { 'user-agent': UA, ...headers }, signal: ctx.signal, redirect: 'follow' });
      if (!res.ok) return out;
      buf = Buffer.from(await res.arrayBuffer());
    } catch { return out; }
  }
  if (findAtom(buf, ['moov'])) return { ...out, ...readMoov(buf) };

  // moov may sit at the end (common for non-faststart encodes).
  const knownTotal = out.estimate_size || total || buf.length;
  if (knownTotal > buf.length) {
    const start = Math.max(0, knownTotal - 3 * 1024 * 1024);
    try {
      const tail = (await httpRange(url, headers, start, knownTotal - 1, ctx)).buf;
      if (findAtom(tail, ['moov'])) return { ...out, ...readMoov(tail) };
    } catch { /* ignore */ }
  }
  return out;
}

/* ------------------------------ HLS parsing -------------------------------- */

function parseAttrs(line) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=("[^"]*"|[^,]*)/g;
  let m;
  while ((m = re.exec(line))) {
    let v = m[2];
    if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1);
    attrs[m[1]] = v;
  }
  return attrs;
}

function absUrl(base, rel) {
  try { return new URL(rel, base).toString(); } catch { return rel; }
}

function parseM3u8(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  const isMaster = lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'));
  if (isMaster) {
    const variants = [];
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i].startsWith('#EXT-X-STREAM-INF')) continue;
      const attrs = parseAttrs(lines[i]);
      let uri = '';
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) { uri = lines[j]; break; }
      }
      if (!uri) continue;
      const [w, h] = (attrs.RESOLUTION || '').split('x').map(Number);
      variants.push({
        url: absUrl(baseUrl, uri),
        bandwidth: Number(attrs.BANDWIDTH) || 0,
        averageBandwidth: Number(attrs['AVERAGE-BANDWIDTH']) || 0,
        width: w || 0,
        height: h || 0,
        codecs: attrs.CODECS || '',
        name: h ? `${h}p` : (attrs.BANDWIDTH ? `${Math.round(Number(attrs.BANDWIDTH) / 1000)}k` : 'variant'),
        frameRate: Number(attrs['FRAME-RATE']) || 0,
      });
    }
    variants.sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
    return { master: true, variants };
  }

  let duration = 0;
  let targetDuration = 0;
  let initSegment = null;
  let key = null;
  let sequence = 0;
  const segments = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.startsWith('#EXT-X-TARGETDURATION')) { targetDuration = Number(line.split(':')[1]) || 0; continue; }
    if (line.startsWith('#EXT-X-MEDIA-SEQUENCE')) { sequence = Number(line.split(':')[1]) || 0; continue; }
    if (line.startsWith('#EXT-X-MAP')) {
      const attrs = parseAttrs(line);
      if (attrs.URI) initSegment = absUrl(baseUrl, attrs.URI);
      continue;
    }
    if (line.startsWith('#EXT-X-KEY')) {
      const attrs = parseAttrs(line);
      if ((attrs.METHOD || 'NONE') === 'NONE') key = null;
      else key = { method: attrs.METHOD, uri: attrs.URI ? absUrl(baseUrl, attrs.URI) : '', iv: attrs.IV || '' };
      continue;
    }
    if (line.startsWith('#EXTINF')) {
      const d = Number((line.split(':')[1] || '').split(',')[0]);
      if (Number.isFinite(d)) duration += d;
      for (let j = i + 1; j < lines.length; j++) {
        if (!lines[j].startsWith('#')) {
          segments.push({ url: absUrl(baseUrl, lines[j]), duration: Number.isFinite(d) ? d : 0, key, seq: sequence + segments.length });
          break;
        }
      }
    }
  }
  return { master: false, segments, duration, targetDuration, initSegment, encrypted: segments.some((s) => s.key) };
}

/* ------------------------------ DASH parsing ------------------------------- */

function parseIsoDuration(str) {
  const m = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?T?(?:(\d+)H)?(?:(\d+)M)?(?:([\d.]+)S)?/.exec(str || '');
  if (!m) return 0;
  return (Number(m[3]) || 0) * 86400 + (Number(m[4]) || 0) * 3600 + (Number(m[5]) || 0) * 60 + (Number(m[6]) || 0);
}

function tagText(xml, tag) {
  const m = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`).exec(xml);
  return m ? m[1].trim() : '';
}

function attrOf(tagXml, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(tagXml);
  return m ? m[1] : '';
}

function parseMpd(text, baseUrl) {
  const mpdTag = /<MPD[^>]*>/.exec(text)?.[0] || '';
  const mediaDuration = parseIsoDuration(attrOf(mpdTag, 'mediaPresentationDuration'))
    || parseIsoDuration(tagText(text, 'mediaPresentationDuration'));
  const globalBaseMatch = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/.exec(text);
  const globalBase = globalBaseMatch ? absUrl(baseUrl, globalBaseMatch[1].trim()) : baseUrl;

  const outReps = [];

  const scan = (blockAttrs, blockBody) => {
    const blockMime = attrOf(blockAttrs, 'mimeType');
    const blockType = attrOf(blockAttrs, 'contentType');
    const blockBaseMatch = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/.exec(blockBody);
    const blockBase = blockBaseMatch ? absUrl(globalBase, blockBaseMatch[1].trim()) : globalBase;
    const blockTmpl = /<SegmentTemplate\b[^>]*>/.exec(blockBody)?.[0] || /<SegmentTemplate\b[^>]*>/.exec(text)?.[0] || '';
    const blockList = [...blockBody.matchAll(/<SegmentURL\b[^>]*>/g)].map((s) => attrOf(s[0], 'media'));

    const repRe = /<Representation\b([^>]*?)(\/>|>([\s\S]*?)<\/Representation>)/g;
    let m;
    while ((m = repRe.exec(blockBody))) {
      const repAttrs = m[1] || '';
      const repBody = m[3] || '';
      const mime = attrOf(repAttrs, 'mimeType') || blockMime;
      const type = attrOf(repAttrs, 'contentType') || blockType;
      const height = Number(attrOf(repAttrs, 'height')) || 0;
      const isAudio = /audio/i.test(mime) || /audio/i.test(type);
      const isVideo = !isAudio && (height > 0 || /video/i.test(mime) || /video/i.test(type));
      if (!isVideo && !isAudio) continue;

      const repBaseMatch = /<BaseURL[^>]*>([\s\S]*?)<\/BaseURL>/.exec(repBody);
      const repBase = repBaseMatch ? absUrl(blockBase, repBaseMatch[1].trim()) : blockBase;
      const repTmpl = /<SegmentTemplate\b[^>]*>/.exec(repBody)?.[0] || blockTmpl;
      const repList = repBody ? [...repBody.matchAll(/<SegmentURL\b[^>]*>/g)].map((s) => attrOf(s[0], 'media')) : blockList;

      const tmpl = repTmpl ? {
        media: attrOf(repTmpl, 'media'),
        init: attrOf(repTmpl, 'initialization'),
        startNumber: Number(attrOf(repTmpl, 'startNumber')) || 1,
        timescale: Number(attrOf(repTmpl, 'timescale')) || 1,
        duration: Number(attrOf(repTmpl, 'duration')) || 0,
      } : null;

      outReps.push({
        id: attrOf(repAttrs, 'id') || `${height}p`,
        width: Number(attrOf(repAttrs, 'width')) || 0,
        height,
        bandwidth: Number(attrOf(repAttrs, 'bandwidth')) || 0,
        codecs: attrOf(repAttrs, 'codecs') || '',
        mimeType: mime,
        audio: isAudio,
        baseUrl: repBase,
        template: tmpl && tmpl.media ? tmpl : null,
        segmentUrls: repList.filter(Boolean),
        name: isAudio ? 'audio' : height ? `${height}p` : `${Math.round((Number(attrOf(repAttrs, 'bandwidth')) || 0) / 1000)}k`,
      });
    }
  };

  const asBlocks = [...text.matchAll(/<AdaptationSet\b([^>]*)>([\s\S]*?)<\/AdaptationSet>/g)];
  if (asBlocks.length) {
    for (const b of asBlocks) scan(b[1], b[2]);
  } else {
    scan('', text);
  }

  const videos = outReps.filter((r) => !r.audio).sort((a, b) => (b.height - a.height) || (b.bandwidth - a.bandwidth));
  const audios = outReps.filter((r) => r.audio).sort((a, b) => b.bandwidth - a.bandwidth);
  return { reps: videos, audioReps: audios, duration: mediaDuration, type: /type="dynamic"/.test(mpdTag) ? 'dynamic' : 'static' };
}

function fillTemplate(tmpl, vars) {
  return tmpl.replace(/\$(\w+)(?:%0(\d+)d)?\$/g, (all, name, pad) => {
    if (name === '$') return '$';
    let v = vars[name];
    if (v === undefined) return all;
    if (pad) v = String(v).padStart(Number(pad), '0');
    return String(v);
  });
}

/* ------------------------------- probing API ------------------------------- */

async function probeHls(url, headers, ctx) {
  const text = await httpText(url, headers, ctx);
  const parsed = parseM3u8(text, url);
  if (parsed.master) {
    const best = parsed.variants[0];
    const out = {
      variants: parsed.variants.map((v) => ({
        url: v.url, name: v.name, width: v.width, height: v.height,
        bandwidth: v.bandwidth, codecs: v.codecs, frameRate: v.frameRate,
      })),
      quality: best ? best.name : '',
      width: best?.width || 0,
      height: best?.height || 0,
    };
    if (best) {
      try {
        const mediaText = await httpText(best.url, headers, ctx);
        const media = parseM3u8(mediaText, best.url);
        if (!media.master) {
          out.duration = Math.round(media.duration * 1000) / 1000;
          // Average bandwidth predicts the finished file far better than peak.
          const bw = best.averageBandwidth || best.bandwidth;
          out.estimate_size = bw ? Math.round((bw * media.duration) / 8) : 0;
          out.verifiedPlaylist = true;
        }
      } catch { /* keep master-only facts */ }
    }
    return out;
  }
  const audioOnly = lookLikeAudio(url) || parsed.variants.every((v) => /audio/i.test(v.codecs || '') && !v.height);
  return {
    variants: [],
    duration: Math.round(parsed.duration * 1000) / 1000,
    verifiedPlaylist: true,
    encrypted: parsed.encrypted,
    audioOnly,
    estimate_size: 0,
  };
}

// An audio rendition playlist names itself in its path or codecs; a video one never does.
function lookLikeAudio(url) {
  try {
    const p = new URL(url).pathname.toLowerCase();
    return /(^|[/_-])(audio|aac|aud)([/_.-]|$)/.test(p);
  } catch {
    return false;
  }
}

async function probeDash(url, headers, ctx) {
  const text = await httpText(url, headers, ctx);
  const parsed = parseMpd(text, url);
  const best = parsed.reps[0];
  const out = {
    variants: parsed.reps.map((r) => ({
      url: r.baseUrl, name: r.name, width: r.width, height: r.height,
      bandwidth: r.bandwidth, codecs: r.codecs,
    })),
    duration: parsed.duration,
  };
  if (best) {
    out.quality = best.name;
    out.width = best.width;
    out.height = best.height;
    if (best.bandwidth && parsed.duration) out.estimate_size = Math.round((best.bandwidth * parsed.duration) / 8);
  }
  return out;
}

module.exports = {
  UA, classify, extOf, hostOf, sizeFromHeaders, qualityLabel, formatDuration,
  parseM3u8, parseMpd, probeHls, probeDash, probeMp4, httpText, httpRange, absUrl, fillTemplate, parseAttrs,
};

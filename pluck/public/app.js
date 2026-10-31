'use strict';
/* Pluck — client. Talks to the local server over JSON + binary WebSocket frames. */

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

const SMALL_BYTES = 2 * 1024 * 1024;
const FRAME_MAGIC = 0x56;

const state = {
  videos: new Map(),
  order: [],
  jobs: new Map(),
  filter: 'all',
  sort: 'best',
  reverse: false,
  showSmall: false,
  showUndefined: false,
  animated: new Set(),
  signalSignature: '',
  session: null,
  socket: null,
  prep: null,
  prepBusy: false,
  closed: false,
  lastGestureAt: 0,
  expiresAt: 0,
  frames: 0,
  frameCount: 0,
  fps: 0,
  decoding: false,
};

/* --------------------------------------------------------------- formatting */

function formatSize(bytes) {
  const n = Number(bytes) || 0;
  if (!n) return '—';
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(2)} MB`;
  return `${(n / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}

function formatDuration(sec) {
  const s = Math.max(0, Math.round(Number(sec) || 0));
  if (!s) return '';
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(r)}` : `${m}:${pad(r)}`;
}

function clock(seconds) {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function hostOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
}

function baseName(url) {
  try {
    const p = new URL(url).pathname.split('/').filter(Boolean).pop() || '';
    return decodeURIComponent(p);
  } catch { return ''; }
}

/* Readable address for the window toolbar: decoded path, long query trimmed. */
function tidyUrl(raw) {
  try {
    const url = new URL(raw);
    let path = url.pathname;
    try { path = decodeURIComponent(path); } catch { /* keep it encoded */ }
    const query = url.search.length > 34 ? '?…' : url.search;
    return `${url.host.replace(/^www\./, '')}${path === '/' ? '' : path}${query}${url.hash ? '#…' : ''}`;
  } catch {
    return String(raw).slice(0, 90);
  }
}

/* Media files are often named after a hash; strip the hash, keep what reads. */
function signalName(video) {
  const host = video.domain || hostOf(video.website) || 'stream';
  const base = baseName(video.url).replace(/\.(m3u8|mpd)$/i, '');
  let core = base
    .replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}[_-]?/i, '')
    .replace(/^[0-9a-f]{16,}[_-]?/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\b(\d{5,})\b/g, (n) => `${Math.round(Number(n) / 1000)}k`)
    .trim();

  if (!core || core.length < 3) {
    if (video.variants && video.variants.length) return 'master playlist';
    if (video.audioOnly) return 'audio track';
    return `${video.ext || 'stream'} file`;
  }
  if (core.length > 42) core = `${core.slice(0, 41).trim()}…`;
  return core;
}

/* A short label for panels that already show the stream: quality first, then host. */
function shortName(video) {
  const quality = video.quality || (video.height ? `${video.height}p` : '');
  const host = hostOf(video.website) || video.domain || '';
  if (quality && host) return `${quality} · ${host}`;
  return signalName(video);
}

function escapeHTML(str) {
  return String(str).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ------------------------------------------------------------------- ranking */

function isSmall(video) {
  // A playlist is a text file that points at the real media; its byte count says
  // nothing about the video, so the small-file filter never applies to one.
  if (video.kind === 'hls' || video.kind === 'dash') return false;
  return video.estimate_size > 0 && video.estimate_size < SMALL_BYTES;
}

function isUndefined(video) {
  const noSize = !video.estimate_size;
  const noDuration = !video.duration;
  if (video.kind === 'segment') return true;
  if (video.kind === 'hls') return !video.verifiedPlaylist && noSize;
  if (video.kind === 'dash') return !video.variants && noSize;
  return noDuration && noSize;
}

function priority(video) {
  const small = isSmall(video);
  const undef = isUndefined(video);
  const short = video.duration > 0 && video.duration < 30;
  const likely = video.detectedAfterUserClick || video.highlight;
  let score = 0;
  if (likely && !short) score += 1e15;
  if (!small && !undef) score += 1e12;
  // A master playlist carries the whole quality ladder, so it outranks its own
  // rendition playlists; an audio rendition is never the file someone wanted.
  if (Array.isArray(video.variants) && video.variants.length) score += 1e11;
  if (video.audioOnly) score -= 2e14;
  score += Math.min(video.estimate_size || 0, 1e12 - 1);
  score += 1e6 * Math.min(video.duration || 0, 86400);
  return score;
}

function visibleSignals() {
  const all = state.order
    .map((id) => state.videos.get(id))
    .filter(Boolean)
    .map((video) => ({ video, score: priority(video) }));

  const matchesFilter = all.filter(({ video }) => {
    if (state.filter === 'hls') return video.kind === 'hls';
    if (state.filter === 'stream') return video.kind !== 'hls';
    return true;
  });

  const shown = matchesFilter.filter(({ video }) => {
    if (isSmall(video) && !state.showSmall) return false;
    if (isUndefined(video) && !state.showUndefined && !video.detectedAfterUserClick) return false;
    return true;
  });

  const compare = {
    best: (a, b) => b.score - a.score,
    size: (a, b) => (b.video.estimate_size || 0) - (a.video.estimate_size || 0),
    duration: (a, b) => (b.video.duration || 0) - (a.video.duration || 0),
    recent: (a, b) => (b.video.detectedAt || 0) - (a.video.detectedAt || 0),
  }[state.sort] || ((a, b) => b.score - a.score);

  shown.sort(compare);
  if (state.reverse) shown.reverse();
  return { shown, ranked: all.sort((a, b) => b.score - a.score) };
}

/* ------------------------------------------------------------------ rendering */

function renderSignals() {
  const { shown, ranked } = visibleSignals();
  const list = $('#signal-list');
  const total = state.order.length;

  const countEl = $('#signal-count');
  countEl.textContent = String(shown.length);
  countEl.title = total === shown.length
    ? `${total} detected`
    : `${shown.length} shown of ${total} detected`;
  renderEmptyState(total, shown.length);

  // Best guess must be a real video: never an audio playlist, never a bare playlist row.
  const topId = ranked.find((row) => {
    const v = row.video;
    if (v.audioOnly) return false;
    if (v.variants && v.variants.length) return true;
    return v.kind === 'progressive' || v.kind === 'dash';
  })?.video.id || null;

  // A probe tick that changes nothing about the visible rows must not rebuild them:
  // rebuilding drops focus, hover and scroll, and restarts the entrance animation.
  const signature = [
    topId, total, shown.length, state.showSmall, state.showUndefined, state.filter, state.sort, state.reverse,
    ...shown.map(({ video }) => [video.id, video.quality, video.estimate_size, Math.round(video.duration || 0),
      video.encrypted ? 1 : 0, video.audioOnly ? 1 : 0, video.variants ? video.variants.length : 0,
      video.thumbnail ? 1 : 0].join(':')),
  ].join('|');
  if (signature === state.signalSignature) return;
  state.signalSignature = signature;

  list.innerHTML = shown.map(({ video }, index) => {
    const match = video.id === topId && shown.length > 1;
    const meta = [];
    if (video.quality) meta.push(`<em>${escapeHTML(video.quality)}</em>`);
    if (video.estimate_size) meta.push(formatSize(video.estimate_size));
    if (video.duration) meta.push(formatDuration(video.duration));
    if (video.encrypted) meta.push('aes-128');

    const kindLabel = video.audioOnly
      ? 'audio'
      : video.variants && video.variants.length
        ? 'master'
        : video.kind === 'hls' ? 'hls'
          : video.kind === 'dash' ? 'dash'
            : video.kind === 'segment' ? video.ext : (video.ext || 'file');

    const thumb = video.thumbnail
      ? `<img src="${video.thumbnail}" alt="" loading="lazy">`
      : `<span>${escapeHTML(video.ext || 'vid')}</span>`;

    return `
      <article class="signal${state.animated.has(video.id) ? '' : ' is-new'}" data-id="${video.id}" style="animation-delay:${Math.min(index * 26, 220)}ms">
        <div class="signal-thumb">${thumb}<span class="thumb-chip${video.audioOnly ? ' is-audio' : ''}">${escapeHTML(kindLabel)}</span></div>
        <div class="signal-body">
          <div class="signal-top">
            <span class="signal-name" title="${escapeHTML(video.url)}">${escapeHTML(signalName(video))}</span>
            ${match ? '<span class="signal-match">best guess</span>' : ''}
          </div>
          <div class="signal-meta">${meta.join('<span class="sep">·</span>')}</div>
        </div>
        <div class="signal-actions">
          <button class="icon-btn" data-act="copy" title="Copy stream address" aria-label="Copy stream address">
            <svg class="icon"><use href="#i-copy"></use></svg>
          </button>
          <button class="icon-btn" data-act="preview" title="Preview in place" aria-label="Preview in place" ${video.kind === 'progressive' ? '' : 'disabled'}>
            <svg class="icon"><use href="#i-eye"></use></svg>
          </button>
          <button class="signal-take" data-act="take" title="Take this stream" aria-label="Take this stream">
            <svg class="icon"><use href="#i-download"></use></svg>
          </button>
        </div>
      </article>`;
  }).join('');

  shown.forEach(({ video }) => state.animated.add(video.id));
  renderNotes();
}

function renderEmptyState(total, shownCount) {
  const empty = $('#dock-empty');
  if (shownCount > 0) { empty.hidden = true; return; }
  empty.hidden = false;
  if (!total) {
    empty.innerHTML = `<p class="dock-empty-title">Nothing yet.</p>
      <p>Press play in the window on the left. Streams show up here the moment the page requests them.</p>`;
    return;
  }
  const hiddenSmall = state.order.map((id) => state.videos.get(id)).filter((v) => v && isSmall(v)).length;
  const hiddenUndef = state.order.map((id) => state.videos.get(id)).filter((v) => v && isUndefined(v) && !v.detectedAfterUserClick).length;
  const why = state.filter === 'hls'
    ? `None of the ${total} detected streams is an HLS playlist.`
    : `All ${total} detected streams are filtered out.`;
  const reveal = [];
  if (hiddenSmall) reveal.push(`<button class="btn btn-quiet btn-small" data-empty="small">Show ${hiddenSmall} under 2 MB</button>`);
  if (hiddenUndef) reveal.push(`<button class="btn btn-quiet btn-small" data-empty="undef">Show ${hiddenUndef} unreadable</button>`);
  empty.innerHTML = `<p class="dock-empty-title">${escapeHTML(why)}</p>
    ${hiddenSmall && hiddenUndef ? '<p>Some are tiny fragments, some have no readable size or duration.</p>' : ''}
    ${reveal.join(' ')}`;
}

function renderNotes() {
  const notes = $('#dock-notes');
  const all = state.order.map((id) => state.videos.get(id)).filter(Boolean);
  const undef = all.filter((v) => isUndefined(v) && !v.detectedAfterUserClick);
  const small = all.filter((v) => isSmall(v) && !undef.includes(v));
  const rows = [];

  if (undef.length) {
    const segments = undef.filter((v) => v.kind === 'segment').length;
    const label = segments === undef.length
      ? `${undef.length} transport segments hidden`
      : `${undef.length} unreadable entr${undef.length === 1 ? 'y' : 'ies'} hidden`;
    rows.push(`<button class="note-row" data-toggle="undef">
      <span>${label}</span>
      <span class="count">${state.showUndefined ? 'hide' : 'show'}</span>
    </button>`);
  }
  if (small.length) {
    rows.push(`<button class="note-row" data-toggle="small">
      <span>${small.length} file${small.length === 1 ? '' : 's'} under 2 MB hidden</span>
      <span class="count">${state.showSmall ? 'hide' : 'show'}</span>
    </button>`);
  }
  notes.innerHTML = rows.join('');
}

function renderPrep() {
  const panel = $('#prep');
  const prep = state.prep;
  if (!prep) { panel.hidden = true; panel.innerHTML = ''; return; }
  const { video, kind, variants } = prep;
  const chosen = prep.variantUrl || (variants[0] && variants[0].url) || '';
  panel.hidden = false;

  const variantList = variants.length > 1
    ? `<div class="variants" role="radiogroup" aria-label="Quality">
        ${variants.map((v, i) => `
          <label class="variant ${v.url === chosen ? 'is-active' : ''}">
            <input type="radio" name="variant" value="${escapeHTML(v.url)}" ${v.url === chosen ? 'checked' : ''}>
            <span class="variant-name">${escapeHTML(v.name || `variant ${i + 1}`)}</span>
            <span class="variant-meta">${v.bandwidth ? `${Math.round(v.bandwidth / 1000)} kbps` : ''}${v.width ? ` · ${v.width}×${v.height}` : ''}</span>
          </label>`).join('')}
      </div>`
    : '';

  const isProgressive = kind === 'progressive';

  panel.innerHTML = `
    <div class="prep-head">
      <div>
        <h3 class="prep-title">Take ${escapeHTML(shortName(video))}</h3>
        <p class="prep-sub">${escapeHTML(kind === 'hls' ? 'HLS · segments joined with ffmpeg' : kind === 'dash' ? 'DASH · video and audio muxed' : 'direct file · parallel ranged chunks')}</p>
      </div>
      <button class="icon-btn prep-close" data-prep="close" aria-label="Close options">
        <svg class="icon"><use href="#i-close"></use></svg>
      </button>
    </div>
    ${variantList}
    <div class="prep-opts">
      ${isProgressive ? `
      <div class="field">
        <label for="opt-threads">Parallel chunks</label>
        <input id="opt-threads" type="number" min="1" max="16" step="1" value="4">
      </div>
      <div class="field">
        <label for="opt-chunk">Chunk size (MB)</label>
        <input id="opt-chunk" type="number" min="1" max="64" step="1" value="20">
      </div>` : `
      <p class="prep-note">Segments are fetched six at a time in playlist order, then joined and remuxed into one MP4. Nothing to tune.</p>`}
      <label class="switch">
        <input id="opt-headers" type="checkbox" checked>
        <span>Send the page's session headers
          <small>Referer and cookies from the live window. Turn off only if the host rejects them.</small>
        </span>
      </label>
    </div>
    ${prep.error ? `<p class="prep-err">${escapeHTML(prep.error)}</p>` : ''}
    <div class="prep-foot">
      <button class="btn btn-primary" data-prep="start" ${state.prepBusy ? 'disabled' : ''}>
        ${state.prepBusy ? 'Starting…' : 'Start download'}
      </button>
      <button class="btn btn-quiet" data-prep="close">Cancel</button>
    </div>`;
}

function renderTransfers() {
  const list = $('#transfer-list');
  const jobs = [...state.jobs.values()].sort((a, b) => (b.elapsed || 0) - (a.elapsed || 0));
  $('#job-count').textContent = String(jobs.length);
  if (!jobs.length) { list.innerHTML = ''; return; }

  list.innerHTML = jobs.map((job) => {
    const pct = job.percent == null ? null : Math.max(0, Math.min(100, job.percent));
    const cls = job.status === 'done' ? 'is-done' : job.status === 'error' ? 'is-error' : '';
    const sizeLine = job.total ? `${formatSize(job.bytes)} / ${formatSize(job.total)}` : formatSize(job.bytes);
    const speed = job.status === 'running' && job.speed ? `${formatSize(job.speed)}/s` : '';
    const actions = [];
    if (job.status === 'done') {
      actions.push(`<a class="btn btn-primary" href="${job.downloadUrl}" download>Save file</a>`);
    } else if (job.status === 'running' || job.status === 'queued') {
      actions.push(`<button class="btn btn-quiet" data-job-cancel="${job.id}">Cancel</button>`);
    } else if (job.status === 'error') {
      actions.push(`<button class="btn btn-quiet" data-job-dismiss="${job.id}">Dismiss</button>`);
    } else {
      actions.push(`<button class="btn btn-quiet" data-job-dismiss="${job.id}">Dismiss</button>`);
    }

    const label = {
      queued: 'queued', running: job.message || 'running', done: 'ready',
      error: job.error || 'failed', cancelled: 'cancelled',
    }[job.status] || job.status;

    return `
      <div class="transfer ${cls}">
        <div class="transfer-name" title="${escapeHTML(job.filename)}">${escapeHTML(job.filename)}</div>
        <div class="transfer-kind">${escapeHTML(job.kind)}</div>
        <div class="transfer-mid">
          <div class="transfer-bar"><i style="width:${pct == null ? (job.status === 'done' ? 100 : 4) : pct}%"></i></div>
          <div class="transfer-meta">
            <span>${pct == null ? '' : `${pct.toFixed(1)}%`}</span>
            <span>${sizeLine}</span>
            ${speed ? `<span>${speed}</span>` : ''}
            <span class="msg">${escapeHTML(label)}</span>
          </div>
        </div>
        <div class="transfer-actions">${actions.join('')}</div>
      </div>`;
  }).join('');
}

function renderAll() {
  renderSignals();
  renderTransfers();
  renderPrep();
}

/* --------------------------------------------------------------------- toasts */

function toast(message, kind = 'info', ms = 5200) {
  const wrap = $('#toasts');
  const el = document.createElement('div');
  el.className = `toast ${kind === 'error' ? 'is-error' : kind === 'good' ? 'is-good' : ''}`;
  const icon = kind === 'error' ? 'i-alert' : kind === 'good' ? 'i-check' : 'i-alert';
  el.innerHTML = `<svg class="icon"><use href="#${icon}"></use></svg><span>${escapeHTML(message)}</span>`;
  wrap.appendChild(el);
  setTimeout(() => {
    el.style.transition = 'opacity 220ms ease, transform 220ms ease';
    el.style.opacity = '0';
    el.style.transform = 'translateY(8px)';
    setTimeout(() => el.remove(), 240);
  }, ms);
}

function setStatus(text, kind = '') {
  const pill = $('#live-pill');
  $('#live-text').textContent = text;
  pill.classList.toggle('is-live', kind === 'live');
  pill.classList.toggle('is-down', kind === 'down');
}

function setLine(text) { $('#status-line').textContent = text; }

/* ------------------------------------------------------------------- session */

function showLanding() {
  $('#landing').hidden = false;
  $('#session').hidden = true;
  document.body.classList.remove('is-session');
  if (location.hash) history.replaceState(null, '', location.pathname);
  window.scrollTo({ top: 0, behavior: 'auto' });
}

function showSession() {
  $('#landing').hidden = true;
  $('#session').hidden = false;
  document.body.classList.add('is-session');
  history.replaceState(null, '', '#session');
  window.scrollTo({ top: 0, behavior: 'auto' });
}

async function startSession(rawUrl) {
  const hint = $('#capture-hint');
  const button = $('#capture-btn');
  let url = String(rawUrl || '').trim();
  if (!url) {
    hint.textContent = 'Paste a page address first.';
    hint.classList.add('is-error');
    $('#page-url').focus();
    return;
  }
  hint.classList.remove('is-error');
  hint.textContent = 'Paste the page address, not the file address.';
  button.disabled = true;
  button.querySelector('span').textContent = 'Starting…';
  try {
    const res = await fetch('/api/session', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start a session.');
    localStorage.setItem('pluck:last-url', url);
    state.session = data.session;
    state.videos.clear();
    state.order = [];
    state.jobs.clear();
    state.closed = false;
    state.prep = null;
    state.showSmall = false;
    state.showUndefined = false;
    state.animated.clear();
    state.signalSignature = '';
    state.expiresAt = data.session.expiresAt;
    showSession();
    $('#target-host').textContent = hostOf(url) || url;
    $('#url-readout').textContent = tidyUrl(url);
    $('#url-readout').title = url;
    $('#monitor-veil').hidden = false;
    $('#monitor-veil').classList.remove('is-gone');
    $('#veil-text').textContent = 'Starting Chrome…';
    $('#end-session').textContent = 'End session';
    setStatus('starting');
    setLine('Launching an isolated Chrome window…');
    renderAll();
    connect(state.session.id);
    startClock();
  } catch (err) {
    hint.textContent = err.message;
    hint.classList.add('is-error');
    toast(err.message, 'error');
  } finally {
    button.disabled = false;
    button.querySelector('span').textContent = 'Capture page';
  }
}

function connect(sessionId) {
  if (state.socket) { try { state.socket.close(); } catch { /* ignore */ } }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const socket = new WebSocket(`${proto}://${location.host}/ws?session=${encodeURIComponent(sessionId)}`);
  socket.binaryType = 'arraybuffer';
  state.socket = socket;

  socket.addEventListener('open', () => {
    setStatus('live', 'live');
    setLine('Window is live. Click inside it to interact.');
  });

  socket.addEventListener('message', (event) => {
    if (typeof event.data !== 'string') { onFrame(event.data); return; }
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }
    onEvent(msg);
  });

  socket.addEventListener('close', () => {
    if (!state.closed) {
      setStatus('closed', 'down');
      setLine('The window closed. Transfers keep running.');
    }
  });
  socket.addEventListener('error', () => setStatus('offline', 'down'));
}

function send(payload) {
  if (state.socket && state.socket.readyState === 1) {
    state.socket.send(JSON.stringify(payload));
    return true;
  }
  return false;
}

function onEvent(msg) {
  switch (msg.type) {
    case 'session': {
      if (msg.session) {
        state.expiresAt = msg.session.expiresAt;
        $('#target-host').textContent = msg.session.host || hostOf(msg.session.url);
        $('#url-readout').textContent = tidyUrl(msg.session.url);
        $('#url-readout').title = msg.session.url;
        setStatus('live', 'live');
      }
      (msg.videos || []).forEach((video) => upsertVideo(video, true));
      (msg.jobs || []).forEach((job) => state.jobs.set(job.id, job));
      renderAll();
      break;
    }
    case 'ready': {
      setStatus('live', 'live');
      setLine('Window is live. Press play inside it.');
      break;
    }
    case 'pageInfo': {
      if (msg.url) {
        const readout = $('#url-readout');
        readout.textContent = tidyUrl(msg.url);
        readout.title = msg.url;
      }
      if (msg.title) setLine(msg.title);
      break;
    }
    case 'navigating':
      setLine(`Loading ${hostOf(msg.url) || msg.url}…`);
      break;
    case 'video':
      upsertVideo(msg.video, false);
      renderSignals();
      break;
    case 'videoUpdate':
      upsertVideo(msg.video, true);
      renderSignals();
      break;
    case 'job': {
      const prev = state.jobs.get(msg.job.id);
      // Progress only moves forward; a snapshot from an earlier tick never rewinds the bar.
      const rewinds = prev && prev.status === 'running' && msg.job.status === 'running'
        && (msg.job.bytes || 0) < (prev.bytes || 0);
      if (!rewinds) state.jobs.set(msg.job.id, msg.job);
      renderTransfers();
      if (msg.job.status === 'done') toast(`${msg.job.filename} is ready to save.`, 'good');
      if (msg.job.status === 'error') toast(msg.job.error || 'That download failed.', 'error');
      break;
    }
    case 'popupBlocked':
      setLine(`Blocked a popup (${msg.count} so far).`);
      break;
    case 'navigationBlocked':
      setLine(`Blocked an unsolicited jump to ${msg.hostname}.`);
      break;
    case 'navigationApprovalRequired': {
      $('#nav-notice').hidden = false;
      $('#nav-host').textContent = msg.hostname;
      $('#nav-notice').dataset.id = msg.id;
      break;
    }
    case 'navigationApprovalResolved':
      $('#nav-notice').hidden = true;
      setLine(msg.allowed ? 'Following the page you approved.' : 'Stayed on the page.');
      break;
    case 'error':
      toast(msg.message || 'Something went wrong.', 'error');
      break;
    case 'closed':
    case 'expired':
      onSessionClosed(msg.reason);
      break;
    default:
      break;
  }
}

function upsertVideo(video, existing) {
  if (!video || !video.id) return;
  const had = state.videos.has(video.id);
  state.videos.set(video.id, video);
  if (!had) state.order.push(video.id);
  if (!existing && had) return;
}

function onSessionClosed(reason) {
  state.closed = true;
  setStatus('closed', 'down');
  $('#monitor-veil').hidden = false;
  $('#monitor-veil').classList.remove('is-gone');
  $('#monitor').classList.remove('is-live');
  $('#veil-text').textContent = reason === 'expired'
    ? 'The five-minute window closed. Transfers you started keep going.'
    : 'Window closed. Press New session to open another.';
  $('#end-session').textContent = 'New session';
  setLine(reason === 'expired' ? 'Session time is up.' : 'Session ended.');
}

/* -------------------------------------------------------------------- frames */

const canvas = $('#screen');
const ctx = canvas.getContext('2d', { alpha: false });

canvas.addEventListener('focus', () => $('#monitor').classList.add('is-focused'));
canvas.addEventListener('blur', () => $('#monitor').classList.remove('is-focused'));

function onFrame(buffer) {
  const bytes = new Uint8Array(buffer);
  if (bytes.length < 9 || bytes[0] !== FRAME_MAGIC) return;
  const width = bytes[2] | (bytes[3] << 8);
  const height = bytes[4] | (bytes[5] << 8);
  if (canvas.width !== width || canvas.height !== height) { canvas.width = width; canvas.height = height; }
  if (state.decoding) return;
  state.decoding = true;
  const blob = new Blob([bytes.subarray(8)], { type: 'image/jpeg' });
  createImageBitmap(blob).then((bitmap) => {
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    state.decoding = false;
    state.frames += 1;
    if (state.frames === 1) {
      $('#monitor-veil').classList.add('is-gone');
      $('#monitor').classList.add('is-live');
      setStatus('live', 'live');
    }
  }).catch(() => { state.decoding = false; });
}

setInterval(() => {
  state.fps = state.frames;
  state.frames = 0;
  $('#fps').textContent = state.fps ? `${state.fps} fps` : '—';
}, 1000);

/* --------------------------------------------------------------------- input */

function toCanvas(event) {
  const rect = canvas.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - rect.left) / rect.width) * canvas.width),
    y: Math.round(((event.clientY - rect.top) / rect.height) * canvas.height),
  };
}

let lastMove = 0;
canvas.addEventListener('mousemove', (event) => {
  const now = performance.now();
  if (now - lastMove < 50) return;
  lastMove = now;
  const { x, y } = toCanvas(event);
  send({ type: 'mousemove', x, y });
  state.lastGestureAt = Date.now();
});

canvas.addEventListener('mousedown', (event) => {
  canvas.focus({ preventScroll: true });
  const { x, y } = toCanvas(event);
  const button = event.button === 2 ? 'right' : event.button === 1 ? 'middle' : 'left';
  send({ type: 'mousedown', x, y, button });
  state.lastGestureAt = Date.now();
  event.preventDefault();
});

window.addEventListener('mouseup', (event) => {
  if (event.target !== canvas) return;
  const { x, y } = toCanvas(event);
  send({ type: 'mouseup', x, y, button: 'left' });
});

canvas.addEventListener('contextmenu', (event) => event.preventDefault());

canvas.addEventListener('wheel', (event) => {
  event.preventDefault();
  const { x, y } = toCanvas(event);
  send({
    type: 'wheel', x, y,
    deltaX: Math.round(event.deltaX), deltaY: Math.round(event.deltaY),
  });
}, { passive: false });

canvas.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') { canvas.blur(); return; }
  event.preventDefault();
  send({ type: 'keydown', key: event.key });
});
canvas.addEventListener('keyup', (event) => {
  if (event.key === 'Escape') return;
  event.preventDefault();
  send({ type: 'keyup', key: event.key });
});

/* touch: a tap is a click, a drag is a scroll */
let touchStart = null;
canvas.addEventListener('touchstart', (event) => {
  const t = event.touches[0];
  touchStart = { x: t.clientX, y: t.clientY, moved: false };
  const { x, y } = toCanvas(t);
  send({ type: 'mousemove', x, y });
  send({ type: 'mousedown', x, y, button: 'left' });
  event.preventDefault();
}, { passive: false });

canvas.addEventListener('touchmove', (event) => {
  if (!touchStart) return;
  const t = event.touches[0];
  const dy = t.clientY - touchStart.y;
  if (Math.abs(dy) > 8) touchStart.moved = true;
  const { x, y } = toCanvas(t);
  send({ type: 'mousemove', x, y });
  send({ type: 'wheel', x, y, deltaX: 0, deltaY: Math.round(dy * 2) });
  touchStart.y = t.clientY;
  event.preventDefault();
}, { passive: false });

canvas.addEventListener('touchend', (event) => {
  if (touchStart && !touchStart.moved) {
    const rect = canvas.getBoundingClientRect();
    const x = Math.round(((touchStart.x - rect.left) / rect.width) * canvas.width);
    const y = Math.round(((touchStart.y - rect.top) / rect.height) * canvas.height);
    send({ type: 'mouseup', x, y, button: 'left' });
  }
  touchStart = null;
  event.preventDefault();
}, { passive: false });

/* ------------------------------------------------------------------- actions */

function findVideo(id) { return state.videos.get(id); }

async function takeSignal(id) {
  const video = findVideo(id);
  if (!video) return;
  state.prep = { video, kind: video.kind === 'segment' ? 'progressive' : video.kind, variants: [], variantUrl: '', busy: false };
  renderPrep();
  try {
    const res = await fetch(`/api/session/${state.session.id}/prepare`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: id }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not read that stream.');
    state.prep.kind = data.kind || state.prep.kind;
    state.prep.variants = data.variants || [];
    state.prep.variantUrl = (data.variants && data.variants[0] && data.variants[0].url) || '';
    renderPrep();
  } catch (err) {
    state.prep.error = err.message;
    renderPrep();
  }
}

async function startJob() {
  const prep = state.prep;
  if (!prep || state.prepBusy) return;
  state.prepBusy = true;
  renderPrep();
  const threads = Number($('#opt-threads')?.value) || 4;
  const chunkMB = Number($('#opt-chunk')?.value) || 20;
  const sendHeaders = $('#opt-headers') ? $('#opt-headers').checked : true;
  try {
    const res = await fetch(`/api/session/${state.session.id}/job`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        videoId: prep.video.id,
        options: { variantUrl: prep.variantUrl, threads, chunkMB, sendHeaders },
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Could not start that download.');
    state.jobs.set(data.job.id, data.job);
    state.prep = null;
    renderAll();
    revealTransfers();
    toast('Download started. It keeps running if you close the window.', 'good');
  } catch (err) {
    state.prepBusy = false;
    if (state.prep) { state.prep.error = err.message; renderPrep(); }
    toast(err.message, 'error');
    return;
  }
  state.prepBusy = false;
}

/* A started download is the thing the user is now watching; bring it into view. */
function revealTransfers() {
  const section = $('#transfers');
  if (!section) return;
  const rect = section.getBoundingClientRect();
  if (rect.top > window.innerHeight - 140 || rect.bottom < 80) {
    section.scrollIntoView({ behavior: 'smooth', block: 'end' });
  }
}

let previewDialog = null;
function previewVideo(id) {
  const video = findVideo(id);
  if (!video || video.kind !== 'progressive') return;
  if (!previewDialog) {
    previewDialog = document.createElement('dialog');
    previewDialog.className = 'preview-dialog';
    previewDialog.innerHTML = `
      <div class="preview-head">
        <span class="preview-name mono"></span>
        <button class="icon-btn" aria-label="Close preview">
          <svg class="icon"><use href="#i-close"></use></svg>
        </button>
      </div>
      <video controls autoplay playsinline></video>`;
    previewDialog.querySelector('button').addEventListener('click', () => previewDialog.close());
    previewDialog.addEventListener('close', () => {
      const v = previewDialog.querySelector('video');
      v.pause();
      v.removeAttribute('src');
      v.load();
    });
    document.body.appendChild(previewDialog);
  }
  previewDialog.querySelector('.preview-name').textContent = signalName(video);
  const src = `/api/session/${state.session.id}/preview/${video.id}`;
  previewDialog.querySelector('video').src = src;
  previewDialog.showModal();
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

/* --------------------------------------------------------------------- clock */

let clockTimer = null;
function startClock() {
  if (clockTimer) clearInterval(clockTimer);
  const tick = () => {
    if (!state.expiresAt) return;
    const left = Math.max(0, (state.expiresAt - Date.now()) / 1000);
    const total = state.session?.ttlSeconds || 300;
    $('#timer-value').textContent = clock(left);
    const frac = Math.max(0, Math.min(1, left / total));
    const fill = $('#timer-fill');
    fill.style.transform = `scaleX(${frac})`;
    fill.classList.toggle('is-low', left <= 60);
    $('#timer-value').classList.toggle('is-low', left <= 60);
    if (left <= 0 && !state.closed) onSessionClosed('expired');
  };
  tick();
  clockTimer = setInterval(tick, 250);
}

/* --------------------------------------------------------------------- wiring */

$('#capture-form').addEventListener('submit', (event) => {
  event.preventDefault();
  startSession($('#page-url').value);
});

$('#end-session').addEventListener('click', async () => {
  if (state.closed) { showLanding(); return; }
  const id = state.session?.id;
  $('#end-session').disabled = true;
  try {
    if (id) await fetch(`/api/session/${id}`, { method: 'DELETE' });
  } catch { /* ignore */ }
  $('#end-session').disabled = false;
  onSessionClosed('ended');
  toast('Session ended. Transfers keep running.', 'info');
});

$$('[data-home]').forEach((el) => el.addEventListener('click', (event) => {
  event.preventDefault();
  if (state.session && !state.closed) {
    showLanding();
    toast('Your window is still open. The timer keeps counting.', 'info');
  } else {
    showLanding();
  }
}));

$('#signal-list').addEventListener('click', async (event) => {
  const row = event.target.closest('.signal');
  if (!row) return;
  const id = row.dataset.id;
  const action = event.target.closest('[data-act]')?.dataset.act;
  if (!action) return;
  const video = findVideo(id);
  if (!video) return;

  if (action === 'take') {
    event.target.closest('[data-act]').disabled = true;
    await takeSignal(id);
    return;
  }
  if (action === 'copy') {
    const ok = await copyText(video.url);
    toast(ok ? 'Stream address copied.' : 'Could not reach the clipboard.', ok ? 'good' : 'error');
    return;
  }
  if (action === 'preview') {
    previewVideo(id);
  }
});

$('#dock-notes').addEventListener('click', (event) => {
  const button = event.target.closest('[data-toggle]');
  if (!button) return;
  if (button.dataset.toggle === 'small') state.showSmall = !state.showSmall;
  if (button.dataset.toggle === 'undef') state.showUndefined = !state.showUndefined;
  renderSignals();
});

$('#dock-empty').addEventListener('click', (event) => {
  const button = event.target.closest('[data-empty]');
  if (!button) return;
  if (button.dataset.empty === 'small') state.showSmall = true;
  if (button.dataset.empty === 'undef') state.showUndefined = true;
  renderSignals();
});

$('#prep').addEventListener('click', (event) => {
  const action = event.target.closest('[data-prep]')?.dataset.prep;
  if (action === 'close') { state.prep = null; state.prepBusy = false; renderPrep(); return; }
  if (action === 'start') startJob();
});

$('#prep').addEventListener('change', (event) => {
  if (event.target.name === 'variant') {
    state.prep.variantUrl = event.target.value;
    $$('.variant', $('#prep')).forEach((el) => el.classList.toggle('is-active', el.querySelector('input').checked));
  }
});

$('#transfer-list').addEventListener('click', async (event) => {
  const cancel = event.target.closest('[data-job-cancel]');
  if (cancel) {
    const id = cancel.dataset.jobCancel;
    await fetch(`/api/job/${id}/cancel`, { method: 'POST' }).catch(() => {});
    const job = state.jobs.get(id);
    if (job) { job.status = 'cancelled'; job.message = 'Cancel requested'; renderTransfers(); }
    return;
  }
  const dismiss = event.target.closest('[data-job-dismiss]');
  if (dismiss) {
    state.jobs.delete(dismiss.dataset.jobDismiss);
    renderTransfers();
  }
});

$$('[data-filter]').forEach((button) => button.addEventListener('click', () => {
  state.filter = button.dataset.filter;
  $$('[data-filter]').forEach((b) => b.setAttribute('aria-pressed', String(b === button)));
  renderSignals();
}));

$('#sort').addEventListener('change', (event) => {
  state.sort = event.target.value;
  renderSignals();
});

$('#sort-reverse').addEventListener('click', (event) => {
  state.reverse = !state.reverse;
  event.currentTarget.setAttribute('aria-pressed', String(state.reverse));
  renderSignals();
});

$$('[data-nav]').forEach((button) => button.addEventListener('click', () => {
  send({ type: button.dataset.nav });
}));

$$('[data-scroll]').forEach((button) => button.addEventListener('click', () => {
  send({ type: 'scroll', deltaY: Number(button.dataset.scroll) });
}));

$('#nav-allow').addEventListener('click', () => {
  const id = $('#nav-notice').dataset.id;
  $('#nav-notice').hidden = true;
  send({ type: 'navigationDecision', id, allow: true });
});
$('#nav-deny').addEventListener('click', () => {
  const id = $('#nav-notice').dataset.id;
  $('#nav-notice').hidden = true;
  send({ type: 'navigationDecision', id, allow: false });
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape' && state.prep) { state.prep = null; renderPrep(); }
});

/* ----------------------------------------------------------------- bootstrap */

(async function boot() {
  const chip = $('#env-chip');
  try {
    const health = await (await fetch('/api/health')).json();
    if (!health.chrome) {
      chip.classList.add('is-warn');
      $('#env-text').textContent = 'no chrome';
      toast('Chrome was not found. Set PLUCK_CHROME to its path and restart.', 'error', 9000);
    } else if (!health.ffmpeg) {
      chip.classList.add('is-warn');
      $('#env-text').textContent = 'no ffmpeg';
      toast('ffmpeg not found: HLS and DASH will save as .ts instead of .mp4.', 'error', 9000);
    } else {
      chip.classList.add('is-ready');
      $('#env-text').textContent = 'local · ready';
    }
  } catch {
    chip.classList.add('is-warn');
    $('#env-text').textContent = 'offline';
  }

  const last = localStorage.getItem('pluck:last-url');
  if (last) $('#page-url').value = last;

  if (location.hash === '#session') history.replaceState(null, '', location.pathname);
  $('#page-url').focus({ preventScroll: true });
})();

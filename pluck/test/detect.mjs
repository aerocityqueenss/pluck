// Detection probe: create a session, listen on the socket, print what arrived.
const BASE = process.env.BASE || 'http://127.0.0.1:7777';
const PAGE = process.env.PAGE || 'https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/video';
const SECONDS = Number(process.env.SECONDS || 16);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const res = await fetch(`${BASE}/api/session`, {
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ url: PAGE }),
});
const created = await res.json();
if (!res.ok) { console.error(created); process.exit(1); }
const id = created.session.id;
console.log('session', id, created.session.host);

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?session=${id}`);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });

const videos = new Map();
let lastFrame = null;
ws.addEventListener('message', (ev) => {
  if (typeof ev.data !== 'string') {
    if (lastFrame === null || true) {
      const b = new Uint8Array(ev.data);
      if (b[0] === 0x56) lastFrame = b.subarray(8);
    }
    return;
  }
  const msg = JSON.parse(ev.data);
  if (msg.type === 'session') (msg.videos || []).forEach((v) => videos.set(v.id, v));
  if (msg.type === 'video' || msg.type === 'videoUpdate') videos.set(msg.video.id, msg.video);
  if (msg.type === 'pageInfo') console.log('page', msg.url, '|', msg.title);
  if (['popupBlocked', 'navigationBlocked', 'error'].includes(msg.type)) console.log('event', msg.type, JSON.stringify(msg).slice(0, 200));
});

await delay(SECONDS * 1000);
if (lastFrame && process.env.SHOT) {
  const fs = await import('node:fs');
  fs.mkdirSync('test/shots', { recursive: true });
  fs.writeFileSync(process.env.SHOT, lastFrame);
  console.log('frame ->', process.env.SHOT);
}
console.log(`videos: ${videos.size}`);
for (const v of videos.values()) {
  console.log(` - ${v.kind.padEnd(11)} ${(v.ext || '').padEnd(5)} q=${(v.quality || '-').padEnd(9)} size=${String(v.estimate_size || 0).padStart(10)} dur=${String(v.duration || 0).padStart(7)} thumb=${v.thumbnail ? 'yes' : 'no'} ${v.url.slice(0, 80)}`);
}
ws.close();
await fetch(`${BASE}/api/session/${id}`, { method: 'DELETE' });
process.exit(0);

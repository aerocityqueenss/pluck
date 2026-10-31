// Time the job-creation round trip for a real playlist, and report progress shape.
const BASE = process.env.BASE || 'http://127.0.0.1:7777';
const PAGE = process.env.PAGE || 'https://bitmovin.com/demos/stream-test';
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const created = await (await fetch(`${BASE}/api/session`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ url: PAGE }),
})).json();
const id = created.session.id;

const ws = new WebSocket(`${BASE.replace('http', 'ws')}/ws?session=${id}`);
await new Promise((r, j) => { ws.addEventListener('open', r); ws.addEventListener('error', j); });
const videos = new Map();
ws.addEventListener('message', (ev) => {
  if (typeof ev.data !== 'string') return;
  const msg = JSON.parse(ev.data);
  if (msg.type === 'video' || msg.type === 'videoUpdate') videos.set(msg.video.id, msg.video);
  if (msg.type === 'session') (msg.videos || []).forEach((v) => videos.set(v.id, v));
});
await delay(12000);

const master = [...videos.values()].find((v) => v.variants && v.variants.length);
if (!master) { console.log('no master detected', [...videos.values()].length); process.exit(1); }
console.log('master', master.id, master.quality, master.variants.length, 'variants');

const t0 = Date.now();
const res = await fetch(`${BASE}/api/session/${id}/job`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ videoId: master.id, options: { variantUrl: master.variants[0].url, sendHeaders: true } }),
});
const data = await res.json();
console.log('POST /job', res.status, `${Date.now() - t0}ms`, JSON.stringify(data).slice(0, 200));
await delay(5000);
const snap = await (await fetch(`${BASE}/api/job/${data.job.id}`)).json();
console.log('job', snap.job ? JSON.stringify(snap.job).slice(0, 300) : JSON.stringify(snap).slice(0, 200));
await fetch(`${BASE}/api/job/${data.job.id}/cancel`, { method: 'POST' }).catch(() => {});
ws.close();
await fetch(`${BASE}/api/session/${id}`, { method: 'DELETE' });
process.exit(0);

// End-to-end: playlist in, one playable MP4 out. Verifies bytes and the ftyp box.
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
  const m = JSON.parse(ev.data);
  if (m.type === 'video' || m.type === 'videoUpdate') videos.set(m.video.id, m.video);
});
await delay(12000);

const master = [...videos.values()].find((v) => v.variants && v.variants.length);
if (!master) { console.log('no master detected'); process.exit(1); }
const variant = master.variants.find((v) => v.height === 360) || master.variants[master.variants.length - 1];
console.log('target', variant.name, variant.url.slice(0, 70));

const started = await (await fetch(`${BASE}/api/session/${id}/job`, {
  method: 'POST', headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ videoId: master.id, options: { variantUrl: variant.url, sendHeaders: true } }),
})).json();
const jobId = started.job.id;

let last = '';
for (let i = 0; i < 150; i++) {
  await delay(2000);
  const snap = await (await fetch(`${BASE}/api/job/${jobId}`)).json();
  const job = snap.job;
  const line = `${job.status} ${job.percent ?? 0}% ${Math.round((job.bytes || 0) / 1048576)}MB ${job.message || ''}`;
  if (line !== last) { console.log(line); last = line; }
  if (job.status === 'done' || job.status === 'error') break;
}

const snap = await (await fetch(`${BASE}/api/job/${jobId}`)).json();
console.log('final', JSON.stringify(snap.job).slice(0, 400));

if (snap.job.status === 'done') {
  const res = await fetch(`${BASE}/api/job/${jobId}/file`);
  const buf = Buffer.from(await res.arrayBuffer());
  const head = buf.subarray(0, 12).toString('latin1');
  console.log('file', res.status, buf.length, 'bytes', 'head=' + JSON.stringify(head), 'ftyp=' + buf.includes('ftyp'));
  console.log('filename', snap.job.filename, '| disposition', res.headers.get('content-disposition'));
}
ws.close();
await fetch(`${BASE}/api/session/${id}`, { method: 'DELETE' });
process.exit(0);

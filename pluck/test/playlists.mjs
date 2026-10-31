// Start one job per detected playlist and report the outcome, to find kinds that fail.
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
await delay(14000);

const lists = [...videos.values()].filter((v) => v.kind === 'hls' || v.kind === 'dash');
console.log('playlist rows', lists.length);
for (const v of lists) {
  const variantUrl = v.variants && v.variants.length ? v.variants[0].url : '';
  const res = await fetch(`${BASE}/api/session/${id}/job`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ videoId: v.id, options: { variantUrl, sendHeaders: true } }),
  });
  const data = await res.json();
  if (!res.ok) { console.log('POST failed', res.status, JSON.stringify(data).slice(0, 160)); continue; }
  const jobId = data.job.id;
  let job = data.job;
  for (let i = 0; i < 40; i++) {
    await delay(1500);
    job = (await (await fetch(`${BASE}/api/job/${jobId}`)).json()).job;
    if (job.status !== 'running') break;
  }
  console.log(
    (v.audioOnly ? 'AUDIO ' : 'video ') + (v.quality || '-').padEnd(6),
    v.variants ? `${v.variants.length}v` : '  ',
    job.status.padEnd(8),
    job.percent ?? '-',
    '|', job.message || job.error || '',
    '|', job.filename,
  );
  if (job.status === 'running') await fetch(`${BASE}/api/job/${jobId}/cancel`, { method: 'POST' });
}
ws.close();
await fetch(`${BASE}/api/session/${id}`, { method: 'DELETE' });
process.exit(0);

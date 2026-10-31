// Backend smoke test: session -> screencast -> detection -> download.
const BASE = process.env.BASE || 'http://127.0.0.1:7777';
const PAGE = process.env.PAGE || 'https://www.w3schools.com/html/html5_video.asp';

const log = (...a) => console.log(new Date().toISOString().slice(11, 23), ...a);

async function main() {
  const health = await (await fetch(`${BASE}/api/health`)).json();
  log('health', JSON.stringify(health));

  const created = await (await fetch(`${BASE}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ url: PAGE, ttlSeconds: 180 }),
  })).json();
  log('session', JSON.stringify(created));
  if (!created.session) throw new Error('no session');

  const socket = new WebSocket(`${BASE.replace('http', 'ws')}/ws?session=${created.session.id}`);
  socket.binaryType = 'arraybuffer';
  let frames = 0, firstFrame = null;
  const videos = [];
  const jobs = [];
  await new Promise((res, rej) => {
    socket.addEventListener('open', res);
    socket.addEventListener('error', rej);
  });
  socket.addEventListener('message', (ev) => {
    if (typeof ev.data !== 'string') {
      frames++;
      if (!firstFrame) {
        const buf = Buffer.from(ev.data);
        firstFrame = { magic: buf.readUInt8(0), ver: buf.readUInt8(1), w: buf.readUInt16LE(2), h: buf.readUInt16LE(4), jpeg: buf.length - 8 };
        log('first frame', JSON.stringify(firstFrame));
      }
      return;
    }
    const msg = JSON.parse(ev.data);
    if (msg.type === 'video') { videos.push(msg.video); log('VIDEO', msg.video.ext, msg.video.id, msg.video.url.slice(0, 70), 'size', msg.video.estimate_size); }
    else if (msg.type === 'videoUpdate') {
      const i = videos.findIndex((v) => v.id === msg.video.id);
      if (i >= 0) videos[i] = msg.video;
      log('UPDATE', msg.video.id, 'q', msg.video.quality, 'dur', msg.video.duration, 'size', msg.video.estimate_size);
    } else if (msg.type === 'job') { jobs.push(msg.job); }
    else if (msg.type !== 'session') log('EVENT', msg.type, JSON.stringify(msg).slice(0, 160));
  });

  // let the page settle and auto-scan
  await new Promise((r) => setTimeout(r, 9000));
  log('frames', frames, 'videos', videos.length);

  // click the middle of the canvas to interact (proves input path)
  socket.send(JSON.stringify({ type: 'input', mtype: 'mousemove', x: 640, y: 300 }));

  if (videos.length) {
    const target = videos.find((v) => v.kind === 'progressive') || videos[0];
    log('preparing', target.id, target.kind);
    const prep = await (await fetch(`${BASE}/api/session/${created.session.id}/prepare`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: target.id }),
    })).json();
    log('prepare ->', JSON.stringify(prep).slice(0, 300));

    const started = await (await fetch(`${BASE}/api/session/${created.session.id}/job`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId: target.id, options: { threads: 4, chunkMB: 4 } }),
    })).json();
    log('job ->', JSON.stringify(started).slice(0, 300));

    if (started.job) {
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 1000));
        const st = await (await fetch(`${BASE}/api/job/${started.job.id}`)).json();
        log('job status', st.job.status, `${st.job.percent}%`, st.job.message, st.job.error || '');
        if (st.job.status === 'done' || st.job.status === 'error') {
          if (st.job.status === 'done') {
            const fileRes = await fetch(`${BASE}/api/job/${st.job.id}/file`);
            const buf = Buffer.from(await fileRes.arrayBuffer());
            log('FILE', fileRes.headers.get('content-type'), buf.length, 'bytes', 'disp:', fileRes.headers.get('content-disposition'));
            log('is mp4?', buf.subarray(4, 8).toString('latin1'));
          }
          break;
        }
      }
    }
  }

  log('final frames', frames);
  socket.close();
  await fetch(`${BASE}/api/session/${created.session.id}`, { method: 'DELETE' });
  log('done');
  process.exit(0);
}

main().catch((e) => { console.error('FAIL', e); process.exit(1); });

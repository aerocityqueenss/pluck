// Validate the HLS and DASH pipelines end to end (playlist parse -> segments -> ffmpeg remux).
const { Job } = require('../server/download.js');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');

const HLS = 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';
const DASH = 'https://dash.akamaized.net/envivio/EnvivioDash3/manifest.mpd';

function probe(file) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=format_name,duration,size', '-show_entries', 'stream=codec_type,codec_name,width,height', '-of', 'json', file], { encoding: 'utf8', windowsHide: true, timeout: 30000 });
  try { return JSON.parse(r.stdout); } catch { return { stderr: r.stderr }; }
}

async function runOne(label, kind, url) {
  const t0 = Date.now();
  const job = new Job({ kind, url, filename: `[test] ${label}.mp4`, threads: 4, chunkMB: 8 });
  job.onUpdate = () => {};
  const done = job.run();
  const tick = setInterval(() => {
    process.stdout.write(`  ${label}: ${job.status} ${job.message} ${job.total ? `${job.bytes}/${job.total}` : job.bytes}\n`);
  }, 4000);
  await done;
  clearInterval(tick);
  const secs = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`${label}: ${job.status} in ${secs}s bytes=${job.bytes}/${job.total} out=${job.outPath} err=${job.error || '-'}`);
  if (job.outPath && fs.existsSync(job.outPath)) {
    const size = fs.statSync(job.outPath).size;
    const head = fs.readFileSync(job.outPath).subarray(4, 8).toString('latin1');
    console.log(`  file ${size} bytes, brand=${head}, ffprobe=`, JSON.stringify(probe(job.outPath)).slice(0, 400));
  }
  job.destroy();
  return job.status === 'done';
}

(async () => {
  const okHls = await runOne('hls', 'hls', HLS);
  const okDash = await runOne('dash', 'dash', DASH);
  console.log('RESULT', { okHls, okDash });
  process.exit(okHls && okDash ? 0 : 1);
})();

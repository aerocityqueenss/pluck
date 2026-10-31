// Proves the password gate actually closes the door: 401 without credentials, 200 with them,
// a cookie that survives to the WebSocket handshake, and a rejected unauthenticated upgrade.
import { spawn } from 'node:child_process';
import fs from 'node:fs';

const PORT = 7779;
const PASS = 'gate-test-123';
const base = `http://127.0.0.1:${PORT}`;
const auth = 'Basic ' + Buffer.from('pluck:' + PASS).toString('base64');
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

const server = spawn('node', ['server/index.js'], {
  cwd: process.cwd(),
  env: { ...process.env, PORT: String(PORT), PLUCK_PASSWORD: PASS },
  stdio: ['ignore', fs.openSync('server.gate.out.txt', 'w'), fs.openSync('server.gate.err.txt', 'w')],
});

(async () => {
  for (let i = 0; i < 30; i++) {
    await delay(400);
    try { if ((await fetch(`${base}/api/health`)).status) break; } catch { /* booting */ }
  }

  const anon = await fetch(`${base}/`);
  console.log('anonymous GET / ->', anon.status, anon.headers.get('www-authenticate') ? 'with challenge' : 'NO challenge');

  const anonApi = await fetch(`${base}/api/health`);
  console.log('anonymous GET /api/health ->', anonApi.status);

  const good = await fetch(`${base}/`, { headers: { authorization: auth } });
  const cookie = (good.headers.get('set-cookie') || '').split(';')[0];
  console.log('authorised GET / ->', good.status, '| cookie', cookie.slice(0, 24) + '…');

  const withCookie = await fetch(`${base}/api/health`, { headers: { cookie } });
  console.log('cookie GET /api/health ->', withCookie.status, JSON.stringify(await withCookie.json()).slice(0, 60));

  const badPass = await fetch(`${base}/`, { headers: { authorization: 'Basic ' + Buffer.from('pluck:wrong').toString('base64') } });
  console.log('wrong password ->', badPass.status);

  // WebSocket handshake, with and without credentials.
  const wsTry = (headers) => new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws?session=nope`, { headers });
    ws.addEventListener('open', () => { ws.close(); resolve('open'); });
    ws.addEventListener('error', () => resolve('rejected'));
  });
  console.log('ws without cookie ->', await wsTry({}));
  console.log('ws with cookie ->', await wsTry({ cookie }));

  server.kill();
  await delay(400);
  process.exit(0);
})();

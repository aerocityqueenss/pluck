// Reports the real inset between each flagged container's top border and its first content.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const CHROME = process.env.PLUCK_CHROME || 'C:/Program Files/Google/Chrome/Application/chrome.exe';
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'pluck-measure-'));
const child = spawn(CHROME, [
  '--headless=new', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--window-size=1440,1000', '--remote-debugging-port=0', 'about:blank',
], { stdio: 'ignore' });
const delay = (ms) => new Promise((r) => setTimeout(r, ms));

let port = 0;
for (let i = 0; i < 60 && !port; i++) {
  await delay(250);
  const f = path.join(profile, 'DevToolsActivePort');
  if (fs.existsSync(f)) {
    const [p] = fs.readFileSync(f, 'utf8').split('\n');
    if (p) port = Number(p);
  }
}
const targets = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
const page = targets.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener('open', r));
let seq = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  pending.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

await send('Page.enable');
await send('Page.navigate', { url: 'http://127.0.0.1:7777/' });
await delay(1800);

const out = await send('Runtime.evaluate', {
  returnByValue: true,
  expression: `(() => {
    const probe = (sel) => [...document.querySelectorAll(sel)].map((el) => {
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const first = [...el.children].find((c) => getComputedStyle(c).display !== 'none');
      const fr = first ? first.getBoundingClientRect() : null;
      return {
        sel, cls: el.className,
        top: Math.round(r.top), paddingTop: cs.paddingTop, borderTop: cs.borderTopWidth,
        firstChild: first ? first.className || first.tagName : null,
        gap: fr ? Math.round(fr.top - r.top) : null,
      };
    });
    return JSON.stringify({
      band: probe('.band'), step: probe('.step'), faq: probe('.faq'), workspace: probe('.workspace'),
    }, null, 1);
  })()`,
});
console.log(out.result.result.value);
ws.close();
child.kill();
await delay(400);
try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 6, retryDelay: 200 }); } catch { /* temp */ }
process.exit(0);

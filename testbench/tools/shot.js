// Dev helper: screenshot a page in headless Edge after real time has passed, optionally running JS first.
//   node tools/shot.js <url> <out.png> [width] [height] [waitMs] [js] [mobile]
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import WebSocket from 'ws';

const [url, out, w = 1100, h = 820, wait = 2500, js = '', mobile = ''] = process.argv.slice(2);
const edge = ['C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe', 'C:/Program Files/Microsoft/Edge/Application/msedge.exe'].find(fs.existsSync);
const port = 9300 + Math.floor(Math.random() * 500);
const prof = fs.mkdtempSync(path.join(os.tmpdir(), 'pc-shot-'));
const proc = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${port}`, `--user-data-dir=${prof}`, '--ignore-certificate-errors', 'about:blank'], { stdio: 'ignore' });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let target;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(200);
  try { target = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page'); } catch {}
}
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.once('open', r));
let id = 0;
const call = (method, params = {}) => new Promise((resolve) => {
  const my = ++id;
  const on = (d) => { const m = JSON.parse(d); if (m.id === my) { ws.off('message', on); resolve(m.result ?? m.error); } };
  ws.on('message', on);
  ws.send(JSON.stringify({ id: my, method, params }));
});
await call('Emulation.setDeviceMetricsOverride', { width: +w, height: +h, deviceScaleFactor: mobile ? 2 : 1, mobile: !!mobile, screenWidth: +w, screenHeight: +h });
if (mobile) await call('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 });
await call('Page.enable');
await call('Page.navigate', { url });
await sleep(+wait);
if (js) { const r = await call('Runtime.evaluate', { expression: js, awaitPromise: true, returnByValue: true }); if (r?.exceptionDetails) console.log('js error', JSON.stringify(r.exceptionDetails).slice(0, 400)); else if (r?.result?.value !== undefined) console.log('result', JSON.stringify(r.result.value)); await sleep(1200); }
const shot = await call('Page.captureScreenshot', { format: 'png' });
fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
ws.close();
proc.kill();
await sleep(800);
try { fs.rmSync(prof, { recursive: true, force: true }); } catch {}
console.log('saved', out);
process.exit(0);

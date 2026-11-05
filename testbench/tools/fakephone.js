// Simulated phone for testing the manager without a real device.
//   node tools/fakephone.js [count=1]   → joins, reports a model + battery, opens the gamepad and plays with it.
import WebSocket from 'ws';
import { MSG, KIND, SIZE, now } from '../public/common.js';

const MODELS = [['Galaxy S22 Ultra', '157 × 73 mm', 82], ['Pixel 8', '144 × 65 mm', 46], ['iPhone 15', '142 × 65 mm', 63]];
const count = +(process.argv[2] ?? 1);

for (let n = 0; n < count; n++) {
  const ws = new WebSocket('ws://127.0.0.1:8080/ws');
  const [model, screen, battery] = MODELS[n % MODELS.length];
  let seq = 0, t0 = Date.now();
  ws.on('open', () => {
    ws.send(JSON.stringify({ type: 'join', deviceId: `fakephone-test-${n}` }));
    ws.send(JSON.stringify({ type: 'device', model, screen, layout: 'real size', battery, charging: n === 1 }));
    ws.send(JSON.stringify({ type: 'mode', mode: n === 2 ? 'keys' : 'pad' }));
    const pad = new DataView(new ArrayBuffer(SIZE.PAD)), ping = new DataView(new ArrayBuffer(SIZE.PING));
    setInterval(() => {
      const t = (Date.now() - t0) / 1000;
      ping.setUint8(0, MSG.PING); ping.setUint32(1, ++seq, true); ping.setFloat64(5, now(), true);
      ws.send(Buffer.from(ping.buffer));
      if (n === 2) return;
      pad.setUint8(0, MSG.INPUT); pad.setUint8(1, KIND.PAD); pad.setUint32(2, ++seq, true);
      pad.setFloat64(6, now(), true); pad.setFloat64(14, now(), true);
      const btn = (Math.floor(t * 2) % 4);
      pad.setUint32(22, 1 << btn, true);
      pad.setInt16(26, Math.round(Math.sin(t * 1.3) * 26000), true); pad.setInt16(28, Math.round(Math.cos(t * 1.7) * 20000), true);
      pad.setInt16(30, Math.round(Math.sin(t * 0.8 + 1) * 30000), true); pad.setInt16(32, 0, true);
      pad.setUint8(34, Math.round((Math.sin(t) * 0.5 + 0.5) * 255)); pad.setUint8(35, Math.round((Math.cos(t * 0.7) * 0.5 + 0.5) * 200));
      ws.send(Buffer.from(pad.buffer));
    }, 16);
  });
  ws.on('message', (d, bin) => { if (!bin) { const m = JSON.parse(d); if (m.type === 'identity') console.log(`phone ${n}: P${m.player} ${m.name} ${m.color} ${m.vtype}`); if (m.type === 'buzz') console.log(`phone ${n}: BUZZ`); } });
  ws.on('close', () => console.log(`phone ${n}: closed`));
}

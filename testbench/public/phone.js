// Phone page entry: tabs, ping test, touch test, render loop. Controller screens live in their own modules.
import { MSG, KIND, PHASE, SIZE, Ring, summarize, fmt, now, drawHistogram } from './common.js';
import { link, acks, sync, sendPing, clearPings, onPong, background, nextSeq, trackAck, startNet, me, onIdentity, setVtype, reconnect } from './net.js';
import { $, capture, clamp01, supportsRaw, closeOverlay } from './overlay.js';
import { renderPad } from './pad.js';
import { renderWheel } from './wheel.js';
import { renderMouse } from './mouse.js';
import { renderWizard } from './wizard.js';
import './hud.js';
import './keys.js';
import { inApp } from './native.js';

// Offer the optional Android app on Android browsers (never inside the app itself).
if (!inApp && /Android/i.test(navigator.userAgent)) $('apkBan').classList.remove('hidden');

$('env').textContent = [
  isSecureContext ? 'secure ✓' : 'insecure (use https for raw touch + motion)',
  crossOriginIsolated ? 'isolated timers ✓' : 'coarse timers',
  supportsRaw ? 'pointerrawupdate ✓' : 'no pointerrawupdate',
  `${screen.width}×${screen.height}@${devicePixelRatio}`,
].join(' · ');

// ---------- identity from the laptop: player number, colour, controller type ----------
onIdentity(() => {
  if (me.kicked) {
    closeOverlay();
    $('kickedReason').textContent = me.reason ?? 'The laptop disconnected this phone.';
    $('kicked').classList.remove('hidden');
    return;
  }
  $('kicked').classList.add('hidden');
  document.documentElement.style.setProperty('--player', me.color);
  $('playerName').textContent = me.name;
  document.querySelectorAll('#vtypeSeg button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === me.vtype));
  $('padTypeName').textContent = me.vtype === 'ds4' ? 'PS4 layout' : me.vtype === 'off' ? 'controller off' : 'Xbox layout';
  document.querySelectorAll('.player-tag').forEach((el) => { el.textContent = `P${me.player}`; });
});
$('vtypeSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) setVtype(b.dataset.v); };
$('kickedReconnect').onclick = () => { $('kicked').classList.add('hidden'); reconnect(); };

// ---------- tabs ----------
const VIEWS = { pad: 'view-padinfo', wheel: 'view-wheelinfo', mouse: 'view-mouseinfo', ping: 'view-ping', touch: 'view-touch' };
document.querySelectorAll('.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('.tabs button').forEach((x) => x.classList.toggle('active', x === b));
  for (const [tab, id] of Object.entries(VIEWS)) $(id).classList.toggle('hidden', tab !== b.dataset.tab);
});
const visible = (id) => !$(id).classList.contains('hidden');

function renderStats(el, items) {
  el.innerHTML = items.map(([label, v, unit = 'ms']) => `<div class="stat"><span>${label}</span><b>${typeof v === 'number' ? fmt(v) : v ?? '–'}</b><span>${unit}</span></div>`).join('');
}

// ---------- ping test ----------
const ping = { running: false, samples: [] };
onPong((rtt, pending) => { if (pending && ping.running) ping.samples.push(rtt); });
$('pingStart').onclick = async () => {
  if (ping.running) { ping.running = false; return; }
  if (!link.ready) return alert('Transport not connected yet');
  const rate = +$('pingRate').value, count = +$('pingCount').value;
  ping.running = true; ping.samples = []; clearPings();
  background.paused = true;
  $('pingStart').textContent = 'Stop';
  const interval = 1000 / rate, t0 = performance.now();
  let sent = 0;
  // Timers clamp to 4 ms; a MessageChannel loop isn't clamped, so pace by wall clock with it.
  await new Promise((done) => {
    const mc = new MessageChannel();
    mc.port1.onmessage = () => {
      if (!ping.running) return done();
      const due = Math.min(count, Math.floor((performance.now() - t0) / interval) + 1);
      while (sent < due) { sendPing(); sent++; }
      if (sent >= count) return done();
      mc.port2.postMessage(0);
    };
    mc.port2.postMessage(0);
  });
  await new Promise((r) => setTimeout(r, 1000));  // let stragglers land
  ping.running = false;
  background.paused = false;
  $('pingStart').textContent = 'Start';
  const s = summarize(ping.samples);
  if (!s) return;
  const loss = (1 - s.n / sent) * 100;
  link.sendJson({ type: 'run', run: { kind: 'ping', transport: link.mode, rate, sent, loss, ...s } });
  $('runs').insertAdjacentHTML('afterbegin', `<tr><td>${link.mode}</td><td>${rate}</td><td>${fmt(s.p50)}</td><td>${fmt(s.p95)}</td><td>${fmt(s.p99)}</td><td>${fmt(s.max)}</td><td>${fmt(s.jitter)}</td><td>${fmt(loss, 1)}%</td></tr>`);
};

// ---------- touch test ----------
const pipeline = new Ring(1000);
const touchBuf = new DataView(new ArrayBuffer(SIZE.TOUCH));
function sendTouch(e, phase, rect) {
  const tSend = now(), tEvent = performance.timeOrigin + e.timeStamp, seq = nextSeq();
  touchBuf.setUint8(0, MSG.INPUT);
  touchBuf.setUint8(1, KIND.TOUCH);
  touchBuf.setUint32(2, seq, true);
  touchBuf.setFloat64(6, tEvent, true);
  touchBuf.setFloat64(14, tSend, true);
  touchBuf.setUint8(22, e.pointerId & 0xff);
  touchBuf.setUint8(23, phase);
  touchBuf.setUint16(24, Math.round(clamp01((e.clientX - rect.left) / rect.width) * 65535), true);
  touchBuf.setUint16(26, Math.round(clamp01((e.clientY - rect.top) / rect.height) * 65535), true);
  link.sendBinary(touchBuf.buffer);
  trackAck(seq, tEvent, tSend);
  pipeline.push(tSend - tEvent);
}

const area = $('touchArea');
const dots = new Map();
function touchHandler(phase) {
  return (e) => {
    const rect = area.getBoundingClientRect();
    sendTouch(e, phase, rect);
    let d = dots.get(e.pointerId);
    if (phase === PHASE.UP) { d?.remove(); dots.delete(e.pointerId); return; }
    if (!d) { d = document.createElement('div'); d.className = 'touchdot'; area.appendChild(d); dots.set(e.pointerId, d); }
    d.style.left = `${e.clientX - rect.left}px`;
    d.style.top = `${e.clientY - rect.top}px`;
  };
}
area.addEventListener('pointerdown', (e) => { capture(area, e); touchHandler(PHASE.DOWN)(e); });
if (supportsRaw) area.addEventListener('pointerrawupdate', touchHandler(PHASE.RAW));
else area.addEventListener('pointermove', touchHandler(PHASE.MOVE));
area.addEventListener('pointerup', touchHandler(PHASE.UP));
area.addEventListener('pointercancel', touchHandler(PHASE.UP));
$('touchReset').onclick = () => { pipeline.clear(); acks.ackRtt.clear(); acks.eventToAck.clear(); link.sendJson({ type: 'reset' }); };

// ---------- render loop ----------
let frame = 0;
function render() {
  if (visible('view-ping')) {
    const s = summarize(ping.samples.slice(-5000));
    renderStats($('pingStats'), [['p50', s?.p50], ['p95', s?.p95], ['p99', s?.p99], ['max', s?.max], ['jitter', s?.jitter], ['samples', s?.n ?? 0, '']]);
    drawHistogram($('pingHist'), ping.samples.slice(-5000), { maxMs: 30, marks: { p50: s?.p50, p99: s?.p99 } });
  }
  if (visible('view-touch')) {
    const p = summarize(pipeline.values()), a = summarize(acks.ackRtt.values()), ea = summarize(acks.eventToAck.values());
    renderStats($('touchStats'), [['event→send p50', p?.p50], ['event→send p99', p?.p99], ['ack RTT p50', a?.p50], ['ack RTT p99', a?.p99], ['event→ack p50', ea?.p50], ['samples', p?.n ?? 0, '']]);
    drawHistogram($('touchHist'), acks.eventToAck.values(), { maxMs: 40, color: '#60a5fa', marks: { p50: ea?.p50, p99: ea?.p99 } });
  }
  if (frame++ % 15 === 0) {
    const a = summarize(acks.ackRtt.values());
    const rtt = a?.p50 ?? sync.rtt;
    const ms = rtt != null ? fmt(rtt, 0) : '–';
    document.querySelectorAll('.pingv').forEach((el) => { el.textContent = ms; });
  }
  renderPad();
  renderWheel();
  renderMouse();
  renderWizard();
  requestAnimationFrame(render);
}

startNet();
render();

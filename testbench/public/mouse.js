// Mouse screen: moves the laptop's real mouse (once allowed in PhoneController on the laptop).
//   Table = slide the phone on a table like a mouse · Touch = trackpad · Air = point it around
//   1 finger drag = move · tap = left click · 2-finger tap = right click · 2-finger drag = scroll
//   L / M / R buttons hold down (drag with another finger) · right strip = scroll
import { MSG, KIND, HEARTBEAT, SIZE, MOUSE_BTN, fmt, summarize, now } from './common.js';
import { $, capture, show, isOpen, MOVE_EVENT, load, save, openOverlay, closeOverlay } from './overlay.js';
import { link, nextSeq, trackAck, acks, server, onServerStatus } from './net.js';
import { motion, onMotion } from './motion.js';
import { TableMouse } from './tablemouse.js';

const mouseEl = $('mouse');
export const mouse = { sens: 2, accel: 0.6, scroll: 4, natural: true, air: false, airSpeed: 35, airHold: false, table: true, tableSpeed: 16, tableSens: 1, ...load('mouse', {}) };
const saveMouse = () => save('mouse', { sens: mouse.sens, accel: mouse.accel, scroll: mouse.scroll, natural: mouse.natural, air: mouse.air, airSpeed: mouse.airSpeed, airHold: mouse.airHold, table: mouse.table, tableSpeed: mouse.tableSpeed, tableSens: mouse.tableSens });

const st = { buttons: 0, accX: 0, accY: 0, accW: 0, accH: 0, sent: 0 };
const i16 = (v) => Math.max(-32768, Math.min(32767, v));
const buf = new DataView(new ArrayBuffer(SIZE.MOUSE));

function send(dx, dy, wheel, hwheel, tEvent, heartbeat = false) {
  const tSend = now(), seq = nextSeq();
  buf.setUint8(0, MSG.INPUT);
  buf.setUint8(1, KIND.MOUSE | (heartbeat ? HEARTBEAT : 0));
  buf.setUint32(2, seq, true);
  buf.setFloat64(6, tEvent ?? tSend, true);
  buf.setFloat64(14, tSend, true);
  buf.setInt16(22, i16(dx), true);
  buf.setInt16(24, i16(dy), true);
  buf.setUint8(26, st.buttons);
  buf.setInt16(27, i16(wheel), true);
  buf.setInt16(29, i16(hwheel), true);
  link.sendBinary(buf.buffer);
  st.sent++;
  if (!heartbeat) trackAck(seq, tEvent ?? tSend, tSend);
}
const stamp = (e) => performance.timeOrigin + e.timeStamp;

// Sub-pixel remainders carry over so slow, precise movement isn't lost to rounding.
function move(dx, dy, dt, e) {
  const speed = Math.hypot(dx, dy) / Math.max(dt, 1);   // px per ms
  const gain = mouse.sens * (1 + mouse.accel * Math.min(speed, 4));
  st.accX += dx * gain; st.accY += dy * gain;
  const ix = Math.trunc(st.accX), iy = Math.trunc(st.accY);
  st.accX -= ix; st.accY -= iy;
  if (ix || iy) send(ix, iy, 0, 0, stamp(e));
}
// Wheel + = scroll up, hwheel + = scroll right.
// Natural: content follows the finger (finger up → page scrolls down). Traditional: the reverse.
function scroll(dx, dy, e) {
  const s = mouse.natural ? 1 : -1;
  st.accW += dy * mouse.scroll * s;
  st.accH -= dx * mouse.scroll * s;
  const w = Math.trunc(st.accW), h = Math.trunc(st.accH);
  st.accW -= w; st.accH -= h;
  if (w || h) send(0, 0, w, h, stamp(e));
}
function setButton(bit, down, e) {
  st.buttons = down ? st.buttons | bit : st.buttons & ~bit;
  send(0, 0, 0, 0, stamp(e));
}
function click(bit, e) {
  setButton(bit, true, e);
  setTimeout(() => setButton(bit, false, e), 30);
  if (!mouse.table) navigator.vibrate?.(8);
}

// ---------- trackpad surface ----------
const surface = $('mouseSurface');
const touches = new Map();   // pointerId → { x, y, t }
let gesture = null;          // { start, maxFingers, travel }

surface.addEventListener('pointerdown', (e) => {
  capture(surface, e);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  if (!gesture) gesture = { start: e.timeStamp, maxFingers: 0, travel: 0 };
  gesture.maxFingers = Math.max(gesture.maxFingers, touches.size);
});
surface.addEventListener(MOVE_EVENT, (e) => {
  const p = touches.get(e.pointerId);
  if (!p) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = e.timeStamp - p.t;
  Object.assign(p, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  if (gesture) gesture.travel += Math.hypot(dx, dy);
  if (touches.size === 1 && !mouse.air && !mouse.table) move(dx, dy, dt, e);
  else if (touches.size === 2) scroll(dx / 2, dy / 2, e);   // each finger reports half the motion
});
function lift(e) {
  if (!touches.delete(e.pointerId) || touches.size) return;
  const g = gesture;
  gesture = null;
  if (!g || e.timeStamp - g.start > 250 || g.travel > 12) return;
  click(g.maxFingers >= 2 ? MOUSE_BTN.R : MOUSE_BTN.L, e);
}
surface.addEventListener('pointerup', lift);
surface.addEventListener('pointercancel', lift);

// ---------- air mouse: move the phone, the cursor follows (gyroscope) ----------
// Turning left/right = rotation about world "up" (from gravity), so it works held upright or flat like a remote.
// Tilting the top toward / away from you = rotation about the screen's x axis.
const AIR_DEAD = 1.2;       // deg/s: ignore the tremor of a resting hand
let airT = 0, airX = 0, airY = 0;
onMotion((e) => {
  if (!mouse.air || mouse.table || !isOpen(mouseEl)) { airT = 0; return; }
  const t = e.timeStamp, dt = airT ? Math.min(50, t - airT) / 1000 : 0;
  airT = t;
  if (!dt || (mouse.airHold && !touches.size)) return;
  const [gx, gy, gz] = motion.gyro, [ax, ay, az] = motion.accel, m = Math.hypot(ax, ay, az) || 1;
  let yaw = (gx * ax + gy * ay + gz * az) / m, pitch = gx;
  yaw = Math.abs(yaw) < AIR_DEAD ? 0 : yaw - Math.sign(yaw) * AIR_DEAD;
  pitch = Math.abs(pitch) < AIR_DEAD ? 0 : pitch - Math.sign(pitch) * AIR_DEAD;
  // Gentle acceleration: slow turns stay precise, fast flicks cross the screen.
  const gain = mouse.airSpeed * (1 + Math.min(1.5, Math.hypot(yaw, pitch) / 120));
  airX += -yaw * dt * gain; airY += -pitch * dt * gain;
  const ix = Math.trunc(airX), iy = Math.trunc(airY);
  airX -= ix; airY -= iy;
  if (ix || iy) send(ix, iy, 0, 0, performance.timeOrigin + t);
});
// ---------- table mouse: slide the phone on the table, the cursor follows ----------
const G = 9.80665;
const tracker = new TableMouse({ sensitivity: mouse.tableSens });
let tableX = 0, tableY = 0;
onMotion((e) => {
  if (!mouse.table || !isOpen(mouseEl)) { tracker.lastT = 0; tableX = tableY = 0; return; }
  const [ax, ay, az] = motion.accel, [gx, gy] = motion.gyro;
  const m = tracker.update(ax * G, ay * G, az * G, gx, gy, e.timeStamp);
  if (!m.x && !m.y) return;
  // Gentle acceleration, like Windows does for a real mouse: precise when slow, quick across the screen.
  const gain = mouse.tableSpeed * (1 + 0.8 * Math.min(2, m.speed / 0.3));
  tableX += m.x * gain; tableY -= m.y * gain;   // phone's top = away from you = cursor up
  const ix = Math.trunc(tableX), iy = Math.trunc(tableY);
  tableX -= ix; tableY -= iy;
  if (ix || iy) send(ix, iy, 0, 0, performance.timeOrigin + e.timeStamp);
});

const modeOf = () => (mouse.table ? 'table' : mouse.air ? 'air' : 'touch');
async function setMouseMode(v) {
  // iPhone asks for motion permission once, from a tap.
  if (v !== 'touch' && typeof DeviceMotionEvent?.requestPermission === 'function') { try { await DeviceMotionEvent.requestPermission(); } catch {} }
  mouse.table = v === 'table'; mouse.air = v === 'air';
  if (mouse.table) tracker.reset();
  tracker.sensitivity = mouse.tableSens;
  saveMouse(); renderAir();
}
function renderAir() {
  document.querySelectorAll('#mouseModeSeg button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === modeOf()));
  mouseEl.classList.toggle('air', mouse.air);
  mouseEl.classList.toggle('table', mouse.table);
  surface.querySelector('span').textContent = mouse.air ? (mouse.airHold ? 'hold here + move the phone' : 'move the phone · tap = click') : 'trackpad';
  $('mouseAirSpeedV').textContent = fmt(mouse.airSpeed, 0);
  $('mouseTableSpeedV').textContent = fmt(mouse.tableSpeed, 0);
  $('mouseTableSensV').textContent = fmt(mouse.tableSens, 1);
}
$('mouseModeSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) setMouseMode(b.dataset.v); };
$('mouseTableOn').checked = mouse.table;
$('mouseTableOn').onchange = (e) => setMouseMode(e.target.checked ? 'table' : 'touch');
$('mouseTableSpeed').value = mouse.tableSpeed;
$('mouseTableSpeed').addEventListener('input', (e) => { mouse.tableSpeed = +e.target.value; saveMouse(); renderAir(); });
$('mouseTableSens').value = mouse.tableSens;
$('mouseTableSens').addEventListener('input', (e) => { mouse.tableSens = +e.target.value; tracker.sensitivity = mouse.tableSens; saveMouse(); renderAir(); });
$('mouseAirSpeed').value = mouse.airSpeed;
$('mouseAirSpeed').addEventListener('input', (e) => { mouse.airSpeed = +e.target.value; saveMouse(); renderAir(); });
$('mouseAirHold').checked = mouse.airHold;
$('mouseAirHold').onchange = (e) => { mouse.airHold = e.target.checked; saveMouse(); renderAir(); };
$('mouseAirOn').checked = mouse.air;
$('mouseAirOn').onchange = (e) => setMouseMode(e.target.checked ? 'air' : 'touch');
renderAir();

// ---------- hold buttons + scroll strip ----------
for (const [id, bit] of [['mouseBtnL', MOUSE_BTN.L], ['mouseBtnM', MOUSE_BTN.M], ['mouseBtnR', MOUSE_BTN.R]]) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => { capture(b, e); b.classList.add('on'); if (!mouse.table) navigator.vibrate?.(8); setButton(bit, true, e); });   // a buzz would read as movement on a table
  const up = (e) => { if (!b.classList.contains('on')) return; b.classList.remove('on'); setButton(bit, false, e); };
  b.addEventListener('pointerup', up);
  b.addEventListener('pointercancel', up);
}
const strip = $('mouseScroll');
let stripY = null;
strip.addEventListener('pointerdown', (e) => { capture(strip, e); stripY = e.clientY; });
strip.addEventListener(MOVE_EVENT, (e) => { if (stripY == null) return; scroll(0, e.clientY - stripY, e); stripY = e.clientY; });
strip.addEventListener('pointerup', () => { stripY = null; });
strip.addEventListener('pointercancel', () => { stripY = null; });

// ---------- open / close ----------
let hb = 0;
$('mouseOpen').onclick = () => {
  tracker.reset();
  openOverlay(mouseEl, 'mouse', () => (++hb % 3 === 0) && send(0, 0, 0, 0, null, true));
};
$('mouseClose').onclick = () => {
  if (st.buttons) { st.buttons = 0; send(0, 0, 0, 0); }
  closeOverlay();
};

// ---------- settings ----------
const fields = { mouseSens: 'sens', mouseAccel: 'accel', mouseScrollSpeed: 'scroll' };
for (const [id, key] of Object.entries(fields)) {
  $(id).value = mouse[key];
  $(id).addEventListener('input', () => { mouse[key] = +$(id).value; renderMouseSettings(); saveMouse(); });
}
$('mouseNatural').checked = mouse.natural;
$('mouseNatural').onchange = (e) => { mouse.natural = e.target.checked; saveMouse(); };
function renderMouseSettings() {
  $('mouseSensV').textContent = fmt(mouse.sens, 1);
  $('mouseAccelV').textContent = fmt(mouse.accel, 1);
  $('mouseScrollSpeedV').textContent = fmt(mouse.scroll, 0);
}
renderMouseSettings();

function renderPermission() {
  const msg = !server.mouseAvailable ? 'Mouse and keyboard control is not available on the laptop (needs Windows).'
    : server.mouseAllowed ? '' : 'The laptop has not allowed mouse and keyboard control yet: turn on "Phone can be the mouse" in PhoneController on the laptop.';
  document.querySelectorAll('.mousePerm').forEach((el) => { el.textContent = msg; el.classList.toggle('hidden', !msg); });
}
onServerStatus(renderPermission);
renderPermission();

const TABLE_STATE = {
  calibrating: ['Lay the phone flat on the table, screen up, and keep it still…', 'wait'],
  lifted: ['Lifted. Put it down and hold still for a moment', 'wait'],
  ready: ['Ready: slide the phone like a mouse', 'ok'],
  moving: ['Moving', 'ok'],
};
export function renderMouse() {
  if (!isOpen(mouseEl)) return;
  const a = summarize(acks.ackRtt.values());
  const air = mouse.air ? (motion.raw == null ? ' · air mouse needs the motion sensor: open the https address' : ` · air ${fmt(mouse.airSpeed, 0)}`) : '';
  $('mouseInfo').textContent = `${link.mode} · ack RTT p50 ${fmt(a?.p50)} ms · packets ${st.sent}${mouse.table ? '' : ` · sens ${fmt(mouse.sens, 1)}`}${air}`;
  $('mouseAirOn').checked = mouse.air;
  $('mouseTableOn').checked = mouse.table;
  if (mouse.table) {
    const [text, cls] = motion.raw == null
      ? [isSecureContext ? 'Waiting for the motion sensor…' : 'Table mouse needs the https address (scan the code on the laptop)', 'bad']
      : TABLE_STATE[tracker.state];
    const el = $('tableState');
    el.textContent = text;
    el.className = cls;
  }
}

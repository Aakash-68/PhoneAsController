// Mouse screen: moves the laptop's real mouse (once allowed in PhoneController on the laptop).
//   1 finger drag = move · tap = left click · double-tap and hold = hold left button (drag)
//   2-finger tap = right click · 2-finger drag = scroll
//   3-finger tap = open windows · 3-finger swipe up = desktop · left / right = next / previous desktop
//   L / M / R buttons hold down (drag with another finger) · right strip = scroll
import { MSG, KIND, HEARTBEAT, SIZE, MOUSE_BTN, fmt, summarize, now } from './common.js';
import { $, capture, show, isOpen, MOVE_EVENT, load, save, openOverlay, closeOverlay } from './overlay.js';
import { link, nextSeq, trackAck, acks, server, onServerStatus } from './net.js';

const mouseEl = $('mouse');
export const mouse = { sens: 2, accel: 0.6, scroll: 4, natural: true, ...load('mouse', {}) };
const saveMouse = () => save('mouse', { sens: mouse.sens, accel: mouse.accel, scroll: mouse.scroll, natural: mouse.natural });

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
  navigator.vibrate?.(8);
}

// ---------- trackpad surface ----------
const surface = $('mouseSurface');
const touches = new Map();   // pointerId → { x, y, t }
let gesture = null;          // { start, maxFingers, travel, swipeX, swipeY, holding, swiped }
let lastTapEnd = -Infinity;
const TAP_MS = 250, THREE_TAP_MS = 350;   // lifting three fingers together takes a little longer
const TAP_TRAVEL = 12;                    // px per finger: more than this is a drag, not a tap
const HOLD_WINDOW_MS = 300;               // a touch this soon after a tap holds the left button
const SWIPE_PX = 50;

// One reliable message, and the laptop presses and releases the keys together: a key press sent as
// separate packets could lose its release and leave the Windows key stuck down.
function shortcut(name) {
  link.sendJson({ type: 'shortcut', name });
  navigator.vibrate?.(15);
}
// Same directions as a Mac: swipe left to reach the desktop on the right.
function swipe3(g) {
  if (Math.hypot(g.swipeX, g.swipeY) < SWIPE_PX) return;
  g.swiped = true;
  if (Math.abs(g.swipeX) > Math.abs(g.swipeY)) shortcut(g.swipeX < 0 ? 'desktop-next' : 'desktop-prev');
  else if (g.swipeY < 0) shortcut('show-desktop');
}

surface.addEventListener('pointerdown', (e) => {
  capture(surface, e);
  touches.set(e.pointerId, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  if (!gesture) {
    gesture = { start: e.timeStamp, maxFingers: 0, travel: 0, swipeX: 0, swipeY: 0, holding: false, swiped: false };
    if (e.timeStamp - lastTapEnd < HOLD_WINDOW_MS) {
      gesture.holding = true;
      setButton(MOUSE_BTN.L, true, e);
      navigator.vibrate?.(8);
    }
    lastTapEnd = -Infinity;
  } else if (gesture.holding) {   // more fingers: this is a new gesture, not a drag
    gesture.holding = false;
    setButton(MOUSE_BTN.L, false, e);
  }
  gesture.maxFingers = Math.max(gesture.maxFingers, touches.size);
});
surface.addEventListener(MOVE_EVENT, (e) => {
  const p = touches.get(e.pointerId);
  if (!p || !gesture) return;
  const dx = e.clientX - p.x, dy = e.clientY - p.y, dt = e.timeStamp - p.t;
  Object.assign(p, { x: e.clientX, y: e.clientY, t: e.timeStamp });
  gesture.travel += Math.hypot(dx, dy);
  // The finger count is the gesture's most, so the last finger lifted doesn't jolt the cursor.
  if (gesture.maxFingers === 1) move(dx, dy, dt, e);
  else if (gesture.maxFingers === 2) { if (touches.size === 2) scroll(dx / 2, dy / 2, e); }   // each finger reports half the motion
  else if (touches.size === 3 && !gesture.swiped) {
    gesture.swipeX += dx / 3; gesture.swipeY += dy / 3;
    swipe3(gesture);
  }
});
function lift(e) {
  if (!touches.delete(e.pointerId) || touches.size) return;
  const g = gesture;
  gesture = null;
  if (!g) return;
  if (g.holding) { setButton(MOUSE_BTN.L, false, e); return; }
  if (g.swiped) return;
  const fingers = Math.min(g.maxFingers, 3);
  if (e.timeStamp - g.start > (fingers === 3 ? THREE_TAP_MS : TAP_MS) || g.travel > TAP_TRAVEL * fingers) return;
  if (fingers === 3) shortcut('task-view');
  else if (fingers === 2) click(MOUSE_BTN.R, e);
  else { click(MOUSE_BTN.L, e); lastTapEnd = e.timeStamp; }
}
surface.addEventListener('pointerup', lift);
surface.addEventListener('pointercancel', lift);

// ---------- hold buttons + scroll strip ----------
for (const [id, bit] of [['mouseBtnL', MOUSE_BTN.L], ['mouseBtnM', MOUSE_BTN.M], ['mouseBtnR', MOUSE_BTN.R]]) {
  const b = $(id);
  b.addEventListener('pointerdown', (e) => { capture(b, e); b.classList.add('on'); navigator.vibrate?.(8); setButton(bit, true, e); });
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

export function renderMouse() {
  if (!isOpen(mouseEl)) return;
  const a = summarize(acks.ackRtt.values());
  $('mouseInfo').textContent = `${link.mode} · ack RTT p50 ${fmt(a?.p50)} ms · packets ${st.sent} · sens ${fmt(mouse.sens, 1)}`;
}

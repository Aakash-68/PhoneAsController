// Racing wheel screen. Steering (left stick X) comes from one of
//   touch   – put a finger on the on-screen wheel and turn it; springs back to centre on release
//   tilt    – hold the phone like a wheel and turn the whole phone
//   buttons – hold ◀ / ▶; steering ramps to full lock and returns to centre when released
// Gas pedal = R2, brake pedal = L2 (analog.js modes). Handbrake, indicators and the rest are plain buttons.
import { fmt, summarize, now } from './common.js';
import { $, capture, show, isOpen, MOVE_EVENT, load, save, openOverlay, closeOverlay } from './overlay.js';
import { gp, sendPad, resetPad, detents } from './gamepad.js';
import { motion, onMotion } from './motion.js';
import { pressure, openPressureWizard } from './pressure.js';
import { analogValue, keepsOnRelease, followsMoves } from './analog.js';
import { link, acks } from './net.js';

const wheelEl = $('wheel');
export const wheel = {
  source: 'touch', touchLock: 135, autoCentre: true, centreSpeed: 540,   // touch wheel
  lock: 45, dead: 1.5,                                                  // tilt
  btnRamp: 220, btnReturn: 160,                                         // buttons: ms to full lock / back to centre
  gas: 'slide', brake: 'slide', hbBtn: 0, opacity: 1, layout: {},   // layout: data-eid → { dx, dy (fraction of screen), s }
  ...load('wheel', {}),
  zero: 0, steer: 0, angle: 0,   // angle = on-screen wheel rotation in touch mode (deg, + = right)
};
const SAVED = ['source', 'touchLock', 'autoCentre', 'centreSpeed', 'lock', 'dead', 'btnRamp', 'btnReturn', 'gas', 'brake', 'hbBtn', 'opacity', 'layout'];
const saveWheel = () => save('wheel', Object.fromEntries(SAVED.map((k) => [k, wheel[k]])));

const pedals = {
  gas: { el: $('gasPedal'), which: 'R2', value: 0 },
  brake: { el: $('brakePedal'), which: 'L2', value: 0 },
};

function steerFromTilt(rollDeg) {
  const a = Math.abs(rollDeg);
  if (a <= wheel.dead) return 0;
  return Math.sign(rollDeg) * Math.min(1, (a - wheel.dead) / (wheel.lock - wheel.dead));
}

function commit(tEvent) {
  gp.r2 = pedals.gas.value;
  gp.l2 = pedals.brake.value;
  gp.lx = wheel.steer;
  detents();
  sendPad(false, tEvent);
}
const stamp = (e) => performance.timeOrigin + e.timeStamp;

onMotion((e) => {
  if (!isOpen(wheelEl) || wheel.source !== 'tilt' || motion.raw == null) return;
  wheel.steer = steerFromTilt(motion.raw - wheel.zero);
  commit(stamp(e));
});

// ---------- touch wheel ----------
// Each finger on the wheel turns it by how far it moves around the centre. With two fingers,
// each contributes half, so both thumbs turning together = one smooth rotation.
const grips = new Map();   // pointerId → last angle around the wheel centre (deg)
const touchZone = $('wheelTouch');
function angleAt(e) {
  const r = touchZone.getBoundingClientRect();
  const dx = e.clientX - (r.left + r.width / 2), dy = e.clientY - (r.top + r.height / 2);
  // Near the hub the angle is unstable; ignore those positions.
  return Math.hypot(dx, dy) < r.width * 0.12 ? null : Math.atan2(dx, -dy) * 180 / Math.PI;
}
const wrap180 = (d) => ((d + 540) % 360) - 180;
function setAngle(a) {
  wheel.angle = Math.max(-wheel.touchLock, Math.min(wheel.touchLock, a));
  wheel.steer = wheel.angle / wheel.touchLock;
}

let centring = null;
function startCentring() {
  if (!wheel.autoCentre || centring) return;
  let last = performance.now();
  centring = setInterval(() => {
    const t = performance.now(), step = wheel.centreSpeed * (t - last) / 1000;
    last = t;
    const a = Math.abs(wheel.angle) <= step ? 0 : wheel.angle - Math.sign(wheel.angle) * step;
    setAngle(a);
    commit(now());
    if (a === 0) stopCentring();
  }, 8);
}
function stopCentring() { clearInterval(centring); centring = null; }

// ---------- steer buttons ----------
const held = new Map();   // pointerId → -1 | 1
let ramping = null;
function steerTarget() { let s = 0; for (const d of held.values()) s += d; return Math.sign(s); }
function startRamp() {
  if (ramping) return;
  let last = performance.now();
  ramping = setInterval(() => {
    const t = performance.now(), dt = (t - last) / 1000;
    last = t;
    const target = steerTarget(), s = wheel.steer;
    const back = target === 0 || Math.sign(s) === -target;   // heading to (or through) centre
    const ms = back ? wheel.btnReturn : wheel.btnRamp;
    const step = ms <= 0 ? 2 : dt * 1000 / ms;
    wheel.steer = Math.abs(target - s) <= step ? target : s + Math.sign(target - s) * step;
    commit(now());
    if (!held.size && wheel.steer === 0) stopRamp();
  }, 8);
}
function stopRamp() { clearInterval(ramping); ramping = null; }

// ---------- indicators: tap to toggle the blinker (the game gets a normal button press) ----------
const blink = { l: false, r: false, hz: false };
function toggleBlink(k) {
  blink[k] = !blink[k];
  if (k === 'l' && blink.l) blink.r = false;
  if (k === 'r' && blink.r) blink.l = false;
  wheelEl.querySelector('[data-blink=l]').classList.toggle('blink', blink.l || blink.hz);
  wheelEl.querySelector('[data-blink=r]').classList.toggle('blink', blink.r || blink.hz);
  wheelEl.querySelector('[data-blink=hz]').classList.toggle('blink', blink.hz);
}
function clearBlink() { blink.l = blink.r = blink.hz = false; wheelEl.querySelectorAll('.blink').forEach((b) => b.classList.remove('blink')); }

// ---------- touch: wheel, pedals, buttons ----------
const owners = new Map();   // pointerId → 'wheel' | 'steer' | pedal name | button element
wheelEl.addEventListener('pointerdown', (e) => {
  const pedalEl = e.target.closest('[data-pedal]');
  const steerEl = e.target.closest('[data-steer]');
  const btn = e.target.closest('[data-btn]');
  if (pedalEl) {
    const name = pedalEl.dataset.pedal;
    owners.set(e.pointerId, name);
    pedals[name].value = analogValue(wheel[name], pedalEl, e, pedals[name].which);
    pedalEl.classList.add('held');
  } else if (steerEl && wheel.source === 'buttons') {
    owners.set(e.pointerId, 'steer');
    held.set(e.pointerId, +steerEl.dataset.steer);
    steerEl.classList.add('on');
    startRamp();
  } else if (btn) {
    owners.set(e.pointerId, btn);
    gp.buttons |= 1 << +btn.dataset.btn;
    btn.classList.add('on');
    if (btn.dataset.blink) toggleBlink(btn.dataset.blink);
    navigator.vibrate?.(8);
  } else if (e.target === touchZone && wheel.source === 'touch') {
    owners.set(e.pointerId, 'wheel');
    grips.set(e.pointerId, angleAt(e));
    stopCentring();
  } else return;
  capture(wheelEl, e);
  commit(stamp(e));
});
wheelEl.addEventListener(MOVE_EVENT, (e) => {
  const o = owners.get(e.pointerId);
  if (o === 'wheel') {
    const a = angleAt(e), prev = grips.get(e.pointerId);
    grips.set(e.pointerId, a);
    if (a == null || prev == null) return;
    setAngle(wheel.angle + wrap180(a - prev) / grips.size);
  } else if (typeof o === 'string' && pedals[o] && followsMoves(wheel[o])) {
    pedals[o].value = analogValue(wheel[o], pedals[o].el, e, pedals[o].which);
  } else return;
  commit(stamp(e));
});
function release(e) {
  const o = owners.get(e.pointerId);
  if (o == null) return;
  owners.delete(e.pointerId);
  if (o === 'wheel') {
    grips.delete(e.pointerId);
    if (!grips.size) startCentring();
  } else if (o === 'steer') {
    const d = held.get(e.pointerId);
    held.delete(e.pointerId);
    if (![...held.values()].includes(d)) wheelEl.querySelector(`[data-steer="${d}"]`).classList.remove('on');
    startRamp();
  } else if (typeof o === 'string') {
    if (!keepsOnRelease(wheel[o])) pedals[o].value = 0;
    pedals[o].el.classList.remove('held');
  } else {
    gp.buttons &= ~(1 << +o.dataset.btn);
    o.classList.remove('on');
  }
  commit(stamp(e));
}
wheelEl.addEventListener('pointerup', release);
wheelEl.addEventListener('pointercancel', release);
wheelEl.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- open / close ----------
function centre() {
  if (wheel.source === 'tilt') { if (motion.raw != null) wheel.zero = motion.raw; }
  else { stopCentring(); stopRamp(); held.clear(); setAngle(0); commit(now()); }
}
function resetSteer() {
  stopCentring(); stopRamp();
  grips.clear(); held.clear(); owners.clear();
  wheelEl.querySelectorAll('.on, .held').forEach((b) => b.classList.remove('on', 'held'));
  setAngle(0);
  wheel.steer = 0;
}
async function openWheel() {
  resetPad();
  pedals.gas.value = pedals.brake.value = 0;
  resetSteer();
  clearBlink();
  await openOverlay(wheelEl, 'wheel', () => sendPad(true));
  if (wheel.source === 'tilt') setTimeout(centre, 400);   // hold it straight when opening: that's centre
}
$('wheelOpen').onclick = () => {
  const needsPressure = (wheel.gas === 'pressure' || wheel.brake === 'pressure') && !pressure.cal;
  if (needsPressure) openPressureWizard((saved) => (saved ? openWheel() : null));
  else openWheel();
};
$('wheelClose').onclick = () => { stopCentring(); stopRamp(); wheelEl.classList.remove('editing'); closeOverlay(); };
$('wheelCentre').onclick = centre;

// On-screen Wheel / Tilt / Buttons switch.
async function setSource(v) {
  if (v === 'tilt' && typeof DeviceMotionEvent?.requestPermission === 'function') { try { await DeviceMotionEvent.requestPermission(); } catch {} }
  wheel.source = v;
  $('steerSource').value = v;
  saveWheel();
  resetSteer();
  gp.buttons = 0;
  renderSettings();
  if (isOpen(wheelEl)) { commit(now()); if (v === 'tilt') setTimeout(centre, 400); }
}
$('steerSeg').onclick = (e) => { const b = e.target.closest('button'); if (b) setSource(b.dataset.v); };

// ---------- settings ----------
const FIELDS = {
  steerSource: 'source', touchLock: 'touchLock', autoCentre: 'autoCentre', centreSpeed: 'centreSpeed',
  wheelLock: 'lock', wheelDead: 'dead', btnRamp: 'btnRamp', btnReturn: 'btnReturn',
  gasMode: 'gas', brakeMode: 'brake', hbBtn: 'hbBtn',
};
function renderSettings() {
  $('touchLockV').textContent = wheel.touchLock;
  $('centreSpeedV').textContent = wheel.centreSpeed;
  $('wheelLockV').textContent = wheel.lock;
  $('wheelDeadV').textContent = wheel.dead;
  $('btnRampV').textContent = wheel.btnRamp;
  $('btnReturnV').textContent = wheel.btnReturn;
  show('touchSteerSettings', wheel.source === 'touch');
  show('tiltSteerSettings', wheel.source === 'tilt');
  show('btnSteerSettings', wheel.source === 'buttons');
  wheelEl.dataset.steermode = wheel.source;
  $('hbrake').dataset.btn = wheel.hbBtn;
  document.querySelectorAll('#steerSeg button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === wheel.source));
}
for (const [id, key] of Object.entries(FIELDS)) {
  const el = $(id);
  if (el.type === 'checkbox') el.checked = wheel[key]; else el.value = wheel[key];
  el.addEventListener('input', () => {
    if (key === 'source') return setSource(el.value);
    wheel[key] = el.type === 'checkbox' ? el.checked : el.tagName === 'SELECT' && key !== 'hbBtn' ? el.value : +el.value;
    renderSettings();
    saveWheel();
  });
}
renderSettings();

// ---------- render ----------
export function renderWheel() {
  if (!$('view-wheelinfo').classList.contains('hidden') && wheel.source === 'tilt') {
    $('wheelLive').textContent = motion.raw == null
      ? (isSecureContext ? 'no motion sensor data' : 'motion needs the https page')
      : `roll ${fmt(motion.raw, 1)}° → steer ${Math.round(steerFromTilt(motion.raw - wheel.zero) * 100)}% (open the wheel to centre it)`;
  }
  if (!isOpen(wheelEl)) return;
  const a = summarize(acks.ackRtt.values());
  const warn = wheel.source === 'tilt' && motion.raw == null ? ' · tilt needs the motion sensor: open the https address' : '';
  $('wheelInfo').textContent = `${link.mode} · ack RTT p50 ${fmt(a?.p50)} ms · gas ${Math.round(gp.r2 * 100)}% · brake ${Math.round(gp.l2 * 100)}%${warn}`;
  renderHud();
  for (const p of Object.values(pedals)) p.el.style.setProperty('--fill', `${p.value * 100}%`);
}

// Touch / buttons: the wheel graphic itself rotates; the arc runs from 12 o'clock to the top stripe.
// Tilt: the rim is fixed to the screen (the phone is the wheel); the horizon and pointer
// show the real world's "up", so as you turn right they swing left.
const R_ARC = 101;
const BTN_VIEW = 90;   // buttons mode: full lock is drawn as a quarter turn
const at = (deg) => { const r = deg * Math.PI / 180; return `${(R_ARC * Math.sin(r)).toFixed(2)} ${(-R_ARC * Math.cos(r)).toFixed(2)}`; };
let hudLockFor = null;
function renderHud() {
  const tilt = wheel.source === 'tilt', touch = wheel.source === 'touch';
  const lock = tilt ? wheel.lock : touch ? wheel.touchLock : BTN_VIEW;
  const angle = tilt ? (motion.raw == null ? 0 : motion.raw - wheel.zero) : touch ? wheel.angle : wheel.steer * BTN_VIEW;
  const shown = Math.max(-Math.min(lock * 1.4, 359), Math.min(Math.min(lock * 1.4, 359), angle));
  const phi = tilt ? -shown : shown;   // where the arc ends on screen; SVG rotate() is clockwise-positive

  $('hudWheel').setAttribute('transform', tilt ? '' : `rotate(${shown})`);
  show('hudHorizon', tilt);
  show('hudPointer', tilt);
  if (tilt) {
    $('hudHorizon').setAttribute('transform', `rotate(${phi})`);
    $('hudPointer').setAttribute('transform', `rotate(${phi})`);
  }
  const mag = Math.abs(wheel.steer);
  const arc = $('hudArc');
  arc.setAttribute('d', Math.abs(phi) < 0.5 ? '' : `M ${at(0)} A ${R_ARC} ${R_ARC} 0 ${Math.abs(phi) > 180 ? 1 : 0} ${phi > 0 ? 1 : 0} ${at(phi)}`);
  arc.style.stroke = mag < 0.6 ? 'var(--player)' : mag < 0.95 ? '#c49a45' : '#c8714f';
  const lockKey = `${wheel.source}:${lock}`;
  if (hudLockFor !== lockKey) {
    hudLockFor = lockKey;
    // Lock marks sit where full steer is reached (overlapping marks past ±180° are left out).
    $('hudLock').innerHTML = lock >= 180 ? '' : [-1, 1].map((s) => `<line class="lock" transform="rotate(${s * lock})" x1="0" y1="-97" x2="0" y2="-107"/>`).join('');
  }
  $('hudPct').textContent = `${Math.round(mag * 100)}`;
  $('hudDir').textContent = wheel.steer < 0 ? '◀' : wheel.steer > 0 ? '▶' : '';
  $('hudDeg').textContent = `${fmt(angle, 0)}° of ±${lock}°`;
}

// ---------- Wheel HUD sheet: pedal modes, opacity, layout ----------
const sheet = $('wheelSheet');
const segPick = (id, v) => $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === v));
function syncSheet() {
  segPick('wsGas', wheel.gas); segPick('wsBrake', wheel.brake);
  $('wsOpacity').value = Math.round(wheel.opacity * 100); $('wsOpacityV').textContent = `${Math.round(wheel.opacity * 100)}%`;
}
document.addEventListener('click', (e) => { if (e.target.closest('.wheelHudOpen')) { syncSheet(); sheet.classList.remove('hidden'); } });
$('wsClose').onclick = () => sheet.classList.add('hidden');
function setPedalMode(name, v) {
  wheel[name] = v;
  $(name === 'gas' ? 'gasMode' : 'brakeMode').value = v;
  pedals[name].value = 0;
  saveWheel(); syncSheet(); commit(now());
  if (v === 'pressure' && !pressure.cal) { sheet.classList.add('hidden'); openPressureWizard(() => {}); }
}
$('wsGas').onclick = (e) => { const b = e.target.closest('button'); if (b) setPedalMode('gas', b.dataset.v); };
$('wsBrake').onclick = (e) => { const b = e.target.closest('button'); if (b) setPedalMode('brake', b.dataset.v); };
$('wsOpacity').oninput = (e) => { wheel.opacity = +e.target.value / 100; saveWheel(); syncSheet(); applyLayout(); };
$('wsReset').onclick = () => { wheel.layout = {}; saveWheel(); applyLayout(); };
$('wsEdit').onclick = () => { sheet.classList.add('hidden'); wheelEl.classList.add('editing'); };
// The pedal selects in the settings tab change the same values.
for (const [id, name] of [['gasMode', 'gas'], ['brakeMode', 'brake']]) $(id).addEventListener('input', syncSheet);

// ---------- edit layout: drag a control to move it, − / + to resize ----------
const scaleOf = (el) => wheel.layout[el.dataset.eid]?.s ?? 1;
function applyLayout() {
  wheelEl.style.setProperty('--wop', wheel.opacity);
  for (const el of wheelEl.querySelectorAll('[data-eid]')) {
    const o = wheel.layout[el.dataset.eid];
    if (!o) { el.style.transform = ''; continue; }
    // Controls inside the wheel group are drawn in its (scaled) space: undo that so a drag follows the finger.
    const ps = el.parentElement.closest('[data-eid]') ? scaleOf(el.parentElement.closest('[data-eid]')) : 1;
    el.style.transform = `translate(${((o.dx ?? 0) * innerWidth / ps).toFixed(1)}px, ${((o.dy ?? 0) * innerHeight / ps).toFixed(1)}px) scale(${o.s ?? 1})`;
  }
}
addEventListener('resize', applyLayout);
applyLayout();

let esel = null, edrag = null;
function eselect(el) {
  wheelEl.querySelectorAll('.is-sel').forEach((x) => x.classList.remove('is-sel'));
  esel = el; el?.classList.add('is-sel');
  $('wSel').textContent = el ? el.dataset.name : 'Drag a control to move it';
}
const editing = () => wheelEl.classList.contains('editing');
// Capture phase: while editing, the controls must not send input.
wheelEl.addEventListener('pointerdown', (e) => {
  if (!editing() || e.target.closest('.editbar, .island, .exit, .steerseg, .pillbtn')) return;
  e.stopPropagation();
  const el = e.target.closest('[data-eid]');
  eselect(el);
  if (!el) return;
  const o = (wheel.layout[el.dataset.eid] ??= {});
  edrag = { o, x: e.clientX, y: e.clientY, dx: o.dx ?? 0, dy: o.dy ?? 0 };
  capture(wheelEl, e);
}, true);
for (const type of new Set(['pointermove', MOVE_EVENT])) wheelEl.addEventListener(type, (e) => {
  if (!edrag) return;
  e.stopPropagation();
  edrag.o.dx = edrag.dx + (e.clientX - edrag.x) / innerWidth;
  edrag.o.dy = edrag.dy + (e.clientY - edrag.y) / innerHeight;
  applyLayout();
}, true);
wheelEl.addEventListener('pointerup', (e) => { if (edrag) { edrag = null; saveWheel(); e.stopPropagation(); } }, true);
const eresize = (f) => {
  if (!esel) return;
  const o = (wheel.layout[esel.dataset.eid] ??= {});
  o.s = Math.max(0.5, Math.min(1.8, (o.s ?? 1) * f));
  saveWheel(); applyLayout();
};
$('wUp').onclick = () => eresize(1.08);
$('wDown').onclick = () => eresize(1 / 1.08);
$('wReset').onclick = () => { wheel.layout = {}; saveWheel(); applyLayout(); };
$('wDone').onclick = () => { wheelEl.classList.remove('editing'); eselect(null); };

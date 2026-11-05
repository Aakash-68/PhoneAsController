// DS4-style pad screen: sticks, buttons, L2/R2 from tilt and/or pressure, tilt calibration.
import { fmt, summarize } from './common.js';
import { $, capture, show, isOpen, MOVE_EVENT, load, save, openOverlay, closeOverlay, exitFullscreen } from './overlay.js';
import { gp, sendPad, resetPad, detents, haptics } from './gamepad.js';
import { motion, onMotion, motionHz, MOTION_HELP } from './motion.js';
import { openWizard } from './wizard.js';
import { pressure, openPressureWizard } from './pressure.js';
import { analogValue, keepsOnRelease, followsMoves } from './analog.js';
import { link, acks } from './net.js';
import { layoutPad } from './hud.js';

const padEl = $('pad');

// ---------- tilt triggers ----------
// cal: { rest, R:[0,50,100], L:[0,50,100] } — angles relative to rest (midpoint of the two 0% poses).
export const tilt = { on: true, dead: 5, full: 30, zero: 0, cal: null, ...load('tilt', {}) };
tilt.cal = load('calib', null);
tilt.zero = tilt.cal?.rest ?? 0;
const saveTilt = () => save('tilt', { on: tilt.on, dead: tilt.dead, full: tilt.full });

export const roll = () => (motion.raw == null ? null : motion.raw - tilt.zero);

// Piecewise-linear response through 0/50/100% points. Works for either tilt direction.
export function curve(x, [p0, p50, p100]) {
  if (p100 < p0) { x = -x; p0 = -p0; p50 = -p50; p100 = -p100; }
  if (x <= p0) return 0;
  if (x <= p50) return 0.5 * (x - p0) / (p50 - p0);
  if (x <= p100) return 0.5 + 0.5 * (x - p50) / (p100 - p50);
  return 1;
}

function tiltValues() {
  const r = roll();
  if (!tilt.on || r == null) return { L: 0, R: 0 };
  if (tilt.cal) return { L: curve(r, tilt.cal.L), R: curve(r, tilt.cal.R) };
  const amount = (deg) => Math.min(1, Math.max(0, (deg - tilt.dead) / (tilt.full - tilt.dead)));
  return { L: amount(-r), R: amount(r) };
}

// On-screen L2/R2 sliders (analog.js modes). Final trigger = max(slider, tilt).
export const padTrig = { mode: load('padTrigMode', 'slide') };
const pressed = { L2: 0, R2: 0 };
function updateTriggers() {
  const t = tiltValues();
  gp.l2 = Math.max(pressed.L2, t.L);
  gp.r2 = Math.max(pressed.R2, t.R);
}

// ---------- touch controls ----------
const owners = new Map();   // pointerId → control element (hit-tested once on down)

function setStick(el, e) {
  const r = el.getBoundingClientRect();
  let x = (e.clientX - (r.left + r.width / 2)) / (r.width / 2);
  let y = (e.clientY - (r.top + r.height / 2)) / (r.height / 2);
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  const k = el.dataset.stick;
  gp[k + 'x'] = x; gp[k + 'y'] = y;
  el.style.setProperty('--x', x.toFixed(3)); el.style.setProperty('--y', y.toFixed(3));
  el.style.setProperty('--m', Math.min(1, Math.hypot(x, y)).toFixed(3));
  el.style.setProperty('--ang', `${(Math.atan2(y, x) * 180 / Math.PI).toFixed(1)}deg`);
}
// Double-tap a stick and hold = click it (L3 / R3), like pressing a real stick down.
const lastUp = { l: -1e9, r: -1e9 };
const STICK_BIT = { l: 14, r: 15 };

const stamp = (e) => performance.timeOrigin + e.timeStamp;
function commit(e) { updateTriggers(); detents(); sendPad(false, stamp(e)); }

padEl.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('[data-btn],[data-stick],[data-trigger]');
  if (!el) return;
  capture(padEl, e);
  owners.set(e.pointerId, el);
  if (el.dataset.stick) {
    const k = el.dataset.stick;
    if (e.timeStamp - lastUp[k] < 300) { gp.buttons |= 1 << STICK_BIT[k]; el.classList.add('clicked'); navigator.vibrate?.(12); }
    el.classList.add('held');
    setStick(el, e);
  }
  else if (el.dataset.trigger) pressed[el.dataset.trigger] = analogValue(padTrig.mode, el, e, el.dataset.trigger);
  else { gp.buttons |= 1 << +el.dataset.btn; el.classList.add('on'); navigator.vibrate?.(6); }
  commit(e);
});
padEl.addEventListener(MOVE_EVENT, (e) => {
  const el = owners.get(e.pointerId);
  if (!el) return;
  if (el.dataset.stick) setStick(el, e);
  else if (el.dataset.trigger && followsMoves(padTrig.mode)) pressed[el.dataset.trigger] = analogValue(padTrig.mode, el, e, el.dataset.trigger);
  else return;
  commit(e);
});
function release(e) {
  const el = owners.get(e.pointerId);
  if (!el) return;
  owners.delete(e.pointerId);
  if (el.dataset.stick) {
    const k = el.dataset.stick;
    gp[k + 'x'] = 0; gp[k + 'y'] = 0;
    gp.buttons &= ~(1 << STICK_BIT[k]);
    lastUp[k] = el.classList.contains('clicked') ? -1e9 : e.timeStamp;
    el.classList.remove('held', 'clicked');
    for (const v of ['--x', '--y', '--m']) el.style.setProperty(v, '0');
  }
  else if (el.dataset.trigger) { if (!keepsOnRelease(padTrig.mode)) pressed[el.dataset.trigger] = 0; }
  else { gp.buttons &= ~(1 << +el.dataset.btn); el.classList.remove('on'); }
  commit(e);
}
padEl.addEventListener('pointerup', release);
padEl.addEventListener('pointercancel', release);
padEl.addEventListener('contextmenu', (e) => e.preventDefault());

onMotion((e) => { if (isOpen(padEl)) commit(e); });

// ---------- open / close ----------
export async function openPad() {
  resetPad();
  pressed.L2 = pressed.R2 = 0;
  await openOverlay(padEl, 'pad', () => sendPad(true));
  layoutPad();
  // Uncalibrated: take the natural grip as zero once the rotation settles. Calibrated: keep the recorded rest.
  if (!tilt.cal) setTimeout(zeroTilt, 400);
}
function zeroTilt() { if (motion.raw != null) tilt.zero = motion.raw; }

$('padOpen').onclick = () => {
  // Calibrate whatever the chosen trigger input needs before playing.
  if (padTrig.mode === 'pressure' && !pressure.cal) openPressureWizard((saved) => saved && openPad());
  else if (tilt.on && !tilt.cal && motion.raw != null) openTiltWizard(true);
  else openPad();
};
$('padTrigMode').value = padTrig.mode;
$('padTrigMode').onchange = (e) => { padTrig.mode = e.target.value; save('padTrigMode', padTrig.mode); };
$('padClose').onclick = () => closeOverlay();
$('padZero').onclick = zeroTilt;

// ---------- settings UI ----------
function bindSettings() {
  $('tiltOn').checked = tilt.on;
  $('tiltDead').value = tilt.dead;
  $('tiltFull').value = tilt.full;
  const apply = () => {
    tilt.on = $('tiltOn').checked;
    tilt.dead = +$('tiltDead').value;
    tilt.full = Math.max(tilt.dead + 1, +$('tiltFull').value);
    $('tiltDeadV').textContent = tilt.dead;
    $('tiltFullV').textContent = tilt.full;
    saveTilt();
  };
  ['tiltOn', 'tiltDead', 'tiltFull'].forEach((id) => $(id).addEventListener('input', apply));
  apply();
  haptics.on = load('haptics', true);
  $('hapticDetents').checked = haptics.on;
  $('hapticDetents').onchange = (e) => { haptics.on = e.target.checked; save('haptics', haptics.on); };
  $('calibStart').onclick = () => openTiltWizard(false);
  $('calibReset').onclick = () => { tilt.cal = null; tilt.zero = 0; save('calib', null); renderTiltStatus(); };
}

function renderTiltStatus() {
  const s = tilt.cal;
  $('calibStatus').innerHTML = s
    ? `Calibrated ✓ R2 ${s.R.map((v) => fmt(v + s.rest, 1)).join(' / ')}° · L2 ${s.L.map((v) => fmt(v + s.rest, 1)).join(' / ')}° <span class="muted">(0 / 50 / 100%)</span>`
    : '<span class="muted">Not calibrated: using the dead zone / full-press sliders.</span>';
  show('defaultCurve', !s);
}

// ---------- tilt calibration wizard ----------
const MIN_GAP = 3;   // degrees between consecutive points
const TILT_STEPS = [
  ['R', 0, 'Hold the phone how you play. Tilt the RIGHT side down just to where R2 should START pressing (or keep it level).'],
  ['R', 50, 'Tilt the RIGHT side down to where R2 should be HALF pressed.'],
  ['R', 100, 'Tilt the RIGHT side down to where R2 should be FULLY pressed.'],
  ['L', 0, 'Back to your grip. Tilt the LEFT side down just to where L2 should START pressing (or keep it level).'],
  ['L', 50, 'Tilt the LEFT side down to where L2 should be HALF pressed.'],
  ['L', 100, 'Tilt the LEFT side down to where L2 should be FULLY pressed.'],
].map(([t, pct, hint], i) => ({
  t, pct, hint, title: `${t}2 · ${pct}%`,
  sample: () => motion.raw,
  ready: () => (motion.raw == null ? (isSecureContext ? 'No motion sensor data.' : MOTION_HELP) : null),
  describe: (r) => `<b>${fmt(r.value, 1)}°</b> <span class="muted">(±${fmt(r.sd.v, 1)}° wobble)</span>`,
  unsteady: (r) => r.sd.v > 1.5,
  // Each point must be ≥ MIN_GAP further in the trigger's direction than the previous one.
  validate: pct === 0 ? null : (r, recs) => {
    const prev = recs[i - 1].value, dir = t === 'R' ? 1 : -1;
    return (r.value - prev) * dir < MIN_GAP
      ? `Must tilt at least ${MIN_GAP}° further ${t === 'R' ? 'right' : 'left'} than the ${pct === 50 ? 0 : 50}% point (${fmt(prev, 1)}°). Retry.`
      : null;
  },
}));

function openTiltWizard(thenPad) {
  openWizard({
    name: 'Tilt',
    steps: TILT_STEPS,
    drawGauge({ ctx, w, h }, { recs, sampling, steps }) {
      const span = 60, X = (deg) => ((Math.max(-span, Math.min(span, deg)) + span) / (2 * span)) * w;
      ctx.fillStyle = '#8a93a6'; ctx.font = '10px system-ui';
      for (let d = -60; d <= 60; d += 15) { ctx.fillRect(X(d), h - 14, 1, 4); ctx.fillText(`${d}`, X(d) + 2, h - 2); }
      ctx.fillText('◀ L2', 4, 12); ctx.fillText('R2 ▶', w - 30, 12);
      recs.forEach((r, i) => {
        if (!r) return;
        ctx.fillStyle = steps[i].t === 'R' ? '#60a5fa' : '#fb923c';
        ctx.fillRect(X(r.value) - 1, 16, 2, h - 34);
        ctx.fillText(`${steps[i].pct}`, X(r.value) + 3, 26);
      });
      if (motion.raw != null) {
        ctx.fillStyle = sampling ? '#f87171' : '#4ade80';
        ctx.fillRect(X(motion.raw) - 2, 10, 4, h - 24);
        ctx.fillText(`${fmt(motion.raw, 1)}°`, Math.min(w - 40, X(motion.raw) + 6), h - 20);
      }
    },
    summary(recs) {
      const r = recs.map((x) => x.value);
      const rest = (r[0] + r[3]) / 2;
      const R = r.slice(0, 3).map((v) => v - rest), L = r.slice(3).map((v) => v - rest);
      // Push each 0% point slightly past its wobble so a resting hand reads exactly 0%.
      R[0] += Math.max(0.5, 2 * recs[0].sd.v);
      L[0] -= Math.max(0.5, 2 * recs[3].sd.v);
      const pending = { rest, R, L };
      return {
        title: 'Your trigger curves',
        head: ['', '0%', '50%', '100%'],
        rows: [['R2', ...r.slice(0, 3).map((v) => `${fmt(v, 1)}°`)], ['L2', ...r.slice(3).map((v) => `${fmt(v, 1)}°`)]],
        draw: (c) => drawCurves(c, pending),
        pending,
      };
    },
    redo: [{ label: 'Redo R2', from: 0, to: 2 }, { label: 'Redo L2', from: 3, to: 5 }],
    onSave(pending) {
      tilt.cal = pending;
      tilt.zero = pending.rest;
      save('calib', pending);
      renderTiltStatus();
    },
    after: (saved) => (saved && thenPad ? openPad() : exitFullscreen()),
  });
}

function drawCurves({ ctx, w, h }, { R, L }) {
  const span = Math.max(30, ...R.map(Math.abs), ...L.map(Math.abs)) + 10;
  const X = (deg) => ((deg + span) / (2 * span)) * w, Y = (v) => h - 12 - v * (h - 24);
  ctx.strokeStyle = '#262d3d'; ctx.beginPath(); ctx.moveTo(X(0), 0); ctx.lineTo(X(0), h); ctx.stroke();
  for (const [p, color] of [[R, '#60a5fa'], [L, '#fb923c']]) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let d = -span; d <= span; d += 0.5) { const y = Y(curve(d, p)); d === -span ? ctx.moveTo(X(d), y) : ctx.lineTo(X(d), y); }
    ctx.stroke();
    ctx.fillStyle = color;
    p.forEach((deg, i) => ctx.fillRect(X(deg) - 3, Y(i / 2) - 3, 6, 6));
  }
  ctx.fillStyle = '#8a93a6'; ctx.font = '10px system-ui';
  ctx.fillText('◀ left down (L2)', 4, 12); ctx.fillText('right down (R2) ▶', w - 92, 12); ctx.fillText('0°', X(0) + 3, h - 2);
}

bindSettings();
renderTiltStatus();

// ---------- render (called every frame) ----------
export function motionText() {
  const hz = motionHz();
  if (motion.raw == null) return isSecureContext ? 'no motion sensor data' : MOTION_HELP;
  const t = tiltValues();
  return `tilt ${fmt(roll(), 0)}° · L2 ${Math.round(t.L * 100)}% · R2 ${Math.round(t.R * 100)}% · sensor ${hz ? fmt(hz, 0) : '–'} Hz`;
}

export function renderPad() {
  if (!$('view-padinfo').classList.contains('hidden')) $('tiltLive').textContent = motionText();
  if (!isOpen(padEl)) return;
  const a = summarize(acks.ackRtt.values());
  $('padInfo').textContent = `${link.mode} · sent ${gp.sent} · ack RTT p50 ${fmt(a?.p50)} ms · ${motionText()}`;
  for (const [id, v] of [['l2Btn', gp.l2], ['r2Btn', gp.r2]]) {
    const el = $(id);
    el.style.setProperty('--v', v.toFixed(3));
    el.classList.toggle('active', v > 0.02);
    el.querySelector('.tv').textContent = `${Math.round(v * 100)}%`;
  }
}

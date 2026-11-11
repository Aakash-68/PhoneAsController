// Tilt triggers: dip the right side for R2, the left side for L2 (L2 is the mirror of R2 around the rest angle).
// Exports used by pad.js (names/signatures are fixed):
//   tilt                       – settings object ({ on, dead, full, pts, rest, zero })
//   tiltValues() → { L, R }    – 0..1 each, from motion.raw (O(1): precomputed lookup)
//   tiltNeedsCalibration()     – always false: defaults + auto-zero on pad open work without the wizard
//   openTiltWizard(thenPad, openPad) – thenPad: call openPad() after saving
//   onPadOpen()                – pad just opened (auto-zero the grip if no rest angle is saved)
//   zeroTilt()                 – "Zero tilt": current angle becomes the saved rest angle
//   motionText()               – one-line status for the pad info bar
//   renderTiltLive()           – called every frame (live readout + range editor, only while visible)
// The settings UI is rendered into #set-tilt from here.
//
// Model: d = |roll - rest| in degrees (roll sign picks R2 / L2). d ≤ dead → 0, d ≥ full → 1, between them
// a monotone curve through user points pts = [[u, v], …] with u, v in 0..1 normalised to the dead..full span,
// so moving the dead zone or the 100% point keeps the curve's shape. Saved as save('tilt', …).
import { fmt } from './common.js';
import { $, load, save, exitFullscreen, setupCanvas, capture } from './overlay.js';
import { haptics } from './gamepad.js';
import { motion, motionHz, MOTION_HELP } from './motion.js';
import { openWizard } from './wizard.js';

const DEF = { dead: 5, full: 30 };
const MIN_SPAN = 2, MAX_FULL = 80, MAX_PTS = 8, U_GAP = 0.02;
const COL = { R: '#60a5fa', L: '#fb923c', line: '#2c2f35', muted: '#7d818a', text: '#e9eaee', accent: '#c8714f', bg: '#0a0b0d' };

// ---------- settings + migration ----------
const clamp = (v, a, b) => Math.min(b, Math.max(a, v));
const stored = load('tilt', {});
export const tilt = {
  on: stored.on ?? true,
  dead: num(stored.dead, DEF.dead),
  full: num(stored.full, DEF.full),
  pts: Array.isArray(stored.pts) ? stored.pts.filter((p) => Array.isArray(p) && p.length === 2) : [],
  rest: typeof stored.rest === 'number' ? stored.rest : null,   // saved rest angle (calibrated or zeroed), null = auto-zero
  zero: 0,                                                         // rest angle in use right now
};
function num(v, d) { return typeof v === 'number' && Number.isFinite(v) ? v : d; }

// Old format: calib = { rest, R: [0%, 50%, 100%], L: [...] } relative to rest. Fold it into dead/full/one curve point.
const old = load('calib', null);
if (old && Array.isArray(old.R) && old.R.length === 3 && Array.isArray(old.L) && old.L.length === 3) {
  const avg2 = (a, b) => (a + b) / 2;
  const dead = Math.max(0, avg2(old.R[0], -old.L[0])), full = avg2(old.R[2], -old.L[2]), half = avg2(old.R[1], -old.L[1]);
  if (full - dead >= MIN_SPAN) {
    tilt.rest = old.rest; tilt.dead = r1(dead); tilt.full = r1(full);
    const u = (half - dead) / (full - dead);
    tilt.pts = u > U_GAP && u < 1 - U_GAP ? [[r3(u), 0.5]] : [];
  }
  save('calib', null);
}
sanitize();
tilt.zero = tilt.rest ?? 0;

function r1(v) { return Math.round(v * 10) / 10; }
function r3(v) { return Math.round(v * 1000) / 1000; }

function sanitize() {
  tilt.full = clamp(tilt.full, MIN_SPAN, MAX_FULL);
  tilt.dead = clamp(tilt.dead, 0, tilt.full - MIN_SPAN);
  const pts = tilt.pts.map(([u, v]) => [r3(clamp(+u || 0, U_GAP, 1 - U_GAP)), r3(clamp(+v || 0, 0, 1))]).sort((a, b) => a[0] - b[0]);
  const out = [];
  let pu = 0, pv = 0;
  for (const [u, v] of pts) {
    if (u - pu < U_GAP || out.length >= MAX_PTS) continue;
    const vv = Math.max(pv, v);
    out.push([u, vv]); pu = u; pv = vv;
  }
  tilt.pts = out;
}

const saveTilt = () => save('tilt', { on: tilt.on, dead: tilt.dead, full: tilt.full, pts: tilt.pts, rest: tilt.rest });

// ---------- curve: monotone cubic (Fritsch–Carlson) through (0,0), pts…, (1,1) → lookup table ----------
const LUT_N = 256;
const lut = new Float32Array(LUT_N + 1);
let lutDead = 0, lutFull = 1, lutInv = 1;

export function curveFn(pts) {
  const xs = [0, ...pts.map((p) => p[0]), 1], ys = [0, ...pts.map((p) => p[1]), 1], n = xs.length;
  const d = [], m = new Array(n);
  for (let k = 0; k < n - 1; k++) d[k] = (ys[k + 1] - ys[k]) / (xs[k + 1] - xs[k]);
  m[0] = d[0]; m[n - 1] = d[n - 2];
  for (let k = 1; k < n - 1; k++) m[k] = d[k - 1] * d[k] <= 0 ? 0 : (d[k - 1] + d[k]) / 2;
  for (let k = 0; k < n - 1; k++) {
    if (d[k] === 0) { m[k] = m[k + 1] = 0; continue; }
    const a = m[k] / d[k], b = m[k + 1] / d[k], s = a * a + b * b;
    if (s > 9) { const t = 3 / Math.sqrt(s); m[k] = t * a * d[k]; m[k + 1] = t * b * d[k]; }
  }
  return (u) => {
    if (u <= 0) return 0;
    if (u >= 1) return 1;
    let k = 0;
    while (k < n - 2 && u > xs[k + 1]) k++;
    const h = xs[k + 1] - xs[k], t = (u - xs[k]) / h, t2 = t * t, t3 = t2 * t;
    return clamp((2 * t3 - 3 * t2 + 1) * ys[k] + (t3 - 2 * t2 + t) * h * m[k] + (-2 * t3 + 3 * t2) * ys[k + 1] + (t3 - t2) * h * m[k + 1], 0, 1);
  };
}

function rebuild() {
  const f = curveFn(tilt.pts);
  for (let i = 0; i <= LUT_N; i++) lut[i] = f(i / LUT_N);
  lutDead = tilt.dead; lutFull = tilt.full; lutInv = 1 / (tilt.full - tilt.dead);
  dirty = true;
}

// Output 0..1 for |degrees| past rest.
export function amount(deg) {
  if (deg <= lutDead) return 0;
  if (deg >= lutFull) return 1;
  const f = (deg - lutDead) * lutInv * LUT_N, i = f | 0;
  return lut[i] + (lut[i + 1] - lut[i]) * (f - i);
}

const roll = () => (motion.raw == null ? null : motion.raw - tilt.zero);

export function tiltValues() {
  const r = motion.raw;
  if (!tilt.on || r == null) return { L: 0, R: 0 };
  const d = r - tilt.zero;
  return d >= 0 ? { L: 0, R: amount(d) } : { L: amount(-d), R: 0 };
}

// Defaults (dead 5°, full 30°) plus auto-zero on pad open are playable, so the wizard is optional.
export const tiltNeedsCalibration = () => false;
export function zeroTilt() {
  if (motion.raw == null) return;
  tilt.zero = tilt.rest = r1(motion.raw);
  saveTilt(); renderStatus(); dirty = true;
}
export function onPadOpen() { if (tilt.rest == null) setTimeout(() => { if (motion.raw != null) tilt.zero = motion.raw; }, 400); }

// ---------- settings card ----------
const card = $('set-tilt');
card.innerHTML = `
  <h3>Tilt triggers</h3>
  <p class="small muted">Dip the <b>right</b> side down for <b>RT / R2</b>, the <b>left</b> side for <b>LT / L2</b> (mirrored). More tilt = harder press.</p>
  <label class="row"><input type="checkbox" id="tiltOn"> Enable tilt triggers</label>
  <label class="row"><input type="checkbox" id="hapticDetents"> Haptic clicks at 50% and 100%</label>
  <canvas id="tiltEditor" class="tl-editor" aria-label="Tilt response curve editor"></canvas>
  <div class="small muted tl-hint" id="tiltHint"></div>
  <div class="tl-nums">
    <div class="tl-num"><span class="small muted">Dead zone</span>
      <button data-k="dead" data-d="-0.5" aria-label="Smaller dead zone">−</button><b id="tiltDeadV"></b><button data-k="dead" data-d="0.5" aria-label="Larger dead zone">+</button></div>
    <div class="tl-num"><span class="small muted">100% at</span>
      <button data-k="full" data-d="-0.5" aria-label="Full press sooner">−</button><b id="tiltFullV"></b><button data-k="full" data-d="0.5" aria-label="Full press later">+</button></div>
  </div>
  <div class="row wrap tl-actions">
    <button class="primary" id="calibStart">Calibrate</button>
    <button id="tiltZero">Zero tilt</button>
    <button id="tiltCurveReset">Reset curve</button>
    <button id="tiltDefaults">Defaults</button>
  </div>
  <div class="small" id="calibStatus"></div>
  <div class="small muted" id="tiltLive">waiting for motion sensor…</div>`;

const cv = $('tiltEditor');
let dirty = true, lastW = 0, lastRoll = NaN, drag = null, span = 60;

function changed(persist = true) {
  sanitize(); rebuild();
  $('tiltDeadV').textContent = `${fmt(tilt.dead, 1)}°`;
  $('tiltFullV').textContent = `${fmt(tilt.full, 1)}°`;
  $('tiltHint').textContent = tilt.pts.length
    ? `${tilt.pts.length} point${tilt.pts.length > 1 ? 's' : ''} · drag to move, tap one to delete`
    : 'Straight line · tap the curve area to add a point';
  if (persist) saveTilt();
}

function renderStatus() {
  $('calibStatus').innerHTML = tilt.rest != null
    ? `Rest angle ${fmt(tilt.rest, 1)}° <span class="muted">· L2 mirrors R2 (${fmt(tilt.rest - tilt.full, 1)}° … ${fmt(tilt.rest + tilt.full, 1)}°)</span>`
    : '<span class="muted">Rest angle: auto-zero when the pad opens. Calibrate or Zero tilt to fix it.</span>';
}

$('tiltOn').checked = tilt.on;
$('tiltOn').onchange = (e) => { tilt.on = e.target.checked; saveTilt(); };
haptics.on = load('haptics', true);
$('hapticDetents').checked = haptics.on;
$('hapticDetents').onchange = (e) => { haptics.on = e.target.checked; save('haptics', haptics.on); };
card.querySelectorAll('.tl-num button').forEach((b) => {
  b.onclick = () => {
    const k = b.dataset.k, v = r1(tilt[k] + +b.dataset.d);
    if (k === 'dead') tilt.dead = clamp(v, 0, tilt.full - MIN_SPAN);
    else tilt.full = clamp(v, tilt.dead + MIN_SPAN, MAX_FULL);
    changed();
  };
});
$('calibStart').onclick = () => openTiltWizard(false);
$('tiltZero').onclick = zeroTilt;
$('tiltCurveReset').onclick = () => { tilt.pts = []; changed(); };
$('tiltDefaults').onclick = () => {
  Object.assign(tilt, { dead: DEF.dead, full: DEF.full, pts: [], rest: null, zero: 0 });
  changed(); renderStatus();
};

// ---------- range editor (canvas) ----------
// Top: curve plot (output 0..100% vs degrees). Bottom: range bar with the dead-zone and 100% handles.
const BAR_H = 22, AXIS_H = 14, PAD_L = 30, PAD_R = 12, PAD_T = 10;
function geom(w, h) {
  const x0 = PAD_L, x1 = w - PAD_R, barY = h - AXIS_H - BAR_H, plotB = barY - 10;
  return { x0, x1, barY, plotT: PAD_T, plotB, X: (deg) => x0 + (deg / span) * (x1 - x0), D: (px) => ((px - x0) / (x1 - x0)) * span, Y: (v) => plotB - v * (plotB - PAD_T), V: (py) => (plotB - py) / (plotB - PAD_T) };
}
const spanFor = () => Math.max(60, Math.ceil((tilt.full + 10) / 10) * 10);

function draw() {
  if (!drag) span = spanFor();
  const { ctx, w, h } = setupCanvas(cv);
  const g = geom(w, h), { X, Y } = g;
  const xd = X(tilt.dead), xf = X(tilt.full);
  ctx.font = '10px "Space Mono", ui-monospace, monospace';
  ctx.textBaseline = 'alphabetic';

  // grid
  ctx.fillStyle = COL.muted; ctx.strokeStyle = COL.line; ctx.lineWidth = 1;
  for (const v of [0, 0.5, 1]) {
    ctx.beginPath(); ctx.moveTo(g.x0, Y(v) + 0.5); ctx.lineTo(g.x1, Y(v) + 0.5); ctx.stroke();
    ctx.fillText(`${v * 100}`, 2, Y(v) + 3);
  }
  const step = span > 60 ? 20 : 10;
  for (let d = 0; d <= span; d += step) {
    ctx.fillRect(X(d), h - AXIS_H, 1, 3);
    ctx.fillText(`${d}°`, Math.min(X(d) + 2, w - 22), h - 2);
  }

  // dead zone shading (plot + bar)
  ctx.fillStyle = 'rgba(125,129,138,0.13)';
  ctx.fillRect(g.x0, g.plotT, xd - g.x0, g.plotB - g.plotT);
  // range bar
  ctx.fillStyle = COL.bg; ctx.fillRect(g.x0, g.barY, g.x1 - g.x0, BAR_H);
  ctx.fillStyle = 'rgba(125,129,138,0.28)'; ctx.fillRect(g.x0, g.barY, xd - g.x0, BAR_H);
  ctx.fillStyle = 'rgba(200,113,79,0.22)'; ctx.fillRect(xd, g.barY, xf - xd, BAR_H);
  ctx.strokeStyle = COL.line; ctx.strokeRect(g.x0 + 0.5, g.barY + 0.5, g.x1 - g.x0 - 1, BAR_H - 1);
  if (xd - g.x0 > 34) { ctx.fillStyle = COL.muted; ctx.fillText('dead', g.x0 + 4, g.barY + 15); }

  // live tilt on the bar
  const r = tilt.on ? roll() : null;
  let live = null;
  if (r != null) {
    const side = r >= 0 ? 'R' : 'L', d = Math.min(Math.abs(r), span), v = amount(Math.abs(r));
    live = { side, d, v };
    ctx.fillStyle = COL[side]; ctx.globalAlpha = 0.55;
    ctx.fillRect(g.x0, g.barY + 7, X(d) - g.x0, BAR_H - 14);
    ctx.globalAlpha = 1;
  }

  // curve
  ctx.strokeStyle = COL.text; ctx.lineWidth = 2; ctx.beginPath();
  ctx.moveTo(g.x0, Y(0)); ctx.lineTo(xd, Y(0));
  const N = Math.max(24, Math.round(xf - xd) / 3);
  for (let i = 0; i <= N; i++) { const u = i / N; ctx.lineTo(xd + u * (xf - xd), Y(lut[Math.round(u * LUT_N)])); }
  ctx.lineTo(g.x1, Y(1)); ctx.stroke();

  // handles: vertical guides + knobs on the bar
  ctx.setLineDash([3, 3]); ctx.strokeStyle = COL.muted; ctx.lineWidth = 1;
  for (const x of [xd, xf]) { ctx.beginPath(); ctx.moveTo(x + 0.5, g.plotT); ctx.lineTo(x + 0.5, g.barY); ctx.stroke(); }
  ctx.setLineDash([]);
  for (const [x, k] of [[xd, 'dead'], [xf, 'full']]) {
    const on = drag?.kind === k;
    ctx.fillStyle = COL.text; ctx.beginPath(); ctx.roundRect(x - 5, g.barY - 3, 10, BAR_H + 6, 4); ctx.fill();
    if (on) { ctx.strokeStyle = COL.accent; ctx.lineWidth = 2; ctx.stroke(); }
  }
  // endpoints + user points
  ctx.fillStyle = COL.muted;
  for (const [x, y] of [[xd, Y(0)], [xf, Y(1)]]) { ctx.beginPath(); ctx.arc(x, y, 4, 0, 7); ctx.fill(); }
  tilt.pts.forEach(([u, v], i) => {
    ctx.fillStyle = COL.accent; ctx.beginPath(); ctx.arc(xd + u * (xf - xd), Y(v), drag?.kind === 'pt' && drag.i === i ? 9 : 7, 0, 7); ctx.fill();
    ctx.strokeStyle = COL.bg; ctx.lineWidth = 2; ctx.stroke();
  });

  // live marker
  if (live) {
    const x = X(live.d), y = Y(live.v);
    ctx.strokeStyle = COL[live.side]; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(x, g.plotT); ctx.lineTo(x, g.barY + BAR_H); ctx.stroke();
    ctx.fillStyle = COL[live.side]; ctx.beginPath(); ctx.arc(x, y, 5, 0, 7); ctx.fill();
    const label = `${live.side}2 ${Math.round(live.v * 100)}%`;
    const tw = ctx.measureText(label).width;
    ctx.fillText(label, x + 6 + tw > g.x1 ? x - 6 - tw : x + 6, g.plotT + 10);
  }
  dirty = false; lastW = w;
}

function pos(e) { const b = cv.getBoundingClientRect(); return [e.clientX - b.left, e.clientY - b.top]; }

cv.addEventListener('pointerdown', (e) => {
  const [px, py] = pos(e), g = geom(cv.clientWidth, cv.clientHeight);
  const xd = g.X(tilt.dead), xf = g.X(tilt.full), ux = (x) => (x - xd) / (xf - xd);
  const near = (x, y, r) => Math.hypot(px - x, py - y) <= r;
  let hit = null;
  const pi = tilt.pts.findIndex(([u, v]) => near(xd + u * (xf - xd), g.Y(v), 20));
  if (pi >= 0) hit = { kind: 'pt', i: pi, tap: true };
  else if (py >= g.barY - 10 || near(xd, g.Y(0), 18) || near(xf, g.Y(1), 18)) {
    const kind = Math.abs(px - xd) <= Math.abs(px - xf) && !(px > xf) ? 'dead' : 'full';
    hit = { kind };
  } else if (px > xd + 4 && px < xf - 4 && py >= g.plotT - 6 && py <= g.plotB + 6 && tilt.pts.length < MAX_PTS) {
    const u = ux(px);
    tilt.pts.push([u, clamp(g.V(py), 0, 1)]);
    tilt.pts.sort((a, b) => a[0] - b[0]);
    sanitize();
    const i = tilt.pts.findIndex((p) => Math.abs(p[0] - u) < 1e-9);
    if (i >= 0) hit = { kind: 'pt', i, tap: false };
    rebuild();
  }
  if (!hit) return;
  e.preventDefault();
  capture(cv, e);
  drag = { ...hit, x: px, y: py, t: e.timeStamp, moved: false };
  if (hit.kind !== 'pt') move(e);
  dirty = true; draw();
});

function move(e) {
  if (!drag) return;
  const [px, py] = pos(e), g = geom(cv.clientWidth, cv.clientHeight);
  if (Math.hypot(px - drag.x, py - drag.y) > 8) drag.moved = true;
  if (drag.kind === 'dead') tilt.dead = clamp(Math.round(g.D(px) * 2) / 2, 0, tilt.full - MIN_SPAN);
  else if (drag.kind === 'full') tilt.full = clamp(Math.round(g.D(px) * 2) / 2, tilt.dead + MIN_SPAN, MAX_FULL);
  else {
    if (!drag.moved) return;
    const xd = g.X(tilt.dead), xf = g.X(tilt.full), pts = tilt.pts, i = drag.i;
    const lo = i > 0 ? pts[i - 1] : [0, 0], hi = i < pts.length - 1 ? pts[i + 1] : [1, 1];
    pts[i] = [r3(clamp((px - xd) / (xf - xd), lo[0] + U_GAP, hi[0] - U_GAP)), r3(clamp(g.V(py), lo[1], hi[1]))];
  }
  changed(false); draw();
}
function up(e) {
  if (!drag) return;
  if (drag.kind === 'pt' && drag.tap && !drag.moved && e.timeStamp - drag.t < 400) tilt.pts.splice(drag.i, 1);
  drag = null;
  changed(); draw();
}
cv.addEventListener('pointermove', move);
cv.addEventListener('pointerup', up);
cv.addEventListener('pointercancel', up);
cv.addEventListener('contextmenu', (e) => e.preventDefault());

// ---------- calibration wizard: rest (0%) + R2 100%; L2 is the mirror ----------
const MIN_FULL = 8;
const TILT_STEPS = [
  { title: 'Rest · 0%', hint: 'Hold the phone how you play and keep it still. This is where both triggers rest (and where the range starts).' },
  { title: 'R2 · 100%', hint: 'Tilt the RIGHT side down to where R2 should be FULLY pressed. L2 uses the same angle to the left.' },
].map((s, i) => ({
  ...s,
  sample: () => motion.raw,
  ready: () => (motion.raw == null ? (isSecureContext ? 'No motion sensor data.' : MOTION_HELP) : null),
  describe: (r) => `<b>${fmt(r.value, 1)}°</b> <span class="muted">(±${fmt(r.sd.v, 1)}° wobble)</span>`,
  unsteady: (r) => r.sd.v > 1.5,
  validate: i === 0 ? null : (r, recs) => (r.value - recs[0].value < MIN_FULL
    ? `Tilt the right side at least ${MIN_FULL}° further down than rest (${fmt(recs[0].value, 1)}°). Retry.` : null),
}));

function fromRecs(recs) {
  const rest = recs[0].value, full = recs[1].value - rest;
  const dead = Math.min(Math.max(2, 3 * recs[0].sd.v), full - MIN_SPAN);
  return { rest: r1(rest), full: r1(full), dead: r1(Math.max(0, dead)) };
}

export function openTiltWizard(thenPad, openPad) {
  openWizard({
    name: 'Tilt',
    steps: TILT_STEPS,
    drawGauge({ ctx, w, h }, { recs, sampling }) {
      const sp = 60, X = (deg) => ((clamp(deg, -sp, sp) + sp) / (2 * sp)) * w;
      ctx.fillStyle = COL.muted; ctx.font = '10px system-ui';
      for (let d = -60; d <= 60; d += 15) { ctx.fillRect(X(d), h - 14, 1, 4); ctx.fillText(`${d}`, X(d) + 2, h - 2); }
      ctx.fillText('◀ L2', 4, 12); ctx.fillText('R2 ▶', w - 30, 12);
      const rest = recs[0]?.value;
      if (rest != null) {
        ctx.fillStyle = COL.text; ctx.fillRect(X(rest) - 1, 16, 2, h - 34); ctx.fillText('rest', X(rest) + 3, 26);
        if (recs[1]) {
          const f = recs[1].value - rest;
          ctx.fillStyle = COL.R; ctx.fillRect(X(rest + f) - 1, 16, 2, h - 34); ctx.fillText('100', X(rest + f) + 3, 26);
          ctx.fillStyle = COL.L; ctx.fillRect(X(rest - f) - 1, 16, 2, h - 34); ctx.fillText('100', X(rest - f) + 3, 26);
        }
      }
      if (motion.raw != null) {
        ctx.fillStyle = sampling ? '#f87171' : '#4ade80';
        ctx.fillRect(X(motion.raw) - 2, 10, 4, h - 24);
        ctx.fillText(`${fmt(motion.raw, 1)}°`, Math.min(w - 40, X(motion.raw) + 6), h - 20);
      }
    },
    summary(recs) {
      const p = fromRecs(recs);
      const error = p.full < MIN_FULL ? `R2 100% must be at least ${MIN_FULL}° past rest: redo it.` : null;
      return {
        title: 'Your tilt range',
        head: ['', 'angle', 'from rest'],
        rows: [
          ['Rest', `${fmt(p.rest, 1)}°`, '0°'],
          ['Dead zone', '', `±${fmt(p.dead, 1)}°`],
          ['R2 100%', `${fmt(p.rest + p.full, 1)}°`, `+${fmt(p.full, 1)}°`],
          ['L2 100%', `${fmt(p.rest - p.full, 1)}°`, `−${fmt(p.full, 1)}° (mirror)`],
        ],
        draw: (c) => drawMirror(c, p),
        pending: p,
        error,
      };
    },
    redo: [{ label: 'Redo rest', from: 0, to: 0 }, { label: 'Redo 100%', from: 1, to: 1 }],
    onSave(p) {
      Object.assign(tilt, { rest: p.rest, zero: p.rest, full: p.full, dead: p.dead });
      changed(); renderStatus();
    },
    after: (saved) => (saved && thenPad ? openPad() : exitFullscreen()),
  });
}

// Summary plot: L2 and R2 output vs absolute roll, with the current curve shape.
function drawMirror({ ctx, w, h }, { rest, dead, full }) {
  const f = curveFn(tilt.pts), sp = Math.max(30, full + 10);
  const X = (deg) => ((deg - rest + sp) / (2 * sp)) * w, Y = (v) => h - 14 - v * (h - 36);
  const out = (d) => (d <= dead ? 0 : d >= full ? 1 : f((d - dead) / (full - dead)));
  ctx.strokeStyle = COL.line; ctx.beginPath(); ctx.moveTo(X(rest), 0); ctx.lineTo(X(rest), h); ctx.stroke();
  for (const [s, color] of [[1, COL.R], [-1, COL.L]]) {
    ctx.strokeStyle = color; ctx.lineWidth = 2; ctx.beginPath();
    for (let i = 0; i <= 120; i++) { const d = (i / 120) * sp, x = X(rest + s * d), y = Y(out(d)); i ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  }
  ctx.fillStyle = COL.muted; ctx.font = '10px system-ui';
  ctx.fillText('◀ left down (L2)', 4, 12); ctx.fillText('right down (R2) ▶', w - 92, 12); ctx.fillText(`rest ${fmt(rest, 1)}°`, X(rest) + 3, h - 2);
}

changed(false);
renderStatus();

export function motionText() {
  const hz = motionHz();
  if (motion.raw == null) return isSecureContext ? 'no motion sensor data' : MOTION_HELP;
  const t = tiltValues();
  return `tilt ${fmt(roll(), 0)}° · L2 ${Math.round(t.L * 100)}% · R2 ${Math.round(t.R * 100)}% · sensor ${hz ? fmt(hz, 0) : '–'} Hz`;
}

let lastText = '';
export function renderTiltLive() {
  if (card.offsetParent === null) return;
  const txt = motionText();
  if (txt !== lastText) { $('tiltLive').textContent = txt; lastText = txt; }
  const r = motion.raw == null ? null : Math.round(roll() * 10);
  if (dirty || r !== lastRoll || cv.clientWidth !== lastW) { lastRoll = r; draw(); }
}

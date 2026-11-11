// Touch-look: empty screen area acts as the right stick (camera), like mobile shooters.
//   initLook(commit, isPadOpen): commit(e?) sends the pad state now; used from the swipe decay timer as commit().
//   lookDown(e) → true if this touch is claimed (feature on, finger on empty space in the zone); false = ignore.
//   lookMove(e) → true if gp.rx/ry changed (pad.js then commits).
//   lookUp(e), resetLook().
// Modes:
//   swipe – finger velocity (mm/s) → deflection; returns to 0 shortly after the finger stops.
//   drag  – displacement from the touch-down point / radius (mm) → deflection; holds while off-centre.
// Never overrides the real on-screen right stick while it is held.
import { $, load, save } from './overlay.js';
import { gp } from './gamepad.js';

const DEFAULTS = { on: false, zone: 'right', mode: 'swipe', sens: 1, radius: 12, invertY: false, ring: true };
export const look = Object.assign({}, DEFAULTS, load('look', {}));

const FULL_SPEED = 120;   // mm/s of finger speed for full deflection at sensitivity 1×
const MIN_SPEED = 4;      // mm/s: below this the swipe reads as 0 (jitter dead zone)
const TAU = 6;            // ms: velocity smoothing time constant (well under one frame)
const STOP_MS = 32;       // ms without moves → swipe stick returns to 0
const DRAG_DEAD = 0.06;   // drag-mode radial dead zone (fraction of radius)

let commitFn = () => {}, padOpenFn = () => true;
let active = null;        // pointerId of the finger that owns look, or null
let u = 6;                // CSS px per mm
let rStick = null;        // the on-screen right stick element (checked for .held)
let ox = 0, oy = 0;       // drag origin
let lx = 0, ly = 0, lt = 0; // swipe: last position / timestamp
let vx = 0, vy = 0;       // swipe: smoothed velocity, mm/ms
let lastMoveT = 0, timer = 0;
let ring = null;

const now = () => performance.now();
const stickHeld = () => !!(rStick && rStick.classList.contains('held'));

// ---------- output ----------
function write(x, y) {
  if (look.invertY) y = -y;
  const m = Math.hypot(x, y);
  if (m > 1) { x /= m; y /= m; }
  if (x === gp.rx && y === gp.ry) return false;
  gp.rx = x; gp.ry = y;
  return true;
}

// ---------- swipe decay timer (one timer, re-armed lazily rather than on every event) ----------
function arm() { if (!timer) timer = setTimeout(tick, STOP_MS); }
function tick() {
  timer = 0;
  if (active === null) return;
  const idle = now() - lastMoveT;
  if (idle < STOP_MS) { timer = setTimeout(tick, STOP_MS - idle); return; }
  vx = vy = 0;
  if (stickHeld()) return;
  if (write(0, 0) && padOpenFn()) commitFn();
}
function clearTimer() { if (timer) { clearTimeout(timer); timer = 0; } }

// ---------- visual ----------
function ensureRing() {
  const pad = $('pad');
  if (!pad) return null;
  if (!ring) { ring = document.createElement('div'); ring.className = 'look-ring'; ring.setAttribute('aria-hidden', 'true'); }
  if (ring.parentNode !== pad) pad.appendChild(ring);
  return ring;
}
function placeRing(x, y) { if (ring) ring.style.transform = `translate3d(${x}px,${y}px,0)`; }
function hideRing() { if (ring) ring.classList.remove('vis'); }

// ---------- pointer contract ----------
export function initLook(commit, isPadOpen) {
  if (commit) commitFn = commit;
  if (isPadOpen) padOpenFn = isPadOpen;
}

export function lookDown(e) {
  if (!look.on || active !== null) return false;
  if (look.zone === 'right' && e.clientX < window.innerWidth / 2) return false;
  rStick = document.querySelector('#pad [data-stick=r]');
  if (stickHeld()) return false;
  const pad = $('pad');
  u = (pad && parseFloat(getComputedStyle(pad).getPropertyValue('--u'))) || 6;
  active = e.pointerId;
  ox = lx = e.clientX; oy = ly = e.clientY; lt = e.timeStamp;
  vx = vy = 0; lastMoveT = now();
  write(0, 0);
  if (look.ring && ensureRing()) {
    ring.classList.toggle('drag', look.mode === 'drag');
    placeRing(e.clientX, e.clientY);
    ring.classList.add('vis');
  }
  return true;
}

export function lookMove(e) {
  if (e.pointerId !== active) return false;
  const x = e.clientX, y = e.clientY;
  if (look.ring) placeRing(x, y);
  if (look.mode === 'drag') {
    if (stickHeld()) return false;
    const R = look.radius * u;
    let dx = (x - ox) / R, dy = (y - oy) / R;
    const m = Math.hypot(dx, dy);
    if (m <= DRAG_DEAD) return write(0, 0);
    const k = Math.min(1, (m - DRAG_DEAD) / (1 - DRAG_DEAD)) / m;
    return write(dx * k, dy * k);
  }
  // swipe
  const dt = e.timeStamp - lt;
  if (dt <= 0) return false;            // same-timestamp duplicate: wait for the next one (lx/ly kept)
  const ix = (x - lx) / u / dt, iy = (y - ly) / u / dt;   // mm/ms
  lx = x; ly = y; lt = e.timeStamp;
  const a = dt >= 30 ? 1 : 1 - Math.exp(-dt / TAU);       // long gap: no stale history
  vx += (ix - vx) * a; vy += (iy - vy) * a;
  lastMoveT = now(); arm();
  if (stickHeld()) return false;
  const speed = Math.hypot(vx, vy) * 1000;                // mm/s
  if (speed < MIN_SPEED) return write(0, 0);
  const full = FULL_SPEED / look.sens;
  const mag = Math.min(1, (speed - MIN_SPEED) / (full - MIN_SPEED));
  const k = mag / speed * 1000;
  return write(vx * k, vy * k);
}

export function lookUp(e) {
  if (e && e.pointerId !== active) return;
  end();
}

export function resetLook() { end(); }

function end() {
  if (active !== null && !stickHeld()) { gp.rx = 0; gp.ry = 0; }
  active = null; rStick = null; vx = vy = 0;
  clearTimer(); hideRing();
}

// ---------- settings UI ----------
function renderSettings() {
  const box = $('set-look');
  if (!box) return;
  box.innerHTML = `
    <h3>Touch-look</h3>
    <p class="small muted">Touch and move on empty screen space to turn the camera, like the right stick — the way most mobile shooters work.</p>
    <label class="row"><input type="checkbox" id="lookOn"> Touch-look (empty screen = right stick)</label>
    <div id="lookOpts">
      <label class="row">Area
        <select id="lookZone">
          <option value="right">Right half only</option>
          <option value="whole">Whole screen</option>
        </select></label>
      <label class="row">Mode
        <select id="lookMode">
          <option value="swipe">Swipe: camera speed follows finger speed</option>
          <option value="drag">Drag: like a stick from where you touched</option>
        </select></label>
      <label class="row" id="lookSensRow">Sensitivity <input type="range" id="lookSens" min="0.2" max="4" step="0.1"> <b id="lookSensV"></b>×</label>
      <label class="row" id="lookRadiusRow">Stick radius <input type="range" id="lookRadius" min="4" max="30" step="1"> <b id="lookRadiusV"></b> mm</label>
      <label class="row"><input type="checkbox" id="lookInvert"> Invert Y (up/down)</label>
      <label class="row"><input type="checkbox" id="lookRing"> Show a ring under the finger</label>
      <p class="small muted" id="lookHint"></p>
    </div>`;
  const on = $('lookOn'), zone = $('lookZone'), mode = $('lookMode'), sens = $('lookSens'), rad = $('lookRadius'),
    inv = $('lookInvert'), rg = $('lookRing');
  const sync = () => {
    $('lookOpts').style.opacity = look.on ? '' : '.5';
    $('lookSensRow').style.display = look.mode === 'swipe' ? '' : 'none';
    $('lookRadiusRow').style.display = look.mode === 'drag' ? '' : 'none';
    $('lookSensV').textContent = (+look.sens).toFixed(1);
    $('lookRadiusV').textContent = look.radius;
    $('lookHint').textContent = look.mode === 'swipe'
      ? `Full camera speed at a ${Math.round(FULL_SPEED / look.sens)} mm/s swipe; stops when your finger stops.`
      : 'Hold your finger away from where you touched to keep turning.';
  };
  on.checked = look.on; zone.value = look.zone; mode.value = look.mode;
  sens.value = look.sens; rad.value = look.radius; inv.checked = look.invertY; rg.checked = look.ring;
  const set = (k, v) => {
    look[k] = v; save('look', look); sync();
    if (k === 'on' || k === 'mode' || k === 'zone') { end(); }
  };
  on.onchange = () => set('on', on.checked);
  zone.onchange = () => set('zone', zone.value);
  mode.onchange = () => set('mode', mode.value);
  sens.oninput = () => set('sens', +sens.value);
  rad.oninput = () => set('radius', +rad.value);
  inv.onchange = () => set('invertY', inv.checked);
  rg.onchange = () => { set('ring', rg.checked); if (!rg.checked) hideRing(); };
  sync();
}
renderSettings();

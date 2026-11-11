// On-screen sticks.
//   stickDown(el, e) / stickMove(el, e) / stickUp(el, e): el has data-stick="l" | "r"; write gp.lx/ly or gp.rx/ry (-1..1)
//   and the L3 (bit 14) / R3 (bit 15) bits in gp.buttons. pad.js calls commit() after each.
//   resetSticks(): clear all stick state (called when the pad opens).
// Settings UI renders itself into #set-sticks.
//
// Shaping (phone side, before the laptop-side me.tune in sendPad):
//   origin: "float" = first touch point is the centre, "fixed" = stick centre.
//   radial dead zone → rescaled so output starts at 0 just past it; "full at" = anti-saturation;
//   response curve exponent on the magnitude (1 = linear, >1 = finer control near centre).
// L3/R3: tap, then touch again within 280 ms → button held while that second touch stays down
//   (kept on for at least 60 ms so a quick double-tap registers as a click).
import { gp, BTN } from './gamepad.js';
import { $, load, save } from './overlay.js';
import { commit } from './pad.js';   // circular (pad.js imports us): only called at runtime, never at load

const DEF = { mode: 'float', travel: 100, dead: 8, full: 92, curve: 1.6, dbl: true };
const cfg = { ...DEF, ...load('sticks', {}) };

const TAP_MS = 220;       // first tap must be shorter than this…
const TAP_MOVE = 0.25;    // …and move less than this fraction of the stick radius
const DBL_MS = 280;       // gap between the first tap's release and the second touch
const MIN_CLICK_MS = 60;  // minimum L3/R3 on-time

function mkState(k) {
  return { k, bit: 1 << (k === 'l' ? BTN.L3 : BTN.R3), id: -1, ox: 0, oy: 0, R: 1, downT: 0, sx: 0, sy: 0, maxMove: 0,
           tapT: -1e9, tapX: 0, tapY: 0, click: false, timer: 0, el: null, rad: 1 };
}
const S = { l: mkState('l'), r: mkState('r') };
const out = { lx: 0, ly: 0, rx: 0, ry: 0 };

// Shape a raw deflection (units of travel radius) into gp + visuals.
function apply(s, el, nx, ny) {
  const m = Math.hypot(nx, ny);
  let vx = 0, vy = 0;
  const dz = cfg.dead / 100, full = Math.max(dz + 0.01, cfg.full / 100);
  if (m > dz) {
    let t = (m - dz) / (full - dz);
    if (t > 1) t = 1;
    const o = cfg.curve === 1 ? t : Math.pow(t, cfg.curve);
    vx = nx * o / m; vy = ny * o / m;
  }
  gp[s.k + 'x'] = vx; gp[s.k + 'y'] = vy;
  out[s.k + 'x'] = vx; out[s.k + 'y'] = vy;
  // Cap follows the finger (clamped to the rim); ring brightness = shaped output.
  const c = m > 1 ? 1 / m : 1;
  const st = el.style;
  st.setProperty('--x', (nx * c).toFixed(3));
  st.setProperty('--y', (ny * c).toFixed(3));
  st.setProperty('--m', Math.hypot(vx, vy).toFixed(3));
  if (m > 0.05) st.setProperty('--ang', (Math.atan2(ny, nx) * 57.29578).toFixed(1) + 'deg');
  queueReadout();
}

function clearClick(s) {
  if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
  s.click = false;
  gp.buttons &= ~s.bit;
  s.el?.classList.remove('l3');
}

export function stickDown(el, e) {
  const s = S[el.dataset.stick];
  s.el = el; s.id = e.pointerId;
  const r = el.getBoundingClientRect();   // measured once per touch; moves only do arithmetic
  s.rad = r.width / 2; s.R = s.rad * (cfg.travel / 100);
  if (cfg.mode === 'fixed') { s.ox = r.left + r.width / 2; s.oy = r.top + r.height / 2; }
  else { s.ox = e.clientX; s.oy = e.clientY; }
  s.downT = e.timeStamp; s.sx = e.clientX; s.sy = e.clientY; s.maxMove = 0;
  el.classList.add('held');

  // Second touch of a double-tap → L3/R3.
  if (cfg.dbl && e.timeStamp - s.tapT < DBL_MS &&
      Math.hypot(e.clientX - s.tapX, e.clientY - s.tapY) < r.width * 0.5) {
    if (s.timer) { clearTimeout(s.timer); s.timer = 0; }
    s.click = true;
    s.tapT = -1e9;
    gp.buttons |= s.bit;
    el.classList.add('l3');
    navigator.vibrate?.(12);
  }
  apply(s, el, (e.clientX - s.ox) / s.R, (e.clientY - s.oy) / s.R);
}

export function stickMove(el, e) {
  const s = S[el.dataset.stick];
  const d = Math.hypot(e.clientX - s.sx, e.clientY - s.sy);
  if (d > s.maxMove) s.maxMove = d;
  apply(s, el, (e.clientX - s.ox) / s.R, (e.clientY - s.oy) / s.R);
}

export function stickUp(el, e) {
  const s = S[el.dataset.stick];
  const t = e ? e.timeStamp : performance.now();
  if (e) { const d = Math.hypot(e.clientX - s.sx, e.clientY - s.sy); if (d > s.maxMove) s.maxMove = d; }
  if (s.click) {
    const left = MIN_CLICK_MS - (t - s.downT);
    if (left > 0) {
      s.timer = setTimeout(() => { s.timer = 0; clearClick(s); commit(); }, left);
    } else clearClick(s);
  } else if (t - s.downT < TAP_MS && s.maxMove < s.rad * TAP_MOVE) {
    s.tapT = t; s.tapX = s.sx; s.tapY = s.sy;   // a clean tap: arms the double-tap window
  } else s.tapT = -1e9;
  s.id = -1;
  gp[s.k + 'x'] = 0; gp[s.k + 'y'] = 0;
  out[s.k + 'x'] = 0; out[s.k + 'y'] = 0;
  el.classList.remove('held');
  const st = el.style;
  st.setProperty('--x', '0'); st.setProperty('--y', '0'); st.setProperty('--m', '0');
  queueReadout();
}

export function resetSticks() {
  for (const s of [S.l, S.r]) {
    if (s.timer) clearTimeout(s.timer);
    s.timer = 0; s.click = false; s.id = -1; s.tapT = -1e9; s.maxMove = 0;
    gp.buttons &= ~s.bit;
  }
  out.lx = out.ly = out.rx = out.ry = 0;
  for (const el of document.querySelectorAll('[data-stick]')) {
    el.classList.remove('held', 'l3', 'clicked');
    for (const v of ['--x', '--y', '--m']) el.style.setProperty(v, '0');
  }
  queueReadout();
}

// ---------- settings UI ----------
const box = $('set-sticks');
box.innerHTML = `
  <h3>Sticks</h3>
  <label class="row">Centre
    <select id="stkMode">
      <option value="float">Floating: thumb lands = centre</option>
      <option value="fixed">Fixed: stick centre</option>
    </select></label>
  <label class="row">Travel <input type="range" id="stkTravel" min="50" max="150" step="5"> <b id="stkTravelV"></b>%</label>
  <label class="row">Dead zone <input type="range" id="stkDead" min="0" max="30" step="1"> <b id="stkDeadV"></b>%</label>
  <label class="row">Full tilt at <input type="range" id="stkFull" min="60" max="100" step="1"> <b id="stkFullV"></b>%</label>
  <label class="row">Response curve <input type="range" id="stkCurve" min="1" max="3" step="0.1"> <b id="stkCurveV"></b></label>
  <p class="small muted">Curve: 1 = linear, higher = finer aim near the centre (feels stiffer, like a real stick). Travel = how far to push for full tilt. Double-tap = click; double-tap and hold = held.</p>
  <label class="row"><input type="checkbox" id="stkDbl"> Double-tap for L3 / R3</label>
  <div class="small muted" id="stkLive">L 0.00, 0.00 · R 0.00, 0.00</div>`;

const persist = () => save('sticks', cfg);
$('stkMode').value = cfg.mode;
$('stkMode').onchange = (e) => { cfg.mode = e.target.value; persist(); };
for (const [id, key, dec] of [['stkTravel', 'travel', 0], ['stkDead', 'dead', 0], ['stkFull', 'full', 0], ['stkCurve', 'curve', 1]]) {
  const inp = $(id), v = $(id + 'V');
  inp.value = cfg[key]; v.textContent = (+cfg[key]).toFixed(dec);
  inp.oninput = () => { cfg[key] = +inp.value; v.textContent = cfg[key].toFixed(dec); persist(); };
}
$('stkDbl').checked = cfg.dbl;
$('stkDbl').onchange = (e) => { cfg.dbl = e.target.checked; if (!cfg.dbl) { S.l.tapT = S.r.tapT = -1e9; } persist(); };

// Readout is cosmetic: batched to the next frame so it never sits on the input path.
const live = $('stkLive');
let rq = false;
function queueReadout() {
  if (rq) return;
  rq = true;
  requestAnimationFrame(() => {
    rq = false;
    live.textContent = `L ${out.lx.toFixed(2)}, ${out.ly.toFixed(2)} · R ${out.rx.toFixed(2)}, ${out.ry.toFixed(2)}`;
  });
}

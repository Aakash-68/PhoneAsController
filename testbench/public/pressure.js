// Pressure-sensitive touch: finger contact size (flatter press = bigger) or reported pressure,
// calibrated per trigger at 0% (light rest) and 100% (hard press). Used by pad L2/R2 and wheel pedals.
import { fmt } from './common.js';
import { $, capture, clamp01, MOVE_EVENT, load, save } from './overlay.js';
import { openWizard } from './wizard.js';

export const pressure = { cal: load('pressCal', null) };

export const metrics = (e) => ({ size: Math.sqrt(Math.max(1, e.width) * Math.max(1, e.height)), pressure: e.pressure ?? 0 });

// 0..1 for this pointer, or null when pressure isn't calibrated (callers then treat a press as 100%).
export function pressValue(which, m) {
  const c = pressure.cal?.[which];
  if (!c) return null;
  return clamp01((m[c.src] - c.p0) / (c.p100 - c.p0));
}

// Whichever signal changed more between the light and hard press.
function pickSource(light, hard) {
  return ['size', 'pressure']
    .map((src) => ({ src, spread: (hard.mean[src] - light.mean[src]) / Math.max(Math.abs(light.mean[src]), 1e-3) }))
    .sort((a, b) => b.spread - a.spread)[0];
}

// ---------- the press target inside the calibration overlay ----------
let live = null;   // metrics of the finger on the target, null when lifted
const target = $('calibTarget');
target.addEventListener('pointerdown', (e) => { capture(target, e); live = metrics(e); target.classList.add('on'); });
target.addEventListener(MOVE_EVENT, (e) => { if (live) live = metrics(e); });
const lift = () => { live = null; target.classList.remove('on'); };
target.addEventListener('pointerup', lift);
target.addEventListener('pointercancel', lift);

const step = (which, pct) => ({
  title: `${which} · ${pct}% pressure`,
  hint: pct === 0
    ? `Rest your finger LIGHTLY on the ${which} circle: the touch that should give 0%. Keep it there through the countdown.`
    : `PRESS HARD on the ${which} circle with the flat pad of your finger: this is 100%. Keep pressing through the countdown.`,
  target: which,
  sample: () => live,
  noData: 'Keep your finger on the circle while it records.',
  describe: (r) => `contact <b>${fmt(r.mean.size, 1)} px</b> · pressure <b>${fmt(r.mean.pressure, 2)}</b>`,
  unsteady: (r) => r.sd.size > r.mean.size * 0.08,
  validate: pct === 100 ? (r, recs, i) => {
    const best = pickSource(recs[i - 1], r);
    return best.spread < 0.12 ? `Only ${Math.round(best.spread * 100)}% difference from your light touch. Press harder and flatter (or lighter on the 0% step).` : null;
  } : null,
});

export function openPressureWizard(after) {
  openWizard({
    name: 'Pressure',
    steps: [step('R2', 0), step('R2', 100), step('L2', 0), step('L2', 100)],
    drawGauge({ ctx, w, h }) {
      const m = live;
      ctx.fillStyle = '#8a93a6'; ctx.font = '12px system-ui';
      if (!m) { ctx.fillText('Touch the circle below…', 8, h / 2); return; }
      const bar = (y, label, v, max) => {
        ctx.fillStyle = '#1e293b'; ctx.fillRect(110, y, w - 120, 14);
        ctx.fillStyle = '#60a5fa'; ctx.fillRect(110, y, (w - 120) * clamp01(v / max), 14);
        ctx.fillStyle = '#cbd5e1'; ctx.fillText(label, 8, y + 12);
      };
      bar(14, `contact ${fmt(m.size, 1)} px`, m.size, 80);
      bar(40, `pressure ${fmt(m.pressure, 2)}`, m.pressure, 1);
    },
    summary(recs) {
      const pending = {};
      const rows = [];
      for (const [which, i] of [['R2', 0], ['L2', 2]]) {
        const light = recs[i], hard = recs[i + 1], best = pickSource(light, hard);
        const lo = light.mean[best.src], hi = hard.mean[best.src];
        // Start a little above the resting touch so a light finger reads exactly 0%.
        const p0 = lo + Math.max(2 * light.sd[best.src], (hi - lo) * 0.05);
        pending[which] = { src: best.src, p0, p100: hi };
        rows.push([which, best.src === 'size' ? 'contact size' : 'pressure', fmt(lo, 2), fmt(hi, 2), `${Math.round(best.spread * 100)}%`]);
      }
      return { title: 'Your pressure range', head: ['', 'signal', '0%', '100%', 'range'], rows, pending };
    },
    redo: [{ label: 'Redo R2', from: 0, to: 1 }, { label: 'Redo L2', from: 2, to: 3 }],
    onSave(pending) { pressure.cal = pending; save('pressCal', pending); renderPressureStatus(); },
    after,
  });
}

// ---------- settings UI (Pad tab) ----------
export function renderPressureStatus() {
  const c = pressure.cal;
  const txt = c
    ? `Calibrated ✓ R2 ${c.R2.src === 'size' ? 'contact' : 'pressure'} ${fmt(c.R2.p0, 1)}→${fmt(c.R2.p100, 1)} · L2 ${c.L2.src === 'size' ? 'contact' : 'pressure'} ${fmt(c.L2.p0, 1)}→${fmt(c.L2.p100, 1)}`
    : '<span class="muted">Not calibrated: Pressure mode will ask you to calibrate first.</span>';
  document.querySelectorAll('.pressStatus').forEach((el) => { el.innerHTML = txt; });
}
$('pressCalib').onclick = () => openPressureWizard();
$('pressReset').onclick = () => { pressure.cal = null; save('pressCal', null); renderPressureStatus(); };
renderPressureStatus();

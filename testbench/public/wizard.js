// Generic step-by-step calibration wizard: countdown → record → retry/next → summary → save.
// Used by tilt triggers (angles) and pressure (finger contact size / pressure).
import { $, show, enterFullscreen, exitFullscreen, setupCanvas } from './overlay.js';

const RECORD_MS = 800, COUNTDOWN = 3;
const el = $('calib');
let W = null;   // active wizard: { cfg, recs, step, sampling, busy }

const avg = (a) => a.reduce((x, y) => x + y, 0) / a.length;
const sd = (a) => { const m = avg(a); return Math.sqrt(avg(a.map((v) => (v - m) ** 2))); };

// Each sample is a number or an object of numbers; record mean and wobble per key.
function reduce(samples) {
  const objs = samples.map((s) => (typeof s === 'number' ? { v: s } : s));
  const keys = Object.keys(objs[0]);
  const mean = {}, dev = {};
  for (const k of keys) { const col = objs.map((o) => o[k]); mean[k] = avg(col); dev[k] = sd(col); }
  return { mean, sd: dev, n: samples.length, value: mean.v };
}

export function openWizard(cfg) {
  W = { cfg, recs: [], step: 0, sampling: null, busy: false };
  el.classList.remove('hidden');
  enterFullscreen();
  stepView();
}

export const wizardOpen = () => !!W;

function close(saved) {
  const cfg = W.cfg;
  W.busy = false;
  W = null;
  el.classList.add('hidden');
  if (cfg.after) cfg.after(saved);
  else exitFullscreen();
}

function stepView() {
  const { cfg, step, recs } = W, st = cfg.steps[step], rec = recs[step];
  $('calibStep').textContent = `${cfg.name} · step ${step + 1} of ${cfg.steps.length}`;
  $('calibTitle').textContent = st.title;
  $('calibHint').textContent = st.hint;
  $('calibCount').textContent = '';
  $('calibResult').innerHTML = rec ? resultHtml(st, rec) : '';
  show('calibTarget', !!st.target);
  $('calibTarget').textContent = st.target ?? '';
  show('calibGauge', !!cfg.drawGauge);
  show('calibRecord', !rec);
  show('calibRetry', !!rec);
  show('calibNext', !!rec && !rec.error);
  show('calibSummary', false);
}

function resultHtml(st, rec) {
  const warn = rec.error ? `<br><span class="warn">${rec.error}</span>` : st.unsteady?.(rec) ? '<br><span class="warn">Hand was moving: retry for a steadier value?</span>' : '';
  return `Recorded ${st.describe(rec)}${warn}`;
}

async function record() {
  if (!W || W.busy) return;
  const st = W.cfg.steps[W.step];
  const pre = st.ready?.();
  if (pre) { $('calibResult').innerHTML = `<span class="warn">${pre}</span>`; return; }
  W.busy = true;
  show('calibRecord', false); show('calibRetry', false); show('calibNext', false);
  $('calibResult').textContent = 'Get into position…';
  for (let n = COUNTDOWN; n > 0; n--) {
    $('calibCount').textContent = n;
    navigator.vibrate?.(30);
    await new Promise((r) => setTimeout(r, 1000));
    if (!W) return;
  }
  $('calibCount').textContent = '● REC';
  const samples = [];
  W.sampling = samples;
  const timer = setInterval(() => { const s = st.sample(); if (s != null) samples.push(s); }, 16);
  await new Promise((r) => setTimeout(r, RECORD_MS));
  clearInterval(timer);
  if (!W) return;
  W.sampling = null;
  navigator.vibrate?.([60, 40, 60]);
  W.busy = false;
  if (samples.length < 5) {
    $('calibCount').textContent = '';
    $('calibResult').innerHTML = `<span class="warn">${st.noData ?? 'No readings captured.'} Try again.</span>`;
    show('calibRecord', true);
    return;
  }
  const rec = reduce(samples);
  rec.error = st.validate?.(rec, W.recs, W.step) ?? null;
  W.recs[W.step] = rec;
  stepView();
}

function next() {
  const i = W.cfg.steps.findIndex((_, j) => j > W.step && !W.recs[j]);
  if (i === -1) summaryView();
  else { W.step = i; stepView(); }
}

function summaryView() {
  const { cfg, recs } = W;
  const sum = cfg.summary(recs);
  W.pending = sum.pending;
  $('calibStep').textContent = `${cfg.name} · done`;
  $('calibTitle').textContent = sum.title ?? 'Your curves';
  $('calibHint').textContent = sum.error ?? 'Check the values, then Save. Redo a part if it looks off.';
  $('calibHint').className = sum.error ? 'warn' : 'muted';
  $('calibCount').textContent = '';
  $('calibResult').textContent = '';
  show('calibTarget', false); show('calibGauge', false);
  show('calibRecord', false); show('calibRetry', false); show('calibNext', false);
  show('calibSummary', true);
  $('calibHead').innerHTML = `<tr>${sum.head.map((h) => `<th>${h}</th>`).join('')}</tr>`;
  $('calibTable').innerHTML = sum.rows.map((r) => `<tr>${r.map((c, i) => (i ? `<td>${c}</td>` : `<th>${c}</th>`)).join('')}</tr>`).join('');
  show('calibCurve', !!sum.draw);
  if (sum.draw) sum.draw(setupCanvas($('calibCurve')));
  const actions = $('calibActions');
  actions.innerHTML = '';
  const btn = (label, primary, fn) => { const b = document.createElement('button'); b.textContent = label; if (primary) b.className = 'primary'; b.onclick = fn; actions.appendChild(b); return b; };
  const saveBtn = btn('Save', true, () => { cfg.onSave(W.pending); close(true); });
  saveBtn.disabled = !!sum.error;
  for (const r of cfg.redo ?? []) btn(r.label, false, () => { for (let i = r.from; i <= r.to; i++) delete W.recs[i]; W.step = r.from; $('calibHint').className = 'muted'; stepView(); });
}

$('calibRecord').onclick = record;
$('calibRetry').onclick = () => { delete W.recs[W.step]; stepView(); record(); };
$('calibNext').onclick = next;
$('calibCancel').onclick = () => W && close(false);

// Called from the render loop while open.
export function renderWizard() {
  if (!W || !W.cfg.drawGauge || $('calibGauge').classList.contains('hidden')) return;
  W.cfg.drawGauge(setupCanvas($('calibGauge')), { recs: W.recs, sampling: !!W.sampling, steps: W.cfg.steps });
}

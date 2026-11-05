// Phone model + real-size layout + HUD options.
//   • Which phone is this? (picked once, auto-detected when the browser tells us the model)
//   • Lays the Xbox / PS4 pad out in millimetres so buttons sit where they are on a real controller
//   • Lays the keyboard screen out at real keycap pitch (19.05 mm)
//   • HUD sheet: size, scale, opacity, shell, labels, stats, edit layout; island; device report to the laptop
import { $, load, save } from './overlay.js';
import { link, me, onIdentity, onBuzz } from './net.js';

// ---------- phones: diagonal (in), panel resolution (long × short), default CSS viewport (short × long) ----------
export const PHONES = [
  { id: 's22u', brand: 'Samsung', name: 'Galaxy S22 Ultra', diag: 6.8, res: [3088, 1440], css: [384, 824], ua: /SM-S908/i },
  { id: 's23u', brand: 'Samsung', name: 'Galaxy S23 Ultra', diag: 6.8, res: [3088, 1440], css: [384, 824], ua: /SM-S918/i },
  { id: 's24u', brand: 'Samsung', name: 'Galaxy S24 Ultra', diag: 6.8, res: [3120, 1440], css: [384, 832], ua: /SM-S928/i },
  { id: 's24', brand: 'Samsung', name: 'Galaxy S24', diag: 6.2, res: [2340, 1080], css: [360, 780], ua: /SM-S921/i },
  { id: 's23', brand: 'Samsung', name: 'Galaxy S23', diag: 6.1, res: [2340, 1080], css: [360, 780], ua: /SM-S911/i },
  { id: 'a54', brand: 'Samsung', name: 'Galaxy A54', diag: 6.4, res: [2340, 1080], css: [384, 832], ua: /SM-A546/i },
  { id: 'px8', brand: 'Google', name: 'Pixel 8', diag: 6.2, res: [2400, 1080], css: [412, 915], ua: /Pixel 8(?! Pro)/i },
  { id: 'px8p', brand: 'Google', name: 'Pixel 8 Pro', diag: 6.7, res: [2992, 1344], css: [448, 998], ua: /Pixel 8 Pro/i },
  { id: 'px9x', brand: 'Google', name: 'Pixel 9 Pro XL', diag: 6.8, res: [2992, 1344], css: [448, 998], ua: /Pixel 9 Pro XL/i },
  { id: 'op12', brand: 'OnePlus', name: 'OnePlus 12', diag: 6.82, res: [3168, 1440], css: [412, 905], ua: /CPH2581|CPH2583/i },
  { id: 'mi14', brand: 'Xiaomi', name: 'Xiaomi 14', diag: 6.36, res: [2670, 1200], css: [393, 873], ua: /23127PN0CG/i },
  { id: 'ip15', brand: 'Apple', name: 'iPhone 15', diag: 6.1, res: [2556, 1179], css: [393, 852], ua: null },
  { id: 'ip15pm', brand: 'Apple', name: 'iPhone 15 Pro Max', diag: 6.7, res: [2796, 1290], css: [430, 932], ua: null },
  { id: 'ip13m', brand: 'Apple', name: 'iPhone 13 mini', diag: 5.4, res: [2340, 1080], css: [375, 812], ua: null },
];
for (const p of PHONES) { const [L, S] = p.res, d = p.diag * 25.4, h = Math.hypot(L, S); p.mmL = d * L / h; p.mmS = d * S / h; }

export const hud = {
  phone: null, size: 'real', scale: 1, opacity: 1, shell: true, labels: true, stats: false, offsets: { xb: {}, ps: {} },
  ...load('hud', {}),
};
hud.kb = { move: 'wasd', keys: ['space', 'shift', 'e', 'q', 'r', 'f', 'ctrl', 'esc'], ...(hud.kb ?? {}) };
hud.offsets = { xb: {}, ps: {}, ...(hud.offsets ?? {}) };
export const saveHud = () => save('hud', hud);
export const currentPhone = () => PHONES.find((p) => p.id === hud.phone) ?? PHONES[0];
const padType = () => (me.vtype === 'ds4' ? 'ps' : 'xb');

async function detect() {
  let model = '';
  try { if (navigator.userAgentData?.getHighEntropyValues) model = (await navigator.userAgentData.getHighEntropyValues(['model'])).model || ''; } catch {}
  const ua = `${model} ${navigator.userAgent}`;
  const hit = PHONES.find((p) => p.ua?.test(ua));
  if (hit) return { phone: hit, how: 'Detected' };
  const L = Math.max(screen.width, screen.height), S = Math.min(screen.width, screen.height);
  const near = [...PHONES].sort((a, b) => (Math.abs(a.css[1] - L) + Math.abs(a.css[0] - S)) - (Math.abs(b.css[1] - L) + Math.abs(b.css[0] - S)))[0];
  return { phone: near, how: 'Best guess' };
}

// ---------- layouts in mm: origin = screen centre, y down; size [w, h] ----------
const LAYOUTS = {
  xb: {
    ls: { at: [-38, -3], size: [31, 31] }, face: { at: [38, -3], size: [33, 33] },
    dpad: { at: [-19, 18], size: [27, 27] }, rs: { at: [19, 18], size: [28, 28] },
    view: { at: [-11, -9], size: [8, 8] }, menu: { at: [11, -9], size: [8, 8] }, home: { at: [0, -17], size: [11, 11] },
  },
  ps: {
    dpad: { at: [-39, -2], size: [28, 28] }, face: { at: [39, -2], size: [33, 33] },
    ls: { at: [-20, 18], size: [26, 26] }, rs: { at: [20, 18], size: [26, 26] },
    touch: { at: [0, -10], size: [40, 18] }, view: { at: [-25, -13], size: [5, 8] }, menu: { at: [25, -13], size: [5, 8] },
    home: { at: [0, 7], size: [8, 8] },
  },
};
const TOP = { lt: { w: 30, h: 13, edge: 3 }, lb: { w: 21, h: 9, edge: 35 } };   // anchored to the screen corners
const SHELL = {
  xb: [[0, -27], [28, -28], [50, -26], [66, -15], [74, 4], [78, 28], [74, 48], [62, 57], [51, 52], [42, 38], [28, 31], [0, 30]],
  ps: [[0, -24], [46, -25], [63, -19], [72, -2], [77, 26], [76, 50], [67, 60], [56, 55], [46, 38], [30, 31], [0, 31]],
};
function catmull(pts) {
  let d = `M${pts[0][0]} ${pts[0][1]}`;
  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[i - 1] || pts[i], p1 = pts[i], p2 = pts[i + 1], p3 = pts[i + 2] || p2;
    d += ` C${p1[0] + (p2[0] - p0[0]) / 6} ${p1[1] + (p2[1] - p0[1]) / 6} ${p2[0] - (p3[0] - p1[0]) / 6} ${p2[1] - (p3[1] - p1[1]) / 6} ${p2[0]} ${p2[1]}`;
  }
  return d;
}
const realPxPerMm = () => Math.max(screen.width, screen.height, innerWidth) / currentPhone().mmL;
const place = (el, x, y, w, h) => { el.style.left = `${x - w / 2}px`; el.style.top = `${y - h / 2}px`; el.style.width = `${w}px`; el.style.height = `${h}px`; };
let fitNote = '';

export function layoutPad() {
  const pad = $('pad');
  if (pad.classList.contains('hidden')) return;
  const W = innerWidth, H = innerHeight, type = padType(), real = realPxPerMm();
  pad.dataset.type = type;
  document.body.dataset.glyph = type;
  const L = LAYOUTS[type], off = hud.offsets[type] ?? {};
  let ext = 0, top = 0, bot = 0;
  for (const k in L) {
    const o = off[k] ?? {}, s = o.s ?? 1, x = L[k].at[0] + (o.dx ?? 0), y = L[k].at[1] + (o.dy ?? 0);
    ext = Math.max(ext, Math.abs(x) + L[k].size[0] * s / 2);
    top = Math.min(top, y - L[k].size[1] * s / 2); bot = Math.max(bot, y + L[k].size[1] * s / 2);
  }
  const tu = Math.min(real, (W / 2 - 60) / 62);
  const yTop = 8 + TOP.lt.h * tu + 8, availH = H - 8 - yTop;
  let u = real * hud.scale;
  const maxU = Math.min((W / 2 - 10) / ext, availH / (bot - top));
  if (hud.size === 'fit') u = maxU * hud.scale;
  const fitted = u > maxU + 1e-6;
  if (fitted) u = maxU;
  fitNote = fitted || hud.size === 'fit' ? `Scaled to ${Math.round((u / real) * 100)}% to fit this screen` : `Real size · ${u.toFixed(2)} px per mm`;
  pad.style.setProperty('--u', u.toFixed(4));
  const cx = W / 2, cy = yTop + (availH - (bot - top) * u) / 2 - top * u;
  pad.querySelectorAll('.ctl').forEach((el) => {
    const id = el.dataset.id, def = L[id];
    if (TOP[id] || /^r[tb]$/.test(id)) return;
    el.hidden = !def;
    if (!def) return;
    const o = off[id] ?? {}, s = o.s ?? 1;
    place(el, cx + (def.at[0] + (o.dx ?? 0)) * u, cy + (def.at[1] + (o.dy ?? 0)) * u, def.size[0] * s * u, def.size[1] * s * u);
  });
  for (const [id, mirror] of [['lt', 0], ['lb', 0], ['rt', 1], ['rb', 1]]) {
    const t = TOP[id.replace('r', 'l')], el = pad.querySelector(`[data-id=${id}]`), o = off[id] ?? {}, s = o.s ?? 1;
    const w = t.w * tu * s, h = t.h * tu * s, x = t.edge * tu + w / 2 + (o.dx ?? 0) * tu;
    place(el, mirror ? W - x : x, 8 + h / 2 + (id.endsWith('b') ? ((TOP.lt.h - t.h) / 2) * tu : 0) + (o.dy ?? 0) * tu, w, h);
  }
  const shell = pad.querySelector('.shell'), half = SHELL[type];
  const pts = half.concat(half.slice(0, -1).reverse().map(([x, y]) => [-x, y]));
  shell.setAttribute('viewBox', `0 0 ${W} ${H}`);
  shell.firstElementChild.setAttribute('d', `${catmull(pts.map(([x, y]) => [cx + x * u, cy + y * u]))}Z`);
  pad.classList.toggle('no-shell', !hud.shell);
  pad.classList.toggle('no-labels', !hud.labels);
  pad.classList.toggle('show-stats', hud.stats);
  pad.style.setProperty('--op', hud.opacity);
}

// ---------- keyboard: inverted T on the left thumb, chosen keys packed into rows of 4 units on the right ----------
export const KEYS = {
  space: ['Space', 0x20, 2], shift: ['Shift', 0x10, 1.5], enter: ['Enter', 0x0d, 1.5], ctrl: ['Ctrl', 0x11, 1], alt: ['Alt', 0x12, 1],
  tab: ['Tab', 0x09, 1], esc: ['Esc', 0x1b, 1], e: ['E', 0x45, 1], q: ['Q', 0x51, 1], r: ['R', 0x52, 1], f: ['F', 0x46, 1],
  c: ['C', 0x43, 1], g: ['G', 0x47, 1], m: ['M', 0x4d, 1], 1: ['1', 0x31, 1], 2: ['2', 0x32, 1], 3: ['3', 0x33, 1], 4: ['4', 0x34, 1],
};
export const MOVE = { wasd: [['W', 0x57], ['A', 0x41], ['S', 0x53], ['D', 0x44]], arrows: [['↑', 0x26], ['←', 0x25], ['↓', 0x28], ['→', 0x27]], none: [] };
const PITCH = 19.05;

export function buildKeys() {
  const kmove = $('kmove'), kgrid = $('kgrid');
  kmove.innerHTML = MOVE[hud.kb.move].map(([label, vk]) => `<button class="kk" data-vk="${vk}">${label}</button>`).join('');
  kgrid.innerHTML = hud.kb.keys.filter((k) => KEYS[k]).map((k) => `<button class="kk" data-vk="${KEYS[k][1]}" data-w="${KEYS[k][2]}">${KEYS[k][0]}</button>`).join('');
  layoutKeys();
}
export function layoutKeys() {
  const ov = $('keys');
  if (ov.classList.contains('hidden')) return;
  const W = innerWidth, H = innerHeight, real = realPxPerMm(), kmove = $('kmove'), kgrid = $('kgrid');
  const rows = []; let row = [], used = 0;
  for (const el of kgrid.children) { const w = +el.dataset.w; if (used + w > 4 && row.length) { rows.push(row); row = []; used = 0; } row.push(el); used += w; }
  if (row.length) rows.push(row);
  const width = (r) => r.reduce((a, el) => a + +el.dataset.w, 0);
  const gUnits = Math.max(0, ...rows.map(width)), mUnits = kmove.children.length ? 3 : 0;
  const nRows = Math.max(kmove.children.length ? 2 : 0, rows.length, 1);
  const yTop = 50, availH = H - yTop - 10, needW = (mUnits + gUnits) * PITCH + 24, needH = nRows * PITCH;
  let u = real * hud.scale;
  const maxU = Math.min((W - 24) / needW, availH / needH);
  if (hud.size === 'fit') u = maxU * hud.scale;
  const fitted = u > maxU + 1e-6;
  if (fitted) u = maxU;
  fitNote = fitted || hud.size === 'fit' ? `Keys scaled to ${Math.round((u / real) * 100)}% to fit` : 'Real keycap size · 19 mm pitch';
  const pitch = PITCH * u, gap = Math.max(4, 1.6 * u), cy = yTop + availH / 2, side = Math.max(12, W * 0.05);
  ov.style.setProperty('--kp', `${pitch}px`);
  ov.style.setProperty('--op', hud.opacity);
  const put = (el, x, y, w) => { el.style.left = `${x}px`; el.style.top = `${y}px`; el.style.width = `${w * pitch - gap}px`; el.style.height = `${pitch - gap}px`; };
  [[1, 0], [0, 1], [1, 1], [2, 1]].forEach(([x, y], i) => kmove.children[i] && put(kmove.children[i], side + x * pitch, cy - pitch + y * pitch, 1));
  const gy = cy - (rows.length * pitch) / 2;
  rows.forEach((r, ri) => { let x = W - side - width(r) * pitch; for (const el of r) { put(el, x, gy + ri * pitch, +el.dataset.w); x += +el.dataset.w * pitch; } });
}

addEventListener('resize', () => { layoutPad(); layoutKeys(); });

// ---------- island: player light + number + latency (on every controller screen) ----------
export function islandHtml() {
  return `<div class="island"><i class="lb"></i><b class="pn player-tag">P–</b><span class="msg"></span><span class="ping"><b class="pingv">–</b>ms</span><button class="gear hudOpen" aria-label="HUD options"><svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="3"/><path d="M12 3v2.5M12 18.5V21M3 12h2.5M18.5 12H21M5.6 5.6l1.8 1.8M16.6 16.6l1.8 1.8M5.6 18.4l1.8-1.8M16.6 7.4l1.8-1.8"/></svg></button></div>`;
}
let popT;
export function pop(text) {
  document.querySelectorAll('.island .msg').forEach((m) => { m.textContent = text; });
  document.querySelectorAll('.island').forEach((i) => i.classList.add('is-pop'));
  clearTimeout(popT);
  popT = setTimeout(() => document.querySelectorAll('.island').forEach((i) => i.classList.remove('is-pop')), 2000);
}
let lastColor = null;
onIdentity(() => {
  if (me.kicked) return;
  if (lastColor && me.color !== lastColor) pop(`Player ${me.player} · new light`);
  lastColor = me.color;
  layoutPad();
  reportDevice();
});
onBuzz(() => pop('The laptop is looking for this phone'));

// ---------- what we tell the laptop about this phone ----------
let battery = null;
async function reportDevice() {
  const p = currentPhone();
  if (!battery && navigator.getBattery) { try { battery = await navigator.getBattery(); battery.onlevelchange = battery.onchargingchange = reportDevice; } catch {} }
  link.sendJson({
    type: 'device', model: hud.phone ? p.name : null, layout: hud.size === 'fit' ? 'fill screen' : 'real size',
    screen: `${Math.round(p.mmL)} × ${Math.round(p.mmS)} mm`, battery: battery ? Math.round(battery.level * 100) : null, charging: battery?.charging ?? false,
  });
}

// ---------- phone picker (first run, or "change") ----------
export async function openPicker() {
  const sug = await detect();
  const groups = {};
  for (const p of PHONES) (groups[p.brand] ??= []).push(p);
  $('pkList').innerHTML = Object.entries(groups).map(([b, list]) => `<div class="pk-group"><span class="lbl">${b}</span>${list.map((p) => `
    <button class="pk-row${sug.phone === p ? ' is-sug' : ''}" data-phone="${p.id}">
      <i class="pk-ico" style="--ar:${(p.res[0] / p.res[1]).toFixed(3)}"></i>
      <span><b>${p.name}</b><small>${p.diag}″ · ${p.mmL.toFixed(0)} × ${p.mmS.toFixed(0)} mm</small></span>
      ${sug.phone === p ? `<em>${sug.how}</em>` : ''}
    </button>`).join('')}</div>`).join('');
  $('picker').classList.remove('hidden');
}
$('pkList').addEventListener('click', (e) => {
  const r = e.target.closest('.pk-row');
  if (!r) return;
  hud.phone = r.dataset.phone;
  saveHud();
  $('picker').classList.add('hidden');
  renderHome();
  reportDevice();
});
$('pkSkip').onclick = () => $('picker').classList.add('hidden');

export function renderHome() {
  const p = currentPhone();
  $('phoneModel').textContent = hud.phone ? `${p.name} · ${p.mmL.toFixed(0)} × ${p.mmS.toFixed(0)} mm` : 'Pick your phone for real-size buttons';
}
$('phoneChange').onclick = openPicker;

// ---------- HUD sheet ----------
const sheet = $('hudSheet');
function segPick(id, value) { $(id).querySelectorAll('button').forEach((b) => b.classList.toggle('is-on', b.dataset.v === value)); }
function syncSheet() {
  segPick('hSize', hud.size);
  segPick('hMove', hud.kb.move);
  $('hScale').value = Math.round(hud.scale * 100); $('hScaleV').textContent = `${Math.round(hud.scale * 100)}%`;
  $('hOpacity').value = Math.round(hud.opacity * 100); $('hOpacityV').textContent = `${Math.round(hud.opacity * 100)}%`;
  $('hShell').checked = hud.shell; $('hLabels').checked = hud.labels; $('hStats').checked = hud.stats;
  $('hPhone').textContent = currentPhone().name;
  $('hNote').textContent = fitNote;
  $('hChips').innerHTML = Object.entries(KEYS).map(([k, [label]]) => `<button class="chip${hud.kb.keys.includes(k) ? ' is-on' : ''}" data-k="${k}">${label}</button>`).join('');
  const where = sheet.dataset.ctx;
  sheet.querySelectorAll('[data-only]').forEach((el) => { el.hidden = !el.dataset.only.split(' ').includes(where); });
}
export function openSheet(ctx) { sheet.dataset.ctx = ctx; syncSheet(); sheet.classList.remove('hidden'); }
const changed = () => { saveHud(); layoutPad(); buildKeys(); syncSheet(); };
document.addEventListener('click', (e) => {
  const g = e.target.closest('.hudOpen');
  if (!g) return;
  const ctx = !$('keys').classList.contains('hidden') ? 'keys' : !$('pad').classList.contains('hidden') ? 'pad' : 'home';
  openSheet(ctx);
});
$('hClose').onclick = () => sheet.classList.add('hidden');
$('hPhoneChange').onclick = () => { sheet.classList.add('hidden'); openPicker(); };
$('hSize').onclick = (e) => { const b = e.target.closest('button'); if (b) { hud.size = b.dataset.v; changed(); } };
$('hMove').onclick = (e) => { const b = e.target.closest('button'); if (b) { hud.kb.move = b.dataset.v; changed(); } };
$('hScale').oninput = (e) => { hud.scale = +e.target.value / 100; changed(); };
$('hOpacity').oninput = (e) => { hud.opacity = +e.target.value / 100; changed(); };
$('hShell').onchange = (e) => { hud.shell = e.target.checked; changed(); };
$('hLabels').onchange = (e) => { hud.labels = e.target.checked; changed(); };
$('hStats').onchange = (e) => { hud.stats = e.target.checked; changed(); };
$('hChips').onclick = (e) => {
  const c = e.target.closest('.chip'); if (!c) return;
  const i = hud.kb.keys.indexOf(c.dataset.k);
  if (i >= 0) hud.kb.keys.splice(i, 1); else if (hud.kb.keys.length < 12) hud.kb.keys.push(c.dataset.k);
  changed();
};
$('hReset').onclick = () => { hud.offsets[padType()] = {}; changed(); };

// ---------- edit layout: drag a control to move it, +/- to resize ----------
let sel = null, drag = null;
const pad = $('pad');
$('hEdit').onclick = () => { sheet.classList.add('hidden'); pad.classList.add('editing'); };
$('eDone').onclick = () => { pad.classList.remove('editing'); select(null); };
$('eReset').onclick = () => { hud.offsets[padType()] = {}; changed(); };
function select(el) {
  pad.querySelectorAll('.ctl.is-sel').forEach((x) => x.classList.remove('is-sel'));
  sel = el; el?.classList.add('is-sel');
  $('eSel').textContent = el ? el.dataset.name : 'Drag a control to move it';
}
const unitFor = (id) => (TOP[id] || /^r[tb]$/.test(id) ? Math.min(realPxPerMm(), (innerWidth / 2 - 60) / 62) : parseFloat(pad.style.getPropertyValue('--u')));
// Capture phase on the overlay: while editing, the controls must not send input.
pad.addEventListener('pointerdown', (e) => {
  if (!pad.classList.contains('editing') || e.target.closest('.editbar')) return;
  e.stopPropagation();
  const el = e.target.closest('.ctl');
  if (!el) return;
  select(el);
  const offs = hud.offsets[padType()], o = (offs[el.dataset.id] ??= {});
  drag = { el, o, x: e.clientX, y: e.clientY, dx: o.dx ?? 0, dy: o.dy ?? 0, u: unitFor(el.dataset.id) };
  try { pad.setPointerCapture(e.pointerId); } catch {}
}, true);
pad.addEventListener('pointermove', (e) => {
  if (!drag) return;
  const mirror = /^r[tb]$/.test(drag.el.dataset.id) ? -1 : 1;
  drag.o.dx = drag.dx + (mirror * (e.clientX - drag.x)) / drag.u;
  drag.o.dy = drag.dy + (e.clientY - drag.y) / drag.u;
  layoutPad();
}, true);
pad.addEventListener('pointerup', (e) => { if (drag) { drag = null; saveHud(); e.stopPropagation(); } }, true);
const resize = (f) => { if (!sel) return; const o = (hud.offsets[padType()][sel.dataset.id] ??= {}); o.s = Math.max(0.6, Math.min(1.6, (o.s ?? 1) * f)); saveHud(); layoutPad(); };
$('eUp').onclick = () => resize(1.08);
$('eDown').onclick = () => resize(1 / 1.08);

// first run
renderHome();
if (!hud.phone) openPicker();

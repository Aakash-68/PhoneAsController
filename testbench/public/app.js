// Manager window ("Focus"): pick a phone on the left, see its live input, tune it, set its light.
// Everything comes from the server's ~30 Hz state feed (/ws?role=dashboard); changes go back over the same socket.
import { fmt } from './common.js';

const $ = (id) => document.getElementById(id);
const B = document.body;
let ws = null, palette = [], nets = [], netIndex = 0, clients = [], selected = null, setupState = null, lastState = null;

const send = (o) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
async function post(action, body = {}) {
  const r = await fetch(`/api/admin/${action}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const data = await r.json().catch(() => ({}));
  if (!r.ok || data.ok === false) throw new Error(data.error ?? `HTTP ${r.status}`);
  return data;
}
const MODE = { pad: 'Gamepad', wheel: 'Wheel', mouse: 'Mouse', keys: 'Keyboard', idle: 'Menu' };
const VNAME = { x360: 'Xbox 360', ds4: 'DualShock 4', off: 'Off' };

// ---------- navigation ----------
document.querySelectorAll('.navpill a[data-view]').forEach((a) => {
  a.onclick = () => {
    B.dataset.view = a.dataset.view;
    document.querySelectorAll('.navpill a[data-view]').forEach((x) => x.classList.toggle('is-on', x === a));
    if (a.dataset.view === 'setup') refreshSetup(true);
  };
});
$('copyAddr').onclick = async () => {
  try { await navigator.clipboard.writeText($('addrText').textContent); $('copyAddr').textContent = 'Copied'; setTimeout(() => { $('copyAddr').textContent = 'Copy'; }, 1200); } catch {}
};

// ---------- join (QR) ----------
// Three ways in. The hotspot is the default: it needs nothing but the laptop and the phone.
let hs = null, joinTab = null, joinStep = 1, stepTouched = false;
async function refreshInfo() {
  try {
    const info = await (await fetch('/api/info')).json();
    if (!palette.length) { palette = info.palette; renderSwatches(); }
    nets = info.interfaces;
    hs = await (await fetch('/api/setup/hotspot')).json();
    renderQr();
    renderHotspot();
  } catch {}
}
const netOf = (kind) => nets.find((n) => n.kind === kind);
function joinTabs() {
  const tabs = [{ id: 'hotspot', label: 'Hotspot' }, { id: 'usb', label: 'USB cable' }];
  for (const n of nets) if (n.kind !== 'hotspot' && n.kind !== 'usb') tabs.push({ id: n.address, label: n.label, net: n });
  return tabs;
}
function setQr(svg, url, help) {
  $('qrWrap').classList.toggle('hidden', !svg);
  if (svg) $('qrBox').innerHTML = svg;
  $('qrUrl').textContent = url;
  $('qrUrl').classList.toggle('hidden', !url);
  $('joinHelp').textContent = help;
}
const hostOf = (n) => n.httpsUrl.replace(/^https:\/\//, '').replace(/\/$/, '');
function renderQr() {
  const tabs = joinTabs();
  if (!tabs.some((t) => t.id === joinTab)) joinTab = 'hotspot';
  $('netTabs').innerHTML = tabs.map((t) => `<button class="${t.id === joinTab ? 'sel' : ''}" data-id="${t.id}">${t.label}</button>`).join('');
  $('netTabs').querySelectorAll('button').forEach((b) => { b.onclick = () => { joinTab = b.dataset.id; renderQr(); }; });

  const isHotspot = joinTab === 'hotspot';
  $('joinSteps').classList.toggle('hidden', !isHotspot);
  $('hsCreds').classList.toggle('hidden', !isHotspot || joinStep !== 1);
  let shown = null;
  if (isHotspot) {
    const n = netOf('hotspot');
    $('joinSteps').querySelectorAll('button').forEach((b) => b.classList.toggle('sel', +b.dataset.step === joinStep));
    if (!hs || hs.status === 'off') setQr('', '', 'The hotspot is off. Turn it on in Setup.');
    else if (hs.status === 'error') setQr('', '', hs.error);
    else if (joinStep === 1) {
      $('hsSsid').textContent = hs.ssid;
      $('hsPass').textContent = hs.pass;
      setQr(hs.qrWifi, '', 'Scan with the phone camera and tap Join. If the phone warns about no internet, choose to stay connected.');
    } else if (n) {
      shown = n;
      setQr(n.qrHttps, hostOf(n), 'Scan to open the controller. On the security warning tap Advanced, then Proceed: this only happens once.');
    } else setQr('', '', 'Starting the hotspot…');
  } else if (joinTab === 'usb') {
    const n = netOf('usb');
    if (n) { shown = n; setQr(n.qrHttps, hostOf(n), 'Cable connected. Scan to open the controller.'); }
    else setQr('', '', 'Plug the phone in with a USB cable, then on the phone turn on Settings > Connections > Mobile Hotspot and Tethering > USB tethering. The code appears here. No mobile data is used.');
  } else {
    const n = nets.find((x) => x.address === joinTab);
    if (n) { shown = n; setQr(n.qrHttps, hostOf(n), `The phone must be on the same ${n.label} network as this laptop.`); }
  }
  $('addrText').textContent = shown ? hostOf(shown) : isHotspot && hs?.ssid ? hs.ssid : '–';
}
$('joinSteps').onclick = (e) => { const b = e.target.closest('button'); if (b) { joinStep = +b.dataset.step; stepTouched = true; renderQr(); } };
$('allowJoins').onclick = () => send({ type: 'settings', lockJoins: $('allowJoins').classList.contains('is-on') });

// ---------- hotspot settings ----------
function renderHotspot() {
  if (!hs) return;
  $('hsToggle').classList.toggle('is-on', hs.status === 'on' || hs.status === 'starting');
  $('hsAuto').classList.toggle('is-on', !!hs.auto);
  $('hsStatus').textContent = hs.status === 'on' ? `On: phones can join "${hs.ssid}". No internet or router needed.`
    : hs.status === 'starting' ? 'Starting…' : hs.status === 'error' ? hs.error : 'Off. Phones connect straight to this laptop when it is on.';
  if (document.activeElement !== $('hsSsidIn')) $('hsSsidIn').value = hs.ssid;
  if (document.activeElement !== $('hsPassIn')) $('hsPassIn').value = hs.pass;
}
async function changeHotspot(body, done = '') {
  try {
    await post('hotspot', body);
    $('hsMsg').textContent = done;
    await refreshInfo();
  } catch (e) { $('hsMsg').textContent = e.message; }
}
$('hsToggle').onclick = () => changeHotspot({ on: !$('hsToggle').classList.contains('is-on') });
$('hsAuto').onclick = () => changeHotspot({ auto: !$('hsAuto').classList.contains('is-on') });
$('hsSave').onclick = () => changeHotspot({ ssid: $('hsSsidIn').value, pass: $('hsPassIn').value }, 'Saved. Phones need to join the network again if you changed it.');
$('hsRegen').onclick = () => { if (confirm('Make a new hotspot password? Phones will need to join again.')) changeHotspot({ regenerate: true }, 'New password set.'); };

// ---------- player list ----------
const joined = () => clients.filter((c) => c.player).sort((a, b) => a.player - b.player);
const modelOf = (c) => c.device?.model ?? (/Android [\d.]+; ([^;)]+)/.exec(c.ua)?.[1]?.replace(/ Build.*/, '') ?? (/iPhone/.test(c.ua) ? 'iPhone' : 'Phone'));
const pingOf = (c) => (c.oneWay?.p50 != null ? c.oneWay.p50 : c.syncRtt != null ? c.syncRtt / 2 : null);

function renderList() {
  const list = joined();
  if (!list.some((c) => c.id === selected)) selected = list[0]?.id ?? null;
  const box = $('items');
  const ids = list.map((c) => c.id).join(',');
  if (box.dataset.ids !== ids) {
    box.dataset.ids = ids;
    box.innerHTML = list.map((c) => `<button class="item" data-id="${c.id}"><span class="pnum"></span><span><b></b><small></small></span><span class="term mini"><b class="p"></b>ms</span></button>`).join('');
    box.querySelectorAll('.item').forEach((el) => { el.onclick = () => { selected = +el.dataset.id; render(); }; });
  }
  list.forEach((c, i) => {
    const el = box.children[i];
    el.classList.toggle('is-on', c.id === selected);
    el.style.setProperty('--ic', c.color);
    el.querySelector('.pnum').textContent = c.player;
    el.querySelector('b').textContent = c.name;
    el.querySelector('small').textContent = `${modelOf(c)} · ${MODE[c.mode] ?? c.mode}`;
    const p = pingOf(c);
    el.querySelector('.p').textContent = p != null ? fmt(p, 0) : '–';
  });
  $('playersLbl').textContent = `Players · ${list.length} / 8`;
  $('slotsFree').textContent = list.length ? `${8 - list.length} free slots · scan the code to add one` : 'Scan the code with your phone camera';
  // A phone that got here has clearly joined; the next one is most likely to need step 1 again.
  if (list.length && !stepTouched) joinStep = 1;
}

// ---------- selected phone ----------
const STICK_SCALE = 1;
function renderSelected() {
  const c = clients.find((x) => x.id === selected);
  $('mainDevices').classList.toggle('none', !c);
  if (!c) return;
  const main = $('mainDevices');
  main.style.setProperty('--c', c.color);
  $('dNum').textContent = c.player;
  $('iNum').textContent = `P${c.player}`;
  if (document.activeElement !== $('dName')) $('dName').value = c.name;
  const d = c.device;
  $('dModel').textContent = [modelOf(c), d?.screen, d?.layout, c.iface, c.transport === 'rtc' ? 'WebRTC' : null].filter(Boolean).join(' · ');
  const batt = $('dBatt');
  batt.hidden = d?.battery == null;
  if (d?.battery != null) { batt.style.setProperty('--b', d.battery / 100); batt.querySelector('span').textContent = `${d.battery}%${d.charging ? ' ⚡' : ''}`; }
  const p = pingOf(c);
  $('dPing').textContent = p != null ? fmt(p, 0) : '–';

  // acts as + what the phone screen is doing
  $('roleKeys').querySelectorAll('.key').forEach((k) => k.classList.toggle('is-on', k.dataset.v === c.vtype));
  $('screenNote').textContent = `Phone screen: ${MODE[c.mode] ?? c.mode}${c.vslot != null ? ` · plugged in as ${VNAME[c.vplugged]}` : ''}`;

  // player light
  $('sws').querySelectorAll('.sw').forEach((s) => s.classList.toggle('is-on', s.dataset.color === c.color));
  $('cName').textContent = `${palette.find((x) => x.hex === c.color)?.name ?? 'Custom'} · shown on the phone's island`;

  // live input
  const pad = c.pad, live = c.idleMs != null && c.idleMs < 600;
  $('monLed').classList.toggle('on', live);
  const hz = c.interval?.p50 ? 1000 / c.interval.p50 : null;
  $('monMode').textContent = `${(MODE[c.mode] ?? c.mode).toUpperCase()}${hz && live ? ` · ${Math.round(hz)} HZ` : ''}`;
  const stick = (el, x, y) => { el.style.setProperty('--x', x * STICK_SCALE); el.style.setProperty('--y', y * STICK_SCALE); el.style.setProperty('--m', Math.min(1, Math.hypot(x, y))); };
  if (pad && c.mode === 'pad' || pad && c.mode === 'wheel') {
    stick($('mLS'), pad.lx, pad.ly); stick($('mRS'), pad.rx, pad.ry);
    $('mL2').style.setProperty('--v', pad.l2); $('mR2').style.setProperty('--v', pad.r2);
    document.querySelectorAll('.mbtn').forEach((b) => b.classList.toggle('on', !!(pad.buttons & (1 << +b.dataset.bit))));
  } else {
    stick($('mLS'), 0, 0); stick($('mRS'), 0, 0);
    $('mL2').style.setProperty('--v', 0); $('mR2').style.setProperty('--v', 0);
    document.querySelectorAll('.mbtn').forEach((b) => b.classList.remove('on'));
  }

  // dials
  for (const el of dials) if (el !== dragging && c.tune) setDial(el, c.tune[el.dataset.tune], false);

  // latency terminal
  const o = c.oneWay;
  $('latBig').textContent = o?.p50 != null ? fmt(o.p50, 0) : p != null ? fmt(p, 0) : '–';
  $('latFoot').textContent = o ? `P50 ${fmt(o.p50, 1)} · P95 ${fmt(o.p95, 1)} · P99 ${fmt(o.p99, 1)} · ${c.transport === 'rtc' ? 'WEBRTC' : 'WEBSOCKET'}` : 'waiting for input…';
  drawSpark($('latCanvas'), c.oneWaySamples ?? []);
}
$('dName').addEventListener('change', (e) => send({ type: 'player-update', id: selected, name: e.target.value }));
$('dName').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); });
$('buzzBtn').onclick = () => { send({ type: 'buzz', id: selected }); pop('buzzing…'); };
$('kickBtn').onclick = () => { const c = clients.find((x) => x.id === selected); if (c && confirm(`Disconnect ${c.name}?`)) send({ type: 'kick', id: selected }); };
$('roleKeys').onclick = (e) => { const k = e.target.closest('.key'); if (k) send({ type: 'player-update', id: selected, vtype: k.dataset.v }); };
$('rumbleTgl').onclick = () => send({ type: 'settings', rumble: !$('rumbleTgl').classList.contains('is-on') });

function renderSwatches() {
  $('sws').innerHTML = palette.map((p) => `<button class="sw" data-color="${p.hex}" style="--sw:${p.hex}" title="${p.name}"></button>`).join('');
}
$('sws').onclick = (e) => {
  const s = e.target.closest('.sw'); if (!s) return;
  send({ type: 'player-update', id: selected, color: s.dataset.color });
  pop(`${s.title} light sent`);
};
let popT;
function pop(text) {
  $('iMsg').textContent = text;
  $('island').classList.add('is-pop');
  clearTimeout(popT); popT = setTimeout(() => $('island').classList.remove('is-pop'), 1800);
}

function drawSpark(cv, samples) {
  const dpr = devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
  if (!w || !h) return;
  if (cv.width !== w * dpr || cv.height !== h * dpr) { cv.width = w * dpr; cv.height = h * dpr; }
  const g = cv.getContext('2d');
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, w, h);
  const s = samples.slice(-160);
  if (s.length < 2) return;
  const max = Math.max(12, ...s) * 1.1, step = w / (s.length - 1);
  g.beginPath();
  s.forEach((v, i) => { const x = i * step, y = h - (Math.max(0, v) / max) * (h - 4) - 2; i ? g.lineTo(x, y) : g.moveTo(x, y); });
  g.lineWidth = 1.5; g.strokeStyle = '#ff7a2c'; g.lineJoin = 'round'; g.shadowColor = 'rgba(255,106,26,.8)'; g.shadowBlur = 4; g.stroke();
  g.shadowBlur = 0; g.lineTo(w, h); g.lineTo(0, h); g.closePath(); g.fillStyle = 'rgba(255,106,26,.14)'; g.fill();
}

// ---------- dials: drag around the centre; values go to the phone as its "tune" ----------
const dials = [...document.querySelectorAll('.gdial')];
let dragging = null, sendT = null;
const A0 = -140, A1 = 140;
const fmtTune = { vib: (v) => `${Math.round(v * 100)}%`, sens: (v) => `${v.toFixed(2)}×`, dead: (v) => `${Math.round(v * 100)}%`, trig: (v) => `${v.toFixed(2)}×` };
function setDial(el, v, fromUser) {
  const lo = +el.dataset.lo, hi = +el.dataset.hi, k = Math.min(1, Math.max(0, (v - lo) / (hi - lo)));
  el.dataset.v = v;
  el.style.setProperty('--a', `${A0 + k * (A1 - A0)}deg`);
  document.querySelector(`[data-out="${el.dataset.tune}"]`).textContent = fmtTune[el.dataset.tune](v);
  const dots = document.querySelectorAll(`[data-dots="${el.dataset.tune}"] b`);
  dots.forEach((b, i) => b.classList.toggle('on', i / (dots.length - 1) <= k + 1e-6));
  if (fromUser) {
    clearTimeout(sendT);
    sendT = setTimeout(() => send({ type: 'player-update', id: selected, tune: { [el.dataset.tune]: +el.dataset.v } }), 60);
  }
}
document.querySelectorAll('[data-dots]').forEach((el) => {
  el.innerHTML = Array.from({ length: 13 }, (_, i) => { const a = (A0 + (i * (A1 - A0)) / 12) * Math.PI / 180; return `<b style="left:${Math.sin(a) * 54}px;top:${-Math.cos(a) * 54}px"></b>`; }).join('');
});
for (const el of dials) {
  let prev = null;
  const angle = (e) => { const r = el.getBoundingClientRect(); return Math.atan2(e.clientY - (r.top + r.height / 2), e.clientX - (r.left + r.width / 2)) * 180 / Math.PI; };
  el.addEventListener('pointerdown', (e) => { if (selected == null) return; dragging = el; prev = angle(e); el.classList.add('held'); try { el.setPointerCapture(e.pointerId); } catch {} });
  el.addEventListener('pointermove', (e) => {
    if (dragging !== el) return;
    const a = angle(e); let d = a - prev; if (d > 180) d -= 360; if (d < -180) d += 360; prev = a;
    const lo = +el.dataset.lo, hi = +el.dataset.hi, v = +el.dataset.v + (d / (A1 - A0)) * (hi - lo);
    setDial(el, Math.min(hi, Math.max(lo, v)), true);
  });
  const end = () => { if (dragging === el) { dragging = null; el.classList.remove('held'); } };
  el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
  el.addEventListener('wheel', (e) => { e.preventDefault(); const lo = +el.dataset.lo, hi = +el.dataset.hi; setDial(el, Math.min(hi, Math.max(lo, +el.dataset.v - Math.sign(e.deltaY) * (hi - lo) / 40)), true); }, { passive: false });
}

// white deck plate: flat top edge with a true circular cut-out around each dial
function drawPlate() {
  const deck = document.querySelector('.deck'), W = deck.clientWidth, H = deck.clientHeight, top = 40, R = 60, cy = 22;
  if (!W) return;
  const dx = Math.sqrt(R * R - cy * cy);
  let d = `M0 ${top}`;
  for (let i = 0; i < 4; i++) { const x = (W * (i + 0.5)) / 4; d += ` L${x - dx} ${top} A${R} ${R} 0 0 1 ${x + dx} ${top}`; }
  d += ` L${W} ${top} L${W} ${top + H} L0 ${top + H} Z`;
  $('plate').setAttribute('d', d);
  deck.querySelector('svg').setAttribute('viewBox', `0 0 ${W} ${H + top}`);
}
addEventListener('resize', drawPlate);

// ---------- event log (derived from changes in the state feed) ----------
const prev = new Map();
const lines = [];
function log(text) {
  lines.push(`${new Date().toTimeString().slice(0, 8)}  ${text}`);
  if (lines.length > 40) lines.shift();
  $('log').innerHTML = lines.slice(-5).map((l) => `<div>${l.replace(/</g, '&lt;')}</div>`).join('');
}
function diff(list) {
  const seen = new Set();
  for (const c of list) {
    if (!c.player) continue;
    seen.add(c.id);
    const p = prev.get(c.id), tag = `P${c.player} ${c.name}`;
    if (!p) log(`${tag} joined via ${c.iface}`);
    else {
      if (p.mode !== c.mode) log(`${tag} → ${MODE[c.mode] ?? c.mode}`);
      if (p.vtype !== c.vtype) log(`${tag} acts as ${VNAME[c.vtype]}`);
      if (p.vslot == null && c.vslot != null) log(`${tag} plugged in as ${VNAME[c.vplugged]}`);
      if (p.color !== c.color) log(`${tag} light changed`);
    }
    prev.set(c.id, { mode: c.mode, vtype: c.vtype, vslot: c.vslot, color: c.color, tag });
  }
  for (const [id, p] of prev) if (!seen.has(id)) { log(`${p.tag} left`); prev.delete(id); }
}

// ---------- setup ----------
async function refreshSetup(fresh = false) {
  try { setupState = await (await fetch(`/api/setup/status${fresh ? '?fresh' : ''}`)).json(); } catch { return; }
  renderSetup();
}
function step(id, state, label) {
  const li = $(id);
  li.className = state;
  li.querySelector('.state').textContent = state === 'done' ? '✓' : state === 'busy' ? '…' : '!';
  if (label) li.querySelector('.key').textContent = label;
}
function renderSetup() {
  const s = setupState;
  if (!s) return;
  const driverOk = s.driver.running && s.bridge.status === 'ready';
  step('stepDriver', driverOk ? 'done' : 'todo', s.driver.installed && !s.driver.running ? 'REPAIR' : 'INSTALL');
  step('stepFirewall', s.firewall.ok ? 'done' : 'todo', s.firewall.blocked ? 'FIX' : 'ALLOW');
  $('stepFirewall').querySelector('p').textContent = s.firewall.blocked
    ? `Windows is blocking phones on ${s.firewall.blocked} networks (the "allow access?" prompt was closed). Click Fix and say Yes to Windows.`
    : 'Lets phones on the hotspot, USB or Wi-Fi reach this laptop. Windows will ask for permission.';
  step('stepVerify', s.verified ? 'done' : 'todo');
  $('stepVerify').querySelector('.key').disabled = !driverOk;
  $('stepDriver').querySelector('.key').disabled = !s.installerBundled;
  const led = (id, ok) => { $(id).classList.toggle('g', ok); $(id).classList.toggle('on', !ok); };
  led('ledDrv', driverOk); led('ledNet', s.firewall.ok); led('ledTest', !!s.verified);
  const allOk = s.ready && s.firewall.ok;
  led('navSetupLed', allOk);
  if (!allOk && !setupShownOnce && location.hash !== '#devices') { setupShownOnce = true; document.querySelector('.navpill a[data-view=setup]').click(); }
}
let setupShownOnce = false;
for (const btn of document.querySelectorAll('[data-action]')) {
  btn.onclick = async () => {
    const li = btn.closest('li');
    step(li.id, 'busy');
    btn.disabled = true;
    $('setupMsg').textContent = {
      'install-driver': 'Follow the driver installer window. Windows will ask for permission.',
      'allow-firewall': 'Windows will ask for permission…',
      verify: 'Testing: a controller may briefly appear in Windows…',
    }[btn.dataset.action];
    try {
      const r = await post(btn.dataset.action);
      $('setupMsg').textContent = btn.dataset.action === 'verify' ? 'Test passed: games will see your phones as controllers. ✓'
        : r.rebootRequired ? 'Driver installed. Windows wants a restart before it works.' : 'Done ✓';
    } catch (e) {
      $('setupMsg').textContent = `Couldn't finish: ${e.message}`;
    }
    btn.disabled = false;
    refreshSetup(true);
  };
}
$('defaultType').onclick = (e) => { const k = e.target.closest('.key'); if (k) send({ type: 'default-type', value: k.dataset.v }); };
for (const id of ['mouseAllow', 'mouseAllow2']) $(id).onclick = () => send({ type: 'mouse-allow', on: !$(id).classList.contains('is-on') });

// ---------- quit / uninstall ----------
function stopped(title, text) {
  $('stoppedTitle').textContent = title;
  $('stoppedText').textContent = text;
  $('stopped').classList.remove('hidden');
}
$('quitBtn').onclick = async () => {
  if (!confirm('Stop PhoneController? Connected phones will disconnect.')) return;
  try { await post('quit'); } catch {}
  stopped('PhoneController has stopped', 'You can close this window. Start it again from the PhoneController shortcut.');
};
$('uninstallBtn').onclick = () => $('uninstallDlg').showModal();
if (location.hash === '#uninstall') $('uninstallDlg').showModal();   // from Windows "Installed apps"
$('unCancel').onclick = () => $('uninstallDlg').close();
$('unConfirm').onclick = async () => {
  const body = { firewall: $('unFirewall').checked, files: $('unFiles').checked, driver: $('unDriver').checked };
  $('unConfirm').disabled = true;
  $('unConfirm').textContent = 'REMOVING…';
  try {
    const r = await post('uninstall', body);
    $('uninstallDlg').close();
    stopped('PhoneController removed', `${r.done.join(' · ')}. You can close this window.`);
  } catch (e) {
    $('unConfirm').disabled = false;
    $('unConfirm').textContent = 'UNINSTALL';
    alert(`Uninstall failed: ${e.message}`);
  }
};

// ---------- live feed ----------
function render() {
  renderList();
  renderSelected();
  if (!lastState) return;
  $('allowJoins').classList.toggle('is-on', !lastState.settings?.lockJoins);
  $('rumbleTgl').classList.toggle('is-on', lastState.settings?.rumble !== false);
  $('mouseAllow').classList.toggle('is-on', !!lastState.mouse.allowed);
  $('mouseAllow2').classList.toggle('is-on', !!lastState.mouse.allowed);
  if (lastState.hotspot && hs && lastState.hotspot.status !== hs.status) refreshInfo();
  $('defaultType').querySelectorAll('.key').forEach((k) => k.classList.toggle('is-on', k.dataset.v === lastState.vpad.defaultType));
}
function connect() {
  ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=dashboard`);
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type !== 'state') return;
    lastState = m;
    clients = m.clients;
    diff(clients);
    render();
  };
  ws.onclose = () => {
    if ($('stopped').classList.contains('hidden')) stopped('Lost connection to PhoneController', 'It may have been closed. Start it again from the PhoneController shortcut.');
    setTimeout(() => { ws = null; tryReconnect(); }, 1500);
  };
}
async function tryReconnect() {
  try { await fetch('/api/ping'); $('stopped').classList.add('hidden'); connect(); refreshSetup(true); } catch { setTimeout(tryReconnect, 2000); }
}

log('PhoneController ready');
render();
drawPlate();
connect();
refreshInfo();
refreshSetup();
setInterval(refreshInfo, 5000);
setInterval(() => refreshSetup(), 5000);

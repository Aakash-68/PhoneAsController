import { fmt, drawHistogram } from './common.js';

const $ = (id) => document.getElementById(id);

async function loadInfo() {
  const info = await (await fetch('/api/info')).json();
  $('qrs').innerHTML = info.interfaces.length
    ? info.interfaces.map((i) => `
      <div class="qr"><b>${i.name}</b><br>${i.qrHttp}<code>${i.httpUrl}</code></div>
      <div class="qr"><b>${i.name} (https)</b><br>${i.qrHttps}<code>${i.httpsUrl}</code></div>`).join('')
    : 'No network adapters with an IP. Connect to Wi-Fi/hotspot or enable USB tethering.';
  if (!info.rtc) $('qrs').insertAdjacentHTML('beforeend', '<p class="small" style="color:var(--bad)">WebRTC disabled on the server (node-datachannel failed to load).</p>');
}
loadInfo();
setInterval(loadInfo, 4000);

const cards = new Map();
function card(c) {
  let el = cards.get(c.id);
  if (el) return el;
  el = document.createElement('div');
  el.className = 'card';
  el.innerHTML = `
    <h3></h3>
    <div class="small muted meta"></div>
    <div class="stats"></div>
    <canvas class="hist"></canvas>
    <p class="small muted">Event→laptop: touch event timestamp on phone → received here (uses clock sync, error ≈ ±sync).</p>
    <div class="viz"></div>`;
  $('clients').appendChild(el);
  cards.set(c.id, el);
  return el;
}

function renderClient(c) {
  const el = card(c);
  const device = /Android[^;)]*/.exec(c.ua)?.[0] ?? (/Windows/.test(c.ua) ? 'Windows' : 'device');
  const vpad = c.vslot != null ? ` · 🎮 ${c.vplugged === 'ds4' ? 'DS4' : 'Xbox 360'} #${c.vslot + 1}` : '';
  el.querySelector('h3').textContent = `#${c.id} · ${device} · ${c.iface} · ${c.transport.toUpperCase()}${c.transport === 'rtc' ? ` (${c.rtcState})` : ''} · ${c.mode.toUpperCase()}${vpad}`;
  const mouseInfo = c.mode === 'mouse' ? ` · mouse moves ${c.mouse.moves} clicks ${c.mouse.clicks} scrolls ${c.mouse.scrolls}` : '';
  el.querySelector('.meta').textContent = `${c.secure ? 'https' : 'http'} · sync ±${fmt(c.syncRtt != null ? c.syncRtt / 2 : null)} ms · inputs ${c.inputs} · pings ${c.pings} · idle ${c.idleMs != null ? fmt(c.idleMs, 0) + ' ms' : '–'}${mouseInfo}`;
  const o = c.oneWay, p = c.pipeline, iv = c.interval;
  el.querySelector('.stats').innerHTML = [
    ['event→laptop p50', o?.p50], ['event→laptop p99', o?.p99], ['max', o?.max],
    ['in-phone p50', p?.p50], ['packet gap p50', iv?.p50], ['gap p99', iv?.p99],
  ].map(([l, v]) => `<div class="stat"><span>${l}</span><b>${fmt(v)}</b><span>ms</span></div>`).join('');
  drawHistogram(el.querySelector('canvas'), c.oneWaySamples, { maxMs: 40, color: '#60a5fa', marks: { p50: o?.p50, p99: o?.p99 } });

  const viz = el.querySelector('.viz');
  let html = '';
  for (const t of Object.values(c.touches)) html += `<div class="t" style="left:${t.x * 100}%;top:${t.y * 100}%"></div>`;
  if (c.pad && (c.mode === 'pad' || c.mode === 'wheel')) html += padSvg(c.pad, c.mode);
  viz.innerHTML = html;
}

function padSvg(p, mode) {
  if (mode === 'wheel') {
    const bar = (x, label, v, color) => `<rect x="${x}" y="20" width="14" height="55" fill="#1e293b"/><rect x="${x}" y="${20 + 55 * (1 - v)}" width="14" height="${55 * v}" fill="${color}"/><text x="${x + 7}" y="84" font-size="4.5" text-anchor="middle" fill="#cbd5e1">${label} ${Math.round(v * 100)}%</text>`;
    return `<svg viewBox="0 0 160 90" style="position:absolute;inset:0;width:100%;height:100%">
      ${bar(8, 'BRAKE', p.l2, '#f87171')}${bar(138, 'GAS', p.r2, '#4ade80')}
      <g transform="rotate(${p.lx * 90} 80 45)"><circle cx="80" cy="45" r="26" fill="none" stroke="#60a5fa" stroke-width="5"/><rect x="54" y="43" width="52" height="4" fill="#60a5fa"/><rect x="78" y="45" width="4" height="26" fill="#60a5fa"/></g>
      <text x="80" y="86" font-size="5" text-anchor="middle" fill="#cbd5e1">steer ${Math.round(p.lx * 100)}%</text>
    </svg>`;
  }
  const b = (i) => (p.buttons >> i) & 1;
  const btn = (i, x, y, label) => `<circle cx="${x}" cy="${y}" r="5" fill="${b(i) ? '#60a5fa' : '#1e293b'}"/><text x="${x}" y="${y + 1.6}" font-size="4.5" text-anchor="middle" fill="#cbd5e1">${label}</text>`;
  const stick = (cx, cy, x, y) => `<circle cx="${cx}" cy="${cy}" r="12" fill="#1e293b"/><circle cx="${cx + x * 9}" cy="${cy + y * 9}" r="5" fill="#60a5fa"/>`;
  return `<svg viewBox="0 0 160 90" style="position:absolute;inset:0;width:100%;height:100%">
    ${stick(35, 60, p.lx, p.ly)}${stick(110, 60, p.rx, p.ry)}
    ${btn(0, 135, 42, '✕')}${btn(1, 146, 31, '○')}${btn(2, 124, 31, '□')}${btn(3, 135, 20, '△')}
    ${btn(4, 25, 20, '▲')}${btn(5, 25, 42, '▼')}${btn(6, 14, 31, '◀')}${btn(7, 36, 31, '▶')}
    ${btn(9, 20, 6, 'L1')}${btn(11, 140, 6, 'R1')}${btn(12, 65, 15, 'SH')}${btn(13, 95, 15, 'OP')}
    ${btn(14, 52, 78, 'L3')}${btn(15, 127, 78, 'R3')}
    <rect x="45" y="2" width="20" height="5" fill="#1e293b"/><rect x="45" y="2" width="${20 * p.l2}" height="5" fill="#60a5fa"/>
    <rect x="95" y="2" width="20" height="5" fill="#1e293b"/><rect x="95" y="2" width="${20 * p.r2}" height="5" fill="#60a5fa"/>
    <text x="55" y="11" font-size="3.5" text-anchor="middle" fill="#cbd5e1">L2 ${Math.round(p.l2 * 100)}%</text>
    <text x="105" y="11" font-size="3.5" text-anchor="middle" fill="#cbd5e1">R2 ${Math.round(p.r2 * 100)}%</text>
    ${p.gyro ? `<text x="80" y="86" font-size="3.5" text-anchor="middle" fill="#8a93a6">gyro ${p.gyro.map((v) => v.toFixed(0).padStart(4)).join(' ')} °/s · accel ${p.accel.map((v) => v.toFixed(2)).join(' ')} g</text>` : ''}
  </svg>`;
}

function addRun(r) {
  const t = new Date(r.at).toLocaleTimeString();
  $('runs').insertAdjacentHTML('afterbegin', `<tr><td>${t}</td><td>#${r.client}</td><td>${r.iface}</td><td>${r.transport}</td><td>${r.rate}</td><td>${fmt(r.p50)}</td><td>${fmt(r.p95)}</td><td>${fmt(r.p99)}</td><td>${fmt(r.max)}</td><td>${fmt(r.jitter)}</td><td>${fmt(r.loss, 1)}%</td></tr>`);
}

let dashWs = null;
$('mouseAllow').onchange = (e) => dashWs?.send(JSON.stringify({ type: 'mouse-allow', on: e.target.checked }));
$('vpadType').onchange = (e) => dashWs?.send(JSON.stringify({ type: 'default-type', value: e.target.value }));

function connect() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws?role=dashboard`);
  dashWs = ws;
  ws.onopen = () => $('dot').classList.add('on');
  ws.onclose = () => { $('dot').classList.remove('on'); setTimeout(connect, 1000); };
  ws.onmessage = (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'run') addRun(m.run);
    else if (m.type === 'state') {
      // Mouse permission can only be granted from a dashboard opened on the laptop itself.
      const local = ['localhost', '127.0.0.1'].includes(location.hostname);
      if (document.activeElement !== $('vpadType')) $('vpadType').value = m.vpad.defaultType;
      $('vpadType').disabled = !local || m.vpad.status !== 'ready';
      const inUse = m.clients.filter((c) => c.vslot != null).length;
      $('vpadStatus').textContent = m.vpad.status === 'ready' ? (inUse ? `● ${inUse} plugged in` : 'ready') : `${m.vpad.status}${m.vpad.error ? `: ${m.vpad.error}` : ''}`;
      $('mouseAllow').checked = m.mouse.allowed;
      $('mouseAllow').disabled = !m.mouse.available || !local;
      $('mouseAllowRow').title = !m.mouse.available ? 'Not available on this server' : local ? 'Lets the phone\'s Mouse screen move this laptop\'s real cursor' : 'Open the dashboard via localhost to change this';
      const live = new Set(m.clients.map((c) => c.id));
      for (const [id, el] of cards) if (!live.has(id)) { el.remove(); cards.delete(id); }
      m.clients.forEach(renderClient);
    }
  };
}
connect();

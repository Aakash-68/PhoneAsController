// PhoneController server.
//   HTTP  :8080  phone page, manager (/app), diagnostics (/dashboard), WebSocket /ws
//   HTTPS :8443  same, self-signed (secure context → raw touch events, motion sensors, fine timers)
//   UDP   :9000  raw echo for the future native Android tester
// Phones reach it over the laptop's own hotspot, a USB cable or any shared network (network.js).
// WebRTC DataChannels (unordered, no retransmits = UDP-like) are signalled over /ws.

import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import fs from 'node:fs';
import path from 'node:path';
import util from 'node:util';
import { WebSocketServer } from 'ws';
import QRCode from 'qrcode';
import selfsigned from 'selfsigned';
import { MSG, KIND, HEARTBEAT, SIZE, Ring, summarize, now } from './public/common.js';
import { APP_DIR, DATA_DIR, readJson, writeJson } from './paths.js';
import * as vigem from './vigem.js';
import * as players from './players.js';
import * as setup from './setup.js';
import * as network from './network.js';

// Started hidden by PhoneController.exe: no console, so log to a file instead.
if (process.env.PC_LOG) {
  const out = fs.createWriteStream(path.join(DATA_DIR, 'server.log'), { flags: 'w' });
  for (const k of ['log', 'warn', 'error']) console[k] = (...a) => out.write(`${new Date().toISOString().slice(11, 19)} ${util.format(...a)}\n`);
}

const HTTP_PORT = 8080, HTTPS_PORT = 8443, UDP_PORT = 9000;
const PUBLIC = path.join(APP_DIR, 'public');
const RESULTS = path.join(DATA_DIR, 'results');
fs.mkdirSync(RESULTS, { recursive: true });

let rtc = null;
try {
  rtc = (await import('node-datachannel')).default;
  rtc.initLogger('Error', (level, message) => console.warn(`[rtc] ${message}`));
} catch (e) {
  console.warn('[rtc] node-datachannel unavailable, WebRTC transport disabled:', e.message);
}

// user32 for real mouse control (off until allowed in the manager), xinput for the setup self-test.
let mouseEvent = null, keybdEvent = null, mapVk = null, readPads = () => [];
try {
  const koffi = (await import('koffi')).default;
  const user32 = koffi.load('user32.dll');
  mouseEvent = user32.func('void __stdcall mouse_event(uint32_t dwFlags, int dx, int dy, int dwData, uintptr_t dwExtraInfo)');
  keybdEvent = user32.func('void __stdcall keybd_event(uint8_t bVk, uint8_t bScan, uint32_t dwFlags, uintptr_t dwExtraInfo)');
  mapVk = user32.func('uint32 __stdcall MapVirtualKeyW(uint32 uCode, uint32 uMapType)');
  const pad = koffi.struct('XINPUT_GAMEPAD', { wButtons: 'uint16', bLeftTrigger: 'uint8', bRightTrigger: 'uint8', sThumbLX: 'int16', sThumbLY: 'int16', sThumbRX: 'int16', sThumbRY: 'int16' });
  koffi.struct('XINPUT_STATE', { dwPacketNumber: 'uint32', Gamepad: pad });
  const getState = koffi.load('xinput1_4.dll').func('uint32 __stdcall XInputGetState(uint32 idx, _Out_ XINPUT_STATE *s)');
  readPads = () => [0, 1, 2, 3].map((i) => { const s = {}; return getState(i, s) === 0 ? { i, lx: s.Gamepad.sThumbLX } : null; }).filter(Boolean);
} catch (e) {
  console.warn('[win32] user32/xinput unavailable:', e.message);
}
// Remembered between runs: a phone that is your mouse should not stop working after a restart.
let mouseAllowed = !!players.settings.mouseAllowed && !!mouseEvent;
const MOUSEEVENTF = { MOVE: 0x1, LEFTDOWN: 0x2, LEFTUP: 0x4, RIGHTDOWN: 0x8, RIGHTUP: 0x10, MIDDLEDOWN: 0x20, MIDDLEUP: 0x40, WHEEL: 0x800, HWHEEL: 0x1000 };
const MOUSE_BITS = [[1, MOUSEEVENTF.LEFTDOWN, MOUSEEVENTF.LEFTUP], [2, MOUSEEVENTF.RIGHTDOWN, MOUSEEVENTF.RIGHTUP], [4, MOUSEEVENTF.MIDDLEDOWN, MOUSEEVENTF.MIDDLEUP]];
const KEYEVENTF = { EXTENDED: 0x1, KEYUP: 0x2 };
// Keys the phone's keyboard screen may press (Windows virtual-key codes). Anything else is ignored.
const KEY_OK = new Set([0x08, 0x09, 0x0d, 0x10, 0x11, 0x12, 0x1b, 0x20, 0x25, 0x26, 0x27, 0x28,
  ...Array.from({ length: 10 }, (_, i) => 0x30 + i), ...Array.from({ length: 26 }, (_, i) => 0x41 + i)]);
const KEY_EXTENDED = new Set([0x25, 0x26, 0x27, 0x28]);

// ---------- network helpers ----------
const { interfaces } = network;
const isLoopback = (addr) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(addr);
const ifaceFor = (addr) => {
  const ip = (addr ?? '').replace(/^::ffff:/, '');
  if (isLoopback(addr) || ip === '127.0.0.1') return 'loopback';
  return interfaces().find((i) => i.address === ip)?.name ?? ip;
};
// Manager-only actions: request must come from this laptop AND from our own page, so no other
// website open in the laptop's browser can trigger them (WebSockets and simple POSTs skip CORS).
const LOCAL_ORIGINS = new Set([`http://localhost:${HTTP_PORT}`, `http://127.0.0.1:${HTTP_PORT}`, `https://localhost:${HTTPS_PORT}`, `https://127.0.0.1:${HTTPS_PORT}`]);
// Same-origin GETs carry no Origin header; allowing those is safe because other sites can't read the reply.
const isManager = (req) => isLoopback(req.socket.remoteAddress)
  && (LOCAL_ORIGINS.has(req.headers.origin ?? '') || (req.method === 'GET' && !req.headers.origin && !req.headers.upgrade));

// ---------- HTTP ----------
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.webmanifest': 'application/manifest+json' };
const json = (res, code, body) => { res.writeHead(code, { 'content-type': 'application/json', 'cache-control': 'no-store' }); res.end(JSON.stringify(body)); };
const readBody = (req) => new Promise((resolve) => { let d = ''; req.on('data', (c) => { d += c; if (d.length > 1e5) req.destroy(); }); req.on('end', () => { try { resolve(JSON.parse(d || '{}')); } catch { resolve({}); } }); });

// The manager asks every few seconds and the answers rarely change.
const qrCache = new Map();
function qr(text) {
  if (!qrCache.has(text)) {
    if (qrCache.size > 64) qrCache.clear();
    qrCache.set(text, QRCode.toString(text, { type: 'svg', margin: 1 }));
  }
  return qrCache.get(text);
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://x');
  if (url.pathname === '/api/ping') return json(res, 200, { ok: true, app: 'PhoneController' });
  if (url.pathname === '/api/info') {
    const ifs = await Promise.all(interfaces().map(async (i) => {
      const httpUrl = `http://${i.address}:${HTTP_PORT}/`, httpsUrl = `https://${i.address}:${HTTPS_PORT}/`;
      return { ...i, httpUrl, httpsUrl, qrHttp: await qr(httpUrl), qrHttps: await qr(httpsUrl) };
    }));
    return json(res, 200, { interfaces: ifs, rtc: !!rtc, udpPort: UDP_PORT, palette: players.PALETTE });
  }
  if (url.pathname.startsWith('/api/setup') || url.pathname.startsWith('/api/admin')) {
    if (!isManager(req)) return json(res, 403, { error: 'only the PhoneController window on this laptop can do that' });
    if (url.pathname === '/api/setup/status') return json(res, 200, await setup.status(vigem.vpad, url.searchParams.has('fresh')));
    // Holds the password, so manager-only (never in /api/info or the state feed).
    if (url.pathname === '/api/setup/hotspot') {
      return json(res, 200, { ...network.hotspotSettings(), ...network.hotspot, qrWifi: await qr(network.wifiPayload()) });
    }
    if (req.method !== 'POST') return json(res, 405, { error: 'POST only' });
    return admin(url.pathname.slice('/api/admin/'.length), await readBody(req), res);
  }
  const routes = { '/': 'index.html', '/app': 'app.html', '/dashboard': 'dashboard.html' };
  const rel = routes[url.pathname] ?? url.pathname.slice(1);
  const file = path.join(PUBLIC, path.normalize(rel));
  if (!file.startsWith(PUBLIC)) { res.writeHead(403); return res.end(); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    const headers = { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' };
    if (req.socket.encrypted) {
      // Cross-origin isolation unlocks 5µs performance.now() resolution (secure contexts only).
      headers['cross-origin-opener-policy'] = 'same-origin';
      headers['cross-origin-embedder-policy'] = 'require-corp';
    }
    res.writeHead(200, headers);
    res.end(data);
  });
}

async function admin(action, body, res) {
  try {
    switch (action) {
      case 'install-driver': {
        const r = await setup.installDriver();
        await vigem.restartBridge();
        return json(res, 200, { ok: true, ...r });
      }
      case 'allow-firewall':
        await setup.allowFirewall();
        return json(res, 200, { ok: true });
      case 'verify': {
        if (vigem.vpad.status !== 'ready') await vigem.restartBridge();
        const r = await vigem.selfTest(readPads);
        if (r.ok) setup.markVerified((await setup.status(vigem.vpad, true)).driver.version);
        return json(res, 200, r);
      }
      case 'hotspot': {
        const error = network.changeHotspot(body);
        return error ? json(res, 400, { ok: false, error }) : json(res, 200, { ok: true });
      }
      case 'quit':
        json(res, 200, { ok: true });
        return setTimeout(shutdown, 200);
      case 'uninstall': {
        for (const s of clients.values()) kick(s, 'The laptop is removing PhoneController.');
        const done = await setup.uninstall(body);
        json(res, 200, { ok: true, done });
        return setTimeout(shutdown, 300);
      }
      default:
        return json(res, 404, { error: 'unknown action' });
    }
  } catch (e) {
    return json(res, 500, { ok: false, error: e.message });
  }
}

// ---------- clients ----------
let nextId = 1;
const clients = new Map();   // id → phone session
const dashboards = new Set();

function newSession(ws, req) {
  return {
    id: nextId++, ws, pc: null, dc: null,
    ua: req.headers['user-agent'] ?? '', iface: ifaceFor(req.socket.localAddress),
    secure: !!req.socket.encrypted, transport: 'ws',
    offset: null, syncRtt: null,                // server − client clock, from client pings
    oneWay: new Ring(2000), pipeline: new Ring(2000), rate: new Ring(200),
    lastInputAt: 0, touches: {}, pad: null, inputs: 0, pings: 0, rtcState: 'none',
    mode: 'idle', mouseButtons: 0, mouse: { moves: 0, clicks: 0, scrolls: 0 }, keys: new Set(), keyPresses: 0, device: null,
    player: null, name: null, color: null, vtype: null, connectedAt: Date.now(),
  };
}
const sendTo = (s, o) => s.ws.readyState === 1 && s.ws.send(JSON.stringify(o));

function kick(s, reason) {
  sendTo(s, { type: 'kicked', reason });
  setTimeout(() => s.ws.close(4001, 'kicked'), 50);
}

function applyMouse(s, b) {
  if (!mouseAllowed || !mouseEvent) return;
  const dx = b.readInt16LE(22), dy = b.readInt16LE(24), buttons = b[26], wheel = b.readInt16LE(27), hwheel = b.readInt16LE(29);
  if (dx || dy) { mouseEvent(MOUSEEVENTF.MOVE, dx, dy, 0, 0); s.mouse.moves++; }
  const changed = buttons ^ s.mouseButtons;
  for (const [bit, down, up] of MOUSE_BITS) {
    if (!(changed & bit)) continue;
    mouseEvent(buttons & bit ? down : up, 0, 0, 0, 0);
    if (buttons & bit) s.mouse.clicks++;
  }
  s.mouseButtons = buttons;
  if (wheel) { mouseEvent(MOUSEEVENTF.WHEEL, 0, 0, wheel, 0); s.mouse.scrolls++; }
  if (hwheel) { mouseEvent(MOUSEEVENTF.HWHEEL, 0, 0, hwheel, 0); s.mouse.scrolls++; }
}

// Never leave a button stuck down when a phone disconnects or control is revoked.
function releaseMouse(s) {
  if (!mouseEvent) return;
  for (const [bit, , up] of MOUSE_BITS) if (s.mouseButtons & bit) mouseEvent(up, 0, 0, 0, 0);
  s.mouseButtons = 0;
}

// Real keyboard (same permission as the mouse). Scan codes too, so games that read raw input see the keys.
function keyEvent(vk, down) {
  keybdEvent(vk, mapVk ? mapVk(vk, 0) : 0, (down ? 0 : KEYEVENTF.KEYUP) | (KEY_EXTENDED.has(vk) ? KEYEVENTF.EXTENDED : 0), 0);
}
function applyKey(s, b) {
  if (!mouseAllowed || !keybdEvent) return;
  const vk = b[22], down = b[23] === 1;
  if (!KEY_OK.has(vk) || down === s.keys.has(vk)) return;
  keyEvent(vk, down);
  if (down) { s.keys.add(vk); s.keyPresses++; } else s.keys.delete(vk);
}
// Never leave a key held down when a phone leaves the keyboard screen or disconnects.
function releaseKeys(s) {
  if (!keybdEvent) return;
  for (const vk of s.keys) keyEvent(vk, false);
  s.keys.clear();
}

function sendMouseStatus(ws) {
  const msg = JSON.stringify({ type: 'mouse-status', allowed: mouseAllowed, available: !!mouseEvent });
  if (ws) ws.readyState === 1 && ws.send(msg);
  else for (const c of clients.values()) c.ws.readyState === 1 && c.ws.send(msg);
}

// Hot path: answer immediately, before any bookkeeping.
// Fresh buffers per reply: ws/datachannel may still hold the previous one when we return.
function onBinary(s, data, reply) {
  const tRecv = now();
  const b = Buffer.isBuffer(data) ? data : Buffer.from(data);
  const type = b[0];
  if (type === MSG.PING && b.length >= SIZE.PING) {
    const pong = Buffer.allocUnsafe(SIZE.PONG);
    pong[0] = MSG.PONG;
    b.copy(pong, 1, 1, 13);
    pong.writeDoubleLE(tRecv, 13);
    reply(pong);
    s.pings++;
  } else if (type === MSG.INPUT && b.length >= SIZE.TOUCH) {
    // Act first (virtual pad / mouse), then ack, then bookkeeping.
    const kind = b[1] & 0x7f;
    if (kind === KIND.PAD && b.length >= SIZE.PAD) vigem.report(s, b);
    else if (kind === KIND.MOUSE && b.length >= SIZE.MOUSE) applyMouse(s, b);
    else if (kind === KIND.KEY && b.length >= SIZE.KEY) applyKey(s, b);
    const ack = Buffer.allocUnsafe(SIZE.INPUT_ACK);
    ack[0] = MSG.INPUT_ACK;
    b.copy(ack, 1, 2, 6);    // seq
    b.copy(ack, 5, 14, 22);  // tSend
    reply(ack);
    recordInput(s, b, tRecv);
  }
}

function recordInput(s, b, tRecv) {
  const kind = b[1] & 0x7f, heartbeat = b[1] & HEARTBEAT, tEvent = b.readDoubleLE(6), tSend = b.readDoubleLE(14);
  s.inputs++;
  if (!heartbeat) s.pipeline.push(tSend - tEvent);
  if (s.offset != null) s.oneWay.push(tRecv - (tSend + s.offset));
  if (s.lastInputAt) s.rate.push(tRecv - s.lastInputAt);
  s.lastInputAt = tRecv;
  if (kind === KIND.TOUCH) {
    const id = b[22], phase = b[23];
    if (phase === 2) delete s.touches[id];
    else s.touches[id] = { x: b.readUInt16LE(24) / 65535, y: b.readUInt16LE(26) / 65535 };
  } else if (kind === KIND.PAD && b.length >= SIZE.PAD) {
    s.pad = {
      buttons: b.readUInt32LE(22),
      lx: b.readInt16LE(26) / 32767, ly: b.readInt16LE(28) / 32767,
      rx: b.readInt16LE(30) / 32767, ry: b.readInt16LE(32) / 32767,
      l2: b[34] / 255, r2: b[35] / 255,
      gyro: [b.readInt16LE(36) / 10, b.readInt16LE(38) / 10, b.readInt16LE(40) / 10],
      accel: [b.readInt16LE(42) / 1000, b.readInt16LE(44) / 1000, b.readInt16LE(46) / 1000],
    };
  }
}

function onText(s, msg) {
  switch (msg.type) {
    case 'join':
      if (players.settings.lockJoins && !players.isKnown(msg.deviceId)) { kick(s, 'The laptop is not accepting new phones right now.'); break; }
      players.join(s, msg.deviceId, clients.values());
      sendTo(s, players.identity(s));
      console.log(`[client ${s.id}] is P${s.player} "${s.name}"`);
      break;
    case 'vtype':   // the phone picked Xbox / PS4 for itself
      players.update(s, { vtype: msg.value });
      vigem.retype(s);
      sendTo(s, players.identity(s));
      break;
    case 'sync':
      s.offset = msg.offset; s.syncRtt = msg.rtt;
      break;
    case 'device': {   // what the phone says about itself (the model picked on the phone, battery)
      const str = (v, n) => (typeof v === 'string' ? v.slice(0, n) : null);
      const num = (v) => (Number.isFinite(v) ? v : null);
      s.device = { model: str(msg.model, 40), layout: str(msg.layout, 40), screen: str(msg.screen, 24), battery: num(msg.battery), charging: !!msg.charging };
      break;
    }
    case 'reset':
      s.oneWay.clear(); s.pipeline.clear(); s.rate.clear(); s.inputs = 0; s.pings = 0;
      break;
    case 'transport':
      s.transport = msg.transport;
      break;
    case 'mode':
      s.mode = String(msg.mode).slice(0, 16);
      if (s.mode !== 'mouse') releaseMouse(s);
      if (s.mode !== 'keys') releaseKeys(s);
      // Pad/wheel get a virtual controller. It stays plugged while browsing settings
      // (the watchdog centres it) so games don't see it vanish and reappear; mouse mode removes it.
      if (s.mode === 'pad' || s.mode === 'wheel') vigem.plug(s);
      else if (s.mode === 'mouse' || s.mode === 'keys') vigem.unplug(s);
      break;
    case 'run': {
      const run = { ...msg.run, at: new Date().toISOString(), client: s.id, iface: s.iface, secure: s.secure, ua: s.ua };
      fs.appendFile(path.join(RESULTS, 'runs.jsonl'), JSON.stringify(run) + '\n', () => {});
      broadcast({ type: 'run', run });
      break;
    }
    case 'rtc-offer':
      startRtc(s, msg.sdp);
      break;
  }
}

// Messages from the manager window (only accepted from this laptop, see isManager).
function onManager(m) {
  const s = clients.get(m.id);
  switch (m.type) {
    case 'player-update':
      if (!s) return;
      players.update(s, m);
      if ('vtype' in m) vigem.retype(s);
      sendTo(s, players.identity(s));
      break;
    case 'kick':
      if (s) kick(s, 'Disconnected by the laptop.');
      break;
    case 'buzz':   // "which phone is this?"
      if (s) sendTo(s, { type: 'buzz' });
      break;
    case 'settings':
      if ('rumble' in m) players.settings.rumble = !!m.rumble;
      if ('lockJoins' in m) players.settings.lockJoins = !!m.lockJoins;
      players.saveSettings();
      for (const c of clients.values()) if (c.player) sendTo(c, players.identity(c));
      break;
    case 'default-type':
      if (['x360', 'ds4', 'off'].includes(m.value)) { players.settings.defaultType = m.value; players.saveSettings(); }
      break;
    case 'mouse-allow':
      mouseAllowed = !!m.on && !!mouseEvent;
      players.settings.mouseAllowed = mouseAllowed;
      players.saveSettings();
      if (!mouseAllowed) for (const c of clients.values()) { releaseMouse(c); releaseKeys(c); }
      console.log(`[mouse] control ${mouseAllowed ? 'ENABLED' : 'disabled'}`);
      sendMouseStatus();
      break;
  }
}

function startRtc(s, sdp) {
  const send = (o) => sendTo(s, o);
  if (!rtc) return send({ type: 'rtc-error', error: 'WebRTC not available on server' });
  s.pc?.close();
  const pc = new rtc.PeerConnection(`client-${s.id}`, { iceServers: [] });
  s.pc = pc;
  pc.onLocalDescription((sdp, type) => send({ type: 'rtc-answer', sdp, sdpType: type }));
  pc.onLocalCandidate((candidate, mid) => send({ type: 'rtc-candidate', candidate: candidate.replace(/^a=/, ''), mid }));
  pc.onStateChange((state) => { s.rtcState = state; send({ type: 'rtc-state', state }); });
  pc.onDataChannel((dc) => {
    s.dc = dc;
    dc.onMessage((m) => { if (typeof m !== 'string') onBinary(s, m, (buf) => dc.sendMessageBinary(buf)); });
    dc.onClosed(() => { if (s.dc === dc) s.dc = null; });
  });
  pc.setRemoteDescription(sdp, 'offer');
}

function attachWs(wss) {
  wss.on('connection', (ws, req) => {
    req.socket.setNoDelay(true);
    const role = new URL(req.url, 'http://x').searchParams.get('role');
    if (role === 'dashboard') {
      const manager = isManager(req);
      dashboards.add(ws);
      ws.on('message', (data) => {
        if (!manager) return;
        try { onManager(JSON.parse(data)); } catch {}
      });
      ws.on('close', () => dashboards.delete(ws));
      return;
    }
    const s = newSession(ws, req);
    clients.set(s.id, s);
    sendTo(s, { type: 'hello', id: s.id, iface: s.iface, rtc: !!rtc });
    sendMouseStatus(ws);
    console.log(`[client ${s.id}] connected via ${s.iface}${s.secure ? ' (https)' : ''}`);
    ws.on('message', (data, isBinary) => {
      if (isBinary) onBinary(s, data, (buf) => ws.send(buf));
      else { try { onText(s, JSON.parse(data)); } catch {} }
    });
    ws.on('close', () => {
      releaseMouse(s);
      releaseKeys(s);
      vigem.unplug(s);
      s.pc?.close();
      clients.delete(s.id);
      console.log(`[client ${s.id}] disconnected`);
    });
  });
}

// ---------- manager / dashboard feed (~30 Hz) ----------
function broadcast(obj) {
  const msg = JSON.stringify(obj);
  for (const d of dashboards) if (d.readyState === 1) d.send(msg);
}
setInterval(() => {
  if (!dashboards.size) return;
  broadcast({
    type: 'state',
    mouse: { allowed: mouseAllowed, available: !!mouseEvent },
    hotspot: network.hotspot,
    settings: { rumble: players.settings.rumble !== false, lockJoins: !!players.settings.lockJoins },
    vpad: { status: vigem.vpad.status, error: vigem.vpad.error, defaultType: players.settings.defaultType },
    clients: [...clients.values()].map((s) => ({
      player: s.player, name: s.name, color: s.color, vtype: s.vtype, tune: s.tune, device: s.device, keyPresses: s.keyPresses, connectedAt: s.connectedAt,
      mode: s.mode, mouse: s.mouse, vslot: s.vslot ?? null, vplugged: s.vplugged ?? null,
      id: s.id, ua: s.ua, iface: s.iface, secure: s.secure, transport: s.transport, rtcState: s.rtcState,
      offset: s.offset, syncRtt: s.syncRtt, inputs: s.inputs, pings: s.pings,
      oneWay: summarize(s.oneWay.values()), pipeline: summarize(s.pipeline.values()), interval: summarize(s.rate.values()),
      oneWaySamples: Array.from(s.oneWay.values().slice(-500)),
      touches: s.touches, pad: s.pad, idleMs: s.lastInputAt ? now() - s.lastInputAt : null,
    })),
  });
}, 33);

// ---------- virtual controllers ----------
vigem.setFeedbackHandler((s, fb) => { if (players.settings.rumble !== false) sendTo(s, { type: 'rumble', ...fb }); });
vigem.startBridge();
network.startNetwork();
setInterval(() => vigem.watchdog(clients.values(), now()), 50);
setup.warmUp();

// ---------- UDP echo (native tester, later) ----------
const udp = dgram.createSocket('udp4');
udp.on('message', (m, rinfo) => {
  const out = Buffer.allocUnsafe(m.length + 8);
  m.copy(out);
  out.writeDoubleLE(now(), m.length);
  udp.send(out, rinfo.port, rinfo.address);
});
udp.bind(UDP_PORT);

// ---------- HTTPS ----------
// Phones address us by IP, which TLS doesn't reveal to the server, so each local address gets its
// own certificate, chosen from the address the connection arrived on. A phone then accepts the
// warning once per address: a USB cable's changing address never disturbs the hotspot's certificate.
const MAX_CERTS = 32;
const certs = readJson('certs.json', {});   // ip -> { key, cert, expires }
const contexts = new Map();                 // ip -> Promise<SecureContext>

async function issue(ip) {
  const saved = certs[ip];
  if (saved && new Date(saved.expires) > new Date(Date.now() + 86400e3)) return saved;
  const altNames = ip === '127.0.0.1' ? [{ type: 2, value: 'localhost' }, { type: 7, ip }] : [{ type: 7, ip }];
  const pems = await selfsigned.generate([{ name: 'commonName', value: `PhoneController ${ip}` }], {
    days: 825, keyType: 'ec', extensions: [{ name: 'subjectAltName', altNames }],
  });
  delete certs[ip];
  certs[ip] = { key: pems.private, cert: pems.cert, expires: new Date(Date.now() + 820 * 86400e3).toISOString() };
  for (const old of Object.keys(certs)) { if (Object.keys(certs).length <= MAX_CERTS) break; delete certs[old]; }
  writeJson('certs.json', certs);
  return certs[ip];
}
function contextFor(address) {
  const ip = (address ?? '127.0.0.1').replace(/^::ffff:/, '');
  if (!contexts.has(ip)) contexts.set(ip, issue(ip).then(({ key, cert }) => tls.createSecureContext({ key, cert })));
  return contexts.get(ip);
}

// ---------- start ----------
const httpServer = http.createServer(handle);
const httpsServer = http.createServer(handle);   // fed decrypted connections by tlsFront
const tlsFront = net.createServer({ pauseOnConnect: true, noDelay: true }, async (raw) => {
  raw.on('error', () => {});
  try {
    const secureContext = await contextFor(raw.localAddress);
    const sock = new tls.TLSSocket(raw, { isServer: true, secureContext, ALPNProtocols: ['http/1.1'] });
    sock.on('error', () => sock.destroy());
    sock.once('secure', () => httpsServer.emit('connection', sock));
    raw.resume();
  } catch (e) {
    console.warn(`[https] ${e.message}`);
    raw.destroy();
  }
});
attachWs(new WebSocketServer({ server: httpServer, path: '/ws', perMessageDeflate: false }));
attachWs(new WebSocketServer({ server: httpsServer, path: '/ws', perMessageDeflate: false }));
httpServer.on('error', (e) => { console.error(`[http] ${e.message}`); process.exit(1); });
tlsFront.on('error', (e) => console.error(`[https] ${e.message}`));
httpServer.listen(HTTP_PORT, '0.0.0.0');
tlsFront.listen(HTTPS_PORT, '0.0.0.0');

// First run: test the driver without waiting for a click, as soon as the controller bridge reports in.
const firstRunCheck = setInterval(async () => {
  if (vigem.vpad.status === 'starting') return;
  clearInterval(firstRunCheck);
  if (vigem.vpad.status !== 'ready' || players.settings.verified) return;
  const r = await vigem.selfTest(readPads).catch(() => null);
  if (r?.ok) setup.markVerified((await setup.status(vigem.vpad, true)).driver.version);
}, 500);

console.log('\nPhoneController running');
console.log(`  Manager (this laptop): http://localhost:${HTTP_PORT}/app`);
for (const i of interfaces()) console.log(`  Phone via ${i.name.padEnd(28)} https://${i.address}:${HTTPS_PORT}/`);
console.log(`  Data: ${DATA_DIR}\n`);

function shutdown() {
  for (const s of clients.values()) { releaseMouse(s); s.ws.close(); }
  vigem.stopBridge();
  network.stopNetwork();
  rtc?.cleanup();
  setTimeout(() => process.exit(0), 300);
}
process.on('SIGINT', shutdown);

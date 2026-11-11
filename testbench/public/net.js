// Connection to the laptop: WebSocket always (control + fallback), WebRTC DataChannel optional for binary.
import { MSG, SIZE, Ring, fmt, now } from './common.js';
import { inApp, nativeCall } from './native.js';

const $ = (id) => document.getElementById(id);

export const link = {
  ws: null, pc: null, dc: null, mode: 'ws',
  sendBinary(buf) {
    if (this.mode === 'rtc' && this.dc?.readyState === 'open') this.dc.send(buf);
    else if (this.ws?.readyState === 1) this.ws.send(buf);
  },
  sendJson(o) { if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(o)); },
  get ready() { return this.mode === 'rtc' ? this.dc?.readyState === 'open' : this.ws?.readyState === 1; },
};

// Laptop-side state pushed to us (mouse permission etc.).
export const server = { mouseAllowed: false, mouseAvailable: false };

// Who we are on the laptop: player number, name, colour, controller type. Same phone = same identity.
export const me = { player: null, name: null, color: null, vtype: null, tune: null, rumble: true, kicked: false };
const deviceId = (() => {
  try {
    let id = localStorage.getItem('deviceId');
    if (!id) { id = crypto.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`; localStorage.setItem('deviceId', id); }
    return id;
  } catch { return null; }
})();
const identityListeners = new Set();
export const onIdentity = (fn) => identityListeners.add(fn);
export const setVtype = (value) => link.sendJson({ type: 'vtype', value });
const buzzListeners = new Set();
export const onBuzz = (fn) => buzzListeners.add(fn);

// Input acks: send → laptop → back, and touch event → back.
export const acks = { ackRtt: new Ring(1000), eventToAck: new Ring(1000) };
let inputSeq = 0;
const inputSent = new Map();   // seq → { tEvent, tSend }
export const nextSeq = () => ++inputSeq;
export const trackAck = (seq, tEvent, tSend) => inputSent.set(seq, { tEvent, tSend });

// Pings: background ones keep clock sync fresh (and the radio awake); the ping test pauses them.
let pingSeq = 0;
const pingSent = new Map();
const pingBuf = new DataView(new ArrayBuffer(SIZE.PING));
const pongListeners = new Set();
export const onPong = (fn) => pongListeners.add(fn);
export const background = { paused: false };
export function clearPings() { pingSent.clear(); }
export function sendPing() {
  const seq = ++pingSeq, t = now();
  pingBuf.setUint8(0, MSG.PING);
  pingBuf.setUint32(1, seq, true);
  pingBuf.setFloat64(5, t, true);
  pingSent.set(seq, t);
  link.sendBinary(pingBuf.buffer);
}

// Clock sync: offset = server − client, from the lowest-RTT recent pong.
export const sync = {
  window: [], offset: null, rtt: null, lastSent: 0,
  reset() { this.window = []; this.offset = null; },
  add(rtt, tSend, tServer) {
    this.window.push({ rtt, offset: tServer - (tSend + rtt / 2) });
    if (this.window.length > 64) this.window.shift();
    const best = this.window.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.offset = best.offset;
    this.rtt = best.rtt;
    const t = now();
    if (t - this.lastSent > 500) {
      this.lastSent = t;
      link.sendJson({ type: 'sync', offset: this.offset, rtt: this.rtt });
      if ($('clock')) $('clock').textContent = `sync ±${fmt(this.rtt / 2)} ms`;
    }
  },
};

function onBinary(ab) {
  const t = now();
  const v = new DataView(ab);
  const type = v.getUint8(0);
  if (type === MSG.PONG) {
    const seq = v.getUint32(1, true), tSend = v.getFloat64(5, true), tServer = v.getFloat64(13, true);
    const rtt = t - tSend;
    sync.add(rtt, tSend, tServer);
    const pending = pingSent.delete(seq);
    for (const fn of pongListeners) fn(rtt, pending);
  } else if (type === MSG.INPUT_ACK) {
    const seq = v.getUint32(1, true);
    const sent = inputSent.get(seq);
    if (!sent) return;
    inputSent.delete(seq);
    acks.ackRtt.push(t - sent.tSend);
    acks.eventToAck.push(t - sent.tEvent);
  }
}

// Game rumble → phone vibration. The web API has no strength control, so strength becomes
// a pulse pattern: stronger rumble = longer buzz, shorter gaps. Repeats until the game stops it.
export const feedback = { rumble: 0, rgb: null };
let rumbleTimer = null;
function rumble({ large, small, rgb }) {
  // Vibration strength is set per phone in the laptop's manager (0..1).
  feedback.rumble = (Math.max(large, small) / 255) * (me.tune?.vib ?? 0.8);
  if (rgb && (rgb[0] || rgb[1] || rgb[2])) feedback.rgb = rgb;
  clearInterval(rumbleTimer);
  if (inApp) {   // the app can set real motor strength, so no pulse pattern is needed
    nativeCall('rumble', feedback.rumble < 0.04 ? 0 : Math.round(30 + 225 * feedback.rumble));
    if (feedback.rumble >= 0.04) rumbleTimer = setTimeout(() => nativeCall('rumble', 0), 5000);
    return;
  }
  if (feedback.rumble < 0.04) { navigator.vibrate?.(0); return; }
  const on = Math.round(12 + 38 * feedback.rumble), off = Math.round(40 * (1 - feedback.rumble));
  const pulse = () => navigator.vibrate?.([on, off, on, off, on, off]);
  pulse();
  rumbleTimer = setInterval(pulse, 3 * (on + off));
  setTimeout(() => clearInterval(rumbleTimer), 5000);   // safety cap if the game never sends "stop"
}

const statusListeners = new Set();
export const onServerStatus = (fn) => statusListeners.add(fn);

function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  ws.binaryType = 'arraybuffer';
  link.ws = ws;
  ws.onopen = () => {
    $('wsDot').classList.add('on');
    link.sendJson({ type: 'join', deviceId });
    if (link.mode === 'rtc') startRtc();
    link.sendJson({ type: 'transport', transport: link.mode });
    for (const fn of reconnectListeners) fn();
  };
  ws.onclose = () => {
    $('wsDot').classList.remove('on');
    rumble({ large: 0, small: 0 });
    if (me.kicked) { $('wsLabel').textContent = 'disconnected by the laptop'; return; }
    $('wsLabel').textContent = 'disconnected – retrying';
    setTimeout(connectWs, 1000);
  };
  ws.onmessage = (e) => {
    if (typeof e.data !== 'string') return onBinary(e.data);
    const m = JSON.parse(e.data);
    if (m.type === 'hello') $('wsLabel').textContent = `#${m.id} via ${m.iface}`;
    else if (m.type === 'rumble') rumble(m);
    else if (m.type === 'buzz') { navigator.vibrate?.([70, 60, 70, 60, 220]); for (const fn of buzzListeners) fn(); }
    else if (m.type === 'identity' || m.type === 'kicked') {
      if (m.type === 'identity') Object.assign(me, { player: m.player, name: m.name, color: m.color, vtype: m.vtype, tune: m.tune ?? null, rumble: m.rumble !== false, kicked: false });
      else Object.assign(me, { kicked: true, reason: m.reason });
      for (const fn of identityListeners) fn(me);
    }
    else if (m.type === 'mouse-status') {
      server.mouseAllowed = m.allowed;
      server.mouseAvailable = m.available;
      for (const fn of statusListeners) fn(server);
    }
    else if (m.type === 'rtc-answer') link.pc?.setRemoteDescription({ type: 'answer', sdp: m.sdp });
    else if (m.type === 'rtc-candidate') link.pc?.addIceCandidate({ candidate: m.candidate, sdpMid: m.mid }).catch(() => {});
    else if (m.type === 'rtc-error') alert(m.error);
  };
}
const reconnectListeners = new Set();
export const onReconnect = (fn) => reconnectListeners.add(fn);

async function startRtc() {
  link.pc?.close();
  const pc = new RTCPeerConnection({ iceServers: [] });
  link.pc = pc;
  // Unordered + no retransmits: stale packets are dropped, never delay newer ones (UDP semantics).
  const dc = pc.createDataChannel('input', { ordered: false, maxRetransmits: 0 });
  dc.binaryType = 'arraybuffer';
  link.dc = dc;
  dc.onopen = () => $('rtcDot').classList.add('on');
  dc.onclose = () => $('rtcDot').classList.remove('on');
  dc.onmessage = (e) => onBinary(e.data);
  await pc.setLocalDescription(await pc.createOffer());
  // Offline LAN: host candidates only, gathering completes almost instantly.
  await new Promise((r) => {
    if (pc.iceGatheringState === 'complete') return r();
    pc.addEventListener('icegatheringstatechange', () => pc.iceGatheringState === 'complete' && r());
    setTimeout(r, 1500);
  });
  link.sendJson({ type: 'rtc-offer', sdp: pc.localDescription.sdp });
}

export function reconnect() {
  me.kicked = false;
  if (!link.ws || link.ws.readyState > 1) connectWs();
}

export function startNet() {
  $('transport').onchange = (e) => {
    link.mode = e.target.value;
    link.sendJson({ type: 'transport', transport: link.mode });
    if (link.mode === 'rtc') startRtc();
    else { link.pc?.close(); link.pc = link.dc = null; $('rtcDot').classList.remove('on'); }
    sync.reset();
  };
  setInterval(() => {
    if (!background.paused && link.ready) sendPing();
    if (pingSent.size > 5000) pingSent.clear();
    if (inputSent.size > 5000) inputSent.clear();
  }, 50);
  connectWs();
}

// Tell the laptop which screen we're on (pad / wheel / mouse / idle).
export const setMode = (mode) => link.sendJson({ type: 'mode', mode });

// How phones reach this laptop without any router or internet:
//   hotspot  the laptop's own password-protected Wi-Fi (Wi-Fi Direct, run by PhoneController.exe --net)
//   usb      USB tethering: a cable, and the phone's "USB tethering" switch
//   wifi / ethernet  any network both already share
// The helper reports network changes as events, so there is no polling near the input path.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import { BRIDGE_EXE } from './paths.js';
import { settings, saveSettings } from './players.js';

const RETRY_MS = 5000;   // the hotspot can drop on sleep/resume or while Wi-Fi is turned off
const REASON = {
  RadioNotAvailable: 'Wi-Fi is off on this laptop, or it is in aeroplane mode. The hotspot needs Wi-Fi on, but no network or internet.',
  ResourceInUse: 'Another app is using the Wi-Fi adapter for its own hotspot. Close it, or turn off Mobile hotspot in Windows Settings.',
};

export const hotspot = { status: 'off', error: null, radioOff: false };   // status: off | starting | on | error
let proc = null, nets = null, retry = null, radioIsOff = false;

// ---------- credentials ----------
// No look-alike characters, so the password can also be typed from the screen.
const WORDS = 'abcdefghjkmnpqrstuvwxyz23456789';
const randomText = (n) => Array.from({ length: n }, () => WORDS[crypto.randomInt(WORDS.length)]).join('');
const newPassword = () => `${randomText(4)}-${randomText(4)}-${randomText(4)}`;   // ~59 bits

function creds() {
  if (!settings.hotspot) {
    settings.hotspot = { ssid: `PhoneController-${randomText(4).toUpperCase()}`, pass: newPassword(), auto: true };
    saveSettings();
  }
  return settings.hotspot;
}
export const hotspotSettings = () => ({ ...creds() });

const validSsid = (s) => typeof s === 'string' && s.trim() && Buffer.byteLength(s.trim()) <= 32 && !/[\r\n]/.test(s);
const validPass = (s) => typeof s === 'string' && s.length >= 8 && s.length <= 63 && /^[\x20-\x7e]+$/.test(s);

// WIFI: payload for a QR code: Android and iPhone cameras offer to join the network directly.
const wifiEscape = (s) => s.replace(/([\\;,:"])/g, '\\$1');
export const wifiPayload = () => { const c = creds(); return `WIFI:T:WPA;S:${wifiEscape(c.ssid)};P:${wifiEscape(c.pass)};;`; };

// ---------- helper process ----------
const send = (...lines) => { if (proc?.stdin.writable) proc.stdin.write(`${lines.join('\n')}\n`); };

export function startNetwork(onChange = () => {}) {
  if (proc || !fs.existsSync(BRIDGE_EXE)) return;
  proc = spawn(BRIDGE_EXE, ['--net'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.on('error', (e) => { console.warn(`[net] helper: ${e.message}`); proc = null; });
  proc.stderr.on('data', (d) => console.warn(`[net] ${d.toString().trim()}`));
  let pending = '';
  proc.stdout.setEncoding('utf8');
  proc.stdout.on('data', (d) => {
    pending += d;
    let i;
    while ((i = pending.indexOf('\n')) >= 0) {
      const line = pending.slice(0, i).trim();
      pending = pending.slice(i + 1);
      if (line.startsWith('NET ')) {
        try { nets = JSON.parse(line.slice(4)); onChange(); } catch {}
      } else if (line.startsWith('HOTSPOT ')) onHotspot(line.slice(8));
      else if (line.startsWith('RADIO ')) onRadio(line.slice(6));
    }
  });
  proc.on('exit', () => { proc = null; nets = null; if (hotspot.status !== 'off') Object.assign(hotspot, { status: 'error', error: 'The hotspot helper stopped.' }); });
  if (creds().auto) startHotspot();
}

function onHotspot(text) {
  if (radioIsOff) return;   // can't be running, whatever Windows reports while the radio goes down
  if (text === 'started') { Object.assign(hotspot, { status: 'on', error: null, radioOff: false }); console.log(`[net] hotspot on: ${creds().ssid}`); return; }
  if (text === 'stopped') {
    if (hotspot.status === 'on') scheduleRetry();   // we didn't ask for this: Windows dropped it
    return;
  }
  const reason = text.replace(/^error\s*/, '');
  Object.assign(hotspot, { status: 'error', radioOff: reason === 'RadioNotAvailable', error: REASON[reason] ?? `Windows could not start the hotspot (${reason}). USB cable still works.` });
  console.warn(`[net] hotspot: ${reason}`);
  scheduleRetry();
}
function onRadio(text) {
  if (text === 'off') {
    radioIsOff = true;
    clearTimeout(retry);
    if (settings.hotspot?.wanted) Object.assign(hotspot, { status: 'error', radioOff: true, error: REASON.RadioNotAvailable });
    return;
  }
  if (text === 'on') {
    const was = radioIsOff;
    radioIsOff = false;
    if (was && settings.hotspot?.wanted) startHotspot();   // Wi-Fi came back, by our button or the taskbar's
    return;
  }
  hotspot.error = `Windows would not turn Wi-Fi on (${text.replace(/^failed\s*/, '')}). Turn it on from the Wi-Fi button in the taskbar: it can stay on during aeroplane mode.`;
}
function scheduleRetry() {
  clearTimeout(retry);
  retry = setTimeout(() => { if (settings.hotspot?.wanted) startHotspot(); }, RETRY_MS);
}

export function startHotspot() {
  const c = creds();
  if (!c.wanted) { c.wanted = true; saveSettings(); }
  clearTimeout(retry);
  if (radioIsOff) { Object.assign(hotspot, { status: 'error', radioOff: true, error: REASON.RadioNotAvailable }); return; }
  Object.assign(hotspot, { status: 'starting', error: null, radioOff: false });
  send('start', c.ssid, c.pass);
}
export function stopHotspot() {
  const c = creds();
  if (c.wanted) { c.wanted = false; saveSettings(); }
  clearTimeout(retry);
  Object.assign(hotspot, { status: 'off', error: null, radioOff: false });
  send('stop');
}

// Manager's hotspot form. Returns an error message, or null when applied.
export function changeHotspot({ on, ssid, pass, regenerate, auto, wifiOn }) {
  if (wifiOn) { send('wifi-on'); return null; }
  const c = creds();
  let restart = false;
  if (ssid !== undefined && ssid !== c.ssid) {
    if (!validSsid(ssid)) return 'The name must be 1 to 32 characters.';
    c.ssid = ssid.trim(); restart = true;
  }
  if (pass !== undefined && pass !== c.pass) {
    if (!validPass(pass)) return 'The password must be 8 to 63 plain characters.';
    c.pass = pass; restart = true;
  }
  if (regenerate) { c.pass = newPassword(); restart = true; }
  if (auto !== undefined) c.auto = !!auto;
  saveSettings();
  if (on === false) stopHotspot();
  else if (on === true || (restart && hotspot.status !== 'off')) startHotspot();
  return null;
}

// ---------- addresses ----------
const KIND_LABEL = { hotspot: 'Hotspot', usb: 'USB cable', wifi: 'Wi-Fi', ethernet: 'Ethernet', other: 'Other' };
const KIND_RANK = { hotspot: 0, usb: 1, wifi: 2, ethernet: 3, other: 4 };

// Fallback when the helper isn't available (dev without a build).
function fromOs() {
  const out = [];
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family !== 'IPv4' || a.internal || a.address.startsWith('169.254.')) continue;
      const kind = /wi-?fi|wlan|wireless/i.test(name) ? 'wifi' : /ethernet/i.test(name) ? 'ethernet' : 'other';
      out.push({ ip: a.address, name, desc: name, kind });
    }
  }
  return out;
}

export function interfaces() {
  return (nets ?? fromOs())
    .map((n) => ({ name: n.name, address: n.ip, kind: n.kind, label: KIND_LABEL[n.kind] ?? 'Other' }))
    .sort((a, b) => KIND_RANK[a.kind] - KIND_RANK[b.kind]);
}

export function stopNetwork() {
  clearTimeout(retry);
  proc?.stdin.end();
}

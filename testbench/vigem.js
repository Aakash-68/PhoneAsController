// Virtual controllers via the bridge (PhoneController.exe --bridge, ViGEmBus). One slot per phone in pad/wheel mode.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { BRIDGE_EXE } from './paths.js';

const KIND = { x360: 1, ds4: 2 };
const SLOTS = 8;
const TEST_SLOT = SLOTS - 1;    // used by the setup self-test
const NEUTRAL_AFTER_MS = 300;   // no packets for this long (Wi-Fi drop) → centre sticks, release triggers
const REFRESH_MS = 100;         // resend unchanged state at least this often

export const vpad = { status: 'starting', error: null };
let proc = null;
const owners = new Array(SLOTS).fill(null);   // slot → session
let onFeedback = () => {};
export const setFeedbackHandler = (fn) => { onFeedback = fn; };

const frame = (...bytes) => { const f = Buffer.alloc(16); bytes.forEach((b, i) => { f[i] = b; }); return f; };
function write(f) { if (proc?.stdin.writable) proc.stdin.write(f); }

export function startBridge() {
  if (proc) return;
  if (!fs.existsSync(BRIDGE_EXE)) {
    Object.assign(vpad, { status: 'missing', error: `bridge not found at ${BRIDGE_EXE}` });
    console.warn(`[vpad] ${vpad.error}`);
    return;
  }
  Object.assign(vpad, { status: 'starting', error: null });
  proc = spawn(BRIDGE_EXE, ['--bridge'], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  proc.stderr.on('data', (d) => {
    for (const line of d.toString().split(/\r?\n/).filter(Boolean)) {
      if (line === 'READY') { vpad.status = 'ready'; console.log('[vpad] ViGEm bridge ready'); }
      else if (line.startsWith('ERROR')) { Object.assign(vpad, { status: 'no-driver', error: line.replace(/^ERROR\s*/, '') }); console.warn(`[vpad] ${line}`); }
      else console.log(`[vpad] ${line}`);
    }
  });
  let pending = Buffer.alloc(0);
  proc.stdout.on('data', (d) => {
    pending = Buffer.concat([pending, d]);
    while (pending.length >= 8) {
      const f = pending.subarray(0, 8);
      pending = pending.subarray(8);
      const s = owners[f[1]];
      if (f[0] === 0x81 && s) onFeedback(s, { large: f[2], small: f[3], rgb: [f[4], f[5], f[6]] });
    }
  });
  proc.on('exit', (code) => {
    if (vpad.status === 'ready' || vpad.status === 'starting') Object.assign(vpad, { status: 'stopped', error: `bridge exited (${code})` });
    for (const s of owners) if (s) s.vslot = null;
    owners.fill(null);
    proc = null;
  });
}

// After installing the driver the running bridge has no bus connection; start a fresh one.
export function restartBridge() {
  return new Promise((resolve) => {
    const start = () => { startBridge(); setTimeout(resolve, 1500); };
    if (!proc) return start();
    proc.once('exit', start);
    proc.stdin.end();
  });
}

export function plug(s) {
  if (vpad.status !== 'ready' || s.vslot != null) return;
  const type = s.vtype ?? 'x360';
  if (type === 'off') return;
  const slot = owners.findIndex((o, i) => !o && i !== TEST_SLOT);
  if (slot === -1) return;
  owners[slot] = s;
  s.vslot = slot;
  s.vplugged = type;
  s.vlast = null;
  write(frame(1, slot, KIND[type]));
}

export function unplug(s) {
  if (s.vslot == null) return;
  write(frame(2, s.vslot));
  owners[s.vslot] = null;
  s.vslot = null;
  s.vplugged = null;
}

// Phone switched Xbox ⇄ PS4 (or off): re-plug if it currently has a pad.
export function retype(s) {
  const using = s.vslot != null || s.mode === 'pad' || s.mode === 'wheel';
  unplug(s);
  if (using) plug(s);
}

// b = the phone's 48-byte pad packet; fields 22..35 are already in the bridge's report layout.
export function report(s, b) {
  if (s.vslot == null) return;
  const f = Buffer.allocUnsafe(16);
  f[0] = 3;
  f[1] = s.vslot;
  b.copy(f, 2, 22, 36);
  // Skip unchanged heartbeats, but refresh every 100 ms anyway: a report sent while Windows is
  // still enumerating a freshly plugged pad is dropped, and dedupe would otherwise never repair it.
  const t = performance.now();
  if (s.vlast && f.equals(s.vlast) && t - s.vlastAt < REFRESH_MS) return;
  s.vlast = f;
  s.vlastAt = t;
  s.vneutral = false;
  write(f);
}

function neutral(s) {
  const f = frame(3, s.vslot);
  s.vlast = f;
  s.vlastAt = performance.now();
  s.vneutral = true;
  write(f);
}

export function watchdog(sessions, now) {
  for (const s of sessions) {
    if (s.vslot != null && !s.vneutral && now - s.lastInputAt > NEUTRAL_AFTER_MS) neutral(s);
  }
}

// Setup check: plug a test Xbox pad, push a known stick value, and confirm Windows (XInput) sees it.
export async function selfTest(readPads) {
  if (vpad.status !== 'ready') return { ok: false, error: vpad.error ?? `bridge ${vpad.status}` };
  const before = readPads().length;
  write(frame(1, TEST_SLOT, KIND.x360));
  const report = frame(3, TEST_SLOT);
  report.writeInt16LE(12345, 6);
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let seen = null;
  for (let i = 0; i < 30 && !seen; i++) {
    await sleep(100);
    write(report);
    seen = readPads().find((p) => p.lx === 12345) ?? null;
  }
  const appeared = readPads().length > before;
  write(frame(2, TEST_SLOT));
  return seen ? { ok: true } : { ok: false, error: appeared ? 'pad appeared but input did not arrive' : 'Windows never saw the test controller' };
}

export function stopBridge() { proc?.stdin.end(); }

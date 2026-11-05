// The virtual controller state shared by the pad and wheel screens, and its wire packet.
import { MSG, KIND, HEARTBEAT, SIZE, now } from './common.js';
import { link, nextSeq, trackAck, me } from './net.js';
import { motion } from './motion.js';

export const BTN = { CROSS: 0, CIRCLE: 1, SQUARE: 2, TRIANGLE: 3, UP: 4, DOWN: 5, LEFT: 6, RIGHT: 7, L2: 8, L1: 9, R2: 10, R1: 11, SHARE: 12, OPTIONS: 13, L3: 14, R3: 15, HOME: 16, TOUCHPAD: 17 };

export const gp = { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, l2: 0, r2: 0, sent: 0 };

const i16 = (v) => Math.max(-32768, Math.min(32767, Math.round(v)));

// Radial dead zone, then sensitivity (gain, clamped to the stick circle). Trigger sensitivity = gain.
const shaped = [0, 0, 0, 0];
function shape(x, y, i) {
  const t = me.tune, m = Math.hypot(x, y);
  if (!t || (t.dead <= 0 && t.sens === 1) || m === 0) { shaped[i] = x; shaped[i + 1] = y; return; }
  if (m <= t.dead) { shaped[i] = 0; shaped[i + 1] = 0; return; }
  const k = Math.min(1, ((m - t.dead) / (1 - t.dead)) * t.sens) / m;
  shaped[i] = x * k; shaped[i + 1] = y * k;
}
const trig = (v) => Math.min(1, v * (me.tune?.trig ?? 1));
const buf = new DataView(new ArrayBuffer(SIZE.PAD));

export function sendPad(heartbeat, tEvent) {
  const tSend = now(), seq = nextSeq();
  buf.setUint8(0, MSG.INPUT);
  buf.setUint8(1, KIND.PAD | (heartbeat ? HEARTBEAT : 0));
  buf.setUint32(2, seq, true);
  buf.setFloat64(6, tEvent ?? tSend, true);
  buf.setFloat64(14, tSend, true);
  buf.setUint32(22, gp.buttons, true);
  shape(gp.lx, gp.ly, 0);
  shape(gp.rx, gp.ry, 2);
  buf.setInt16(26, i16(shaped[0] * 32767), true);
  buf.setInt16(28, i16(shaped[1] * 32767), true);
  buf.setInt16(30, i16(shaped[2] * 32767), true);
  buf.setInt16(32, i16(shaped[3] * 32767), true);
  buf.setUint8(34, Math.round(trig(gp.l2) * 255));
  buf.setUint8(35, Math.round(trig(gp.r2) * 255));
  for (let i = 0; i < 3; i++) {
    buf.setInt16(36 + i * 2, i16(motion.gyro[i] * 10), true);
    buf.setInt16(42 + i * 2, i16(motion.accel[i] * 1000), true);
  }
  link.sendBinary(buf.buffer);
  gp.sent++;
  if (!heartbeat) trackAck(seq, tEvent ?? tSend, tSend);
}

export function resetPad() {
  Object.assign(gp, { buttons: 0, lx: 0, ly: 0, rx: 0, ry: 0, l2: 0, r2: 0 });
}

// Haptic detents: a short click as a trigger crosses 50%, a longer one at 100%.
export const haptics = { on: true };
const zones = { l2: 0, r2: 0 };
const zoneOf = (v) => (v >= 0.999 ? 2 : v >= 0.5 ? 1 : 0);
export function detents() {
  for (const k of ['l2', 'r2']) {
    const z = zoneOf(gp[k]);
    if (z > zones[k] && haptics.on) navigator.vibrate?.(z === 2 ? 25 : 10);
    zones[k] = z;
  }
}

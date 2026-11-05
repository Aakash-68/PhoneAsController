// Motion sensor (DeviceMotion; Chrome only delivers it on https). Screen-relative axes: x right, y up, z out.
import { Ring } from './common.js';

const G = 9.80665;
export const motion = {
  raw: null,                 // roll in degrees, + = right side of the screen dipped down (absolute, vs gravity)
  gyro: [0, 0, 0],           // deg/s
  accel: [0, 0, 0],          // g
  hz: new Ring(60), last: 0,
};

const subs = new Set();
export const onMotion = (fn) => { subs.add(fn); return () => subs.delete(fn); };

// Device frame (x right, y up, z out, in natural portrait) → current screen frame.
export function toScreen(x, y, z) {
  switch (screen.orientation?.angle ?? 0) {
    case 90: return [-y, x, z];
    case 180: return [-x, -y, z];
    case 270: return [y, -x, z];
    default: return [x, y, z];
  }
}

window.addEventListener('devicemotion', (e) => {
  const g = e.accelerationIncludingGravity;
  if (!g || g.x == null) return;
  if (motion.last) motion.hz.push(e.timeStamp - motion.last);
  motion.last = e.timeStamp;

  const [ax, ay, az] = toScreen(g.x, g.y, g.z);
  // The sensor reports the upward reaction to gravity, so the right side dipping gives ax < 0.
  const mag = Math.hypot(ax, ay, az) || 1;
  motion.raw = Math.asin(Math.max(-1, Math.min(1, -ax / mag))) * 180 / Math.PI;
  motion.accel = [ax / G, ay / G, az / G];
  const r = e.rotationRate;   // beta = about device x, gamma = about device y, alpha = about device z
  if (r && r.beta != null) motion.gyro = toScreen(r.beta, r.gamma, r.alpha);

  for (const fn of subs) fn(e);
});

export function motionHz() {
  const v = motion.hz.values();
  if (!v.length) return null;
  const s = Float64Array.from(v).sort();
  return 1000 / s[s.length >> 1];
}

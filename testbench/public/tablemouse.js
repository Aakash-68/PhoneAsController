// Table mouse: slide the phone on a table and the cursor follows, like a real mouse.
// A phone has no mouse sensor, so position comes from the accelerometer alone: acceleration is
// integrated into velocity, and every trick below exists to keep that integration honest.
//   - gravity + sensor bias are learned while the phone rests, then subtracted (works without any
//     OS "linear acceleration" filter, which would add lag)
//   - velocity is forced to zero as soon as the phone stops (no drift at rest, no run-on)
//   - a stroke can't bounce backwards when it ends: motion in the opposite direction only counts
//     if it lasts long enough to be a real reversal
//   - rotating or lifting the phone disengages it, like lifting a mouse off the table
// DOM-free so tools/tablemouse-test.js can run it against simulated sensor data.

const SETTLE_MS = 70;       // after a stroke ends, how long to wait before believing a reversal
const LEAK_S = 1.5;         // velocity bleeds off with this time constant, bounding any error
const QUIET_SLOW = 3;       // samples of near-zero acceleration before velocity starts fading (60 Hz)
const QUIET_STOP = 6;       // ... and before the phone counts as stopped
const END_FRACTION = 0.12;  // while slowing down, below this share of peak speed the stroke is over
const MAX_SPEED = 4;        // m/s, far beyond a hand on a table
const LIFT_GYRO = 28;       // deg/s of tilting = picked up or rocked by a finger
const LIFT_Z = 2.8;         // m/s² vertical = picked up or tapped hard

export class TableMouse {
  constructor({ sensitivity = 1 } = {}) {
    this.sensitivity = sensitivity;   // higher = reacts to gentler movement
    this.reset();
  }

  reset() {
    this.state = 'calibrating';       // calibrating → ready ↔ moving, lifted → calibrating
    this.lastT = 0;
    this.grav = [0, 0, 0];
    this.samples = [];
    this.need = 30;                   // samples for a full calibration (~0.5 s)
    this.noise = 0.02;
    this.v = [0, 0];
    this.f = [0, 0];                  // lightly smoothed acceleration
    this.quiet = 0;
    this.peak = 0;
    this.dir = [0, 0];
    this.settle = 0;                  // end of the settle window (0 = not settling)
    this.pending = [0, 0];
    this.armed = null;                // first above-threshold sample, waiting for a second
    this.sign = 1;
  }

  get startThreshold() { return Math.max(0.16, 6 * this.noise) / this.sensitivity; }
  get stillThreshold() { return Math.max(0.07, 3.5 * this.noise) / this.sensitivity; }

  // a = acceleration including gravity (m/s²), gyro = deg/s, both screen axes: x right, y up, z out.
  // Returns the movement since the last sample in millimetres (y positive = toward the phone's top).
  update(ax, ay, az, gx, gy, t) {
    const dt = this.lastT ? (t - this.lastT) / 1000 : 0;
    if (dt > 0.25) { const s = this.sensitivity; this.reset(); this.sensitivity = s; }   // sensor paused (screen off, tab hidden)
    this.lastT = t;
    if (!(dt > 0) || dt > 0.25) return ZERO;

    if (this.state === 'calibrating' || this.state === 'lifted') return this.learn(ax, ay, az, gx, gy);

    const s = this.sign, rx = s * (ax - this.grav[0]), ry = s * (ay - this.grav[1]), rz = s * (az - this.grav[2]);
    if (Math.hypot(gx, gy) > LIFT_GYRO || Math.abs(rz) > LIFT_Z) return this.lift();

    const mag = Math.hypot(rx, ry);
    return this.state === 'ready' ? this.idle(rx, ry, mag, dt, ax, ay, az) : this.move(rx, ry, mag, dt, t);
  }

  // Wait for the phone to lie still, then take that as gravity + bias.
  learn(ax, ay, az, gx, gy) {
    const list = this.samples;
    list.push([ax, ay, az]);
    if (list.length > this.need) list.shift();
    if (Math.hypot(gx, gy) > 3) { list.length = 0; return ZERO; }
    if (list.length < this.need) return ZERO;
    const mean = [0, 1, 2].map((i) => list.reduce((sum, p) => sum + p[i], 0) / list.length);
    const spread = Math.max(...list.map((p) => Math.hypot(p[0] - mean[0], p[1] - mean[1], p[2] - mean[2])));
    if (spread > 0.35) { list.shift(); return ZERO; }
    this.grav = mean;
    this.sign = mean[2] < 0 ? -1 : 1;   // iPhones report the opposite sign; flat and face-up tells us which
    this.noise = Math.min(0.08, spread / 3);
    list.length = 0;
    this.need = 12;                     // after a lift only a short rest is needed
    this.state = 'ready';
    this.v = [0, 0]; this.f = [0, 0]; this.armed = null;
    return ZERO;
  }

  lift() {
    this.state = 'lifted';
    this.samples.length = 0;
    this.v = [0, 0];
    this.settle = 0;
    return ZERO;
  }

  // Resting: follow slow changes in gravity/bias, and watch for the start of a stroke.
  // Two samples in a row are required, which rejects a single knock on the table.
  idle(rx, ry, mag, dt, ax, ay, az) {
    if (mag < this.startThreshold) {
      this.armed = null;
      const k = 0.01;
      this.grav[0] += k * (ax - this.grav[0]); this.grav[1] += k * (ay - this.grav[1]); this.grav[2] += k * (az - this.grav[2]);
      return ZERO;
    }
    if (!this.armed || (this.armed[0] * rx + this.armed[1] * ry) <= 0) { this.armed = [rx, ry, dt]; return ZERO; }
    this.state = 'moving';
    this.v = [this.armed[0] * this.armed[2] + rx * dt, this.armed[1] * this.armed[2] + ry * dt];
    this.f = [rx, ry];
    this.armed = null; this.peak = 0; this.quiet = 0; this.settle = 0;
    return this.out(dt);
  }

  move(rx, ry, mag, dt, t) {
    this.f[0] += 0.6 * (rx - this.f[0]);
    this.f[1] += 0.6 * (ry - this.f[1]);
    const fx = this.f[0], fy = this.f[1];

    // Quiet = no acceleration and no sliding vibration: the phone has stopped.
    this.quiet = mag < this.stillThreshold ? this.quiet + 1 : 0;
    if (this.quiet >= QUIET_STOP) { this.state = 'ready'; this.v = [0, 0]; this.settle = 0; return ZERO; }

    if (this.settle) {
      this.pending[0] += fx * dt; this.pending[1] += fy * dt;
      if (t < this.settle) return ZERO;
      this.settle = 0;
      // Still pushing the other way: a real reversal, which keeps what it gathered while we waited.
      if (Math.hypot(fx, fy) > this.startThreshold * 0.7) { this.v = this.pending; this.peak = 0; return this.out(dt); }
      this.v = [0, 0]; this.peak = 0;
      return ZERO;
    }

    this.v[0] += fx * dt; this.v[1] += fy * dt;
    const leak = Math.exp(-dt / LEAK_S);
    this.v[0] *= leak; this.v[1] *= leak;
    if (this.quiet >= QUIET_SLOW) { this.v[0] *= 0.6; this.v[1] *= 0.6; }

    const speed = Math.hypot(this.v[0], this.v[1]);
    if (speed > MAX_SPEED) { this.v[0] *= MAX_SPEED / speed; this.v[1] *= MAX_SPEED / speed; }
    if (speed > this.peak) { this.peak = speed; this.dir = [this.v[0] / (speed || 1), this.v[1] / (speed || 1)]; }

    // End of stroke: slowing down and either nearly stopped or already past zero. Hold at zero
    // instead of letting the leftover of the braking pulse push the cursor backwards.
    const along = this.v[0] * this.dir[0] + this.v[1] * this.dir[1];
    const braking = fx * this.v[0] + fy * this.v[1] < 0;
    if (this.peak > 0.02 && (along <= 0 || (braking && speed < END_FRACTION * this.peak))) {
      this.v = [0, 0];
      this.pending = [0, 0];
      this.settle = t + SETTLE_MS;
      return ZERO;
    }
    return this.out(dt);
  }

  out(dt) { return { x: this.v[0] * dt * 1000, y: this.v[1] * dt * 1000, speed: Math.hypot(this.v[0], this.v[1]) }; }
}

const ZERO = { x: 0, y: 0, speed: 0 };

// Shared by the phone page, the dashboard and the Node server.
// Keep this file DOM-free at top level so Node can import it.

// Binary message types (first byte). All multi-byte fields little-endian.
//   PING      C→S  [1][seq u32][tSend f64]                                   13 B
//   PONG      S→C  [2][seq u32][tSend f64][tServer f64]                      21 B
//   INPUT     C→S  [3][kind u8][seq u32][tEvent f64][tSend f64][payload]
//                  kind 1 touch: [pointerId u8][phase u8][x u16][y u16]      28 B
//                  kind 2 pad:   [buttons u32][lx ly rx ry i16][l2 r2 u8]
//                                [gx gy gz i16 (deg/s ×10)][ax ay az i16 (milli-g)] 48 B
//                                motion axes are screen-relative: x right, y up, z out of screen
//                  kind | 0x80 = heartbeat resend of unchanged state (no fresh event)
//                  kind 3 mouse: [dx dy i16][buttons u8 (1 L,2 R,4 M)][wheel hwheel i16 (120 = 1 notch)] 31 B
//                  kind 4 key:   [vk u8 (Windows virtual-key)][down u8]          24 B
//   INPUT_ACK S→C  [4][seq u32][tSend f64]                                   13 B
export const MSG = { PING: 1, PONG: 2, INPUT: 3, INPUT_ACK: 4 };
export const KIND = { TOUCH: 1, PAD: 2, MOUSE: 3, KEY: 4 };
export const HEARTBEAT = 0x80;
export const PHASE = { DOWN: 0, MOVE: 1, UP: 2, RAW: 3 };
export const SIZE = { PING: 13, PONG: 21, TOUCH: 28, PAD: 48, MOUSE: 31, KEY: 24, INPUT_ACK: 13 };
export const MOUSE_BTN = { L: 1, R: 2, M: 4 };

// Epoch milliseconds with sub-millisecond resolution, same timebase in browser and Node.
export const now = () => performance.timeOrigin + performance.now();

export class Ring {
  constructor(capacity) {
    this.buf = new Float64Array(capacity);
    this.len = 0;
    this.pos = 0;
  }
  push(v) {
    this.buf[this.pos] = v;
    this.pos = (this.pos + 1) % this.buf.length;
    if (this.len < this.buf.length) this.len++;
  }
  clear() { this.len = 0; this.pos = 0; }
  values() {
    if (this.len < this.buf.length) return this.buf.slice(0, this.len);
    const out = new Float64Array(this.len);
    out.set(this.buf.subarray(this.pos));
    out.set(this.buf.subarray(0, this.pos), this.buf.length - this.pos);
    return out;
  }
}

export function summarize(samples) {
  const n = samples.length;
  if (!n) return null;
  const s = Float64Array.from(samples).sort();
  const q = (p) => s[Math.min(n - 1, Math.floor(p * n))];
  let sum = 0;
  for (const v of s) sum += v;
  const mean = sum / n;
  let varSum = 0;
  for (const v of s) varSum += (v - mean) ** 2;
  return {
    n, mean,
    min: s[0], p50: q(0.5), p90: q(0.9), p95: q(0.95), p99: q(0.99), max: s[n - 1],
    jitter: Math.sqrt(varSum / n),
  };
}

export const fmt = (v, digits = 2) => (v == null || Number.isNaN(v) ? '–' : v.toFixed(digits));

// Histogram of millisecond samples. Bins clamp at maxMs so outliers show in the last bar.
export function drawHistogram(canvas, samples, { maxMs = 30, bins = 60, color = '#4ade80', marks = {} } = {}) {
  const dpr = globalThis.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);

  const counts = new Array(bins).fill(0);
  for (const v of samples) counts[Math.min(bins - 1, Math.max(0, Math.floor((v / maxMs) * bins)))]++;
  const peak = Math.max(1, ...counts);
  const bw = w / bins;
  ctx.fillStyle = color;
  counts.forEach((c, i) => {
    const bh = (c / peak) * (h - 16);
    ctx.fillRect(i * bw + 0.5, h - 14 - bh, Math.max(1, bw - 1), bh);
  });

  ctx.fillStyle = '#8a93a6';
  ctx.font = '10px system-ui';
  for (let t = 0; t <= maxMs; t += maxMs / 6) ctx.fillText(`${Math.round(t)}`, (t / maxMs) * w + 2, h - 2);
  for (const [label, v] of Object.entries(marks)) {
    if (v == null) continue;
    const x = Math.min(w - 1, (v / maxMs) * w);
    ctx.fillStyle = '#facc15';
    ctx.fillRect(x, 0, 1, h - 14);
    ctx.fillText(label, x + 3, 10);
  }
}

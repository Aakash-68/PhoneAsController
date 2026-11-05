// Runs the table mouse against simulated sensor data: hand strokes with realistic sensor noise,
// bias, sliding vibration and uneven sample timing. Real-phone feel still needs a real phone; this
// guards the behaviour that must always hold (no drift, right direction, no bounce-back).
//   node tools/tablemouse-test.js
import { TableMouse } from '../public/tablemouse.js';

const G = 9.80665;
let seed = 7;
const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-9)) * Math.cos(2 * Math.PI * rnd());

// Minimum-jerk stroke: how hands actually move between two points.
const strokeAccel = (dist, dur, t) => {
  const u = t / dur;
  return (dist / (dur * dur)) * (60 * u - 180 * u * u + 120 * u * u * u);
};

// segments: { rest: s } or { x: m, y: m, dur: s } or { lift: s } or { knock: true }
function run(segments, { noise = 0.02, friction = 0.12, bias = [0.06, -0.04, 0.03], sensitivity = 1, rate = 60, flip = 1 } = {}) {
  const m = new TableMouse({ sensitivity });
  let t = 1000;
  const trace = [];
  const sample = (a, gyro = [0, 0], sliding = false) => {
    const n = () => gauss() * noise + (sliding ? gauss() * friction : 0);
    t += (1000 / rate) * (0.9 + rnd() * 0.2);
    const o = m.update(flip * (a[0] + bias[0] + n()), flip * (a[1] + bias[1] + n()), flip * (G + (a[2] ?? 0) + bias[2] + n()), gyro[0], gyro[1], t);
    trace.push({ t, x: o.x, y: o.y, state: m.state });
  };
  for (const seg of segments) {
    if (seg.rest) for (let i = 0; i < seg.rest * rate; i++) sample([0, 0]);
    else if (seg.lift) for (let i = 0; i < seg.lift * rate; i++) sample([gauss() * 1.5, gauss() * 1.5, gauss() * 3], [40 * Math.sin(i / 5), 30]);
    else if (seg.knock) sample([1.2, 0.8, 1]);
    else for (let i = 0; i < seg.dur * rate; i++) {
      const u = (i + 0.5) / rate;
      sample([strokeAccel(seg.x ?? 0, seg.dur, u), strokeAccel(seg.y ?? 0, seg.dur, u)], [0, 0], true);
    }
  }
  return trace;
}

const sum = (tr, k, from = 0, to = Infinity) => tr.filter((_, i) => i >= from && i < to).reduce((a, s) => a + s[k], 0);
let failed = 0;
function check(name, ok, detail) {
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name.padEnd(46)} ${detail}`);
  if (!ok) failed++;
}

// ---------- rest ----------
{
  const tr = run([{ rest: 60 }]);
  const travel = tr.reduce((a, s) => a + Math.hypot(s.x, s.y), 0);
  check('60 s at rest: no drift', travel === 0, `travel ${travel.toFixed(2)} mm`);
}
{
  const tr = run([{ rest: 1 }, { knock: true }, { rest: 1 }]);
  const travel = tr.reduce((a, s) => a + Math.hypot(s.x, s.y), 0);
  check('single knock on the table: cursor stays', travel < 0.5, `travel ${travel.toFixed(2)} mm`);
}

// ---------- single strokes in every direction, several speeds ----------
for (const [label, dist, dur] of [['quick 10 cm', 0.10, 0.25], ['normal 10 cm', 0.10, 0.45], ['slow 5 cm', 0.05, 0.7], ['small 2 cm', 0.02, 0.3]]) {
  for (const [dir, ux, uy] of [['right', 1, 0], ['left', -1, 0], ['forward', 0, 1], ['back', 0, -1], ['diagonal', 0.71, 0.71]]) {
    const tr = run([{ rest: 1 }, { x: ux * dist, y: uy * dist, dur }, { rest: 1 }]);
    const x = sum(tr, 'x'), y = sum(tr, 'y'), along = (x * ux + y * uy), off = Math.abs(x * uy - y * ux);
    const ratio = along / (dist * 1000);
    check(`${label} ${dir}: direction + distance`, ratio > 0.5 && ratio < 1.5 && off < 0.4 * along, `${along.toFixed(1)} mm of ${dist * 1000} (${(ratio * 100).toFixed(0)}%), off-axis ${off.toFixed(1)}`);
  }
}

// ---------- stopping ----------
{
  const tr = run([{ rest: 1 }, { x: 0.1, dur: 0.4 }, { rest: 1 }]);
  const start = 60, end = start + 24;
  const after = tr.slice(end + 9);   // 150 ms after the hand stopped
  const runOn = after.reduce((a, s) => a + Math.abs(s.x), 0);
  check('stops within 150 ms of the hand stopping', runOn < 2, `run-on ${runOn.toFixed(2)} mm`);
  const back = tr.reduce((a, s) => a + Math.min(0, s.x), 0);
  check('no bounce-back at the end of a stroke', back > -2, `backward ${back.toFixed(2)} mm`);
}

// ---------- reversal: back-and-forth keeps its direction changes ----------
{
  const tr = run([{ rest: 1 }, { x: 0.08, dur: 0.35 }, { x: -0.08, dur: 0.35 }, { x: 0.08, dur: 0.35 }, { rest: 0.5 }]);
  const a = 60, b = a + 21, c = b + 21, d = c + 21;
  const s1 = sum(tr, 'x', a, b), s2 = sum(tr, 'x', b, c), s3 = sum(tr, 'x', c, d);
  check('back and forth follows each stroke', s1 > 30 && s2 < -30 && s3 > 30, `${s1.toFixed(0)} / ${s2.toFixed(0)} / ${s3.toFixed(0)} mm`);
}

// ---------- lifting, like a real mouse ----------
{
  const tr = run([{ rest: 1 }, { x: 0.05, dur: 0.3 }, { rest: 0.3 }, { lift: 1 }, { rest: 0.5 }, { x: 0.05, dur: 0.3 }, { rest: 0.5 }]);
  const lifted = tr.slice(60 + 18 + 18, 60 + 18 + 18 + 60);
  const during = lifted.reduce((a, s) => a + Math.hypot(s.x, s.y), 0);
  check('lifted phone: cursor frozen', during < 1, `travel ${during.toFixed(2)} mm`);
  const after = sum(tr, 'x', 60 + 18 + 18 + 60);
  check('put back down: works again', after > 25, `${after.toFixed(1)} mm of 50`);
}

// ---------- other phones ----------
{
  const tr = run([{ rest: 1 }, { x: 0.1, dur: 0.4 }, { rest: 1 }], { flip: -1 });
  check('iPhone sign convention', sum(tr, 'x') > 50, `${sum(tr, 'x').toFixed(1)} mm`);
}
{
  const tr = run([{ rest: 1 }, { x: 0.1, dur: 0.4 }, { rest: 1 }], { noise: 0.05, friction: 0.25 });
  check('noisier sensor still tracks', sum(tr, 'x') > 50 && sum(tr, 'x') < 150, `${sum(tr, 'x').toFixed(1)} mm`);
  const rest = run([{ rest: 30 }], { noise: 0.05 });
  check('noisier sensor: no drift at rest', rest.every((s) => s.x === 0 && s.y === 0), '');
}

console.log(failed ? `\n${failed} FAILED` : '\nall passed');
process.exit(failed ? 1 : 0);

// Mirrors what the laptop actually receives onto the gamepad screen, once per frame: a control lights red
// whenever it is active, whatever drove it (touch, volume key, tilt, touch-look). Off the input path.
import { $ } from './overlay.js';
import { gp } from './gamepad.js';

const pad = $('pad');
const btnEls = [...pad.querySelectorAll('[data-btn]')].map((el) => ({ el, bit: 1 << +el.dataset.btn, on: false }));
const trigEls = [['l2', $('l2Btn')], ['r2', $('r2Btn')]].map(([k, el]) => ({ k, el, on: false }));
const stickEls = [...pad.querySelectorAll('[data-stick]')].map((el) => ({ k: el.dataset.stick, el, on: false, shown: false }));

export function renderPadVisuals() {
  const b = gp.buttons;
  for (const x of btnEls) {
    const on = (b & x.bit) !== 0;
    if (on !== x.on) { x.on = on; x.el.classList.toggle('act', on); }
  }
  for (const x of trigEls) {
    const on = gp[x.k] > 0.02;
    if (on !== x.on) { x.on = on; x.el.classList.toggle('act', on); }
  }
  for (const s of stickEls) {
    const vx = gp[s.k + 'x'], vy = gp[s.k + 'y'], m = Math.hypot(vx, vy);
    const on = m > 0.02;
    if (on !== s.on) { s.on = on; s.el.classList.toggle('act', on); }
    // A stick moved by something other than a finger on it (touch-look): show the same movement on the cap.
    if (!s.el.classList.contains('held')) {
      if (on || s.shown) {
        const st = s.el.style;
        st.setProperty('--x', vx.toFixed(3)); st.setProperty('--y', vy.toFixed(3)); st.setProperty('--m', Math.min(1, m).toFixed(3));
        if (on) st.setProperty('--ang', `${(Math.atan2(vy, vx) * 57.29578).toFixed(1)}deg`);
        s.shown = on;
      }
    } else s.shown = false;
  }
}

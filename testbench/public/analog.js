// 0..1 from a touch on a bar-shaped control (pad trigger or wheel pedal). Shared modes:
//   slide    – finger height = amount, back to 0 on release
//   lever    – like slide, but stays where you leave it (touch the bottom to cut)
//   pressure – press harder for more (needs the pressure calibration)
//   digital  – 0 or 100%
import { clamp01 } from './overlay.js';
import { metrics, pressValue } from './pressure.js';

// The bottom and top 6% of the bar snap to exactly 0% / 100%, so the extremes are easy to hit.
const SNAP = 0.06;

export function analogValue(mode, el, e, which) {
  if (mode === 'digital') return 1;
  if (mode === 'pressure') return pressValue(which, metrics(e)) ?? 1;
  const r = el.getBoundingClientRect();
  const raw = (r.bottom - e.clientY) / r.height;
  return clamp01((raw - SNAP) / (1 - 2 * SNAP));
}

export const keepsOnRelease = (mode) => mode === 'lever';
export const followsMoves = (mode) => mode !== 'digital';

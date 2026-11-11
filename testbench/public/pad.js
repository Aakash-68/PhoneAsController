// Gamepad screen: routes touches to the feature modules and sends the pad state.
//   sticks.js  – left/right on-screen sticks (floating centre, dead zone, curve, L3/R3 taps)
//   look.js    – empty screen area acts as the right stick (camera), optional
//   volkeys.js – phone volume keys → L2/R2, L1/R1 or any button
//   tilt.js    – tilt the phone for L2/R2
// Final L2/R2 = max(on-screen trigger, tilt, volume key).
import { fmt, summarize } from './common.js';
import { $, capture, isOpen, MOVE_EVENT, load, save, openOverlay, closeOverlay } from './overlay.js';
import { gp, sendPad, resetPad, detents } from './gamepad.js';
import { motion, onMotion } from './motion.js';
import { pressure, openPressureWizard } from './pressure.js';
import { analogValue, keepsOnRelease, followsMoves } from './analog.js';
import { link, acks } from './net.js';
import { layoutPad } from './hud.js';
import { stickDown, stickMove, stickUp, resetSticks } from './sticks.js';
import { lookDown, lookMove, lookUp, resetLook, initLook } from './look.js';
import { volTrig, initVolKeys, resetVolKeys } from './volkeys.js';
import { tilt, tiltValues, tiltNeedsCalibration, openTiltWizard, onPadOpen as tiltOnPadOpen, zeroTilt, motionText, renderTiltLive } from './tilt.js';
import './padsettings.js';

const padEl = $('pad');
export const padOpen = () => isOpen(padEl);

// On-screen L2/R2 sliders (analog.js modes).
export const padTrig = { mode: load('padTrigMode', 'slide') };
const pressed = { L2: 0, R2: 0 };
function updateTriggers() {
  const t = tiltValues();
  gp.l2 = Math.max(pressed.L2, t.L, volTrig.L2);
  gp.r2 = Math.max(pressed.R2, t.R, volTrig.R2);
}

const stamp = (e) => (e && e.timeStamp != null ? performance.timeOrigin + e.timeStamp : undefined);
// Every input change goes through here: recompute triggers, haptic detents, send now.
export function commit(e) { updateTriggers(); detents(); sendPad(false, stamp(e)); }

initLook(commit, padOpen);
initVolKeys(commit, padOpen);

// ---------- touch routing ----------
const owners = new Map();   // pointerId → control element, or 'look'

padEl.addEventListener('pointerdown', (e) => {
  if (padEl.classList.contains('editing')) return;
  const el = e.target.closest('[data-btn],[data-stick],[data-trigger]');
  if (!el) {
    // Empty space (not the exit / island / info): maybe the touch-look zone.
    if (e.target.closest('.exit, .island, .editbar')) return;
    if (!lookDown(e)) return;
    capture(padEl, e);
    owners.set(e.pointerId, 'look');
    commit(e);
    return;
  }
  capture(padEl, e);
  owners.set(e.pointerId, el);
  if (el.dataset.stick) stickDown(el, e);
  else if (el.dataset.trigger) pressed[el.dataset.trigger] = analogValue(padTrig.mode, el, e, el.dataset.trigger);
  else { gp.buttons |= 1 << +el.dataset.btn; el.classList.add('on'); navigator.vibrate?.(6); }
  commit(e);
});
padEl.addEventListener(MOVE_EVENT, (e) => {
  const el = owners.get(e.pointerId);
  if (!el) return;
  if (el === 'look') { if (!lookMove(e)) return; }
  else if (el.dataset.stick) stickMove(el, e);
  else if (el.dataset.trigger && followsMoves(padTrig.mode)) pressed[el.dataset.trigger] = analogValue(padTrig.mode, el, e, el.dataset.trigger);
  else return;
  commit(e);
});
function release(e) {
  const el = owners.get(e.pointerId);
  if (!el) return;
  owners.delete(e.pointerId);
  if (el === 'look') lookUp(e);
  else if (el.dataset.stick) stickUp(el, e);
  else if (el.dataset.trigger) { if (!keepsOnRelease(padTrig.mode)) pressed[el.dataset.trigger] = 0; }
  else { gp.buttons &= ~(1 << +el.dataset.btn); el.classList.remove('on'); }
  commit(e);
}
padEl.addEventListener('pointerup', release);
padEl.addEventListener('pointercancel', release);
padEl.addEventListener('contextmenu', (e) => e.preventDefault());

onMotion((e) => { if (isOpen(padEl)) commit(e); });

// ---------- open / close ----------
export async function openPad() {
  resetPad();
  pressed.L2 = pressed.R2 = 0;
  owners.clear();
  resetSticks(); resetLook(); resetVolKeys();
  await openOverlay(padEl, 'pad', () => sendPad(true));
  layoutPad();
  tiltOnPadOpen();
}

$('padOpen').onclick = () => {
  // Calibrate whatever the chosen trigger input needs before playing.
  if (padTrig.mode === 'pressure' && !pressure.cal) openPressureWizard((saved) => saved && openPad());
  else if (tiltNeedsCalibration()) openTiltWizard(true, openPad);
  else openPad();
};
$('padTrigMode').value = padTrig.mode;
$('padTrigMode').onchange = (e) => { padTrig.mode = e.target.value; save('padTrigMode', padTrig.mode); };
$('padClose').onclick = () => closeOverlay();
$('padZero').onclick = zeroTilt;

// ---------- render (called every frame) ----------
export function renderPad() {
  renderTiltLive();
  if (!isOpen(padEl)) return;
  const a = summarize(acks.ackRtt.values());
  $('padInfo').textContent = `${link.mode} · sent ${gp.sent} · ack RTT p50 ${fmt(a?.p50)} ms · ${motionText()}`;
  for (const [id, v] of [['l2Btn', gp.l2], ['r2Btn', gp.r2]]) {
    const el = $(id);
    el.style.setProperty('--v', v.toFixed(3));
    el.classList.toggle('active', v > 0.02);
    el.querySelector('.tv').textContent = `${Math.round(v * 100)}%`;
  }
}
// Unused here but kept for callers that read the tilt state directly.
export { tilt, motion };

// Keyboard screen: WASD / arrows + chosen keys at real keycap size. Presses real keys on the laptop
// (same permission as the mouse). Each key sends one packet on press and one on release.
import { MSG, KIND, SIZE, now } from './common.js';
import { $, capture, isOpen, openOverlay, closeOverlay } from './overlay.js';
import { link, nextSeq, trackAck } from './net.js';
import { buildKeys, layoutKeys } from './hud.js';

const el = $('keys');
const buf = new DataView(new ArrayBuffer(SIZE.KEY));
const held = new Map();   // pointerId → key element

function send(vk, down, tEvent) {
  const tSend = now(), seq = nextSeq();
  buf.setUint8(0, MSG.INPUT);
  buf.setUint8(1, KIND.KEY);
  buf.setUint32(2, seq, true);
  buf.setFloat64(6, tEvent ?? tSend, true);
  buf.setFloat64(14, tSend, true);
  buf.setUint8(22, vk);
  buf.setUint8(23, down ? 1 : 0);
  link.sendBinary(buf.buffer);
  trackAck(seq, tEvent ?? tSend, tSend);
}
const stamp = (e) => performance.timeOrigin + e.timeStamp;
const pressedCount = (k) => [...held.values()].filter((x) => x === k).length;

el.addEventListener('pointerdown', (e) => {
  const k = e.target.closest('.kk');
  if (!k) return;
  capture(el, e);
  const first = !pressedCount(k);
  held.set(e.pointerId, k);
  if (first) { k.classList.add('on'); send(+k.dataset.vk, true, stamp(e)); navigator.vibrate?.(8); }
  e.preventDefault();
});
function up(e) {
  const k = held.get(e.pointerId);
  if (!k) return;
  held.delete(e.pointerId);
  if (!pressedCount(k)) { k.classList.remove('on'); send(+k.dataset.vk, false, stamp(e)); }
}
el.addEventListener('pointerup', up);
el.addEventListener('pointercancel', up);
el.addEventListener('contextmenu', (e) => e.preventDefault());

function releaseAll() {
  for (const k of new Set(held.values())) { k.classList.remove('on'); send(+k.dataset.vk, false); }
  held.clear();
}

export async function openKeys() {
  await openOverlay(el, 'keys');
  buildKeys();
  layoutKeys();
}
$('keysOpen').onclick = openKeys;
$('keysClose').onclick = () => { releaseAll(); closeOverlay(); };
document.addEventListener('visibilitychange', () => { if (document.hidden && isOpen(el)) releaseAll(); });

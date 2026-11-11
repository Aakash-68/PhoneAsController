// Fullscreen landscape overlays (pad, wheel, mouse, calibration) + shared helpers.
import { startKeepAwake, stopKeepAwake } from './keepawake.js';
import { setMode, onReconnect } from './net.js';

export const $ = (id) => document.getElementById(id);
export const show = (id, on) => $(id).classList.toggle('hidden', !on);
export const isOpen = (el) => !el.classList.contains('hidden');
export const clamp01 = (v) => Math.min(1, Math.max(0, v));
export const supportsRaw = 'onpointerrawupdate' in window;
// pointerrawupdate fires as soon as the event arrives; pointermove waits for the next frame.
export const MOVE_EVENT = supportsRaw ? 'pointerrawupdate' : 'pointermove';

// Pointer capture can throw if the pointer is already gone; input handling must carry on regardless.
export function capture(el, e) { try { el.setPointerCapture(e.pointerId); } catch {} }

export function load(key, fallback) {
  try { const v = JSON.parse(localStorage.getItem(key) ?? 'null'); return v ?? fallback; } catch { return fallback; }
}
export function save(key, value) {
  try { value == null ? localStorage.removeItem(key) : localStorage.setItem(key, JSON.stringify(value)); } catch {}
}

let current = null, wakeLock = null, timer = null;
// Listeners told the current mode ('pad', 'wheel', … or 'idle') whenever a controller screen opens or closes.
const overlayListeners = new Set();
export const onOverlay = (fn) => overlayListeners.add(fn);
export const overlayMode = () => current?.mode ?? 'idle';
const notifyOverlay = () => { for (const fn of overlayListeners) fn(overlayMode()); };
onReconnect(() => current && setMode(current.mode));

export async function enterFullscreen() {
  try { await document.documentElement.requestFullscreen({ navigationUI: 'hide' }); await screen.orientation.lock('landscape'); } catch {}
}
export async function exitFullscreen() {
  try { if (document.fullscreenElement) await document.exitFullscreen(); } catch {}
}

// heartbeat: called at ~250 Hz while open (resends state, keeps the Wi-Fi radio awake).
export async function openOverlay(el, mode, heartbeat) {
  if (current) closeOverlay(true);
  current = { el, mode };
  el.classList.remove('hidden');
  setMode(mode);
  await enterFullscreen();
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch {}
  if (!wakeLock) startKeepAwake();
  if (heartbeat) timer = setInterval(heartbeat, 4);
  notifyOverlay();
}

export function closeOverlay(keepFullscreen = false) {
  if (!current) return;
  current.el.classList.add('hidden');
  current = null;
  clearInterval(timer);
  timer = null;
  wakeLock?.release();
  wakeLock = null;
  stopKeepAwake();
  setMode('idle');
  if (!keepFullscreen) exitFullscreen();
  notifyOverlay();
}

export function setupCanvas(canvas) {
  const dpr = devicePixelRatio || 1, w = canvas.clientWidth, h = canvas.clientHeight;
  if (canvas.width !== w * dpr || canvas.height !== h * dpr) { canvas.width = w * dpr; canvas.height = h * dpr; }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, w, h);
  return { ctx, w, h };
}

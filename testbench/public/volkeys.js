// Phone volume keys as controller inputs.
//   volTrig = { L2: 0..1, R2: 0..1 }: pad.js ORs (max) these into the triggers.
//   initVolKeys(commit, isPadOpen), resetVolKeys().
// Settings UI renders itself into #set-vol.
//
// Reality check: Chromium on Android (Chrome, Samsung Internet, Edge, Brave…) filters
// KEYCODE_VOLUME_UP/DOWN out before they reach web content (ContentViewClient
// .shouldPropagateKey), fullscreen or not, so on most phones nothing arrives here and the
// keys just change the system volume. The settings card has a live test so the user can see
// whether their browser passes them; we never claim it works.
import { $, load, save } from './overlay.js';
import { gp } from './gamepad.js';

export const volTrig = { L2: 0, R2: 0 };

// Target ids: 'L2' / 'R2' = analog trigger at 100%; numbers = gp.buttons bit.
const TARGETS = [
  ['L2', 'LT / L2'], ['R2', 'RT / R2'], ['9', 'LB / L1'], ['11', 'RB / R1'],
  ['0', 'A / ✕'], ['1', 'B / ○'], ['2', 'X / □'], ['3', 'Y / △'],
  ['4', 'D-pad ↑'], ['5', 'D-pad ↓'], ['6', 'D-pad ←'], ['7', 'D-pad →'],
  ['14', 'L3 (left stick click)'], ['15', 'R3 (right stick click)'],
  ['12', 'View / Share'], ['13', 'Menu / Options'], ['16', 'Home / PS'], ['17', 'Touchpad click'],
];
const PRESETS = { triggers: { down: 'L2', up: 'R2' }, bumpers: { down: '9', up: '11' } };

const cfg = Object.assign({ mode: 'triggers', down: 'L2', up: 'R2' }, load('volkeys', {}));
const held = { up: false, down: false };
const owned = { up: null, down: null };   // target each key is currently driving
let commit = () => {}, padOpen = () => false;
let seen = { up: false, down: false };

function whichKey(e) {
  const k = e.key, c = e.keyCode;
  if (k === 'AudioVolumeUp' || k === 'VolumeUp' || c === 175 || c === 183) return 'up';
  if (k === 'AudioVolumeDown' || k === 'VolumeDown' || c === 174 || c === 182) return 'down';
  return null;
}

function targetFor(key) {
  if (cfg.mode === 'off') return null;
  if (cfg.mode === 'custom') return cfg[key];
  return (PRESETS[cfg.mode] || PRESETS.triggers)[key];
}

function setTarget(t, on) {
  if (t == null) return;
  if (t === 'L2' || t === 'R2') volTrig[t] = on ? 1 : 0;
  else { const bit = 1 << +t; gp.buttons = on ? gp.buttons | bit : gp.buttons & ~bit; }
}

// Re-apply both keys from scratch (handles both keys mapped to the same target).
function apply() {
  for (const k of ['up', 'down']) { setTarget(owned[k], false); owned[k] = null; }
  for (const k of ['up', 'down']) if (held[k]) { owned[k] = targetFor(k); setTarget(owned[k], true); }
}

function onKey(e) {
  const key = whichKey(e);
  if (!key) return;
  const down = e.type === 'keydown';
  if (down) markSeen(key);
  if (!padOpen() || cfg.mode === 'off') return;
  e.preventDefault();
  if (e.repeat || held[key] === down) return;
  held[key] = down;
  apply();
  commit(e);
}

function clearAll(send) {
  const was = held.up || held.down;
  held.up = held.down = false;
  apply();
  volTrig.L2 = volTrig.R2 = 0;
  if (was && send) commit();
}

export function initVolKeys(commitFn, isPadOpen) {
  commit = commitFn || commit;
  padOpen = isPadOpen || padOpen;
  window.addEventListener('keydown', onKey, { capture: true });
  window.addEventListener('keyup', onKey, { capture: true });
  window.addEventListener('blur', () => clearAll(true));
  document.addEventListener('visibilitychange', () => { if (document.hidden) clearAll(true); });
  renderSettings();
}

export function resetVolKeys() { clearAll(false); }

// ---------- settings card ----------
const opts = (list, sel) => list.map(([v, t]) => `<option value="${v}"${v === sel ? ' selected' : ''}>${t}</option>`).join('');

function renderSettings() {
  const card = $('set-vol');
  if (!card) return;
  card.innerHTML = `
    <h3>Volume keys</h3>
    <label class="row">Act as
      <select id="volMode">${opts([
        ['triggers', 'Triggers: − LT / L2, + RT / R2'],
        ['bumpers', 'Bumpers: − LB / L1, + RB / R1'],
        ['custom', 'Custom…'], ['off', 'Off'],
      ], cfg.mode)}</select></label>
    <div id="volCustom">
      <label class="row">Vol − <select id="volDown">${opts(TARGETS, cfg.down)}</select></label>
      <label class="row">Vol + <select id="volUp">${opts(TARGETS, cfg.up)}</select></label>
    </div>
    <p class="small muted">Triggers press fully (100%) while the key is held. Only active while the gamepad is open.</p>
    <div class="volTest small" id="volTest"></div>
    <p class="small muted" id="volNote">Most Android browsers do <b>not</b> pass the volume keys to web pages: Chrome, Samsung Internet, Edge and other Chrome-based browsers keep them for the system volume, even in full screen. No common Android browser is confirmed to work. If the test above stays at "not yet" when you press the keys, this browser doesn't pass them; you can try another browser (e.g. Firefox).</p>`;
  const mode = $('volMode'), dn = $('volDown'), up = $('volUp');
  const sync = () => {
    cfg.mode = mode.value; cfg.down = dn.value; cfg.up = up.value;
    $('volCustom').classList.toggle('hidden', cfg.mode !== 'custom');
    save('volkeys', { ...cfg });
    clearAll(true);
  };
  mode.onchange = dn.onchange = up.onchange = sync;
  $('volCustom').classList.toggle('hidden', cfg.mode !== 'custom');
  renderTest();
}

function markSeen(key) {
  if (seen[key]) { flash(); return; }
  seen[key] = true;
  renderTest();
  flash();
}

function flash() {
  const el = $('volTest');
  if (!el) return;
  el.classList.remove('hit'); void el.offsetWidth; el.classList.add('hit');
}

function renderTest() {
  const el = $('volTest');
  if (!el) return;
  const any = seen.up || seen.down;
  el.innerHTML = 'Test: press a volume key · ' +
    `<span class="${seen.down ? 'ok' : 'muted'}">Vol − ${seen.down ? 'detected ✓' : 'not yet'}</span> · ` +
    `<span class="${seen.up ? 'ok' : 'muted'}">Vol + ${seen.up ? 'detected ✓' : 'not yet'}</span>`;
  $('volNote')?.classList.toggle('hidden', any);
}

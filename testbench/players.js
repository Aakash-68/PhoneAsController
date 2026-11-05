// Connected phones as players: number, name, colour and controller type, remembered per device.
import { readJson, writeJson } from './paths.js';

// Calm, hardware-like player lights (shown on the phone's island and in the manager).
export const PALETTE = [
  { name: 'Ember', hex: '#c8714f' }, { name: 'Sage', hex: '#7f9a78' }, { name: 'Slate', hex: '#5f7c9c' },
  { name: 'Ochre', hex: '#c49a45' }, { name: 'Plum', hex: '#8c6b94' }, { name: 'Teal', hex: '#4e8f8c' },
  { name: 'Rose', hex: '#c48a8c' }, { name: 'Graphite', hex: '#5d6066' },
];
// Per-phone feel, applied on the phone before sending: vibration strength, stick sensitivity,
// stick dead zone (fraction of travel) and trigger sensitivity.
export const TUNE = { vib: 0.8, sens: 1, dead: 0, trig: 1 };
const LIMITS = { vib: [0, 1], sens: [0.5, 2], dead: [0, 0.3], trig: [0.5, 2] };
const VTYPES = ['x360', 'ds4', 'off'];
const MAX_PLAYERS = 8;

const known = readJson('devices.json', {});   // deviceId → { name, color, vtype, tune }
const save = () => writeJson('devices.json', known);

export const settings = { defaultType: 'x360', rumble: true, lockJoins: false, ...readJson('settings.json', {}) };
export const isKnown = (deviceId) => typeof deviceId === 'string' && !!known[deviceId];
export const saveSettings = () => writeJson('settings.json', settings);

// Give a session its player identity. Same phone (deviceId) gets its old name/colour back.
export function join(s, deviceId, sessions) {
  const others = [...sessions].filter((o) => o !== s && o.player);
  const id = typeof deviceId === 'string' && /^[\w-]{8,64}$/.test(deviceId) ? deviceId : null;
  const prev = id ? known[id] : null;
  const usedNumbers = new Set(others.map((o) => o.player));
  const usedColors = new Set(others.map((o) => o.color));
  s.deviceId = id;
  s.player = [...Array(MAX_PLAYERS).keys()].map((i) => i + 1).find((n) => !usedNumbers.has(n)) ?? others.length + 1;
  s.name = prev?.name ?? `Phone ${s.player}`;
  s.color = prev?.color ?? (PALETTE.find((p) => !usedColors.has(p.hex)) ?? PALETTE[(s.player - 1) % PALETTE.length]).hex;
  s.vtype = VTYPES.includes(prev?.vtype) ? prev.vtype : settings.defaultType;
  s.tune = { ...TUNE, ...(prev?.tune ?? {}) };
  remember(s);
}

export function update(s, { name, color, vtype, tune }) {
  if (typeof name === 'string' && name.trim()) s.name = name.trim().slice(0, 24);
  if (typeof color === 'string' && /^#[0-9a-f]{6}$/i.test(color)) s.color = color.toLowerCase();
  if (VTYPES.includes(vtype)) s.vtype = vtype;
  if (tune && typeof tune === 'object') {
    for (const [k, [lo, hi]] of Object.entries(LIMITS)) if (Number.isFinite(tune[k])) s.tune[k] = Math.min(hi, Math.max(lo, tune[k]));
  }
  remember(s);
}

function remember(s) {
  if (!s.deviceId) return;
  known[s.deviceId] = { name: s.name, color: s.color, vtype: s.vtype, tune: s.tune };
  save();
}

export const identity = (s) => ({ type: 'identity', player: s.player, name: s.name, color: s.color, vtype: s.vtype, tune: s.tune, rumble: settings.rumble !== false });

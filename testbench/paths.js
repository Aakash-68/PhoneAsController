// Where things live, in dev (repo checkout) and in the portable build (dist/PhoneController/).
//   portable layout: <root>/PhoneController.exe, <root>/runtime/node.exe, <root>/app/server.js, <root>/vendor/, <root>/.portable
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.dirname(fileURLToPath(import.meta.url));          // folder holding server.js
const portableRoot = path.resolve(APP_DIR, '..');
// Only a folder carrying the marker counts as the portable install; uninstall may delete it, never a dev checkout.
export const PORTABLE = fs.existsSync(path.join(portableRoot, '.portable')) ? portableRoot : null;
export const REPO_ROOT = PORTABLE ?? path.resolve(APP_DIR, '..');

export const BRIDGE_EXE = process.env.PC_BRIDGE
  ?? (PORTABLE ? path.join(PORTABLE, 'PhoneController.exe') : path.join(REPO_ROOT, 'bridge', 'out', 'PhoneController.exe'));
export const VIGEM_INSTALLER = path.join(REPO_ROOT, 'vendor', 'ViGEmBus_1.22.0_x64_x86_arm64.exe');
export const NODE_EXE = process.execPath;

// Per-user data (settings, phone names/colours, certificate). Removed by uninstall.
export const DATA_DIR = path.join(process.env.LOCALAPPDATA ?? os.homedir(), 'PhoneController');
fs.mkdirSync(DATA_DIR, { recursive: true });

export function readJson(name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA_DIR, name), 'utf8')); } catch { return fallback; }
}
export function writeJson(name, value) {
  try { fs.writeFileSync(path.join(DATA_DIR, name), JSON.stringify(value, null, 2)); } catch (e) { console.warn(`[data] ${name}: ${e.message}`); }
}

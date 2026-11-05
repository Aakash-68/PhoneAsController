// First-run setup and uninstall for the PC side: controller driver (ViGEmBus), firewall rule, self-test.
// Actions that change the system go through UAC, so Windows always asks the user first.
import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, NODE_EXE, PORTABLE, VIGEM_INSTALLER } from './paths.js';
import { settings, saveSettings } from './players.js';

const RULE = 'PhoneController';
const run = (file, args) => new Promise((resolve) => {
  execFile(file, args, { windowsHide: true, timeout: 120000 }, (err, stdout, stderr) => resolve({ code: err ? (err.code ?? 1) : 0, out: `${stdout}${stderr}` }));
});
const ps = (cmd) => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', cmd]);
const q = (s) => `'${String(s).replace(/'/g, "''")}'`;

// Runs a PowerShell script elevated (UAC prompt). Rejects if the user says no.
async function elevated(script) {
  const r = await ps(`try { $p = Start-Process powershell.exe -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList '-NoProfile','-Command',${q(script)}; exit $p.ExitCode } catch { exit 1223 }`);
  if (r.code === 1223) throw new Error('Windows permission was declined');
  if (r.code !== 0) throw new Error(`failed (exit ${r.code})`);
}

// ---------- checks ----------
async function driverStatus() {
  const r = await run('sc.exe', ['query', 'ViGEmBus']);
  if (r.code !== 0) return { installed: false, running: false, version: null };
  const v = await ps("(Get-Item \"$env:SystemRoot\\System32\\drivers\\ViGEmBus.sys\" -ErrorAction SilentlyContinue).VersionInfo.FileVersion");
  return { installed: true, running: /RUNNING/.test(r.out), version: v.out.trim() || null };
}

async function firewallStatus() {
  const r = await ps(`@(Get-NetFirewallApplicationFilter -Program ${q(NODE_EXE)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Allow' } | ForEach-Object { $_.Profile.ToString() }) -join ','`);
  const profiles = r.out.trim();
  // Block rules always win over Allow rules. Windows adds them when its "allow access?" prompt is dismissed,
  // and then phones on that kind of network can't connect at all (the page just keeps loading).
  const b = await ps(`@(Get-NetFirewallApplicationFilter -Program ${q(NODE_EXE)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Enabled -eq 'True' -and $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | ForEach-Object { $_.Profile.ToString() }) -join ','`);
  const blocked = b.out.trim();
  // "Any" or all three profiles = phones can reach us on every kind of network (hotspot/USB count as Public).
  const ok = !blocked && (/Any/.test(profiles) || (/Public/.test(profiles) && /Private/.test(profiles)));
  return { ok, profiles: profiles || 'none', blocked: blocked || null };
}

// The system queries take a few seconds (PowerShell), so results are cached and refreshed in the
// background; callers only wait when there's no result yet or they ask for a fresh one.
let cache = null, cacheAt = 0, pending = null;
function refresh() {
  pending ??= Promise.all([driverStatus(), firewallStatus()]).then(([driver, firewall]) => {
    cache = { driver, firewall };
    cacheAt = Date.now();
  }).finally(() => { pending = null; });
  return pending;
}
export const warmUp = () => refresh();

export async function status(vpad, fresh = false) {
  if (fresh || !cache) await refresh();
  else if (Date.now() - cacheAt > 10000) refresh();
  const { driver, firewall } = cache;
  const verified = settings.verified?.driverVersion && settings.verified.driverVersion === driver.version;
  return {
    driver, firewall, bridge: { status: vpad.status, error: vpad.error },
    verified: !!verified, verifiedAt: verified ? settings.verified.at : null,
    ready: driver.running && vpad.status === 'ready' && !!verified,
    portable: !!PORTABLE, installerBundled: fs.existsSync(VIGEM_INSTALLER),
  };
}

// ---------- actions ----------
export async function installDriver() {
  if (!fs.existsSync(VIGEM_INSTALLER)) throw new Error('driver installer is missing from this download');
  // The official installer shows its own wizard and asks Windows for permission itself.
  const r = await run(VIGEM_INSTALLER, []);
  cache = null;
  if (r.code !== 0 && r.code !== 3010) throw new Error(`driver installer exited with ${r.code}`);
  return { rebootRequired: r.code === 3010 };
}

export async function allowFirewall() {
  // Also removes Windows' own Block rules for our node.exe (left by a dismissed "allow access?" prompt).
  await elevated(`Get-NetFirewallApplicationFilter -Program ${q(NODE_EXE)} -ErrorAction SilentlyContinue | Get-NetFirewallRule | Where-Object { $_.Direction -eq 'Inbound' -and $_.Action -eq 'Block' } | Remove-NetFirewallRule; Remove-NetFirewallRule -DisplayName ${q(RULE)} -ErrorAction SilentlyContinue; New-NetFirewallRule -DisplayName ${q(RULE)} -Direction Inbound -Program ${q(NODE_EXE)} -Action Allow -Profile Any | Out-Null`);
  cache = null;
}

export function markVerified(driverVersion) {
  settings.verified = { at: new Date().toISOString(), driverVersion };
  saveSettings();
  cache = null;
}

// Removes what we added. The driver is optional: other apps (DS4Windows, Steam tools) may share it.
export async function uninstall({ firewall = true, driver = false, files = true }) {
  const done = [];
  if (firewall) {
    try { await elevated(`Remove-NetFirewallRule -DisplayName ${q(RULE)} -ErrorAction SilentlyContinue`); done.push('firewall rule removed'); }
    catch (e) { done.push(`firewall rule: ${e.message}`); }
  }
  if (driver) {
    const r = await ps("Get-ItemProperty HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*, HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\* -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -match 'ViGEm Bus Driver|Virtual Gamepad Emulation Bus' } | ForEach-Object { $_.PSChildName }");
    const codes = r.out.split(/\r?\n/).map((c) => c.trim()).filter((c) => /^\{[0-9A-F-]+\}$/i.test(c));
    for (const code of codes) await run('msiexec.exe', ['/x', code]);   // interactive; Windows asks for permission
    done.push(codes.length ? 'controller driver uninstaller started' : 'controller driver not found');
  }
  if (files) {
    fs.rmSync(DATA_DIR, { recursive: true, force: true });
    done.push('settings removed');
    if (PORTABLE) {
      // Added by Install.exe. Harmless no-ops for an app folder that was just unzipped.
      await ps(`Remove-Item -Force -ErrorAction SilentlyContinue "$([Environment]::GetFolderPath('Desktop'))\\PhoneController.lnk","$([Environment]::GetFolderPath('Programs'))\\PhoneController.lnk"; Remove-Item -Force -Recurse -ErrorAction SilentlyContinue 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\PhoneController'`);
      // Delete the app folder a moment after we exit (a running program can't delete itself).
      // Verbatim arguments: Node would otherwise escape the inner quotes as \" which cmd.exe doesn't understand.
      spawn('cmd.exe', ['/d', '/s', '/c', `"ping 127.0.0.1 -n 4 > nul & rmdir /s /q "${PORTABLE}""`], {
        detached: true, stdio: 'ignore', windowsHide: true, windowsVerbatimArguments: true, cwd: path.dirname(PORTABLE),
      }).unref();
      done.push('app folder will be deleted');
    } else done.push('dev checkout kept (only the portable app folder is ever deleted)');
  }
  return done;
}

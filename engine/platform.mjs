/** Detect OS-specific capabilities and persist them for the rest of askui. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const DATA = path.join(os.homedir(), '.local/share/askui');
export const PLATFORM_FILE = path.join(DATA, 'platform.json');

const has = (cmd) => {
  const probe = process.platform === 'win32' ? `where ${cmd}` : `command -v ${cmd}`;
  return spawnSync(process.platform === 'win32' ? 'cmd' : 'sh', [process.platform === 'win32' ? '/c' : '-lc', probe], { stdio: 'ignore' }).status === 0;
};

export function detect() {
  const plat = process.platform;
  let notifier = 'stderr';
  if (plat === 'darwin') notifier = 'osascript';
  else if (plat === 'win32') notifier = has('powershell') ? 'powershell' : 'stderr';
  else if (has('notify-send')) notifier = 'notify-send';
  else if (has('dunstify')) notifier = 'dunstify';
  else if (has('gdbus')) notifier = 'gdbus';

  let browser = 'none';
  if (has('zbr')) browser = 'zbr';
  else if (plat === 'darwin') browser = 'open';
  else if (plat === 'win32') browser = 'start';
  else if (has('xdg-open')) browser = 'xdg-open';

  return {
    os: plat,
    arch: process.arch,
    node: process.version,
    shell: process.env.SHELL || (plat === 'win32' ? 'cmd.exe' : '/bin/sh'),
    notifier,
    browser,
    hasDisplay: !!(process.env.DISPLAY || process.env.WAYLAND_DISPLAY) || plat === 'darwin' || plat === 'win32',
    dbus: fs.existsSync(`/run/user/${process.getuid?.() || 1000}/bus`) ? `unix:path=/run/user/${process.getuid?.() || 1000}/bus` : null,
    dataDir: DATA,
    initializedAt: Date.now(),
  };
}

export function readPlatform() {
  try { return JSON.parse(fs.readFileSync(PLATFORM_FILE, 'utf8')); } catch { return null; }
}

export function ensurePlatform({ force = false } = {}) {
  fs.mkdirSync(DATA, { recursive: true });
  const cur = readPlatform();
  const fresh = detect();
  if (!force && cur && cur.os === fresh.os && cur.arch === fresh.arch && cur.browser === fresh.browser && cur.notifier === fresh.notifier) {
    return { ...cur, changed: false };
  }
  fs.writeFileSync(PLATFORM_FILE, JSON.stringify(fresh, null, 1));
  return { ...fresh, changed: true };
}

/** Detect the best available desktop notification channel and send messages. */
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import { readPlatform } from './platform.mjs';

const has = (cmd) => spawnSync('sh', ['-lc', `command -v ${cmd}`], { stdio: 'ignore' }).status === 0;
let cached = null;

function sessionEnv() {
  const env = { ...process.env };
  const uid = process.getuid ? process.getuid() : 1000;
  if (!env.DBUS_SESSION_BUS_ADDRESS) {
    const bus = `/run/user/${uid}/bus`;
    if (fs.existsSync(bus)) env.DBUS_SESSION_BUS_ADDRESS = `unix:path=${bus}`;
  }
  if (!env.DISPLAY && !env.WAYLAND_DISPLAY) {
    if (fs.existsSync('/tmp/.X11-unix/X0')) env.DISPLAY = ':0';
    const wd = `/run/user/${uid}/wayland-1`;
    if (fs.existsSync(wd)) env.WAYLAND_DISPLAY = 'wayland-1';
  }
  return env;
}

export function detectChannels() {
  if (cached) return cached;
  const channels = [];
  if (has('notify-send')) channels.push('notify-send');
  if (has('dunstify')) channels.push('dunstify');
  if (has('gdbus')) channels.push('gdbus');
  if (process.env.ASKUI_NTFY_URL) channels.push('ntfy');
  if (has('paplay')) channels.push('sound');
  const plat = readPlatform();
  if (plat?.notifier && plat.notifier !== 'stderr') channels.unshift(plat.notifier);
  cached = {
    channels,
    selected: channels[0] || 'stderr',
    hasDisplay: !!(sessionEnv().DISPLAY || sessionEnv().WAYLAND_DISPLAY),
  };
  return cached;
}

function urgency(level) {
  if (level === 'error') return 'critical';
  if (level === 'warn') return 'normal';
  return 'low';
}

export async function notify({ title = 'askui', body = '', level = 'info' } = {}) {
  const d = detectChannels();
  const t = String(title).slice(0, 120);
  const b = String(body).slice(0, 500);
  try {
    if (d.selected === 'osascript') {
      spawnSync('osascript', ['-e', `display notification ${JSON.stringify(b)} with title ${JSON.stringify(t)}`], { stdio: 'ignore' });
      return { ok: true, channel: 'osascript' };
    }
    if (d.selected === 'powershell') {
      spawnSync('powershell', ['-NoProfile', '-Command',
        `[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null; Write-Output ${JSON.stringify(t + ': ' + b)}`], { stdio: 'ignore' });
      return { ok: true, channel: 'powershell' };
    }
    if (d.selected === 'notify-send') {
      spawnSync('notify-send', ['-a', 'askui', '-u', urgency(level), t, b], { stdio: 'ignore', env: sessionEnv() });
      return { ok: true, channel: 'notify-send' };
    }
    if (d.selected === 'dunstify') {
      spawnSync('dunstify', ['-a', 'askui', '-u', String(level === 'error' ? 2 : 1), t, b], { stdio: 'ignore', env: sessionEnv() });
      return { ok: true, channel: 'dunstify' };
    }
    if (d.selected === 'gdbus') {
      spawnSync('gdbus', ['call', '--session', '--dest', 'org.freedesktop.Notifications',
        '--object-path', '/org/freedesktop/Notifications',
        '--method', 'org.freedesktop.Notifications.Notify',
        'askui', '0', '', t, b, '[]', '{}', '5000'], { stdio: 'ignore', env: sessionEnv() });
      return { ok: true, channel: 'gdbus' };
    }
    if (d.selected === 'ntfy') {
      const url = process.env.ASKUI_NTFY_URL;
      await fetch(url, { method: 'POST', body: `${t}\n${b}`, headers: { Title: encodeURIComponent(t) } });
      return { ok: true, channel: 'ntfy' };
    }
  } catch (e) {
    return { ok: false, channel: d.selected, error: String(e.message) };
  }
  process.stderr.write(`[notify] ${t}: ${b}\n`);
  return { ok: true, channel: 'stderr' };
}

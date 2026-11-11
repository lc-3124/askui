/** Thin wrapper over zbr for opening and closing pages. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { readPlatform } from './platform.mjs';

const REG = path.join(os.homedir(), '.local/share/askui/pages.json');
function readReg() { try { return JSON.parse(fs.readFileSync(REG, 'utf8')); } catch { return []; } }
function writeReg(list) { try { fs.mkdirSync(path.dirname(REG), { recursive: true }); fs.writeFileSync(REG, JSON.stringify([...new Set(list)])); } catch {} }

const run = (args) => {
  const r = spawnSync('zbr', args, { encoding: 'utf8', timeout: 30000 });
  let json = null;
  try { json = JSON.parse(r.stdout || '{}'); } catch {}
  return { code: r.status, json, err: (r.stderr || '').slice(0, 300) };
};

export function available() {
  const r = spawnSync('sh', ['-lc', 'command -v zbr'], { stdio: 'ignore' });
  return r.status === 0;
}

/** Close every AI-owned page (askui sessions + registered tabs), except keep. */
export function closeAll({ keep = [] } = {}) {
  if (!available()) return { ok: false, error: 'zbr not found', closed: [] };
  const reg = readReg();
  const tabs = listTabs();
  const isMine = (t) => (t.url || '').includes('127.0.0.1:9410/s/') || reg.includes(t.url);
  const hits = tabs.filter((t) => isMine(t) && !keep.includes(t.url)).sort((a, b) => b.index - a.index);
  const closed = [];
  for (const t of hits) {
    const r = run(['close', String(t.index)]);
    if (r.json?.ok) closed.push(t.url);
  }
  writeReg(keep);
  return { ok: true, closed };
}

/**
 * Open a page exclusively: every previous AI page is closed first, so at most
 * one AI-created page exists at any time.
 */
export function openPage(url, { exclusive = true } = {}) {
  if (!available()) {
    // OS-specific fallback: open the page with the system browser.
    const plat = readPlatform();
    const cmd = plat?.browser || (process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open');
    if (cmd === 'none') return { ok: false, error: 'no browser opener; open manually: ' + url };
    const r = process.platform === 'win32'
      ? spawnSync('cmd', ['/c', 'start', '', url], { stdio: 'ignore' })
      : spawnSync(cmd, [url], { stdio: 'ignore' });
    return { ok: r.status === 0, external: true, opener: cmd, url };
  }
  let closed = [];
  if (exclusive) {
    closed = closeAll({ keep: [url] }).closed || [];
    const existing = listTabs().find((t) => (t.url || '') === url);
    if (existing) {
      run(['tab', String(existing.index)]);
      writeReg([url]);
      return { ok: true, reused: true, closed, url };
    }
  }
  const r = run(['new', url]);
  if (r.json?.ok) writeReg([url]);
  return r.json?.ok ? { ok: true, closed, ...r.json } : { ok: false, error: r.json?.error || r.err };
}

export function listTabs() {
  if (!available()) return [];
  const r = run(['tabs']);
  return r.json?.tabs || [];
}

export function closeByUrl(fragment, { keep = [] } = {}) {
  if (!fragment) return { ok: false, error: 'missing url fragment' };
  const tabs = listTabs();
  const hits = tabs.filter((t) => (t.url || '').includes(fragment) && !keep.some((k) => (t.url || '').includes(k)));
  const closed = [];
  for (const t of hits.reverse()) {
    const r = run(['close', String(t.index)]);
    if (r.json?.ok) closed.push(t.url);
  }
  return { ok: true, closed };
}

export function closeSensitive(patterns = []) {
  const tabs = listTabs();
  const hits = tabs.filter((t) => patterns.some((p) => (t.url || '').includes(p) || (t.title || '').includes(p)));
  const closed = [];
  for (const t of hits.reverse()) {
    const r = run(['close', String(t.index)]);
    if (r.json?.ok) closed.push(t.title || t.url);
  }
  return { ok: true, closed };
}

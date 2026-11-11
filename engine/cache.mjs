import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { getFlow } from './flow.mjs';

const SKILL = path.join(os.homedir(), '.dsh/skills/askui');
const CACHE = path.join(SKILL, 'cache');
const INDEX = path.join(CACHE, 'index.json');

function ensure() { fs.mkdirSync(CACHE, { recursive: true }); }
function readIndex() {
  ensure();
  try { return JSON.parse(fs.readFileSync(INDEX, 'utf8')); } catch { return { updatedAt: 0, items: [] }; }
}
function writeIndex(idx) {
  idx.updatedAt = Date.now();
  fs.writeFileSync(INDEX + '.tmp', JSON.stringify(idx, null, 1));
  fs.renameSync(INDEX + '.tmp', INDEX);
}
const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5-]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'app';

export function saveToCache(flowRef, { tags = [] } = {}) {
  const flow = getFlow(flowRef);
  if (!flow) throw new Error('flow not found: ' + flowRef);
  ensure();
  const name = slug(flow.name);
  const dir = path.join(CACHE, name);
  fs.mkdirSync(path.join(dir, 'specs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'flow.json'), JSON.stringify(flow, null, 1));
  for (const s of flow.steps) {
    if (s.ui) fs.writeFileSync(path.join(dir, 'specs', `${s.key}.json`), JSON.stringify(s.ui, null, 1));
  }
  const idx = readIndex();
  const prev = idx.items.find((x) => x.name === name);
  const meta = {
    name,
    title: flow.plan?.title || flow.goal || flow.name,
    goal: flow.goal,
    tags: [...new Set([...(prev?.tags || []), ...tags, ...(flow.tags || [])])],
    version: flow.version,
    steps: flow.steps.map((s) => ({ key: s.key, kind: s.kind, ui: !!s.ui, next: s.next })),
    uses: prev?.uses || 0,
    savedAt: Date.now(),
    source: flow.id,
  };
  fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 1));
  idx.items = idx.items.filter((x) => x.name !== name).concat(meta).sort((a, b) => b.savedAt - a.savedAt);
  writeIndex(idx);
  return { ok: true, name, dir, meta };
}

export function listCache() {
  return readIndex().items;
}

export function searchCache(q) {
  const s = String(q || '').toLowerCase();
  return listCache().filter((m) =>
    !s || m.name.includes(s) || (m.title || '').toLowerCase().includes(s) ||
    (m.goal || '').toLowerCase().includes(s) || (m.tags || []).some((t) => t.toLowerCase().includes(s))
  );
}

export function showCache(name) {
  const dir = path.join(CACHE, slug(name));
  if (!fs.existsSync(path.join(dir, 'meta.json'))) return null;
  return {
    meta: JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf8')),
    flow: JSON.parse(fs.readFileSync(path.join(dir, 'flow.json'), 'utf8')),
    dir,
  };
}

export function bumpCache(name) {
  const idx = readIndex();
  const it = idx.items.find((x) => x.name === slug(name));
  if (!it) return null;
  it.uses += 1; it.lastUsedAt = Date.now();
  writeIndex(idx);
  return it;
}

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const DATA = path.join(os.homedir(), '.local/share/askui');
fs.mkdirSync(DATA, { recursive: true });
export const DB_PATH = path.join(DATA, 'askui.db');
export const db = new DatabaseSync(DB_PATH);

db.exec(`
PRAGMA journal_mode=WAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS flows(
  id TEXT PRIMARY KEY, name TEXT NOT NULL, version INTEGER NOT NULL,
  goal TEXT, tags TEXT, status TEXT DEFAULT 'active',
  context_refs TEXT, plan_json TEXT, created_at INTEGER, updated_at INTEGER,
  UNIQUE(name, version)
);
CREATE TABLE IF NOT EXISTS steps(
  flow_id TEXT NOT NULL, key TEXT NOT NULL, seq INTEGER NOT NULL,
  goal TEXT, kind TEXT NOT NULL, interface TEXT,
  ui_json TEXT, input_schema TEXT, output_schema TEXT, tools TEXT, next_json TEXT,
  PRIMARY KEY(flow_id, key),
  FOREIGN KEY(flow_id) REFERENCES flows(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS interfaces(
  name TEXT PRIMARY KEY, spec_json TEXT, answer_schema TEXT,
  version INTEGER DEFAULT 1, uses INTEGER DEFAULT 0, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS runs(
  id TEXT PRIMARY KEY, flow_id TEXT NOT NULL, flow_version INTEGER,
  status TEXT NOT NULL, current_step TEXT, context_json TEXT,
  created_at INTEGER, updated_at INTEGER,
  FOREIGN KEY(flow_id) REFERENCES flows(id)
);
CREATE TABLE IF NOT EXISTS step_runs(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT NOT NULL,
  session_id TEXT, status TEXT NOT NULL, input_json TEXT, output_json TEXT,
  started_at INTEGER, ended_at INTEGER,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS artifacts(
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL, step_key TEXT,
  name TEXT NOT NULL, format TEXT DEFAULT 'json', schema_json TEXT,
  value_json TEXT, created_at INTEGER,
  FOREIGN KEY(run_id) REFERENCES runs(id) ON DELETE CASCADE
);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER, run_id TEXT,
  type TEXT, data_json TEXT
);
`);

export const now = () => Date.now();
export const uid = (n = 6) => {
  const c = globalThis.crypto;
  return Array.from(c.getRandomValues(new Uint8Array(n))).map((b) => b.toString(16).padStart(2, '0')).join('');
};

export function log(runId, type, data = {}) {
  db.prepare('INSERT INTO events(at,run_id,type,data_json) VALUES(?,?,?,?)')
    .run(now(), runId || null, type, JSON.stringify(data));
}

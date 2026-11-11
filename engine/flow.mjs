import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { db, now, uid, log } from './db.mjs';

const ASK = `http://127.0.0.1:${process.env.ASKUI_PORT || 9410}`;
const STORE = path.join(os.homedir(), '.local/share/askui/store');

const j = (s, d = null) => { try { return s ? JSON.parse(s) : d; } catch { return d; } };
const J = (v) => JSON.stringify(v ?? null);

export function validateFlow(flow) {
  const errors = [];
  if (!flow.name) errors.push('missing name');
  if (!Array.isArray(flow.steps) || !flow.steps.length) errors.push('steps must be a non-empty array');
  const keys = new Set();
  for (const s of flow.steps || []) {
    if (!s.key) errors.push('step missing key');
    if (keys.has(s.key)) errors.push(`duplicate step key: ${s.key}`);
    keys.add(s.key);
    if (!['input', 'compute', 'final'].includes(s.kind || 'input')) errors.push(`step ${s.key}: kind must be input|compute|final`);
    if (['input', 'final'].includes(s.kind || 'input') && !s.ui && !s.interface) errors.push(`step ${s.key}: UI step needs ui or interface`);
  }
  for (const s of flow.steps || []) {
    const n = s.next;
    if (n == null) continue;
    if (typeof n === 'string' && !keys.has(n)) errors.push(`step ${s.key}: next "${n}" not found`);
    if (typeof n === 'object' && Array.isArray(n.when)) {
      for (const w of n.when) if (w.goto && !keys.has(w.goto)) errors.push(`step ${s.key}: goto "${w.goto}" not found`);
    }
  }
  return { ok: errors.length === 0, errors };
}

export function saveFlow(flow, { version } = {}) {
  const v = validateFlow(flow);
  if (!v.ok) throw new Error('invalid flow: ' + v.errors.join('; '));
  const max = db.prepare('SELECT MAX(version) v FROM flows WHERE name=?').get(flow.name)?.v || 0;
  const ver = Number(version || flow.version || max + 1);
  const id = `${flow.name}@${ver}`;
  const t = now();

  db.exec('BEGIN');
  try {
    db.prepare(`INSERT INTO flows(id,name,version,goal,tags,status,context_refs,plan_json,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      id, flow.name, ver, flow.goal || '', J(flow.tags || []), flow.status || 'active',
      J(flow.contextRefs || []), J(flow), t, t
    );
    flow.steps.forEach((s, i) => {
      db.prepare(`INSERT INTO steps(flow_id,key,seq,goal,kind,interface,ui_json,input_schema,output_schema,tools,next_json)
        VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        id, s.key, i, s.goal || '', s.kind || 'input', s.interface || null,
        s.ui ? J(s.ui) : null, s.input ? J(s.input) : null, s.output ? J(s.output) : null,
        J(s.tools || []), J(s.next ?? null)
      );
      if (s.interface && s.ui) {
        db.prepare(`INSERT INTO interfaces(name,spec_json,answer_schema,version,uses,updated_at)
          VALUES(?,?,?,1,0,?)
          ON CONFLICT(name) DO UPDATE SET spec_json=excluded.spec_json, answer_schema=excluded.answer_schema,
          version=interfaces.version+1, updated_at=excluded.updated_at`).run(s.interface, J(s.ui), J(s.output || null), t);
      }
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  return getFlow(id);
}

export function listFlows() {
  return db.prepare(`SELECT f.id,f.name,f.version,f.goal,f.tags,f.status,f.updated_at,
    (SELECT COUNT(*) FROM steps s WHERE s.flow_id=f.id) step_count
    FROM flows f ORDER BY f.updated_at DESC`).all().map((r) => ({ ...r, tags: j(r.tags, []) }));
}

export function searchFlows(q) {
  const like = `%${q}%`;
  return db.prepare(`SELECT id,name,version,goal,tags FROM flows
    WHERE name LIKE ? OR goal LIKE ? OR tags LIKE ? ORDER BY updated_at DESC LIMIT 20`)
    .all(like, like, like).map((r) => ({ ...r, tags: j(r.tags, []) }));
}

export function getFlow(idOrName) {
  let row;
  if (String(idOrName).includes('@')) row = db.prepare('SELECT * FROM flows WHERE id=?').get(idOrName);
  else row = db.prepare('SELECT * FROM flows WHERE name=? ORDER BY version DESC LIMIT 1').get(idOrName);
  if (!row) return null;
  const steps = db.prepare('SELECT * FROM steps WHERE flow_id=? ORDER BY seq').all(row.id);
  return {
    id: row.id, name: row.name, version: row.version, goal: row.goal,
    tags: j(row.tags, []), status: row.status, contextRefs: j(row.context_refs, []),
    plan: j(row.plan_json, {}),
    steps: steps.map((s) => ({
      key: s.key, seq: s.seq, goal: s.goal, kind: s.kind, interface: s.interface,
      ui: j(s.ui_json), input: j(s.input_schema), output: j(s.output_schema),
      tools: j(s.tools, []), next: j(s.next_json),
    })),
  };
}

/* ---------------- runs ---------------- */

function sessionKey(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(STORE, `${sid}.json`), 'utf8')).adminKey; } catch { return null; }
}

async function createSession({ spec, schema, brief, flow }) {
  const r = await fetch(`${ASK}/api/session`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ spec, answerSchema: schema || null, taskBrief: brief, contextRefs: flow.contextRefs || [], tools: spec.tools || [] }),
  });
  const d = await r.json();
  if (!d.ok) throw new Error('session create failed: ' + (d.error || r.status));
  return d;
}

function resolveSpec(step) {
  if (step.ui) return step.ui;
  if (step.interface) {
    const it = db.prepare('SELECT spec_json FROM interfaces WHERE name=?').get(step.interface);
    if (it) return j(it.spec_json);
  }
  throw new Error(`step ${step.key}: no ui spec`);
}

export function getRun(id) {
  const r = db.prepare('SELECT * FROM runs WHERE id=?').get(id);
  if (!r) return null;
  const steps = db.prepare('SELECT * FROM step_runs WHERE run_id=? ORDER BY started_at').all(id);
  const arts = db.prepare('SELECT id,step_key,name,format,schema_json,value_json,created_at FROM artifacts WHERE run_id=? ORDER BY created_at').all(id);
  return {
    id: r.id, flowId: r.flow_id, status: r.status, currentStep: r.current_step,
    context: j(r.context_json, {}), createdAt: r.created_at,
    steps: steps.map((s) => ({
      step: s.step_key, status: s.status, sessionId: s.session_id,
      output: j(s.output_json), startedAt: s.started_at, endedAt: s.ended_at,
    })),
    artifacts: arts.map((a) => ({ id: a.id, step: a.step_key, name: a.name, format: a.format, schema: j(a.schema_json), value: j(a.value_json) })),
  };
}

export async function startRun(flowRef, context = {}) {
  const flow = getFlow(flowRef);
  if (!flow) throw new Error('flow not found: ' + flowRef);
  const id = uid(6);
  const t = now();
  db.prepare('INSERT INTO runs(id,flow_id,flow_version,status,current_step,context_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(id, flow.id, flow.version, 'created', null, J(context), t, t);
  log(id, 'run_started', { flow: flow.id });
  return advanceRun(id);
}

export async function startStep(run, flow, step) {
  const t = now();
  const brief = `${flow.goal}${step.goal ? ' / ' + step.goal : ''}`;
  let session = null;
  if (step.kind === 'final') {
    session = await createSession({ spec: resolveSpec(step), schema: step.output, brief, flow });
    db.prepare('INSERT INTO step_runs(id,run_id,step_key,session_id,status,started_at,ended_at) VALUES(?,?,?,?,?,?,?)')
      .run(uid(6), run.id, step.key, session.id, 'done', t, t);
    db.prepare('UPDATE runs SET status=?,current_step=?,updated_at=? WHERE id=?').run('done', step.key, t, run.id);
    log(run.id, 'final_rendered', { step: step.key, session: session.id });
    return { run: getRun(run.id), session };
  }
  if ((step.kind || 'input') === 'input') {
    session = await createSession({ spec: resolveSpec(step), schema: step.output, brief, flow });
    db.prepare('INSERT INTO step_runs(id,run_id,step_key,session_id,status,started_at) VALUES(?,?,?,?,?,?)')
      .run(uid(6), run.id, step.key, session.id, 'waiting', t);
    db.prepare('UPDATE runs SET status=?,current_step=?,updated_at=? WHERE id=?').run('waiting', step.key, t, run.id);
    log(run.id, 'step_started', { step: step.key, session: session.id });
  } else {
    db.prepare('INSERT INTO step_runs(id,run_id,step_key,status,started_at) VALUES(?,?,?,?,?)')
      .run(uid(6), run.id, step.key, 'ready', t);
    db.prepare('UPDATE runs SET status=?,current_step=?,updated_at=? WHERE id=?').run('ready', step.key, t, run.id);
    log(run.id, 'step_ready', { step: step.key });
  }
  return { run: getRun(run.id), session };
}

export async function recordAnswer(runId, timeout = 600000) {
  const run = getRun(runId);
  if (!run) throw new Error('run not found');
  const cur = db.prepare('SELECT * FROM step_runs WHERE run_id=? ORDER BY started_at DESC LIMIT 1').get(runId);
  if (!cur || !cur.session_id) throw new Error('current step has no session');
  const key = sessionKey(cur.session_id);
  if (!key) throw new Error('session key missing');
  let d = null;
  const deadline = Date.now() + Number(timeout);
  while (Date.now() < deadline) {
    const chunk = Math.min(60000, deadline - Date.now());
    const r = await fetch(`${ASK}/api/wait/${cur.session_id}?timeout=${chunk}`, {
      headers: { 'x-askui-key': key },
      signal: AbortSignal.timeout(chunk + 5000),
    });
    if (r.status === 204) continue;
    d = await r.json();
    break;
  }
  if (!d) return { pending: true, sessionId: cur.session_id };
  if (!d.ok) throw new Error(d.error || 'wait failed');

  const flow = getFlow(run.flowId);
  const step = flow.steps.find((s) => s.key === cur.step_key);
  const props = step?.output?.properties || {};
  const vals = d.values || {};
  for (const [k, v] of Object.entries(vals)) {
    db.prepare('INSERT INTO artifacts(id,run_id,step_key,name,format,schema_json,value_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
      .run(uid(6), runId, cur.step_key, k, 'json', J(props[k] || null), J(v), now());
  }
  db.prepare('UPDATE step_runs SET status=?,output_json=?,ended_at=? WHERE id=?').run('answered', J(vals), now(), cur.id);
  db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run('answered', now(), runId);
  log(runId, 'step_answered', { step: cur.step_key, keys: Object.keys(vals) });

  // Auto-advance: input -> next input creates the next session; next compute
  // is marked ready for the model to fill with artifacts.
  const nextKey = step ? step.next : null;
  if (!nextKey) {
    db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run('done', now(), runId);
    return { ok: true, values: vals, sessionId: cur.session_id, step: cur.step_key, done: true };
  }
  const next = flow.steps.find((s) => s.key === nextKey);
  if (!next) throw new Error('next step not found: ' + nextKey);
  if ((next.kind || 'input') === 'input') {
    const r = await startStep(getRun(runId), flow, next);
    return { ok: true, values: vals, step: cur.step_key, nextStep: next.key, run: r.run, session: r.session };
  }
  db.prepare('INSERT INTO step_runs(id,run_id,step_key,status,started_at) VALUES(?,?,?,?,?)')
    .run(uid(6), runId, next.key, 'ready', now());
  db.prepare('UPDATE runs SET status=?,current_step=?,updated_at=? WHERE id=?').run('ready', next.key, now(), runId);
  log(runId, 'step_ready', { step: next.key });
  return { ok: true, values: vals, step: cur.step_key, nextStep: next.key, status: 'ready' };
}

export async function advanceRun(runId, artifactValues = {}) {
  const run = getRun(runId);
  if (!run) throw new Error('run not found');
  const flow = getFlow(run.flowId);

  // store artifacts supplied by the model for the current compute step
  if (run.currentStep && Object.keys(artifactValues).length) {
    for (const [k, v] of Object.entries(artifactValues)) {
      db.prepare('INSERT INTO artifacts(id,run_id,step_key,name,format,schema_json,value_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
        .run(uid(6), runId, run.currentStep, k, 'json', null, J(v), now());
    }
    db.prepare('UPDATE step_runs SET status=?,output_json=?,ended_at=? WHERE run_id=? AND step_key=?')
      .run('done', J(artifactValues), now(), runId, run.currentStep);
    log(runId, 'step_computed', { step: run.currentStep, keys: Object.keys(artifactValues) });
  }

  const cur = run.currentStep;
  const step = flow.steps.find((s) => s.key === cur);
  const nextKey = step ? step.next : flow.steps[0].key;
  if (!nextKey) {
    db.prepare('UPDATE runs SET status=?,updated_at=? WHERE id=?').run('done', now(), runId);
    log(runId, 'run_done');
    return { run: getRun(runId), session: null };
  }
  const next = flow.steps.find((s) => s.key === nextKey);
  if (!next) throw new Error('next step not found: ' + nextKey);
  return startStep(run, flow, next);
}

export function putArtifact(runId, name, value, { format = 'json', step = null } = {}) {
  db.prepare('INSERT INTO artifacts(id,run_id,step_key,name,format,schema_json,value_json,created_at) VALUES(?,?,?,?,?,?,?,?)')
    .run(uid(6), runId, step, name, format, null, J(value), now());
  log(runId, 'artifact_put', { name });
}

export function searchArtifacts(q) {
  const like = `%${q}%`;
  return db.prepare('SELECT * FROM artifacts WHERE name LIKE ? OR value_json LIKE ? ORDER BY created_at DESC LIMIT 30')
    .all(like, like).map((a) => ({ ...a, value_json: j(a.value_json) }));
}

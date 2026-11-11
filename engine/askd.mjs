#!/usr/bin/env node
/**
 * askd v0.1 — interaction engine for AI-generated UI.
 *
 * Session lifecycle:
 *   waiting -> answered -> generating -> done
 *                    \-> cancelled / expired
 *
 * The page only collects input. The agent owns result generation and pushes a
 * new page; the page reloads itself. Every state change is persisted and logged.
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { renderPage, isInteractiveSpec } from './render.mjs';
import { validate } from './validate.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOME = os.homedir();
const DATA = path.join(HOME, '.local/share/askui');
const STORE = path.join(DATA, 'store');
const PORT = Number(process.env.ASKUI_PORT || 9410);
const HOST = '127.0.0.1';
const TTL = Number(process.env.ASKUI_TTL || 2 * 60 * 60 * 1000);
const KEEP = 24 * 60 * 60 * 1000;

fs.mkdirSync(STORE, { recursive: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const rid = (n) => crypto.randomBytes(n).toString('hex');
const json = (res, code, obj) => {
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(JSON.stringify(obj));
};
const readBody = (req) => new Promise((resolve, reject) => {
  let raw = '';
  req.on('data', (c) => { raw += c; if (raw.length > 2e6) reject(new Error('body too large')); });
  req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch (e) { reject(new Error('bad json')); } });
  req.on('error', reject);
});

function fileOf(id) { return path.join(STORE, `${id}.json`); }
function load(id) {
  try { return JSON.parse(fs.readFileSync(fileOf(id), 'utf8')); } catch { return null; }
}
function save(s) {
  s.touchedAt = Date.now();
  const tmp = fileOf(s.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(s));
  fs.renameSync(tmp, fileOf(s.id));
}
function logEvent(s, type, data = {}) {
  s.events.push({ at: Date.now(), type, ...data });
  if (s.events.length > 200) s.events = s.events.slice(-200);
}
function publicState(s, since = 0) {
  return {
    ok: true, id: s.id, state: s.state, version: s.version,
    progress: s.progress, thoughts: s.thoughts || [], stream: (s.stream || []).filter((e) => e.seq > since), seq: s.seq || 0, reports: s.reports || [], reportSeq: s.reportSeq || 0, answered: !!s.answer, delivered: !!s.delivered, answeredAt: s.answeredAt || null, createdAt: s.createdAt,
    interactive: s.spec ? isInteractiveSpec(s.spec) : false, final: s.state === 'done',
  };
}
function auth(req, s) { return req.headers['x-askui-key'] === s.adminKey; }

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, `http://${HOST}:${PORT}`);
  try {
    if (u.pathname === '/health') {
      return json(res, 200, { ok: true, pid: process.pid, sessions: fs.readdirSync(STORE).filter((f) => f.endsWith('.json')).length });
    }

    /* ---- create ---- */
    if (req.method === 'POST' && u.pathname === '/api/session') {
      const body = await readBody(req);
      if (!body.spec && !body.html) return json(res, 400, { ok: false, error: 'need spec or html' });
      const id = rid(6), token = rid(12), adminKey = rid(16);
      const s = {
        id, token, adminKey, createdAt: Date.now(), touchedAt: Date.now(),
        state: body.spec && body.spec.final ? 'done' : 'waiting', taskBrief: body.taskBrief || '', contextRefs: body.contextRefs || [],
        tools: body.tools || [], spec: body.spec || null, answerSchema: body.answerSchema || null,
        html: '', version: 1, answer: null, answerKey: null, delivered: false, answeredAt: null, progress: [], thoughts: [], stream: [], seq: 0, reports: [], reportSeq: 0, events: [],
      };
      s.html = body.html
        ? String(body.html).replaceAll('__SESSION__', id).replaceAll('__TOKEN__', token)
        : renderPage(body.spec, { sessionId: id, token, version: 1 });
      logEvent(s, 'created', { taskBrief: s.taskBrief });
      save(s);
      return json(res, 200, { ok: true, id, token, adminKey, url: `http://${HOST}:${PORT}/s/${id}`, path: `/s/${id}` });
    }

    /* ---- serve page ---- */
    const mPage = u.pathname.match(/^\/s\/([a-f0-9]+)$/);
    if (req.method === 'GET' && mPage) {
      const s = load(mPage[1]);
      if (!s) { res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' }); return res.end('session not found'); }
      s.touchedAt = Date.now(); save(s);
      logEvent(s, 'viewed', { ua: String(req.headers['user-agent'] || '').slice(0, 120) });
      save(s);
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(s.html);
    }

    /* ---- page polls state ---- */
    const mState = u.pathname.match(/^\/api\/state\/([a-f0-9]+)$/);
    if (req.method === 'GET' && mState) {
      const s = load(mState[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      return json(res, 200, publicState(s, Number(u.searchParams.get('since') || 0)));
    }

    /* ---- answer ---- */
    const mAns = u.pathname.match(/^\/api\/answer\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mAns) {
      const s = load(mAns[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      const body = await readBody(req);
      if (body.token !== s.token) return json(res, 403, { ok: false, error: 'bad token' });
      if (s.state === 'cancelled' || s.state === 'expired') return json(res, 409, { ok: false, error: `session ${s.state}` });
      if (s.answer && body.idempotencyKey !== s.answerKey) return json(res, 409, { ok: false, error: 'already answered', version: s.version });
      if (s.answer) return json(res, 200, { ok: true, duplicate: true });
      if (s.answerSchema) {
        const v = validate(s.answerSchema, body.values);
        if (!v.ok) {
          logEvent(s, 'answer_rejected', { errors: v.errors });
          save(s);
          return json(res, 422, { ok: false, error: 'invalid answer', errors: v.errors });
        }
      }
      s.answer = body.values;
      s.answerKey = body.idempotencyKey || rid(8);
      s.state = 'answered';
      s.answeredAt = Date.now();
      s.progress = s.progress || [];
      s.progress.push({ at: Date.now(), step: 'AI 已接手', detail: '正在解析你的输入', tone: 'ok' });
      logEvent(s, 'answered', { keys: body.values && typeof body.values === 'object' ? Object.keys(body.values) : [] });
      save(s);
      return json(res, 200, { ok: true });
    }

    /* ---- agent endpoints ---- */
    const mWait = u.pathname.match(/^\/api\/wait\/([a-f0-9]+)$/);
    if (req.method === 'GET' && mWait) {
      const s = load(mWait[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      const timeout = Math.min(Number(u.searchParams.get('timeout') || 60000), 600000);
      const t0 = Date.now();
      while (Date.now() - t0 < timeout) {
        const cur = load(s.id);
        if (cur && cur.answer) {
          return json(res, 200, {
            ok: true, id: cur.id, values: cur.answer, taskBrief: cur.taskBrief,
            contextRefs: cur.contextRefs, tools: cur.tools, version: cur.version,
            answeredAt: cur.events.filter((e) => e.type === 'answered').pop()?.at,
          });
        }
        await sleep(250);
      }
      return json(res, 204, { ok: false, pending: true, id: s.id });
    }

    const mPush = u.pathname.match(/^\/api\/push\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mPush) {
      const s = load(mPush[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      const body = await readBody(req);
      if (!body.spec && !body.html) return json(res, 400, { ok: false, error: 'need spec or html' });
      if (body.spec && body.final !== false && isInteractiveSpec(body.spec)) {
        return json(res, 400, { ok: false, error: 'final page must be non-interactive: remove cards/fields/confirm or push with final:false' });
      }
      if (body.ifVersion != null && Number(body.ifVersion) !== s.version) {
        return json(res, 409, { ok: false, error: 'version conflict', version: s.version });
      }
      s.html = body.html || renderPage(body.spec, { sessionId: s.id, token: s.token, version: s.version + 1 });
      s.version += 1;
      s.state = body.final === false ? 'generating' : 'done';
      if (body.final !== false) s.delivered = true;
      if (body.spec) s.spec = body.spec;
      logEvent(s, 'pushed', { version: s.version, final: body.final !== false });
      save(s);
      return json(res, 200, { ok: true, version: s.version, state: s.state });
    }

    const mNext = u.pathname.match(/^\/api\/next\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mNext) {
      const s = load(mNext[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      const body = await readBody(req);
      if (body.token !== s.token) return json(res, 403, { ok: false, error: 'bad token' });
      if (s.nextUrl) return json(res, 200, { ok: true, url: s.nextUrl, reused: true });
      try {
        const bin = process.env.ASKUI_BIN || path.join(os.homedir(), '.local/bin/askui');
        const cmd = process.env.ASKUI_NEXT_CMD || `${bin} run start immersive-intake`;
        const out = await new Promise((resolve, reject) => {
          const child = spawn('sh', ['-lc', cmd], { env: process.env });
          let buf = '', err = '';
          const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} reject(new Error('next command timeout')); }, 20000);
          child.stdout.on('data', (d) => (buf += d));
          child.stderr.on('data', (d) => (err += d));
          child.on('error', (e) => { clearTimeout(timer); reject(e); });
          child.on('close', (code) => {
            clearTimeout(timer);
            if (code !== 0) return reject(new Error(`next command exited ${code}: ${err.slice(0, 200)}`));
            try { resolve(JSON.parse(buf)); } catch { reject(new Error('next command returned non-JSON')); }
          });
        });
        const url = out?.session?.url;
        if (!url) throw new Error('next command produced no session url');
        s.nextUrl = url;
        s.nextAt = Date.now();
        logEvent(s, 'next_started', { url });
        save(s);
        return json(res, 200, { ok: true, url });
      } catch (e) {
        return json(res, 500, { ok: false, error: String(e.message || e) });
      }
    }

    const mReport = u.pathname.match(/^\/api\/report\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mReport) {
      const s = load(mReport[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      const body = await readBody(req);
      const action = String(body.action || '').slice(0, 500);
      if (!action) return json(res, 400, { ok: false, error: 'missing action' });
      s.reports = s.reports || [];
      s.reportSeq = (s.reportSeq || 0) + 1;
      const phase = ['before', 'after', 'note'].includes(body.phase) ? body.phase : 'before';
      s.reports.push({
        rid: s.reportSeq, at: Date.now(), phase,
        action, detail: String(body.detail || '').slice(0, 1000),
        status: body.status || 'ok',
      });
      if (s.reports.length > 500) s.reports = s.reports.slice(-500);
      if (s.state === 'answered') s.state = 'generating';
      save(s);
      return json(res, 200, { ok: true, rid: s.reportSeq });
    }

    const mLive = u.pathname.match(/^\/api\/live\/([a-f0-9]+)$/);
    if (req.method === 'GET' && mLive) {
      const s = load(mLive[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      res.writeHead(200, {
        'content-type': 'text/event-stream; charset=utf-8',
        'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive',
        'x-accel-buffering': 'no',
      });
      let lastReport = Number(u.searchParams.get('sinceReport') || 0);
      let lastStream = Number(u.searchParams.get('sinceStream') || 0);
      let lastVersion = null;
      const tick = () => {
        const cur = load(mLive[1]);
        if (!cur) return;
        for (const r of cur.reports || []) if (r.rid > lastReport) { res.write(`event: report\ndata: ${JSON.stringify(r)}\n\n`); lastReport = r.rid; }
        for (const e of cur.stream || []) if (e.seq > lastStream) { res.write(`event: stream\ndata: ${JSON.stringify(e)}\n\n`); lastStream = e.seq; }
        if (lastVersion === null) lastVersion = cur.version;
        else if (cur.version !== lastVersion) { res.write(`event: version\ndata: ${JSON.stringify({ version: cur.version, state: cur.state })}\n\n`); lastVersion = cur.version; }
        res.write(': ping\n\n');
      };
      tick();
      const iv = setInterval(tick, 800);
      req.on('close', () => clearInterval(iv));
      return;
    }

    const mStream = u.pathname.match(/^\/api\/stream\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mStream) {
      const s = load(mStream[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      const body = await readBody(req);
      const entries = Array.isArray(body.entries) ? body.entries : [{ channel: body.channel, text: body.text }];
      s.stream = s.stream || [];
      s.seq = s.seq || 0;
      for (const e of entries) {
        const text = String(e.text ?? '');
        if (!text) continue;
        s.seq += 1;
        s.stream.push({ seq: s.seq, at: Date.now(), channel: e.channel || 'content', text: text.slice(0, 20000) });
      }
      if (s.stream.length > 5000) s.stream = s.stream.slice(-5000);
      if (s.state === 'answered') s.state = 'generating';
      save(s);
      return json(res, 200, { ok: true, seq: s.seq });
    }

    const mThink = u.pathname.match(/^\/api\/thought\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mThink) {
      const s = load(mThink[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      const body = await readBody(req);
      s.thoughts = s.thoughts || [];
      s.thoughts.push({ at: Date.now(), text: String(body.text || '').slice(0, 20000), kind: body.kind || 'thought' });
      if (s.thoughts.length > 500) s.thoughts = s.thoughts.slice(-500);
      if (s.state === 'answered') s.state = 'generating';
      save(s);
      return json(res, 200, { ok: true, count: s.thoughts.length });
    }

    const mProg = u.pathname.match(/^\/api\/progress\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mProg) {
      const s = load(mProg[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      const body = await readBody(req);
      s.progress.push({ at: Date.now(), step: body.step || '', detail: body.detail || '', pct: body.pct ?? null, tone: body.tone || 'dim' });
      if (s.state === 'answered') s.state = 'generating';
      logEvent(s, 'progress', { step: body.step });
      save(s);
      return json(res, 200, { ok: true, state: s.state });
    }

    const mCancel = u.pathname.match(/^\/api\/cancel\/([a-f0-9]+)$/);
    if (req.method === 'POST' && mCancel) {
      const s = load(mCancel[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      s.state = 'cancelled'; logEvent(s, 'cancelled'); save(s);
      return json(res, 200, { ok: true });
    }

    const mEvents = u.pathname.match(/^\/api\/events\/([a-f0-9]+)$/);
    if (req.method === 'GET' && mEvents) {
      const s = load(mEvents[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      return json(res, 200, { ok: true, id: s.id, state: s.state, version: s.version, events: s.events });
    }

    const mDel = u.pathname.match(/^\/api\/session\/([a-f0-9]+)$/);
    if (req.method === 'DELETE' && mDel) {
      const s = load(mDel[1]);
      if (!s) return json(res, 404, { ok: false, error: 'no session' });
      if (!auth(req, s)) return json(res, 403, { ok: false, error: 'bad key' });
      fs.unlinkSync(fileOf(s.id));
      return json(res, 200, { ok: true });
    }

    if (req.method === 'GET' && u.pathname === '/api/sessions') {
      const list = fs.readdirSync(STORE).filter((f) => f.endsWith('.json')).map((f) => {
        try { const s = JSON.parse(fs.readFileSync(path.join(STORE, f), 'utf8')); return { id: s.id, state: s.state, version: s.version, taskBrief: s.taskBrief, createdAt: s.createdAt }; } catch { return null; }
      }).filter(Boolean);
      return json(res, 200, { ok: true, sessions: list });
    }

    return json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    return json(res, 500, { ok: false, error: String(e.message || e) });
  }
});

/* Delivery watchdog: answered but never delivered -> surface as stalled. */
setInterval(() => {
  const limit = Number(process.env.ASKUI_STALL_MS || 5 * 60 * 1000);
  const now = Date.now();
  for (const f of fs.readdirSync(STORE)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(STORE, f);
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (!s.answeredAt || s.delivered || ['done', 'cancelled', 'expired', 'stalled'].includes(s.state)) continue;
      if (now - s.answeredAt > limit) {
        s.state = 'stalled';
        s.progress = s.progress || [];
        s.progress.push({ at: now, step: 'AI 处理超时', detail: '页面仍未交付', tone: 'warn' });
        logEvent(s, 'stalled', { answeredAt: s.answeredAt });
        save(s);
      }
    } catch {}
  }
}, 15000).unref();

/* TTL: mark idle sessions expired, delete files after KEEP. */
setInterval(() => {
  const now = Date.now();
  for (const f of fs.readdirSync(STORE)) {
    if (!f.endsWith('.json')) continue;
    const p = path.join(STORE, f);
    try {
      const s = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (now - s.touchedAt > KEEP) { fs.unlinkSync(p); continue; }
      if (s.state === 'waiting' && now - s.touchedAt > TTL) { s.state = 'expired'; logEvent(s, 'expired'); save(s); }
    } catch {}
  }
}, 5 * 60 * 1000).unref();

server.listen(PORT, HOST, () => {
  fs.mkdirSync(DATA, { recursive: true });
  fs.writeFileSync(path.join(DATA, 'askd.pid'), String(process.pid));
  console.log(`[askd] http://${HOST}:${PORT} store=${STORE} pid=${process.pid}`);
});

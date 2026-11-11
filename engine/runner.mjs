#!/usr/bin/env node
/**
 * runner — flow controller.
 *
 * Waits for a page answer, records artifacts, then (only for compute steps)
 * spawns an AI worker process with the run context. The page stays live the
 * whole time; the runner never exits while a session is interactive.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { getRun, recordAnswer, advanceRun, getFlow } from './flow.mjs';
import { openPage } from './browser.mjs';
import { notify } from './notify.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DATA = path.join(os.homedir(), '.local/share/askui');
const STORE = path.join(DATA, 'store');
const RUNS = path.join(DATA, 'runs');
fs.mkdirSync(RUNS, { recursive: true });

const argv = process.argv.slice(2);
const flags = {};
for (const a of argv) if (a.startsWith('--')) { const [k, v] = a.slice(2).split('='); flags[k] = v === undefined ? true : v; }
const runId = flags.run;
if (!runId) { console.error('usage: runner.mjs --run=<id> [--worker=cmd]'); process.exit(1); }

const workerCmd = flags.worker || process.env.ASKUI_WORKER || `node ${path.join(HERE, 'worker-default.mjs')}`;
const logPath = path.join(RUNS, `${runId}.log`);
const log = (msg) => {
  const line = `[${new Date().toISOString()}] ${msg}\n`;
  fs.appendFileSync(logPath, line);
};
fs.writeFileSync(path.join(RUNS, `${runId}.pid`), String(process.pid));
log(`runner start pid=${process.pid} worker=${workerCmd}`);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function sessionMeta(sid) {
  try { return JSON.parse(fs.readFileSync(path.join(STORE, `${sid}.json`), 'utf8')); } catch { return null; }
}

async function pushSpec(sid, spec) {
  const meta = sessionMeta(sid);
  if (!meta) throw new Error('session not found: ' + sid);
  const r = await fetch(`http://127.0.0.1:${process.env.ASKUI_PORT || 9410}/api/push/${sid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-askui-key': meta.adminKey },
    body: JSON.stringify({ spec }),
  });
  return r.json();
}

async function postThought(sid, text, kind = 'thought') {
  const meta = sessionMeta(sid);
  if (!meta) return;
  await fetch(`http://127.0.0.1:${process.env.ASKUI_PORT || 9410}/api/thought/${sid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-askui-key': meta.adminKey },
    body: JSON.stringify({ text, kind }),
  }).catch(() => {});
}

async function postProgress(sid, step, detail = '') {
  const meta = sessionMeta(sid);
  if (!meta) return;
  await fetch(`http://127.0.0.1:${process.env.ASKUI_PORT || 9410}/api/progress/${sid}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-askui-key': meta.adminKey },
    body: JSON.stringify({ step, detail, tone: 'ok' }),
  }).catch(() => {});
}

function runWorker(request) {
  return new Promise((resolve, reject) => {
    const child = spawn('sh', ['-lc', workerCmd], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ASKUI_SESSION: request.sessionId || '', ASKUI_RUN: request.run?.id || '' },
    });
    let out = '', err = '', lineBuf = '';
    const timer = setTimeout(() => { try { child.kill('SIGTERM'); } catch {} reject(new Error('worker timeout')); }, Number(process.env.ASKUI_WORKER_TIMEOUT || 300000));
    child.stdout.on('data', (d) => (out += d));
    child.stderr.on('data', (d) => {
      err += d;
      lineBuf += d;
      const lines = lineBuf.split(String.fromCharCode(10));
      lineBuf = lines.pop();
      for (const line of lines) {
        const m = line.match(/^THINK:\s?(.*)$/);
        if (m && request.sessionId) postThought(request.sessionId, m[1], 'thought');
        else if (line.trim()) {
          log('worker stderr: ' + line.slice(0, 200));
          if (process.env.ASKUI_RAW_THOUGHTS === '1' && request.sessionId) postThought(request.sessionId, line, 'raw');
        }
      }
    });
    child.on('error', (e) => { clearTimeout(timer); reject(e); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`worker exited ${code}: ${err.slice(0, 400)}`));
      try { resolve(JSON.parse(out)); } catch { reject(new Error('worker returned non-JSON: ' + out.slice(0, 300))); }
    });
    child.stdin.end(JSON.stringify(request));
  });
}

async function main() {
  let run = getRun(runId);
  if (!run) throw new Error('run not found: ' + runId);
  const flow = getFlow(run.flowId);

  // open the page that startRun already created
  const waiting = run.steps.filter((s) => s.status === 'waiting' && s.sessionId).pop();
  let lastSession = waiting?.sessionId || null;
  if (lastSession) {
    const meta = sessionMeta(lastSession);
    const url = `http://127.0.0.1:${process.env.ASKUI_PORT || 9410}/s/${lastSession}`;
    const opened = openPage(url);
    log('open ' + url + ' ' + JSON.stringify(opened));
    await notify({ title: '沉浸式决策已开始', body: '交互页面已在浏览器打开。', level: 'info' });
  }

  for (;;) {
    run = getRun(runId);
    if (!run) throw new Error('run disappeared');
    log(`state=${run.status} step=${run.currentStep}`);

    // If a new input session appeared (auto-advance), open it once.
    const curWait = run.steps.filter((s) => s.status === 'waiting' && s.sessionId).pop();
    if (curWait && curWait.sessionId !== lastSession) {
      lastSession = curWait.sessionId;
      const url = `http://127.0.0.1:${process.env.ASKUI_PORT || 9410}/s/${curWait.sessionId}`;
      openPage(url);
      log('open waiting ' + url);
    }

    if (run.status === 'done') {
      await notify({ title: '流程完成', body: '所有步骤已结束，页面为最终交付。', level: 'info' });
      log('done');
      return;
    }

    if (run.status === 'waiting') {
      const ans = await recordAnswer(runId, Number(flags.timeout || 24 * 60 * 60 * 1000));
      if (ans.pending) continue; // page still interactive: never exit
      lastSession = ans.sessionId || lastSession;
      await notify({ title: '已收到你的选择', body: 'AI 正在处理下一步。', level: 'info' });
      log('answered ' + JSON.stringify(ans.values).slice(0, 300));
      if (ans.session) {
        const url = `http://127.0.0.1:${process.env.ASKUI_PORT || 9410}/s/${ans.session.id}`;
        openPage(url);
        lastSession = ans.session.id;
        log('open next ' + url);
      }
      continue;
    }

    if (run.status === 'ready') {
      const step = flow.steps.find((s) => s.key === run.currentStep);
      await notify({ title: 'AI 已接手', body: step?.goal || run.currentStep, level: 'info' });
      const request = {
        run: { id: run.id, flowId: run.flowId, currentStep: run.currentStep },
        flow: { name: flow.name, goal: flow.goal, contextRefs: flow.contextRefs },
        step,
        artifacts: run.artifacts,
        sessionId: lastSession,
      };
      log('worker start ' + workerCmd);
      if (lastSession) {
        await postProgress(lastSession, 'AI 已接手', step?.goal || '');
        await postThought(lastSession, '开始处理：' + (step?.goal || run.currentStep), 'thought');
      }
      const res = await runWorker(request);
      log('worker result ' + JSON.stringify(res).slice(0, 400));
      if (res.spec && lastSession) {
        const pushed = await pushSpec(lastSession, res.spec);
        log('push ' + JSON.stringify(pushed));
        if (!pushed.ok) throw new Error('push failed: ' + (pushed.error || 'unknown'));
      }
      if (lastSession) await postProgress(lastSession, '生成完成', '正在推送下一页');
      const adv = await advanceRun(runId, res.artifacts || {});
      if (adv.session) {
        const url = `http://127.0.0.1:${process.env.ASKUI_PORT || 9410}/s/${adv.session.id}`;
        openPage(url);
        lastSession = adv.session.id;
        log('open after compute ' + url);
      }
      await notify({ title: '处理完成', body: '下一页或最终结果已就绪。', level: 'info' });
      continue;
    }

    await sleep(800);
  }
}

main().catch(async (e) => {
  log('ERROR ' + (e.stack || e.message));
  await notify({ title: 'askui 出错', body: String(e.message).slice(0, 300), level: 'error' });
  process.exit(1);
});

process.on('SIGTERM', () => { log('SIGTERM'); process.exit(0); });

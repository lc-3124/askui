#!/usr/bin/env node
/** Minimal worker: reads a JSON request on stdin, returns a final spec. */
let raw = '';
process.stdin.on('data', (c) => (raw += c));
process.stdin.on('end', () => {
  const think = (t) => process.stderr.write('THINK: ' + t + String.fromCharCode(10));
  think('读取运行上下文与 artifacts…');
  let req = {};
  try { req = JSON.parse(raw || '{}'); } catch {}
  const step = req.step || {};
  const arts = req.artifacts || [];
  const lines = arts.map((a) => `${a.name}: ${typeof a.value === 'string' ? a.value.slice(0, 200) : JSON.stringify(a.value).slice(0, 200)}`);
  const spec = {
    kicker: 'DONE',
    title: '流程完成',
    subtitle: step.goal || '所有步骤已结束。',
    meta: ['由 worker-default 生成', '可通过 ASKUI_WORKER 替换为真实 AI'],
    blocks: [
      { type: 'text', text: lines.length ? lines.join('\n') : '没有额外的产物。' },
      { type: 'notice', text: '这是默认 worker 的占位结果。设置 ASKUI_WORKER 指向你的 AI 进程即可生成真实内容。' },
    ],
    final: true,
  };
  think('整理步骤：' + (step.goal || step.key || 'final'));
  think('生成终态页：' + (spec.title || ''));
  process.stdout.write(JSON.stringify({ spec, artifacts: {}, final: true }));
});

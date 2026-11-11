#!/usr/bin/env node
/**
 * gateway — OpenAI-compatible reverse proxy that tees the raw model stream
 * into an askui session. The AI client only needs to point its base URL here.
 *
 *   base_url = http://127.0.0.1:9420/s/<session>/v1
 *
 * Upstream: ASKUI_UPSTREAM (e.g. https://api.deepseek.com/v1)
 * Key:      incoming Authorization, else ASKUI_API_KEY
 */
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const session = flag('session') || process.env.ASKUI_SESSION;
const port = Number(flag('port') || process.env.ASKUI_GATEWAY_PORT || 9420);
const upstream = (flag('upstream') || process.env.ASKUI_UPSTREAM || 'https://api.deepseek.com/v1').replace(/\/$/, '');
if (!session) { console.error('missing --session'); process.exit(2); }

const ASK = `http://127.0.0.1:${process.env.ASKUI_PORT || 9410}`;
const STORE = path.join(os.homedir(), '.local/share/askui/store');
let adminKey = null;
try { adminKey = JSON.parse(fs.readFileSync(path.join(STORE, `${session}.json`), 'utf8')).adminKey; } catch {}

async function emit(channel, text) {
  if (!text || !adminKey) return;
  await fetch(`${ASK}/api/stream/${session}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-askui-key': adminKey },
    body: JSON.stringify({ entries: [{ channel, text }] }),
  }).catch(() => {});
}

const buffers = { reasoning: '', content: '', tool: '' };
async function push(channel, text) {
  buffers[channel] += text;
  const parts = buffers[channel].split('\n');
  buffers[channel] = parts.pop();
  for (const line of parts) await emit(channel, line + '\n');
}
async function flush() {
  for (const ch of Object.keys(buffers)) if (buffers[ch]) { await emit(ch, buffers[ch]); buffers[ch] = ''; }
}

function sessionFromPath(p) {
  const m = p.match(/^\/s\/([a-f0-9]+)\//);
  return m ? m[1] : session;
}

const server = http.createServer(async (req, res) => {
  const sid = sessionFromPath(req.url);
  const forwardPath = req.url.replace(/^\/s\/[a-f0-9]+/, '') || '/chat/completions';
  if (req.method !== 'POST') {
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, gateway: true, session: sid, upstream }));
  }
  let raw = '';
  for await (const c of req) raw += c;
  let body;
  try { body = JSON.parse(raw || '{}'); } catch { res.writeHead(400); return res.end('bad json'); }

  const auth = req.headers.authorization || (process.env.ASKUI_API_KEY ? `Bearer ${process.env.ASKUI_API_KEY}` : '');
  let up;
  try {
    up = await fetch(upstream + forwardPath, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
      body: JSON.stringify(body),
    });
  } catch (e) {
    res.writeHead(502, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ error: String(e.message) }));
  }

  const ct = up.headers.get('content-type') || '';
  if (!ct.includes('text/event-stream')) {
    const text = await up.text();
    try {
      const j = JSON.parse(text);
      const msg = j.choices?.[0]?.message || {};
      if (msg.reasoning_content) await push('reasoning', msg.reasoning_content);
      if (msg.content) await push('content', msg.content);
      await flush();
    } catch {}
    res.writeHead(up.status, { 'content-type': ct || 'application/json' });
    return res.end(text);
  }

  res.writeHead(up.status, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache',
    connection: 'keep-alive',
    'x-accel-buffering': 'no',
  });
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of up.body) {
    const bytes = Buffer.from(chunk);
    res.write(bytes); // forward verbatim to the AI client
    buf += dec.decode(bytes, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const rawLine of lines) {
      const line = rawLine.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      try {
        const j = JSON.parse(data);
        const d = j.choices?.[0]?.delta || {};
        if (d.reasoning_content) await push('reasoning', d.reasoning_content);
        if (d.content) await push('content', d.content);
        if (d.tool_calls) await push('tool', JSON.stringify(d.tool_calls));
      } catch {}
    }
  }
  await flush();
  res.end();
});

server.listen(port, '127.0.0.1', () => {
  fs.mkdirSync(path.join(os.homedir(), '.local/share/askui/runs'), { recursive: true });
  fs.writeFileSync(path.join(os.homedir(), '.local/share/askui/runs', `gateway-${port}.pid`), String(process.pid));
  console.log(`[gateway] http://127.0.0.1:${port}/s/${session}/v1 -> ${upstream}`);
});

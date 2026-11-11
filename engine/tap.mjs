#!/usr/bin/env node
/**
 * tap — pipe a model's raw response stream into an askui session.
 * No summarization: reasoning_content / content / tool_calls are forwarded as-is.
 *
 * Env: ASKUI_LLM_URL, ASKUI_API_KEY, ASKUI_MODEL, ASKUI_SYSTEM
 * Usage: node tap.mjs --session=<id> --prompt="..."
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const args = process.argv.slice(2);
const flag = (name, def = '') => {
  const hit = args.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.slice(name.length + 3) : def;
};
const session = flag('session') || process.env.ASKUI_SESSION;
if (!session) { console.error('missing --session'); process.exit(2); }

const ASK = `http://127.0.0.1:${process.env.ASKUI_PORT || 9410}`;
const STORE = path.join(os.homedir(), '.local/share/askui/store');
const meta = JSON.parse(fs.readFileSync(path.join(STORE, `${session}.json`), 'utf8'));
const key = meta.adminKey;

const url = process.env.ASKUI_LLM_URL || 'https://api.deepseek.com/chat/completions';
const apiKey = process.env.ASKUI_API_KEY || '';
const model = process.env.ASKUI_MODEL || 'deepseek-chat';
const system = process.env.ASKUI_SYSTEM || 'You are a helpful assistant.';
const prompt = flag('prompt') || fs.readFileSync(0, 'utf8');

async function emit(channel, text) {
  if (!text) return;
  await fetch(`${ASK}/api/stream/${session}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-askui-key': key },
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
  for (const ch of Object.keys(buffers)) {
    if (buffers[ch]) { await emit(ch, buffers[ch]); buffers[ch] = ''; }
  }
}

async function main() {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
    body: JSON.stringify({
      model, stream: true,
      messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`model HTTP ${res.status}: ${(await res.text()).slice(0, 300)}`);
  if (!res.body) throw new Error('model returned no body');
  const dec = new TextDecoder();
  let buf = '';
  let content = '', reasoning = '';
  for await (const chunk of res.body) {
    buf += dec.decode(chunk, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const raw of lines) {
      const line = raw.trim();
      if (!line.startsWith('data:')) continue;
      const data = line.slice(5).trim();
      if (!data || data === '[DONE]') continue;
      let j; try { j = JSON.parse(data); } catch { continue; }
      const d = j.choices?.[0]?.delta || {};
      if (d.reasoning_content) { reasoning += d.reasoning_content; await push('reasoning', d.reasoning_content); }
      if (d.content) { content += d.content; await push('content', d.content); }
      if (d.tool_calls) {
        const t = JSON.stringify(d.tool_calls);
        await push('tool', t);
      }
    }
  }
  await flush();
  process.stdout.write(JSON.stringify({ ok: true, text: content, reasoning, model }));
}

main().catch((e) => { console.error(String(e.message || e)); process.exit(1); });

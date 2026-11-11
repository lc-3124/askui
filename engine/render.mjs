import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CSS = fs.readFileSync(path.join(HERE, '../web/theme.css'), 'utf8');
const CLIENT = fs.readFileSync(path.join(HERE, '../web/client.js'), 'utf8');


/** Minimal, safe Markdown -> HTML. Raw HTML is escaped, links are http(s) only. */
export function mdToHtml(md) {
  const inline = (raw) => {
    let x = esc(raw);
    x = x.replace(/`([^`]+)`/g, '<code>$1</code>');
    x = x.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    x = x.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    x = x.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');
    return x;
  };
  const lines = String(md || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let para = [], list = null, code = null;
  const flushPara = () => { if (para.length) { out.push(`<p>${inline(para.join(' '))}</p>`); para = []; } };
  const flushList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  for (const line of lines) {
    if (/^```/.test(line)) {
      if (code) { out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`); code = null; }
      else { flushPara(); flushList(); code = []; }
      continue;
    }
    if (code) { code.push(line); continue; }
    if (!line.trim()) { flushPara(); flushList(); continue; }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) { flushPara(); flushList(); const n = h[1].length; out.push(`<h${n}>${inline(h[2])}</h${n}>`); continue; }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) { flushPara(); flushList(); out.push('<hr>'); continue; }
    if (/^>\s?/.test(line)) { flushPara(); flushList(); out.push(`<blockquote>${inline(line.replace(/^>\s?/, ''))}</blockquote>`); continue; }
    const ul = line.match(/^[-*]\s+(.*)$/), ol = line.match(/^\d+\.\s+(.*)$/);
    if (ul || ol) {
      flushPara();
      const t = ul ? 'ul' : 'ol';
      if (list !== t) { flushList(); out.push(`<${t}>`); list = t; }
      out.push(`<li>${inline((ul || ol)[1])}</li>`);
      continue;
    }
    para.push(line.trim());
  }
  if (code) out.push(`<pre><code>${esc(code.join('\n'))}</code></pre>`);
  flushPara(); flushList();
  return out.join('\n');
}

export function isInteractiveSpec(spec) {
  return (spec.blocks || []).some((b) => ['cards', 'fields', 'confirm'].includes(b.type));
}

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

function hue(s) { let h = 0; for (const ch of String(s)) h = (h * 131 + ch.codePointAt(0)) % 360; return h; }
function art(seed) {
  const a = hue(seed), b = (a + 58) % 360;
  return `background:radial-gradient(120% 120% at 15% 10%,hsl(${a} 85% 89%),transparent 58%),radial-gradient(120% 120% at 85% 90%,hsl(${b} 82% 91%),transparent 62%),linear-gradient(140deg,hsl(${a} 62% 96%),hsl(${b} 58% 95%))`;
}

function renderBlock(b, inputs) {
  const type = b.type;
  if (type === 'markdown') return `<div class="block md">${mdToHtml(b.text || '')}</div>`;
  if (type === 'text') return `<div class="block"><div class="sub">${esc(b.text).replace(/\n/g, '<br>')}</div></div>`;
  if (type === 'notice') return `<div class="block"><div class="confirm" style="cursor:default"><div>${esc(b.text)}</div></div></div>`;

  if (type === 'cards') {
    const multiple = b.multiple !== false;
    inputs.push({ kind: 'cards', name: b.name, multiple });
    const opts = (b.options || []).map((o) => {
      const ch = o.ch || String(o.label || o.value).trim()[0] || '?';
      const badge = o.meta ? `<div class="num">${esc(o.meta)}</div>` : '';
      const tag = o.tag ? `<div class="tag">${esc(o.tag)}</div>` : '';
      const desc = o.desc ? `<p>${esc(o.desc)}</p>` : '';
      const extra = o.note ? `<div class="n">${esc(o.note)}</div>` : '';
      return `<div class="card" data-value="${esc(o.value)}">
        <div class="art" style="${o.art === 'none' ? '' : art(o.value || o.label)}"><div class="ch">${esc(ch)}</div>${badge}${tag}<div class="tick"></div></div>
        <div class="body"><h3>${esc(o.label ?? o.value)}</h3>${desc}${extra}</div>
      </div>`;
    }).join('');
    return `<div class="block">
      <div class="toolbar"><div class="count">${multiple ? '可多选' : '单选'} · 已选 <b data-count-for="${esc(b.name)}">0</b></div>
      ${multiple ? `<div style="display:flex;gap:8px"><button class="mini" data-clear="${esc(b.name)}">清空</button></div>` : ''}</div>
      <div class="grid" data-cards="${esc(b.name)}" data-multiple="${multiple}">${opts}</div>
    </div>`;
  }

  if (type === 'fields') {
    const fields = (b.fields || []).map((f) => {
      inputs.push({ kind: 'field', name: f.name, type: f.type || 'text', required: !!f.required });
      const req = f.required ? '<span class="req">*</span>' : '';
      const label = `<label for="f_${esc(f.name)}">${esc(f.label || f.name)}${req}</label>`;
      let control;
      if (f.type === 'textarea') control = `<textarea id="f_${esc(f.name)}" data-field="${esc(f.name)}" placeholder="${esc(f.placeholder || '')}"></textarea>`;
      else if (f.type === 'select') control = `<select id="f_${esc(f.name)}" data-field="${esc(f.name)}">${(f.options || []).map((o) => `<option value="${esc(o.value ?? o)}">${esc(o.label ?? o)}</option>`).join('')}</select>`;
      else control = `<input class="input" id="f_${esc(f.name)}" data-field="${esc(f.name)}" type="${esc(f.type || 'text')}" placeholder="${esc(f.placeholder || '')}">`;
      return `<div class="field">${label}${control}<div class="err" data-err="${esc(f.name)}"></div></div>`;
    }).join('');
    return `<div class="block">${fields}</div>`;
  }

  if (type === 'list') {
    const items = (b.items || []).map((it) => `<div class="item">
      <div class="item-head"><h3>${esc(it.title)}</h3>${it.tag ? `<span class="tagline">${esc(it.tag)}</span>` : ''}</div>
      ${it.desc ? `<p>${esc(it.desc)}</p>` : ''}
      ${it.code ? `<div class="item-code"><code>${esc(it.code)}</code><button class="copy" data-copy="${esc(it.code)}">复制</button></div>` : ''}
    </div>`).join('');
    return `<div class="block"><div class="res-grid">${items}</div></div>`;
  }

  if (type === 'code') {
    return `<div class="block"><div class="codebox"><div class="codehead"><span>${esc(b.label || '可直接复制')}</span><button class="copy" data-copy="${esc(b.code)}">复制</button></div><pre>${esc(b.code)}</pre></div></div>`;
  }

  if (type === 'confirm') {
    inputs.push({ kind: 'confirm', name: b.name, required: b.required !== false });
    return `<div class="block"><label class="confirm"><input type="checkbox" data-confirm="${esc(b.name)}"><div>${esc(b.label)}</div></label></div>`;
  }
  return `<div class="block"><div class="err">unknown block: ${esc(type)}</div></div>`;
}

export function renderPage(spec, { sessionId, token, version }) {
  const inputs = [];
  const blocks = (spec.blocks || []).map((b) => renderBlock(b, inputs)).join('\n');
  const meta = (spec.meta || []).map((m) => `<span class="chip">${esc(m)}</span>`).join('');
  const accent = spec.theme?.accent || '#ff6b9d';
  const interactive = !spec.final && (isInteractiveSpec(spec) || !!spec.submit);
  const submitLabel = spec.submit?.label || '提交给 AI';
  const note = spec.submit?.note || '提交后由模型接手处理，页面会自动更新。';
  const client = CLIENT
    .replaceAll('__SESSION__', sessionId)
    .replaceAll('__TOKEN__', token)
    .replaceAll('__VERSION__', String(version))
    .replaceAll('__INPUTS__', JSON.stringify(inputs))
    .replaceAll('__SUBMIT_LABEL__', JSON.stringify(submitLabel));

  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(spec.title || '需要你的选择')}</title>
<style>:root{--accent:${esc(accent)}}${CSS}</style></head>
<body>
<div class="wrap">
  ${spec.kicker ? `<div class="kicker">${esc(spec.kicker)}</div>` : ''}
  <h1>${esc(spec.title || '')}</h1>
  ${spec.subtitle ? `<div class="sub">${esc(spec.subtitle)}</div>` : ''}
  ${meta ? `<div class="meta">${meta}</div>` : ''}
  ${blocks}
</div>
${interactive ? `<div class="submitbar"><div class="in"><div class="t">${esc(note)}</div><button class="btn" id="askui-submit">${esc(submitLabel)}</button></div></div>` : `<div class="nextbar"><div class="done">本次交互已完成</div>${spec.next === false ? '' : `<button class="btn" id="askui-next">${esc(spec.nextLabel || '下一件事')}</button>`}</div>`}
<div class="overlay" id="askui-overlay" style="display:none"><div class="panel act-panel">
  <div class="act-head">
    <span class="pulse"></span>
    <div>
      <div class="act-title" id="askui-title">已提交，AI 正在接手…</div>
      <div class="act-sub">操作日志 · 实时推送 · <span id="askui-elapsed">0s</span></div>
    </div>
  </div>
  <div class="act-list" id="askui-actions"></div>
  <div class="act-foot" id="askui-hint">AI 在任何操作前都会先向 JS 服务报告，页面通过 SSE 实时渲染。</div>
</div></div>
<div class="toast" id="askui-toast"></div>
<script>${client}</script>
</body></html>`;
}

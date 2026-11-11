(() => {
  const SID = "__SESSION__";
  const TOKEN = "__TOKEN__";
  const BASE_VERSION = Number("__VERSION__");
  const INPUTS = __INPUTS__;
  const SUBMIT_LABEL = __SUBMIT_LABEL__;
  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => [...r.querySelectorAll(s)];
  const state = new Map();

  const countFor = (name) => { const v = state.get(name); return v instanceof Set ? v.size : (v ? 1 : 0); };
  const refreshCounts = () => $$('[data-count-for]').forEach((el) => { el.textContent = countFor(el.dataset.countFor); });

  $$('[data-cards]').forEach((grid) => {
    const name = grid.dataset.cards;
    const multiple = grid.dataset.multiple === 'true';
    if (!state.has(name)) state.set(name, multiple ? new Set() : '');
    $$('.card', grid).forEach((card) => {
      card.addEventListener('click', () => {
        const v = card.dataset.value;
        if (multiple) {
          const set = state.get(name);
          if (set.has(v)) { set.delete(v); card.classList.remove('sel'); }
          else { set.add(v); card.classList.add('sel'); }
        } else {
          state.set(name, v);
          $$('.card', grid).forEach((c) => c.classList.toggle('sel', c === card));
        }
        refreshCounts();
      });
    });
  });
  $$('[data-clear]').forEach((b) => b.addEventListener('click', () => {
    const name = b.dataset.clear;
    const grid = $(`[data-cards="${CSS.escape(name)}"]`);
    if (!grid) return;
    if (state.get(name) instanceof Set) state.get(name).clear(); else state.set(name, '');
    $$('.card', grid).forEach((c) => c.classList.remove('sel'));
    refreshCounts();
  }));

  function collect() {
    const out = {};
    for (const inp of INPUTS) {
      if (inp.kind === 'cards') {
        const v = state.get(inp.name);
        out[inp.name] = inp.multiple ? [...(v || [])] : (v || '');
      } else if (inp.kind === 'confirm') {
        const el = $(`[data-confirm="${CSS.escape(inp.name)}"]`);
        out[inp.name] = !!(el && el.checked);
      } else if (inp.kind === 'field') {
        const el = $(`[data-field="${CSS.escape(inp.name)}"]`);
        let v = el ? el.value : '';
        if (inp.type === 'number' && v !== '') v = Number(v);
        out[inp.name] = v;
      }
    }
    return out;
  }

  function validateLocal() {
    let ok = true;
    for (const inp of INPUTS) {
      if (inp.kind === 'field' && inp.required) {
        const el = $(`[data-field="${CSS.escape(inp.name)}"]`);
        const err = $(`[data-err="${CSS.escape(inp.name)}"]`);
        const empty = !el || String(el.value).trim() === '';
        if (err) err.textContent = empty ? '必填' : '';
        if (empty) ok = false;
      }
      if (inp.kind === 'confirm' && inp.required) {
        const el = $(`[data-confirm="${CSS.escape(inp.name)}"]`);
        if (el && !el.checked) { el.focus(); ok = false; toast('请先勾选确认项'); }
      }
    }
    return ok;
  }

  let key = sessionStorage.getItem('askui-key-' + SID);
  if (!key) { key = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now() + Math.random())); sessionStorage.setItem('askui-key-' + SID, key); }

  const overlay = $('#askui-overlay');
  const actList = $('#askui-actions');
  const titleEl = $('#askui-title');
  const elapsedEl = $('#askui-elapsed');
  let done = false;
  let startedAt = 0;
  let lastRid = 0;
  const pending = new Map();

  const hhmmss = (ts) => new Date(ts || Date.now()).toLocaleTimeString('zh-CN', { hour12: false });
  const fmtElapsed = (ms) => { const s = Math.floor(ms / 1000); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m${String(s % 60).padStart(2, '0')}s`; };
  const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  function makeRow(r) {
    const row = document.createElement('div');
    row.className = 'act' + (r.phase === 'note' ? ' is-note' : r.phase === 'before' ? ' is-pending' : ' is-done') + (r.status === 'error' ? ' is-error' : '');
    row.dataset.action = r.action;
    if (r.phase === 'note') {
      row.innerHTML = `<span class="act-dot"></span>
        <div class="act-main"><div class="act-note-text">${esc(r.action)}</div>${r.detail ? `<div class="act-detail">${esc(r.detail)}</div>` : ''}</div>
        <span class="act-time">${hhmmss(r.at)}</span>`;
    } else {
      row.innerHTML = `<span class="act-dot"></span>
        <div class="act-main">
          <div class="act-line"><span class="act-phase">${r.phase === 'before' ? '准备' : (r.status === 'error' ? '失败' : '完成')}</span><span class="act-action">${esc(r.action)}</span></div>
          ${r.detail ? `<div class="act-detail">${esc(r.detail)}</div>` : ''}
        </div>
        <span class="act-time">${hhmmss(r.at)}</span>`;
    }
    actList.appendChild(row);
    actList.scrollTop = actList.scrollHeight;
    return row;
  }

  function renderReport(r) {
    if (!r || r.rid <= lastRid) return;
    lastRid = Math.max(lastRid, r.rid);
    if (r.phase === 'after') {
      const prev = pending.get(r.action);
      if (prev) {
        prev.classList.remove('is-pending');
        prev.classList.add(r.status === 'error' ? 'is-error' : 'is-done');
        prev.querySelector('.act-phase').textContent = r.status === 'error' ? '失败' : '完成';
        if (r.detail) {
          let d = prev.querySelector('.act-detail');
          if (!d) { d = document.createElement('div'); d.className = 'act-detail'; prev.querySelector('.act-main').appendChild(d); }
          d.textContent = r.detail;
        }
        pending.delete(r.action);
        return;
      }
    }
    const row = makeRow(r);
    if (r.phase === 'before') pending.set(r.action, row);
    if (titleEl) titleEl.textContent = r.phase === 'note' ? 'AI 正在做事…' : r.phase === 'before' ? 'AI 正在操作…' : 'AI 刚刚完成一步';
  }

  async function submit() {
    if (done) return;
    if (!validateLocal()) return;
    done = true;
    const btn = $('#askui-submit');
    if (btn) { btn.disabled = true; btn.textContent = '已提交'; }
    overlay.style.display = 'flex';
    startedAt = Date.now();
    setInterval(() => { if (elapsedEl) elapsedEl.textContent = fmtElapsed(Date.now() - startedAt); }, 1000);
    const values = collect();
    try {
      const r = await fetch(`/api/answer/${SID}`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: TOKEN, values, idempotencyKey: key }),
      });
      const j = await r.json();
      if (!j.ok && r.status !== 409) throw new Error(j.error || '提交失败');
    } catch (e) {
      if (titleEl) titleEl.textContent = '提交失败，请刷新重试';
      done = false;
      if (btn) { btn.disabled = false; btn.textContent = SUBMIT_LABEL; }
      toast('提交失败：' + e.message);
      return;
    }
    live();
  }

  function live() {
    try {
      const es = new EventSource(`/api/live/${SID}`);
      es.addEventListener('report', (e) => { try { renderReport(JSON.parse(e.data)); } catch {} });
      es.addEventListener('version', (e) => {
        try {
          const d = JSON.parse(e.data);
          if (d.version > BASE_VERSION) { if (titleEl) titleEl.textContent = '完成，正在打开结果…'; setTimeout(() => location.reload(), 400); }
        } catch {}
      });
      es.onerror = () => { /* EventSource auto-reconnects */ };
    } catch (e) { pollFallback(); }
  }

  let polling = false;
  async function pollFallback() {
    if (polling) return;
    polling = true;
    for (;;) {
      await new Promise((r) => setTimeout(r, 1000));
      try {
        const st = await (await fetch(`/api/state/${SID}`)).json();
        for (const r of st.reports || []) renderReport(r);
        if (st.version > BASE_VERSION) return location.reload();
      } catch {}
    }
  }

  const nextBtn = $('#askui-next');
  if (nextBtn) nextBtn.addEventListener('click', async () => {
    nextBtn.disabled = true;
    const old = nextBtn.textContent;
    nextBtn.textContent = '正在开启…';
    try {
      const r = await fetch(`/api/next/${SID}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ token: TOKEN }) });
      const j = await r.json();
      if (!j.ok || !j.url) throw new Error(j.error || '无法开启下一轮');
      location.href = j.url;
    } catch (e) {
      nextBtn.disabled = false; nextBtn.textContent = old; toast('开启失败：' + e.message);
    }
  });

  let tt;
  function toast(msg) {
    const t = $('#askui-toast');
    if (!t) return;
    t.textContent = msg; t.classList.add('show');
    clearTimeout(tt); tt = setTimeout(() => t.classList.remove('show'), 1600);
  }
  function copy(text) {
    const ok = () => toast('已复制');
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(ok).catch(() => fb(text, ok));
    else fb(text, ok);
  }
  function fb(text, ok) {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    try { document.execCommand('copy'); ok(); } catch (e) { toast('复制失败'); }
    document.body.removeChild(ta);
  }
  document.addEventListener('click', (e) => {
    const b = e.target.closest('[data-copy]');
    if (b) copy(b.dataset.copy);
  });

  const btn = $('#askui-submit');
  if (btn) btn.addEventListener('click', submit);
  refreshCounts();
})();

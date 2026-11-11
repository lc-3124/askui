/** UI module library — a real SQLite DB that lives beside the skill. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const SKILL = path.join(os.homedir(), '.dsh/skills/askui');
const DIR = path.join(SKILL, 'modules');
fs.mkdirSync(DIR, { recursive: true });
export const DB_PATH = path.join(DIR, 'modules.db');
const db = new DatabaseSync(DB_PATH);

db.exec(`
CREATE TABLE IF NOT EXISTS modules(
  short TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
  tags TEXT, description TEXT, fragment TEXT, code TEXT,
  uses INTEGER DEFAULT 0, version INTEGER DEFAULT 1,
  created_at INTEGER, updated_at INTEGER
);
`);

const now = () => Date.now();
const J = (v) => JSON.stringify(v ?? null);

export function listModules({ tag } = {}) {
  const rows = tag
    ? db.prepare("SELECT short,name,kind,tags,description,uses,version FROM modules WHERE tags LIKE ? ORDER BY uses DESC, updated_at DESC").all(`%${tag}%`)
    : db.prepare('SELECT short,name,kind,tags,description,uses,version FROM modules ORDER BY uses DESC, updated_at DESC').all();
  return rows.map((r) => ({ ...r, tags: JSON.parse(r.tags || '[]') }));
}

export function getModule(short) {
  const r = db.prepare('SELECT * FROM modules WHERE short=?').get(short);
  if (!r) return null;
  return {
    ...r,
    tags: JSON.parse(r.tags || '[]'),
    fragment: JSON.parse(r.fragment || 'null'),
    code: r.code || null,
  };
}

export function addModule(m) {
  if (!m.short || !m.name || !m.kind) throw new Error('short/name/kind required');
  const prev = db.prepare('SELECT version FROM modules WHERE short=?').get(m.short);
  const v = prev ? prev.version + 1 : 1;
  db.prepare(`INSERT INTO modules(short,name,kind,tags,description,fragment,code,uses,version,created_at,updated_at)
    VALUES(?,?,?,?,?,?,?,?,?,?,?)
    ON CONFLICT(short) DO UPDATE SET name=excluded.name,kind=excluded.kind,tags=excluded.tags,
    description=excluded.description,fragment=excluded.fragment,code=excluded.code,
    version=excluded.version,updated_at=excluded.updated_at`).run(
    m.short, m.name, m.kind, J(m.tags || []), m.description || '', J(m.fragment ?? null),
    m.code || null, m.uses || 0, v, now(), now()
  );
  return getModule(m.short);
}

export function useModule(short) {
  db.prepare('UPDATE modules SET uses=uses+1,updated_at=? WHERE short=?').run(now(), short);
  return getModule(short);
}

export function seedModules() {
  const blocks = {
    cards: {
      short: 'cards', name: '卡片选择', kind: 'block', tags: ['choice', 'multi-select'],
      description: '单选/多选卡片，支持标签、描述、右上角徽标和自动渐变封面。',
      fragment: { type: 'cards', name: '{{name}}', multiple: true, options: [
        { value: 'a', label: '选项 A', desc: '一句话说明', tag: '标签', meta: '12 项' },
        { value: 'b', label: '选项 B', desc: '一句话说明', tag: '标签', meta: '8 项' },
      ] },
    },
    fields: {
      short: 'fields', name: '表单字段', kind: 'block', tags: ['form'],
      description: '文本/数字/多行/下拉字段，支持 required 与占位符。',
      fragment: { type: 'fields', fields: [
        { type: 'text', name: '{{name}}', label: '名称', required: true, placeholder: '...' },
        { type: 'number', name: 'count', label: '数量', required: false },
      ] },
    },
    confirm: {
      short: 'confirm', name: '确认勾选', kind: 'block', tags: ['confirm', 'danger'],
      description: '单个确认勾选，适合危险操作前的最后一道门。',
      fragment: { type: 'confirm', name: '{{name}}', label: '我确认上述内容', required: true },
    },
    list: {
      short: 'list', name: '结果列表', kind: 'block', tags: ['result', 'list'],
      description: '标题 + 描述 + 标签 + 可复制代码的结果卡片网格。',
      fragment: { type: 'list', items: [
        { title: '{{title}}', desc: '简介', tag: '标签 · 12 项', code: 'echo hello' },
      ] },
    },
    code: {
      short: 'code', name: '代码块', kind: 'block', tags: ['result', 'command'],
      description: '带复制按钮的代码块，用于一次性命令或脚本。',
      fragment: { type: 'code', label: '复制以下命令', code: '{{command}}' },
    },
    notice: {
      short: 'notice', name: '提示框', kind: 'block', tags: ['notice'],
      description: '一条醒目的提示，用于风险/前置条件说明。',
      fragment: { type: 'notice', text: '{{text}}' },
    },
  };
  for (const m of Object.values(blocks)) {
    if (!db.prepare('SELECT 1 FROM modules WHERE short=?').get(m.short)) addModule(m);
  }
  const steps = {
    'step-multi-select': {
      short: 'step-multi-select', name: '多选步骤', kind: 'step', tags: ['choice', 'multi-select', 'step'],
      description: '完整的选择页 spec：标题、说明、卡片多选、提交条。',
      fragment: {
        kicker: 'PICK', title: '{{title}}', subtitle: '{{subtitle}}',
        blocks: [{ type: 'cards', name: 'selected', multiple: true, options: [
          { value: 'a', label: 'A', desc: '...', tag: 'tag', meta: '1' },
        ] }],
        answerSchema: { type: 'object', required: ['selected'], additionalProperties: false,
          properties: { selected: { type: 'array', items: { type: 'string' } } } },
        submit: { label: '提交给 AI' },
      },
    },
    'step-form': {
      short: 'step-form', name: '表单步骤', kind: 'step', tags: ['form', 'step'],
      description: '完整的表单页 spec，带必填校验与确认。',
      fragment: {
        kicker: 'FORM', title: '{{title}}', subtitle: '带 * 的必填。',
        blocks: [
          { type: 'fields', fields: [{ type: 'text', name: 'name', label: '名称', required: true }] },
          { type: 'confirm', name: 'agree', label: '我确认信息无误' },
        ],
        answerSchema: { type: 'object', required: ['name', 'agree'], additionalProperties: false,
          properties: { name: { type: 'string' }, agree: { type: 'boolean' } } },
        submit: { label: '提交' },
      },
    },
    'step-danger': {
      short: 'step-danger', name: '危险确认页', kind: 'step', tags: ['confirm', 'danger', 'step'],
      description: '列出影响项 + 确认勾选，适合删除/重启/支付前。',
      fragment: {
        kicker: 'CONFIRM', title: '确认执行', subtitle: '这会立即生效。',
        blocks: [
          { type: 'list', items: [{ title: '目标', desc: '...', tag: 'prod' }] },
          { type: 'confirm', name: 'agree', label: '我知道后果' },
        ],
        answerSchema: { type: 'object', required: ['agree'], additionalProperties: false,
          properties: { agree: { type: 'boolean' } } },
        submit: { label: '确认' },
      },
    },
  };
  for (const m of Object.values(steps)) {
    if (!db.prepare('SELECT 1 FROM modules WHERE short=?').get(m.short)) addModule(m);
  }
  const flows = {
    'flow-multi-select-result': {
      short: 'flow-multi-select-result', name: '多选→结果→命令', kind: 'flow', tags: ['flow', 'choice', 'result'],
      description: '两步流程：卡片多选，排除已选后生成结果列表与可复制命令。',
      fragment: {
        goal: '让用户从一组选项里排除已知项，为剩余项生成简介与命令',
        steps: [
          { key: 'select', goal: '收集已知项', kind: 'input', ui: '{{multiSelectSpec}}',
            output: { type: 'object', required: ['known'], properties: { known: { type: 'array', items: { type: 'string' } } } },
            next: 'recommend' },
          { key: 'recommend', goal: '为未选项生成结果', kind: 'compute', needs: ['select.known'], tools: ['make_result'], next: null },
        ],
      },
    },
    'flow-intake': {
      short: 'flow-intake', name: '目标收集', kind: 'flow', tags: ['flow', 'intake', 'starter'],
      description: '目标不清楚时的第一页：收目标、限制、推进方式。',
      fragment: null, code: 'see cache/immersive-intake/flow.json',
    },
  };
  for (const m of Object.values(flows)) {
    if (!db.prepare('SELECT 1 FROM modules WHERE short=?').get(m.short)) addModule(m);
  }
  return listModules();
}

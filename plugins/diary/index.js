// 日记插件
//
// 为什么单独做：塑料记忆只收"值得长期留"的事，而且会被合并/归档；
// 日记是**她自己的记录**——不限字数、不用给别人看、想写什么写什么。
//
// 存储：data/diary/<YYYY-MM-DD>.md。同一天可以分多次追加。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const DIR = path.join(DATA_DIR, 'diary');
let api = null;
let cfg = () => ({});

function pad(n) {
  return String(n).padStart(2, '0');
}

export function todayKey(now = Date.now()) {
  const d = new Date(now);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function fileOf(date) {
  return path.join(DIR, `${date}.md`);
}

export function readDiary(date) {
  try {
    return fs.readFileSync(fileOf(date), 'utf8');
  } catch {
    return '';
  }
}

export function writeDiary(text, { date = todayKey(), now = Date.now() } = {}) {
  const body = String(text || '').trim();
  if (!body) return { ok: false, error: '内容是空的' };
  const hh = new Date(now).toTimeString().slice(0, 5);
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileOf(date);
    const exists = fs.existsSync(file);
    const block = exists ? `\n\n---\n\n（${hh}）\n${body}\n` : `# ${date}\n\n（${hh}）\n${body}\n`;
    fs.appendFileSync(file, block, 'utf8');
    return { ok: true, date, chars: body.length };
  } catch (e) {
    return { ok: false, error: String(e?.message || e) };
  }
}

export function hasDiary(date = todayKey()) {
  return readDiary(date).trim().length > 0;
}

/** 最近一篇日记（今天没有就往前找），用于注入。 */
export function latestDiary(now = Date.now()) {
  for (let i = 0; i < 7; i += 1) {
    const d = new Date(now - i * 86400000);
    const key = todayKey(d.getTime());
    const text = readDiary(key);
    if (text.trim()) return { date: key, text };
  }
  return null;
}

function log(...args) {
  try { api?.log?.(...args); } catch { /* ignore */ }
}

export function setup(a) {
  api = a;
  cfg = a?.config || (() => ({}));
  registerTools();   // ⚠️ 别忘：daily-schedule 就是漏了这行，工具一直没注册
  log('[diary] 日记已加载');
}

export const hooks = {};

/** 到点还没写日记 → orchestrator 会开一次运行专门写日记。 */
export const providers = {
  'diary.pending': () => ({
    pending: !hasDiary(),
    hour: Math.max(0, Math.min(23, Number(cfg()?.writeHour) ?? 23)),
    minute: Math.max(0, Math.min(59, Number(cfg()?.writeMinute) ?? 20))
  })
};

export function promptSections() {
  try {
    if (cfg()?.enabled === false) return [];
    const maxChars = Math.max(80, Math.min(2000, Number(cfg()?.injectChars) || 400));
    const latest = latestDiary();
    const lines = [];
    if (latest) {
      const brief = latest.text.replace(/^#.*$/m, '').trim().slice(0, maxChars);
      lines.push(`【日记·最近一篇 ${latest.date}】\n${brief}`);
    }
    const hour = new Date().getHours();
    if (cfg()?.remind !== false && hour >= Math.max(0, Math.min(23, Number(cfg()?.writeHour) ?? 22)) && !hasDiary()) {
      lines.push('（今天还没写日记。想写就随手写两句——用 diary_write，写给自己看，不用发消息给对方；不想写就算了。）');
    }
    if (!lines.length) return [];
    return [{ id: 'diary', title: '日记', priority: 52, content: lines.join('\n') }];
  } catch {
    return [];
  }
}

function registerTools() {
  api.registerTool({
    id: 'diary_write',
    name: '写日记',
    description: '写今天的日记：不限字数、不限主题，想到什么写什么，只给自己看。同一天可以写多次，会追加。写完不需要发消息告诉对方。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '日记内容，随性写；可以是一句话，也可以很长' },
        date: { type: 'string', description: '补写某一天（YYYY-MM-DD），不填就是今天' }
      },
      required: ['text']
    },
    execute(_ctx, args) {
      const text = String(args?.text || '').trim();
      if (!text) return { content: '没写内容，没记。' };
      const date = /^\d{4}-\d{2}-\d{2}$/.test(String(args?.date || '')) ? String(args.date) : todayKey();
      const r = writeDiary(text, { date });
      if (!r.ok) return { content: `记日记失败：${r.error}` };
      return { content: `写好了（${date}，${r.chars} 字）。` };
    }
  });

  api.registerTool({
    id: 'diary_read',
    name: '翻日记',
    description: '看某一天或最近一篇日记。想看自己之前写过什么时用；不要把日记原文念给别人。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        date: { type: 'string', description: 'YYYY-MM-DD，不填就是最近一篇' }
      }
    },
    execute(_ctx, args) {
      const wantDate = String(args?.date || '').trim();
      if (wantDate) {
        const text = readDiary(wantDate);
        return { content: text ? text.slice(0, 1500) : `${wantDate} 没有日记。` };
      }
      const latest = latestDiary();
      return { content: latest ? `（${latest.date}）\n${latest.text.slice(0, 1500)}` : '还没有写过日记。' };
    }
  });
}

export { registerTools as _registerTools };

export function deactivate() {
  api = null;
}

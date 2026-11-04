// 待办 / 约定：她答应过的事、别人说过要做的事。
//
// 为什么单独一个模块：主动消息现在只有"随机抽冷群"一种动机，抽出来的话跟上下文无关。
// 真正像人的主动是"有事"——约好的、答应过的、对方提过的未来事件，到点了去问一句。
//
// 存储：data/followups/<chatKey>.json
//   { chatKey, items: [{ id, what, who, whoName, dueAt, dueText, status, createdAt, askedAt }] }
// status: open | asked | done
//
// 另外存一份运行态（上次主动时间、连续被无视次数、冷却）在 _state.json。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';
import { chatCompletion } from './llm.js';

const DIR = path.join(DATA_DIR, 'followups');
const META = path.join(DIR, '_state.json');
const DAY = 86400000;

function fileOf(chatKey) {
  const safe = String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
  return path.join(DIR, `${safe}.json`);
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function writeJson(file, data) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 失败不影响聊天 */ }
}

/** "明天/后天/今晚/周末" → 时间戳；认不出来就 2 小时后。 */
export function parseDue(text, now = Date.now()) {
  const s = String(text || '');
  const d = new Date(now);
  const at = (dayOffset, hour, minute = 0) => {
    const x = new Date(d);
    x.setDate(x.getDate() + dayOffset);
    x.setHours(hour, minute, 0, 0);
    return x.getTime();
  };
  if (/后天/.test(s)) return { dueAt: at(2, 10), dueText: '后天' };
  if (/明天|明早|明晚/.test(s)) return { dueAt: at(1, /明晚/.test(s) ? 20 : 10), dueText: '明天' };
  if (/今晚|今天晚上/.test(s)) {
    const t = at(0, 20, 30);
    return { dueAt: t > now ? t : now + 3600000, dueText: '今晚' };
  }
  if (/周末|礼拜六|周六/.test(s)) {
    const x = new Date(now);
    const add = (6 - x.getDay() + 7) % 7 || 7;
    return { dueAt: at(add, 10), dueText: '周末' };
  }
  if (/一会儿|等下|晚点|回头/.test(s)) return { dueAt: now + 50 * 60000, dueText: '晚点' };
  return { dueAt: now + 2 * 3600000, dueText: '过一会儿' };
}

export function load(chatKey) {
  const raw = readJson(fileOf(chatKey), null);
  return raw && Array.isArray(raw.items) ? raw : { chatKey, items: [] };
}

export function add(chatKey, { what, who = '', whoName = '', dueAt, dueText = '', now = Date.now() } = {}) {
  const text = String(what || '').trim().slice(0, 120);
  if (!text) return null;
  const st = load(chatKey);
  // 同一件事不重复记（按内容去重）
  if (st.items.some((x) => x.status !== 'done' && x.what === text)) return null;
  if (st.items.filter((x) => x.status === 'open').length >= 8) return null;
  const item = {
    id: `fu_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
    what: text,
    who: String(who || ''),
    whoName: String(whoName || '').slice(0, 20),
    dueAt: Number(dueAt) || now + 2 * 3600000,
    dueText,
    status: 'open',
    createdAt: now,
    askedAt: 0
  };
  st.items.push(item);
  writeJson(fileOf(chatKey), st);
  return item;
}

/** 到点且还没问过的。 */
export function due(chatKey, now = Date.now()) {
  return load(chatKey).items.filter((x) => x.status === 'open' && x.dueAt <= now);
}

/** 扫全部会话，找到点的待办（按到期时间升序）。 */
export function dueChats(now = Date.now()) {
  const out = [];
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== '_state.json'); } catch { return out; }
  for (const f of names) {
    const st = readJson(path.join(DIR, f), null);
    if (!st?.chatKey || !Array.isArray(st.items)) continue;
    const hit = st.items.filter((x) => x.status === 'open' && x.dueAt <= now);
    if (hit.length) out.push({ chatKey: st.chatKey, items: hit.sort((a, b) => a.dueAt - b.dueAt) });
  }
  return out.sort((a, b) => a.items[0].dueAt - b.items[0].dueAt);
}

export function markAsked(chatKey, id, now = Date.now()) {
  const st = load(chatKey);
  const it = st.items.find((x) => x.id === id);
  if (!it) return;
  it.status = 'asked';
  it.askedAt = now;
  writeJson(fileOf(chatKey), st);
}

export function markDone(chatKey, id) {
  const st = load(chatKey);
  const it = st.items.find((x) => x.id === id);
  if (!it) return;
  it.status = 'done';
  writeJson(fileOf(chatKey), st);
}

/** 清理：问过 3 天还没结果、或完成超过 7 天的，删掉。 */
export function prune(now = Date.now()) {
  let names = [];
  try { names = fs.readdirSync(DIR).filter((f) => f.endsWith('.json') && f !== '_state.json'); } catch { return; }
  for (const f of names) {
    const st = readJson(path.join(DIR, f), null);
    if (!st?.items?.length) continue;
    const before = st.items.length;
    st.items = st.items.filter((x) => {
      if (x.status === 'done') return now - (x.askedAt || x.createdAt) < 7 * DAY;
      if (x.status === 'asked') return now - (x.askedAt || x.createdAt) < 3 * DAY;
      return now - x.createdAt < 14 * DAY;
    });
    if (st.items.length !== before) writeJson(path.join(DIR, f), st);
  }
}

/** 注入提示词用的一句话。 */
export function formatForPrompt(items = []) {
  if (!items.length) return '';
  return items.slice(0, 2).map((x) => `- ${x.whoName || '对方'}那边：${x.what}（约的是${x.dueText || '刚才'}）`).join('\n');
}

// ── 运行态：主动频控 ──────────────────────────────────────────────────

export function loadMeta() {
  return readJson(META, {}) || {};
}

export function saveMeta(meta) {
  writeJson(META, meta || {});
}

export function getChatMeta(chatKey) {
  return loadMeta()[chatKey] || {};
}

export function patchChatMeta(chatKey, patch) {
  const meta = loadMeta();
  meta[chatKey] = { ...(meta[chatKey] || {}), ...patch };
  saveMeta(meta);
  return meta[chatKey];
}

// ── 从对话里抽"约定/待办" ────────────────────────────────────────────

const PROMISE_HINT = /明天|后天|今晚|周末|回头|晚点|等会|一会|说好|答应|约好|记得|考试|面试|下班|回来|发你|给你|告诉我|叫我/;

export function looksLikePromise(text = '') {
  return PROMISE_HINT.test(String(text));
}

/**
 * 用模型从这一轮对话里抽 0~2 条"可以之后主动问"的事。
 * 只在 looksLikePromise 命中时才调用（省 token）。
 */
export async function extractFollowups({ chatKey, dialogue = '', triggerEntries = [], now = Date.now() } = {}) {
  const text = String(dialogue || '').trim().slice(0, 1600);
  if (!text) return [];
  // 同一个会话 10 分钟内最多抽一次：一句"今晚吃什么"也会命中关键词，
  // 不加节流的话每轮都多一次模型调用，纯浪费。
  try {
    const meta = getChatMeta(chatKey);
    if (meta.lastExtractAt && now - Number(meta.lastExtractAt) < 10 * 60000) return [];
    patchChatMeta(chatKey, { lastExtractAt: now });
  } catch { /* ignore */ }
  try {
    const r = await chatCompletion({
      messages: [
        {
          role: 'system',
          content: [
            '从这段聊天里找出 0~2 条"之后可以主动问一句"的事，只找两类：',
            'A. 我答应过对方要做的事（我说"好/等我/回头给你"）；B. 对方说过要做、或提到的未来事件（明天考试、周末搬家）。',
            '不要记：一次性的闲聊、情绪、已经做完的事、没有时间的泛泛而谈。',
            '只输出 JSON：{"items":[{"what":"一句话，可独立看懂","who":"对方QQ号","whoName":"对方昵称","dueText":"明天|后天|今晚|周末|晚点|过一会儿"}]}'
          ].join('\n')
        },
        { role: 'user', content: `对话：\n${text}\n\n请输出 JSON。` }
      ],
      temperature: 0.2,
      maxTokens: 500
    });
    const raw = String(r?.message?.content || '').trim();
    const first = raw.indexOf('{');
    const last = raw.lastIndexOf('}');
    if (first < 0 || last <= first) return [];
    const data = JSON.parse(raw.slice(first, last + 1));
    if (!Array.isArray(data?.items)) return [];
    const out = [];
    for (const it of data.items.slice(0, 2)) {
      const what = String(it?.what || '').trim();
      if (!what) continue;
      const dueInfo = parseDue(`${it?.dueText || ''} ${what}`, now);
      const item = add(chatKey, {
        what,
        who: it?.who || triggerEntries?.[0]?.senderId || '',
        whoName: it?.whoName || triggerEntries?.[0]?.senderName || '',
        dueAt: dueInfo.dueAt,
        dueText: dueInfo.dueText,
        now
      });
      if (item) out.push(item);
    }
    return out;
  } catch {
    return [];
  }
}

export const internals = { DIR, META, PROMISE_HINT };

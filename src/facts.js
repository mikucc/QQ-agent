// 情景事实层（短期的"他现在的情况"）
//
// 为什么单独一层：日程是**虚构生活**，用户真实状态（电脑坏了、在公交上、今天忙）
// 没有任何持久层。96 条窗口之外就忘了，日程里也不会体现，于是出现
// "你说他电脑坏了，她还问'那你拿手机上来的？'"这种接不上的情况。
//
// 这里只存**短期事实**：24 小时自动过期，不进长期记忆，不参与回忆计数。
// 写入由塑料记忆的抽取顺手完成（同一次模型调用，零额外成本）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from './config.js';

const DIR = path.join(DATA_DIR, 'facts');
const DEFAULT_TTL_HOURS = 24;
const MAX_PER_CHAT = 8;

function fileOf(chatKey) {
  return path.join(DIR, `${String(chatKey || '').replace(/[^a-z0-9_]/gi, '_')}.json`);
}

function read(chatKey) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(chatKey), 'utf8').replace(/^\uFEFF/, ''));
    return Array.isArray(raw?.items) ? raw : { chatKey, items: [] };
  } catch {
    return { chatKey, items: [] };
  }
}

function write(state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileOf(state.chatKey);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* 事实层失败不影响聊天 */ }
}

function ttlMs() {
  const h = Number(getConfig()?.facts?.ttlHours) || DEFAULT_TTL_HOURS;
  return Math.max(1, Math.min(72, h)) * 3600000;
}

/** 加一条事实（同义的刷新时间，不重复堆）。 */
export function add(chatKey, text, now = Date.now()) {
  const content = String(text || '').trim().slice(0, 120);
  if (!chatKey || !content) return null;
  const state = read(chatKey);
  const norm = (s) => String(s).replace(/[\s\p{P}\p{S}]+/gu, '');
  const hit = state.items.find((x) => norm(x.text) === norm(content) || norm(x.text).includes(norm(content)));
  if (hit) {
    hit.expiresAt = now + ttlMs();
    hit.updatedAt = now;
    write(state);
    return hit;
  }
  const item = {
    id: `f_${now.toString(36)}_${Math.random().toString(36).slice(2, 5)}`,
    text: content,
    createdAt: now,
    updatedAt: now,
    expiresAt: now + ttlMs()
  };
  state.items.push(item);
  state.items = state.items.filter((x) => x.expiresAt > now).slice(-MAX_PER_CHAT);
  write(state);
  return item;
}

/** 取当前仍有效的事实（新的在前）。 */
export function fresh(chatKey, now = Date.now()) {
  const state = read(chatKey);
  return state.items
    .filter((x) => Number(x.expiresAt) > now)
    .sort((a, b) => Number(b.updatedAt) - Number(a.updatedAt))
    .slice(0, 6);
}

/** 清理过期事实。 */
export function prune(chatKey, now = Date.now()) {
  const state = read(chatKey);
  const before = state.items.length;
  state.items = state.items.filter((x) => Number(x.expiresAt) > now);
  if (state.items.length !== before) write(state);
}

/** 渲染成提示词里的一段。 */
export function renderForPrompt(chatKey, now = Date.now()) {
  const items = fresh(chatKey, now);
  if (!items.length) return '';
  const lines = items.map((x) => `- ${x.text}`).join('\n');
  return `【他现在的情况（短期事实，24 小时内有效）】\n${lines}\n（这些是他最近亲口说的现实情况，比你的日程优先；不要拿日程去反驳他，也别反复追问细节。）`;
}

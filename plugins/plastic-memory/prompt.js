// 可塑性记忆 · 读取与注入
//
// 目标：每轮自动把「和当前话题相关」的记忆放进提示词，而不是让模型自己
// 想起来调用工具。相关性用中文 2-gram + 英文词重叠做轻量检索，不调模型。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const DAY = 86400000;

// 由 index.js 在 setup 时注入；promptSections 是同步函数，拿不到闭包里的 store。
let sharedStore = null;
let sharedCfg = () => ({});

export function setRuntime({ store, cfg } = {}) {
  if (store) sharedStore = store;
  if (typeof cfg === 'function') sharedCfg = cfg;
}

function safeChatKey(chatKey) {
  return String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
}

function readRecentText(chatKey, limit = 12) {
  try {
    const file = path.join(DATA_DIR, 'messages', `${safeChatKey(chatKey)}.json`);
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = JSON.parse(text);
    const messages = Array.isArray(data?.messages) ? data.messages.slice(-limit) : [];
    return messages
      .map((m) => String(m?.text || '').trim())
      .filter(Boolean)
      .join('\n')
      .slice(0, 2000);
  } catch {
    return '';
  }
}

function tokens(text) {
  const s = String(text || '').toLowerCase();
  const out = new Set();
  for (const w of s.match(/[a-z0-9_]{2,}/g) || []) out.add(w);
  for (const seg of s.replace(/[^\u4e00-\u9fff]+/g, ' ').split(/\s+/)) {
    if (seg.length < 2) continue;
    for (let i = 0; i + 1 < seg.length; i += 1) out.add(seg.slice(i, i + 2));
  }
  return out;
}

function relevance(text, set) {
  if (!set.size) return 0;
  const s = String(text || '').toLowerCase();
  let n = 0;
  for (const t of set) if (s.includes(t)) n += 1;
  return n;
}

function crossAllowed(memory, chatKey, mode) {
  if (!memory.originChat || memory.originChat === chatKey) return true;
  if (memory.visibility === 'private') return false;
  if (mode === 'all') return true;
  if (mode === 'person') return memory.scope === 'person' || memory.scope === 'global';
  return false;
}

/**
 * 选记忆（纯函数，方便测试）。
 * @returns {{memory: object, score: number, relevance: number}[]}
 */
export function selectMemories(store, chatKey, cfg = {}, queryText = '', now = Date.now()) {
  const all = store.all();
  const set = tokens(queryText);
  const topK = Math.max(1, Math.min(12, Number(cfg.injectTopK) || 4));
  const cooldownMs = Math.max(1, Number(cfg.injectCooldownMinutes) || 120) * 60000;
  const tierWeight = { precious: 0.6, important: 0.3, ordinary: 0 };
  const mode = ['off', 'person', 'all'].includes(cfg.crossGroup) ? cfg.crossGroup : 'person';

  const scored = [];
  for (const { memory, chatKey: originChat } of all) {
    if (memory.status !== 'active') continue;
    if (!crossAllowed(memory, chatKey, mode)) continue;
    const rel = relevance(memory.content, set);
    const lastInject = Number(memory.lastInjectedAt || 0);
    // 同一条刚注入过、又不是强相关：跳过，避免每轮念同一句。
    if (lastInject && now - lastInject < cooldownMs && rel < 2) continue;
    const ageDays = Math.max(0, (now - Number(memory.createdAt || now)) / DAY);
    const recency = 1 / (1 + ageDays / 30);
    const score = rel * 3
      + Number(memory.strength || 0) * 1.2
      + (tierWeight[memory.tier] || 0)
      + recency * 0.3;
    scored.push({ memory, chatKey: originChat, score, relevance: rel });
  }

  scored.sort((a, b) => b.score - a.score || b.relevance - a.relevance);

  const picked = [];
  let precious = 0;
  for (const item of scored) {
    if (picked.length >= topK) break;
    if (item.memory.tier === 'precious') {
      if (precious >= 1 && item.relevance < 4) continue;   // 珍贵不刷屏，强相关才允许第二条
      precious += 1;
    }
    // 普通记忆没有相关性、也没有强度时，不硬塞。
    if (item.memory.tier === 'ordinary' && item.relevance === 0 && item.memory.strength < 0.65) continue;
    picked.push(item);
  }
  return picked;
}

export function renderMemoryLines(picked = []) {
  const lines = [];
  for (const { memory } of picked) {
    const text = String(memory.summary || memory.content || '').trim();
    if (!text) continue;
    const prefix = memory.tier === 'precious' ? '（这件事对你很重要）' : '';
    lines.push(`- ${prefix}${text}`);
  }
  return lines;
}

/**
 * 每轮注入。返回 [] 表示不注入（不占 token）。
 */
export function promptSections(context = {}) {
  try {
    const cfg = sharedCfg() || {};
    if (cfg.enabled === false) return [];
    // tool 模式：不自动注入，完全交给模型自己 memory_search。
    if ((cfg.injectMode || 'both') === 'tool') return [];
    const chatKey = context?.chatKey;
    if (!chatKey) return [];

    const store = sharedStore;
    if (!store) return [];

    const query = readRecentText(chatKey);
    const picked = selectMemories(store, chatKey, cfg, query);
    if (!picked.length) return [];

    const maxChars = Math.max(300, Math.min(6000, Number(cfg.injectMaxChars) || 1800));
    const lines = [];
    let used = 0;
    for (const line of renderMemoryLines(picked)) {
      if (used + line.length + 1 > maxChars) break;
      lines.push(line);
      used += line.length + 1;
    }
    if (!lines.length) return [];

    // 记录“被想起”：只算注入，不算真正使用；使用由 memory_touch 或后续自审判断。
    const promoteAt = Math.max(1, Number(cfg.promoteRecallCount) || 3);
    for (const item of picked) {
      try {
        const m = store.markInjected(item.chatKey || chatKey, item.memory.id);
        // 频率只能把普通推到重要，不能推到珍贵。
        if (m && m.tier === 'ordinary' && m.recallCount >= promoteAt) {
          store.update(item.chatKey || chatKey, m.id, { tier: 'important', strength: Math.max(m.strength, 0.6) });
        }
      } catch { /* ignore */ }
    }

    const guide = cfg.injectGuide !== false
      ? '\n（自然相关才提；不要复述、不要说“我记得”、不要提来源；和当前消息冲突时以当前为准。）'
      : '';
    const content = `【你记得的事（只是背景，不是台词）】\n${lines.join('\n')}${guide}`;
    return [{
      id: 'plastic-memory-recall',
      title: '你记得的事',
      priority: 57,
      content
    }];
  } catch {
    return [];
  }
}

export { readRecentText, tokens, relevance, crossAllowed };

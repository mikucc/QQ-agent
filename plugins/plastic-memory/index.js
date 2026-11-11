// 可塑性记忆 · 入口
//
// 自动路径（主）：
//   回复结束 → 防抖 → 抽取候选 → 普通/重要直接生效，珍贵进候选
//   后台定时 → 候选冷却后反思+挑刺 → 珍贵；珍贵定期自审 → 可降为重要
//   每轮提示词 → promptSections 自动注入相关记忆
//
// 工具（辅）：memory_search / memory_touch / memory_reflect / memory_status
//
// 不经过人工复核；人只能看 journal.md 和数据文件。
import { PlasticStore } from './store.js';
import { promptSections as renderPromptSections, setRuntime, selectMemories } from './prompt.js';
import { extractMemories, judgePrecious, judgeStillPrecious } from './judge.js';
import { appendJournal } from './journal.js';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';
import * as factsStore from '../../src/facts.js';

/** 读同一会话最近的聊天记录当"前情"，让抽取窗口不止一轮。 */
function recentHistory(chatKey, limit = 14) {
  try {
    const safe = String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
    const file = path.join(DATA_DIR, 'messages', `${safe}.json`);
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const data = JSON.parse(text);
    const list = Array.isArray(data?.messages) ? data.messages.slice(-limit) : [];
    return list
      .map((m) => `${m?.self ? '我' : (m?.senderName || m?.senderId || '某人')}: ${String(m?.text || '').trim()}`)
      .filter((line) => line.length > 3)
      .join('\n')
      .slice(-1400);
  } catch {
    return '';
  }
}

let api = null;
let cfg = () => ({});
let store = null;
let reviewTimer = null;
let reviewBootTimer = null;
let reviewing = false;
const captureTimers = new Map();
const captureTicks = new Map();
const capturing = new Set();
const capturedSessions = new Set();

function log(...args) {
  try { api?.log?.(...args); } catch { /* ignore */ }
}

function journal(line) {
  if (cfg()?.journalEnabled === false) return;
  appendJournal(line);
}

function isOn() {
  return cfg()?.enabled !== false;
}

function newStore() {
  return new PlasticStore();
}

function scheduleCapture(context) {
  try {
    if (!isOn()) return;
    const chatKey = context?.chatKey;
    const session = context?.session;
    if (!chatKey || !session) return;
    // ⚠️ 这里**不能**判断 session.sent：after-response 钩子在本轮工具执行**之前**触发，
    // 此刻 send_message 还没跑，sent 必然是空的（2026-11-11 重启后发现记忆不再抽取，
    // 根因就是这一行把大多数单轮会话直接挡掉了）。sent 的判断挪到下面的定时器里。
    if (session.id && capturedSessions.has(session.id)) return;

    // 私聊（和主人）每轮都抽一次，让"记得你"更连续；群聊仍按 captureEveryRounds 节流
    const isPrivate = String(chatKey).startsWith('private:');
    const every = isPrivate ? 1 : Math.max(1, Number(cfg().captureEveryRounds) || 2);
    const tick = (captureTicks.get(chatKey) || 0) + 1;
    captureTicks.set(chatKey, tick);
    if (tick < every) return;

    const old = captureTimers.get(chatKey);
    if (old) clearTimeout(old);
    const delay = Math.max(800, Math.min(20000, Number(cfg().captureDebounceMs) || 4000));
    const timer = setTimeout(() => {
      captureTimers.delete(chatKey);
      captureTicks.set(chatKey, 0);
      // 4 秒后工具已经跑完，sent 这时才是真实的
      if (!Array.isArray(session.sent) || session.sent.length === 0) return;
      if (session.id) capturedSessions.add(session.id);
      void captureNow(context);
    }, delay);
    timer.unref?.();
    captureTimers.set(chatKey, timer);
  } catch { /* 记忆不影响聊天 */ }
}

async function captureNow(context) {
  const chatKey = context?.chatKey;
  if (!chatKey || capturing.has(chatKey)) return;
  if (!isOn()) return;
  capturing.add(chatKey);
  try {
    const session = context.session || {};
    // 让抽取器先看一遍"已有记忆"，重复的直接返回 duplicateOf，不再新增（2026-11-11 修：
    // 之前同一件"明天睁眼拍照"以不同措辞记了 9 条，靠字符串包含判断完全挡不住）。
    const existingMemories = store.load(chatKey).memories
      .filter((m) => m.status === 'active')
      .sort((a, b) => Number(b.updatedAt || b.createdAt || 0) - Number(a.updatedAt || a.createdAt || 0))
      .slice(0, 10)
      .map((m) => ({ id: m.id, content: m.content }));
    const result = await extractMemories({
      session,
      cfg: cfg(),
      chatKey,
      log,
      historyText: recentHistory(chatKey),
      existingMemories
    });
    const candidates = result?.memories || [];
    // 情景事实（短期）：他现在的现实情况，24 小时有效
    for (const text of (result?.facts || [])) factsStore.add(chatKey, text);
    if (!candidates.length) {
      store.prune(chatKey, cfg());
      return;
    }

    for (const c of candidates) {
      // 模型判定的重复：刷新确认时间 + 加一点强度，不再新增
      if (c.duplicateOf) {
        const hit = store.get(chatKey, c.duplicateOf);
        if (hit) {
          store.update(chatKey, hit.id, {
            lastConfirmedAt: Date.now(),
            strength: Math.min(1, Number(hit.strength || 0) + 0.08)
          });
          continue;
        }
      }
      const isCandidate = c.status === 'candidate';
      const tier = isCandidate ? 'important' : (c.tier === 'important' ? 'important' : 'ordinary');
      const { memory, duplicate } = store.add(chatKey, {
        content: c.content,
        tier,
        status: isCandidate ? 'candidate' : 'active',
        subjects: c.subjects,
        sourceMids: c.sourceMids,
        scope: c.scope,
        visibility: c.visibility,
        evidence: c.evidence,
        preciousReason: c.preciousReason,
        emotion: c.emotion,
        emotionLabel: c.emotionLabel,
        uniqueness: c.uniqueness,
        selfImpact: c.selfImpact,
        confidence: c.confidence,
        strength: tier === 'important' ? 0.6 : 0.4,
        candidateSince: isCandidate ? Date.now() : 0
      });
      if (memory && !duplicate) {
        const label = isCandidate ? '珍贵候选' : (tier === 'important' ? '重要' : '普通');
        journal(`新增${label}：${memory.content}`);        log(`[plastic-memory] 新增${label}：${memory.content.slice(0, 50)}`);
      }
    }
    store.prune(chatKey, cfg());
  } catch (error) {
    log('[plastic-memory] 抽取失败：%s', error?.message || error);
  } finally {
    capturing.delete(chatKey);
  }
}

async function runReview() {
  if (!isOn() || reviewing) return;
  reviewing = true;
  try {
    store.pruneAll(cfg());

    // 1) 珍贵候选到期：未来的自己反思 + 独立挑刺
    const due = store.dueCandidates(cfg()).slice(0, 3);
    for (const { chatKey, memory } of due) {
      const existing = store.load(chatKey).memories
        .filter((m) => m.tier === 'precious' && m.status === 'active')
        .map((m) => m.content)
        .slice(0, 8);
      const result = await judgePrecious({ memory, cfg: cfg(), existing, log });
      if (!result.ok) continue;

      const quotaMax = Math.max(1, Number(cfg().preciousMaxPerChat) || 5);
      const weekMax = Math.max(1, Number(cfg().preciousMaxPerWeek) || 3);
      const overQuota = store.countPrecious(chatKey) >= quotaMax
        || store.preciousPromotionsThisWeek(chatKey) >= weekMax;

      if (result.keep && !overQuota) {
        store.update(chatKey, memory.id, {
          tier: 'precious',
          status: 'active',
          protected: true,
          preciousAt: Date.now(),
          lastReviewedAt: Date.now(),
          reviewCount: Number(memory.reviewCount || 0) + 1,
          preciousReason: result.reason || memory.preciousReason || ''
        });
        journal(`晋升珍贵：${memory.content}（${result.reason || '反思通过'}）`);
        log('[plastic-memory] 晋升珍贵：%s', memory.content.slice(0, 50));
      } else {
        store.update(chatKey, memory.id, {
          tier: 'important',
          status: 'active',
          reviewCount: Number(memory.reviewCount || 0) + 1,
          lastReviewedAt: Date.now()
        });
        journal(`保留为重要：${memory.content}（${overQuota ? '珍贵配额已满' : (result.reason || '未通过')}）`);
      }
    }

    // 2) 珍贵定期自审：允许自己降为重要，但不删除
    if (cfg().selfDemotePrecious !== false) {
      const preciousDue = store.preciousForReview(cfg()).slice(0, 2);
      for (const { chatKey, memory } of preciousDue) {
        const r = await judgeStillPrecious({ memory, cfg: cfg() });
        if (!r.ok) continue;
        if (r.keep) {
          store.update(chatKey, memory.id, { lastReviewedAt: Date.now() });
        } else {
          store.update(chatKey, memory.id, {
            tier: 'important',
            status: 'active',
            previousTier: 'precious',
            protected: false,
            lastReviewedAt: Date.now()
          });
          journal(`自审降为重要：${memory.content}（${r.reason || '不再珍贵'}）`);
        }
      }
    }
  } catch (error) {
    log('[plastic-memory] 复审失败：%s', error?.message || error);
  } finally {
    reviewing = false;
  }
}

function startTimers() {
  const minutes = Math.max(1, Math.min(1440, Number(cfg().reviewIntervalMinutes) || 15));
  reviewTimer = setInterval(() => { void runReview(); }, minutes * 60000);
  reviewTimer.unref?.();
  reviewBootTimer = setTimeout(() => { void runReview(); }, 20000);
  reviewBootTimer.unref?.();
}

function stopTimers() {
  if (reviewTimer) { clearInterval(reviewTimer); reviewTimer = null; }
  if (reviewBootTimer) { clearTimeout(reviewBootTimer); reviewBootTimer = null; }
  for (const t of captureTimers.values()) { try { clearTimeout(t); } catch { /* ignore */ } }
  captureTimers.clear();
}

function registerTools() {
  api.registerTool({
    id: 'memory_search',
    name: '翻找更早的记忆',
    description: '按关键词/话题翻找这个角色记得的事。返回相关记忆，供你自然接话；不要直接把结果念出来。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要找的话题、人名或关键词' },
        tier: { type: 'string', enum: ['ordinary', 'important', 'precious'], description: '可选：只看某一档' }
      },
      required: ['query']
    },
    execute(ctx, args) {
      try {
        const chatKey = ctx?.chatKey;
        if (!chatKey) return { content: '没有会话上下文。' };
        const q = String(args?.query || '').trim();
        const picked = selectMemories(store, chatKey, cfg(), q)
          .filter((x) => !args?.tier || x.memory.tier === args.tier);
        if (!picked.length) return { content: '没有找到相关的记忆。' };
        return {
          content: picked.map((x) => `- ${x.memory.content}（id: ${x.memory.id}）`).join('\n')
        };
      } catch (e) {
        return { content: `翻记忆失败：${e?.message || e}` };
      }
    }
  });

  api.registerTool({
    id: 'memory_touch',
    name: '确认用到了某条记忆',
    description: '当你在回复里真的用到了某条记忆（不是只看到），调用它，让这条记忆被巩固。传记忆 id。',
    category: 'memory',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '记忆 id（pm_...）' } },
      required: ['id']
    },
    execute(ctx, args) {
      try {
        const chatKey = ctx?.chatKey;
        const id = String(args?.id || '').trim();
        if (!chatKey || !id) return { content: '缺少会话或记忆 id。' };
        const m = store.get(chatKey, id) || store.all().find((x) => x.memory.id === id)?.memory;
        if (!m) return { content: '没找到这条记忆。' };
        const key = store.all().find((x) => x.memory.id === id)?.chatKey || chatKey;
        const touched = store.touch(key, id, 'use');
        if (touched && touched.tier === 'ordinary' && touched.useCount >= Math.max(1, Number(cfg().promoteRecallCount) || 3)) {
          store.update(key, id, { tier: 'important', strength: Math.max(touched.strength, 0.6) });
        }
        return { content: '记住了，这条记忆被再次确认。' };
      } catch (e) {
        return { content: `确认失败：${e?.message || e}` };
      }
    }
  });

  api.registerTool({
    id: 'memory_reflect',
    name: '现在想一想',
    description: '主动触发一次记忆自审：看看有没有冷却到期的珍贵候选，或者该重新判断的珍贵记忆。平时不用调，后台会自动做。',
    category: 'memory',
    parameters: { type: 'object', properties: {} },
    async execute(ctx) {
      await runReview();
      const c = store.counts(ctx?.chatKey || '');
      return { content: `自审完成。当前：普通 ${c.ordinary}，重要 ${c.important}，珍贵 ${c.precious}，候选 ${c.candidate}。` };
    }
  });

  api.registerTool({
    id: 'memory_status',
    name: '看看自己的记忆',
    description: '查看当前会话的普通/重要/珍贵记忆数量和候选数量。',
    category: 'memory',
    parameters: { type: 'object', properties: {} },
    execute(ctx) {
      try {
        const c = store.counts(ctx?.chatKey || '');
        return { content: `普通 ${c.ordinary} 条，重要 ${c.important} 条，珍贵 ${c.precious} 条，珍贵候选 ${c.candidate} 条。` };
      } catch (e) {
        return { content: `读取失败：${e?.message || e}` };
      }
    }
  });
}

export const providers = {
  // 给 daily-schedule 之类的插件读取“值得写进日程”的重要/珍贵记忆。
  // 只返回当前会话，避免把私聊内容带进群日程。
  'memory.important': (ctx = {}) => {
    try {
      if (!store) return [];
      const chatKey = String(ctx?.chatKey || '');
      if (!chatKey) return [];
      return store.all()
        .filter(({ chatKey: k, memory }) => k === chatKey
          && memory.status === 'active'
          && (memory.tier === 'important' || memory.tier === 'precious'))
        .sort((a, b) => Number(b.memory.strength || 0) - Number(a.memory.strength || 0))
        .slice(0, 8)
        .map(({ memory }) => ({
          tier: memory.tier,
          content: String(memory.content || '').slice(0, 240)
        }));
    } catch {
      return [];
    }
  }
};

export function setup(a) {
  api = a;
  cfg = a?.config || (() => ({}));
  stopTimers();
  store = newStore();
  setRuntime({ store, cfg });
  try { store.pruneAll(cfg()); } catch { /* ignore */ }
  registerTools();
  startTimers();
  log('[plastic-memory] 可塑性记忆已加载');
  return { store };
}

export function promptSections(context = {}) {
  return renderPromptSections(context);
}

export const hooks = {
  'after-response': async (context) => {
    try { scheduleCapture(context); } catch { /* ignore */ }
  }
};

export function deactivate() {
  stopTimers();
  captureTicks.clear();
  capturing.clear();
  capturedSessions.clear();
}

export function dispose() {
  deactivate();
  api = null;
  store = null;
}

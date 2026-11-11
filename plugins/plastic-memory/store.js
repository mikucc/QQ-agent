// 可塑性记忆 · 存储层
//
// 设计原则（和 inner-life / life-memory 一致）：
//   · 纯 JSON，原子写（tmp + rename），失败只降级不抛错；
//   · 每个会话一个文件，跨群检索时再扫全部；
//   · 不依赖数据库，方便人直接打开看、备份、删除。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

export const DEFAULT_ROOT = path.join(DATA_DIR, 'plastic-memory');
const DAY = 86400000;

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function chatFileName(chatKey) {
  return `${String(chatKey || 'unknown').replace(/[^a-z0-9_]/gi, '_')}.json`;
}

function readJson(file, fallback) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

/** 归一化：去空白、标点、符号，转小写。 */
export function normalizeText(s) {
  return String(s ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 二元组重合率（除以较短的一条，长句包含短句时接近 1）。 */
export function similarity(a, b) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return 0;
  const bigrams = (t) => {
    const set = new Set();
    for (let i = 0; i + 1 < t.length; i += 1) set.add(t.slice(i, i + 2));
    return set;
  };
  const A = bigrams(na);
  const B = bigrams(nb);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const x of A) if (B.has(x)) hit += 1;
  return hit / Math.min(A.size, B.size);
}

/** 两条记忆是否像同一件事：归一化相等、短句被长句包含，或字面重合度够高。 */
export function isSameMemory(a, b, threshold = 0.55) {
  const na = normalizeText(a);
  const nb = normalizeText(b);
  if (!na || !nb) return false;
  if (na === nb) return true;
  const short = na.length <= nb.length ? na : nb;
  const long = na.length <= nb.length ? nb : na;
  if (short.length >= 8 && long.includes(short)) return true;
  return similarity(a, b) >= threshold;
}

export function makeMemory(input = {}, now = Date.now()) {
  const content = String(input.content ?? '').trim().slice(0, 600);
  const tier = ['ordinary', 'important', 'precious'].includes(input.tier) ? input.tier : 'ordinary';
  const status = ['active', 'candidate', 'archived', 'expired'].includes(input.status)
    ? input.status
    : 'active';
  return {
    id: input.id || `pm_${now.toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    tier,
    status,
    content,
    summary: String(input.summary ?? '').slice(0, 300),
    subjects: Array.isArray(input.subjects) ? input.subjects.map(String).slice(0, 8) : [],
    sourceMids: Array.isArray(input.sourceMids) ? input.sourceMids.slice(0, 8) : [],
    originChat: String(input.originChat ?? ''),
    scope: ['chat', 'person', 'global'].includes(input.scope) ? input.scope : 'chat',
    visibility: ['private', 'group', 'global'].includes(input.visibility) ? input.visibility : 'group',
    createdAt: Number(input.createdAt) || now,
    lastRecalledAt: Number(input.lastRecalledAt) || 0,
    lastUsedAt: Number(input.lastUsedAt) || 0,
    lastInjectedAt: Number(input.lastInjectedAt) || 0,
    recallCount: Number(input.recallCount) || 0,
    useCount: Number(input.useCount) || 0,
    strength: clamp(input.strength ?? 0.5, 0, 1),
    emotion: clamp(input.emotion ?? 0, 0, 1),
    // 情绪标签：人记得的是"那件事发生时什么感觉"，光有 0~1 的数值模型读不出来。
    emotionLabel: String(input.emotionLabel ?? '').slice(0, 6),
    uniqueness: clamp(input.uniqueness ?? 0, 0, 1),
    selfImpact: clamp(input.selfImpact ?? 0, 0, 1),
    confidence: clamp(input.confidence ?? 0.5, 0, 1),
    preciousReason: String(input.preciousReason ?? '').slice(0, 500),
    evidence: String(input.evidence ?? '').slice(0, 1000),
    candidateSince: Number(input.candidateSince) || 0,
    reviewCount: Number(input.reviewCount) || 0,
    lastReviewedAt: Number(input.lastReviewedAt) || 0,
    preciousAt: Number(input.preciousAt) || 0,
    previousTier: String(input.previousTier ?? ''),
    protected: input.protected === true,
    archivedAt: Number(input.archivedAt) || 0,
    expiredAt: Number(input.expiredAt) || 0,
    updatedAt: Number(input.updatedAt) || now
  };
}

export class PlasticStore {
  constructor(root = DEFAULT_ROOT) {
    this.root = root;
    this.chatsDir = path.join(root, 'chats');
    this.cache = new Map();
  }

  fileOf(chatKey) {
    return path.join(this.chatsDir, chatFileName(chatKey));
  }

  load(chatKey) {
    const key = String(chatKey || '');
    if (this.cache.has(key)) return this.cache.get(key);
    const file = this.fileOf(key);
    const raw = readJson(file, null);
    const state = raw && Array.isArray(raw.memories)
      ? { version: 1, chatKey: key, updatedAt: Number(raw.updatedAt) || 0, memories: raw.memories }
      : { version: 1, chatKey: key, updatedAt: 0, memories: [] };
    this.cache.set(key, state);
    return state;
  }

  save(chatKey, state) {
    const key = String(chatKey || '');
    state.chatKey = key;
    state.updatedAt = Date.now();
    writeJsonAtomic(this.fileOf(key), state);
    this.cache.set(key, state);
    return state;
  }

  listChats() {
    const out = new Set(this.cache.keys());
    try {
      for (const f of fs.readdirSync(this.chatsDir)) {
        if (f.endsWith('.json')) out.add(f.replace(/\.json$/, '').replace(/_/g, ':'));
      }
    } catch { /* 目录还不存在 */ }
    // 缓存里的 key 是真实 chatKey；磁盘还原只能近似，这里优先用缓存。
    return [...out].filter((k) => k.includes(':'));
  }

  all() {
    const out = [];
    for (const chatKey of this.listChats()) {
      const state = this.load(chatKey);
      for (const m of state.memories) out.push({ chatKey, memory: m });
    }
    return out;
  }

  add(chatKey, input, now = Date.now()) {
    const state = this.load(chatKey);
    const content = String(input.content ?? '').trim();
    if (!content) return { memory: null, duplicate: false };
    const hit = state.memories.find((m) => m.status !== 'expired' && isSameMemory(m.content, content));
    if (hit) {
      hit.lastConfirmedAt = now;
      hit.strength = clamp(hit.strength + 0.08, 0, 1);
      hit.updatedAt = now;
      this.save(chatKey, state);
      return { memory: hit, duplicate: true };
    }
    const memory = makeMemory({ ...input, originChat: input.originChat || chatKey }, now);
    state.memories.push(memory);
    this.save(chatKey, state);
    return { memory, duplicate: false };
  }

  get(chatKey, id) {
    return this.load(chatKey).memories.find((m) => m.id === id) || null;
  }

  update(chatKey, id, patch = {}, now = Date.now()) {
    const state = this.load(chatKey);
    const m = state.memories.find((x) => x.id === id);
    if (!m) return null;
    Object.assign(m, patch, { updatedAt: now });
    this.save(chatKey, state);
    return m;
  }

  touch(chatKey, id, kind = 'recall', now = Date.now()) {
    const state = this.load(chatKey);
    const m = state.memories.find((x) => x.id === id);
    if (!m) return null;
    if (kind === 'use') {
      m.useCount += 1;
      m.lastUsedAt = now;
      m.strength = clamp(m.strength + 0.12, 0, 1);
    } else {
      m.recallCount += 1;
      m.lastRecalledAt = now;
      m.strength = clamp(m.strength + 0.05, 0, 1);
    }
    m.updatedAt = now;
    this.save(chatKey, state);
    return m;
  }

  markInjected(chatKey, id, now = Date.now()) {
    const state = this.load(chatKey);
    const m = state.memories.find((x) => x.id === id);
    if (!m) return null;
    m.lastInjectedAt = now;
    m.recallCount += 1;
    m.lastRecalledAt = now;
    m.strength = clamp(m.strength + 0.05, 0, 1);
    m.updatedAt = now;
    this.save(chatKey, state);
    return m;
  }

  remove(chatKey, id) {
    const state = this.load(chatKey);
    const before = state.memories.length;
    state.memories = state.memories.filter((m) => m.id !== id);
    if (state.memories.length !== before) this.save(chatKey, state);
    return state.memories.length !== before;
  }

  counts(chatKey) {
    const state = this.load(chatKey);
    const counts = { ordinary: 0, important: 0, precious: 0, candidate: 0, archived: 0, expired: 0 };
    for (const m of state.memories) {
      if (m.status === 'candidate') counts.candidate += 1;
      else if (m.status === 'archived') counts.archived += 1;
      else if (m.status === 'expired') counts.expired += 1;
      else if (counts[m.tier] !== undefined) counts[m.tier] += 1;
    }
    return counts;
  }

  countPrecious(chatKey) {
    return this.load(chatKey).memories.filter((m) => m.tier === 'precious' && m.status === 'active').length;
  }

  preciousPromotionsThisWeek(chatKey, now = Date.now()) {
    const since = now - 7 * DAY;
    return this.load(chatKey).memories.filter((m) => m.tier === 'precious' && m.preciousAt >= since).length;
  }

  prune(chatKey, cfg = {}, now = Date.now()) {
    const state = this.load(chatKey);
    const ordinaryTtl = Math.max(1, Number(cfg.ordinaryTtlDays) || 3) * DAY;
    const importantTtl = Math.max(1, Number(cfg.importantTtlDays) || 14) * DAY;
    const preciousArchive = Math.max(1, Number(cfg.preciousArchiveDays) || 30) * DAY;
    const grace = Math.max(1, Number(cfg.expiredGraceDays) || 7) * DAY;
    let changed = false;
    const keep = [];
    for (const m of state.memories) {
      const last = Number(m.lastUsedAt || m.lastRecalledAt || m.createdAt || now);
      const age = Math.max(0, now - last);

      if (m.status === 'expired') {
        if (now - (m.expiredAt || now) >= grace) { changed = true; continue; }
        keep.push(m);
        continue;
      }
      if (m.status === 'archived') {
        keep.push(m);
        continue;
      }
      if (m.status === 'candidate') {
        keep.push(m);
        continue;
      }

      if (m.tier === 'ordinary' && age >= ordinaryTtl) {
        m.status = 'expired';
        m.expiredAt = now;
        changed = true;
      } else if (m.tier === 'important' && age >= importantTtl) {
        m.status = 'archived';
        m.archivedAt = now;
        m.summary = m.summary || String(m.content || '').slice(0, 160);
        changed = true;
      } else if (m.tier === 'precious' && age >= preciousArchive) {
        m.status = 'archived';
        m.archivedAt = now;
        m.protected = true;
        m.summary = m.summary || String(m.content || '').slice(0, 160);
        changed = true;
      }
      keep.push(m);
    }
    state.memories = keep;
    if (changed) this.save(chatKey, state);
    return state;
  }

  pruneAll(cfg = {}, now = Date.now()) {
    let changed = 0;
    for (const chatKey of this.listChats()) {
      const before = this.load(chatKey).memories.length;
      this.prune(chatKey, cfg, now);
      const after = this.load(chatKey).memories.length;
      if (after !== before) changed += 1;
    }
    return changed;
  }

  dueCandidates(cfg = {}, now = Date.now()) {
    const cooldown = Math.max(1, Number(cfg.candidateCooldownHours) || 12) * 3600000;
    const recallThreshold = Math.max(1, Number(cfg.candidateRecallThreshold) || 3);
    const out = [];
    for (const { chatKey, memory } of this.all()) {
      if (memory.status !== 'candidate') continue;
      const dueByTime = memory.candidateSince && now - memory.candidateSince >= cooldown;
      const dueByRecall = memory.recallCount >= recallThreshold;
      if (dueByTime || dueByRecall) out.push({ chatKey, memory });
    }
    return out;
  }

  preciousForReview(cfg = {}, now = Date.now()) {
    const days = Math.max(1, Number(cfg.preciousReviewDays) || 7);
    const out = [];
    for (const { chatKey, memory } of this.all()) {
      if (memory.status !== 'active' || memory.tier !== 'precious') continue;
      if (now - Number(memory.lastReviewedAt || 0) >= days * DAY) out.push({ chatKey, memory });
    }
    return out;
  }
}

export { clamp, DAY };

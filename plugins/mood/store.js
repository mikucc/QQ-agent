// 心情 · 状态存储
//
// 全局一份（跨群一致），原子写；失败只降级。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const FILE = path.join(DATA_DIR, 'mood', 'state.json');

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

export function dayKey(ts = Date.now()) {
  const d = new Date(ts);
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

export function defaultState(now = Date.now()) {
  const energy = 0.55 + Math.random() * 0.25;
  const social = 0.5 + Math.random() * 0.25;
  const valence = -0.1 + Math.random() * 0.35;
  const arousal = 0.3 + Math.random() * 0.25;
  return {
    version: 1,
    dayKey: dayKey(now),
    baseline: { valence, arousal, energy, socialBattery: social },
    valence,
    arousal,
    energy,
    socialBattery: social,
    moodLabel: labelFor({ valence, energy, socialBattery: social }),
    causes: [],
    lastInteractionAt: 0,
    lastInitAt: 0,
    updatedAt: now
  };
}

export function loadState(now = Date.now()) {
  try {
    let text = fs.readFileSync(FILE, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const raw = JSON.parse(text);
    return normalize(raw, now);
  } catch {
    return defaultState(now);
  }
}

export function saveState(state) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const tmp = `${FILE}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, FILE);
  } catch { /* 心情失败不影响聊天 */ }
}

export function normalize(raw, now = Date.now()) {
  const d = defaultState(now);
  const s = { ...d, ...(raw && typeof raw === 'object' ? raw : {}) };
  s.version = 1;
  s.dayKey = String(s.dayKey || dayKey(now));
  s.valence = clamp(s.valence, -1, 1);
  s.arousal = clamp(s.arousal, 0, 1);
  s.energy = clamp(s.energy, 0, 1);
  s.socialBattery = clamp(s.socialBattery, 0, 1);
  s.baseline = {
    valence: clamp(s.baseline?.valence ?? s.valence, -1, 1),
    arousal: clamp(s.baseline?.arousal ?? s.arousal, 0, 1),
    energy: clamp(s.baseline?.energy ?? s.energy, 0, 1),
    socialBattery: clamp(s.baseline?.socialBattery ?? s.socialBattery, 0, 1)
  };
  s.causes = Array.isArray(s.causes) ? s.causes.map(String).slice(-5) : [];
  s.lastInteractionAt = Number(s.lastInteractionAt) || 0;
  s.lastInitAt = Number(s.lastInitAt) || 0;
  s.updatedAt = Number(s.updatedAt) || now;
  s.moodLabel = String(s.moodLabel || labelFor(s));
  return s;
}

export function labelFor(s) {
  const v = Number(s.valence) || 0;
  const e = Number(s.energy) || 0;
  const social = Number(s.socialBattery) || 0;
  if (e < 0.3) return '没电了，有点困';
  if (social < 0.3) return '不太想说话，想安静一会儿';
  if (v < -0.35) return '有点低落';
  if (v > 0.35 && e > 0.55) return '心情不错，有点精神';
  if (v > 0.15) return '心情还行';
  return '普普通通，没什么起伏';
}

/** 综合心情分：越高越有精神/越愿意说话。 */
export function moodScore(s) {
  const v = (clamp(s.valence, -1, 1) + 1) / 2;
  return clamp(0.45 * v + 0.35 * clamp(s.energy, 0, 1) + 0.2 * clamp(s.socialBattery, 0, 1), 0, 1);
}

/**
 * 低心情时的沉默概率。
 * 不只看综合分：社交电量/精力极低时也算低心情，避免出现
 * “标签写着不想说话，但沉默概率是 0”的不一致。
 */
export function suppressChances(s, cfg = {}) {
  const threshold = Math.max(0.1, Math.min(0.9, Number(cfg.lowMoodThreshold) || 0.5));
  const score = moodScore(s);
  const social = clamp(s.socialBattery, 0, 1);
  const energy = clamp(s.energy, 0, 1);
  const scoreLow = score >= threshold
    ? 0
    : clamp((threshold - score) / Math.max(0.01, threshold - 0.15), 0, 1);
  const socialLow = clamp((0.28 - social) / 0.28, 0, 1) * 0.8;
  const energyLow = clamp((0.32 - energy) / 0.32, 0, 1) * 0.7;
  const factor = Math.max(scoreLow, socialLow, energyLow);
  if (factor <= 0) return { score, reply: 0, proactive: 0 };
  const replyMax = clamp(Number(cfg.replySuppressChance) || 0.05, 0, 0.2);
  const proMax = clamp(Number(cfg.proactiveSuppressChance) || replyMax * 2, 0, 0.3);
  return {
    score,
    reply: Math.min(replyMax, replyMax * factor),
    // 保持和普通回复 1:2；主动上限不会超过普通上限的两倍。
    proactive: Math.min(proMax, replyMax * 2 * factor)
  };
}

/**
 * 按“距离上次互动多久”恢复。
 * 只回拉到 baseline，不会自己变开心；每天模型初始化仍然会重定 baseline。
 */
export function recoverMood(raw, now = Date.now()) {
  const s = normalize(raw, now);
  const last = Number(s.lastInteractionAt || s.updatedAt || now);
  const idleMin = Math.max(0, (now - last) / 60000);
  if (idleMin < 5) return s;
  const socialPull = Math.min(1, idleMin / 120);   // 2 小时回满
  const energyPull = Math.min(1, idleMin / 180);   // 3 小时回满
  const arousalPull = Math.min(1, idleMin / 120);
  s.socialBattery = clamp(s.socialBattery + (s.baseline.socialBattery - s.socialBattery) * socialPull, 0, 1);
  s.energy = clamp(s.energy + (s.baseline.energy - s.energy) * energyPull, 0, 1);
  s.arousal = clamp(s.arousal + (s.baseline.arousal - s.arousal) * arousalPull, 0, 1);
  s.valence = clamp(s.valence + (s.baseline.valence - s.valence) * Math.min(0.2, idleMin / 600), -1, 1);
  s.moodLabel = labelFor(s);
  s.updatedAt = now;
  return s;
}

/** 小幅更新；有惯性，避免一句话让心情过山车。 */
export function applyDelta(s, { valence = 0, arousal = 0, energy = 0, social = 0 } = {}, cause = '') {
  s.valence = clamp(s.valence + valence, -1, 1);
  s.arousal = clamp(s.arousal * 0.8 + arousal * 0.2, 0, 1);
  s.energy = clamp(s.energy + energy, 0, 1);
  s.socialBattery = clamp(s.socialBattery + social, 0, 1);
  s.lastInteractionAt = Date.now();
  s.updatedAt = Date.now();
  s.moodLabel = labelFor(s);
  if (cause) {
    s.causes = [...new Set([...(s.causes || []), String(cause).slice(0, 80)])].slice(-5);
  }
  return s;
}

export { FILE, clamp };

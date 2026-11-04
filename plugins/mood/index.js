// 心情 · 入口
//
// 全局状态：valence / arousal / energy / socialBattery。
// 每天第一次 before-context 用主模型初始化；after-response 轻量调整；
// 每轮 promptSections 注入【你此刻的状态】。
// 对外能力：mood.current（注意力门用）、proactive.gate（主动消息用）。
import { dailyInitIfNeeded } from './init.js';
import {
  applyDelta,
  loadState,
  moodScore,
  normalize,
  recoverMood,
  saveState,
  suppressChances
} from './store.js';

let api = null;
let cfg = () => ({});
let state = null;
const appraisedSessions = new Set();

function log(...args) {
  try { api?.log?.(...args); } catch { /* ignore */ }
}

function on() {
  return cfg()?.enabled !== false;
}

function ensureState() {
  if (!state) state = loadState();
  state = normalize(state);
  return state;
}

function level(n) {
  const x = Number(n) || 0;
  if (x < 0.3) return '低';
  if (x < 0.6) return '中';
  return '高';
}

function latestText(entries = []) {
  return entries.map((e) => String(e?.text || '')).filter(Boolean).join('\n').slice(0, 500);
}

function appraise(context = {}) {
  if (!on()) return;
  const sid = String(context?.session?.id || '');
  if (sid && appraisedSessions.has(sid)) return;
  if (sid) appraisedSessions.add(sid);
  if (appraisedSessions.size > 5000) appraisedSessions.clear();
  const s = ensureState();
  const entries = Array.isArray(context?.session?.trigger) ? context.session.trigger : [];
  const text = latestText(entries);
  if (!text) return;

  const positive = /哈哈|开心|喜欢|可爱|谢谢|厉害|牛|好耶|夸|温柔|抱抱|贴贴/.test(text);
  const negative = /怼|气死|无语|难过|烦|滚|骂|讨厌|哭|难受|破防/.test(text);
  const addressed = entries.some((e) => e && !e.self && (e.atMe === true || e.isPoke === true));
  const conflict = /吵|别烦|闭嘴|滚|生气|不理你/.test(text);

  let dv = 0;
  let da = 0;
  if (positive) { dv += 0.05; da += 0.03; }
  if (negative) { dv -= 0.06; da += 0.02; }
  if (conflict) dv -= 0.04;
  if (addressed) dv += 0.02;

  const energy = -0.008 * Math.max(1, Math.min(6, entries.length));
  const social = -0.015 * Math.max(1, Math.min(6, entries.length)) + (positive ? 0.01 : 0);
  const cause = positive ? '刚才聊得挺开心' : (negative || conflict ? '刚才有点被消耗' : '');
  applyDelta(s, { valence: dv, arousal: da, energy, social }, cause);
  s.moodLabel = s.moodLabel || '';
  saveState(s);
  log(`[心情] ${s.moodLabel}｜valence ${s.valence.toFixed(2)} energy ${s.energy.toFixed(2)} social ${s.socialBattery.toFixed(2)}`);
}

export const providers = {
  'mood.current': () => {
    state = recoverMood(ensureState());
    const s = state;
    const sup = suppressChances(s, cfg());
    return {
      ...s,
      score: sup.score,
      suppress: { reply: sup.reply, proactive: sup.proactive },
      replySuppressChance: sup.reply,
      proactiveSuppressChance: sup.proactive
    };
  },
  'proactive.gate': () => {
    if (!on()) return { allow: true };
    state = recoverMood(ensureState());
    const s = state;
    const sup = suppressChances(s, cfg());
    if (sup.proactive > 0 && Math.random() < sup.proactive) {
      return { allow: false, reason: `心情低（${s.moodLabel}，${Math.round(sup.proactive * 100)}% 抑制）` };
    }
    return { allow: true, reason: s.moodLabel };
  },
  'status.mood': () => {
    state = recoverMood(ensureState());
    const s = state;
    const sup = suppressChances(s, cfg());
    return {
      icon: '🌤️',
      title: '心情',
      priority: 56,
      lines: [
        ['心情', s.moodLabel],
        ['多巴胺/精力', `valence ${s.valence.toFixed(2)}｜energy ${s.energy.toFixed(2)}｜social ${s.socialBattery.toFixed(2)}`],
        ['沉默概率', `普通 ${Math.round(sup.reply * 100)}%｜主动 ${Math.round(sup.proactive * 100)}%（仅低心情时）`],
        ['原因', (s.causes || []).join('；') || '（没有特别原因）']
      ]
    };
  }
};

export const hooks = {
  'before-context': async () => {
    if (!on()) return;
    try {
      // 先按“多久没互动”恢复，再判断是否需要每日初始化。
      state = recoverMood(ensureState());
      state = await dailyInitIfNeeded(state, cfg());
      saveState(state);
    } catch { /* 初始化失败不阻塞 */ }
  },
  'after-response': (context = {}) => {
    try { appraise(context); } catch { /* ignore */ }
  }
};

export function promptSections() {
  try {
    if (!on()) return [];
    state = recoverMood(ensureState());
    const s = state;
    const sup = suppressChances(s, cfg());
    const energy = level(s.energy);
    const social = level(s.socialBattery);
    const effect = [];
    if (sup.reply > 0) effect.push('今天不太想主动接话，能短就短，能不接就不接');
    else if (s.energy < 0.35) effect.push('有点没电，回复短一点，别硬撑');
    else if (s.valence > 0.3 && s.energy > 0.6) effect.push('精神不错，可以自然多聊两句');
    const content = [
      '【你此刻的状态】',
      `- 心情：${s.moodLabel}`,
      `- 精力：${energy}；社交电量：${social}`,
      (s.causes || []).length ? `- 原因：${(s.causes || []).slice(-2).join('；')}` : '',
      effect.length ? `- 状态影响：${effect.join('；')}` : '',
      '- 不要向群友报数值，也不要说“我的心情值是……”。这只是你说话的状态。'
    ].filter(Boolean).join('\n');
    return [{ id: 'mood-state', title: '你此刻的状态', priority: 56, content }];
  } catch {
    return [];
  }
}

export async function setup(a) {
  api = a;
  cfg = a?.config || (() => ({}));
  state = loadState();
  state = normalize(state);
  log(`[心情] 已加载：${state.moodLabel}（energy ${state.energy.toFixed(2)} / social ${state.socialBattery.toFixed(2)}）`);
}

export function deactivate() {
  try { if (state) saveState(state); } catch { /* ignore */ }
  appraisedSessions.clear();
}

export function dispose() {
  deactivate();
  state = null;
}

export const internals = {
  get state() { return state; },
  moodScore,
  suppressChances
};

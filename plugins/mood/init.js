// 心情 · 每日初始化
//
// 每天第一次运行：读昨天日记 + 昨天心情 + 最近记忆，让主模型生成今天的
// baseline。失败时退回规则（保留昨天状态 + 随机扰动），绝不阻塞聊天。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { chatCompletion, resolveApiKey } from '../../src/llm.js';
import { dayKey, defaultState, labelFor, normalize, saveState } from './store.js';

let initializing = false;

function clamp(n, min, max) {
  const x = Number(n);
  if (!Number.isFinite(x)) return min;
  return Math.max(min, Math.min(max, x));
}

function readDiary(limit = 8) {
  try {
    const file = path.join(DATA_DIR, '日记', 'diary.jsonl');
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    const rows = text.split(/\r?\n/).filter(Boolean).slice(-limit);
    const out = [];
    for (const row of rows) {
      try {
        const o = JSON.parse(row);
        const t = String(o.text || o.content || o.entry || '').trim();
        if (t) out.push(t.slice(0, 300));
      } catch { /* 跳过坏行 */ }
    }
    return out;
  } catch {
    return [];
  }
}

function apiConf() {
  const c = getConfig();
  const api = c.api || {};
  return {
    baseUrl: String(api.baseUrl || '').trim(),
    apiKey: String(resolveApiKey(c) || '').trim(),
    model: String(api.model || '').trim()
  };
}

function parseJson(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
}

async function askModel(prev, diary) {
  const api = apiConf();
  if (!api.baseUrl || !api.model || !api.apiKey) return null;
  const c = getConfig();
  const botName = String(c.persona?.botName || '这个角色');
  const system = [
    `你是「${botName}」。现在是新的一天，你要给自己定一个初始心情。`,
    '参考昨天的日记、昨天结束时的情绪、最近的生活；不要编造日记里没有的重大事件。',
    '输出 JSON，不要 markdown：',
    '{"valence":-1到1,"arousal":0到1,"energy":0到1,"socialBattery":0到1,"moodLabel":"一句自然的话","causes":["原因1","原因2"]}',
    '说明：valence 越高兴奋度；arousal 越激动；energy 精力；socialBattery 想不想理人。',
    '要像人：不要每天都一样，也不要把随机数写进理由。'
  ].join('\n');
  const user = [
    `昨天结束时的状态：valence=${prev.valence.toFixed(2)}, arousal=${prev.arousal.toFixed(2)}, energy=${prev.energy.toFixed(2)}, socialBattery=${prev.socialBattery.toFixed(2)}`,
    prev.causes?.length ? `昨天挂着的情绪原因：${prev.causes.join('；')}` : '',
    diary.length ? `昨天的日记：\n- ${diary.join('\n- ')}` : '昨天没有日记记录。',
    '请给出今天的初始状态。'
  ].filter(Boolean).join('\n\n');

  try {
    const r = await chatCompletion({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.7,
      maxTokens: 300,
      overrides: { ...api, timeoutMs: 45000 }
    });
    const content = r?.message?.content;
    return parseJson(typeof content === 'string' ? content : '');
  } catch {
    return null;
  }
}

function fallback(prev, now) {
  const next = defaultState(now);
  const jitter = () => (Math.random() - 0.5) * 0.16;
  next.valence = clamp(prev.valence + jitter(), -1, 1);
  next.arousal = clamp(prev.arousal + jitter() * 0.6, 0, 1);
  next.energy = clamp(0.55 + Math.random() * 0.3, 0, 1);
  next.socialBattery = clamp(0.5 + Math.random() * 0.3, 0, 1);
  next.baseline = {
    valence: next.valence,
    arousal: next.arousal,
    energy: next.energy,
    socialBattery: next.socialBattery
  };
  next.moodLabel = labelFor(next);
  next.causes = prev.causes?.slice(-2) || [];
  next.lastInitAt = now;
  return next;
}

/**
 * 每天第一次运行调用；全局只初始化一次。
 * 注意：即使模型失败也会写 lastInitAt，避免每条消息都重试。
 */
export async function dailyInitIfNeeded(rawState, cfg = {}, now = Date.now()) {
  let state = normalize(rawState, now);
  const today = dayKey(now);
  if (state.dayKey === today && state.lastInitAt > 0) return state;
  if (cfg.dailyInit === false) {
    state.dayKey = today;
    state.lastInitAt = now;
    saveState(state);
    return state;
  }
  if (initializing) return state;
  initializing = true;
  try {
    const prev = normalize(rawState, now);
    const model = await askModel(prev, readDiary());
    const next = defaultState(now);
    next.dayKey = today;
    next.lastInitAt = now;
    if (model) {
      next.valence = clamp(model.valence ?? prev.valence, -1, 1);
      next.arousal = clamp(model.arousal ?? prev.arousal, 0, 1);
      next.energy = clamp(model.energy ?? prev.energy, 0, 1);
      next.socialBattery = clamp(model.socialBattery ?? prev.socialBattery, 0, 1);
      next.baseline = {
        valence: next.valence,
        arousal: next.arousal,
        energy: next.energy,
        socialBattery: next.socialBattery
      };
      next.moodLabel = String(model.moodLabel || labelFor(next)).slice(0, 80);
      next.causes = Array.isArray(model.causes) ? model.causes.map(String).slice(0, 3) : [];
    } else {
      Object.assign(next, fallback(prev, now));
      next.dayKey = today;
      next.lastInitAt = now;
    }
    state = normalize(next, now);
    saveState(state);
    return state;
  } finally {
    initializing = false;
  }
}

export { readDiary, askModel };

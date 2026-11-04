// 注意力门 · 群聊唤醒前的本地判断
//
// 核心在 orchestrator.wake 里、drain 出完整批次之后、#runAgent 之前调用
// message.attention 能力。本插件只做本地规则，绝不调模型。
//
// 规则顺序：
//   ① 在跟她说话（@ 她 / 回复她 / 拍一拍 / 叫名字）→ 必醒
//   ② 别人有明确对象（@ 别人 / 回复别人 / 点名问某人）→ 默认沉默
//   ③ 最短间隔 / 每小时上限
//   ④ 兴趣加权掷骰子：基础 + 兴趣词 + 问句 + 情绪 + @全体 + 主人
//
// dryRun 只记录、不拦截：返回 wake:true，但日志会写“本来会沉默”。
import { getConfig } from '../../src/config.js';
import { NameBook, clean, valid } from './names.js';

let api = null;
let nameBook = null;
const lastWake = new Map();       // chatKey -> ts
const lastWakeSender = new Map(); // chatKey -> 这次唤醒对应的人
const wakeLog = new Map();        // chatKey -> ts[]
const lastSpokeAt = new Map();    // chatKey -> ts（她真的发出消息的时间）
const lastSpokeSender = new Map();// chatKey -> 她最后回复的人
const observedSessions = new Set();

function log(...args) {
  try { api?.log?.(...args); } catch { /* ignore */ }
}

function settings() {
  let raw = {};
  try { raw = (typeof api?.config === 'function' ? api.config() : null) || {}; } catch { raw = {}; }
  return {
    enabled: raw.enabled !== false,
    dryRun: raw.dryRun === true,
    interjectChance: num(raw.interjectChance, 15, 0, 100),
    keywords: parseList(raw.interestKeywords),
    questionBonus: num(raw.questionBonus, 20, 0, 100),
    emotionBonus: num(raw.emotionBonus, 15, 0, 100),
    interestBonus: num(raw.interestBonus, 35, 0, 100),
    atAllBonus: num(raw.atAllBonus, 10, 0, 100),
    ownerBonus: num(raw.ownerBonus, 15, 0, 100),
    minGapSeconds: num(raw.minGapSeconds, 15, 0, 86400),
    continuationWindowSeconds: num(raw.continuationWindowSeconds, 120, 0, 3600),
    maxWakePerHour: num(raw.maxWakePerHour, 60, 1, 10000),
    aliases: parseList(raw.aliases),
    logDecisions: raw.logDecisions !== false
  };
}

function num(v, d, min = 0, max = 100000) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : d;
}

function parseList(v) {
  return String(v ?? '')
    .split(/\r?\n|[,，、;；]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

function names() {
  if (nameBook) return nameBook.activeList();
  const cfg = getConfig() || {};
  const out = new Set();
  for (const n of [cfg.persona?.botName, cfg.persona?.selfNickname, ...settings().aliases]) {
    const s = String(n || '').trim();
    if (s.length >= 2) out.add(s);
  }
  return [...out];
}

function ownerIds() {
  try {
    const cfg = getConfig() || {};
    return new Set(parseList(cfg.skills?.['owner-identity']?.ids));
  } catch {
    return new Set();
  }
}

function addressedToMe(e, selfId = '', aliases = []) {
  if (!e || typeof e !== 'object') return false;
  if (e.atMe === true) return true;
  if (e.isPoke === true) return true;
  if (selfId && String(e.reply?.senderId ?? '') === String(selfId)) return true;
  const text = String(e.text ?? '');
  return aliases.some((name) => name && text.includes(name));
}

function pointedAtOther() {
  return false;   // 已放弃“判断在叫谁”；只认叫她自己的硬信号，其余交给兴趣和提示词。
}

const isQuestion = (t) => /[?？]|吗[。！？!?]?$|怎么|为什么|为啥|如何|多少|哪[个里]|是不是|能不能|可不可以/.test(String(t || ''));
const hasEmotion = (t) => /哈哈|嘿嘿|嘻嘻|笑死|草|卧槽|我去|无语|麻了|气死|哭了|呜呜|烦死|崩溃|绝了|离谱|太[好棒牛强]|牛逼|难受|开心|难过|激动|惊了|震惊/.test(String(t || ''));

/* ── 她自己的称呼：显式命名 / 被叫到时的候选 ───────────────────────── */

function explicitName(text) {
  const s = String(text || '');
  const patterns = [
    /(?:以后|之后|往后)?(?:就)?叫你([\u4e00-\u9fa5A-Za-z0-9_]{1,8})/,
    /我叫你([\u4e00-\u9fa5A-Za-z0-9_]{1,8})/,
    /你是([\u4e00-\u9fa5A-Za-z0-9_]{1,8})吗/
  ];
  for (const re of patterns) {
    const m = s.match(re);
    if (m?.[1]) {
      const name = clean(m[1]);
      if (valid(name)) return name;
    }
  }
  return '';
}

function vocativeName(text) {
  const s = String(text || '').trim();
  let m = s.match(/^([\u4e00-\u9fa5A-Za-z0-9_]{2,8})[，,：:]/);
  if (m?.[1]) {
    const name = clean(m[1]);
    if (valid(name)) return name;
  }
  // 句尾", xxx" 只在整句很短时才算称呼（"早啊，小鲸鱼"）；
  // 长句尾巴是正文（"@肥鱼 你测了多少次" 曾被收成"测了多少次"）。
  if (s.length <= 12) {
    m = s.match(/[，,]\s*([\u4e00-\u9fa5A-Za-z0-9_]{2,8})\s*[?？]?$/);
    if (m?.[1]) {
      const name = clean(m[1]);
      if (valid(name)) return name;
    }
  }
  return '';
}

function observeNames(context = {}) {
  try {
    if (!nameBook || settings().enabled === false) return;
    const sid = String(context?.session?.id || '');
    if (sid && observedSessions.has(sid)) return;
    if (sid) observedSessions.add(sid);
    const entries = Array.isArray(context?.session?.trigger) ? context.session.trigger : [];
    const owners = ownerIds();
    const selfId = String(getConfig()?.onebot?.selfId || '');
    for (const e of entries) {
      if (!e || e.self) continue;
      const text = String(e?.text || '');
      const evidence = String(e?.mid ?? e?.id ?? '');
      const explicit = explicitName(text);
      if (explicit) {
        if (owners.has(String(e.senderId ?? ''))) {
          nameBook.explicit(explicit, 'explicit-owner', evidence);
          log(`[称呼] 主人明确命名：${explicit}`);
        } else {
          nameBook.candidate(explicit, 'explicit', evidence);
        }
      }
      // 只有“明确在跟她说话”的消息，才把句首/句尾的称呼当作候选；
      // 普通聊天里叫别人（“徐院，人呢”）不会被收进来。
      if (e.atMe === true || (selfId && String(e.reply?.senderId ?? '') === selfId) || e.isPoke === true) {
        const cand = vocativeName(text);
        if (cand) {
          nameBook.candidate(cand, 'addressed', evidence);
          log(`[称呼] 候选：${cand}`);
        }
      }
    }
    nameBook.review();
  } catch (error) {
    log(`[称呼] 维护失败：${error?.message || error}`);
  }
}


function recordSpoke(context = {}) {
  try {
    const chatKey = String(context?.chatKey || '');
    const session = context?.session;
    if (!chatKey || !session) return;
    if (!Array.isArray(session.sent) || session.sent.length === 0) return;
    lastSpokeAt.set(chatKey, Date.now());
    const trigger = Array.isArray(session.trigger) ? session.trigger : [];
    const lastOther = [...trigger].reverse().find((e) => e && !e.self);
    if (lastOther?.senderId) lastSpokeSender.set(chatKey, String(lastOther.senderId));
  } catch { /* ignore */ }
}

function recentWakes(chatKey, now) {
  const list = (wakeLog.get(chatKey) || []).filter((ts) => now - ts < 3600000);
  wakeLog.set(chatKey, list);
  return list;
}

function recordWake(chatKey, now, senderId = '') {
  const list = recentWakes(chatKey, now);
  list.push(now);
  wakeLog.set(chatKey, list);
  lastWake.set(chatKey, now);
  if (senderId) lastWakeSender.set(chatKey, String(senderId));
}

function lastSenderOf(entries = []) {
  const list = [...entries].reverse().find((e) => e && !e.self && e.senderId);
  return list ? String(list.senderId) : '';
}

function decide(ctx = {}) {
  const s = settings();
  const result = decideInner(ctx, s);
  if (s.logDecisions) log(`[${String(ctx.chatKey || '')}] ${result.wake ? '唤醒' : '沉默'}｜${result.reason}`);
  return result;
}

function decideInner(ctx = {}, s = settings()) {
  if (!s.enabled) return { wake: true, reason: '注意力门已关闭' };

  // 当前群的群名片是最可靠的自称：协议端给了就自动收进来，不用人维护。
  const card = String(ctx.selfCard || '').trim();
  if (nameBook && card && !nameBook.activeNames().has(card)) {
    try { nameBook.explicit(card, 'group-card'); } catch { /* ignore */ }
  }

  const entries = (Array.isArray(ctx.entries) ? ctx.entries : []).filter((e) => e && !e.self);
  if (!entries.length) return { wake: true, reason: '没有可判断的消息' };

  const chatKey = String(ctx.chatKey || '');
  const selfId = String(ctx.selfId || '');
  const aliases = names();
  const joined = entries.map((e) => String(e?.text ?? '')).join('\n');

  // ① 在跟她说话 → 必醒
  const addressed = entries.some((e) => addressedToMe(e, selfId, aliases));
  if (addressed) {
    if (!s.dryRun) recordWake(chatKey, Date.now(), lastSenderOf(entries));
    return { wake: true, reason: '在跟她说话（@ / 回复 / 拍一拍 / 叫名字）', score: 100 };
  }

  // ② 不再判断“别人有明确对象”。只认叫她自己的硬信号；其余按兴趣，
  //    醒了之后由提示词约束“明显在叫别人就不要接”。

  const now = Date.now();
  // ③ 对话延续：她刚回过这个人，或对方紧接着说“你”，优先当作接着聊，
  //    不套用“主动搭话”的最短间隔。否则连续对话会被 15 秒误伤。
  const contWindow = Math.max(0, Number(s.continuationWindowSeconds) || 120) * 1000;
  // 优先用“真的发出”的时间；after-response 跑在工具执行之前时 sent 还是空的，
  // 所以再用“刚唤醒”的时间兜底：她刚被叫醒并回了这个人，也算对话延续。
  const spokeAt = lastSpokeAt.get(chatKey) || lastWake.get(chatKey) || 0;
  if (contWindow > 0 && spokeAt > 0 && now - spokeAt < contWindow) {
    const lastTo = lastSpokeSender.get(chatKey) || lastWakeSender.get(chatKey) || '';
    const sameSender = lastTo && entries.some((e) => String(e.senderId ?? '') === String(lastTo));
    const mentionsYou = entries.some((e) => /(你|您)/.test(String(e?.text || '')));
    if (sameSender || mentionsYou) {
      if (!s.dryRun) recordWake(chatKey, now, lastSenderOf(entries));
      return { wake: true, reason: '对话延续（刚回过对方 / 对方在说“你”）', score: 100 };
    }
  }

  const last = lastWake.get(chatKey) || 0;
  if (s.minGapSeconds > 0 && last > 0 && now - last < s.minGapSeconds * 1000) {
    const left = Math.ceil((s.minGapSeconds * 1000 - (now - last)) / 1000);
    if (s.dryRun) return { wake: true, reason: `演练：本来会沉默（刚醒过，${left} 秒内不主动）`, score: 0 };
    return { wake: false, reason: `刚醒过，${left} 秒内不主动` , score: 0 };
  }

  const wakes = recentWakes(chatKey, now);
  if (wakes.length >= s.maxWakePerHour) {
    if (s.dryRun) return { wake: true, reason: `演练：本来会沉默（本小时已醒 ${wakes.length} 次）`, score: 0 };
    return { wake: false, reason: `本小时已醒 ${wakes.length} 次，达到上限`, score: 0 };
  }

  // ③ 兴趣加权
  let chance = s.interjectChance;
  const why = [`基础 ${s.interjectChance}%`];
  const hitKw = s.keywords.filter((k) => joined.includes(k));
  if (hitKw.length) {
    chance += s.interestBonus;
    why.push(`命中兴趣词「${hitKw.slice(0, 3).join('、')}」+${s.interestBonus}%`);
  }
  if (entries.some((e) => e.atAll === true)) {
    chance += s.atAllBonus;
    why.push(`@全体 +${s.atAllBonus}%`);
  }
  if (isQuestion(joined)) {
    chance += s.questionBonus;
    why.push(`是问句 +${s.questionBonus}%`);
  }
  if (hasEmotion(joined)) {
    chance += s.emotionBonus;
    why.push(`带情绪 +${s.emotionBonus}%`);
  }
  const owners = ownerIds();
  if (entries.some((e) => owners.has(String(e.senderId ?? '')))) {
    chance += s.ownerBonus;
    why.push(`主人 +${s.ownerBonus}%`);
  }
  chance = Math.max(0, Math.min(100, chance));

  const roll = Math.random() * 100;
  const speak = roll < chance;
  const reason = `${why.join('，')} → 掷到 ${Math.round(roll)}，${speak ? '这次醒' : '这次沉默'}`;

  if (s.dryRun) {
    return { wake: true, reason: `演练：${reason}`, score: chance };
  }
  if (speak) {
    // 心情低时，普通唤醒有最多 5% 概率沉默；硬相关不走这里。
    try {
      const mood = api?.capability?.('mood.current', { chatKey });
      const suppress = Number(mood?.suppress?.reply ?? mood?.replySuppressChance ?? 0);
      if (suppress > 0 && Math.random() < suppress) {
        return { wake: false, reason: `心情低（${mood?.moodLabel || '状态不好'}），这次不太想接`, score: chance };
      }
    } catch { /* 心情插件坏了不影响唤醒 */ }
    recordWake(chatKey, now, lastSenderOf(entries));
  }
  return { wake: speak, reason, score: chance };
}

export const providers = {
  'message.attention': decide,
  'status.attention-gate': () => {
    const s = settings();
    return {
      icon: '🚪',
      title: '注意力门',
      priority: 58,
      lines: [
        ['状态', s.enabled ? (s.dryRun ? '演练中（只记录，不拦截）' : '运行中') : '已关闭'],
        ['范围', '只群聊；私聊永远唤醒'],
        ['必醒', '@ / 回复 / 拍一拍 / 叫她的名字'],
        ['默认', '没有叫她时按兴趣；不判断“在叫哪个群友”'],
        ['主动概率', `基础 ${s.interjectChance}% + 兴趣 ${s.interestBonus} + 问句 ${s.questionBonus} + 情绪 ${s.emotionBonus} + 主人 ${s.ownerBonus}`],
        ['限流', `${s.minGapSeconds} 秒间隔；每小时最多 ${s.maxWakePerHour} 次`]
      ]
    };
  }
};

export function setup(a) {
  api = a;
  nameBook = new NameBook();
  const s = settings();
  const cfg = getConfig() || {};
  nameBook.bootstrap({
    botName: cfg.persona?.botName || '',
    selfNickname: cfg.persona?.selfNickname || '',
    aliases: s.aliases
  });
  log(`已加载：${s.dryRun ? '演练模式（只记录）' : '运行模式'}｜基础 ${s.interjectChance}%｜兴趣词 ${s.keywords.length} 个｜称呼 ${nameBook.activeList().join('、')}｜最短 ${s.minGapSeconds} 秒`);
}

export const hooks = {
  'after-response': (context = {}) => {
    try { recordSpoke(context); } catch { /* ignore */ }
    try { observeNames(context); } catch { /* 称呼维护失败不影响聊天 */ }
  }
};

export function promptSections() {
  try {
    if (!settings().enabled) return [];
    const list = names();
    if (!list.length) return [];
    const content = [
      '【关于称呼】',
      `别人可能这样叫你：${list.join('、')}。`,
      '- 只有叫这些名字、@ 你、回复你，才算在叫你。',
      '- 明显在叫别人（“徐院，人呢”“在吗，徐院”）：不要接，也不要自嘲式插话。',
      '- 不确定是不是叫你：沉默，或只问“是叫我吗”。'
    ].join('\n');
    return [{ id: 'attention-self-names', title: '称呼与分寸', priority: 56, content }];
  } catch {
    return [];
  }
}

export function available() {
  return settings().enabled !== false;
}

export function deactivate() {
  try { nameBook?.save(); } catch { /* ignore */ }
  lastWake.clear();
  lastWakeSender.clear();
  wakeLog.clear();
  lastSpokeAt.clear();
  lastSpokeSender.clear();
  observedSessions.clear();
}

export function dispose() {
  deactivate();
}

export const internals = {
  decide,
  settings,
  addressedToMe,
  pointedAtOther,
  explicitName,
  vocativeName,
  observeNames,
  recordSpoke,
  isQuestion,
  hasEmotion
};

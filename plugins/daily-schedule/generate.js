// 每日日程 · 生成、校验、修补
import { getConfig } from '../../src/config.js';
import { chatCompletion, resolveApiKey } from '../../src/llm.js';
import {
  loadDay,
  minutesToTime,
  recentSummaries,
  timeToMinutes
} from './store.js';
import {
  dayTypeName,
  pickDayType,
  templateFor
} from './templates.js';

const DAY = 1440;

function shiftDateStr(date, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function clampText(s, n) {
  return String(s ?? '').trim().slice(0, n);
}

function parseJson(text) {
  let s = String(text ?? '').trim();
  s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  // 先整体试：模型有时直接返回裸数组 [{...},{...}]，原实现只截 {} 会把数组拼坏。
  try { return JSON.parse(s); } catch { /* 继续兜底 */ }
  // 再从文本里截取括号块：对象优先，数组次之（哪个能解析用哪个）。
  const pairs = [
    ['{', '}'],
    ['[', ']']
  ];
  for (const [open, close] of pairs) {
    const first = s.indexOf(open);
    const last = s.lastIndexOf(close);
    if (first < 0 || last <= first) continue;
    try { return JSON.parse(s.slice(first, last + 1)); } catch { /* 试下一种 */ }
  }
  return null;
}

function fill(start, end) {
  return {
    start: minutesToTime(start),
    end: minutesToTime(end),
    activity: '休息',
    location: '家',
    with: '',
    note: ''
  };
}

/** 排序、去重叠、补空档、限制段数；保证 00:00~24:00。 */
export function normalizeSegments(raw, max = 10) {
  const list = [];
  for (const item of Array.isArray(raw) ? raw : []) {
    const start = timeToMinutes(item?.start);
    const end = timeToMinutes(item?.end);
    if (start === null || end === null || end <= start) continue;
    const activity = clampText(item?.activity, 80);
    if (!activity) continue;
    list.push({
      start: Math.max(0, Math.min(DAY, start)),
      end: Math.max(0, Math.min(DAY, end)),
      activity,
      location: clampText(item?.location, 40) || '家',
      with: clampText(item?.with, 40),
      note: clampText(item?.note, 120)
    });
  }
  list.sort((a, b) => a.start - b.start || a.end - b.end);

  const out = [];
  let cursor = 0;
  for (const s of list) {
    let start = Math.max(cursor, s.start);
    const end = Math.max(start, s.end);
    if (end <= start) continue;
    if (start > cursor) out.push(fill(cursor, start));
    out.push({
      start: minutesToTime(start),
      end: minutesToTime(end),
      activity: s.activity,
      location: s.location,
      with: s.with,
      note: s.note
    });
    cursor = end;
    if (cursor >= DAY) break;
  }
  if (cursor < DAY) out.push(fill(cursor, DAY));

  // 超过上限：合并相邻两段中总时长最短的一组，直到 <= max。
  while (out.length > max) {
    let best = 0;
    let bestLen = Infinity;
    for (let i = 0; i + 1 < out.length; i += 1) {
      const a = timeToMinutes(out[i].start);
      const b = timeToMinutes(out[i].end);
      const c = timeToMinutes(out[i + 1].start);
      const d = timeToMinutes(out[i + 1].end);
      const len = (b - a) + (d - c);
      if (len < bestLen) { bestLen = len; best = i; }
    }
    const a = out[best];
    const b = out[best + 1];
    out.splice(best, 2, {
      start: a.start,
      end: b.end,
      activity: a.activity === b.activity ? a.activity : `${a.activity}，然后${b.activity}`,
      location: a.location === b.location ? a.location : '外面',
      with: a.with || b.with,
      note: a.note || b.note
    });
  }
  return out;
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

function buildPrompt({ date, weekday, dayType, cfg, mood, memories }) {
  const c = getConfig();
  const botName = String(c.persona?.botName || '这个角色');
  const persona = String(c.persona?.roleText || '').trim().slice(0, 1800);
  const weekdayName = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][weekday] || '';
  const bible = String(cfg.lifeBible || '').trim();
  const special = String(cfg.specialRequest || '').trim();
  const recent = recentSummaries(3)
    .map((r) => `${r.date}（${dayTypeName(r.dayType)}）：${r.activities.join('；')}`)
    .join('\n') || '（还没有历史日程）';
  // 昨天的结尾：让新一天的凌晨段接着写（避免"昨晚洗过澡、凌晨又安排洗澡"）
  const prevDate = shiftDateStr(date, -1);
  const prevTail = ((loadDay(prevDate)?.segments) || [])
    .filter((s) => !/睡觉/.test(s.activity))
    .slice(-2)
    .map((s) => `${s.start}-${s.end} ${s.activity}`)
    .join('；');
  const memoryText = (memories || []).slice(0, 6)
    .map((m) => `- ${m.tier === 'precious' ? '[珍贵] ' : ''}${m.content}`)
    .join('\n') || '（没有需要写进日程的记忆）';
  const moodText = mood
    ? `精力 ${Math.round(Number(mood.energy || 0) * 100)}%，社交电量 ${Math.round(Number(mood.socialBattery || 0) * 100)}%，心情：${mood.moodLabel || ''}`
    : '（心情未知）';

  const system = [
    `你是「${botName}」的生活编剧，只负责写她明天真实、平淡、连贯的一天。`,
    '不是写小说，不出现超自然、战斗、犯罪、真实地址和真实隐私。',
    '她的生活要符合人设和生活圣经；作息像普通年轻人，可以有懒散、摸鱼、临时改变，但不要自相矛盾。',
    `日程必须从 00:00 覆盖到 24:00，${Math.max(1, Number(cfg.segmentsMin) || 6)}~${Math.max(1, Number(cfg.segmentsMax) || 15)} 段，时间不能重叠，不要写“按计划”“日程表”这种词。`,
    '活动要具体：睡觉、吃饭、写稿、散步、便利店、看剧、洗澡。不要每段都写“工作”。',
    '如果精力低/社交电量低，多安排宅家、休息、睡觉；如果精力高，可以安排出门。',
    prevTail
      ? `昨晚的结尾：${prevTail}。今天的凌晨段要接着它写：昨晚已经洗过澡，凌晨就别再安排洗澡，只写刷牙洗脸或直接睡。`
      : '今天凌晨段要和昨晚自然衔接，不要凭空重复洗澡。',
    '只输出 JSON，不要 markdown：',
    '{"segments":[{"start":"00:00","end":"07:30","activity":"睡觉","location":"家","with":"","note":""}]}'
  ].join('\n');

  const user = [
    `日期：${date}（${weekdayName}）`,
    `类型：${dayTypeName(dayType)}`,
    persona ? `人设（只取前 1800 字）：\n${persona}` : '',
    bible ? `生活圣经：\n${bible}` : '',
    recent ? `最近三天：\n${recent}` : '',
    `今天的心情：${moodText}`,
    memoryText !== '（没有需要写进日程的记忆）' ? `重要记忆：\n${memoryText}` : '',
    special ? `特别要求：${special}` : '',
    '请输出明天的完整日程 JSON。'
  ].filter(Boolean).join('\n\n');

  return { system, user };
}

async function modelGenerate(args) {
  const api = apiConf();
  if (!api.baseUrl || !api.model || !api.apiKey) {
    return { error: `日程模型未配置（baseUrl=${api.baseUrl ? '有' : '空'}，model=${api.model || '空'}，apiKey=${api.apiKey ? '有' : '空'}）` };
  }
  const { system, user } = buildPrompt(args);
  const call = (maxTokens) => chatCompletion({
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user }
    ],
    temperature: 0.85,
    maxTokens,
    overrides: { ...api, timeoutMs: 60000 }
  });
  try {
    // 900 不够：这个模型每次先花 200~300 个 reasoning token，正文很容易在中途被截断
    //（实测 5 次里 3 次 finish_reason=length、JSON 断在段中间，于是整轮退化成模板兜底）。
    let r = await call(2400);
    if (r?.finishReason === 'length') r = await call(4096);   // 真的截断了：加倍预算重打一次
    const content = r?.message?.content;
    const data = parseJson(typeof content === 'string' ? content : '');
    if (!data) {
      const len = String(content ?? '').length;
      return { error: `模型没有返回合法 JSON（finish=${r?.finishReason ?? '?'}，正文 ${len} 字）` };
    }
    const segments = normalizeSegments(Array.isArray(data) ? data : data?.segments, args.cfg?.segmentsMax || 10);
    if (segments.length < Math.max(1, Number(args.cfg?.segmentsMin) || 6)) {
      return { error: `模型只返回 ${segments.length} 段，少于最低要求` };
    }
    return { segments };
  } catch (error) {
    return { error: String(error?.message || error).slice(0, 300) };
  }
}

/**
 * 转场那一刻的"刚……"。
 *
 * 每次转场**实时生成**，不查固定模板，所以同一天不同转场、同一个转场隔天都不会重复。
 * 这个模型会先花 reasoning token，给 160 这种小预算会正文为空——实测 600 起才稳定，
 * 空回时自动加倍重试一次。失败返回 null，调用方就不写（宁缺勿错）。
 */
export async function generateMoment({ from = '', to = '', now = Date.now(), mood = null, cfg = {} } = {}) {
  const api = apiConf();
  if (!api.baseUrl || !api.model || !api.apiKey) return null;
  const d = new Date(now);
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const moodText = mood
    ? `精力 ${Math.round(Number(mood.energy || 0) * 100)}%，社交电量 ${Math.round(Number(mood.socialBattery || 0) * 100)}%`
    : '正常';
  const call = async (maxTokens) => {
    const r = await chatCompletion({
      messages: [
        {
          role: 'system',
          content: [
            '你在写一个普通女孩生活里的"转场瞬间"。',
            '输入是"上一段在做什么 → 下一段做什么"，请写一句以「刚」开头的现场细节。',
            '要求：只写看得见、听得见、摸得着的东西（手里的东西、身上的状态、声音、光线、温度），10~18 字；',
            '不要写心情总结、不要写"感觉"、不要提日程/计划/时间表；不要加引号。',
            '例：刚换好鞋，钥匙还在手里 / 刚洗完，头发还滴着水 / 刚进门，袋子上还挂着水珠。'
          ].join('\n')
        },
        {
          role: 'user',
          content: `上一段：${from}\n下一段：${to}\n时间：${hh}\n状态：${moodText}\n只输出那一句。`
        }
      ],
      temperature: 0.9,
      maxTokens,
      overrides: { ...api, timeoutMs: 30000 }
    });
    return String(r?.message?.content || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  };
  try {
    const base = Math.max(400, Number(cfg.momentMaxTokens) || 800);
    let text = await call(base);
    if (!text) text = await call(Math.min(2400, base * 2));   // reasoning 吃光预算时加倍重试一次
    if (!text) return null;
    text = text.replace(/[。．.!！~～]+$/, '').trim();
    if (!text.startsWith('刚')) text = `刚${text.replace(/^[，,。\s]+/, '')}`;
    return text.slice(0, 24);
  } catch {
    return null;
  }
}

// 默认衣柜（manifest 里也有同名配置；读不到时用这份兜底，测试/旧配置也不会空）
const DEFAULT_WARDROBE = {
  outside: '外出外套,外出卫衣,外出衬衫',
  home: '居家服,居家运动,居家旧T',
  sleep: '睡衣,睡衣丝质,睡衣T恤'
};

/**
 * 每天从衣柜里选一套（出门/在家/睡前各一套）。
 * 用日期做种子：同一天多次调用结果一致，重启也不会换；换一天就换一套。
 */
export function ensureWardrobe(day, cfg = {}) {
  if (!day) return day;
  if (day.wardrobe?.outside && day.wardrobe?.home && day.wardrobe?.sleep) return day;
  const pick = (text) => {
    const list = String(text || '').split(/[,，\s]+/).map((s) => s.trim()).filter(Boolean);
    if (!list.length) return '';
    const seed = `${day.date}|${list.join('|')}`;
    let h = 0;
    for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return list[h % list.length];
  };
  day.wardrobe = {
    outside: pick(cfg.wardrobeOutside || DEFAULT_WARDROBE.outside),
    home: pick(cfg.wardrobeHome || DEFAULT_WARDROBE.home),
    sleep: pick(cfg.wardrobeSleep || DEFAULT_WARDROBE.sleep)
  };
  return day;
}

/**
 * 确保某天有日程。优先用模型；失败时用模板，modelFailed=true 交由调用方重试。
 */
export async function ensureDay({ date, cfg = {}, mood = null, memories = [], force = false, existing = null, log = () => {} } = {}) {
  if (!force && existing?.segments?.length) {
    return { day: ensureWardrobe(existing, cfg), modelFailed: false };
  }
  const weekday = new Date(`${date}T12:00:00`).getDay();
  const dayType = existing?.dayType || pickDayType({
    weekend: weekday === 0 || weekday === 6,
    weightsText: cfg.dayTypeWeights
  });

  const generated = await modelGenerate({ date, weekday, dayType, cfg, mood, memories });
  const segments = generated?.segments;
  if (segments?.length) {
    log(`[日程] ${date} 模型生成 ${segments.length} 段`);
    return {
      day: ensureWardrobe({
        date,
        dayType,
        generatedAt: Date.now(),
        generatedBy: 'model',
        segments,
        adjustments: existing?.adjustments || []
      }, cfg),
      modelFailed: false
    };
  }

  log(`[日程] ${date} 模型失败${generated?.error ? `：${generated.error}` : ''}，使用模板兜底`);
  return {
    day: ensureWardrobe({
      date,
      dayType,
      generatedAt: Date.now(),
      generatedBy: 'template',
      segments: normalizeSegments(templateFor(dayType), cfg.segmentsMax || 10),
      adjustments: existing?.adjustments || []
    }, cfg),
    modelFailed: true
  };
}

export { buildPrompt, modelGenerate };

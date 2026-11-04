// 每日日程 · 入口
//
// 全局一份虚构生活。每天 23:30 生成明天；启动/跨天补今天；每轮注入此刻。
import fs from 'node:fs';
import path from 'node:path';
import { getConfig } from '../../src/config.js';
import { chatCompletion, resolveApiKey } from '../../src/llm.js';
import { ensureDay, normalizeSegments } from './generate.js';
import { renderSchedule, currentSegment } from './prompt.js';
import {
  addAdjustment,
  DAYS_DIR,
  loadDay,
  minutesToTime,
  nowParts,
  ROOT,
  saveDay,
  timeToMinutes
} from './store.js';
import { dayTypeName } from './templates.js';

// ── 转场事件（"刚……"）的存储 ──
// 为什么不放 store.js：热重载只重新 import 入口文件，依赖模块命中 ESM 缓存；
// 给 store.js 新增导出会让热重载报 "does not provide an export named ..."，
// 旧实例被保留、新代码永远进不来（2026-11-05 踩过）。入口文件里的函数没这个问题。
function eventsFile(date) {
  return path.join(ROOT, `${date}.events.json`);
}

function loadEvents(date) {
  try {
    const text = fs.readFileSync(eventsFile(date), 'utf8').replace(/^\uFEFF/, '');
    const data = JSON.parse(text);
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function appendEvent(date, ev) {
  try {
    const list = loadEvents(date);
    list.push(ev);
    fs.mkdirSync(ROOT, { recursive: true });
    const file = eventsFile(date);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(list.slice(-40), null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
  return ev;
}

function latestEvent(date, now = Date.now()) {
  return loadEvents(date)
    .filter((e) => Number(e.at) <= now && now < Number(e.expiresAt))
    .sort((a, b) => Number(b.at) - Number(a.at))[0] || null;
}

// ── 转场文案（实时生成）──
// 同样放在入口文件里：见上面 eventsFile 的注释（热重载 + ESM 缓存）。
// 每次转场现写一句，所以不会出现"每天同一句"的重复感；失败就不写。
function momentApi() {
  const c = getConfig();
  const api = c.api || {};
  return {
    baseUrl: String(api.baseUrl || '').trim(),
    apiKey: String(resolveApiKey(c) || '').trim(),
    model: String(api.model || '').trim()
  };
}

// 转场句子的"角度"池：每次随机指定一类，避免每次都是"耳机/头发/手"同一种写法。
const MOMENT_ANGLES = [
  '身体残留：手、头发、耳朵、皮肤现在的状态',
  '声音：楼道、风声、水声、键盘、塑料袋',
  '物品细节：手里/桌上/袋子里具体的东西',
  '光线与温度：灯、窗外、风、被子里的温度',
  '动作刚完成的瞬间：坐下、起身、放下、脱下',
  '气味：洗发水、饭、咖啡、雨后的味道',
  '衣服与穿戴：袜子、外套、发圈、鞋'
];

function bigrams(s) {
  const t = String(s || '').replace(/[\s\p{P}]/gu, '');
  const out = new Set();
  for (let i = 0; i + 1 < t.length; i += 1) out.add(t.slice(i, i + 2));
  return out;
}

/** 和最近说过的话太像（二元组重合 ≥45%）就算重复。 */
function tooSimilar(text, recent = []) {
  const a = bigrams(text);
  if (!a.size) return false;
  return recent.some((r) => {
    const b = bigrams(r);
    if (!b.size) return false;
    let inter = 0;
    for (const x of a) if (b.has(x)) inter += 1;
    return inter / Math.min(a.size, b.size) >= 0.45;
  });
}

async function generateMomentText({ from = '', to = '', now = Date.now(), mood = null, cfg: conf = {}, recent = [] } = {}) {
  const api = momentApi();
  if (!api.baseUrl || !api.model || !api.apiKey) return null;
  const d = new Date(now);
  const hh = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  const moodText = mood
    ? `精力 ${Math.round(Number(mood.energy || 0) * 100)}%，社交电量 ${Math.round(Number(mood.socialBattery || 0) * 100)}%`
    : '正常';
  const recentText = (recent || []).slice(-6).map((t) => `- ${t}`).join('\n') || '（还没有）';

  const call = async (maxTokens, angle) => {
    const r = await chatCompletion({
      messages: [
        {
          role: 'system',
          content: [
            '你在写一个普通女孩生活里的"转场瞬间"。',
            '输入是"上一段在做什么 → 下一段做什么"，请写一句现场细节。',
            `这一次只写【${angle}】这一类，不要写别的类别。`,
            '要求：只写看得见、听得见、摸得着的东西；8~18 字；不要以「刚」开头（展示时会自动加“（刚）”）；',
            '不要写心情总结、不要写"感觉"、不要提日程/计划/时间表；不要加引号。',
            '句式要变：可以是一个短语、一个名词句、一句没头没尾的观察，不一定是"刚XX，YY还ZZ"。',
            '例：头发梢还在滴水 / 楼道里有人关门 / 耳机挂在脖子上 / 杯子外壁一层水 / 被子还是暖的。'
          ].join('\n')
        },
        {
          role: 'user',
          content: `上一段：${from}\n下一段：${to}\n时间：${hh}\n状态：${moodText}\n\n最近用过的句子（不要和它们重复，词、意象、结构都别撞）：\n${recentText}\n\n只输出那一句。`
        }
      ],
      temperature: 1.0,
      maxTokens,
      overrides: { ...api, timeoutMs: 45000 }
    });
    return String(r?.message?.content || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
  };
  try {
    const base = Math.max(400, Number(conf.momentMaxTokens) || 800);
    let text = '';
    // 最多两次：第一次按随机角度，和最近太像就换个角度重写一次
    for (let i = 0; i < 2; i += 1) {
      const angle = MOMENT_ANGLES[Math.floor(Math.random() * MOMENT_ANGLES.length)];
      let t = await call(base, angle);
      if (!t) t = await call(Math.min(2400, base * 2), angle);
      if (!t) continue;
      t = t.replace(/^刚[，,]?/, '').replace(/[。．.!！~～]+$/, '').trim();
      if (!t) continue;
      text = t;
      if (!tooSimilar(t, recent)) break;
    }
    if (!text) return null;
    return text.slice(0, 24);
  } catch {
    return null;
  }
}

let api = null;
let cfg = () => ({});
let timer = null;
let boot = null;
let lastChatKey = '';
const working = new Set();
const retryTimers = new Map();
const retryCount = new Map();

// 默认衣柜（manifest 里也有同名配置；读不到时用这份兜底）
const DEFAULT_WARDROBE = {
  outside: '外出外套,外出卫衣,外出衬衫',
  home: '居家服,居家运动,居家旧T',
  sleep: '睡衣,睡衣丝质,睡衣T恤',
  hairOutside: '松松散散的高马尾，额前留几缕碎发|自然披散，发尾微卷|侧边低马尾，耳侧夹一枚小发夹',
  hairHome: '随手扎起的丸子头，碎发掉在耳侧|用夹子随手夹起，露出后颈|低低的双马尾，有点松',
  hairSleep: '完全披散，压在枕头上有点乱|松松的低马尾，没扎紧|披散着，额头碎发被睡乱'
};

/** 每天出门/在家/睡前各随机一套衣服 + 一个发型（用日期做种子：同一天固定，换天换一套）。 */
function ensureWardrobe(day, conf = {}) {
  if (!day) return day;
  const done = day.wardrobe?.outside && day.wardrobe?.home && day.wardrobe?.sleep
    && day.wardrobe?.hairOutside && day.wardrobe?.hairHome && day.wardrobe?.hairSleep;
  if (done) return day;
  const hash = (seed) => {
    let h = 0;
    for (let i = 0; i < seed.length; i += 1) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    return h;
  };
  const pickList = (text, sep) => String(text || '').split(sep).map((s) => s.trim()).filter(Boolean);
  const pick = (text, sep) => {
    const list = pickList(text, sep);
    if (!list.length) return '';
    return list[hash(`${day.date}|${list.join('|')}`) % list.length];
  };
  day.wardrobe = {
    outside: pick(conf.wardrobeOutside || DEFAULT_WARDROBE.outside, /[,，\s]+/),
    home: pick(conf.wardrobeHome || DEFAULT_WARDROBE.home, /[,，\s]+/),
    sleep: pick(conf.wardrobeSleep || DEFAULT_WARDROBE.sleep, /[,，\s]+/),
    hairOutside: pick(conf.wardrobeHairOutside || DEFAULT_WARDROBE.hairOutside, /[|｜\n]+/),
    hairHome: pick(conf.wardrobeHairHome || DEFAULT_WARDROBE.hairHome, /[|｜\n]+/),
    hairSleep: pick(conf.wardrobeHairSleep || DEFAULT_WARDROBE.hairSleep, /[|｜\n]+/)
  };
  return day;
}

/**
 * 读当天日程并带上衣柜。
 * 运行中的进程可能还缓存着旧版 store.js（loadDay 不返回 wardrobe），
 * 这里直接从文件补一次；重启后 store.js 自己就会带出来。
 */
function loadDayFull(date) {
  const day = loadDay(date);
  if (!day) return null;
  if (!day.wardrobe) {
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(DAYS_DIR, `${date}.json`), 'utf8').replace(/^\uFEFF/, ''));
      if (raw?.wardrobe && typeof raw.wardrobe === 'object') day.wardrobe = raw.wardrobe;
    } catch { /* ignore */ }
  }
  return day;
}

function log(...args) {  try { api?.log?.(...args); } catch { /* ignore */ }
}

function on() {
  return cfg()?.enabled !== false;
}

function tz() {
  return String(cfg()?.timezone || 'Asia/Shanghai');
}

function today() {
  return nowParts(Date.now(), tz()).date;
}

function shiftDate(date, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function weekdayOf(date) {
  return new Date(`${date}T12:00:00`).getDay();
}

function moodNow() {
  try { return api?.capability?.('mood.current', {}) || null; } catch { return null; }
}

function memoriesNow(chatKey = '') {
  try { return api?.capability?.('memory.important', { chatKey }) || []; } catch { return []; }
}

async function ensureDate(date, { force = false, chatKey = '', silent = false } = {}) {
  if (!date) return null;
  if (working.has(date)) {
    const existing = loadDay(date);
    return existing;
  }
  const existing = loadDay(date);
  if (existing && !force) return existing;

  working.add(date);
  try {
    const result = await ensureDay({
      date,
      cfg: cfg(),
      mood: moodNow(),
      memories: memoriesNow(chatKey),
      force,
      existing,
      log
    });
    saveDay(result.day);
    // 衣柜：每天出门/在家/睡前各一套（同一天固定）。放在入口文件里做，
    // 避免给 generate.js 新增导出 —— 热重载只重载入口，依赖走 ESM 缓存会报错。
    const beforeW = JSON.stringify(result.day.wardrobe || null);
    ensureWardrobe(result.day, cfg());
    if (JSON.stringify(result.day.wardrobe || null) !== beforeW) saveDay(result.day);
    if (result.modelFailed) scheduleRetry(date);
    if (!silent) log(`[日程] ${date} 已生成（${result.day.generatedBy}，${result.day.segments.length} 段）`);
    return result.day;
  } catch (error) {
    log(`[日程] ${date} 生成异常：${error?.message || error}`);
    return existing;
  } finally {
    working.delete(date);
  }
}

function scheduleRetry(date) {
  if (retryTimers.has(date)) return;
  const count = retryCount.get(date) || 0;
  if (count >= 2) return;
  retryCount.set(date, count + 1);
  const minutes = Math.max(1, Number(cfg()?.retryMinutes) || 20);
  const t = setTimeout(() => {
    retryTimers.delete(date);
    if (!on()) return;
    void ensureDate(date, { force: true, silent: true });
  }, minutes * 60000);
  t.unref?.();
  retryTimers.set(date, t);
}

function tick() {
  if (!on()) return;
  try {
    const now = nowParts(Date.now(), tz());
    const todayDate = now.date;
    const todayDay = loadDay(todayDate);
    if (!todayDay) void ensureDate(todayDate, { chatKey: lastChatKey, silent: true });
    else if (todayDay.generatedBy === 'template') scheduleRetry(todayDate);
    // 生成时间读配置（原来硬编码 23:30，UI 上改了 generateHour/generateMinute 不生效）。
    const genHour = Math.min(23, Math.max(0, Number(cfg()?.generateHour ?? 23)));
    const genMinute = Math.min(59, Math.max(0, Number(cfg()?.generateMinute ?? 30)));
    const afterGen = now.hour > genHour || (now.hour === genHour && now.minute >= genMinute);
    if (afterGen) {
      const tomorrow = shiftDate(todayDate, 1);
      const tomorrowDay = loadDay(tomorrow);
      if (!tomorrowDay) void ensureDate(tomorrow, { chatKey: lastChatKey, silent: true });
      else if (tomorrowDay.generatedBy === 'template') scheduleRetry(tomorrow);
    }
    // 段切换 → 生成一条"刚……"
    maybeMoment(now, loadDay(todayDate));
  } catch { /* 日程失败不影响聊天 */ }
}

// ── 转场事件（"刚……"）────────────────────────────────────────────────
// 每分钟 tick 检测段切换；切换后调一次很小的模型，写一句现场细节，
// 15 分钟内注入提示词，过期自动消失。失败就不写（宁缺勿错）。
const lastSegKey = new Map();   // date -> 段 key
const momentCount = new Map();  // date -> 已生成条数
const lastMomentAt = new Map(); // date -> 上次生成时间

function maybeMoment(now, day) {
  try {
    if (!on() || cfg()?.momentEnabled === false) return;
    if (!day?.segments?.length) return;
    const cur = currentSegment(day, now);
    if (!cur) return;
    const key = `${now.date}|${cur.index}|${cur.start}`;
    const prevKey = lastSegKey.get(now.date);
    lastSegKey.set(now.date, key);
    // 启动/跨天后的第一轮只记录，不补发（避免开机就冒一条"刚……"）
    if (!prevKey || prevKey === key) return;
    const prevSeg = day.segments[cur.index - 1];
    const from = String(prevSeg?.activity || '');
    const to = String(cur.activity || '');
    if (!from || !to) return;
    if (/睡觉/.test(to)) return;                       // 不去写"刚躺下"
    if (/睡觉/.test(from) && /睡觉/.test(to)) return;   // 睡→睡
    const nowTs = Date.now();
    const gapMin = Math.max(0, Number(cfg()?.momentMinGapMin ?? 6));
    if (nowTs - Number(lastMomentAt.get(now.date) || 0) < gapMin * 60000) return;
    const maxPerDay = Math.max(0, Number(cfg()?.momentMaxPerDay ?? 12));
    if (Number(momentCount.get(now.date) || 0) >= maxPerDay) return;
    momentCount.set(now.date, Number(momentCount.get(now.date) || 0) + 1);
    lastMomentAt.set(now.date, nowTs);
    void (async () => {
      const recent = loadEvents(now.date).slice(-6).map((e) => String(e.text || '')).filter(Boolean);
      const text = await generateMomentText({ from, to, now: nowTs, mood: moodNow(), cfg: cfg(), recent });
      if (!text) return;
      const ttl = Math.max(1, Number(cfg()?.momentTtlMin ?? 15)) * 60000;
      appendEvent(now.date, { at: nowTs, from, to, text, expiresAt: nowTs + ttl });
      log(`[日程] 转场 ${from} → ${to}｜${text}`);
    })();
  } catch { /* 转场失败不影响聊天 */ }
}

function formatDay(day) {
  if (!day) return '（没有日程）';
  return day.segments.map((s) => {
    const where = s.location ? `（${s.location}）` : '';
    const who = s.with ? `，和${s.with}` : '';
    const note = s.note ? `，${s.note}` : '';
    return `${s.start}-${s.end}  ${s.activity}${where}${who}${note}`;
  }).join('\n');
}

function readDayArg(arg) {
  const todayDate = today();
  const key = String(arg || 'today').toLowerCase();
  if (key === 'tomorrow' || key === '明天') return { date: shiftDate(todayDate, 1), label: '明天' };
  if (key === 'yesterday' || key === '昨天') return { date: shiftDate(todayDate, -1), label: '昨天' };
  return { date: todayDate, label: '今天' };
}

function registerTools() {
  api.registerTool({
    id: 'schedule_view',
    name: '查看自己的日程',
    description: '查看今天/明天/昨天的完整日程。想知道“我今天/明天大概做什么”时用；返回后不要把时间表念给群友。',
    category: 'knowledge',
    parameters: {
      type: 'object',
      properties: {
        day: { type: 'string', enum: ['today', 'tomorrow', 'yesterday'], description: '默认 today' }
      }
    },
    execute(_ctx, args) {
      const { date, label } = readDayArg(args?.day);
      const day = loadDay(date);
      if (!day) return { content: `${label}还没有日程。` };
      return {
        content: `${label}（${date}，${dayTypeName(day.dayType)}）：\n${formatDay(day)}`
      };
    }
  });

  api.registerTool({
    id: 'schedule_adjust',
    name: '临时改自己的计划',
    description: '被约出去、突然想散步、要加班、被叫回家、临时改主意时，改今天的日程。调用前先过三问：谁在要求（主人/熟人/没印象的陌生人）、他是否认真（有理由/在催 vs 起哄）、你自己想不想动（在睡觉/累了就不动）。只改今天/未来，不改过去；改完后续注入会跟着变。不要对群友说“我调整了日程”，自然地说决定就好。',
    category: 'knowledge',
    parameters: {
      type: 'object',
      properties: {
        start: { type: 'string', description: '开始时间 HH:MM' },
        end: { type: 'string', description: '结束时间 HH:MM' },
        activity: { type: 'string', description: '做什么' },
        location: { type: 'string', description: '在哪（可选）' },
        with: { type: 'string', description: '和谁（可选）' },
        note: { type: 'string', description: '备注（可选）' }
      },
      required: ['start', 'end', 'activity']
    },
    execute(ctx, args) {
      try {
        const start = timeToMinutes(args?.start);
        const end = timeToMinutes(args?.end);
        const activity = String(args?.activity || '').trim().slice(0, 80);
        if (start === null || end === null || end <= start || !activity) {
          return { content: '时间或活动不合法，没改。' };
        }
        const now = nowParts(Date.now(), tz());
        const nowMin = now.hour * 60 + now.minute;
        if (end <= nowMin) return { content: '已经过去的时间改不了。' };
        const date = today();
        const day = loadDay(date);
        if (!day) return { content: '今天还没有日程，先等它生成。' };
        const maxAdjust = Math.max(1, Number(cfg()?.maxAdjustPerDay) || 3);
        if ((day.adjustments || []).length >= maxAdjust) {
          return { content: `今天已经改过 ${maxAdjust} 次了，先这样吧。` };
        }
        const next = [];
        for (const s of day.segments) {
          const ss = timeToMinutes(s.start);
          const se = timeToMinutes(s.end);
          if (se <= start || ss >= end) { next.push(s); continue; }
          if (ss < start) next.push({ ...s, end: minutesToTime(start) });
          if (se > end) next.push({ ...s, start: minutesToTime(end) });
        }
        next.push({
          start: minutesToTime(start),
          end: minutesToTime(end),
          activity,
          location: String(args?.location || '').trim().slice(0, 40) || '外面',
          with: String(args?.with || '').trim().slice(0, 40),
          note: String(args?.note || '').trim().slice(0, 120)
        });
        day.segments = normalizeSegments(next, cfg()?.segmentsMax || 10);
        addAdjustment(day, { start, end, activity });
        saveDay(day);
        return { content: `改好了：${minutesToTime(start)}-${minutesToTime(end)} ${activity}。` };
      } catch (e) {
        return { content: `改日程失败：${e?.message || e}` };
      }
    }
  });

  api.registerTool({
    id: 'schedule_current',
    name: '我现在在做什么',
    description: '查看此刻在做什么、在哪、接下来一段。聊天里需要对齐“现在”时用。',
    category: 'knowledge',
    parameters: { type: 'object', properties: {} },
    execute() {
      const day = loadDayFull(today());
      const cur = currentSegment(day, nowParts(Date.now(), tz()));
      if (!cur) return { content: '现在没有日程。' };
      const where = cur.location ? `，在${cur.location}` : '';
      return { content: `${cur.activity}${where}。` };
    }
  });
}

export function setup(a) {
  api = a;
  cfg = a?.config || (() => ({}));
  if (timer) clearInterval(timer);
  if (boot) clearTimeout(boot);
  timer = setInterval(tick, 60000);
  timer.unref?.();
  boot = setTimeout(tick, 5000);
  boot.unref?.();
  log('[日程] 已加载');
}

export const hooks = {
  'before-context': beforeContext
};

export function promptSections(context = {}) {
  try {
    if (!on()) return [];
    if (cfg().injectAll === false) return [];
    const nowMs = Date.now();
    const now = nowParts(nowMs, tz());
    const day = loadDayFull(now.date);
    if (!day) return [];
    // 老日程没有衣柜：按日期补一套并存回去（同一天不会再变）
    const beforeW = JSON.stringify(day.wardrobe || null);
    ensureWardrobe(day, cfg());
    if (JSON.stringify(day.wardrobe || null) !== beforeW) saveDay(day);
    let text = renderSchedule(day, now, cfg());
    if (!text) return [];
    // 转场后的"刚……"：只在该转场后 momentTtlMin 分钟内出现，紧跟在"你此刻"后面读着自然
    const ev = latestEvent(now.date, nowMs);
    if (ev?.text) {
      const lines = text.split('\n');
      const at = lines.findIndex((l) => l.startsWith('你此刻：'));
      if (at >= 0) lines.splice(at + 1, 0, `（刚）${ev.text}`);
      else lines.push(`（刚）${ev.text}`);
      text = lines.join('\n');
    }
    return [{ id: 'daily-schedule', title: '你今天的生活', priority: 55, content: text }];
  } catch {
    return [];
  }
}

export async function beforeContext(context = {}) {
  if (!on()) return;
  try {
    lastChatKey = String(context?.chatKey || lastChatKey || '');
    const todayDate = today();
    if (!loadDay(todayDate)) {
      await ensureDate(todayDate, { chatKey: context?.chatKey || '' });
    }
    const now = nowParts(Date.now(), tz());
    if (now.hour > 23 || (now.hour === 23 && now.minute >= 30)) {
      const tomorrow = shiftDate(todayDate, 1);
      if (!loadDay(tomorrow)) void ensureDate(tomorrow, { chatKey: context?.chatKey || '' });
    }
  } catch { /* 日程失败不影响聊天 */ }
}

export const providers = {
  'schedule.current': () => {
    const day = loadDayFull(today());
    const cur = currentSegment(day, nowParts(Date.now(), tz()));
    if (!cur) return null;
    // 带上今天的衣柜：生图时按"在家/出门/睡前"取对应那套
    return { ...cur, wardrobe: day?.wardrobe || null };
  }
};

export function deactivate() {
  if (timer) { clearInterval(timer); timer = null; }
  if (boot) { clearTimeout(boot); boot = null; }
  for (const t of retryTimers.values()) { try { clearTimeout(t); } catch { /* ignore */ } }
  retryTimers.clear();
}

export function dispose() {
  deactivate();
}

export const internals = {
  ensureDate,
  tick,
  readDayArg,
  today,
  shiftDate,
  weekdayOf,
  generateMomentText,
  tooSimilar
};

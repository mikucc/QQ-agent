// 每日日程 · 存储与时间工具
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

export const ROOT = path.join(DATA_DIR, 'daily-schedule');
export const DAYS_DIR = path.join(ROOT, 'days');

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

export function dayFile(date) {
  return path.join(DAYS_DIR, `${date}.json`);
}

export function loadDay(date) {
  const raw = readJson(dayFile(date), null);
  if (!raw || !Array.isArray(raw.segments)) return null;
  return {
    date: String(raw.date || date),
    dayType: String(raw.dayType || 'home'),
    generatedAt: Number(raw.generatedAt) || 0,
    generatedBy: String(raw.generatedBy || 'model'),
    segments: raw.segments,
    adjustments: Array.isArray(raw.adjustments) ? raw.adjustments : [],
    // 衣柜：出门/在家/睡前各一套（每天固定）。旧文件没有这个字段。
    wardrobe: raw.wardrobe && typeof raw.wardrobe === 'object' ? raw.wardrobe : null
  };
}

export function saveDay(day) {
  writeJsonAtomic(dayFile(day.date), day);
  return day;
}

// ── 转场事件（"刚……"）────────────────────────────────────────────────
// 每段切换时写一条，只在该转场后 N 分钟内注入，过期自动失效。

export function eventsFile(date) {
  return path.join(ROOT, `${date}.events.json`);
}

export function loadEvents(date) {
  const raw = readJson(eventsFile(date), []);
  return Array.isArray(raw) ? raw : [];
}

export function appendEvent(date, ev) {
  const list = loadEvents(date);
  list.push(ev);
  writeJsonAtomic(eventsFile(date), list.slice(-40));
  return ev;
}

/** 当前仍然有效的那条"刚……"（没有就 null）。 */
export function latestEvent(date, now = Date.now()) {
  const hit = loadEvents(date)
    .filter((e) => Number(e.at) <= now && now < Number(e.expiresAt))
    .sort((a, b) => Number(b.at) - Number(a.at))[0];
  return hit || null;
}

export function listDays(limit = 3) {
  try {
    return fs.readdirSync(DAYS_DIR)
      .filter((f) => /^\d{4}-\d{2}-\d{2}\.json$/.test(f))
      .sort()
      .slice(-limit)
      .map((f) => f.replace(/\.json$/, ''));
  } catch {
    return [];
  }
}

/** 按指定时区取日期/小时/分钟/星期。 */
export function nowParts(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    weekday: 'short'
  });
  const parts = Object.fromEntries(fmt.formatToParts(new Date(ts)).map((p) => [p.type, p.value]));
  const weekdayIndex = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.weekday);
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    weekday: weekdayIndex >= 0 ? weekdayIndex : new Date(ts).getDay()
  };
}

export function dayKey(ts = Date.now(), timeZone = 'Asia/Shanghai') {
  return nowParts(ts, timeZone).date;
}

export function minutesOfDay(hour, minute) {
  return Math.max(0, Math.min(1439, Number(hour) * 60 + Number(minute)));
}

export function timeToMinutes(s) {
  const m = String(s || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  if (h === 24 && min === 0) return 1440;
  if (h < 0 || h > 23 || min < 0 || min > 59) return null;
  return h * 60 + min;
}

export function minutesToTime(n) {
  const x = Math.max(0, Math.min(1440, Number(n) || 0));
  if (x >= 1440) return '24:00';
  return `${String(Math.floor(x / 60)).padStart(2, '0')}:${String(x % 60).padStart(2, '0')}`;
}

export function dateLabel(date, weekday) {
  const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  return `${date} ${names[weekday] || ''}`.trim();
}

export function addAdjustment(day, item) {
  day.adjustments = Array.isArray(day.adjustments) ? day.adjustments : [];
  day.adjustments.push({ ...item, at: Date.now() });
  day.adjustments = day.adjustments.slice(-20);
  return day;
}

export function recentSummaries(limit = 3) {
  const out = [];
  for (const date of listDays(limit)) {
    const day = loadDay(date);
    if (!day) continue;
    const acts = day.segments
      .filter((s) => s.activity && !/睡觉/.test(s.activity))
      .slice(0, 5)
      .map((s) => `${s.start}-${s.end} ${s.activity}`);
    out.push({ date, dayType: day.dayType, activities: acts });
  }
  return out;
}

export function isWeekend(weekday) {
  return weekday === 0 || weekday === 6;
}

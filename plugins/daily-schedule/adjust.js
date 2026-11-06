// 日程调整 · 纯函数（不碰文件，方便测试）
//
// 旧实现只替换 [start,end] 这一格，出门一整天会留下"11:10 又赖床"这种矛盾；
// 现在支持三种用法：
//   ① 只改一格：{start, end, activity}
//   ② 改到某个时刻：{start, until, activity}       → [start,until] 一整段
//   ③ 给一段完整计划：{start, segments:[{start,end,activity,...}]} → 按计划铺开，空隙标记（待定）
import { minutesToTime, timeToMinutes } from './store.js';

const GAP_FILL_MIN = 15;   // 计划之间超过 15 分钟的空隙，补一段"待定"

function normSeg(s) {
  const start = timeToMinutes(s?.start);
  const end = timeToMinutes(s?.end);
  if (start === null || end === null || end <= start) return null;
  const activity = String(s?.activity || '').trim().slice(0, 80);
  if (!activity) return null;
  return {
    start,
    end,
    activity,
    location: String(s?.location || '').trim().slice(0, 40),
    with: String(s?.with || '').trim().slice(0, 40),
    note: String(s?.note || '').trim().slice(0, 120)
  };
}

/**
 * 算出调整后的新段列表。
 * @returns {{segments?: Array, error?: string}}
 */
export function planAdjustment(day, args = {}, { nowMin = 0, maxSegments = 15 } = {}) {
  const start = timeToMinutes(args?.start);
  if (start === null) return { error: '开始时间不合法' };
  if (endIsPast(start, nowMin)) return { error: '已经过去的时间改不了' };

  const tentative = args?.tentative === true;
  const mark = (text) => (tentative && !/待定/.test(text) ? `${text}（待定）` : text);

  // 计划段
  let plan = [];
  if (Array.isArray(args?.segments) && args.segments.length) {
    for (const raw of args.segments.slice(0, 8)) {
      const seg = normSeg(raw);
      if (seg) plan.push(seg);
    }
    if (!plan.length) return { error: '给的时段都不合法，没改' };
  } else {
    const end = timeToMinutes(args?.until) ?? timeToMinutes(args?.end);
    const activity = String(args?.activity || '').trim().slice(0, 80);
    if (end === null || end <= start || !activity) return { error: '时间或活动不合法，没改' };
    plan.push({
      start,
      end,
      activity,
      location: String(args?.location || '').trim().slice(0, 40),
      with: String(args?.with || '').trim().slice(0, 40),
      note: String(args?.note || '').trim().slice(0, 120)
    });
  }

  plan.sort((a, b) => a.start - b.start);
  // 计划之间补"待定"，保证连续
  const filled = [];
  for (let i = 0; i < plan.length; i += 1) {
    const cur = plan[i];
    const prev = filled[filled.length - 1];
    if (prev && cur.start - prev.end >= GAP_FILL_MIN) {
      filled.push({ start: prev.end, end: cur.start, activity: '（待定）', location: '', with: '', note: '这段还没定' });
    }
    filled.push(cur);
  }

  const spanStart = filled[0].start;
  const spanEnd = Math.max(...filled.map((s) => s.end));

  // 切掉被覆盖的旧段（保留头尾）
  const next = [];
  for (const s of day.segments || []) {
    const ss = timeToMinutes(s.start);
    const se = timeToMinutes(s.end);
    if (se <= spanStart || ss >= spanEnd) { next.push(s); continue; }
    if (ss < spanStart) next.push({ ...s, end: minutesToTime(spanStart) });
    if (se > spanEnd) next.push({ ...s, start: minutesToTime(spanEnd) });
  }

  for (const p of filled) {
    next.push({
      start: minutesToTime(p.start),
      end: minutesToTime(p.end),
      activity: mark(p.activity),
      location: p.location,
      with: p.with,
      note: p.note
    });
  }

  next.sort((a, b) => timeToMinutes(a.start) - timeToMinutes(b.start));
  return {
    segments: next.slice(0, Math.max(1, Number(maxSegments) || 15)),
    adjustment: { start: minutesToTime(spanStart), end: minutesToTime(spanEnd), activity: filled.map((p) => p.activity).join(' / ').slice(0, 80) }
  };
}

function endIsPast(start, nowMin) {
  return start < nowMin - 1;
}

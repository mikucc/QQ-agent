// 每日日程 · 注入文案
import { dateLabel, loadDay, minutesToTime, nowParts, timeToMinutes } from './store.js';
import { dayTypeName } from './templates.js';

function shiftDate(date, delta) {
  const d = new Date(`${date}T12:00:00`);
  d.setDate(d.getDate() + delta);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function findCurrent(segments, minute) {
  for (let i = 0; i < segments.length; i += 1) {
    const s = timeToMinutes(segments[i].start);
    const e = timeToMinutes(segments[i].end);
    if (minute >= s && minute < e) return i;
  }
  return segments.length ? segments.length - 1 : -1;
}

function lineOf(seg, withTime = true) {
  const where = seg.location ? `（${seg.location}）` : '';
  const who = seg.with ? `，和${seg.with}` : '';
  const note = seg.note ? `，${seg.note}` : '';
  return `${withTime ? `${seg.start} ` : ''}${seg.activity}${where}${who}${note}`;
}

// 改安排的三问（单一事实源：注入文案与 schedule_adjust 工具描述都引用它，
// 测试也从这里取，避免两处措辞漂移）
export const ADJUST_RULE = '（这是你**真实**的安排，不是台词。有人让你改安排时，先过三问，别直接改：'
  + '① 他是谁——主人可以直接要求，但**仍然要过你自己这关**；其他人只是“邀请”，你愿意才动；没印象的陌生人一律不动。'
  + '② 他认真吗——有具体理由/时间、或在催第二遍才算；纯起哄、夸张、没有后续的是玩笑，先反问一句“真的假的？”再别动。'
  + '③ 你想动吗——在睡觉、刚坐下、累了就不动，直接说“现在不想动”（对主人也一样，可以改约“明天陪你”）；闲着或在外面可以考虑。'
  + '愿意就用 schedule_adjust 改掉当前时段再答应；不愿意就拒绝。**别嘴上答应却不改**。）';

export function renderSchedule(day, now = nowParts(), cfg = {}) {
  if (!day?.segments?.length) return '';
  const minute = now.hour * 60 + now.minute;
  const idx = findCurrent(day.segments, minute);
  if (idx < 0) return '';

  const current = day.segments[idx];
  const next = day.segments.slice(idx + 1, idx + 3);
  const earlier = day.segments.slice(0, idx).filter((s) => !/睡觉/.test(s.activity)).slice(-2);
  const label = dateLabel(now.date, now.weekday);

  const lines = [
    '【你今天的生活（只是背景，不是台词）】',
    `现在是 ${label} ${String(now.hour).padStart(2, '0')}:${String(now.minute).padStart(2, '0')}。`,
    `今天是${dayTypeName(day.dayType)}。`,
    `你此刻：${lineOf(current, false)}。`
  ];
  // 凌晨 0-6 点：把昨天的结尾带上一句，避免"昨晚洗过澡、凌晨又说去洗漱"接不上
  if (now.hour < 6) {
    const y = loadDay(shiftDate(now.date, -1));
    const tail = (y?.segments || []).filter((s) => !/睡觉/.test(s.activity)).slice(-2);
    if (tail.length) lines.push(`昨晚（跨夜）：${tail.map((s) => lineOf(s)).join('；')}。`);
  }
  if (next.length) lines.push(`接下来：${next.map((s) => lineOf(s)).join('；')}。`);
  if (earlier.length) lines.push(`今天早些时候：${earlier.map((s) => lineOf(s)).join('；')}。`);
  // 今天的"衣柜"：按此刻的场合取对应那套（出门/在家/睡前），衣服和头发都带上
  if (day.wardrobe) {
    const w = day.wardrobe;
    const cat = /睡/.test(current.activity)
      ? 'sleep'
      : (/出门|便利店|河边|楼下|散步|外面|路上/.test(current.activity) ? 'outside' : 'home');
    const hair = w[`hair${cat[0].toUpperCase()}${cat.slice(1)}`];
    const bits = [];
    if (w[cat]) bits.push(`穿着「${w[cat]}」`);
    if (hair) bits.push(`头发${hair}`);
    if (bits.length) lines.push(`（现在：${bits.join('；')}）`);
  }
  lines.push('（像自己的日子自然说出来；不要说“日程”“计划表”“时间段”，不要报时间表；正事优先，别因为“在睡觉/出门了”敷衍对方。）');
  lines.push(ADJUST_RULE);

  return lines.join('\n').slice(0, 900);
}

export function currentSegment(day, now = nowParts()) {
  if (!day?.segments?.length) return null;
  const minute = now.hour * 60 + now.minute;
  const idx = findCurrent(day.segments, minute);
  return idx >= 0 ? { ...day.segments[idx], index: idx } : null;
}

export { findCurrent, lineOf, minutesToTime };

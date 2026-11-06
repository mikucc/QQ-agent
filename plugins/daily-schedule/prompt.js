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
  + '愿意就用工具改：**大改动**（出门半天、回母校、去医院、后面几小时都得跟着变）用 schedule_replan，把"发生了什么 + 大概到几点 + 谁去做什么"说清楚，它会重写后面的安排、拿不准的标“（待定）”；**小改动**（拿快递、下楼买水）用 schedule_adjust。只改一格会留下"出了门又在家赖床"的矛盾。'
  + '**发现日程和现实不一致时必须先改再回**：对方说“还没到站”“我还在办事”“你怎么下车了”“我还没回去”，说明日程写错了——立刻用 schedule_replan 把之后的部分重写，再回话；只在嘴上认错、日程不改，下一轮还会错。'
  + '不愿意就拒绝。**别嘴上答应却不改**。）';

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
  // 今天的"衣柜"：按此刻的场合取对应那套（出门/在家/睡前）
  // 规则尽量简单：睡/刚醒/洗完 → 睡衣；地点写了不是家 → 出门；其余一律当在家。
  // 以前是"命中一堆出门词才算外面"，词表少一个就错判成在家（2026-11-05 在食堂被判成居家）。
  if (day.wardrobe) {
    const w = day.wardrobe;
    const loc = String(current.location || '');
    const cat = /睡|刚醒|洗完/.test(String(current.activity || ''))
      ? 'sleep'
      : (loc && !/家/.test(loc) ? 'outside' : 'home');
    const hair = w[`hair${cat[0].toUpperCase()}${cat.slice(1)}`];
    const bits = [];
    if (w[cat]) bits.push(`穿着「${w[cat]}」`);
    if (hair) bits.push(`头发${hair}`);
    if (bits.length) lines.push(`（现在：${bits.join('；')}）`);
  }
  lines.push('（像自己的日子自然说出来；不要说“日程”“计划表”“时间段”，不要报时间表；正事优先，别因为“在睡觉/出门了”敷衍对方。）');
  lines.push('（标了“（待定）”的安排不要自己往下推进：在车上就等他说到站，他办事就等他消息；别自己决定下车、办完、回家。）');
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

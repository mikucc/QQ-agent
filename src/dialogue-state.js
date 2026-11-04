// 对话状态卡（dialogue-state）
//
// 为什么需要：QQ-agent 是无状态会话 —— 每次触发都新开一次 LLM 会话，模型只能从
// 【已读信息】那 80 条消息里自己推断"我刚说了什么 / 在等谁 / 哪件事没聊完"。
// 推断失败的表现就是：刚说过的话下一轮又问一遍、对方没接还追问、答应过的事忘了。
//
// 这里只维护三个字段，渲染出来 ≤160 字：
//   lastSelf   我最后一条发言（2 小时内才展示）
//   pendingAsk 我问出去、还没人接的问题（30 分钟内才展示）
//   topic      还没聊完的话题（来自 chatActive 活跃期，到期即消失）
//
// 原则：宁可不显示，也不显示错的。任何字段过期就整条不出现；写盘失败一律吞掉
//（状态卡只是锦上添花，绝不能影响聊天主流程）。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from './config.js';

const DIR = path.join(DATA_DIR, 'dialogue-state');
const LAST_SELF_TTL = 120 * 60 * 1000;
const PENDING_TTL = 30 * 60 * 1000;

function fileOf(chatKey) {
  const safe = String(chatKey || '').replace(/[^a-z0-9_]/gi, '_');
  return path.join(DIR, `${safe}.json`);
}

function cleanText(s, n) {
  return String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
}

export function load(chatKey) {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(chatKey), 'utf8').replace(/^\uFEFF/, ''));
    return raw && typeof raw === 'object' ? raw : {};
  } catch {
    return {};
  }
}

function save(state) {
  try {
    fs.mkdirSync(DIR, { recursive: true });
    const file = fileOf(state.chatKey);
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(state, null, 1), 'utf8');
    fs.renameSync(tmp, file);
  } catch { /* ignore */ }
}

function minutesBetween(a, b) {
  return Math.max(0, Math.round((b - a) / 60000));
}

/** 渲染成提示词里的一段；没有可说的返回 ''。 */
export function render(state = {}, now = Date.now()) {
  const lines = [];
  const last = state.lastSelf;
  if (last && last.text && now - Number(last.at || 0) <= LAST_SELF_TTL) {
    const mins = minutesBetween(Number(last.at || now), now);
    lines.push(`- 你上一条是「${last.text}」${mins >= 1 ? `（${mins} 分钟前）` : '（刚刚）'}。`);
  }
  const ask = state.pendingAsk;
  if (ask && ask.text && now - Number(ask.at || 0) <= PENDING_TTL) {
    const who = ask.name || '对方';
    lines.push(`- 你在等 ${who} 回你「${ask.text}」——他没接就别追第二遍。`);
  }
  const topic = state.topic;
  if (topic && topic.text && Number(topic.until || 0) > now) {
    lines.push(`- 还没聊完的事：${topic.text}。`);
  }
  if (!lines.length) return '';
  return ['【对话状态】（你自己记得的事，不是系统提示）', ...lines].join('\n');
}

/**
 * 每次运行**之前**调用：闭合已被回答的问题、刷新话题，并返回要注入的文本。
 * @param {{chatKey:string, triggerEntries?:Array, topic?:string, topicUntil?:number, now?:number}} args
 */
export function prepareForRun({ chatKey, triggerEntries = [], topic = '', topicUntil = 0, now = Date.now() } = {}) {
  if (!chatKey) return '';
  const st = load(chatKey);
  st.chatKey = chatKey;
  let dirty = false;

  // 对方回了 → 这条"待答"闭合（不再每轮提醒"你在等他"）
  if (st.pendingAsk) {
    const answered = (triggerEntries || []).some((e) => e && !e.self
      && String(e.senderId ?? '') === String(st.pendingAsk.to ?? ''));
    if (answered || now - Number(st.pendingAsk.at || 0) > PENDING_TTL) {
      st.pendingAsk = null;
      dirty = true;
    }
  }

  // 话题：活跃期刷新；活跃期结束（topic 为空）就清掉，避免"聊完了还挂着一句"
  if (topic) {
    st.topic = { text: cleanText(topic, 40), until: Number(topicUntil) || now + 30 * 60000 };
    dirty = true;
  } else if (st.topic && Number(st.topic.until || 0) <= now) {
    st.topic = null;
    dirty = true;
  }

  if (dirty) save(st);
  return render(st, now);
}

/**
 * 每次运行**之后**调用：记下"我最后说了什么"，并判断这句话是不是一个"在等回答"的问题。
 * @param {{chatKey:string, sent?:Array, triggerEntries?:Array, now?:number}} args
 */
export function recordRun({ chatKey, sent = [], triggerEntries = [], now = Date.now() } = {}) {
  if (!chatKey) return;
  const st = load(chatKey);
  st.chatKey = chatKey;
  st.updatedAt = now;

  const lastSelf = [...(sent || [])].reverse().find((m) => cleanText(m?.text, 200));
  if (lastSelf) {
    const text = cleanText(lastSelf.text, 60);
    st.lastSelf = { text, at: now };
    // 只有"确实在问人"才算 pendingAsk：句尾问号，或"吗/呢"收尾。
    // 纯感叹/陈述不算，否则每句话都会变成"他在等回复"。
    const isAsk = /[?？]\s*$/.test(text) || /[吗呢]\s*$/.test(text);
    const to = [...(triggerEntries || [])].reverse().find((e) => e && !e.self && e.senderId);
    st.pendingAsk = isAsk && to
      ? { to: String(to.senderId), name: String(to.senderName || '').slice(0, 20), text, at: now }
      : null;
  }

  save(st);
}

/** 外部（测试/清理）用：删除某个会话的状态。 */
export function clear(chatKey) {
  try { fs.unlinkSync(fileOf(chatKey)); } catch { /* ignore */ }
}

export const internals = { DIR, LAST_SELF_TTL, PENDING_TTL, cleanText };

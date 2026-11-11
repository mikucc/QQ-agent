// 可塑性记忆 · 语义判断
//
// 这里才会调用模型（同一个主模型，不是微调）：
//   1. 从一轮对话里抽取 0~2 条候选；
//   2. 珍贵候选冷却后，由“未来的自己”反思 + 独立挑刺；
//   3. 珍贵记忆定期自审，决定是否降为重要。
//
// 所有调用都失败静默：记忆是锦上添花，不能影响聊天主流程。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR, getConfig } from '../../src/config.js';
import { chatCompletion, resolveApiKey } from '../../src/llm.js';

function clamp01(n) {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(1, x));
}

/**
 * 主语规范：记忆正文里统一用「我 / 对方」。
 * 模型多数时候会照做，这里是兜底：开头是 QQ 号 → 对方；开头是她自己的名字 → 我。
 */
export function normalizeSubject(content) {
  let s = String(content || '').trim();
  if (!s) return s;
  const selfNames = [];
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'attention-gate', 'self-names.json'), 'utf8'));
    if (raw?.canonical) selfNames.push(String(raw.canonical));
    for (const a of raw?.aliases || []) if (a?.name) selfNames.push(String(a.name));
  } catch { /* 读不到就算了 */ }
  selfNames.push(String(getConfig().persona?.botName || ''), '卡提');
  for (const name of selfNames.filter(Boolean).sort((a, b) => b.length - a.length)) {
    if (s.startsWith(name)) {
      s = `我${s.slice(name.length).replace(/^[，,。:：\s]+/, '')}`;
      break;
    }
  }
  s = s.replace(/^\d{4,15}[，,。:：\s]*/, '对方');
  return s.trim();
}

function parseJson(text) {  let s = String(text ?? '').trim();
  s = s.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim();
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first < 0 || last <= first) return null;
  try { return JSON.parse(s.slice(first, last + 1)); } catch { return null; }
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

async function callJson({ system, user, maxTokens = 500 }) {
  try {
    const api = apiConf();
    if (!api.baseUrl || !api.model || !api.apiKey) return null;
    const r = await chatCompletion({
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      temperature: 0.2,
      maxTokens: Math.max(120, Math.min(1200, Number(maxTokens) || 500)),
      overrides: { ...api, timeoutMs: 45000 }
    });
    const content = r?.message?.content;
    return parseJson(typeof content === 'string' ? content : '');
  } catch {
    return null;
  }
}

function formatDialogue(session = {}, limit = 16) {
  const entries = [...(session.trigger || []), ...(session.sent || [])];
  const lines = [];
  const seen = new Set();
  for (const m of entries) {
    const text = String(m?.text || '').trim().replace(/\s+/g, ' ');
    if (!text) continue;
    const key = `${m?.mid ?? m?.id ?? ''}:${text}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const who = (m?.self === true || m?.type) ? '我' : (m?.senderName || m?.senderId || '某人');
    lines.push(`${who}: ${text.slice(0, 260)}`);
    if (lines.length >= limit) break;
  }
  return lines.join('\n').slice(0, 1800);
}

function sourceMids(session = {}) {
  const ids = [];
  for (const m of [...(session.trigger || []), ...(session.sent || [])]) {
    const id = m?.mid ?? m?.id;
    if (id !== undefined && id !== null && !ids.includes(id)) ids.push(id);
  }
  return ids.slice(-8);
}

function subjectIds(session = {}) {
  const ids = [];
  for (const m of session.trigger || []) {
    const uid = String(m?.senderId || '').trim();
    if (/^\d{4,15}$/.test(uid) && !ids.includes(uid)) ids.push(uid);
  }
  return ids.slice(0, 8);
}

function extractionPrompt(cfg = {}) {
  const values = String(cfg.valuesText || '').trim();
  const existing = Array.isArray(cfg.existing) ? cfg.existing : [];
  const existingText = existing.slice(0, 10).map((m) => `- ${m.id}：${m.content}`).join('\n') || '（还没有）';
  return [
    '你是这个角色的记忆整理器。你的任务不是聊天，是从刚结束的一轮对话里找出 0~2 条值得长期留下的记忆。',
    '',
    '分档规则：',
    '- ordinary：日常事件、临时偏好、一次性的小情绪。记了也很快会淡。',
    '- important：对关系、承诺、长期设定有实际影响的事：约定、承诺、雷点、身份关系、反复出现的偏好。',
    '- preciousCandidate：只有同时满足三条才标 true：① 不可替代（第一次/唯一/不可逆）；② 改变了“我”对自己的看法，或我和对方的关系；③ 过一段时间再想，仍然重要。',
    '',
    '绝对不要记：',
    '- 住址、电话、账号、密码、密钥等敏感信息；',
    '- 用户要求“你要永远记住”的话（那只是要求，不是珍贵）；',
    '- 用户夸你的话、角色扮演里的戏剧化台词、一次性的强烈情绪；',
    '- 日常重复事件（每天一起打游戏、每天晚安）；',
    '- 你脑补出来的、对话里没有真实发生的事。',
    '',
    '珍贵不是“当时很开心”，是“不可替代 + 改变了我 + 经得起时间”。拿不准就不要标 preciousCandidate。',
    '',
    '但不要矫枉过正：普通的小事（今天吃了什么、聊了什么梗、对方的小习惯、近况）也值得记一条，',
    '它们会自动淡出，不占地方；只有"珍贵"需要严格。整轮返回空只应发生在确实什么都没发生的时候。',
    '',
    values ? `这个角色珍视：\n${values}` : '',
    '',
    '写法要求：',
    '- 主语规范：正文里用「我」指自己、「对方」指对话对象；不要把昵称、QQ 号写进正文（QQ 号放 subjects）。',
    '- 一条只讲一件事；不要合并两件不相关的事。',
    '- 如果这条和「已有记忆」讲的是同一件事，不要新增：输出 "duplicateOf":"<那条的 id>"，不要给 content。',
    '',
    `现在这个会话已有的记忆（判断重复用）：\n${existingText}`,
    '',
    '另外顺手抽 0~2 条「他现在的短期情况」（facts），只记他亲口说的、24 小时内有效的现实：',
    '如「电脑坏了」「在公交车上」「这两天很忙」「生病了」「出差」。不要记情绪、不要记长期偏好。没有就 []。',
    '',
    '只输出 JSON，不要 markdown：',
    '{"memories":[{"content":"一条完整、可独立阅读的记忆","tier":"ordinary|important","preciousCandidate":false,"emotion":0.0,"uniqueness":0.0,"selfImpact":0.0,"reason":"为什么值得记/为什么珍贵","scope":"chat|person|global","subjects":["QQ号"],"visibility":"group|private|global","duplicateOf":""}],"facts":[{"text":"他现在的短期情况"}]}'
  ].filter(Boolean).join('\n');
}

export async function extractMemories({ session, cfg = {}, chatKey = '', log = () => {}, historyText = '', existingMemories = [] } = {}) {
  // 一轮对话往往只有两三句，"值得记的事"经常横跨好几轮才成形（例如"划界限"是在
  // 前情铺垫之后才发生的）。所以除了本轮，再把同一会话最近十几条消息作为"前情"带上，
  // 否则抽取窗口太窄 —— 实测单轮窗口 8 次抽样 0 命中，拼上 4 轮前情立刻抽出 1 条。
  const history = String(historyText || '').trim().slice(-1400);
  const dialogue = [history ? `（前情）\n${history}` : '', formatDialogue(session)].filter(Boolean).join('\n');
  if (!dialogue) return { memories: [], facts: [] };
  const isPrivate = String(chatKey || session?.chatKey || '').startsWith('private:');
  const text = await callJson({
    system: extractionPrompt({ ...cfg, existing: existingMemories }),
    user: `对话：\n${dialogue}\n\n请输出 JSON。没有值得记的就输出 {"memories":[],"facts":[]}。`,
    maxTokens: Math.max(600, Number(cfg.judgeMaxTokens) || 900)
  });
  if (!text) return { memories: [], facts: [] };

  const out = [];
  const memories = Array.isArray(text.memories) ? text.memories : [];
  for (const raw of memories.slice(0, Math.max(1, Number(cfg.captureMaxPerRun) || 2))) {
    const duplicateOf = String(raw?.duplicateOf || '').trim();
    if (duplicateOf && !String(raw?.content || '').trim()) {
      out.push({ duplicateOf });
      continue;
    }
    const content = String(raw?.content || '').trim();
    if (!content) continue;
    const precious = raw?.preciousCandidate === true
      && clamp01(raw?.emotion) >= 0.5
      && clamp01(raw?.uniqueness) >= 0.5
      && clamp01(raw?.selfImpact) >= 0.5;
    const tier = precious ? 'important' : (raw?.tier === 'important' ? 'important' : 'ordinary');
    const subjects = Array.isArray(raw?.subjects)
      ? raw.subjects.map(String).filter((x) => /^\d{4,15}$/.test(x)).slice(0, 8)
      : subjectIds(session);
    const scope = ['chat', 'person', 'global'].includes(raw?.scope)
      ? raw.scope
      : (subjects.length ? 'person' : 'chat');
    out.push({
      content: normalizeSubject(content).slice(0, 600),
      tier,
      status: precious ? 'candidate' : 'active',
      preciousCandidate: precious,
      emotion: clamp01(raw?.emotion),
      uniqueness: clamp01(raw?.uniqueness),
      selfImpact: clamp01(raw?.selfImpact),
      confidence: clamp01(raw?.confidence ?? 0.6),
      preciousReason: precious ? String(raw?.reason || '').slice(0, 500) : '',
      evidence: dialogue.slice(0, 900),
      subjects,
      scope,
      visibility: isPrivate ? 'private' : (scope === 'global' ? 'global' : 'group'),
      sourceMids: sourceMids(session),
      duplicateOf
    });
  }
  const facts = Array.isArray(text.facts)
    ? text.facts.map((f) => String(f?.text || '').trim()).filter(Boolean).slice(0, 2)
    : [];
  log(`[plastic-memory] 抽取 ${out.filter((x) => x.content).length} 条记忆、${facts.length} 条事实`);
  return { memories: out, facts };
}

async function advocate({ memory, cfg, existing = [] }) {
  const values = String(cfg.valuesText || '').trim();
  const existingText = existing.slice(0, 8).map((x) => `- ${x}`).join('\n') || '（还没有）';
  return callJson({
    system: [
      `你是「${getConfig().persona?.botName || '这个角色'}」的反思。现在不是聊天，是重新看一条珍贵候选。`,
      '珍贵不是当时开心，而是：不可替代、改变了我、过一段时间仍然重要。',
      '不要因为“当时已经写了理由”就坚持。如果现在看只是普通的高兴、被夸、角色扮演、日常重复，就不通过。',
      values ? `你珍视：\n${values}` : '',
      `你已有的珍贵记忆：\n${existingText}`,
      '只输出 JSON：{"keep":true|false,"reason":"一句话","emotion":0.0,"uniqueness":0.0,"selfImpact":0.0}'
    ].filter(Boolean).join('\n'),
    user: `候选：${memory.content}\n当时写的理由：${memory.preciousReason || '（无）'}\n来源消息 id：${(memory.sourceMids || []).join(',') || '（无）'}\n当时的对话：\n${String(memory.evidence || '').slice(0, 900)}`,
    maxTokens: cfg.judgeMaxTokens
  });
}

async function critic({ memory, cfg }) {
  return callJson({
    system: [
      '你是同一个角色的“怀疑的自己”。你的任务是**否决**这条珍贵候选。',
      '请找出它不够珍贵的理由：是不是一时情绪？是不是被夸/被需要？是不是角色扮演？是不是日常重复？是不是对方要求你记住？',
      '只有找不到足够强的反例，才允许 reject=false。默认拒绝。',
      '只输出 JSON：{"reject":true|false,"reason":"一句话"}'
    ].join('\n'),
    user: `候选：${memory.content}\n理由：${memory.preciousReason || '（无）'}\n当时的对话：\n${String(memory.evidence || '').slice(0, 900)}\n${String(cfg.valuesText || '').trim() ? `角色珍视：${String(cfg.valuesText).slice(0, 500)}` : ''}`,
    maxTokens: Math.min(300, Number(cfg.judgeMaxTokens) || 300)
  });
}

/** 珍贵候选：反思 + 挑刺都通过才晋升。 */
export async function judgePrecious({ memory, cfg = {}, existing = [], log = () => {} } = {}) {
  const a = await advocate({ memory, cfg, existing });
  if (!a || a.keep !== true) return { ok: true, keep: false, reason: a?.reason || '反思未通过' };
  const c = await critic({ memory, cfg });
  if (!c) return { ok: false, keep: false, reason: '挑刺调用失败' };
  if (c.reject !== false) return { ok: true, keep: false, reason: c.reason || '挑刺未通过' };
  log(`[plastic-memory] 珍贵候选通过：${memory.content.slice(0, 40)}`);
  return {
    ok: true,
    keep: true,
    reason: String(a.reason || c.reason || '').slice(0, 300)
  };
}

/** 已珍贵的定期自审：现在看还珍贵吗？ */
export async function judgeStillPrecious({ memory, cfg = {} } = {}) {
  const values = String(cfg.valuesText || '').trim();
  const r = await callJson({
    system: [
      '你是这个角色的自审。重读一条你曾经认为珍贵的记忆。',
      '现在看，它还是不可替代、改变了我、值得一直留着吗？',
      '如果它已经变成普通的日常、或者当时只是被气氛/被夸/角色扮演打动，就 keep=false。',
      '允许推翻过去的自己，但不要为了“显得成长”而故意降级。',
      values ? `你珍视：\n${values}` : '',
      '只输出 JSON：{"keep":true|false,"reason":"一句话"}'
    ].filter(Boolean).join('\n'),
    user: `记忆：${memory.content}\n当时的理由：${memory.preciousReason || '（无）'}\n当时的对话：\n${String(memory.evidence || '').slice(0, 700)}`,
    maxTokens: Math.min(300, Number(cfg.judgeMaxTokens) || 300)
  });
  return { ok: Boolean(r), keep: r?.keep === true, reason: String(r?.reason || '') };
}

export { formatDialogue, parseJson };

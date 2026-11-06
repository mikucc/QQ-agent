// 生图工作室 · 入口
//
// 参考库 + 生图 API + 直接发到当前 QQ 会话。
// 工具：image_generate / image_library
// 注入：什么时候发图、参考库目录。
import { compose } from './compose.js';
import {
  CATEGORIES,
  CATEGORY_LABEL,
  LIBRARY_DIR,
  ensureDirs,
  saveOutput
} from './store.js';
import {
  catalogText,
  ensureDefaults,
  formatEntry,
  resolveRef,
  scanAll
} from './library.js';
import { generate } from './providers.js';

let api = null;
let cfg = () => ({});
let libCache = null;
let libAt = 0;
const lastShot = new Map();
const shotLog = [];

function log(...args) {
  try { api?.log?.(...args); } catch { /* ignore */ }
}

function on() {
  return cfg()?.enabled !== false;
}

function hasApi() {
  const c = cfg();
  return Boolean(String(c.baseUrl || '').trim() && String(c.apiKey || '').trim() && String(c.model || '').trim());
}

function getLib(force = false) {
  const now = Date.now();
  if (!force && libCache && now - libAt < 60000) return libCache;
  libCache = scanAll();
  libAt = now;
  return libCache;
}

function cleanShotLog(now = Date.now()) {
  const dayAgo = now - 24 * 3600000;
  while (shotLog.length && shotLog[0] < dayAgo) shotLog.shift();
}

function checkLimits(chatKey, userRequested) {
  const c = cfg();
  const now = Date.now();
  cleanShotLog(now);
  const hourAgo = now - 3600000;
  const hourCount = shotLog.filter((t) => t > hourAgo).length;
  // 两档额度：用户明确要图走"请求档"（宽松），主动发图继续克制。
  const perHour = userRequested
    ? Math.max(1, Number(c.requestMaxPerHour) || 12)
    : Math.max(1, Number(c.maxPerHour) || 6);
  const perDay = userRequested
    ? Math.max(1, Number(c.requestMaxPerDay) || 40)
    : Math.max(1, Number(c.maxPerDay) || 20);
  if (hourCount >= perHour) {
    return userRequested
      ? `这一小时已经生成 ${hourCount} 张了，先歇一会儿。`
      : `这一小时已经主动发了 ${hourCount} 张，先歇一会儿。`;
  }
  if (shotLog.length >= perDay) return `今天已经生成 ${shotLog.length} 张，先到这里。`;
  const gapMin = userRequested
    ? Math.max(0, Number(c.requestCooldownMin ?? 2))
    : Math.max(0, Number(c.cooldownMin) || 0);
  const last = lastShot.get(chatKey) || 0;
  if (gapMin > 0 && last > 0 && now - last < gapMin * 60000) {
    const mins = Math.round((now - last) / 60000);
    return `${userRequested ? '刚发过一张' : '主动发图冷却中'}：距离上一张才 ${mins} 分钟（至少 ${Math.round(gapMin)} 分钟）。`;
  }
  return '';
}

function guideText(lib) {
  const c = cfg();
  const policy = String(c.policy || 'smart');
  const when = policy === 'explicit'
    ? '只有用户明确要求“发张图/自拍/换装/画一张”时才调用。'
    : policy === 'off'
      ? '不要主动发图；只有用户明确要求时才调用。'
      : '用户明确要求发图/自拍/换装时调用——对方反复撒娇、催同一张，也算明确要求，别拿“别频繁”当借口；聊天氛围很适合（刚起床、在河边、换了衣服）时也可以主动发一张。';
  return [
    '【生图工作室】',
    '你有一个本地参考库和生图接口。图会由 image_generate 直接发到当前聊天，不要再调用 send_image / send_sticker 发同一张。',
    when,
    `额度：用户明确要图时（user_requested=true）最少间隔 ${Math.max(0, Number(c.requestCooldownMin ?? 2))} 分钟、每小时最多 ${Math.max(1, Number(c.requestMaxPerHour) || 12)} 张；主动发图间隔 ${Number(c.cooldownMin) || 30} 分钟、每小时最多 ${Math.max(1, Number(c.maxPerHour) || 6)} 张。`,
    '参考库目录：',
    catalogText(lib, 10) || '（还没有素材，只按文字画）',
    '用法：prompt 写“谁在哪做什么、构图和情绪”；characters/outfits/scene/props 填库里的名字或 id。名字不确定就先调用 image_library 查。人物长相和服装设计由参考图保证，不要把参考图的姿势和表情照抄进 prompt。',
    '不要每次都同一套：在家穿睡衣/居家服，出门换外套或水手服；镜头和动作也换着来（自拍、半身、全身、侧后方）。用户没指定就自己挑一套搭今天的场景。',
    '**答应了就当场发**：说过“给你看/拍给你/等下拍”就必须在这一轮调用 image_generate 把图发出去；只回一句“好呀 给你看”然后结束，图就没了（会被提前收尾）。'
  ].join('\n');
}

function formatCatalog(category, query, id) {
  const lib = getLib(true);
  const cats = category ? [category] : CATEGORIES;
  const q = String(query || '').trim().toLowerCase();
  const lines = [];
  for (const cat of cats) {
    for (const entry of lib[cat] || []) {
      if (id && entry.id.toLowerCase() !== String(id).toLowerCase()) continue;
      if (q) {
        const hay = [entry.name, entry.id, ...(entry.aliases || []), entry.description, entry.traits]
          .join(' ').toLowerCase();
        if (!hay.includes(q)) continue;
      }
      lines.push(formatEntry(entry));
      if (lines.length >= 40) break;
    }
    if (lines.length >= 40) break;
  }
  return lines.length ? lines.join('\n') : '参考库里没有匹配的条目。';
}

function registerTools() {
  api.registerTool({
    id: 'image_generate',
    name: '生成并发送图片',
    description: '根据画面描述和本地参考库生成一张图片，并直接发到当前 QQ 聊天。用户要自拍/发图/换装，或聊天氛围适合时用。图已经由本工具发出，不要再调用 send_image 或 send_sticker 发同一张。',
    category: 'media',
    parameters: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '画面描述：谁、在哪、正在做什么、构图与情绪重点。人物长相和服装设计由参考图保证，不必重复。' },
        situation: { type: 'string', description: '情境，如 刚睡醒、在家休息、在河边散步、睡前' },
        expression: { type: 'string', description: '神态，如 困倦、开心、害羞、发呆' },
        pose: { type: 'string', description: '动作，如 抱膝坐、托腮、伸懒腰、举手机自拍' },
        shot: { type: 'string', description: '镜头，如 自拍、近景、全身、第一人称' },
        light: { type: 'string', description: '光线，如 午后暖阳、夜晚台灯、黄昏逆光' },
        characters: { type: 'array', items: { type: 'string' }, description: '人物库名字或 id；通常是小鲸鱼' },
        outfits: { type: 'array', items: { type: 'string' }, description: '服饰库名字或 id；不填用人物默认服饰' },
        scene: { type: 'string', description: '场景库名字或 id，只能一个' },
        props: { type: 'array', items: { type: 'string' }, description: '道具库名字或 id' },
        aspect: { type: 'string', description: '画幅：1:1、3:4、4:3、9:16、16:9' },
        caption: { type: 'string', description: '图下面的一句说明，可选' },
        user_requested: { type: 'boolean', description: '用户本轮明确要求发图时为 true，可绕过主动发图冷却。' }
      },
      required: ['prompt']
    },
    async execute(ctx, args) {
      try {
        const c = cfg();
        if (!on()) return { content: '生图工作室已关闭。' };
        if (!hasApi()) {
          return { content: '生图接口还没配置：需要在设置里填 Base URL、API Key 和模型。' };
        }
        const userRequested = args?.user_requested === true;
        if (String(c.policy || 'smart') === 'explicit' && !userRequested) {
          return { content: '当前是“只有用户明确要图才发”的策略；这次没有明确要求，先不生成。' };
        }
        const limit = checkLimits(String(ctx?.chatKey || ''), userRequested);
        if (limit) return { content: limit };

        const lib = getLib();
        // 今天的衣柜由 daily-schedule 决定（出门/在家/睡前各一套，当天固定）。
        // 拿不到就算了，compose 会退回按情境挑衣服。
        let sched = null;
        try { sched = api?.capability?.('schedule.current', { chatKey: ctx?.chatKey }) || null; } catch { /* ignore */ }
        const wardrobe = sched?.wardrobe || null;
        const composed = compose({
          ...args,
          wardrobe,
          scheduleActivity: sched?.activity || '',
          scheduleLocation: sched?.location || ''
        }, c, lib);
        log(`[生图] 生成：${String(args?.prompt || '').slice(0, 60)}｜参考图 ${composed.refs.length} 张`);
        const result = await generate({ prompt: composed.prompt, refs: composed.refs, cfg: c });
        const saved = saveOutput(result.buffer, result.ext);
        const dataUrl = `base64://${result.buffer.toString('base64')}`;
        let sent = false;
        let sendError = '';
        try {
          if (!ctx?.sender?.sendImage) throw new Error('当前上下文没有发送器');
          await ctx.sender.sendImage(ctx.chatKey, { file: saved.file, dataUrl }, {
            note: String(args?.caption || '').slice(0, 40)
          });
          sent = true;
        } catch (e) {
          sendError = e?.message || String(e);
          log(`[生图] 发送失败：${sendError}`);
        }
        lastShot.set(String(ctx?.chatKey || ''), Date.now());
        shotLog.push(Date.now());

        const lines = [
          sent ? '图已生成并直接发到聊天里了。' : `图已生成，但发送失败：${sendError}`,
          `文件：${saved.file}`,
          composed.refs.length ? `参考图：${composed.refs.map((r) => r.label).join('、')}` : '参考图：无，按文字生成'
        ];
        if (composed.notes?.length) lines.push(`说明：${composed.notes.join('；')}`);
        if (composed.unresolved?.length) lines.push(`库里没找到：${composed.unresolved.join('、')}`);
        lines.push('不要向用户复述提示词；不要说“我调用工具生成了一张图”。如果用户还想改，再生成一张。');
        return { content: lines.join('\n') };
      } catch (e) {
        log(`[生图] 失败：${e?.message || e}`);
        return { content: `生图失败：${e?.message || e}` };
      }
    }
  });

  api.registerTool({
    id: 'image_library',
    name: '查生图参考库',
    description: '查询本地人物/服饰/场景/道具库。不知道名字、或系统提示里的目录没列全时用。',
    category: 'media',
    parameters: {
      type: 'object',
      properties: {
        category: { type: 'string', enum: CATEGORIES, description: '只查一类' },
        query: { type: 'string', description: '关键词，匹配名字、别名、描述' },
        id: { type: 'string', description: '查看某个条目' }
      }
    },
    execute(_ctx, args) {
      return { content: formatCatalog(args?.category, args?.query, args?.id) };
    }
  });
}

export function setup(a) {
  api = a;
  cfg = a?.config || (() => ({}));
  ensureDirs();
  ensureDefaults();
  libCache = scanAll();
  libAt = Date.now();
  registerTools();
  log(`[生图] 已加载：${hasApi() ? '接口已配置' : '接口未配置'}｜库目录 ${LIBRARY_DIR}`);
}

export function promptSections() {
  try {
    if (!on() || cfg().injectGuide === false) return [];
    if (String(cfg().policy || 'smart') === 'off') return [];
    if (!hasApi()) return [];
    return [{
      id: 'image-studio-guide',
      title: '生图工作室',
      priority: 57,
      content: guideText(getLib())
    }];
  } catch {
    return [];
  }
}

export const providers = {
  'image.available': () => ({
    enabled: on(),
    configured: hasApi(),
    provider: String(cfg().provider || 'openai'),
    model: String(cfg().model || '')
  })
};

export function deactivate() {
  lastShot.clear();
  shotLog.length = 0;
}

export function dispose() {
  deactivate();
}

export const internals = {
  getLib,
  checkLimits,
  formatCatalog,
  resolveRef,
  CATEGORY_LABEL
};

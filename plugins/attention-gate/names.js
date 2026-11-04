// 注意力门 · 她自己的称呼仓库
//
// 只维护「她自己的」2~3 个称呼，不维护群友名单。
// 来源只有三类：固定身份、明确命名、被直接叫到时的候选。
// 目的不是穷举昵称，而是避免把“徐院”这种群友名误认成她。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const FILE = path.join(DATA_DIR, 'attention-gate', 'self-names.json');
const MAX_ACTIVE = 3;
const MAX_CANDIDATE = 8;
const DAY = 86400000;

// ── 评分制 ─────────────────────────────────────────────────────────────
// 旧实现只数"被叫到几次"，分不清"认真叫她"和"长句尾巴被误抓"，也清不掉旧词。
// 现在每条别名带一个分数：不同来源给不同权重，按周衰减，分数 + 近 7 天出现次数
// 同时达标才转正。权重是"证据强度"，不是"次数"——主人明确命名一次就够，
// 句尾疑似称呼要攒很多次。
const SOURCE_WEIGHT = {
  bootstrap: 4,          // 配置里的固定称呼（botName/selfNickname/aliases）
  'group-card': 5,       // 群名片：最硬的自称
  'explicit-owner': 5,   // 主人说"以后叫你 X"
  explicit: 3,           // 普通群友说"叫你 X"
  addressed: 1.5         // 被 @/回复/拍一拍 时句首的呼语
};
const PROMOTE_SCORE = 4;      // 转正所需分数
const PROMOTE_HITS_7D = 2;    // 且近 7 天至少出现 2 次（防"一次误抓就转正"）
const DEMOTE_SCORE = 1.2;     // 活跃别名低于这个分、且 60 天没出现 → 降候选
const DROP_SCORE = 0.8;       // 候选低于这个分、且 30 天没出现 → 直接丢

function weightOf(source) {
  return SOURCE_WEIGHT[source] ?? 1.5;
}

function hitsIn7d(item, now) {
  return (Array.isArray(item.hits) ? item.hits : []).filter((t) => now - Number(t) <= 7 * DAY).length;
}

// 这些词不可能是名字；防止把“在吗/你好/大家”收成别名。
const STOP = new Set([
  '在吗', '在不在', '你好', '您好', '那个', '这个', '就是', '不是', '什么', '怎么',
  '可以', '谢谢', '大家', '各位', '有人', '有人吗', '兄弟', '姐妹', '朋友', '大佬',
  '群主', '管理', '管理员', '机器人', 'ai', 'AI', '喂', '诶', '哎', '草', '笑死',
  '宝贝', '亲爱的', '大佬们', '各位', '在么', '人呢',
  '今天', '明天', '昨天', '现在', '刚才', '一下', '一个', '两个', '进行', '没有',
  '谁', '哪', '哪个', '哪儿', '这里', '那里', '什么', '怎么'
]);

function clean(name) {
  return String(name ?? '').trim().replace(/^[^\u4e00-\u9fa5A-Za-z0-9_]+|[^\u4e00-\u9fa5A-Za-z0-9_]+$/g, '');
}

// 含这些字的基本上是句子碎片，不是称呼（"测了多少次""你的灵魂被禁锢了""你忘了吗"）。
const PHRASE_CHARS = /[的了是吗吧呢啊呀哦你他她它们这那个次些有在把被就都太不我会能要说问给让叫]/;

function valid(name) {
  return name.length >= 2 && name.length <= 8
    && !STOP.has(name)
    && !PHRASE_CHARS.test(name)
    && !/^\d+$/.test(name)
    && !/^(.)\1+$/.test(name);
}

function readJson(file) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

export class NameBook {
  constructor(file = FILE) {
    this.file = file;
    const raw = readJson(file);
    this.state = raw && Array.isArray(raw.aliases)
      ? raw
      : { version: 1, canonical: '', aliases: [], rejected: [] };
    if (!Array.isArray(this.state.rejected)) this.state.rejected = [];
    // 迁移：老数据只有 confidence/count，没有 score/hits。按旧置信度折一个起始分，
    // 保证升级后不会出现"全部别名瞬间归零被清掉"。
    for (const a of this.state.aliases) {
      if (!Array.isArray(a.hits)) a.hits = [];
      if (a.score === undefined) {
        a.score = Math.max(1, Number(a.confidence) || 0.3) * 3 + Number(a.count || 1) * 0.5;
      }
      if (!a.lastDecayAt) a.lastDecayAt = Number(a.lastSeen || a.firstSeen || Date.now());
    }
  }

  /** 一次"被叫到"：加分数 + 记一次时间戳。 */
  #bump(item, source, evidence, now = Date.now()) {
    item.score = Number(item.score || 0) + weightOf(source);
    item.hits = [...(Array.isArray(item.hits) ? item.hits : []), now].slice(-12);
    item.count = Number(item.count || 0) + 1;
    item.lastSeen = now;
    item.source = item.source || source;
    item.confidence = Math.max(
      Number(item.confidence) || 0,
      Math.min(0.95, 0.2 + Math.min(item.score, 6) * 0.12)
    );
    if (evidence) item.evidence = [...new Set([...(item.evidence || []), String(evidence)])].slice(-8);
    return item;
  }

  get canonical() {
    return String(this.state.canonical || '').trim();
  }

  activeNames() {
    const out = new Set();
    if (this.canonical) out.add(this.canonical);
    for (const a of this.state.aliases) {
      if (a.status === 'active' && a.name) out.add(a.name);
    }
    return out;
  }

  activeList() {
    return [...this.activeNames()];
  }

  /** 固定身份：botName / selfNickname / 配置 aliases。 */
  bootstrap({ botName = '', selfNickname = '', aliases = [] } = {}) {
    const canonical = clean(botName) || this.canonical || '小鲸鱼';
    this.state.canonical = canonical;
    for (const raw of [canonical, selfNickname, ...aliases]) {
      const name = clean(raw);
      if (!valid(name)) continue;
      if (name === canonical) continue;
      const existing = this.state.aliases.find((a) => a.name === name);
      if (existing) {
        existing.status = 'active';
        existing.confidence = 1;
        existing.source = existing.source || 'bootstrap';
        existing.score = Math.max(Number(existing.score) || 0, SOURCE_WEIGHT.bootstrap);
        existing.lastSeen = Date.now();
      } else if (this.#activeCount() < MAX_ACTIVE) {
        const now = Date.now();
        this.state.aliases.push({
          name,
          status: 'active',
          confidence: 1,
          source: 'bootstrap',
          count: 1,
          score: SOURCE_WEIGHT.bootstrap,
          hits: [now],
          lastDecayAt: now,
          firstSeen: now,
          lastSeen: now,
          evidence: []
        });
      }
    }
    // 迁移：老版本把"测了多少次""你的灵魂被禁锢了"这类句子碎片收进了候选，
    // 挤满 3+8 的格子，新称呼再也进不来。加载时按新规则清一遍候选（active 保留，
    // 避免把已经生效的真称呼误删）。
    this.state.aliases = this.state.aliases.filter((a) => a.status === 'active' || valid(String(a.name || '')));
    this.review();
    this.save();
    return this;
  }

  #activeCount() {
    return this.state.aliases.filter((a) => a.status === 'active').length;
  }

  #find(name) {
    return this.state.aliases.find((a) => a.name === name) || null;
  }

  /** 明确命名：直接转正（受上限约束）。 */
  explicit(raw, source = 'explicit', evidence = '') {
    const name = clean(raw);
    if (!valid(name) || name === this.canonical) return false;
    if (this.state.rejected.includes(name)) return false;
    let item = this.#find(name);
    if (!item) {
      if (this.#activeCount() >= MAX_ACTIVE) {
        // 群名片/主人明确命名优先：挤掉一个置信度最低的非固定别名。
        if (source === 'group-card' || source === 'explicit-owner') {
          const victim = this.state.aliases
            .filter((a) => a.status === 'active' && a.source !== 'bootstrap')
            .sort((a, b) => (Number(a.confidence) || 0) - (Number(b.confidence) || 0))[0];
          if (victim) {
            victim.status = 'candidate';
            victim.confidence = Math.min(Number(victim.confidence) || 0.5, 0.4);
          } else {
            return this.candidate(name, source, evidence);
          }
        } else {
          // 上限满了：只留候选，不硬塞
          return this.candidate(name, source, evidence);
        }
      }
      item = {
        name,
        status: 'active',
        confidence: 1,
        source,
        count: 1,
        score: weightOf(source),
        hits: [Date.now()],
        lastDecayAt: Date.now(),
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        evidence: []
      };
      this.state.aliases.push(item);
    } else {
      item.status = 'active';
      item.confidence = 1;
      item.source = source;
      this.#bump(item, source, evidence);
    }
    if (evidence) item.evidence = [...new Set([...(item.evidence || []), String(evidence)])].slice(-8);
    this.save();
    return true;
  }

  /** 被直接叫到时的候选：按分数 + 近 7 天次数转正（不是数够 3 次就转）。 */
  candidate(raw, source = 'addressed', evidence = '') {
    const name = clean(raw);
    if (!valid(name) || name === this.canonical) return false;
    if (this.state.rejected.includes(name)) return false;
    if (this.activeNames().has(name)) {
      const active = this.#find(name);
      if (active) this.#bump(active, source, evidence);
      this.save();
      return true;
    }
    let item = this.#find(name);
    if (!item) {
      // 容量按"候选数"算，不是按 aliases 总数：活跃别名和候选是两格预算，
      // 之前用总数 >= 3+8 判断，导致活跃位空着时候选能涨到 9 个。
      const candCount = this.state.aliases.filter((a) => a.status === 'candidate').length;
      if (candCount >= MAX_CANDIDATE) {
        // 满了不是"拒收新词"，而是先淘汰最没希望的那个候选（分数最低、只被叫过一次）。
        // 老实现直接 return false —— 垃圾候选一旦占满格子，真正的新称呼就永远进不来。
        const victim = this.state.aliases
          .filter((a) => a.status === 'candidate' && Number(a.count) < 2)
          .sort((a, b) => (Number(a.score) || 0) - (Number(b.score) || 0)
            || Number(a.lastSeen || 0) - Number(b.lastSeen || 0))[0];
        if (!victim) return false;
        this.state.aliases = this.state.aliases.filter((a) => a !== victim);
      }
      item = {
        name,
        status: 'candidate',
        confidence: 0.2,
        source,
        count: 0,
        score: 0,
        hits: [],
        lastDecayAt: Date.now(),
        firstSeen: Date.now(),
        lastSeen: Date.now(),
        evidence: []
      };
      this.state.aliases.push(item);
    }
    const now = Date.now();
    this.#bump(item, source, evidence, now);
    if (item.status === 'candidate'
      && Number(item.score) >= PROMOTE_SCORE
      && hitsIn7d(item, now) >= PROMOTE_HITS_7D
      && this.#activeCount() < MAX_ACTIVE) {
      item.status = 'active';
      item.confidence = Math.min(0.9, 0.5 + Number(item.score) * 0.05);
    }
    this.save();
    return true;
  }

  reject(raw) {
    const name = clean(raw);
    if (!name) return;
    if (!this.state.rejected.includes(name)) this.state.rejected.push(name);
    this.state.rejected = this.state.rejected.slice(-20);
    this.state.aliases = this.state.aliases.filter((a) => a.name !== name);
    this.save();
  }

  touch(name) {
    const item = this.#find(clean(name));
    if (!item) return;
    item.lastSeen = Date.now();
    this.save();
  }

  /** 自审：按周衰减分数，再按分数 + 闲置时长降级/淘汰。 */
  review(now = Date.now()) {
    for (const a of this.state.aliases) {
      // 1) 每周衰减 10%：三个月没被叫过，分数只剩约 22%，自然掉出去。
      const since = Number(a.lastDecayAt || a.firstSeen || now);
      const weeks = (now - since) / (7 * DAY);
      if (weeks >= 1) {
        a.score = Number(a.score || 0) * Math.pow(0.9, weeks);
        a.lastDecayAt = now;
      }
      const last = Number(a.lastSeen || a.firstSeen || 0);
      const score = Number(a.score || 0);
      // 2) 活跃但分数掉下去 + 长期没出现 → 降候选（bootstrap 固定称呼不降）
      if (a.status === 'active' && a.source !== 'bootstrap' && score < DEMOTE_SCORE && now - last > 60 * DAY) {
        a.status = 'candidate';
        a.confidence = Math.min(Number(a.confidence) || 0.5, 0.4);
      }
      // 3) 候选分数太低 + 一个月没出现 → 删除
      if (a.status === 'candidate' && score < DROP_SCORE && now - last > 30 * DAY) {
        a.__drop = true;
      }
    }
    this.state.aliases = this.state.aliases.filter((a) => !a.__drop);
    return this;
  }

  save() {
    writeJsonAtomic(this.file, this.state);
  }
}

export { clean, valid, STOP, FILE };

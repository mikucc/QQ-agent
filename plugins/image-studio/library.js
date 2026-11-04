// 生图工作室 · 本地参考库
import fs from 'node:fs';
import path from 'node:path';
import {
  CATEGORIES,
  CATEGORY_LABEL,
  LIBRARY_DIR,
  ensureDirs,
  readJson,
  writeJsonAtomic
} from './store.js';

const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

const DEFAULTS = {
  characters: {
    '卡提希雅': {
      name: '卡提希雅',
      aliases: ['卡提', '提希雅'],
      description: '浅金色长发（偏暖、有光泽，长度过腰），蓝色系大眼，长而尖的精灵耳，额头正中一枚深色四角星印记，白皙少女脸、脸颊带淡红晕，纤细高挑。',
      traits: '元气、清纯灵动，带一点小恶魔感；耳朵怕痒，害羞时耳朵尖会红。',
      defaultOutfit: '水手JK'
    }
  },
  outfits: {
    '水手JK': {
      name: '水手JK',
      description: '白色短款水手服上衣，黑色宽翻领带白色细边，浅米色褶皱领结；浅蓝色百褶裙、黑色细腰带；浅蓝色宽松长袖外套，袖口黑色条纹与奶油色蝴蝶结。'
    }
  },
  scenes: {
    '河边步道': {
      name: '河边步道',
      description: '南方小城傍晚的河边步道，栏杆、旧路灯、树影，风里有水汽。'
    }
  },
  props: {
    '手机': {
      name: '手机',
      description: '普通的深色手机，屏幕亮着，常被拿在手里。'
    }
  }
};

export function ensureDefaults() {
  ensureDirs();
  for (const [category, items] of Object.entries(DEFAULTS)) {
    for (const [name, entry] of Object.entries(items)) {
      const dir = path.join(LIBRARY_DIR, category, name);
      const file = path.join(dir, 'entry.json');
      if (!fs.existsSync(file)) {
        fs.mkdirSync(dir, { recursive: true });
        writeJsonAtomic(file, entry);
      }
    }
  }
}

function imageFiles(dir) {
  try {
    return fs.readdirSync(dir)
      .filter((f) => IMAGE_EXT.test(f))
      .sort()
      .map((f) => ({ file: f, abs: path.join(dir, f) }));
  } catch {
    return [];
  }
}

function normalizeEntry(category, dir, raw, fallbackName) {
  const name = String(raw?.name || fallbackName || path.basename(dir)).trim();
  const entry = {
    category,
    id: String(raw?.id || path.basename(dir) || name),
    name,
    aliases: Array.isArray(raw?.aliases) ? raw.aliases.map(String) : [],
    description: String(raw?.description || '').trim(),
    traits: String(raw?.traits || '').trim(),
    defaultOutfit: String(raw?.defaultOutfit || '').trim(),
    situationOutfits: raw?.situationOutfits && typeof raw.situationOutfits === 'object' ? raw.situationOutfits : {},
    dir,
    images: imageFiles(dir)
  };
  return entry;
}

function scanCategory(category) {
  const root = path.join(LIBRARY_DIR, category);
  const entries = [];
  let names = [];
  try { names = fs.readdirSync(root); } catch { return entries; }
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const full = path.join(root, name);
    let stat;
    try { stat = fs.statSync(full); } catch { continue; }
    if (stat.isDirectory()) {
      const raw = readJson(path.join(full, 'entry.json'), null);
      entries.push(normalizeEntry(category, full, raw, name));
      continue;
    }
    if (stat.isFile() && IMAGE_EXT.test(name)) {
      entries.push({
        category,
        id: name.replace(IMAGE_EXT, ''),
        name: name.replace(IMAGE_EXT, ''),
        aliases: [],
        description: '',
        traits: '',
        defaultOutfit: '',
        situationOutfits: {},
        dir: root,
        images: [{ file: name, abs: full }]
      });
    }
  }
  return entries;
}

export function scanAll() {
  ensureDefaults();
  const out = {};
  for (const category of CATEGORIES) out[category] = scanCategory(category);
  return out;
}

export function resolveRef(category, ref, lib) {
  const list = lib?.[category] || [];
  const key = String(ref ?? '').trim().toLowerCase();
  if (!key) return null;
  return list.find((e) => e.id.toLowerCase() === key)
    || list.find((e) => e.name.toLowerCase() === key)
    || list.find((e) => e.aliases.some((a) => String(a).toLowerCase() === key))
    || null;
}

export function mentionedIn(category, text, lib) {
  const t = String(text || '').toLowerCase();
  if (!t) return [];
  const hits = [];
  for (const e of lib?.[category] || []) {
    const names = [e.name, ...e.aliases].map((s) => String(s).toLowerCase()).filter((s) => s.length >= 2);
    if (names.some((n) => t.includes(n))) hits.push(e);
  }
  return hits;
}

export function catalogText(lib = scanAll(), max = 12) {
  const lines = [];
  for (const category of CATEGORIES) {
    const list = lib[category] || [];
    if (!list.length) continue;
    const names = list.slice(0, max).map((e) => e.name).join('、');
    lines.push(`${CATEGORY_LABEL[category]}：${names}${list.length > max ? ` 等 ${list.length} 个` : ''}`);
  }
  return lines.join('\n');
}

export function formatEntry(entry) {
  const imgs = entry.images?.length ? `参考图 ${entry.images.length} 张` : '无参考图，仅文字';
  const desc = entry.description ? `：${entry.description}` : '';
  return `[${CATEGORY_LABEL[entry.category]}] ${entry.name}（${imgs}）${desc}`;
}

// 生图工作室 · 存储与路径
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

export const ROOT = path.join(DATA_DIR, 'image-studio');
export const LIBRARY_DIR = path.join(ROOT, 'library');
export const OUTPUTS_DIR = path.join(ROOT, 'outputs');
export const CATEGORIES = ['characters', 'outfits', 'scenes', 'props'];
export const CATEGORY_LABEL = {
  characters: '人物',
  outfits: '服饰',
  scenes: '场景',
  props: '道具'
};

export function ensureDirs() {
  fs.mkdirSync(LIBRARY_DIR, { recursive: true });
  fs.mkdirSync(OUTPUTS_DIR, { recursive: true });
  for (const c of CATEGORIES) fs.mkdirSync(path.join(LIBRARY_DIR, c), { recursive: true });
}

export function readJson(file, fallback = null) {
  try {
    let text = fs.readFileSync(file, 'utf8');
    if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 1), 'utf8');
  fs.renameSync(tmp, file);
}

export function saveOutput(buffer, ext = '.png') {
  ensureDirs();
  const now = new Date();
  const dir = path.join(OUTPUTS_DIR, `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`);
  fs.mkdirSync(dir, { recursive: true });
  const id = `img-${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}-${String(now.getHours()).padStart(2, '0')}${String(now.getMinutes()).padStart(2, '0')}${String(now.getSeconds()).padStart(2, '0')}-${Math.random().toString(36).slice(2, 6)}`;
  const file = path.join(dir, `${id}${ext}`);
  fs.writeFileSync(file, buffer);
  return { id, file };
}

export function extFromMime(mime = '', url = '') {
  const m = String(mime).toLowerCase();
  if (m.includes('jpeg') || m.includes('jpg')) return '.jpg';
  if (m.includes('webp')) return '.webp';
  if (m.includes('gif')) return '.gif';
  if (m.includes('png')) return '.png';
  const u = String(url).toLowerCase().split('?')[0];
  if (u.endsWith('.jpg') || u.endsWith('.jpeg')) return '.jpg';
  if (u.endsWith('.webp')) return '.webp';
  if (u.endsWith('.gif')) return '.gif';
  return '.png';
}

export function dataUri(buffer, mime = 'image/png') {
  return `data:${mime};base64,${Buffer.from(buffer).toString('base64')}`;
}

export function aspectToSize(aspect, fallback = '1024x1024') {
  const s = String(aspect || '').trim();
  if (/^\d{3,4}x\d{3,4}$/.test(s)) return s;
  const map = {
    '1:1': '1024x1024',
    '3:4': '1024x1536',
    '4:3': '1536x1024',
    '9:16': '1024x1536',
    '16:9': '1536x1024'
  };
  return map[s] || fallback;
}

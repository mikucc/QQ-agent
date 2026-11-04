// 生图工作室 · 生图接口
import fs from 'node:fs';
import path from 'node:path';
import { detectImageType } from '../../src/image-type.js';
import { aspectToSize, dataUri, extFromMime } from './store.js';

function baseUrl(cfg) {
  return String(cfg.baseUrl || '').trim().replace(/\/+$/, '');
}

function headers(cfg) {
  const h = { Authorization: `Bearer ${String(cfg.apiKey || '').trim()}` };
  if (String(cfg.extraHeaderName || '').trim() && String(cfg.extraHeaderValue || '').trim()) {
    h[String(cfg.extraHeaderName).trim()] = String(cfg.extraHeaderValue).trim();
  }
  return h;
}

function timeoutMs(cfg) {
  return Math.max(5000, Math.min(600000, Number(cfg.timeoutMs) || 180000));
}

function mimeOf(file) {
  const e = path.extname(file).toLowerCase();
  if (e === '.jpg' || e === '.jpeg') return 'image/jpeg';
  if (e === '.webp') return 'image/webp';
  if (e === '.gif') return 'image/gif';
  return 'image/png';
}

async function readError(res) {
  let body = '';
  try { body = (await res.text()).slice(0, 600); } catch { /* ignore */ }
  return `生图 API HTTP ${res.status}：${body || res.statusText}`;
}

function findImage(value) {
  let b64 = null;
  let url = null;
  const visit = (x) => {
    if (!x) return;
    if (typeof x === 'string') {
      if (!b64 && /^[A-Za-z0-9+/=]{200,}$/.test(x)) b64 = x;
      if (!url && /^https?:\/\//.test(x) && /\.(png|jpe?g|webp|gif)(\?|$)/i.test(x)) url = x;
      return;
    }
    if (Array.isArray(x)) { for (const y of x) visit(y); return; }
    if (typeof x !== 'object') return;
    for (const key of ['b64_json', 'image_base64', 'base64', 'b64']) {
      if (!b64 && typeof x[key] === 'string' && x[key].length > 100) b64 = x[key];
    }
    for (const key of ['url', 'result_url', 'result_urls', 'image_url', 'image_urls', 'output', 'images', 'data', 'results']) {
      if (x[key]) visit(x[key]);
    }
    if (x.image && x.image.url) visit(x.image.url);
  };
  visit(value);
  return { b64, url };
}

async function toBuffer(value, cfg) {
  const { b64, url } = findImage(value);
  if (b64) {
    const clean = b64.replace(/^data:image\/[a-z0-9.+-]+;base64,/i, '');
    const buffer = Buffer.from(clean, 'base64');
    return { buffer, ext: detectImageType(buffer)?.ext || '.png' };
  }
  if (url) {
    const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs(cfg)) });
    if (!res.ok) throw new Error(`下载生成图失败：HTTP ${res.status}`);
    const buf = Buffer.from(await res.arrayBuffer());
    return { buffer: buf, ext: extFromMime(res.headers.get('content-type') || '', url) };
  }
  throw new Error(`生图 API 返回里没有图片数据：${JSON.stringify(value).slice(0, 400)}`);
}

async function openaiGenerate({ prompt, refs, cfg }) {
  const base = baseUrl(cfg);
  const size = aspectToSize(cfg.aspect, cfg.size || '1024x1024');
  const model = String(cfg.model || 'gpt-image-1').trim();
  if (!refs.length) {
    const res = await fetch(`${base}/images/generations`, {
      method: 'POST',
      headers: { ...headers(cfg), 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model,
        prompt,
        n: 1,
        size,
        ...(cfg.quality ? { quality: cfg.quality } : {}),
        response_format: 'b64_json'
      }),
      signal: AbortSignal.timeout(timeoutMs(cfg))
    });
    if (!res.ok) throw new Error(await readError(res));
    return toBuffer(await res.json(), cfg);
  }

  const form = new FormData();
  form.append('model', model);
  form.append('prompt', prompt);
  form.append('n', '1');
  form.append('size', size);
  form.append('response_format', 'b64_json');
  if (cfg.quality) form.append('quality', cfg.quality);
  for (const ref of refs) {
    const buf = fs.readFileSync(ref.path);
    form.append('image', new Blob([buf], { type: mimeOf(ref.path) }), path.basename(ref.path));
  }
  const res = await fetch(`${base}/images/edits`, {
    method: 'POST',
    headers: headers(cfg),
    body: form,
    signal: AbortSignal.timeout(timeoutMs(cfg))
  });
  if (!res.ok) throw new Error(await readError(res));
  return toBuffer(await res.json(), cfg);
}

async function task65535Generate({ prompt, refs, cfg }) {
  const base = baseUrl(cfg);
  const imageUrls = refs.map((r) => dataUri(fs.readFileSync(r.path), mimeOf(r.path)));
  const body = {
    model: String(cfg.model || '').trim(),
    input: { prompt, image_urls: imageUrls },
    response_format: 'b64_json',
    size: aspectToSize(cfg.aspect, cfg.size || '1024x1024')
  };
  const submit = await fetch(`${base}/v1/tasks`, {
    method: 'POST',
    headers: {
      ...headers(cfg),
      'Content-Type': 'application/json',
      'Idempotency-Key': `qq-agent-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs(cfg))
  });
  if (!submit.ok) throw new Error(await readError(submit));
  const first = await submit.json();
  let task = first;
  const id = first?.id || first?.task_id || first?.data?.id;
  const deadline = Date.now() + timeoutMs(cfg);
  while (id && Date.now() < deadline) {
    const state = String(task?.status || task?.state || '').toLowerCase();
    if (['succeeded', 'success', 'completed', 'done'].includes(state)) break;
    if (['failed', 'error', 'cancelled', 'canceled'].includes(state)) {
      throw new Error(`生图任务失败：${JSON.stringify(task).slice(0, 500)}`);
    }
    await new Promise((r) => setTimeout(r, 2000));
    const poll = await fetch(`${base}/v1/tasks/${encodeURIComponent(id)}`, {
      headers: headers(cfg),
      signal: AbortSignal.timeout(timeoutMs(cfg))
    });
    if (!poll.ok) throw new Error(await readError(poll));
    task = await poll.json();
  }
  return toBuffer(task, cfg);
}

export async function generate({ prompt, refs = [], cfg = {} }) {
  const provider = String(cfg.provider || 'openai').toLowerCase();
  if (!baseUrl(cfg)) throw new Error('生图 Base URL 未配置');
  if (!String(cfg.apiKey || '').trim()) throw new Error('生图 API Key 未配置');
  if (provider === '65535') return task65535Generate({ prompt, refs, cfg });
  return openaiGenerate({ prompt, refs, cfg });
}

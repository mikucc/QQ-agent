// 临时诊断脚本：直接连 SnowLuma 的 OneBot WS，把收到的事件原样打印出来。
//
// 用法：
//   node scripts/onebot-ws-probe.mjs
// 然后给机器人发一条消息（私聊或群里 @），看这里有没有输出。
//
// 它能区分两种"不回复"：
//   · 这里能打印事件  → SnowLuma 推送正常，问题在 QQ Agent 的处理/白名单/模型
//   · 这里也没有事件  → SnowLuma 没往 WS 客户端推，问题在协议端
//
// 只读，不改任何配置；60 秒后自动退出。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cfg = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'config.json'), 'utf8'));
const base = String(cfg?.snowluma?.wsUrl || 'ws://127.0.0.1:3001');
const token = String(cfg?.snowluma?.accessToken || '');
const url = token ? `${base}${base.includes('?') ? '&' : '?'}access_token=${encodeURIComponent(token)}` : base;

console.log('[probe] 连接', base, token ? '(带 token)' : '(无 token)');
const ws = new WebSocket(url, { headers: token ? { authorization: `Bearer ${token}` } : {} });

ws.on('open', () => console.log('[probe] OPEN —— 已连上，请给机器人发消息'));
ws.on('message', (data) => {
  const text = String(data);
  console.log('[probe] MSG', text.length > 800 ? text.slice(0, 800) + '…' : text);
});
ws.on('close', (code, reason) => console.log('[probe] CLOSE', code, String(reason || '')));
ws.on('error', (e) => console.log('[probe] ERROR', e?.message || e));

setTimeout(() => {
  console.log('[probe] 60 秒到，退出');
  try { ws.close(); } catch { /* ignore */ }
  setTimeout(() => process.exit(0), 500);
}, 60_000);

// 对话状态卡 · 纯本地测试（不连模型、不连 OneBot）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dialogue-state-test-'));
process.env.QQ_AGENT_DATA_DIR = testRoot;

const { prepareForRun, recordRun, render, load, clear } = await import('../src/dialogue-state.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const KEY = 'group:1';
const T0 = 1_800_000_000_000;   // 固定时间，避免真实时钟影响 TTL 断言

ok('没发过言 → 不注入任何东西', () => {
  assert.equal(prepareForRun({ chatKey: KEY, now: T0 }), '');
});

ok('发了一句陈述 → 只记「上一条」，不算在等回答', () => {
  recordRun({ chatKey: KEY, sent: [{ text: '搬完家啦' }], triggerEntries: [{ senderId: '123', senderName: '甲' }], now: T0 });
  const st = load(KEY);
  assert.equal(st.lastSelf.text, '搬完家啦');
  assert.equal(st.pendingAsk, null);
  const text = prepareForRun({ chatKey: KEY, now: T0 + 60_000 });
  assert.ok(text.includes('你上一条是「搬完家啦」'));
  assert.ok(!text.includes('在等'));
});

ok('发了一个问题 → 记成「在等谁回」', () => {
  recordRun({ chatKey: KEY, sent: [{ text: '你刚说啥？' }], triggerEntries: [{ senderId: '123', senderName: '甲' }], now: T0 });
  const text = prepareForRun({ chatKey: KEY, now: T0 + 60_000 });
  assert.ok(text.includes('你在等 甲 回你'));
});

ok('对方回了 → 待答闭合，不再提醒', () => {
  const text = prepareForRun({ chatKey: KEY, triggerEntries: [{ senderId: '123', text: '没事了' }], now: T0 + 120_000 });
  assert.ok(!text.includes('你在等'));
});

ok('超过 30 分钟没回 → 待答自动过期', () => {
  recordRun({ chatKey: KEY, sent: [{ text: '在吗？' }], triggerEntries: [{ senderId: '123', senderName: '甲' }], now: T0 });
  const text = prepareForRun({ chatKey: KEY, now: T0 + 31 * 60_000 });
  assert.ok(!text.includes('你在等'));
});

ok('超过 2 小时 → 不再提「上一句」', () => {
  recordRun({ chatKey: KEY, sent: [{ text: '睡了' }], triggerEntries: [{ senderId: '123' }], now: T0 });
  const text = prepareForRun({ chatKey: KEY, now: T0 + 121 * 60_000 });
  assert.equal(text, '');
});

ok('活跃话题未到期 → 注入；过期 → 不注入', () => {
  recordRun({ chatKey: KEY, sent: [{ text: '嗯' }], triggerEntries: [{ senderId: '123' }], now: T0 });
  const alive = prepareForRun({ chatKey: KEY, topic: '周末去哪玩', topicUntil: T0 + 10 * 60_000, now: T0 + 60_000 });
  assert.ok(alive.includes('还没聊完的事：周末去哪玩'));
  const dead = prepareForRun({ chatKey: KEY, now: T0 + 20 * 60_000 });
  assert.ok(!dead.includes('周末去哪玩'));
});

ok('超长发言被截断，不会把整段塞进提示词', () => {
  recordRun({ chatKey: KEY, sent: [{ text: '啊'.repeat(300) }], triggerEntries: [{ senderId: '123' }], now: T0 });
  assert.ok(load(KEY).lastSelf.text.length <= 60);
});

ok('clear 删掉状态', () => {
  clear(KEY);
  assert.equal(prepareForRun({ chatKey: KEY, now: T0 }), '');
});

ok('render 只吃字段、不读盘（纯函数）', () => {
  const text = render({ lastSelf: { text: '在呢', at: T0 }, pendingAsk: null, topic: null }, T0 + 1000);
  assert.ok(text.startsWith('【对话状态】'));
  assert.ok(text.includes('在呢'));
});

console.log(`\n对话状态卡：通过 ${passed}，失败 0`);

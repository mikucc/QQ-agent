// 约定/待办 · 纯本地测试（不调模型）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-followups-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const fu = await import('../src/followups.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

const BASE = new Date('2026-11-04T10:00:00+08:00').getTime();
const KEY = 'private:10001';

ok('parseDue：明天 → 次日 10 点', () => {
  const r = fu.parseDue('明天给你图', BASE);
  const d = new Date(r.dueAt);
  assert.equal(d.getDate(), 5);
  assert.equal(d.getHours(), 10);
  assert.equal(r.dueText, '明天');
});

ok('parseDue：今晚 → 当天 20:30', () => {
  const r = fu.parseDue('今晚发你', BASE);
  assert.equal(new Date(r.dueAt).getHours(), 20);
  assert.equal(r.dueText, '今晚');
});

ok('parseDue：周末 → 下一个周六', () => {
  const r = fu.parseDue('周末一起', BASE);
  assert.equal(new Date(r.dueAt).getDay(), 6);
});

ok('parseDue：认不出来的短语 → 2 小时后', () => {
  const r = fu.parseDue('嗯 好', BASE);
  assert.equal(r.dueAt, BASE + 2 * 3600000);
});

ok('looksLikePromise 只对约定类词命中', () => {
  assert.equal(fu.looksLikePromise('明天考试 你记得吗'), true);
  assert.equal(fu.looksLikePromise('哈哈哈'), false);
});

ok('add + due：到期才算', () => {
  const item = fu.add(KEY, { what: '发那天的图', who: '10001', whoName: '菲比', dueAt: BASE + 1000, dueText: '晚点', now: BASE });
  assert.ok(item?.id);
  assert.equal(fu.due(KEY, BASE).length, 0);
  assert.equal(fu.due(KEY, BASE + 2000).length, 1);
});

ok('同一件事不重复记', () => {
  const again = fu.add(KEY, { what: '发那天的图', dueAt: BASE + 5000, now: BASE });
  assert.equal(again, null);
});

ok('markAsked 之后不再算到期', () => {
  const [item] = fu.due(KEY, BASE + 2000);
  fu.markAsked(KEY, item.id, BASE + 2000);
  assert.equal(fu.due(KEY, BASE + 3000).length, 0);
});

ok('dueChats 能扫到其它会话的到期项', () => {
  fu.add('group:20002', { what: '问一下考试结果', whoName: '甲', dueAt: BASE + 1000, dueText: '明天', now: BASE });
  const list = fu.dueChats(BASE + 2000);
  assert.ok(list.some((x) => x.chatKey === 'group:20002'));
});

ok('formatForPrompt 渲染成一行', () => {
  const text = fu.formatForPrompt([{ whoName: '菲比', what: '发照片', dueText: '晚点' }]);
  assert.ok(text.includes('菲比') && text.includes('发照片'));
});

ok('运行态：lastAt / missStreak 可读写', () => {
  fu.patchChatMeta(KEY, { lastAt: 123, missStreak: 1 });
  const m = fu.getChatMeta(KEY);
  assert.equal(m.lastAt, 123);
  assert.equal(m.missStreak, 1);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n约定/待办：通过 ${passed}，失败 0`);

// 情景事实层测试（临时数据目录，不碰真实数据）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-facts-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const facts = await import('../src/facts.js');
const now = Date.now();
const KEY = 'private:10001';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('add + fresh 能取回', () => {
  facts.add(KEY, '电脑坏了', now);
  facts.add(KEY, '在公交车上', now);
  const list = facts.fresh(KEY, now);
  assert.equal(list.length, 2);
  assert.ok(list.some((x) => x.text === '电脑坏了'));
});

ok('同一件事重复写不会堆', () => {
  facts.add(KEY, '电脑坏了', now + 1000);
  assert.equal(facts.fresh(KEY, now + 1000).filter((x) => x.text === '电脑坏了').length, 1);
});

ok('过期的不再返回', () => {
  const later = now + 25 * 3600000;
  assert.equal(facts.fresh(KEY, later).length, 0);
});

ok('prune 清掉过期条目', () => {
  facts.prune(KEY, now + 25 * 3600000);
  assert.equal(facts.fresh(KEY, now + 25 * 3600000).length, 0);
});

ok('renderForPrompt 有内容时带标记', () => {
  facts.add(KEY, '这两天很忙', now);
  const text = facts.renderForPrompt(KEY, now);
  assert.ok(text.includes('他现在的情况'));
  assert.ok(text.includes('这两天很忙'));
});

ok('没有事实时 render 返回空串', () => {
  assert.equal(facts.renderForPrompt('private:99999', now), '');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n情景事实层：通过 ${pass}，失败 0`);

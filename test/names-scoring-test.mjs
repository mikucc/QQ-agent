// 称呼评分制 · 纯本地测试（不连模型、不连 OneBot）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'names-scoring-test-'));
const { NameBook } = await import('../plugins/attention-gate/names.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

let seq = 0;
function fresh(opts = {}) {
  seq += 1;
  const b = new NameBook(path.join(root, `n${seq}.json`));
  b.bootstrap({ botName: '小鲸鱼', selfNickname: '', aliases: [], ...opts });
  return b;
}

ok('bootstrap：固定称呼直接是 active', () => {
  const b = fresh();
  assert.ok(b.activeNames().has('小鲸鱼'));
});

ok('句子碎片进不来（短语过滤）', () => {
  const b = fresh();
  assert.equal(b.candidate('测了多少次', 'addressed'), false);
  assert.equal(b.candidate('你的灵魂被禁锢了', 'addressed'), false);
  assert.equal(b.candidate('你忘了吗', 'addressed'), false);
});

ok('合法昵称进候选，但一次不够转正', () => {
  const b = fresh();
  assert.equal(b.candidate('小肥鱼', 'addressed'), true);
  assert.equal(b.activeNames().has('小肥鱼'), false);
});

ok('候选两次仍未转正（分数 3.0 < 4）', () => {
  const b = fresh();
  b.candidate('小肥鱼', 'addressed');
  b.candidate('小肥鱼', 'addressed');
  assert.equal(b.activeNames().has('小肥鱼'), false);
});

ok('候选第三次转正（分数 4.5，近 7 天 3 次）', () => {
  const b = fresh();
  b.candidate('小肥鱼', 'addressed');
  b.candidate('小肥鱼', 'addressed');
  b.candidate('小肥鱼', 'addressed');
  assert.ok(b.activeNames().has('小肥鱼'));
});

ok('主人明确命名 → 一次就 active', () => {
  const b = fresh();
  b.explicit('大鲸鱼', 'explicit-owner', 'mid-1');
  assert.ok(b.activeNames().has('大鲸鱼'));
});

ok('群名片 → 一次就 active', () => {
  const b = fresh();
  b.explicit('鲸鱼酱', 'group-card', 'mid-2');
  assert.ok(b.activeNames().has('鲸鱼酱'));
});

ok('活跃别名上限 3 个，第 4 个只能进候选', () => {
  const b = fresh();
  b.explicit('甲一', 'explicit-owner');
  b.explicit('乙二', 'explicit-owner');
  b.explicit('丙三', 'explicit-owner');
  assert.equal(b.state.aliases.filter((a) => a.status === 'active').length, 3);
  b.candidate('丁四', 'addressed');
  assert.ok(!b.activeNames().has('丁四'));
});

ok('候选位满时，淘汰最弱候选而不是拒收新词', () => {
  const b = fresh();
  const names = ['甲乙', '丙丁', '戊己', '庚辛', '壬癸', '子丑', '寅卯', '辰巳'];
  for (const n of names) b.candidate(n, 'addressed');
  assert.equal(b.state.aliases.filter((a) => a.status === 'candidate').length, 8);
  b.candidate('新名号', 'addressed');
  assert.equal(b.state.aliases.filter((a) => a.status === 'candidate').length, 8);
  assert.ok(b.state.aliases.some((a) => a.name === '新名号'), '新词应该留下来');
});

ok('衰减：一年没被叫过，分数按周掉到接近 0', () => {
  const b = fresh();
  b.explicit('鲸鱼酱', 'group-card');
  const item = b.state.aliases.find((a) => a.name === '鲸鱼酱');
  const before = Number(item.score);
  b.review(Date.now() + 365 * 86400000);
  const after = Number(item.score);
  assert.ok(after < before * 0.05, `before=${before} after=${after}`);
});

ok('衰减后长期不用的别名会被降级/清掉', () => {
  const b = fresh();
  b.candidate('路人甲', 'addressed');
  b.review(Date.now() + 400 * 86400000);
  assert.equal(b.state.aliases.some((a) => a.name === '路人甲'), false);
});

ok('rejected 里的名字永远不进候选', () => {
  const b = fresh();
  b.reject('老公');
  assert.equal(b.candidate('老公', 'addressed'), false);
});

console.log(`\n称呼评分：通过 ${passed}，失败 0`);

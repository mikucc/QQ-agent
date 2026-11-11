// 记忆去重 + 主语规范测试
import assert from 'node:assert/strict';
import { isSameMemory, similarity } from '../plugins/plastic-memory/store.js';
import { normalizeSubject } from '../plugins/plastic-memory/judge.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('完全相同的两条 → 判重', () => {
  assert.equal(isSameMemory('明天睁眼先拍照', '明天睁眼先拍照'), true);
});

ok('短句被长句包含 → 判重', () => {
  assert.equal(isSameMemory('明天睁眼先拍照', '我答应明天睁眼先拍张照片给她，说话算话'), true);
});

ok('同一件事换措辞，相似度高 → 判重', () => {
  const a = '我答应明天一睁眼就给对方拍照片';
  const b = '我答应明天一睁眼先拍张照片给对方';
  assert.ok(similarity(a, b) >= 0.55, `similarity=${similarity(a, b)}`);
  assert.equal(isSameMemory(a, b), true);
});

ok('不同的两件事 → 不判重', () => {
  assert.equal(isSameMemory('对方不喜欢被要求拍脚', '对方在公交车上拍了张糊掉的照片'), false);
});

ok('主语规范：开头是 QQ 号 → 对方', () => {
  assert.equal(normalizeSubject('123456789 凌晨三点还没睡'), '对方凌晨三点还没睡');
});

ok('主语规范：开头是她自己的名字 → 我', () => {
  assert.equal(normalizeSubject('卡提 答应明天拍照'), '我答应明天拍照');
});

ok('已经规范的文本不动', () => {
  assert.equal(normalizeSubject('我答应明天拍照'), '我答应明天拍照');
});

console.log(`\n记忆去重/主语：通过 ${pass}，失败 0`);

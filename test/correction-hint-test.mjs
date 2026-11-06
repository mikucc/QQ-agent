// 纠正检测 · 纯正则测试
import assert from 'node:assert/strict';
import { looksLikeCorrection } from '../src/prompt.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('"还没发到站呢，你怎么又下车了" → 纠正确认', () => {
  assert.equal(looksLikeCorrection('还没发到站呢，你怎么又下车了'), true);
});

ok('"我还在办事" → 纠正确认', () => {
  assert.equal(looksLikeCorrection('我还在办事，你自己逛'), true);
});

ok('"还没到站" → 纠正确认', () => {
  assert.equal(looksLikeCorrection('还没到站'), true);
});

ok('"到站了，下车吧" → 不是纠正', () => {
  assert.equal(looksLikeCorrection('到站了，下车吧'), false);
});

ok('普通闲聊不误伤', () => {
  assert.equal(looksLikeCorrection('今天吃什么'), false);
  assert.equal(looksLikeCorrection('我还没吃饭'), false);
});

ok('空文本不炸', () => {
  assert.equal(looksLikeCorrection(''), false);
});

console.log(`\n纠正检测：通过 ${pass}，失败 0`);

// 转场句子去重 · 纯本地测试（不调模型）
import assert from 'node:assert/strict';

process.env.QQ_AGENT_DATA_DIR = process.env.QQ_AGENT_DATA_DIR || 'C:\\Windows\\Temp';
const { internals } = await import('../plugins/daily-schedule/index.js');
const { tooSimilar } = internals;

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

ok('同一句 → 判重', () => {
  assert.equal(tooSimilar('头发还滴着水', ['头发还滴着水']), true);
});

ok('只差标点/空格 → 判重', () => {
  assert.equal(tooSimilar('头发还滴着水。', ['头发还滴着水']), true);
});

ok('同类但换了意象 → 不算重', () => {
  assert.equal(tooSimilar('水管咕噜两声，花洒才出水', ['耳机搁在鼠标垫一角']), false);
});

ok('完全不同 → 不算重', () => {
  assert.equal(tooSimilar('被子还是暖的', ['楼道里有人关门']), false);
});

ok('空列表 / 空句子不炸', () => {
  assert.equal(tooSimilar('随便一句', []), false);
  assert.equal(tooSimilar('', ['随便一句']), false);
});

console.log(`\n转场去重：通过 ${passed}，失败 0`);

// 记忆情绪标签渲染测试
import assert from 'node:assert/strict';
import { renderMemoryLines } from '../plugins/plastic-memory/prompt.js';

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };
const pick = (memory) => renderMemoryLines([{ memory }])[0];

ok('有标签 + 高情绪 → "很"', () => {
  const line = pick({ content: '发照片一直卡在转圈', emotion: 0.8, emotionLabel: '气恼' });
  assert.ok(line.includes('（很气恼）'), line);
});

ok('有标签 + 中等情绪 → "有点"', () => {
  const line = pick({ content: '被夸了', emotion: 0.45, emotionLabel: '害羞' });
  assert.ok(line.includes('（有点害羞）'), line);
});

ok('有标签 + 低情绪 → 不加程度词', () => {
  const line = pick({ content: '聊了会儿天', emotion: 0.1, emotionLabel: '开心' });
  assert.ok(line.includes('（开心）'), line);
  assert.ok(!line.includes('有点开心'), line);
});

ok('平静不渲染', () => {
  const line = pick({ content: '吃了面', emotion: 0.2, emotionLabel: '平静' });
  assert.ok(!line.includes('平静'), line);
});

ok('没有标签就不加前缀（旧记忆兼容）', () => {
  const line = pick({ content: '旧的一条记忆', emotion: 0.5 });
  assert.ok(!line.includes('（'), line);
});

ok('珍贵标记和情绪可以同时出现', () => {
  const line = pick({ content: '第一次见面', tier: 'precious', emotion: 0.9, emotionLabel: '开心' });
  assert.ok(line.includes('这件事对你很重要'));
  assert.ok(line.includes('（很开心）'));
});

console.log(`\n记忆情绪标签：通过 ${pass}，失败 0`);

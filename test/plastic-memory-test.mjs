// 可塑性记忆 · 纯本地测试
//
// 不连模型、不连 OneBot、不碰真实 data/；用临时目录验证存储、去重、TTL、跨群过滤、注入上限。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'plastic-memory-test-'));
process.env.QQ_AGENT_DATA_DIR = root;

const { PlasticStore, isSameMemory, makeMemory } = await import('../plugins/plastic-memory/store.js');
const { selectMemories, renderMemoryLines } = await import('../plugins/plastic-memory/prompt.js');

const DAY = 86400000;
const now = Date.now();
let passed = 0;

function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

function newStore(name) {
  return new PlasticStore(path.join(root, name));
}

ok('近似内容视为同一条', () => {
  assert.equal(isSameMemory('约好周六晚上一起打本', '约好周六晚上一起打本。'), true);
  assert.equal(isSameMemory('喜欢猫', '喜欢狗'), false);
});

ok('重复写入只保留一条', () => {
  const s = newStore('dedupe');
  s.add('group:1', { content: '约好周六晚上一起打本', tier: 'important' });
  s.add('group:1', { content: '约好周六晚上一起打本。', tier: 'important' });
  assert.equal(s.load('group:1').memories.length, 1);
});

ok('普通记忆过期后进回收站，宽限期后删除', () => {
  const s = newStore('ordinary');
  s.add('group:1', { content: '今天吃了面', tier: 'ordinary', createdAt: now - 4 * DAY });
  s.prune('group:1', { ordinaryTtlDays: 3, importantTtlDays: 14, preciousArchiveDays: 30, expiredGraceDays: 7 }, now);
  assert.equal(s.load('group:1').memories[0].status, 'expired');
  s.prune('group:1', { ordinaryTtlDays: 3, importantTtlDays: 14, preciousArchiveDays: 30, expiredGraceDays: 7 }, now + 8 * DAY);
  assert.equal(s.load('group:1').memories.length, 0);
});

ok('重要记忆过期只归档，不删除', () => {
  const s = newStore('important');
  s.add('group:1', { content: '答应帮他看稿子', tier: 'important', createdAt: now - 15 * DAY });
  s.prune('group:1', { ordinaryTtlDays: 3, importantTtlDays: 14, preciousArchiveDays: 30 }, now);
  const m = s.load('group:1').memories[0];
  assert.equal(m.status, 'archived');
  assert.equal(m.content, '答应帮他看稿子');
  assert.ok(m.summary);
});

ok('珍贵记忆过期只归档，且保持保护', () => {
  const s = newStore('precious');
  s.add('group:1', { content: '第一次被认真对待', tier: 'precious', createdAt: now - 31 * DAY });
  s.prune('group:1', { ordinaryTtlDays: 3, importantTtlDays: 14, preciousArchiveDays: 30 }, now);
  const m = s.load('group:1').memories[0];
  assert.equal(m.status, 'archived');
  assert.equal(m.protected, true);
});

ok('跨群 person 模式只带人物/全局记忆', () => {
  const s = newStore('cross');
  s.add('group:1', { content: '他喜欢在周末钓鱼', tier: 'important', scope: 'person' });
  s.add('group:1', { content: '这个群昨天在聊原神', tier: 'ordinary', scope: 'chat' });
  const picked = selectMemories(s, 'group:2', { crossGroup: 'person', injectTopK: 4 }, '周末钓鱼');
  const texts = picked.map((x) => x.memory.content);
  assert.ok(texts.some((x) => x.includes('钓鱼')));
  assert.ok(!texts.some((x) => x.includes('原神')));
});

ok('off 模式不跨群', () => {
  const s = newStore('off');
  s.add('group:1', { content: '他喜欢在周末钓鱼', tier: 'important', scope: 'person' });
  const picked = selectMemories(s, 'group:2', { crossGroup: 'off', injectTopK: 4 }, '钓鱼');
  assert.equal(picked.length, 0);
});

ok('注入条数不超过 topK', () => {
  const s = newStore('topk');
  for (let i = 0; i < 10; i += 1) {
    s.add('group:1', { content: `一起打本第 ${i} 次`, tier: 'ordinary', strength: 0.9 });
  }
  const picked = selectMemories(s, 'group:1', { injectTopK: 3, crossGroup: 'off' }, '打本');
  assert.ok(picked.length <= 3);
});

ok('候选不参与注入', () => {
  const s = newStore('candidate');
  s.add('group:1', { content: '一个珍贵候选', tier: 'important', status: 'candidate' });
  const picked = selectMemories(s, 'group:1', { injectTopK: 4, crossGroup: 'off' }, '珍贵');
  assert.equal(picked.length, 0);
});

ok('渲染不暴露档位名', () => {
  const s = newStore('render');
  s.add('group:1', { content: '第一次被认真对待', tier: 'precious' });
  const picked = selectMemories(s, 'group:1', { injectTopK: 4, crossGroup: 'off' }, '认真');
  const lines = renderMemoryLines(picked).join('\n');
  assert.ok(lines.includes('这件事对你很重要'));
  assert.ok(!lines.includes('precious'));
  assert.ok(!lines.includes('珍贵'));
});

ok('makeMemory 默认值可用', () => {
  const m = makeMemory({ content: '测试' });
  assert.equal(m.tier, 'ordinary');
  assert.equal(m.status, 'active');
  assert.equal(m.protected, false);
  assert.ok(m.id.startsWith('pm_'));
});

console.log(`\n可塑性记忆：通过 ${passed}，失败 0`);

// 注意力门 · 纯本地测试（不连模型、不连 OneBot）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const testRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'attention-gate-test-'));
process.env.QQ_AGENT_DATA_DIR = testRoot;

const {
  setup,
  deactivate,
  internals
} = await import('../plugins/attention-gate/index.js');

const { decide, addressedToMe, explicitName, vocativeName, recordSpoke, isQuestion, hasEmotion } = internals;

function config(over = {}) {
  return {
    enabled: true,
    dryRun: false,
    quietIfNotAddressed: true,
    interjectChance: 0,
    interestKeywords: '',
    questionBonus: 0,
    emotionBonus: 0,
    interestBonus: 0,
    atAllBonus: 0,
    ownerBonus: 0,
    minGapSeconds: 0,
    maxWakePerHour: 60,
    aliases: '小鲸鱼',
    logDecisions: false,
    ...over
  };
}

function ctx(entries, selfId = '999') {
  return { chatKey: 'group:1', kind: 'group', selfId, entries };
}

setup({ config: () => config() });

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

ok('@ 她 → 必醒', () => {
  const r = decide(ctx([{ text: '在吗', atMe: true }]));
  assert.equal(r.wake, true);
});

ok('回复她的消息 → 必醒', () => {
  const r = decide(ctx([{ text: '你说呢', reply: { senderId: '999' } }]));
  assert.equal(r.wake, true);
});

ok('拍一拍 → 必醒', () => {
  assert.equal(addressedToMe({ isPoke: true }, '999'), true);
});

ok('叫名字 → 必醒', () => {
  const r = decide(ctx([{ text: '小鲸鱼今天在干嘛' }]));
  assert.equal(r.wake, true);
});

ok('群名片自动成为称呼，且绕过最短间隔', () => {
  const c = ctx([{ text: '肥鱼！' }]);
  c.selfCard = '肥鱼';
  assert.equal(decide(c).wake, true);
  assert.equal(decide(c).wake, true);
});

ok('刚回完对方，紧接着说“你” → 对话延续', () => {
  recordSpoke({
    chatKey: 'group:1',
    session: { id: 's-cont', sent: [{ text: '还行' }], trigger: [{ senderId: '123' }] }
  });
  const r = decide(ctx([{ senderId: '123', text: '这都快睡觉了，你刚醒十八' }]));
  assert.equal(r.wake, true);
  assert.ok(String(r.reason).includes('对话延续'));
});

ok('刚被叫醒并回了同一个人，下一句“你”仍算延续', () => {
  const a = ctx([{ senderId: '456', text: '小鲸鱼' }]);
  decide(a);
  const r = decide(ctx([{ senderId: '456', text: '你现在觉得咋样' }]));
  assert.equal(r.wake, true);
  assert.ok(String(r.reason).includes('对话延续'));
});

ok('@ 别人、且没有第二人称 → 默认沉默', () => {
  // ① 注意：这里刻意不用"你看这个"。2026-09 之后注意力门不再判断"在叫谁"，
  //    含"你/您"的消息按「对话延续」放行是设计内行为（见 decideInner ③）。
  const r = decide(ctx([{ text: '@某人 看这个', atMe: false }]));
  assert.equal(r.wake, false);
});

ok('@ 别人但接着说“你” → 按对话延续放行（设计内）', () => {
  const r = decide(ctx([{ text: '@某人 你看这个', atMe: false }]));
  assert.equal(r.wake, true);
  assert.ok(String(r.reason).includes('对话延续'));
});

ok('回复别人 → 默认沉默', () => {
  const r = decide(ctx([{ text: '对啊', reply: { senderId: '123' } }]));
  assert.equal(r.wake, false);
});

ok('明确命名/呼语提取', () => {
  assert.equal(explicitName('以后叫你肥鱼'), '肥鱼');
  assert.equal(vocativeName('小鲸鱼，在吗'), '小鲸鱼');
  assert.equal(vocativeName('在吗，小鲸鱼'), '小鲸鱼');
});

ok('问句/情绪识别', () => {
  assert.equal(isQuestion('这个怎么弄？'), true);
  assert.equal(hasEmotion('哈哈哈哈哈'), true);
});

ok('概率 0 时普通消息沉默', () => {
  const r = decide(ctx([{ text: '今天天气不错' }]));
  assert.equal(r.wake, false);
});

ok('dryRun 只记录，不拦截', () => {
  deactivate();
  setup({ config: () => config({ dryRun: true, interjectChance: 0 }) });
  const r = decide(ctx([{ text: '今天天气不错' }]));
  assert.equal(r.wake, true);
  assert.ok(String(r.reason).includes('演练'));
});

deactivate();
console.log(`\n注意力门：通过 ${passed}，失败 0`);

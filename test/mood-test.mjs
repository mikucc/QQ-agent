// 心情 · 纯本地测试（不调模型）
import assert from 'node:assert/strict';
import {
  defaultState,
  suppressChances,
  moodScore,
  applyDelta,
  normalize,
  recoverMood,
  dayKey
} from '../plugins/mood/store.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

ok('状态默认值在合法范围', () => {
  const s = defaultState();
  assert.ok(s.valence >= -1 && s.valence <= 1);
  assert.ok(s.energy >= 0 && s.energy <= 1);
  assert.ok(s.socialBattery >= 0 && s.socialBattery <= 1);
  assert.equal(s.dayKey, dayKey());
});

ok('正常心情不触发沉默', () => {
  const s = normalize({ valence: 0.4, energy: 0.8, socialBattery: 0.8 });
  const c = suppressChances(s, { replySuppressChance: 0.05, proactiveSuppressChance: 0.10, lowMoodThreshold: 0.45 });
  assert.equal(c.reply, 0);
  assert.equal(c.proactive, 0);
});

ok('低心情时 普通:主动 = 1:2', () => {
  const s = normalize({ valence: -0.8, energy: 0.15, socialBattery: 0.1 });
  const c = suppressChances(s, { replySuppressChance: 0.05, proactiveSuppressChance: 0.10, lowMoodThreshold: 0.45 });
  assert.ok(c.reply > 0 && c.reply <= 0.05);
  assert.ok(c.proactive > 0 && c.proactive <= 0.10);
  assert.ok(Math.abs(c.proactive - c.reply * 2) < 1e-9, `ratio ${c.reply}:${c.proactive}`);
});

ok('心情分越低，抑制概率越高', () => {
  const low = suppressChances(normalize({ valence: -0.5, energy: 0.3, socialBattery: 0.3 }), { lowMoodThreshold: 0.45 });
  const lower = suppressChances(normalize({ valence: -0.9, energy: 0.1, socialBattery: 0.1 }), { lowMoodThreshold: 0.45 });
  assert.ok(lower.reply >= low.reply);
});

ok('情绪更新会被限制在合法范围', () => {
  const s = normalize({ valence: 0.9, energy: 0.9, socialBattery: 0.9 });
  applyDelta(s, { valence: 1, energy: 1, social: 1 });
  assert.ok(s.valence <= 1 && s.energy <= 1 && s.socialBattery <= 1);
  assert.ok(moodScore(s) <= 1);
});

ok('社交电量极低时，标签和沉默概率一致', () => {
  const s = normalize({ valence: 0.4, energy: 0.41, socialBattery: 0.13 });
  const c = suppressChances(s, { replySuppressChance: 0.05, proactiveSuppressChance: 0.10, lowMoodThreshold: 0.5 });
  assert.ok(c.reply > 0, '低社交电量应触发沉默概率');
  assert.ok(Math.abs(c.proactive - c.reply * 2) < 1e-9, '仍保持 1:2');
});

ok('安静一段时间会向 baseline 恢复', () => {
  const now = Date.now();
  const s = normalize({
    valence: 0.4,
    energy: 0.4,
    socialBattery: 0.13,
    baseline: { valence: 0.3, arousal: 0.42, energy: 0.63, socialBattery: 0.55 },
    lastInteractionAt: now - 2 * 3600000
  });
  const r = recoverMood(s, now);
  assert.ok(r.socialBattery > 0.13);
  assert.ok(r.energy > 0.4);
  assert.ok(r.arousal >= 0);
});

console.log(`\n心情：通过 ${passed}，失败 0`);

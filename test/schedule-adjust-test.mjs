// 日程调整 · 连续性测试（纯函数，不碰文件/模型）
import assert from 'node:assert/strict';
import { planAdjustment } from '../plugins/daily-schedule/adjust.js';
import { timeToMinutes } from '../plugins/daily-schedule/store.js';

const day = {
  segments: [
    { start: '02:10', end: '11:10', activity: '睡觉', location: '家 卧室', with: '', note: '' },
    { start: '11:10', end: '11:50', activity: '赖在床上刷手机', location: '家 卧室', with: '', note: '' },
    { start: '11:50', end: '12:40', activity: '起床洗漱', location: '家 厨房', with: '', note: '' },
    { start: '12:40', end: '14:20', activity: '桌前看稿', location: '家 书桌', with: '', note: '' }
  ]
};

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('只改一格：插入后前后仍是原日程', () => {
  const r = planAdjustment(day, { start: '10:00', end: '10:30', activity: '下楼拿快递' });
  const segs = r.segments;
  assert.equal(segs[0].start, '02:10');
  assert.equal(segs[0].end, '10:00');
  assert.equal(segs[1].activity, '下楼拿快递');
  assert.equal(segs[2].start, '10:30');
  assert.equal(segs[2].activity, '睡觉');
});

ok('用 until 改到下午：后面的"赖床"被整段覆盖，不留矛盾', () => {
  const r = planAdjustment(day, { start: '10:00', until: '15:00', activity: '和主人回母校', location: '路上' });
  const segs = r.segments;
  assert.ok(!segs.some((s) => s.activity.includes('赖床')), '不应再出现赖床');
  const cover = segs.find((s) => s.activity === '和主人回母校');
  assert.equal(cover.start, '10:00');
  assert.equal(cover.end, '15:00');
  assert.equal(segs[segs.length - 1].end, '15:00');
});

ok('一次给多段计划：按顺序铺开，超时的旧段保留尾部', () => {
  const r = planAdjustment(day, {
    start: '10:00',
    segments: [
      { start: '10:00', end: '10:43', activity: '赶去火车站' },
      { start: '10:43', end: '12:00', activity: '坐火车' },
      { start: '12:00', end: '15:00', activity: '在母校逛' }
    ]
  });
  const segs = r.segments;
  const acts = segs.map((s) => s.activity);
  assert.deepEqual(acts.slice(1, 4), ['赶去火车站', '坐火车', '在母校逛']);
  assert.equal(segs[0].end, '10:00');
  assert.equal(segs[segs.length - 1].activity, '在母校逛');
  assert.equal(segs[segs.length - 1].end, '15:00');
});

ok('计划之间有空隙：自动补（待定）', () => {
  const r = planAdjustment(day, {
    start: '10:00',
    segments: [
      { start: '10:00', end: '11:00', activity: '在母校逛' },
      { start: '13:00', end: '14:00', activity: '和主人吃饭' }
    ]
  });
  const gap = r.segments.find((s) => s.activity === '（待定）');
  assert.ok(gap, '应补一段待定');
  assert.equal(gap.start, '11:00');
  assert.equal(gap.end, '13:00');
});

ok('tentative 会标（待定）', () => {
  const r = planAdjustment(day, { start: '10:00', until: '12:00', activity: '和主人回母校', tentative: true });
  assert.ok(r.segments.some((s) => s.activity === '和主人回母校（待定）'));
});

ok('时间不合法 → 报错不写入', () => {
  assert.ok(planAdjustment(day, { start: '10:00', end: '09:00', activity: 'x' }).error);
  assert.ok(planAdjustment(day, { start: 'nope', end: '11:00', activity: 'x' }).error);
  assert.ok(planAdjustment(day, { start: '10:00', end: '11:00', activity: '' }).error);
});

ok('过去的时间不让改', () => {
  const r = planAdjustment(day, { start: '09:00', until: '10:00', activity: 'x' }, { nowMin: timeToMinutes('09:30') });
  assert.ok(r.error);
});

ok('段数不会超过上限', () => {
  const r = planAdjustment(day, {
    start: '10:00',
    segments: Array.from({ length: 8 }, (_, i) => ({ start: `10:0${i}`, end: `10:1${i}`, activity: `事${i}` }))
  }, { maxSegments: 15 });
  assert.ok(r.segments.length <= 15);
});

console.log(`\n日程调整：通过 ${pass}，失败 0`);

// 每日日程 · 本地测试（不调模型）
import assert from 'node:assert/strict';
import {
  minutesToTime,
  timeToMinutes,
  nowParts
} from '../plugins/daily-schedule/store.js';
import { normalizeSegments } from '../plugins/daily-schedule/generate.js';
import { templateFor, pickDayType, parseWeights } from '../plugins/daily-schedule/templates.js';
import { renderSchedule } from '../plugins/daily-schedule/prompt.js';

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

ok('时间换算', () => {
  assert.equal(timeToMinutes('00:00'), 0);
  assert.equal(timeToMinutes('24:00'), 1440);
  assert.equal(timeToMinutes('7:30'), 450);
  assert.equal(minutesToTime(450), '07:30');
  assert.equal(minutesToTime(1440), '24:00');
  assert.equal(timeToMinutes('99:99'), null);
});

ok('模板覆盖 00:00~24:00 且 6~10 段', () => {
  for (const type of ['workday', 'rest', 'out', 'home', 'overtime', 'slack']) {
    const segs = normalizeSegments(templateFor(type), 10);
    assert.equal(segs[0].start, '00:00', type);
    assert.equal(segs[segs.length - 1].end, '24:00', type);
    assert.ok(segs.length >= 6 && segs.length <= 10, `${type}: ${segs.length}`);
  }
});

ok('补空档 / 去重叠', () => {
  const segs = normalizeSegments([
    { start: '09:00', end: '12:00', activity: '写稿' },
    { start: '11:00', end: '13:00', activity: '午饭' }
  ], 10);
  assert.equal(segs[0].start, '00:00');
  assert.equal(segs[segs.length - 1].end, '24:00');
  for (let i = 1; i < segs.length; i += 1) {
    assert.equal(segs[i - 1].end, segs[i].start);
  }
});

ok('超过上限会合并', () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    start: minutesToTime(i * 60),
    end: minutesToTime((i + 1) * 60),
    activity: `活动${i}`
  }));
  const segs = normalizeSegments(many, 8);
  assert.ok(segs.length <= 8);
  assert.equal(segs[0].start, '00:00');
  assert.equal(segs[segs.length - 1].end, '24:00');
});

ok('类型权重解析', () => {
  const w = parseWeights('workday:2,rest:1,out:0');
  assert.equal(w.workday, 2);
  assert.equal(w.rest, 1);
  assert.equal(w.out, undefined);
  assert.equal(pickDayType({ weekend: false, weightsText: 'workday:10', random: () => 0.5 }), 'workday');
});

ok('注入包含日期/此刻/接下来，不出现“日程表”', () => {
  const day = {
    date: '2026-11-03',
    dayType: 'workday',
    segments: normalizeSegments(templateFor('workday'), 10)
  };
  const now = nowParts(new Date('2026-11-03T10:30:00+08:00').getTime(), 'Asia/Shanghai');
  const text = renderSchedule(day, now);
  assert.ok(text.includes('2026-11-03'));
  assert.ok(text.includes('你此刻'));
  assert.ok(text.includes('接下来'));
  assert.ok(!text.includes('日程表'));
});

console.log(`\n每日日程：通过 ${passed}，失败 0`);

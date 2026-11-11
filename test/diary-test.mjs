// 日记插件测试（临时数据目录）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-diary-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const diary = await import('../plugins/diary/index.js');

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('写入后能读回', () => {
  const r = diary.writeDiary('今天什么都没干', { date: '2026-11-11' });
  assert.equal(r.ok, true);
  assert.ok(diary.readDiary('2026-11-11').includes('今天什么都没干'));
});

ok('同一天追加，不覆盖', () => {
  diary.writeDiary('晚上又想写两句', { date: '2026-11-11' });
  const text = diary.readDiary('2026-11-11');
  assert.ok(text.includes('今天什么都没干'));
  assert.ok(text.includes('晚上又想写两句'));
});

ok('hasDiary 判断当天有没有写', () => {
  assert.equal(diary.hasDiary('2026-11-11'), true);
  assert.equal(diary.hasDiary('2026-11-10'), false);
});

ok('空内容不写', () => {
  const r = diary.writeDiary('   ', { date: '2026-11-11' });
  assert.equal(r.ok, false);
});

ok('latestDiary 能往前找最近的', () => {
  diary.writeDiary('前一天写的', { date: '2026-11-09' });
  const now = new Date('2026-11-12T10:00:00').getTime();
  const latest = diary.latestDiary(now);
  assert.ok(latest && latest.date === '2026-11-11');
});

ok('没有日记时 latestDiary 返回 null', () => {
  const now = new Date('2026-10-01T10:00:00').getTime();
  assert.equal(diary.latestDiary(now), null);
});

ok('promptSections 注入最近一篇', () => {
  diary.setup({ config: () => ({ enabled: true, injectChars: 200 }), log: () => {}, registerTool: () => {} });
  const secs = diary.promptSections();
  assert.ok(secs.length >= 1);
  assert.ok(String(secs[0].content).includes('日记'));
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n日记：通过 ${pass}，失败 0`);

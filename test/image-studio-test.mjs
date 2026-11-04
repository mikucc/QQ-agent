// 生图工作室 · 本地测试（不调生图 API）
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-image-studio-'));
process.env.QQ_AGENT_DATA_DIR = tmp;

const store = await import('../plugins/image-studio/store.js');
const library = await import('../plugins/image-studio/library.js');
const { compose } = await import('../plugins/image-studio/compose.js');

let passed = 0;
function ok(name, fn) {
  fn();
  passed += 1;
  console.log(`  ✓ ${name}`);
}

ok('默认参考库会创建', () => {
  store.ensureDirs();
  library.ensureDefaults();
  const lib = library.scanAll();
  assert.ok(lib.characters.some((e) => e.name === '卡提希雅'));
  assert.ok(lib.outfits.some((e) => e.name === '水手JK'));
  assert.ok(lib.scenes.some((e) => e.name === '河边步道'));
});

ok('画幅映射', () => {
  assert.equal(store.aspectToSize('3:4'), '1024x1536');
  assert.equal(store.aspectToSize('1024x768'), '1024x768');
  assert.equal(store.aspectToSize('bad', '1024x1024'), '1024x1024');
});

ok('组合提示词包含画面、人物和服饰描述', () => {
  const lib = library.scanAll();
  const c = compose({
    prompt: '在河边步道散步，回头看了一眼',
    characters: ['卡提希雅'],
    scene: '河边步道',
    expression: '有点困'
  }, { maxRefs: 6, autoMatch: true }, lib);
  assert.ok(c.prompt.includes('【画面】'));
  assert.ok(c.prompt.includes('卡提希雅'));
  assert.ok(c.prompt.includes('水手JK'));
  assert.ok(c.prompt.includes('河边步道'));
  assert.ok(c.prompt.includes('有点困'));
  assert.equal(c.refs.length, 0);
});

ok('有图片时会进入参考图列表，且不超上限', () => {
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nGQAAAAASUVORK5CYII=',
    'base64'
  );
  const dir = path.join(store.LIBRARY_DIR, 'characters', '卡提希雅');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'front.png'), png);
  const lib = library.scanAll();
  const c = compose({
    prompt: '自拍',
    characters: ['卡提希雅'],
    outfits: ['水手JK'],
    scene: '河边步道'
  }, { maxRefs: 2, refsPerCharacter: 2, autoMatch: true }, lib);
  assert.ok(c.refs.length <= 2);
  assert.ok(c.refs.length >= 1);
  assert.ok(c.prompt.includes('参考图说明'));
});

ok('查库能按关键词找到条目', () => {
  const lib = library.scanAll();
  assert.ok(library.resolveRef('characters', '卡提', lib));
  assert.equal(library.resolveRef('characters', '不存在', lib), null);
  assert.ok(library.mentionedIn('scenes', '去河边步道走走', lib).length >= 1);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n生图工作室：通过 ${passed}，失败 0`);

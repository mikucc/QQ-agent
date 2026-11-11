// 参考图去重测试：同一张图不能作为两条参考发出去
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { compose } from '../plugins/image-studio/compose.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-refdedupe-'));
const same = path.join(tmp, 'same.png');
const other = path.join(tmp, 'other.png');
fs.writeFileSync(same, Buffer.from('identical-bytes'));
fs.copyFileSync(same, path.join(tmp, 'same-copy.png'));
fs.writeFileSync(other, Buffer.from('different-bytes'));

const lib = {
  characters: [{ category: 'characters', id: 'c', name: '卡提希雅', aliases: [], description: '她', images: [{ abs: same }] }],
  outfits: [
    { category: 'outfits', id: 'jk', name: '水手JK', aliases: [], description: '水手服', images: [{ abs: path.join(tmp, 'same-copy.png') }] },
    { category: 'outfits', id: 'home', name: '居家运动', aliases: [], description: '运动服', images: [{ abs: other }] }
  ],
  scenes: [],
  props: []
};

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('人物图和服饰图内容相同 → 只发一条', () => {
  const c = compose({ prompt: '在河边散步', characters: ['卡提希雅'], outfits: ['水手JK'] }, {}, lib);
  assert.equal(c.refs.length, 1);
  assert.equal(c.refs[0].label, '人物「卡提希雅」');
});

ok('内容不同的两张 → 都发', () => {
  const c = compose({ prompt: '在家', characters: ['卡提希雅'], outfits: ['居家运动'] }, {}, lib);
  assert.equal(c.refs.length, 2);
});

ok('跳过的服饰仍然用文字描述', () => {
  const c = compose({ prompt: '在河边散步', characters: ['卡提希雅'], outfits: ['水手JK'] }, {}, lib);
  assert.ok(c.prompt.includes('水手服'), c.prompt);
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n参考图去重：通过 ${pass}，失败 0`);

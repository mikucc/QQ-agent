// 表情包读法 · 提示词回归测试（确保规则和例子还在）
import assert from 'node:assert/strict';
import { buildSystemPrompt } from '../src/prompt.js';

process.env.QQ_AGENT_DATA_DIR = process.env.QQ_AGENT_DATA_DIR || 'C:\\Windows\\Temp';

const sys = buildSystemPrompt({ persona: { botName: '卡提希雅', roleText: '测试人设' }, skillContext: {} });

let pass = 0;
const ok = (name, fn) => { fn(); pass += 1; console.log(`  ✓ ${name}`); };

ok('包含“一句情绪”的读法规则', () => {
  assert.ok(sys.includes('一句情绪'), '缺少表情包读法规则');
});

ok('明确禁止描述画面/追问是谁', () => {
  assert.ok(sys.includes('不要描述画面里有什么'));
  assert.ok(sys.includes('这画的谁'));
});

ok('带正反例', () => {
  assert.ok(sys.includes('谁欠你钱了'));
  assert.ok(sys.includes('撇嘴 你倒是会'));
});

ok('例外：明确问“这是什么”时才说内容', () => {
  assert.ok(sys.includes('只有对方明确问'));
});

console.log(`\n表情包读法：通过 ${pass}，失败 0`);

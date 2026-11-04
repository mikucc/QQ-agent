#!/usr/bin/env node
// 提交前敏感信息检查（pre-commit 钩子调用，也可以手动跑：node scripts/check-secrets.mjs）
//
// 两道检查：
//   ① 路径：data/、.trash/、snowluma/、node_modules/、*.env、*.key、*.pem 一律不许进版本库
//   ② 内容：私钥块、sk- 开头的 Key、非空的 apiKey/token/secret/password、Bearer、本机用户路径
//
// 个人信息（自己的 QQ 号、昵称、群号）不写进脚本 —— 那种东西写进仓库等于自曝。
// 放在未跟踪的 .git/info/personal-terms.txt 里（一行一个词），脚本会自动读。
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const BLOCKED_PATH = /^(data\/|\.trash\/|snowluma\/|node_modules\/|runtime\/|release\/|dist\/)|\.(env|key|pem|p12|pfx)$/i;

const RULES = [
  ['私钥块', /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
  ['API Key（sk- 开头）', /\bsk-[A-Za-z0-9_-]{16,}/],
  ['非空 apiKey', /"apiKey"\s*:\s*"[^"\s]{6,}"/],
  ['非空 token/secret/password', /"(?:token|secret|password|accessToken|clientSecret)"\s*:\s*"[^"\s]{6,}"/i],
  ['Bearer Token', /Bearer\s+[A-Za-z0-9._-]{20,}/],
  ['本机用户路径', /[A-Za-z]:\\Users\\[^\\\s"']+/]
];

function stagedFiles() {
  try {
    return execFileSync('git', ['diff', '--cached', '--name-only', '--diff-filter=ACM'], { encoding: 'utf8' })
      .split('\n').map((s) => s.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

function personalTerms() {
  for (const file of ['.git/info/personal-terms.txt', '.personal-terms.txt']) {
    try {
      return fs.readFileSync(file, 'utf8').split('\n').map((s) => s.trim()).filter(Boolean);
    } catch { /* next */ }
  }
  return [];
}

const files = stagedFiles();
if (!files.length) {
  console.log('[check-secrets] 没有待提交文件，跳过');
  process.exit(0);
}

const terms = personalTerms();
const problems = [];

for (const file of files) {
  if (BLOCKED_PATH.test(file.replace(/\\/g, '/'))) {
    problems.push(`${file}：这个路径不应该进版本库（敏感/第三方/产物）`);
    continue;
  }
  let text = '';
  try {
    if (fs.statSync(file).size > 3 * 1024 * 1024) continue;
    text = fs.readFileSync(file, 'utf8');
  } catch {
    continue;
  }
  for (const [name, re] of RULES) {
    const hit = text.match(re);
    if (hit) problems.push(`${file}：命中「${name}」→ ${String(hit[0]).slice(0, 60)}`);
  }
  for (const term of terms) {
    if (text.includes(term)) problems.push(`${file}：包含个人信息「${term.slice(0, 3)}***」`);
  }
}

if (problems.length) {
  console.error('\n✖ 提交被拦下：发现可能的敏感信息\n');
  for (const p of problems) console.error('  - ' + p);
  console.error('\n处理办法：把敏感内容挪到 data/（已在 .gitignore），或用 git restore --staged 取消暂存。');
  console.error('确认是误报时可以加 --no-verify 提交，但先看清楚。\n');
  process.exit(1);
}

console.log(`[check-secrets] ${files.length} 个文件通过检查 ✅`);

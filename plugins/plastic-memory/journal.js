// 只读 journal：给人看，不参与审批。
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../../src/config.js';

const FILE = path.join(DATA_DIR, 'plastic-memory', 'journal.md');

export function appendJournal(line) {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    fs.appendFileSync(FILE, `- ${ts}  ${String(line || '').replace(/\s+/g, ' ').slice(0, 500)}\n`, 'utf8');
  } catch { /* journal 失败不影响记忆 */ }
}

export function journalPath() {
  return FILE;
}

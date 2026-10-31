'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** سجل JSON-lines في ملف يومي. لا يعتمد على نافذة CMD (مهم للتشغيل المخفي). */
function createLogger({ dir, level = 'info', echo = false } = {}) {
  const order = { debug: 10, info: 20, warn: 30, error: 40 };
  if (dir) fs.mkdirSync(dir, { recursive: true });
  function write(lvl, msg, extra) {
    if (order[lvl] < order[level]) return;
    const now = new Date();
    const line = JSON.stringify({ t: now.toISOString(), level: lvl, msg, ...extra });
    if (echo) process.stderr.write(line + '\n');
    if (dir) {
      const file = path.join(dir, `tayl-${now.toISOString().slice(0, 10)}.log`);
      try { fs.appendFileSync(file, line + '\n'); } catch { /* لا نُسقط التطبيق بسبب فشل السجل */ }
    }
  }
  return {
    debug: (m, e) => write('debug', m, e),
    info: (m, e) => write('info', m, e),
    warn: (m, e) => write('warn', m, e),
    error: (m, e) => write('error', m, e),
  };
}
module.exports = { createLogger };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../server/core/config');
const { restoreBackup } = require('../server/core/backup');
const cfg = loadConfig();
const file = process.argv[2];
if (!file) { console.error('الاستخدام: npm run restore -- <مسار ملف النسخة .db>'); process.exit(2); }
if (fs.existsSync(cfg.pidFile)) {
  const pid = Number(fs.readFileSync(cfg.pidFile, 'utf8'));
  let alive = false; try { process.kill(pid, 0); alive = true; } catch { /* غير يعمل */ }
  if (alive) { console.error(`البرنامج يعمل (PID ${pid}). أغلقه أولًا ثم أعد المحاولة.`); process.exit(3); }
}
try {
  const r = restoreBackup({ dbFile: cfg.dbFile, backupFile: path.resolve(file), dir: cfg.backupDir });
  console.log('تمت الاستعادة من:', r.manifest.file, '\nنسخة أمان للقاعدة السابقة:', r.safetyCopy || '(لا توجد قاعدة سابقة)');
} catch (e) { console.error('فشلت الاستعادة (لم يتغير شيء):', e.message); process.exit(1); }

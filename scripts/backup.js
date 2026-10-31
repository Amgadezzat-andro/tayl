'use strict';
const { loadConfig } = require('../server/core/config');
const { openDatabase } = require('../server/core/db');
const { createBackup } = require('../server/core/backup');
const pkg = require('../package.json');
(async () => {
  const cfg = loadConfig();
  const db = openDatabase(cfg.dbFile);
  try {
    const r = await createBackup(db, { dir: cfg.backupDir, reason: 'manual', retention: cfg.backupRetention, appVersion: pkg.version });
    console.log('تم إنشاء النسخة:', r.path, '\nSHA-256:', r.manifest.sha256);
  } finally { db.close(); }
})().catch((e) => { console.error('فشل:', e.message); process.exit(1); });

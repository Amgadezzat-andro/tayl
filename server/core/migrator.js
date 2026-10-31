'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { MigrationError } = require('./errors');
const { inTransaction } = require('./db');

const FILE_RE = /^(\d{4})_([a-z0-9_]+)\.sql$/;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

function ensureTable(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    module     TEXT NOT NULL,
    id         TEXT NOT NULL,
    checksum   TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    PRIMARY KEY (module, id)
  ) STRICT`);
}

/** قراءة ملفات الترحيل الخاصة بوحدة معينة بترتيب رقمي صارم. */
function readMigrations(moduleName, dir) {
  if (!dir || !fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.sql')).sort();
  const seen = new Set();
  return files.map((f) => {
    const m = FILE_RE.exec(f);
    if (!m) throw new MigrationError('BAD_NAME', `اسم ملف ترحيل غير صالح: ${moduleName}/${f} (المطلوب NNNN_name.sql)`);
    if (seen.has(m[1])) throw new MigrationError('DUPLICATE_ID', `رقم ترحيل مكرر ${m[1]} في وحدة ${moduleName}`);
    seen.add(m[1]);
    const sql = fs.readFileSync(path.join(dir, f), 'utf8');
    return { module: moduleName, id: `${m[1]}_${m[2]}`, seq: m[1], sql, checksum: sha256(sql) };
  });
}

/**
 * يحسب الحالة دون تغيير شيء:
 *  - pending : ترحيلات لم تُطبّق
 *  - applied : ما طُبّق فعلًا
 * ويرفض (يرمي خطأ) في حالتين خطيرتين:
 *  - TAMPERED: ترحيل مُطبّق تغيّر محتواه بعد التطبيق
 *  - DB_NEWER: القاعدة تحوي ترحيلات لا يعرفها هذا الإصدار من البرنامج (تشغيل نسخة أقدم على قاعدة أحدث)
 */
function plan(db, modules) {
  ensureTable(db);
  const known = modules.flatMap((m) => readMigrations(m.name, m.migrationsDir));
  const knownMap = new Map(known.map((m) => [`${m.module}/${m.id}`, m]));
  const appliedRows = db.prepare('SELECT module, id, checksum FROM schema_migrations ORDER BY module, id').all();

  for (const row of appliedRows) {
    const k = knownMap.get(`${row.module}/${row.id}`);
    if (!k) throw new MigrationError('DB_NEWER', `القاعدة تحوي ترحيلًا غير معروف (${row.module}/${row.id}). شغّل نسخة أحدث من البرنامج.`);
    if (k.checksum !== row.checksum) throw new MigrationError('TAMPERED', `تم تعديل ترحيل مُطبّق مسبقًا (${row.module}/${row.id}). التعديل ممنوع؛ أنشئ ترحيلًا جديدًا.`);
  }
  const done = new Set(appliedRows.map((r) => `${r.module}/${r.id}`));
  const pending = known.filter((m) => !done.has(`${m.module}/${m.id}`));
  return { pending, applied: appliedRows };
}

/**
 * تطبيق الترحيلات المعلّقة. كل ترحيل في معاملة مستقلة:
 * إن فشل أحدها يُلغى كليًا ولا يُسجَّل، وتتوقف العملية عنده.
 */
function migrate(db, modules, { onApply } = {}) {
  const { pending } = plan(db, modules);
  const order = new Map(modules.map((m, i) => [m.name, i]));   // ترتيب الوحدات = ترتيب الاعتماديات
  pending.sort((a, b) => order.get(a.module) - order.get(b.module) || a.id.localeCompare(b.id));
  const applied = [];
  for (const m of pending) {
    try {
      inTransaction(db, () => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migrations (module, id, checksum) VALUES (?,?,?)').run(m.module, m.id, m.checksum);
      });
    } catch (e) {
      throw new MigrationError('FAILED', `فشل الترحيل ${m.module}/${m.id}: ${e.message}`);
    }
    applied.push(`${m.module}/${m.id}`);
    if (onApply) onApply(m);
  }
  const fk = db.pragma('foreign_key_check');
  if (fk.length) throw new MigrationError('FK_VIOLATION', `بعد الترحيل توجد مخالفات مفاتيح خارجية: ${JSON.stringify(fk.slice(0, 3))}`);
  return applied;
}

module.exports = { plan, migrate, readMigrations };

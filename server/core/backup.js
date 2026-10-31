'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const Database = require('better-sqlite3');
const { openDatabase } = require('./db');
const { BackupError } = require('./errors');

const NAME_RE = /^tayl-\d{8}-\d{6}-\d{3}-[a-z0-9-]+\.db$/;

function stamp(d = new Date()) {
  const p = (n, w = 2) => String(n).padStart(w, '0');
  return `${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}-${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}-${p(d.getUTCMilliseconds(), 3)}`;
}
function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.alloc(1 << 20); let n;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) h.update(buf.subarray(0, n));
  } finally { fs.closeSync(fd); }
  return h.digest('hex');
}
function integrityOk(file) {
  const db = openDatabase(file, { readonly: true });
  try {
    const rows = db.pragma('integrity_check');
    return rows.length === 1 && rows[0].integrity_check === 'ok';
  } finally { db.close(); }
}
const manifestPath = (file) => file.replace(/\.db$/, '.json');

/**
 * إنشاء نسخة احتياطية متسقة أثناء عمل القاعدة (SQLite online backup API):
 *  1) نسخ إلى ملف مؤقت  2) فحص سلامة النسخة  3) حساب بصمة SHA-256 + بيان manifest
 *  4) إعادة تسمية ذرّية للاسم النهائي  5) تطبيق سياسة الاحتفاظ.
 * لا تظهر نسخة ناقصة تحت اسم نهائي أبدًا.
 */
async function createBackup(db, { dir, reason = 'manual', retention = 30, appVersion = 'unknown' }) {
  if (!/^[a-z0-9-]+$/.test(reason)) throw new BackupError('BAD_REASON', 'سبب النسخة يجب أن يكون أحرفًا إنجليزية صغيرة/أرقام/شرطات');
  fs.mkdirSync(dir, { recursive: true });
  const name = `tayl-${stamp()}-${reason}.db`;
  const finalPath = path.join(dir, name);
  const tmp = finalPath + '.partial';
  try {
    await db.backup(tmp);
    // النسخة ترث وضع WAL؛ فتحها للفحص كان يترك ملفات -wal/-shm يتيمة بجوارها (اكتُشف في المرحلة 1).
    // تحويلها إلى DELETE يجعلها ملفًا واحدًا مكتفيًا بذاته (ويُعاد WAL تلقائيًا عند فتحها بعد الاستعادة).
    const copy = new Database(tmp);
    try { copy.pragma('journal_mode = DELETE'); } finally { copy.close(); }
    if (!integrityOk(tmp)) throw new BackupError('INTEGRITY', 'فشل فحص سلامة النسخة الاحتياطية');
    let migrations = [];
    try { migrations = db.prepare('SELECT module, id FROM schema_migrations ORDER BY module, id').all(); } catch { /* قاعدة جديدة */ }
    const manifest = {
      file: name, reason, appVersion, createdAt: new Date().toISOString(),
      sizeBytes: fs.statSync(tmp).size, sha256: sha256File(tmp), migrations,
    };
    fs.renameSync(tmp, finalPath);
    fs.writeFileSync(manifestPath(finalPath), JSON.stringify(manifest, null, 2));
    prune(dir, retention);
    return { path: finalPath, manifest };
  } catch (e) {
    fs.rmSync(tmp, { force: true });
    throw e;
  }
}

function listBackups(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir).filter((f) => NAME_RE.test(f)).sort().reverse().map((f) => {
    const mp = manifestPath(path.join(dir, f));
    let manifest = null;
    try { manifest = JSON.parse(fs.readFileSync(mp, 'utf8')); } catch { /* بلا manifest */ }
    return { file: f, path: path.join(dir, f), manifest };
  });
}

/** يحذف الأقدم فقط، ولا يلمس أي ملف لا يطابق نمط أسماء TAYL. */
function prune(dir, retention) {
  const all = listBackups(dir);
  for (const b of all.slice(Math.max(1, retention))) {
    fs.rmSync(b.path, { force: true });
    fs.rmSync(manifestPath(b.path), { force: true });
  }
}

function verifyBackup(file) {
  if (!fs.existsSync(file)) throw new BackupError('MISSING', 'ملف النسخة غير موجود');
  const mp = manifestPath(file);
  if (!fs.existsSync(mp)) throw new BackupError('NO_MANIFEST', 'ملف البيان (manifest) مفقود، لا يمكن التحقق من النسخة');
  const manifest = JSON.parse(fs.readFileSync(mp, 'utf8'));
  if (sha256File(file) !== manifest.sha256) throw new BackupError('CHECKSUM', 'بصمة النسخة لا تطابق البيان: النسخة تالفة أو معدّلة');
  if (!integrityOk(file)) throw new BackupError('INTEGRITY', 'فحص سلامة قاعدة النسخة فشل');
  return manifest;
}

/**
 * استعادة نسخة. شروط:
 *  - يجب أن تكون القاعدة الحالية مغلقة (يتحقق المستدعي).
 *  - تُتحقق النسخة أولًا؛ إن فشل التحقق لا يُمس شيء.
 *  - تُحفظ القاعدة الحالية (مع ملفات WAL) في مجلد pre-restore قبل الاستبدال، فلا تضيع بيانات.
 */
function restoreBackup({ dbFile, backupFile, dir }) {
  const manifest = verifyBackup(backupFile);
  let safety = null;
  if (fs.existsSync(dbFile)) {
    safety = path.join(dir, `pre-restore-${stamp()}`);
    fs.mkdirSync(safety, { recursive: true });
    for (const ext of ['', '-wal', '-shm']) {
      if (fs.existsSync(dbFile + ext)) fs.copyFileSync(dbFile + ext, path.join(safety, path.basename(dbFile) + ext));
    }
  }
  const tmp = dbFile + '.restoring';
  fs.mkdirSync(path.dirname(dbFile), { recursive: true });
  fs.copyFileSync(backupFile, tmp);
  fs.renameSync(tmp, dbFile);
  fs.rmSync(dbFile + '-wal', { force: true });   // ملفات WAL القديمة لا تخص النسخة المستعادة
  fs.rmSync(dbFile + '-shm', { force: true });
  return { manifest, safetyCopy: safety };
}

module.exports = { createBackup, listBackups, verifyBackup, restoreBackup, prune };

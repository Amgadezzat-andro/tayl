'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/core/db');
const backup = require('../server/core/backup');
const { tmpDir } = require('./helpers');

function mkDb() {
  const dir = tmpDir();
  const file = path.join(dir, 'tayl.db');
  const db = openDatabase(file);
  db.exec("CREATE TABLE t(v TEXT) STRICT; INSERT INTO t VALUES ('one'),('two');");
  return { dir, file, db, bdir: path.join(dir, 'backups') };
}

test('backup: إنشاء نسخة مع manifest وبصمة صحيحة', async () => {
  const { db, bdir } = mkDb();
  const r = await backup.createBackup(db, { dir: bdir, reason: 'manual' });
  assert.ok(fs.existsSync(r.path));
  assert.equal(r.manifest.sha256.length, 64);
  assert.equal(backup.verifyBackup(r.path).sha256, r.manifest.sha256);
  assert.equal(fs.readdirSync(bdir).filter((f) => f.endsWith('.partial')).length, 0);
  db.close();
});

test('backup: لا تُترك ملفات جانبية (-wal/-shm) بعد النسخ أو التحقق — المرحلة 1', async () => {
  const { db, bdir } = mkDb();
  const r = await backup.createBackup(db, { dir: bdir });
  backup.verifyBackup(r.path);
  assert.deepEqual(fs.readdirSync(bdir).sort(), [path.basename(r.path), path.basename(r.path).replace(/\.db$/, '.json')].sort());
  db.close();
});

test('backup: النسخة تحوي البيانات فعلًا', async () => {
  const { db, bdir } = mkDb();
  const r = await backup.createBackup(db, { dir: bdir });
  const copy = openDatabase(r.path, { readonly: true });
  assert.equal(copy.prepare('SELECT count(*) c FROM t').get().c, 2);
  copy.close(); db.close();
});

test('backup: نسخة تالفة (تعديل بايت) ترفضها verify', async () => {
  const { db, bdir } = mkDb();
  const r = await backup.createBackup(db, { dir: bdir });
  const buf = fs.readFileSync(r.path); buf[buf.length - 10] ^= 0xff; fs.writeFileSync(r.path, buf);
  assert.throws(() => backup.verifyBackup(r.path), (e) => e.code === 'CHECKSUM');
  db.close();
});

test('backup: غياب manifest أو الملف يُرفض', async () => {
  const { db, bdir } = mkDb();
  const r = await backup.createBackup(db, { dir: bdir });
  fs.rmSync(r.path.replace(/\.db$/, '.json'));
  assert.throws(() => backup.verifyBackup(r.path), (e) => e.code === 'NO_MANIFEST');
  assert.throws(() => backup.verifyBackup(path.join(bdir, 'nope.db')), (e) => e.code === 'MISSING');
  db.close();
});

test('backup: سبب غير صالح يُرفض', async () => {
  const { db, bdir } = mkDb();
  await assert.rejects(backup.createBackup(db, { dir: bdir, reason: '../evil' }), (e) => e.code === 'BAD_REASON');
  db.close();
});

test('backup: سياسة الاحتفاظ تحذف الأقدم فقط ولا تلمس ملفات غريبة', async () => {
  const { db, bdir } = mkDb();
  fs.mkdirSync(bdir, { recursive: true });
  fs.writeFileSync(path.join(bdir, 'my-notes.txt'), 'keep');
  for (let i = 0; i < 4; i++) { await backup.createBackup(db, { dir: bdir, retention: 2 }); await new Promise((r) => setTimeout(r, 5)); }
  assert.equal(backup.listBackups(bdir).length, 2);
  assert.ok(fs.existsSync(path.join(bdir, 'my-notes.txt')));
  db.close();
});

test('backup: استعادة كاملة + نسخة أمان للقاعدة السابقة', async () => {
  const { db, file, dir, bdir } = mkDb();
  const r = await backup.createBackup(db, { dir: bdir });
  db.exec("INSERT INTO t VALUES ('after-backup')");
  db.close();
  const res = backup.restoreBackup({ dbFile: file, backupFile: r.path, dir: bdir });
  const restored = openDatabase(file);
  assert.equal(restored.prepare('SELECT count(*) c FROM t').get().c, 2);      // الصف اللاحق غير موجود
  restored.close();
  const safe = openDatabase(path.join(res.safetyCopy, 'tayl.db'));
  assert.equal(safe.prepare('SELECT count(*) c FROM t').get().c, 3);          // لكنه محفوظ في نسخة الأمان
  safe.close();
  assert.ok(dir);
});

test('backup: استعادة من نسخة تالفة لا تغيّر القاعدة الحالية', async () => {
  const { db, file, bdir } = mkDb();
  const r = await backup.createBackup(db, { dir: bdir });
  db.close();
  const buf = fs.readFileSync(r.path); buf[buf.length - 10] ^= 0xff; fs.writeFileSync(r.path, buf);
  const before = fs.readFileSync(file);
  assert.throws(() => backup.restoreBackup({ dbFile: file, backupFile: r.path, dir: bdir }), (e) => e.code === 'CHECKSUM');
  assert.ok(before.equals(fs.readFileSync(file)));
});

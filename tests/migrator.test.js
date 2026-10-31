'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/core/db');
const migrator = require('../server/core/migrator');
const { tmpDir } = require('./helpers');

function mod(name, files) {
  const dir = tmpDir();
  for (const [f, sql] of Object.entries(files)) fs.writeFileSync(path.join(dir, f), sql);
  return { name, migrationsDir: dir };
}

test('migrator: يطبّق الترحيلات بالترتيب ويسجلها', () => {
  const db = openDatabase(':memory:');
  const m = mod('a', { '0002_b.sql': 'ALTER TABLE t ADD COLUMN x TEXT;', '0001_a.sql': 'CREATE TABLE t(id INTEGER PRIMARY KEY) STRICT;' });
  assert.deepEqual(migrator.migrate(db, [m]), ['a/0001_a', 'a/0002_b']);
  assert.equal(db.prepare('SELECT count(*) c FROM schema_migrations').get().c, 2);
});

test('migrator: إعادة التشغيل لا تعيد التطبيق (idempotent)', () => {
  const db = openDatabase(':memory:');
  const m = mod('a', { '0001_a.sql': 'CREATE TABLE t(id INTEGER) STRICT;' });
  migrator.migrate(db, [m]);
  assert.deepEqual(migrator.migrate(db, [m]), []);
});

test('migrator: ترحيل فاشل يُلغى كليًا ولا يُسجَّل', () => {
  const db = openDatabase(':memory:');
  const m = mod('a', { '0001_a.sql': 'CREATE TABLE ok_t(id INTEGER) STRICT; INSERT INTO missing_table VALUES (1);' });
  assert.throws(() => migrator.migrate(db, [m]), (e) => e.code === 'FAILED');
  assert.equal(db.prepare("SELECT count(*) c FROM sqlite_master WHERE name='ok_t'").get().c, 0);
  assert.equal(db.prepare('SELECT count(*) c FROM schema_migrations').get().c, 0);
});

test('migrator: تعديل ترحيل مُطبّق يُرفض (checksum)', () => {
  const db = openDatabase(':memory:');
  const m = mod('a', { '0001_a.sql': 'CREATE TABLE t(id INTEGER) STRICT;' });
  migrator.migrate(db, [m]);
  fs.writeFileSync(path.join(m.migrationsDir, '0001_a.sql'), 'CREATE TABLE t(id INTEGER, extra TEXT) STRICT;');
  assert.throws(() => migrator.migrate(db, [m]), (e) => e.code === 'TAMPERED');
});

test('migrator: قاعدة أحدث من البرنامج تُرفض (DB_NEWER)', () => {
  const db = openDatabase(':memory:');
  const m2 = mod('a', { '0001_a.sql': 'CREATE TABLE t(id INTEGER) STRICT;', '0002_b.sql': 'ALTER TABLE t ADD COLUMN x TEXT;' });
  migrator.migrate(db, [m2]);
  const m1 = { name: 'a', migrationsDir: tmpDir() };
  fs.writeFileSync(path.join(m1.migrationsDir, '0001_a.sql'), 'CREATE TABLE t(id INTEGER) STRICT;');
  assert.throws(() => migrator.migrate(db, [m1]), (e) => e.code === 'DB_NEWER');
});

test('migrator: اسم ملف سيئ ورقم مكرر يُرفضان', () => {
  const db = openDatabase(':memory:');
  assert.throws(() => migrator.plan(db, [mod('a', { 'bad.sql': 'select 1;' })]), (e) => e.code === 'BAD_NAME');
  assert.throws(() => migrator.plan(db, [mod('a', { '0001_x.sql': 'select 1;', '0001_y.sql': 'select 2;' })]), (e) => e.code === 'DUPLICATE_ID');
});

test('migrator: مخالفة مفتاح خارجي بعد الترحيل تُكتشف', () => {
  const db = openDatabase(':memory:');
  db.pragma('foreign_keys = OFF');
  const m = mod('a', { '0001_a.sql': 'CREATE TABLE p(id INTEGER PRIMARY KEY) STRICT; CREATE TABLE c(p INTEGER REFERENCES p(id)) STRICT; INSERT INTO c VALUES (5);' });
  assert.throws(() => migrator.migrate(db, [m]), (e) => e.code === 'FK_VIOLATION');
});

test('migrator: ترحيلات وحدات متعددة بترتيب الاعتماد', () => {
  const db = openDatabase(':memory:');
  const a = mod('a', { '0001_a.sql': 'CREATE TABLE pa(id INTEGER PRIMARY KEY) STRICT;' });
  const b = mod('b', { '0001_b.sql': 'CREATE TABLE cb(pa INTEGER REFERENCES pa(id)) STRICT;' });
  assert.deepEqual(migrator.migrate(db, [a, b]), ['a/0001_a', 'b/0001_b']);
});

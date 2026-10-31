'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, inTransaction } = require('../server/core/db');

test('db: المفاتيح الخارجية مفعّلة وتُرفض المخالفة', () => {
  const db = openDatabase(':memory:');
  assert.equal(db.pragma('foreign_keys', { simple: true }), 1);
  db.exec('CREATE TABLE p(id INTEGER PRIMARY KEY) STRICT; CREATE TABLE c(id INTEGER PRIMARY KEY, p INTEGER NOT NULL REFERENCES p(id)) STRICT;');
  assert.throws(() => db.prepare('INSERT INTO c(p) VALUES (99)').run(), /FOREIGN KEY/);
});

test('db: ملف حقيقي يعمل بوضع WAL و synchronous=FULL', () => {
  const dir = require('./helpers').tmpDir();
  const db = openDatabase(require('node:path').join(dir, 'x.db'));
  assert.equal(db.pragma('journal_mode', { simple: true }), 'wal');
  assert.equal(db.pragma('synchronous', { simple: true }), 2);
  db.close();
});

test('db: المعاملة كل-شيء-أو-لا-شيء (rollback عند الخطأ)', () => {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE t(v INTEGER) STRICT');
  assert.throws(() => inTransaction(db, () => { db.prepare('INSERT INTO t VALUES (1)').run(); throw new Error('boom'); }), /boom/);
  assert.equal(db.prepare('SELECT count(*) c FROM t').get().c, 0);
  inTransaction(db, () => { db.prepare('INSERT INTO t VALUES (1)').run(); });
  assert.equal(db.prepare('SELECT count(*) c FROM t').get().c, 1);
});

test('db: المعاملات المتداخلة تتراجع جزئيًا بـ SAVEPOINT', () => {
  const db = openDatabase(':memory:');
  db.exec('CREATE TABLE t(v INTEGER) STRICT');
  inTransaction(db, () => {
    db.prepare('INSERT INTO t VALUES (1)').run();
    try { inTransaction(db, () => { db.prepare('INSERT INTO t VALUES (2)').run(); throw new Error('inner'); }); } catch { /* متوقع */ }
  });
  assert.deepEqual(db.prepare('SELECT v FROM t').all().map((r) => r.v), [1]);
});

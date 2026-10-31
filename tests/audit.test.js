'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { openDatabase, inTransaction } = require('../server/core/db');
const migrator = require('../server/core/migrator');
const { createAudit } = require('../server/core/audit');
const system = require('../server/modules/system');

function setup() {
  const db = openDatabase(':memory:');
  migrator.migrate(db, [system]);
  return { db, audit: createAudit(db) };
}

test('audit: تسجيل وقراءة حدث', () => {
  const { audit } = setup();
  const id = audit.record({ action: 'test.create', source: 'tests', entityType: 'doc', entityId: 7, details: { a: 1 }, userId: 3, actor: 'ali' });
  const [row] = audit.list({ entityType: 'doc', entityId: 7 });
  assert.equal(row.id, id);
  assert.equal(row.actor, 'ali');
  assert.deepEqual(JSON.parse(row.details), { a: 1 });
  assert.match(row.occurred_at, /^\d{4}-\d\d-\d\dT/);
});

test('audit: السجل إضافة فقط — التعديل والحذف مرفوضان من القاعدة نفسها', () => {
  const { db, audit } = setup();
  const id = audit.record({ action: 'x', source: 's' });
  assert.throws(() => db.prepare('UPDATE audit_log SET action=? WHERE id=?').run('y', id), /append-only/);
  assert.throws(() => db.prepare('DELETE FROM audit_log WHERE id=?').run(id), /append-only/);
});

test('audit: action و source إلزاميان', () => {
  const { audit } = setup();
  assert.throws(() => audit.record({ source: 's' }), /action/);
  assert.throws(() => audit.record({ action: 'a' }), /source/);
});

test('audit: التسجيل داخل معاملة يُلغى معها', () => {
  const { db, audit } = setup();
  assert.throws(() => inTransaction(db, () => { audit.record({ action: 'a', source: 's' }); throw new Error('fail'); }));
  assert.equal(audit.list().length, 0);
});

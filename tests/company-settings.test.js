'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startReady } = require('./helpers');

test('company: عرض وتعديل بيانات الشركة مع تسجيل الفروق في التدقيق', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const c = (await s.admin.get('/api/company')).body;
  assert.equal(c.nameAr, 'شركة اختبار'); assert.equal(c.baseCurrency, 'EGP'); assert.equal(c.hasLogo, false);
  const up = await s.admin.put('/api/company', { taxNumber: '000-000-000', email: 'info@example.test', defaultLanguage: 'en' });
  assert.equal(up.status, 200); assert.equal(up.body.taxNumber, '000-000-000');
  assert.equal((await s.admin.get('/api/setup/status')).body.defaultLanguage, 'en');
  assert.equal((await s.admin.put('/api/company', { nameAr: '   ' })).body.error.details.fields.nameAr, 'REQUIRED');
  assert.equal((await s.admin.put('/api/company', { phone: '<script>' })).body.error.details.fields.phone, 'INVALID');
  const log = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action='company.updated'").get().details);
  assert.deepEqual(log.changes.taxNumber, { from: null, to: '000-000-000' });
  assert.deepEqual(log.changes.defaultLanguage, { from: 'ar', to: 'en' });
});

test('company: رفع الشعار وحذفه', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0x10, 0x4a, 0x46, 0x49, 0x46, 0, 1, 0xff, 0xd9]);
  assert.equal((await s.admin.put('/api/company/logo', { data: jpeg.toString('base64') })).body.hasLogo, true);
  const r = await fetch(s.base + '/api/company/logo', { headers: { cookie: s.admin.state.cookie } });
  assert.equal(r.headers.get('content-type'), 'image/jpeg');
  assert.equal((await s.admin.del('/api/company/logo')).body.hasLogo, false);
  assert.equal((await fetch(s.base + '/api/company/logo', { headers: { cookie: s.admin.state.cookie } })).status, 404);
  assert.equal((await fetch(s.base + '/api/company/logo')).status, 401);
});

test('settings: إعدادات الجلسات والدخول بحدود، وتسري فورًا', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const g = (await s.admin.get('/api/settings')).body;
  assert.equal(g.values.sessionIdleMinutes, 30);
  assert.equal((await s.admin.put('/api/settings', { sessionIdleMinutes: 1 })).body.error.details.fields.sessionIdleMinutes, 'OUT_OF_RANGE');
  assert.equal((await s.admin.put('/api/settings', { loginMaxFailures: '5' })).body.error.details.fields.loginMaxFailures, 'NOT_INTEGER');
  assert.equal((await s.admin.put('/api/settings', { sessionIdleMinutes: 10, passwordMinLength: 12 })).status, 200);
  s.app.db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 11 * 60000);
  assert.equal((await s.admin.get('/api/settings')).status, 401);
  const log = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action='settings.updated'").get().details);
  assert.deepEqual(log.changes, { sessionIdleMinutes: { from: 30, to: 10 }, passwordMinLength: { from: 8, to: 12 } });
});

test('precision: تعديل السياسة (افتراضي + تخصيص عملة) يُحفظ ويُدقَّق ويطبَّق على المحرك', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const d = (await s.admin.get('/api/precision')).body;
  assert.equal(d.intermediatePrecision, 120);
  assert.deepEqual(d.kinds.map((k) => [k.kind, k.storageScale]), [['amount', 8], ['quantity', 8], ['unit_price', 10], ['fx_rate', 12], ['rate', 8], ['unit_cost', 10]]);
  const rows = [...d.rows, { kind: 'amount', currency: 'kwd', commitScale: 3, displayScale: 3, rounding: 'HALF_EVEN' }];
  assert.equal((await s.admin.put('/api/precision', { rows })).status, 200);
  const prev = await s.admin.post('/api/precision/preview', { kind: 'amount', currency: 'KWD', value: '1234.56750' });
  assert.deepEqual([prev.body.committed, prev.body.stored, prev.body.display], ['1234.568', '1234.568', '1,234.568']);
  const egp = await s.admin.post('/api/precision/preview', { kind: 'amount', value: '1234.567891234' });
  assert.deepEqual([egp.body.committed, egp.body.display], ['1234.56789123', '1,234.57']);
  const log = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action='precision.updated'").get().details);
  assert.deepEqual(log.changes, { 'amount|KWD': { from: null, to: '3/3/HALF_EVEN' } });
});

test('precision: سياسة غير صالحة تُرفض كاملة ولا يتغير شيء', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const d = (await s.admin.get('/api/precision')).body;
  const tooFine = d.rows.map((r) => (r.kind === 'amount' ? { ...r, commitScale: 9 } : r));
  assert.equal((await s.admin.put('/api/precision', { rows: tooFine })).body.error.details.fields['rows.0'], 'COMMIT_SCALE_RANGE');
  const missing = d.rows.filter((r) => r.kind !== 'rate');
  assert.equal((await s.admin.put('/api/precision', { rows: missing })).body.error.code, 'POLICY_INCOMPLETE');
  assert.equal((await s.admin.post('/api/precision/preview', { kind: 'amount', value: 0.1 })).body.error.details.fields.value, 'DECIMAL_MUST_BE_STRING');
  assert.equal((await s.admin.post('/api/precision/preview', { kind: 'amount', value: '1e5' })).body.error.details.fields.value, 'INVALID');
  assert.deepEqual((await s.admin.get('/api/precision')).body.rows, d.rows);
  assert.throws(() => s.app.db.prepare("UPDATE decimal_policy SET commit_scale = 9 WHERE kind='amount'").run(), /CHECK/);
  assert.throws(() => s.app.db.prepare("DELETE FROM decimal_policy WHERE kind='amount'").run(), /cannot be deleted/);
});

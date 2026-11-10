'use strict';
/* المرحلة 3 (الدفعة 3.1): ترقيم المستندات — التسلسل، الفروع، تغيير كود الفرع، FY2026، أقفال السلسلة، والتراجع الذري. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startReady } = require('./helpers');
const { ok, seedLedger, draft, postEntry, postNew } = require('./ledger-helpers');

const LINES = (seed, amount = '10') => [{ accountId: seed.acc.cash.id, debit: amount }, { accountId: seed.acc.sales.id, credit: amount }];
const count = (s, t, where = '1') => s.app.db.prepare(`SELECT count(*) c FROM ${t} WHERE ${where}`).get().c;

test('numbering: تسلسل متصل لكل فرع وسنة، والفشل لا يستهلك رقمًا', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const alx = ok(await s.admin.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  const nums = [];
  for (let i = 0; i < 5; i++) {
    nums.push((await postNew(s, seed, LINES(seed))).number);
    const bad = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '9' }]));
    assert.equal((await postEntry(s, bad.id)).body.error.code, 'UNBALANCED');           // فشل بين كل ترحيلين
  }
  assert.deepEqual(nums, [1, 2, 3, 4, 5].map((n) => `JV-HQ-FY2026-00000${n}`));
  assert.equal((await postNew(s, seed, LINES(seed), { branchId: alx.id })).number, 'JV-ALX-FY2026-000001');   // تسلسل مستقل للفرع
  assert.deepEqual(s.app.db.prepare('SELECT branch_key, year_key, last_value FROM document_counters ORDER BY branch_key').all(),
    [{ branch_key: seed.hq.id, year_key: 2026, last_value: 5 }, { branch_key: alx.id, year_key: 2026, last_value: 1 }]);
  assert.equal(count(s, 'issued_numbers'), 6);
  assert.deepEqual(s.app.services.ledger.integrity(), { ok: true, problems: [] });
});

test('numbering: تغيير كود الفرع — الأرقام القديمة بنصها، الجديدة بالكود الجديد، والتسلسل مستمر حسب branch_id', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const first = await postNew(s, seed, LINES(seed));
  assert.equal(first.number, 'JV-HQ-FY2026-000001');
  ok(await s.admin.put('/api/branches/' + seed.hq.id, { code: 'CAI' }));
  const second = await postNew(s, seed, LINES(seed));
  assert.equal(second.number, 'JV-CAI-FY2026-000002');                                   // التسلسل مستمر
  assert.equal(ok(await s.admin.get('/api/journal/' + first.id)).number, 'JV-HQ-FY2026-000001');   // القديم لم يتغير
  assert.deepEqual(s.app.db.prepare('SELECT number, branch_id, branch_key, seq FROM issued_numbers ORDER BY seq').all(),
    [{ number: 'JV-HQ-FY2026-000001', branch_id: seed.hq.id, branch_key: seed.hq.id, seq: 1 }, { number: 'JV-CAI-FY2026-000002', branch_id: seed.hq.id, branch_key: seed.hq.id, seq: 2 }]);
  // فرع آخر يأخذ الكود القديم HQ: النص JV-HQ-FY2026-000001 صدر من قبل ⇒ NUMBER_CONFLICT ولا يُرحَّل شيء (لا تكرار أبدًا)
  const other = ok(await s.admin.post('/api/branches', { code: 'HQ', nameAr: 'فرع جديد', nameEn: 'New branch' }));
  const d = ok(await draft(s, seed, LINES(seed), { branchId: other.id }));
  const r = await postEntry(s, d.id);
  assert.equal(r.body.error.code, 'NUMBER_CONFLICT'); assert.equal(r.body.error.details.number, 'JV-HQ-FY2026-000001');
  assert.equal(ok(await s.admin.get('/api/journal/' + d.id)).status, 'draft');
  assert.equal(count(s, 'document_counters', 'branch_key = ' + other.id), 0);              // زيادة العداد أُلغيت مع المعاملة
  assert.equal(count(s, 'gl_entries'), 4);
});

test('numbering: صيغة السنة FY2026 = سنة بداية السنة المالية (سنة لا تبدأ في يناير)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s, { fy: { code: 'Y2627', startDate: '2026-07-01', endDate: '2027-06-30' } });
  const p = await postNew(s, seed, LINES(seed), { entryDate: '2026-08-15' });
  assert.equal(p.number, 'JV-HQ-FY2026-000001');
  assert.match(p.number, /^JV-HQ-FY\d{4}-\d{6}$/);
  // سلسلة للشركة كلها بلا إعادة سنوية: لا مقطع فرع ولا سنة
  ok(await s.admin.post('/api/document-series', { code: 'GJ', docType: 'journal', nameAr: 'عام', nameEn: 'General', prefix: 'GJ', perBranch: false, resetYearly: false, padding: 4, isDefault: true }));
  assert.equal((await postNew(s, seed, LINES(seed), { entryDate: '2026-08-16' })).number, 'GJ-0001');
});

test('numbering: إعدادات السلسلة — مسموحة قبل أول رقم، مقفلة بعده (API و SQL مباشر)، والتعطيل وإعادة التفعيل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const list = ok(await s.admin.get('/api/document-series'));
  const jv = list.find((x) => x.code === 'JV');
  assert.deepEqual([jv.docType, jv.prefix, jv.perBranch, jv.resetYearly, jv.padding, jv.isDefault, jv.isUsed], ['journal', 'JV', true, true, 6, true, false]);
  // قبل الاستخدام: النطاق قابل للتعديل
  assert.equal(ok(await s.admin.put('/api/document-series/' + jv.id, { padding: 5 })).padding, 5);
  ok(await s.admin.put('/api/document-series/' + jv.id, { padding: 6 }));
  const d = ok(await draft(s, seed, LINES(seed)));          // مسودة بسلسلة JV قبل التعطيل
  await postNew(s, seed, LINES(seed));
  // بعد أول رقم: كل ما يحدد الهوية أو النطاق مرفوض من الخادم
  for (const [k, v] of [['code', 'JX'], ['docType', 'journal_other'], ['prefix', 'JX'], ['perBranch', false], ['resetYearly', false], ['padding', 8]]) {
    const r = await s.admin.put('/api/document-series/' + jv.id, { [k]: v });
    assert.equal(r.body.error.code, 'SERIES_LOCKED', k); assert.equal(r.body.error.details.fields[k], 'LOCKED');
  }
  // ...ومن القاعدة نفسها
  const db = s.app.db;
  for (const set of ["code = 'JX'", "doc_type = 'journal_other'", "prefix = 'JX'", 'per_branch = 0', 'reset_yearly = 0', 'padding = 8']) {
    assert.throws(() => db.prepare(`UPDATE document_series SET ${set} WHERE id = ?`).run(jv.id), /locked after the first issued number/, set);
  }
  assert.throws(() => db.prepare('DELETE FROM document_series WHERE id = ?').run(jv.id), /cannot be deleted/);
  assert.throws(() => db.prepare("INSERT INTO document_series (code, doc_type, name_ar, name_en, prefix) VALUES ('ZZ', 'journal', 'x', 'x', 'JV')").run(), /UNIQUE constraint failed: document_series.prefix/);
  assert.throws(() => db.prepare("INSERT INTO document_series (code, doc_type, name_ar, name_en, prefix, is_default) VALUES ('J9', 'journal', 'x', 'x', 'J9', 1)").run(), /UNIQUE constraint failed: document_series.doc_type/);   // افتراضيتان لنفس النوع
  assert.throws(() => db.prepare("INSERT INTO document_counters (series_id, branch_key, year_key, last_value) VALUES (?, 99, 2026, 5)").run(jv.id), /starts at 1/);
  assert.throws(() => db.prepare("UPDATE document_counters SET year_key = 2027").run(), /only move forward/);
  assert.throws(() => db.prepare(`INSERT INTO issued_numbers (series_id, branch_key, year_key, seq, number, doc_type, source_id, branch_id, fiscal_year_id, issued_by)
    VALUES (?, ?, 2026, 2, 'JV-HQ-FY2026-000001', 'journal', 1, ?, 1, 1)`).run(jv.id, seed.hq.id, seed.hq.id), /UNIQUE constraint failed: issued_numbers.number|sequence must equal/);
  // المسموح بعد الاستخدام: التسميات (بتدقيق)
  assert.equal(ok(await s.admin.put('/api/document-series/' + jv.id, { nameAr: 'قيود اليومية العامة' })).nameAr, 'قيود اليومية العامة');
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'document_series.updated'").get());
  // لا تعطيل للافتراضية، ولا إلغاء افتراضيتها مباشرة؛ نقل الافتراضية لسلسلة أخرى ثم التعطيل
  assert.equal((await s.admin.post(`/api/document-series/${jv.id}/status`, { active: false })).body.error.code, 'SERIES_DEFAULT_REQUIRED');
  assert.equal((await s.admin.put('/api/document-series/' + jv.id, { isDefault: false })).body.error.code, 'SERIES_DEFAULT_REQUIRED');
  const j2 = ok(await s.admin.post('/api/document-series', { code: 'J2', docType: 'journal', nameAr: 'ثانية', nameEn: 'Second', prefix: 'J2', isDefault: true }));
  assert.equal(ok(await s.admin.get('/api/document-series')).find((x) => x.code === 'JV').isDefault, false);
  ok(await s.admin.post(`/api/document-series/${jv.id}/status`, { active: false }));
  // [مراجعة] مسودة أُنشئت بسلسلة JV المعطّلة لا تعلق: تُرحَّل بالسلسلة الافتراضية الحالية، ولا يُستهلك من JV شيء
  assert.equal(ok(await postEntry(s, d.id)).number, 'J2-HQ-FY2026-000001');
  assert.equal(db.prepare('SELECT last_value FROM document_counters WHERE series_id = ?').get(jv.id).last_value, 1);
  assert.equal((await postNew(s, seed, LINES(seed))).number, 'J2-HQ-FY2026-000002');        // الجديدة تستخدم الافتراضية
  // إعادة التفعيل تكمل من آخر قيمة (لا يعود أي رقم)
  ok(await s.admin.post(`/api/document-series/${jv.id}/status`, { active: true }));
  ok(await s.admin.put('/api/document-series/' + jv.id, { isDefault: true }));
  assert.equal((await postNew(s, seed, LINES(seed))).number, 'JV-HQ-FY2026-000002');
  assert.equal(j2.isUsed, false);
});

test('numbering: التراجع الذري — فشل أي خطوة داخل الترحيل يلغي الرقم والعداد والأستاذ وتحديث القيد والتدقيق', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const db = s.app.db;
  await postNew(s, seed, LINES(seed));                       // رقم 1 موجود
  const state = () => JSON.stringify({
    counters: db.prepare('SELECT * FROM document_counters').all(), issued: db.prepare('SELECT * FROM issued_numbers').all(),
    gl: db.prepare('SELECT count(*) c FROM gl_entries').get().c, posted: db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'ledger.posted'").get().c,
  });
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '30' }, { accountId: seed.acc.rent.id, debit: '20' }, { accountId: seed.acc.sales.id, credit: '50' }]));
  const before = state();
  // فشل في الخطوة الأخيرة: السطر الثالث في الأستاذ (بعد إصدار الرقم وتحديث القيد وكتابة سطرين)
  db.exec(`CREATE TEMP TRIGGER fail_third_gl BEFORE INSERT ON main.gl_entries WHEN (SELECT count(*) FROM main.gl_entries WHERE source_id = ${d.id}) = 2
    BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
  const r = await postEntry(s, d.id);
  assert.equal(r.status, 500);
  db.exec('DROP TRIGGER fail_third_gl');
  assert.equal(state(), before);
  const e = ok(await s.admin.get('/api/journal/' + d.id));
  assert.deepEqual([e.status, e.number, e.fiscalPeriodId, e.totalBase], ['draft', null, null, '0']);
  assert.ok(e.lines.every((l) => l.debit === '0' && l.credit === '0'));                   // المبالغ الأساسية لم تُحفظ
  // بعد زوال العطل: يأخذ الرقم 2 (الرقم الذي «كاد» يصدر لم يُستهلك)
  assert.equal(ok(await postEntry(s, d.id)).number, 'JV-HQ-FY2026-000002');
  assert.deepEqual(s.app.services.ledger.integrity(), { ok: true, problems: [] });
});

test('numbering: سنة مالية انتقالية — سنتان تبدآن في 2026 تشتركان في عداد FY2026 فلا يتكرر رقم', async (t) => {
  const s = await startReady(); t.after(s.stop);
  // سنة قصيرة (يناير–يونيو) ثم سنة تبدأ في يوليو، متصلتان (P5)
  const seed = await seedLedger(s, { fy: { code: 'FY26S', startDate: '2026-01-01', endDate: '2026-06-30' } });
  ok(await s.admin.post('/api/fiscal-years', { code: 'FY2627', nameAr: '2026/2027', nameEn: '2026/27', startDate: '2026-07-01', endDate: '2027-06-30', periodType: 'monthly' }));
  const a = await postNew(s, seed, LINES(seed), { entryDate: '2026-03-01' });
  const b = await postNew(s, seed, LINES(seed), { entryDate: '2026-08-01' });
  assert.deepEqual([a.number, b.number], ['JV-HQ-FY2026-000001', 'JV-HQ-FY2026-000002']);
  const rows = s.app.db.prepare('SELECT fiscal_year_id, year_key, seq FROM issued_numbers ORDER BY seq').all();
  assert.notEqual(rows[0].fiscal_year_id, rows[1].fiscal_year_id);                       // معنى الرقم (السنة) محفوظ
  assert.deepEqual(rows.map((r) => r.year_key), [2026, 2026]);
});

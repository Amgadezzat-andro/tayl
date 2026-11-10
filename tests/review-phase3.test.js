'use strict';
/* المرحلة 3: اختبارات انحدار لنتائج المراجعة المستقلة للكود (كل نتيجة مؤكدة لها اختبار). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startReady, makeUser } = require('./helpers');
const { ok, seedLedger, draft, postEntry, postNew } = require('./ledger-helpers');

const L = (seed, a = '10', extra = {}) => [{ accountId: seed.acc.cash.id, debit: a, ...extra }, { accountId: seed.acc.sales.id, credit: a }];
const periodsOf = async (s) => ok(await s.admin.get('/api/fiscal-years/' + ok(await s.admin.get('/api/fiscal-years'))[0].id)).periods;

test('مراجعة 1: نطاق يمتد خارج السنوات المعرّفة لا يكون «نهائيًا» ولو كانت كل فتراته المعرّفة مقفلة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  await postNew(s, seed, L(seed, '100'));
  for (const p of await periodsOf(s)) { ok(await s.admin.post(`/api/fiscal-periods/${p.id}/close`, { reason: 'إغلاق' })); ok(await s.admin.post(`/api/fiscal-periods/${p.id}/lock`, { reason: 'قفل' })); }
  assert.deepEqual(ok(await s.admin.get('/api/ledger/trial-balance?from=2026-01-01&to=2026-12-31')).finality, { final: true, reasons: [] });
  const f = ok(await s.admin.get('/api/ledger/trial-balance?from=2026-01-01&to=2027-12-31')).finality;
  assert.equal(f.final, false); assert.ok(f.reasons.some((r) => r.code === 'RANGE_NOT_COVERED'));
});

test('مراجعة 2: لا سنة قبل الأولى بعد إغلاق أو قفل أي فترة (الخادم والقاعدة) — يحمي ثابت P2', async (t) => {
  const s = await startReady(); t.after(s.stop);
  await seedLedger(s);
  const p = await periodsOf(s);
  ok(await s.admin.post(`/api/fiscal-periods/${p[0].id}/close`, { reason: 'إغلاق' }));
  const r = await s.admin.post('/api/fiscal-years', { code: 'FY25', nameAr: '2025', nameEn: '2025', startDate: '2025-01-01', endDate: '2025-12-31', periodType: 'monthly' });
  assert.equal(r.body.error.code, 'FISCAL_YEAR_BEFORE_CLOSED');
  assert.throws(() => s.app.db.prepare("INSERT INTO fiscal_years (code,name_ar,name_en,start_date,end_date,period_type) VALUES ('Z','z','z','2025-01-01','2025-12-31','monthly')").run(), /once a period is closed or locked/);
});

test('مراجعة 3: كود فرع ظهر في أرقام فرع آخر لا يُعاد استخدامه؛ العودة لكود الفرع نفسه مسموحة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const alx = ok(await s.admin.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  await postNew(s, seed, L(seed));                                         // JV-HQ-FY2026-000001
  ok(await s.admin.put('/api/branches/' + seed.hq.id, { code: 'HQX' }));
  const r = await s.admin.put('/api/branches/' + alx.id, { code: 'HQ' });
  assert.equal(r.body.error.code, 'BRANCH_CODE_IN_NUMBERS'); assert.equal(r.body.error.details.fields.code, 'USED_IN_NUMBERS');
  assert.equal(ok(await s.admin.get('/api/branches/' + alx.id)).code, 'ALX');   // لم يتغير شيء
  ok(await s.admin.put('/api/branches/' + seed.hq.id, { code: 'HQ' }));          // الفرع نفسه يعود لكوده
  assert.equal((await postNew(s, seed, L(seed))).number, 'JV-HQ-FY2026-000002');
});

test('مراجعة 5 و6: مستخدم فرع لا يرى مركز تكلفة فرع آخر عبر المسودة، ولا فحص السلامة الشامل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const alx = ok(await s.admin.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  const typeId = s.app.db.prepare('SELECT id FROM cost_center_types LIMIT 1').get().id;
  const hqCc = ok(await s.admin.post('/api/cost-centers', { code: 'HQSECRET', nameAr: 'سري', nameEn: 'Secret', typeId, branchId: seed.hq.id }));
  const u = await makeUser(s, { username: 'alxclerk', permissions: ['journal.view', 'journal.create', 'ledger.view'], branchIds: [alx.id] });
  const r = await draft(s, seed, L(seed, '10', { costCenterId: hqCc.id }), { branchId: alx.id }, u.client);
  assert.equal(r.status, 400); assert.equal(r.body.error.details.fields['lines.0.costCenterId'], 'NOT_FOUND');
  assert.equal((await u.client.get('/api/ledger/integrity')).status, 403);
  assert.equal(ok(await s.admin.get('/api/ledger/integrity')).ok, true);
});

test('مراجعة 7 و9: طباعة دفتر اليومية كاملة أو مرفوضة، ومرشح المركز يطابق السطور المعروضة للإجمالي', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  await postNew(s, seed, [{ accountId: seed.acc.rent.id, debit: '7', costCenterId: seed.cc.id }, { accountId: seed.acc.cash.id, credit: '7' }]);
  const r = ok(await s.admin.get(`/api/ledger/journal?from=2026-01-01&to=2026-12-31&costCenterId=${seed.cc.id}`));
  assert.equal(r.items[0].lines.length, 1); assert.equal(r.items[0].totalDebit, '7'); assert.equal(r.items[0].totalCredit, '0');
  // أكثر من 500 مستند ⇒ الطباعة/التصدير ترفض بدل إجمالي لا يطابق الصفوف
  const db = s.app.db;
  const ctx = { user: { id: 1, username: 'admin' }, ip: '127.0.0.1', requestId: 't', branchId: seed.hq.id,
    access: { allBranches: true, can: () => true, assertBranch() {}, branchAllowed: () => true, branchIds: () => [], sqlFilter: () => ({ sql: '1 = 1', params: [] }) } };
  require('../server/core/db').inTransaction(db, () => {
    for (let i = 0; i < 500; i++) s.app.services.journal.postEntry(ctx, s.app.services.journal.createDraft(ctx, { branchId: seed.hq.id, entryDate: '2026-03-15', description: 'x' + i, lines: L(seed, '1') }).id);
  });
  assert.equal((await s.admin.get('/api/ledger/journal/print?from=2026-01-01&to=2026-12-31')).body.error.code, 'REPORT_TOO_LARGE');
  assert.equal(ok(await s.admin.get('/api/ledger/journal/print?from=2026-03-15&to=2026-03-15&number=FY2026-0000')).rows.length > 0, true);
});

test('مراجعة 8 والافتتاحي: طباعة السند بصلاحية journal.print؛ عكس الافتتاحي وحذف مسودته يتطلبان journal.opening', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const e = await postNew(s, seed, L(seed));
  const v = await makeUser(s, { username: 'nprint', permissions: ['journal.view'], allBranches: true });
  assert.equal((await v.client.get(`/api/journal/${e.id}/print`)).status, 403);
  assert.equal(ok(await s.admin.get(`/api/journal/${e.id}/print`)).number, e.number);
  const ob = await postNew(s, seed, L(seed), { entryType: 'opening', entryDate: '2026-01-01' });
  const rv = await makeUser(s, { username: 'revonly', permissions: ['journal.view', 'journal.reverse', 'journal.delete'], allBranches: true });
  assert.equal((await rv.client.post(`/api/journal/${ob.id}/reverse`, { reason: 'محاولة' })).status, 403);
  assert.equal(ok(await rv.client.post(`/api/journal/${e.id}/reverse`, { reason: 'قيد عادي' })).entryType, 'reversal');
  const obDraft = ok(await draft(s, seed, L(seed), { entryType: 'opening', entryDate: '2026-01-01' }));
  assert.equal((await rv.client.del('/api/journal/' + obDraft.id)).status, 403);
});

test('مراجعة 6.3: تغيير تاريخ المسودة أو عملة السطر يُسقط السعر اليدوي المنقول في الخادم ما لم يُعَد تأكيده', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s, { usdRate: '48.5' });
  const lines = [{ accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '10', rate: '49', rateReason: 'سعر البنك' }, { accountId: seed.acc.sales.id, currencyId: seed.usd.id, credit: '10', rate: '49', rateReason: 'سعر البنك' }];
  const d = ok(await draft(s, seed, lines));
  const put = (b) => s.admin.put('/api/journal/' + d.id, { branchId: seed.hq.id, description: 'قيد', lines, ...b });
  assert.deepEqual(ok(await put({ entryDate: '2026-03-15' })).lines.map((l) => l.rateSource), ['manual', 'manual']);    // التاريخ لم يتغير
  assert.deepEqual(ok(await put({ entryDate: '2026-03-20' })).lines.map((l) => [l.rateSource, l.rate]), [['table', '48.5'], ['table', '48.5']]);
  // السابق صار من الجدول ⇒ السعر اليدوي المرسل الآن إدخال جديد مقصود (بصلاحية وسبب) فيُقبل
  assert.deepEqual(ok(await put({ entryDate: '2026-03-21' })).lines.map((l) => l.rateSource), ['manual', 'manual']);
  // يدوي منقول + تغيير التاريخ: يسقط بلا تأكيد، ويبقى بتأكيد صريح
  assert.deepEqual(ok(await put({ entryDate: '2026-03-22', reconfirmManualRates: true })).lines.map((l) => l.rateSource), ['manual', 'manual']);
  assert.deepEqual(ok(await put({ entryDate: '2026-03-25' })).lines.map((l) => l.rateSource), ['table', 'table']);
  // تغيير عملة السطر يُسقط اليدوي المنقول أيضًا
  ok(await put({ entryDate: '2026-03-25' }));
  const eurLines = lines.map((l) => ({ ...l, currencyId: seed.eur.id }));
  assert.deepEqual(ok(await s.admin.put('/api/journal/' + d.id, { branchId: seed.hq.id, description: 'قيد', entryDate: '2026-03-25', lines: eurLines })).lines.map((l) => [l.rateSource, l.currencyCode]), [['table', 'EUR'], ['table', 'EUR']]);
});

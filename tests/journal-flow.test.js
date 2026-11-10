'use strict';
/* المرحلة 3: اختبارات تكامل الدورة كاملة عبر الـ API — المسودة، التعديل، الترحيل، العكس، الافتتاحي، فصل المهام، والتقارير. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDecimalService } = require('../server/core/decimal');
const { startReady, makeUser } = require('./helpers');
const { ok, seedLedger, draft, postEntry, postNew } = require('./ledger-helpers');

const D = createDecimalService();
const L = (seed, amount = '100', extra = {}) => [{ accountId: seed.acc.cash.id, debit: amount, ...extra }, { accountId: seed.acc.sales.id, credit: amount }];
const count = (s, t, where = '1') => s.app.db.prepare(`SELECT count(*) c FROM ${t} WHERE ${where}`).get().c;
const tb = async (s, q = 'from=2026-01-01&to=2026-12-31') => ok(await s.admin.get('/api/ledger/trial-balance?' + q));
const row = (r, code) => r.rows.find((x) => x.code === code);

test('flow: مسودة ← تعديل ← ترحيل ← تظهر في دفتر اليومية وكشف الحساب وميزان المراجعة مطابقة للأستاذ', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const d = ok(await draft(s, seed, L(seed, '100')));
  // تعديل المسودة: التاريخ والبيان والسطور (سطر بالدولار)، ولا رقم
  const u = ok(await s.admin.put('/api/journal/' + d.id, { branchId: seed.hq.id, entryDate: '2026-04-10', description: 'بيع نقدي معدل', reference: 'INV-7',
    lines: [{ accountId: seed.acc.cash.id, debit: '250.50', costCenterId: seed.cc.id }, { accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '731.73456789' }] }));
  assert.deepEqual([u.status, u.number, u.entryDate, u.reference, u.lines.length], ['draft', null, '2026-04-10', 'INV-7', 3]);
  assert.equal(u.lines[1].rateSource, 'table'); assert.equal(u.lines[1].rate, '48.123456789012');
  const ev = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action = 'journal_entry.updated'").get().details);
  assert.deepEqual(ev.changes.entryDate, { from: '2026-03-15', to: '2026-04-10' }); assert.deepEqual(ev.lines, { from: 2, to: 3 });
  // المعاينة = ما سيُرحَّل (نفس الدالة): 10 × 48.123456789012 = 481.23456789
  const pv = ok(await s.admin.post('/api/journal/preview', { entryDate: '2026-04-10', lines: u.lines.map((l) => ({ currencyId: l.currencyId, debit: l.debitFc !== '0' ? l.debitFc : undefined, credit: l.creditFc !== '0' ? l.creditFc : undefined })) }));
  assert.equal(pv.balanced, true); assert.equal(pv.totalDebit, '731.73456789'); assert.equal(pv.lines[1].base, '481.23456789');
  const p = ok(await postEntry(s, d.id));
  assert.equal(p.number, 'JV-HQ-FY2026-000001'); assert.deepEqual(p.lines.map((l) => l.debit), pv.lines.map((l) => (l.side === 'debit' ? l.base : '0')));
  // دفتر اليومية
  const jr = ok(await s.admin.get('/api/ledger/journal?from=2026-01-01&to=2026-12-31'));
  assert.equal(jr.items.length, 1); assert.equal(jr.items[0].number, p.number); assert.equal(jr.items[0].lines.length, 3);
  assert.deepEqual([jr.totals.debit, jr.totals.credit, jr.totals.balanced], ['731.73456789', '731.73456789', true]);
  // كشف حساب المبيعات: دائن 731.73456789
  const st = ok(await s.admin.get(`/api/ledger/statement?accountId=${seed.acc.sales.id}&from=2026-01-01&to=2026-12-31`));
  assert.equal(st.rows.length, 1); assert.deepEqual([st.rows[0].credit, st.rows[0].balance.side, st.closing.credit], ['731.73456789', 'credit', '731.73456789']);
  // كشف الحساب التجميعي (الأصول) يشمل الصندوق وبنك الدولار
  const sa = ok(await s.admin.get(`/api/ledger/statement?accountId=${seed.acc.assets.id}&from=2026-01-01&to=2026-12-31`));
  assert.equal(sa.rows.length, 2); assert.equal(sa.closing.debit, '731.73456789');
  // كشف بعملة: المبالغ الأصلية ورصيدها
  const su = ok(await s.admin.get(`/api/ledger/statement?accountId=${seed.acc.bankUsd.id}&from=2026-01-01&to=2026-12-31&currencyId=${seed.usd.id}`));
  assert.deepEqual([su.rows[0].debitFc, su.closingFc.debit, su.closing.debit], ['10', '10', '481.23456789']);
  // الميزان: متزن، والتجميعي = مجموع فروعه، ومطابق للأستاذ مباشرة
  const r = await tb(s);
  assert.equal(r.totals.balanced.all, true);
  assert.equal(row(r, '1').closing.debit, '731.73456789'); assert.equal(row(r, '4').closing.credit, '731.73456789');
  assert.equal(row(r, '1101').movementDebit, '250.5');
  const gl = s.app.db.prepare('SELECT dec_sum(debit) d FROM gl_entries').get().d;
  assert.equal(r.totals.movementDebit, gl);
  // صفوف الحسابات بلا حركة مخفية افتراضيًا ومُظهرة عند الطلب
  assert.equal(row(r, '5101'), undefined); assert.ok(row(await tb(s, 'from=2026-01-01&to=2026-12-31&includeZero=1'), '5101'));
  assert.deepEqual(s.app.services.ledger.integrity(), { ok: true, problems: [] });
});

test('flow: القيد العكسي — مرآة كاملة بالمبالغ والأسعار المحفوظة، الأرصدة تعود صفرًا، والأصل لا يتغير', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  // سطران بسعر الجدول وسطر بسعر يدوي (فرق صريح بالجنيه) — العكس يحافظ على كل ذلك
  const orig = await postNew(s, seed, [{ accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '33.33', costCenterId: seed.cc.id },
    { accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '66.67' },
    { accountId: seed.acc.sales.id, currencyId: seed.usd.id, credit: '100', rate: '50', rateReason: 'سعر البنك الفعلي' },
    { accountId: seed.acc.fxDiff.id, debit: '187.6543211' }], { entryDate: '2026-05-05' });
  assert.deepEqual(orig.lines.map((l) => l.rateSource), ['table', 'table', 'manual', 'base']);
  const before = JSON.stringify(s.app.db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(orig.id));
  // سعر الدولار يُصحَّح بعد الترحيل: العكس لا يتأثر (يستخدم المحفوظ)
  ok(await s.admin.post(`/api/currencies/rates/${seed.usdRateRow.id}/correct`, { rate: '99', reason: 'تصحيح لاحق' }));
  // ويصبح الحساب حساب مراقبة ومركز التكلفة معطلًا: العكس لا يتأثر
  ok(await s.admin.put('/api/accounts/' + seed.acc.bankUsd.id, { allowManualEntry: false }));
  ok(await s.admin.post(`/api/cost-centers/${seed.cc.id}/status`, { active: false }));
  assert.equal((await s.admin.post(`/api/journal/${orig.id}/reverse`, {})).body.error.details.fields.reason, 'REQUIRED');
  const rev = ok(await s.admin.post(`/api/journal/${orig.id}/reverse`, { reason: 'تسجيل خاطئ للبيع' }));
  assert.equal(rev.number, 'RV-HQ-FY2026-000001'); assert.equal(rev.entryType, 'reversal'); assert.equal(rev.entryDate, '2026-05-05');
  assert.equal(rev.reverses.id, orig.id); assert.equal(rev.reason, 'تسجيل خاطئ للبيع');
  assert.deepEqual(rev.lines.map((l) => [l.accountId, l.costCenterId, l.currencyCode, l.rate, l.rateSource, l.debitFc, l.creditFc, l.debit, l.credit]),
    orig.lines.map((l) => [l.accountId, l.costCenterId, l.currencyCode, l.rate, l.rateSource, l.creditFc, l.debitFc, l.credit, l.debit]));
  assert.equal(JSON.stringify(s.app.db.prepare('SELECT * FROM journal_lines WHERE entry_id = ?').all(orig.id)), before);   // الأصل كما هو
  // الأرصدة: صافي كل حساب صفر بالعملتين
  for (const a of [seed.acc.bankUsd.id, seed.acc.sales.id]) {
    const x = s.app.db.prepare('SELECT dec_sum(debit) d, dec_sum(credit) c, dec_sum(debit_fc) fd, dec_sum(credit_fc) fc FROM gl_entries WHERE account_id = ?').get(a);
    assert.equal(x.d, x.c); assert.equal(x.fd, x.fc);
  }
  const r = await tb(s);
  assert.equal(row(r, '1102').closing.net, '0'); assert.equal(r.totals.balanced.all, true);
  // الأصل يظهر «معكوس» والعلاقة في الاتجاهين
  const o = ok(await s.admin.get('/api/journal/' + orig.id));
  assert.equal(o.reversedBy.number, rev.number);
  assert.equal(ok(await s.admin.get('/api/journal?status=reversed')).items[0].id, orig.id);
  const jr = ok(await s.admin.get('/api/ledger/journal?from=2026-01-01&to=2026-12-31'));
  assert.equal(jr.items.find((d) => d.number === rev.number).reverses.number, orig.number);
  // الرفض: عكس ثانٍ، عكس العكسي، عكس مسودة
  assert.equal((await s.admin.post(`/api/journal/${orig.id}/reverse`, { reason: 'مرة أخرى' })).body.error.code, 'ALREADY_REVERSED');
  assert.equal((await s.admin.post(`/api/journal/${rev.id}/reverse`, { reason: 'عكس العكس' })).body.error.code, 'REVERSAL_NOT_REVERSIBLE');
  const d = ok(await draft(s, seed, L(seed)));
  assert.equal((await s.admin.post(`/api/journal/${d.id}/reverse`, { reason: 'مسودة' })).body.error.code, 'NOT_POSTED');
  // القيد العكسي لا يُعدَّل ولا يُحذف ولا يُرحَّل يدويًا
  assert.equal((await s.admin.del('/api/journal/' + rev.id)).body.error.code, 'NOT_DRAFT');
  // التدقيق
  const a = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action = 'journal_entry.reversed'").get().details);
  assert.deepEqual([a.original, a.reversal, a.reason], [orig.number, rev.number, 'تسجيل خاطئ للبيع']);
  assert.deepEqual(s.app.services.ledger.integrity(), { ok: true, problems: [] });
});

test('flow: العكس — فترة الأصل المغلقة تتطلب تاريخًا مفتوحًا لا يسبق الأصل، والصلاحية والنطاق، والتراجع الذري', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const orig = await postNew(s, seed, L(seed), { entryDate: '2026-02-10' });
  const fy = ok(await s.admin.get('/api/fiscal-years'))[0];
  const feb = ok(await s.admin.get('/api/fiscal-years/' + fy.id)).periods[1];
  ok(await s.admin.post(`/api/fiscal-periods/${feb.id}/close`, { reason: 'إغلاق فبراير' }));
  const R = (b, c = s.admin) => c.post(`/api/journal/${orig.id}/reverse`, b);
  assert.equal((await R({ reason: 'تصحيح' })).body.error.code, 'REVERSAL_DATE_REQUIRED');
  assert.equal((await R({ reason: 'تصحيح', date: '2026-02-20' })).body.error.code, 'PERIOD_NOT_OPEN');
  assert.equal((await R({ reason: 'تصحيح', date: '2026-02-01' })).body.error.details.fields.date, 'BEFORE_ORIGINAL');
  // الصلاحية: من يرحّل لا يعكس بلا journal.reverse
  const poster = await makeUser(s, { username: 'poster', permissions: ['journal.view', 'journal.post'], allBranches: true });
  assert.equal((await R({ reason: 'تصحيح', date: '2026-03-01' }, poster.client)).status, 403);
  // النطاق: فرع آخر = غير موجود
  const alx = ok(await s.admin.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  const rv = await makeUser(s, { username: 'alxrev', permissions: ['journal.view', 'journal.reverse'], branchIds: [alx.id] });
  assert.equal((await R({ reason: 'تصحيح', date: '2026-03-01' }, rv.client)).status, 404);
  // التراجع الذري: عطل عند كتابة الأستاذ ⇒ لا قيد عكسي ولا رقم ولا تدقيق
  const db = s.app.db;
  db.exec(`CREATE TEMP TRIGGER fail_rev_gl BEFORE INSERT ON main.gl_entries WHEN (SELECT entry_type FROM main.journal_entries WHERE id = NEW.source_id) = 'reversal'
    BEGIN SELECT RAISE(ABORT, 'simulated failure'); END;`);
  assert.equal((await R({ reason: 'تصحيح', date: '2026-03-01' })).status, 500);
  db.exec('DROP TRIGGER fail_rev_gl');
  assert.equal(count(s, 'journal_entries', "entry_type = 'reversal'"), 0);
  assert.equal(count(s, 'issued_numbers', "doc_type = 'journal_reversal'"), 0);
  assert.equal(count(s, 'audit_log', "action = 'journal_entry.reversed'"), 0);
  const ok2 = ok(await R({ reason: 'تصحيح', date: '2026-03-01' }));
  assert.equal(ok2.number, 'RV-HQ-FY2026-000001');
});

test('flow: القيد الافتتاحي — أول يوم من أول سنة، فعّال واحد لكل فرع، تصحيحه بالعكس، ولا يقبله حساب مراقبة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const O = (lines, extra = {}) => draft(s, seed, lines, { entryType: 'opening', entryDate: '2026-01-01', ...extra });
  const equityG = ok(await s.admin.post('/api/accounts', { code: '3', nameAr: 'حقوق الملكية', nameEn: 'Equity', classCode: 'equity', isGroup: true }));
  const openAcc = ok(await s.admin.post('/api/accounts', { code: '3901', nameAr: 'أرصدة افتتاحية', nameEn: 'Opening balances', parentId: equityG.id }));
  const lines = [{ accountId: seed.acc.cash.id, debit: '5000' }, { accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '100' }, { accountId: openAcc.id, credit: '9812.3456789' }];
  const first = ok(await O(lines));
  const p1 = ok(await postEntry(s, first.id));
  assert.equal(p1.number, 'OB-HQ-FY2026-000001');
  assert.equal(s.app.db.prepare('SELECT DISTINCT entry_kind k FROM gl_entries WHERE source_id = ?').get(p1.id).k, 'opening');
  // افتتاحي ثانٍ لنفس الفرع مرفوض (خادم + قاعدة)
  const second = ok(await O(lines));
  assert.equal((await postEntry(s, second.id)).body.error.code, 'OPENING_EXISTS');
  // لفرع آخر مسموح
  const alx = ok(await s.admin.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  assert.equal(ok(await postEntry(s, ok(await O(lines, { branchId: alx.id })).id)).number, 'OB-ALX-FY2026-000001');
  // التصحيح: عكس الأول (حركة افتتاحية أيضًا) ثم ترحيل الصحيح
  const rv = ok(await s.admin.post(`/api/journal/${p1.id}/reverse`, { reason: 'تصحيح الأرصدة الافتتاحية' }));
  assert.equal(s.app.db.prepare('SELECT DISTINCT entry_kind k FROM gl_entries WHERE source_id = ?').get(rv.id).k, 'opening');
  assert.equal(ok(await postEntry(s, second.id)).number, 'OB-HQ-FY2026-000002');
  // حساب مراقبة لا يقبل الافتتاحي (لا ازدواج مع الأرصدة التفصيلية المستقبلية) — فرع ثالث بلا افتتاحي
  const giz = ok(await s.admin.post('/api/branches', { code: 'GIZ', nameAr: 'الجيزة', nameEn: 'Giza' }));
  ok(await s.admin.put('/api/accounts/' + seed.acc.cash.id, { allowManualEntry: false }));
  const ctl = ok(await O(lines, { branchId: giz.id }));
  assert.equal((await postEntry(s, ctl.id)).body.error.code, 'MANUAL_ENTRY_NOT_ALLOWED');
  // تاريخ غير أول يوم من أول سنة
  assert.equal((await O(lines, { entryDate: '2026-01-02' })).body.error.code, 'OPENING_DATE');
  // دفاع القاعدة: الترحيل المباشر لافتتاحي ثانٍ فعّال
  assert.throws(() => s.app.db.prepare("UPDATE journal_entries SET status = 'posted', number = 'X', fiscal_period_id = 1, decimal_snapshot = '{}', total_base = '1', posted_by = 1, posted_at = 'now' WHERE id = ?").run(ctl.id),
    /opening entry already exists|non-zero base|account is inactive/);
});

test('flow: فصل المهام اختياري — عند التفعيل لا يرحّل المنشئ أو آخر من عدّل، ويرحّل غيره', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const clerk = await makeUser(s, { username: 'clerk2', permissions: ['journal.view', 'journal.create', 'journal.update', 'journal.post'], allBranches: true });
  const chief = await makeUser(s, { username: 'chief', permissions: ['journal.view', 'journal.post'], allBranches: true });
  const d1 = ok(await draft(s, seed, L(seed), {}, clerk.client));
  assert.equal(ok(await postEntry(s, d1.id, clerk.client)).status, 'posted');            // الإعداد معطّل افتراضيًا
  const st = ok(await s.admin.get('/api/settings'));
  ok(await s.admin.put('/api/settings', { ...st.values, journalSegregatePosting: 1 }));
  const d2 = ok(await draft(s, seed, L(seed), {}, clerk.client));
  assert.equal((await postEntry(s, d2.id, clerk.client)).body.error.code, 'SEGREGATION_REQUIRED');
  // آخر من عدّل لا يرحّل أيضًا
  ok(await chief.client.get('/api/journal/' + d2.id));
  const d3 = ok(await draft(s, seed, L(seed)));
  ok(await clerk.client.put('/api/journal/' + d3.id, { branchId: seed.hq.id, entryDate: '2026-03-16', description: 'تعديل', lines: L(seed, '7') }));
  assert.equal((await postEntry(s, d3.id, clerk.client)).body.error.code, 'SEGREGATION_REQUIRED');
  assert.equal(ok(await postEntry(s, d2.id, chief.client)).status, 'posted');
  assert.equal(ok(await postEntry(s, d3.id, chief.client)).status, 'posted');
  assert.equal(ok(await s.admin.get('/api/ledger/status')).segregatePosting, true);
});

test('flow: الصلاحيات ونطاق الفروع على التعديل والقائمة والتقارير، والتصدير والطباعة بختم النهائية', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const alx = ok(await s.admin.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  await postNew(s, seed, L(seed, '100'));
  await postNew(s, seed, L(seed, '40'), { branchId: alx.id });
  const d = ok(await draft(s, seed, L(seed)));
  const viewer = await makeUser(s, { username: 'jviewer', permissions: ['journal.view'], allBranches: true });
  assert.equal((await viewer.client.put('/api/journal/' + d.id, { branchId: seed.hq.id, entryDate: '2026-03-15', description: 'x', lines: L(seed) })).status, 403);
  assert.equal((await viewer.client.post('/api/journal/preview', { entryDate: '2026-03-15', lines: [] })).status, 403);
  assert.equal((await viewer.client.get('/api/ledger/trial-balance?from=2026-01-01&to=2026-12-31')).status, 403);   // التقارير بصلاحية ledger.view
  // مستخدم فرع ALX: القائمة والتقارير لفرعه فقط
  const ax = await makeUser(s, { username: 'axl', permissions: ['journal.view', 'ledger.view', 'ledger.export', 'ledger.print'], branchIds: [alx.id] });
  const lst = ok(await ax.client.get('/api/journal'));
  assert.deepEqual(lst.items.map((e) => e.branchCode), ['ALX']);
  const r = ok(await ax.client.get('/api/ledger/trial-balance?from=2026-01-01&to=2026-12-31'));
  assert.equal(r.totals.movementDebit, '40');
  assert.equal((await ax.client.get(`/api/ledger/trial-balance?from=2026-01-01&to=2026-12-31&branch=${seed.hq.id}`)).body.error.code, 'BRANCH_FORBIDDEN');
  assert.equal(ok(await ax.client.get(`/api/ledger/statement?accountId=${seed.acc.cash.id}&from=2026-01-01&to=2026-12-31`)).closing.debit, '40');
  // الطباعة والتصدير: ختم «غير نهائي» (الفترات مفتوحة)، والتصدير مُدقَّق
  const pr = ok(await ax.client.get('/api/ledger/trial-balance/print?from=2026-01-01&to=2026-12-31'));
  assert.match(pr.title, /غير نهائي/); assert.equal(pr.finality.final, false);
  const res = await fetch(s.base + '/api/ledger/statement/export.xlsx?accountId=' + seed.acc.cash.id + '&from=2026-01-01&to=2026-12-31', { headers: { cookie: ax.client.state.cookie } });
  assert.equal(res.status, 200); assert.match(res.headers.get('content-type'), /spreadsheetml/);
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'ledger.exported'").get());
  const noExp = await makeUser(s, { username: 'noexp', permissions: ['ledger.view'], allBranches: true });
  assert.equal((await fetch(s.base + '/api/ledger/journal/export.xlsx?from=2026-01-01&to=2026-12-31', { headers: { cookie: noExp.client.state.cookie } })).status, 403);
  assert.equal((await noExp.client.get('/api/ledger/journal/print?from=2026-01-01&to=2026-12-31')).status, 403);
  // البحث في القائمة بالرقم وأنواع التصفية
  assert.equal(ok(await s.admin.get('/api/journal?q=FY2026-000001')).items.length, 2);
  assert.equal(ok(await s.admin.get('/api/journal?status=draft')).items.length, 1);
  // القوائم المرجعية متاحة لمستخدم القيود دون صلاحية الحسابات
  const clerk = await makeUser(s, { username: 'clerk3', permissions: ['journal.create'], allBranches: true });
  assert.equal((await clerk.client.get('/api/accounts/lookup?usable=1')).status, 200);
  assert.equal((await clerk.client.get('/api/cost-centers/lookup?usable=1')).status, 200);
  assert.equal((await clerk.client.get('/api/currencies/lookup')).status, 200);
  assert.equal((await clerk.client.get('/api/accounts')).status, 403);
});

test('flow: لا مسار بديل للكتابة في الأستاذ — gl_entries تُكتب في ledger.js فقط', () => {
  const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(path.join(d, e.name)) : e.name.endsWith('.js') ? [path.join(d, e.name)] : []));
  const writers = files(path.join(__dirname, '..', 'server')).filter((f) => /INSERT\s+INTO\s+gl_entries/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(writers.map((f) => path.relative(path.join(__dirname, '..'), f)), [path.join('server', 'modules', 'journal', 'ledger.js')]);
  // ولا Number/parseFloat في حسابات الوحدة المالية
  for (const f of files(path.join(__dirname, '..', 'server', 'modules', 'journal'))) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\/.*$/gm, '');
    assert.ok(!/parseFloat|Math\.round|toFixed\(|Number\((?:debit|credit|amount|rate|total)/.test(src), f);
  }
});

test('flow: ميزان المراجعة — أول المدة والحركة وآخر المدة لفترة جزئية، والتصفية بمركز التكلفة، والدقة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  await postNew(s, seed, L(seed, '100.01'), { entryDate: '2026-01-10' });
  await postNew(s, seed, [{ accountId: seed.acc.rent.id, debit: '0.03', costCenterId: seed.cc.id }, { accountId: seed.acc.cash.id, credit: '0.03' }], { entryDate: '2026-02-10' });
  await postNew(s, seed, L(seed, '0.1'), { entryDate: '2026-02-11' });
  const r = await tb(s, 'from=2026-02-01&to=2026-02-28');
  const cash = row(r, '1101');
  assert.deepEqual([cash.opening.debit, cash.movementDebit, cash.movementCredit, cash.closing.debit], ['100.01', '0.1', '0.03', '100.08']);
  assert.equal(r.totals.balanced.all, true);
  assert.equal(r.totals.openingDebit, '100.01'); assert.equal(r.totals.closingDebit, D.canonical(D.add('100.08', '0.03')));
  const byCc = await tb(s, `from=2026-01-01&to=2026-12-31&costCenterId=${seed.cc.id}`);
  assert.deepEqual(byCc.rows.filter((x) => !x.isGroup).map((x) => x.code), ['5101']);
  // المستويات: المستوى الأول فقط
  assert.ok((await tb(s, 'from=2026-01-01&to=2026-12-31&level=1')).rows.every((x) => x.level === 1));
  // فترة خاطئة
  assert.equal((await s.admin.get('/api/ledger/trial-balance?from=2026-03-01&to=2026-02-01')).body.error.details.fields.to, 'END_BEFORE_START');
});

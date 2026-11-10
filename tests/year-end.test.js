'use strict';
/* المرحلة 4: الإقفال السنوي وترحيل الأرصدة — على قاعدة بيانات حقيقية مؤقتة (لا mocks)، عبر HTTP كما يستخدمها البرنامج. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { startReady, makeUser } = require('./helpers');
const { ok } = require('./ledger-helpers');
const { seedYears, setRetained, post, closePeriods, closeYear, carryYear, key } = require('./year-end-helpers');

const E = (r) => (r.body && r.body.error ? r.body.error.code : `HTTP ${r.status}`);
const tb = async (s, from, to, extra = '') => {
  const r = ok(await s.admin.get(`/api/ledger/trial-balance?from=${from}&to=${to}${extra}`));
  return { ...r, by: Object.fromEntries(r.rows.map((x) => [x.code, x])) };
};
const net = (row) => (row ? row.closing.net : '0');
const statusOf = async (s, yearId, client = s.admin) => ok(await client.get('/api/year-end/status?fiscalYearId=' + yearId));
const integrity = (s) => s.app.services.ledger.integrity();
const dbChecks = (s) => {
  assert.deepEqual(s.app.db.prepare('PRAGMA foreign_key_check').all(), []);
  assert.equal(s.app.db.prepare('PRAGMA integrity_check').get().integrity_check, 'ok');
  const r = integrity(s); assert.equal(r.ok, true, JSON.stringify(r.problems));
};
const counts = (s) => s.app.db.prepare(`SELECT (SELECT count(*) FROM year_closings) yc, (SELECT count(*) FROM carry_forwards) cf, (SELECT count(*) FROM year_end_entries) ye,
  (SELECT count(*) FROM year_end_lines) yl, (SELECT count(*) FROM gl_entries) gl, (SELECT count(*) FROM issued_numbers) nums,
  (SELECT group_concat(last_value) FROM document_counters) ctr, (SELECT count(*) FROM year_end_requests) req`).get();

/** سنة رابحة نموذجية في 2024 للفرع الرئيسي: رأس مال 10000، مبيعات 5000، إيجار 1200 ⇒ ربح 3800. */
async function profitYear(s, seed) {
  const A = seed.acc;
  await post(s, seed, '2024-01-05', [{ accountId: A.cash.id, debit: '10000' }, { accountId: A.capital.id, credit: '10000' }]);
  await post(s, seed, '2024-03-10', [{ accountId: A.cash.id, debit: '5000' }, { accountId: A.sales.id, credit: '5000' }]);
  await post(s, seed, '2024-06-30', [{ accountId: A.rent.id, debit: '1200', costCenterId: seed.cc1.id }, { accountId: A.cash.id, credit: '1200' }]);
}
async function ready(t, { years } = {}) {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedYears(s, years ? { years } : {});
  await setRetained(s, seed);
  return { s, seed };
}

test('م4 (1): سنة رابحة — تصفير الإيرادات والمصروفات، إثبات الربح في حساب النتيجة، وترحيل الميزانية للسنة التالية', async (t) => {
  const { s, seed } = await ready(t);
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  const pv = ok(await s.admin.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, branchIds: 'all', operation: 'close', carryForward: true }));
  assert.equal(pv.ready, true, JSON.stringify(pv.branches[0].errors));
  const b = pv.branches[0];
  assert.deepEqual(b.lines.map((l) => [l.accountCode, l.debit, l.credit, l.basis]), [['4101', '5000', '0', 'balance'], ['6101', '0', '1200', 'balance'], ['3201', '0', '3800', 'result']]);
  assert.equal(b.summary.resultSide, 'profit'); assert.equal(b.summary.netResult, '3800');
  assert.deepEqual(b.carryForwardLines.map((l) => [l.accountCode, l.debit, l.credit]), [['1101', '13800', '0'], ['3101', '0', '10000'], ['3201', '0', '3800']]);
  const before = await tb(s, '2025-01-01', '2025-12-31');
  const r = ok(await s.admin.post('/api/year-end/close', { fiscalYearId: seed.fy[2024].id, branchIds: 'all', carryForward: true, fingerprint: pv.fingerprint, idempotencyKey: key(), acknowledgeWarnings: true, confirm: true }));
  assert.equal(r.branches[0].entry.number, 'YC-HQ-FY2024-000001');
  assert.equal(r.branches[0].carryForward.entry.number, 'CF-HQ-FY2025-000001');
  assert.equal(r.companyClosed, true);
  // بعد الإقفال: قائمة الدخل صفر في نهاية 2024، والنتيجة في الأرباح المحتجزة؛ وقبل الإقفال تُرى بـ excludeClosing
  const after24 = await tb(s, '2024-01-01', '2024-12-31');
  assert.equal(net(after24.by['4101']), '0'); assert.equal(net(after24.by['6101']), '0'); assert.equal(net(after24.by['3201']), '-3800');
  const pre24 = await tb(s, '2024-01-01', '2024-12-31', '&excludeClosing=1');
  assert.equal(net(pre24.by['4101']), '-5000'); assert.equal(net(pre24.by['3201']), '0');
  // السنة التالية: الافتتاح = نهاية 2024، والإيرادات تبدأ صفرًا؛ ولا ازدواج (الأرقام نفسها قبل الترحيل وبعده)
  const y25 = await tb(s, '2025-01-01', '2025-12-31');
  assert.equal(y25.by['1101'].opening.net, '13800'); assert.equal(y25.by['3201'].opening.net, '-3800');
  assert.equal(y25.by['4101'] ? y25.by['4101'].opening.net : '0', '0');
  assert.equal(y25.by['1101'].opening.net, before.by['1101'].opening.net);
  assert.equal(y25.totals.balanced.all, true);
  // السنة السابقة مُقفلة لكل الفروع ⇒ لا سبب PRIOR_YEAR_NOT_CLOSED لتقارير 2025
  assert.ok(!y25.finality.reasons.some((x) => x.code === 'PRIOR_YEAR_NOT_CLOSED'));
  // كشف الحساب لا يكرر الرصيد المرحّل
  const st = ok(await s.admin.get(`/api/ledger/statement?accountId=${seed.acc.cash.id}&from=2025-01-01&to=2025-12-31`));
  assert.equal(st.opening.net, '13800'); assert.equal(st.rows.length, 0); assert.equal(st.closing.net, '13800');
  const rec = ok(await s.admin.get(`/api/year-end/reports/reconciliation?fiscalYearId=${seed.fy[2024].id}`));
  const recHq = rec.branches.find((b) => b.branch.code === 'HQ');
  assert.equal(rec.ok, true); assert.equal(recHq.ok, true); assert.equal(recHq.rows.length, 3); assert.ok(recHq.rows.every((x) => x.fcMatch && x.baseMatch));
  assert.equal(rec.branches.find((b) => b.branch.code === 'ALX').carried, false);
  const res = ok(await s.admin.get(`/api/year-end/reports/result?fiscalYearId=${seed.fy[2024].id}`));
  assert.deepEqual([res.totals.revenue, res.totals.expense, res.totals.net, res.allZeroAfter], ['5000', '1200', '3800', true]);
  // دفتر اليومية يعرض المستندين بنوعيهما
  const jr = ok(await s.admin.get('/api/ledger/journal?from=2024-12-31&to=2025-01-01'));
  assert.deepEqual(jr.items.map((d) => [d.number, d.entryType]), [['YC-HQ-FY2024-000001', 'closing'], ['CF-HQ-FY2025-000001', 'carry_forward']]);
  assert.equal(ok(await s.admin.get('/api/ledger/journal?from=2024-01-01&to=2024-12-31&kind=closing')).items.length, 1);
  dbChecks(s);
  // سجل التدقيق
  const acts = s.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'year_end.%' ORDER BY id").all().map((x) => x.action);
  assert.deepEqual(acts, ['year_end.settings_updated', 'year_end.closed', 'year_end.carried_forward']);
});

test('م4 (2، 3، 7): سنة خاسرة تُثبت الخسارة مدينة، وسنة نتيجتها صفر بلا سطر نتيجة، وأرصدة مدينة ودائنة متنوعة', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  // خسارة 2024: إيراد 1000، تكلفة 700، رواتب 900، ودائنون (رصيد دائن) ومسحوبات من الصندوق
  await post(s, seed, '2024-01-02', [{ accountId: A.cash.id, debit: '5000' }, { accountId: A.capital.id, credit: '5000' }]);
  await post(s, seed, '2024-02-01', [{ accountId: A.cash.id, debit: '1000' }, { accountId: A.sales.id, credit: '1000' }]);
  await post(s, seed, '2024-02-02', [{ accountId: A.cogs.id, debit: '700' }, { accountId: A.payable.id, credit: '700' }]);
  await post(s, seed, '2024-02-03', [{ accountId: A.salaries.id, debit: '900', costCenterId: seed.cc2.id }, { accountId: A.cash.id, credit: '900' }]);
  await closePeriods(s, seed.fy[2024].id);
  const r = ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  assert.equal(r.branches[0].resultSide, 'loss'); assert.equal(r.branches[0].netResult, '600');
  const e = ok(await s.admin.get('/api/year-end/entries/' + r.branches[0].entry.id));
  assert.deepEqual(e.lines.find((l) => l.accountCode === '3201'), { ...e.lines.find((l) => l.accountCode === '3201'), debit: '600', credit: '0', basis: 'result' });
  const y25 = await tb(s, '2025-01-01', '2025-12-31');
  assert.deepEqual(['1101', '2101', '3101', '3201'].map((c) => y25.by[c].opening.net), ['5100', '-700', '-5000', '600']);
  // صفر 2025: إيراد 500 ومصروف 500
  await post(s, seed, '2025-05-01', [{ accountId: A.cash.id, debit: '500' }, { accountId: A.otherRev.id, credit: '500' }]);
  await post(s, seed, '2025-05-02', [{ accountId: A.rent.id, debit: '500' }, { accountId: A.cash.id, credit: '500' }]);
  await closePeriods(s, seed.fy[2025].id);
  const pv = ok(await s.admin.post('/api/year-end/preview', { fiscalYearId: seed.fy[2025].id, branchIds: 'all', operation: 'close' }));
  assert.equal(pv.branches[0].summary.resultSide, 'zero');
  assert.ok(!pv.branches[0].lines.some((l) => l.basis === 'result'));
  const z = ok(await closeYear(s, seed.fy[2025].id, { carryForward: true }));
  assert.equal(z.branches[0].resultSide, 'zero'); assert.equal(z.branches[0].netResult, '0');
  const y26 = await tb(s, '2026-01-01', '2026-12-31');
  assert.equal(y26.by['3201'].opening.net, '600');
  assert.equal(y26.by['4102'] ? y26.by['4102'].opening.net : '0', '0');
  dbChecks(s);
});

test('م4 (4، 19): أرصدة متعددة العملات — العملات والأسعار تُحفظ، والبواقي الأساسية تُمثَّل بلا فقد، والمطابقة لكل عملة', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc; const usd = seed.usd.id; const eur = seed.eur.id;
  const M = (rate) => ({ rate, rateReason: 'سعر البنك الفعلي' });
  await post(s, seed, '2024-01-03', [{ accountId: A.cash.id, debit: '20000' }, { accountId: A.capital.id, credit: '20000' }]);
  // إيراد بالدولار (4850 أساسي) وباليورو
  await post(s, seed, '2024-02-10', [{ accountId: A.bankUsd.id, currencyId: usd, debit: '100' }, { accountId: A.sales.id, currencyId: usd, credit: '100' }]);
  await post(s, seed, '2024-02-11', [{ accountId: A.bankEur.id, currencyId: eur, debit: '50' }, { accountId: A.sales.id, currencyId: eur, credit: '50' }]);
  // حركة دولار بسعرين على الحساب نفسه ⇒ رصيد واحد بسعر مشتق (4845 ÷ 100)
  await post(s, seed, '2024-03-01', [{ accountId: A.bankUsd.id, currencyId: usd, debit: '10' }, { accountId: A.cash.id, credit: '485' }]);
  await post(s, seed, '2024-03-02', [{ accountId: A.bankUsd.id, currencyId: usd, credit: '10', ...M('49') }, { accountId: A.rent.id, debit: '490' }]);
  // فرق عملة محقق بلا رصيد أصلي: دائنون بالدولار 10$ بسعر 48.5 ثم سدادها بسعر 49 ⇒ أصلي 0 وأساسي +5 (باقٍ أساسي)
  await post(s, seed, '2024-03-05', [{ accountId: A.cash.id, debit: '485' }, { accountId: A.payable.id, currencyId: usd, credit: '10' }]);
  await post(s, seed, '2024-03-06', [{ accountId: A.payable.id, currencyId: usd, debit: '10', ...M('49') }, { accountId: A.cash.id, credit: '490' }]);
  // رصيد أجنبي موجب بأساسي سالب: +0.01€ وأساسي -60.4 ⇒ جزء بسعر الجدول + باقٍ أساسي
  const dep = ok(await s.admin.post('/api/accounts', { code: '1104', nameAr: 'وديعة يورو', nameEn: 'EUR deposit', parentId: seed.groups.assets.id }));
  await post(s, seed, '2024-03-03', [{ accountId: dep.id, currencyId: eur, debit: '10' }, { accountId: A.cash.id, credit: '539' }]);
  await post(s, seed, '2024-03-04', [{ accountId: dep.id, currencyId: eur, credit: '9.99', ...M('60') }, { accountId: A.rent.id, debit: '599.4' }]);
  await closePeriods(s, seed.fy[2024].id);
  const pv = ok(await s.admin.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, branchIds: 'all', operation: 'close', carryForward: true }));
  assert.equal(pv.ready, true, JSON.stringify(pv.branches[0].errors));
  const sales = pv.branches[0].lines.filter((l) => l.accountCode === '4101');
  assert.deepEqual(sales.map((l) => [l.currency, l.debitFc, l.debit, l.rate]), [['USD', '100', '4850', '48.5'], ['EUR', '50', '2695', '53.9']]);
  const cf = pv.branches[0].carryForwardLines;
  const at = (code) => cf.filter((l) => l.accountCode === code).map((l) => [l.currency, l.basis, l.debitFc, l.creditFc, l.debit, l.credit, l.rate]);
  assert.deepEqual(at('1102'), [['USD', 'balance', '100', '0', '4845', '0', '48.45']]);
  assert.deepEqual(at('2101'), [['EGP', 'residual', '5', '0', '5', '0', '1']]);
  // 0.01€ × 53.9 (سعر الجدول في نهاية السنة) = 0.539 مدين، والباقي -60.939 دائن ⇒ الصافي الأساسي -60.4 محفوظ بالضبط
  assert.deepEqual(at('1104'), [['EUR', 'split', '0.01', '0', '0.539', '0', '53.9'], ['EGP', 'residual', '0', '60.939', '0', '60.939', '1']]);
  assert.ok(pv.branches[0].carryForward.warnings.some((w) => w.code === 'SPLIT_LINES'));
  ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  // المطابقة: الأصلي لكل عملة أجنبية والأساسي لكل حساب بالضبط
  const rec = ok(await s.admin.get(`/api/year-end/reports/reconciliation?fiscalYearId=${seed.fy[2024].id}`));
  assert.equal(rec.ok, true);
  const row = (code, cur) => rec.branches.find((b) => b.branch.code === 'HQ').rows.find((x) => x.accountCode === code && x.currency === cur);
  assert.deepEqual([row('1102', 'USD').endFc, row('1102', 'USD').carriedFc], ['100', '100']);
  assert.deepEqual([row('1103', 'EUR').endFc, row('1103', 'EUR').carriedFc, row('1103', 'EUR').endBase, row('1103', 'EUR').carriedBase], ['50', '50', '2695', '2695']);
  assert.deepEqual([row('1104', 'EUR').endFc, row('1104', 'EUR').carriedFc, row('1104', 'EUR').residualMoved], ['0.01', '0.01', true]);
  assert.deepEqual([row('2101', 'USD').endBase, row('2101', 'USD').carriedBase, row('2101', 'EGP').carriedBase, row('2101', 'USD').baseMatch], ['5', '0', '5', true]);
  // كشف حساب الدولار بالعملة الأصلية في 2025: الافتتاح 100$ (من الأستاذ، لا من الترحيل)
  const st = ok(await s.admin.get(`/api/ledger/statement?accountId=${A.bankUsd.id}&currencyId=${usd}&from=2025-01-01&to=2025-12-31`));
  assert.equal(st.openingFc.net, '100');
  const tb24 = await tb(s, '2025-01-01', '2025-01-31');
  const cfTotal = ok(await s.admin.get(`/api/year-end/reports/carried?fiscalYearId=${seed.fy[2024].id}`)).totals;
  assert.equal(cfTotal.balanced, true);
  assert.equal(tb24.totals.balanced.all, true);
  dbChecks(s);
});

test('م4 (5، 6): فرعان ومراكز تكلفة — لا اختلاط للأرصدة، والسنة مُقفلة للشركة فقط بعد كل الفروع (P10)', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await post(s, seed, '2024-01-02', [{ accountId: A.cash.id, debit: '1000' }, { accountId: A.capital.id, credit: '1000' }]);
  await post(s, seed, '2024-04-01', [{ accountId: A.cash.id, debit: '300' }, { accountId: A.sales.id, credit: '300' }]);
  await post(s, seed, '2024-04-02', [{ accountId: A.rent.id, debit: '40', costCenterId: seed.cc1.id }, { accountId: A.rent.id, debit: '60', costCenterId: seed.cc2.id }, { accountId: A.cash.id, credit: '100' }]);
  await post(s, seed, '2024-01-02', [{ accountId: A.cash.id, debit: '700' }, { accountId: A.payable.id, credit: '700', costCenterId: seed.cc2.id }], { branch: seed.alx });
  await post(s, seed, '2024-05-01', [{ accountId: A.cash.id, debit: '900' }, { accountId: A.sales.id, credit: '900' }], { branch: seed.alx });
  const ps = await closePeriods(s, seed.fy[2024].id);
  const r = ok(await closeYear(s, seed.fy[2024].id, { branchIds: [seed.hq.id], carryForward: true }));
  assert.equal(r.companyClosed, false); assert.equal(r.branches[0].netResult, '200');
  const st = await statusOf(s, seed.fy[2024].id);
  assert.deepEqual(st.branches.map((b) => [b.branch.code, b.state]), [['ALX', 'open'], ['HQ', 'carried']]);
  // تقارير 2025 غير نهائية ما دام فرع لم يُقفل؛ وقفل آخر فترة ممنوع (P10)
  for (const p of ps.slice(0, 11)) ok(await s.admin.post(`/api/fiscal-periods/${p.id}/lock`, { reason: 'قفل' }));
  assert.equal(E(await s.admin.post(`/api/fiscal-periods/${ps[11].id}/lock`, { reason: 'قفل' })), 'YEAR_NOT_CLOSED_FOR_LOCK');
  assert.ok((await tb(s, '2025-01-01', '2025-12-31')).finality.reasons.some((x) => x.code === 'PRIOR_YEAR_NOT_CLOSED'));
  // مراكز التكلفة محفوظة في قيد الإقفال
  const e = ok(await s.admin.get('/api/year-end/entries/' + r.branches[0].entry.id));
  assert.deepEqual(e.lines.filter((l) => l.accountCode === '6101').map((l) => [l.costCenterCode, l.credit]), [['CC1', '40'], ['CC2', '60']]);
  const a = ok(await closeYear(s, seed.fy[2024].id, { branchIds: [seed.alx.id], carryForward: true }));
  assert.equal(a.companyClosed, true); assert.equal(a.branches[0].netResult, '900');
  assert.equal(a.branches[0].entry.number, 'YC-ALX-FY2024-000001');
  ok(await s.admin.post(`/api/fiscal-periods/${ps[11].id}/lock`, { reason: 'قفل' }));
  // لكل فرع أرصدته: نتيجة HQ 200 ونتيجة ALX 900 في الحساب نفسه بفرعين
  const hq = await tb(s, '2025-01-01', '2025-12-31', `&branch=${seed.hq.id}`);
  const alx = await tb(s, '2025-01-01', '2025-12-31', `&branch=${seed.alx.id}`);
  assert.deepEqual([hq.by['3201'].opening.net, alx.by['3201'].opening.net, hq.by['1101'].opening.net, alx.by['1101'].opening.net], ['-200', '-900', '1200', '1600']);
  assert.equal(alx.by['2101'].opening.net, '-700');
  const cf = ok(await s.admin.get(`/api/year-end/reports/carried?fiscalYearId=${seed.fy[2024].id}&branch=${seed.alx.id}`));
  assert.ok(cf.rows.every((x) => x.branchCode === 'ALX'));
  assert.equal(cf.rows.find((x) => x.accountCode === '2101').costCenterCode, 'CC2');
  assert.deepEqual((await tb(s, '2025-01-01', '2025-12-31')).finality.reasons.map((x) => x.code).filter((c) => c === 'PRIOR_YEAR_NOT_CLOSED'), []);
  dbChecks(s);
});

test('م4 (8): لا سنة تالية — الإقفال مسموح بتحذير، والترحيل خطأ مانع حتى تُنشأ السنة التالية', async (t) => {
  const { s, seed } = await ready(t, { years: [2024] });
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  const withCarry = ok(await s.admin.post('/api/year-end/check', { fiscalYearId: seed.fy[2024].id, operation: 'close', carryForward: true }));
  assert.equal(withCarry.ready, false); assert.ok(withCarry.branches[0].carryForward.errors.some((x) => x.code === 'NEXT_YEAR_MISSING'));
  assert.equal(E(await closeYear(s, seed.fy[2024].id, { carryForward: true }).catch((e) => ({ body: { error: { code: e.message } } }))), 'NOT_READY');
  const pv = ok(await s.admin.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, operation: 'close' }));
  assert.ok(pv.branches[0].warnings.some((w) => w.code === 'NEXT_YEAR_MISSING'));
  // تحذير بلا إقرار ⇒ مرفوض
  assert.equal(E(await s.admin.post('/api/year-end/close', { fiscalYearId: seed.fy[2024].id, fingerprint: pv.fingerprint, idempotencyKey: key(), confirm: true })), 'WARNINGS_NOT_ACKNOWLEDGED');
  ok(await closeYear(s, seed.fy[2024].id));
  assert.equal((await statusOf(s, seed.fy[2024].id)).branches.find((b) => b.branch.code === 'HQ').state, 'closed_no_next_year');
  const c = ok(await s.admin.post('/api/year-end/check', { fiscalYearId: seed.fy[2024].id, operation: 'carry_forward' }));
  assert.ok(c.branches[0].errors.some((x) => x.code === 'NEXT_YEAR_MISSING'));
  ok(await s.admin.post('/api/fiscal-years', { code: 'FY2025', nameAr: '2025', nameEn: '2025', startDate: '2025-01-01', endDate: '2025-12-31', periodType: 'quarterly' }));
  const cr = ok(await carryYear(s, seed.fy[2024].id));
  assert.equal(cr.branches[0].entry.number, 'CF-HQ-FY2025-000001');
  dbChecks(s);
});

test('م4 (9): أخطاء مانعة — فترات مفتوحة، مسودات، مشكلة سلامة، حساب نتيجة غير صالح، سنة لم تنتهِ، سنة سابقة غير مُقفلة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedYears(s);
  await profitYear(s, seed);
  const codes = async (yearId, op = 'close', client = s.admin) => ok(await client.post('/api/year-end/check', { fiscalYearId: yearId, operation: op })).branches[0].errors.map((x) => x.code);
  let c = await codes(seed.fy[2024].id);
  assert.ok(c.includes('PERIODS_OPEN') && c.includes('RE_ACCOUNT_NOT_SET'), c.join());
  // حساب نتيجة غير صالح: ليس حقوق ملكية / حساب مراقبة
  assert.equal(E(await s.admin.put('/api/year-end/settings', { retainedEarningsAccountId: seed.acc.cash.id })), 'RE_ACCOUNT_INVALID');
  ok(await s.admin.put('/api/accounts/' + seed.acc.capital.id, { allowManualEntry: false }));
  assert.deepEqual((await s.admin.put('/api/year-end/settings', { retainedEarningsAccountId: seed.acc.capital.id })).body.error.details.reasons, ['CONTROL_ACCOUNT']);
  await setRetained(s, seed);
  // حساب النتيجة صالح لكن تحذير النوع إن لم يكن «أرباح محتجزة» يظهر في الإعداد فقط عند الحاجة
  await s.admin.post('/api/journal', { branchId: seed.hq.id, entryDate: '2024-12-20', description: 'مسودة', lines: [{ accountId: seed.acc.cash.id, debit: '1' }, { accountId: seed.acc.sales.id, credit: '1' }] }).then(ok);
  await closePeriods(s, seed.fy[2024].id);
  c = await codes(seed.fy[2024].id);
  assert.deepEqual(c, ['DRAFTS_EXIST']);
  const d = s.app.db.prepare("SELECT id FROM journal_entries WHERE status = 'draft'").get();
  // مشكلة سلامة: مسودة عكسية في القاعدة (لا تنشأ إلا خطأً) — ومستخدم فرع يرى العدد فقط
  const orig = s.app.db.prepare("SELECT id FROM journal_entries WHERE status = 'posted' LIMIT 1").get().id;
  s.app.db.prepare(`INSERT INTO journal_entries (branch_id, entry_type, entry_date, series_id, default_currency_id, description, created_by, updated_by, reverses_id, reason)
    VALUES (?, 'reversal', '2025-06-01', 1, ?, 'x', 1, 1, ?, 'خطأ')`).run(seed.alx.id, seed.egp.id, orig);
  c = await codes(seed.fy[2024].id);
  assert.ok(c.includes('LEDGER_INTEGRITY'));
  const u = await makeUser(s, { username: 'hqcheck', permissions: ['year_end.view', 'year_end.check'], branchIds: [seed.hq.id] });
  const li = ok(await u.client.post('/api/year-end/check', { fiscalYearId: seed.fy[2024].id, operation: 'close' })).branches[0].errors.find((x) => x.code === 'LEDGER_INTEGRITY');
  assert.equal(li.details, undefined); assert.ok(li.problems >= 1);
  s.app.db.prepare("DELETE FROM journal_entries WHERE entry_type = 'reversal' AND status = 'draft'").run();
  // التنفيذ يرفض في الخادم ولو أُرسلت بصمة صحيحة
  const pv = ok(await s.admin.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, operation: 'close' }));
  const r = await s.admin.post('/api/year-end/close', { fiscalYearId: seed.fy[2024].id, fingerprint: pv.fingerprint, idempotencyKey: key(), acknowledgeWarnings: true, confirm: true });
  assert.equal(E(r), 'NOT_READY'); assert.equal(r.body.error.details.branches[0].errors[0].code, 'DRAFTS_EXIST');
  ok(await s.admin.del('/api/journal/' + d.id));
  // سنة لم تنتهِ (2026) وسنة سابقة غير مُقفلة (2025 قبل 2024)
  c = await codes(seed.fy[2025].id);
  assert.ok(c.includes('PREVIOUS_YEAR_NOT_CLOSED'));
  c = await codes(seed.fy[2026].id);
  assert.ok(c.includes('YEAR_NOT_ENDED'));
  // بلا تأكيد صريح ⇒ مرفوض؛ بصمة قديمة ⇒ مرفوض
  assert.equal(E(await s.admin.post('/api/year-end/close', { fiscalYearId: seed.fy[2024].id, fingerprint: pv.fingerprint, idempotencyKey: key(), acknowledgeWarnings: true })), 'CONFIRM_REQUIRED');
  // البصمة تغطي السطور المحسوبة: حركة جديدة بعد المعاينة ⇒ PREVIEW_STALE
  const dec = ok(await s.admin.get('/api/fiscal-years/' + seed.fy[2024].id)).periods[11];
  ok(await s.admin.post(`/api/fiscal-periods/${dec.id}/reopen`, { reason: 'قيد متأخر', confirm: true }));
  await post(s, seed, '2024-12-30', [{ accountId: seed.acc.cash.id, debit: '7' }, { accountId: seed.acc.sales.id, credit: '7' }]);
  ok(await s.admin.post(`/api/fiscal-periods/${dec.id}/close`, { reason: 'إغلاق' }));
  assert.equal(E(await s.admin.post('/api/year-end/close', { fiscalYearId: seed.fy[2024].id, fingerprint: pv.fingerprint, idempotencyKey: key(), acknowledgeWarnings: true, confirm: true })), 'PREVIEW_STALE');
  ok(await closeYear(s, seed.fy[2024].id));
  dbChecks(s);
});

test('م4 (10): إعادة الطلب بالمفتاح نفسه تعيد النتيجة نفسها، ومفتاح جديد لا يكرر الإقفال ولا الترحيل', async (t) => {
  const { s, seed } = await ready(t);
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  const k = key();
  const r1 = ok(await closeYear(s, seed.fy[2024].id, { idempotencyKey: k }));
  const before = counts(s);
  // إعادة إرسال الطلب نفسه (انقطاع بعد الحفظ): لا كتابة جديدة
  const r2 = ok(await s.admin.post('/api/year-end/close', { fiscalYearId: seed.fy[2024].id, branchIds: 'all', fingerprint: 'x'.repeat(64), idempotencyKey: k, acknowledgeWarnings: true, confirm: true }));
  assert.equal(r2.replayed, true); assert.deepEqual(r2.branches, r1.branches);
  assert.deepEqual(counts(s), before);
  // مفتاح جديد ⇒ ALREADY_CLOSED (مانع)
  const pv = ok(await s.admin.post('/api/year-end/check', { fiscalYearId: seed.fy[2024].id, operation: 'close' }));
  assert.ok(pv.branches[0].errors.some((x) => x.code === 'ALREADY_CLOSED'));
  assert.equal(E(await closeYear(s, seed.fy[2024].id)), 'NOT_READY');
  // مفتاح مستخدم لعملية أخرى ⇒ مرفوض
  assert.equal(E(await carryYear(s, seed.fy[2024].id, { idempotencyKey: k })), 'IDEMPOTENCY_KEY_REUSED');
  const ck = key();
  ok(await carryYear(s, seed.fy[2024].id, { idempotencyKey: ck }));
  const c2 = counts(s);
  assert.equal(ok(await s.admin.post('/api/year-end/carry-forward', { fiscalYearId: seed.fy[2024].id, fingerprint: 'y'.repeat(64), idempotencyKey: ck, confirm: true })).replayed, true);
  assert.equal(E(await carryYear(s, seed.fy[2024].id)), 'NOT_READY');
  assert.deepEqual(counts(s), c2);
  // القاعدة نفسها تمنع عملية نشطة ثانية
  assert.throws(() => s.app.db.prepare("INSERT INTO year_closings (fiscal_year_id, branch_id, retained_earnings_account_id, closing_date, result_side, net_result, summary, readiness, fingerprint, created_by) VALUES (?, ?, ?, '2024-12-31', 'zero', '0', '{}', '{}', ?, 1)")
    .run(seed.fy[2024].id, seed.hq.id, seed.acc.retained.id, 'a'.repeat(64)), /UNIQUE/);
  dbChecks(s);
});

test('م4 (11): فشل متعمد في منتصف العملية ⇒ لا شيء يُحفظ (لا عملية، لا مستند، لا أستاذ، لا رقم)، ثم تنجح العملية نفسها', async (t) => {
  const { s, seed } = await ready(t);
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  const before = counts(s);
  const audit = s.app.services.audit;
  const orig = audit.fromCtx;
  // الفشل بعد ترحيل قيد الإقفال وقيد الترحيل (عند آخر تسجيل تدقيق قبل حفظ مفتاح الطلب)
  audit.fromCtx = (ctx, e) => { if (e.action === 'year_end.carried_forward') throw new Error('فشل متعمد'); return orig.call(audit, ctx, e); };
  const k = key();
  const r = await closeYear(s, seed.fy[2024].id, { carryForward: true, idempotencyKey: k });
  audit.fromCtx = orig;
  assert.equal(r.status, 500);
  assert.deepEqual(counts(s), before);
  assert.equal(s.app.db.prepare("SELECT count(*) n FROM gl_entries WHERE source_type <> 'journal'").get().n, 0);
  // المفتاح نفسه بعد الفشل ينفّذ فعلًا (لم يُحفظ شيء)، والأرقام لم تُستهلك
  const ok2 = ok(await closeYear(s, seed.fy[2024].id, { carryForward: true, idempotencyKey: k }));
  assert.equal(ok2.branches[0].entry.number, 'YC-HQ-FY2024-000001');
  assert.equal(ok2.branches[0].carryForward.entry.number, 'CF-HQ-FY2025-000001');
  dbChecks(s);
});

async function runWorkers(argsList) {
  const kids = argsList.map((a) => fork(path.join(__dirname, 'workers', 'http-worker.js'), a.map(String), { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  await Promise.all(kids.map((k) => new Promise((res, rej) => { k.once('message', (m) => (m.fatal ? rej(new Error(m.fatal)) : res())); k.once('error', rej); })));
  const done = kids.map((k) => new Promise((res, rej) => { let got = null; k.on('message', (m) => { got = m; }); k.once('exit', (c) => (c === 0 && got && !got.fatal ? res(got) : rej(new Error(got && got.fatal || 'exit ' + c)))); }));
  for (const k of kids) k.send('go');
  return Promise.all(done);
}

test('م4 (12، 13): طلبان متزامنان من عمليتين منفصلتين لإقفال السنة نفسها ثم لترحيلها ⇒ عملية واحدة فقط', { timeout: 120000 }, async (t) => {
  const { s, seed } = await ready(t);
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  const pv = ok(await s.admin.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, operation: 'close' }));
  const { cookie } = s.admin.state; const { csrf } = s.admin.state;
  const body = (k) => JSON.stringify({ path: '/api/year-end/close', body: { fiscalYearId: seed.fy[2024].id, branchIds: 'all', fingerprint: pv.fingerprint, idempotencyKey: k, acknowledgeWarnings: true, confirm: true } });
  let out = await runWorkers([1, 2].map((i) => [s.dir, 'request', body('w' + i + '-' + key()), cookie, csrf]));
  let res = out.map((o) => o.results[0]);
  assert.equal(res.filter((x) => x.status === 200).length, 1, JSON.stringify(res));
  assert.ok(res.some((x) => x.code === 'NOT_READY' || x.code === 'PREVIEW_STALE'), JSON.stringify(res));
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM year_closings').get().n, 1);
  const cp = ok(await s.admin.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, operation: 'carry_forward' }));
  const cbody = (k) => JSON.stringify({ path: '/api/year-end/carry-forward', body: { fiscalYearId: seed.fy[2024].id, branchIds: 'all', fingerprint: cp.fingerprint, idempotencyKey: k, acknowledgeWarnings: true, confirm: true } });
  out = await runWorkers([1, 2, 3].map((i) => [s.dir, 'request', cbody('c' + i + '-' + key()), cookie, csrf]));
  res = out.map((o) => o.results[0]);
  assert.equal(res.filter((x) => x.status === 200).length, 1, JSON.stringify(res));
  assert.equal(s.app.db.prepare('SELECT count(*) n FROM carry_forwards').get().n, 1);
  assert.equal(s.app.db.prepare("SELECT count(*) n FROM year_end_entries WHERE kind = 'carry_forward'").get().n, 1);
  dbChecks(s);
});

test('م4 (14): السنة المُقفلة محمية — لا مسودة ولا ترحيل ولا عكس بتاريخها، ولا سنة سابقة لها، والقاعدة ترفض الالتفاف', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await profitYear(s, seed);
  const e = await post(s, seed, '2024-07-01', [{ accountId: A.cash.id, debit: '50' }, { accountId: A.sales.id, credit: '50' }]);
  const dr = ok(await s.admin.post('/api/journal', { branchId: seed.hq.id, entryDate: '2025-02-01', description: 'مسودة', lines: [{ accountId: A.cash.id, debit: '5' }, { accountId: A.sales.id, credit: '5' }] }));
  await closePeriods(s, seed.fy[2024].id);
  ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  const L = [{ accountId: A.cash.id, debit: '1' }, { accountId: A.sales.id, credit: '1' }];
  ok(await s.admin.post(`/api/fiscal-periods/${(await closePeriods(s, seed.fy[2024].id).then((ps) => ps[11])).id}/reopen`, { reason: 'إعادة فتح للفحص', confirm: true }));
  assert.equal(E(await s.admin.post('/api/journal', { branchId: seed.hq.id, entryDate: '2024-12-15', description: 'x', lines: L })), 'YEAR_CLOSED');
  assert.equal(E(await s.admin.put('/api/journal/' + dr.id, { branchId: seed.hq.id, entryDate: '2024-12-15', description: 'x', lines: L })), 'YEAR_CLOSED');
  assert.equal(E(await s.admin.post(`/api/journal/${e.id}/reverse`, { reason: 'تصحيح', date: '2024-12-20' })), 'YEAR_CLOSED');
  const rv = ok(await s.admin.post(`/api/journal/${e.id}/reverse`, { reason: 'تصحيح في السنة الجديدة', date: '2025-01-10' }));
  assert.equal(rv.status, 'posted');
  // تعديل/حذف القيد المرحّل ومستندات الإقفال وسجل العمليات ممنوع في القاعدة
  const db = s.app.db;
  assert.throws(() => db.prepare("UPDATE journal_entries SET description = 'x' WHERE id = ?").run(e.id), /cannot be modified/);
  assert.throws(() => db.prepare('DELETE FROM gl_entries WHERE source_id = ?').run(e.id), /append-only/);
  assert.throws(() => db.prepare("UPDATE year_end_entries SET description = 'x'").run(), /cannot be modified|identity is fixed/);
  assert.throws(() => db.prepare('DELETE FROM year_end_entries').run(), /cannot be deleted/);
  assert.throws(() => db.prepare('UPDATE year_end_lines SET debit = debit').run(), /cannot be changed/);
  assert.throws(() => db.prepare('DELETE FROM year_closings').run(), /history is kept/);
  assert.throws(() => db.prepare("UPDATE year_closings SET net_result = '1'").run(), /fixed/);
  assert.throws(() => db.prepare('DELETE FROM carry_forwards').run(), /history is kept/);
  // ترحيل مسودة بتاريخ السنة المُقفلة مباشرة في القاعدة (تجاوز الخادم) ⇒ مرفوض
  db.prepare("UPDATE journal_entries SET entry_date = '2024-12-15' WHERE id = ?").run(dr.id);
  assert.throws(() => db.prepare("UPDATE journal_entries SET status = 'posted', number = 'X-1', fiscal_period_id = (SELECT id FROM fiscal_periods WHERE start_date = '2024-12-01'), decimal_snapshot = '{}', posted_by = 1, posted_at = 'x', total_base = '5' WHERE id = ?").run(dr.id), /closed for this branch/);
  // فرع بلا تاريخ قبل السنة: إقفال 2025 لـ ALX يمنع الترحيل بتاريخ 2024 أيضًا
  await post(s, seed, '2025-03-01', [{ accountId: A.cash.id, debit: '10' }, { accountId: A.capital.id, credit: '10' }], { branch: seed.alx });
  await closePeriods(s, seed.fy[2025].id);
  ok(await closeYear(s, seed.fy[2025].id, { branchIds: [seed.alx.id] }));
  assert.equal(E(await s.admin.post('/api/journal', { branchId: seed.alx.id, entryDate: '2024-12-15', description: 'x', lines: L })), 'YEAR_CLOSED');
  dbChecks(s);
});

test('م4 (15): الصلاحيات ونطاق الفروع في الخادم لكل إجراء', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await profitYear(s, seed);
  await post(s, seed, '2024-02-01', [{ accountId: A.cash.id, debit: '100' }, { accountId: A.sales.id, credit: '100' }], { branch: seed.alx });
  await closePeriods(s, seed.fy[2024].id);
  const viewer = await makeUser(s, { username: 'yeview', permissions: ['year_end.view', 'year_end.check', 'year_end.preview'], allBranches: true });
  const pv = ok(await viewer.client.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, operation: 'close' }));
  assert.equal(pv.canExecute, false);
  assert.equal((await viewer.client.post('/api/year-end/close', { fiscalYearId: seed.fy[2024].id, fingerprint: pv.fingerprint, idempotencyKey: key(), confirm: true })).status, 403);
  assert.equal((await viewer.client.put('/api/year-end/settings', { retainedEarningsAccountId: A.retained.id })).status, 403);
  assert.equal((await viewer.client.get(`/api/year-end/reports/result/export.xlsx?fiscalYearId=${seed.fy[2024].id}`)).status, 403);
  const noView = await makeUser(s, { username: 'yenone', permissions: ['ledger.view'], allBranches: true });
  assert.equal((await noView.client.get('/api/year-end/status?fiscalYearId=' + seed.fy[2024].id)).status, 403);
  assert.equal((await noView.client.post('/api/year-end/check', { fiscalYearId: seed.fy[2024].id })).status, 403);
  // مستخدم فرع ALX: يُقفل فرعه فقط، ولا يرى HQ
  const alx = await makeUser(s, { username: 'alxclose', permissions: ['year_end.view', 'year_end.check', 'year_end.preview', 'year_end.close', 'year_end.carry_forward'], branchIds: [seed.alx.id] });
  assert.equal(E(await alx.client.post('/api/year-end/preview', { fiscalYearId: seed.fy[2024].id, operation: 'close', branchIds: [seed.hq.id] })), 'BRANCH_FORBIDDEN');
  const st = await statusOf(s, seed.fy[2024].id, alx.client);
  assert.deepEqual(st.branches.map((b) => b.branch.code), ['ALX']);
  const r = ok(await closeYear(s, seed.fy[2024].id, { client: alx.client, carryForward: true }));
  assert.deepEqual(r.branches.map((b) => b.branchId), [seed.alx.id]);
  const hq = ok(await closeYear(s, seed.fy[2024].id, { branchIds: [seed.hq.id] }));
  assert.equal((await alx.client.get('/api/year-end/entries/' + hq.branches[0].entry.id)).status, 404);
  const rep = ok(await alx.client.get(`/api/year-end/reports/entries?fiscalYearId=${seed.fy[2024].id}`));
  assert.ok(rep.items.every((x) => x.branchCode === 'ALX'));
  assert.equal((await alx.client.get(`/api/year-end/reports/result?fiscalYearId=${seed.fy[2024].id}&branch=${seed.hq.id}`)).status, 403);
  // إعادة الفتح: صلاحية مستقلة؛ وإلغاء الترحيل معها صلاحية أخرى
  const re = await makeUser(s, { username: 'yereopen', permissions: ['year_end.view', 'year_end.reopen'], allBranches: true });
  assert.equal((await alx.client.post('/api/year-end/reopen', { fiscalYearId: seed.fy[2024].id, branchId: seed.alx.id, reason: 'تصحيح', idempotencyKey: key(), confirm: true })).status, 403);
  assert.equal(E(await re.client.post('/api/year-end/reopen', { fiscalYearId: seed.fy[2024].id, branchId: seed.alx.id, reason: 'تصحيح', includeCarryForward: true, idempotencyKey: key(), confirm: true })), 'FORBIDDEN');
  assert.equal(E(await re.client.post('/api/year-end/reopen', { fiscalYearId: seed.fy[2024].id, branchId: seed.alx.id, reason: 'تصحيح', idempotencyKey: key(), confirm: true })), 'CARRY_FORWARD_ACTIVE');
  assert.equal(E(await re.client.post('/api/year-end/reopen', { fiscalYearId: seed.fy[2024].id, branchId: seed.hq.id, reason: 'تصحيح', idempotencyKey: key() })), 'CONFIRM_REQUIRED');
  ok(await re.client.post('/api/year-end/reopen', { fiscalYearId: seed.fy[2024].id, branchId: seed.hq.id, reason: 'تصحيح الإيجار', idempotencyKey: key(), confirm: true }));
  // صلاحيتا إعادة الفتح وإلغاء الترحيل لا يمنحهما إلا المدير العام
  const perms = ok(await s.admin.get('/api/permissions')).resources.find((x) => x.resource === 'year_end');
  assert.deepEqual([...perms.superOnlyGrant].sort(), ['reopen', 'revert_carry_forward']);
  dbChecks(s);
});

test('م4 (16): إعادة فتح سنة لسنتها التالية حركات ⇒ تأكيد صريح؛ أرصدة السنة التالية لا تتغير، ثم يُعاد الإقفال والترحيل', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  await post(s, seed, '2025-02-01', [{ accountId: A.cash.id, debit: '70' }, { accountId: A.sales.id, credit: '70' }]);
  const tb25 = await tb(s, '2025-01-01', '2025-12-31');
  const body = { fiscalYearId: seed.fy[2024].id, branchId: seed.hq.id, reason: 'تصحيح بعد المراجعة', includeCarryForward: true, confirm: true };
  const r = await s.admin.post('/api/year-end/reopen', { ...body, idempotencyKey: key() });
  assert.equal(E(r), 'NEXT_YEAR_HAS_ACTIVITY'); assert.equal(r.body.error.details.entries, 1);
  const ro = ok(await s.admin.post('/api/year-end/reopen', { ...body, confirmNextYearActivity: true, idempotencyKey: key() }));
  assert.equal(ro.reversal.number, 'YCR-HQ-FY2024-000001'); assert.equal(ro.carryForward.reversal.number, 'CFR-HQ-FY2025-000001');
  // أرصدة 2025 لم تتغير بإلغاء الترحيل (تُحسب من الأستاذ)، أما نتيجة 2024 فعادت إلى الإيرادات
  const after = await tb(s, '2025-01-01', '2025-12-31');
  assert.equal(after.by['1101'].closing.net, tb25.by['1101'].closing.net);
  assert.equal(after.by['3201'] ? after.by['3201'].opening.net : '0', '0');
  assert.equal(after.by['4101'].opening.net, '-5000');
  assert.equal((await statusOf(s, seed.fy[2024].id)).branches.find((b) => b.branch.code === 'HQ').state, 'open');
  ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  const rec = ok(await s.admin.get(`/api/year-end/reports/reconciliation?fiscalYearId=${seed.fy[2024].id}`));
  assert.equal(rec.ok, true);
  dbChecks(s);
});

test('م4 (17): لا إعادة فتح لسنة سنتها التالية مُقفلة (الأحدث أولًا)، ولا مع قفل نهائي لآخر فترة', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  await post(s, seed, '2025-02-01', [{ accountId: A.cash.id, debit: '70' }, { accountId: A.sales.id, credit: '70' }]);
  await closePeriods(s, seed.fy[2025].id);
  ok(await closeYear(s, seed.fy[2025].id, { carryForward: true }));
  const body = (y) => ({ fiscalYearId: y, branchId: seed.hq.id, reason: 'تصحيح', includeCarryForward: true, confirmNextYearActivity: true, idempotencyKey: key(), confirm: true });
  assert.equal(E(await s.admin.post('/api/year-end/reopen', body(seed.fy[2024].id))), 'NEXT_YEAR_CLOSED');
  assert.equal(E(await s.admin.post('/api/year-end/revert-carry-forward', body(seed.fy[2024].id))), 'NEXT_YEAR_CLOSED');
  // القاعدة نفسها: لا إلغاء لإقفال 2024 والترحيل منها نشط أو 2025 مُقفلة
  assert.throws(() => s.app.db.prepare("UPDATE year_closings SET status = 'reverted', reverted_by = 1, reverted_at = 'x', revert_reason = 'xxx' WHERE fiscal_year_id = ?").run(seed.fy[2024].id), /carry-forward of this year first|next fiscal year is closed/);
  ok(await s.admin.post('/api/year-end/reopen', body(seed.fy[2025].id)));
  ok(await s.admin.post('/api/year-end/reopen', body(seed.fy[2024].id)));
  // قفل آخر فترة نهائيًا بعد الإقفال يمنع إعادة الفتح للأبد (القفل نهائي)
  ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  const ps = ok(await s.admin.get('/api/fiscal-years/' + seed.fy[2024].id)).periods;
  for (const p of ps) ok(await s.admin.post(`/api/fiscal-periods/${p.id}/lock`, { reason: 'قفل نهائي' }));
  assert.equal(E(await s.admin.post('/api/year-end/reopen', body(seed.fy[2024].id))), 'PERIOD_LOCKED');
  assert.deepEqual((await tb(s, '2024-01-01', '2024-12-31')).finality, { final: true, reasons: [] });
  dbChecks(s);
});

test('م4 (18): تصحيح الإقفال وإعادة تنفيذه — السجل والتدقيق محفوظان، والأرقام لا يُعاد استخدامها', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await profitYear(s, seed);
  const ps = await closePeriods(s, seed.fy[2024].id);
  const first = ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  ok(await s.admin.post('/api/year-end/reopen', { fiscalYearId: seed.fy[2024].id, branchId: seed.hq.id, reason: 'إيجار ديسمبر لم يُسجَّل', includeCarryForward: true, idempotencyKey: key(), confirm: true }));
  ok(await s.admin.post(`/api/fiscal-periods/${ps[11].id}/reopen`, { reason: 'تسجيل التصحيح', confirm: true }));
  await post(s, seed, '2024-12-31', [{ accountId: A.rent.id, debit: '300', costCenterId: seed.cc1.id }, { accountId: A.cash.id, credit: '300' }]);
  ok(await s.admin.post(`/api/fiscal-periods/${ps[11].id}/close`, { reason: 'إغلاق بعد التصحيح' }));
  const second = ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  assert.equal(first.branches[0].entry.number, 'YC-HQ-FY2024-000001');
  assert.equal(second.branches[0].entry.number, 'YC-HQ-FY2024-000002');
  assert.equal(second.branches[0].carryForward.entry.number, 'CF-HQ-FY2025-000002');
  assert.equal(second.branches[0].netResult, '3500');
  const hist = ok(await s.admin.get('/api/year-end/history?fiscalYearId=' + seed.fy[2024].id));
  assert.deepEqual(hist.map((h) => [h.type, h.status]).sort(), [['carry_forward', 'active'], ['carry_forward', 'reverted'], ['closing', 'active'], ['closing', 'reverted']]);
  const reverted = hist.find((h) => h.type === 'closing' && h.status === 'reverted');
  assert.equal(reverted.revertReason, 'إيجار ديسمبر لم يُسجَّل'); assert.equal(reverted.reversal.number, 'YCR-HQ-FY2024-000001');
  const acts = s.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'year_end.%' ORDER BY id").all().map((x) => x.action);
  assert.deepEqual(acts, ['year_end.settings_updated', 'year_end.closed', 'year_end.carried_forward', 'year_end.carry_forward_reverted', 'year_end.reopened', 'year_end.closed', 'year_end.carried_forward']);
  assert.equal(s.app.db.prepare('SELECT count(DISTINCT number) n, count(*) c FROM issued_numbers').get().n, s.app.db.prepare('SELECT count(*) c FROM issued_numbers').get().c);
  const y25 = await tb(s, '2025-01-01', '2025-12-31');
  assert.equal(y25.by['3201'].opening.net, '-3500'); assert.equal(y25.by['1101'].opening.net, '13500');
  dbChecks(s);
});

test('م4 (23): لا مسار كتابة بديل للأستاذ — المصدر الوحيد ledger.post، والقاعدة ترفض أي سطر لا يطابق مستندًا مرحّلًا', async (t) => {
  const ROOT = path.join(__dirname, '..');
  const files = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((x) => (x.isDirectory() ? files(path.join(d, x.name)) : x.name.endsWith('.js') ? [path.join(d, x.name)] : []));
  const writers = files(path.join(ROOT, 'server')).filter((f) => /INSERT\s+INTO\s+gl_entries/i.test(fs.readFileSync(f, 'utf8')));
  assert.deepEqual(writers.map((f) => path.relative(ROOT, f)), [path.join('server', 'modules', 'journal', 'ledger.js')]);
  const { s, seed } = await ready(t);
  await profitYear(s, seed);
  await closePeriods(s, seed.fy[2024].id);
  const r = ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  const db = s.app.db;
  const g = db.prepare("SELECT * FROM gl_entries WHERE source_type = 'year_closing' LIMIT 1").get();
  const ins = (o) => db.prepare(`INSERT INTO gl_entries (source_type, source_id, source_line_id, doc_number, entry_kind, posting_date, fiscal_period_id, fiscal_year_id, branch_id, account_id,
    cost_center_id, currency_id, rate, rate_source, debit_fc, credit_fc, debit, credit, posted_by, posted_at) VALUES (@source_type, @source_id, @source_line_id, @doc_number, @entry_kind,
    @posting_date, @fiscal_period_id, @fiscal_year_id, @branch_id, @account_id, @cost_center_id, @currency_id, @rate, @rate_source, @debit_fc, @credit_fc, @debit, @credit, @posted_by, @posted_at)`).run({ ...g, ...o });
  assert.throws(() => ins({ debit: g.debit === '0' ? '0' : '1', credit: g.credit === '0' ? '0' : '1', debit_fc: g.debit_fc === '0' ? '0' : '1', credit_fc: g.credit_fc === '0' ? '0' : '1' }), /must match a line of the posted year-end entry/);
  assert.throws(() => ins({ source_type: 'manual_hack' }), /unknown ledger source/);
  assert.throws(() => ins({ source_type: 'journal', entry_kind: 'closing' }), /closing entries come from the year-end closing only/);
  // مستند إقفال بلا عملية نشطة ⇒ مرفوض
  assert.throws(() => db.prepare("INSERT INTO year_end_entries (kind, closing_id, closing_year_id, fiscal_year_id, branch_id, entry_date, series_id, description, created_by) VALUES ('closing', 999, ?, ?, ?, '2024-12-31', 1, 'x', 1)")
    .run(seed.fy[2024].id, seed.fy[2024].id, seed.hq.id), /belongs to an active closing/);
  assert.throws(() => db.prepare("INSERT INTO year_end_entries (kind, closing_id, closing_year_id, fiscal_year_id, branch_id, entry_date, series_id, description, created_by) VALUES ('closing', ?, ?, ?, ?, '2024-12-31', 1, 'x', 1)")
    .run(r.branches[0].closingId, seed.fy[2024].id, seed.fy[2024].id, seed.hq.id), /one original entry/);
  // الخدمة نفسها: قيد إقفال لا يمر من المحرك إلا بأصل النظام
  const ctx = { user: { id: 1, username: 'admin' }, ip: '127.0.0.1', requestId: 't', access: { allBranches: true, can: () => true, assertBranch() {}, branchAllowed: () => true } };
  assert.throws(() => s.app.services.ledger.post(ctx, { origin: 'manual', entryKind: 'closing', lines: [] }), (e) => e.code === 'ENTRY_TYPE_NOT_SUPPORTED');
  dbChecks(s);
});

test('م4: حساب النتيجة لا يتغير والسنة مُقفلة جزئيًا (الخادم والقاعدة)، والإقفال يحفظ لقطته', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await profitYear(s, seed);
  await post(s, seed, '2024-02-01', [{ accountId: A.cash.id, debit: '100' }, { accountId: A.sales.id, credit: '100' }], { branch: seed.alx });
  await closePeriods(s, seed.fy[2024].id);
  ok(await closeYear(s, seed.fy[2024].id, { branchIds: [seed.hq.id] }));
  const other = ok(await s.admin.post('/api/accounts', { code: '3202', nameAr: 'نتائج مرحلة', nameEn: 'Carried results', parentId: seed.groups.equity.id }));
  assert.equal(E(await s.admin.put('/api/year-end/settings', { retainedEarningsAccountId: other.id })), 'CLOSING_IN_PROGRESS');
  assert.throws(() => s.app.db.prepare('UPDATE year_end_settings SET retained_earnings_account_id = ?').run(other.id), /partially closed/);
  assert.deepEqual(ok(await s.admin.get('/api/year-end/settings')).lockedBy, ['FY2024']);
  ok(await closeYear(s, seed.fy[2024].id, { branchIds: [seed.alx.id] }));
  const st = ok(await s.admin.put('/api/year-end/settings', { retainedEarningsAccountId: other.id }));
  assert.ok(st.warnings.some((w) => w.code === 'RE_ACCOUNT_TYPE'));
  // إقفالات 2024 تبقى بلقطة حسابها الأصلي
  assert.ok((await statusOf(s, seed.fy[2024].id)).branches.every((b) => b.closing.retainedEarningsAccount.code === '3201'));
  // الحساب المستخدم في الإعداد لا يُحذف
  assert.equal((await s.admin.del('/api/accounts/' + other.id)).status, 409);
});

test('م4: سنة بلا حركات تُقفل صراحة (لكل الفروع النشطة) فتزول عنها تحذيرات P9، ولا تُحذف بعد إقفالها', async (t) => {
  const { s, seed } = await ready(t, { years: [2024, 2025] });
  const st0 = ok(await s.admin.get('/api/ledger/status'));
  assert.ok(st0.warnings.some((w) => w.year.code === 'FY2024'));
  await closePeriods(s, seed.fy[2025].id);
  await closePeriods(s, seed.fy[2024].id);
  const r = ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  assert.deepEqual(r.branches.map((b) => [b.entry, b.carryForward.entry]), [[null, null], [null, null]]);
  assert.equal(r.companyClosed, true);
  assert.ok(!ok(await s.admin.get('/api/ledger/status')).warnings.some((w) => w.year.code === 'FY2024'));
  assert.equal(E(await s.admin.del('/api/fiscal-years/' + seed.fy[2025].id)), 'FISCAL_YEAR_NOT_OPEN');
  for (const p of ok(await s.admin.get('/api/fiscal-years/' + seed.fy[2025].id)).periods) ok(await s.admin.post(`/api/fiscal-periods/${p.id}/reopen`, { reason: 'إعادة فتح' }));
  assert.equal(E(await s.admin.del('/api/fiscal-years/' + seed.fy[2025].id)), 'IN_USE');
  dbChecks(s);
});

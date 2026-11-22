'use strict';
/* المرحلة 5: القوائم المالية — على قاعدة SQLite حقيقية مؤقتة عبر HTTP (لا mocks إلا حيث يُختبر منع الإصدار عند عدم المطابقة). */
const test = require('node:test');
const assert = require('node:assert/strict');
const { startReady, makeUser } = require('./helpers');
const { ok } = require('./ledger-helpers');
const { post, closePeriods, closeYear, key } = require('./year-end-helpers');
const { seedFs, profit2024 } = require('./fs-helpers');
const { readSheet } = require('../server/core/xlsx');

const E = (r) => (r.body && r.body.error ? r.body.error.code : `HTTP ${r.status}`);
const V = (x, i = 0) => x.values[i].value;
const line = (r, k) => r.lines.find((l) => l.key === k);
const acc = (r, code) => r.lines.flatMap((l) => l.rows || []).find((a) => a.code === code);
const bsAcc = (r, code) => r.sections.flatMap((s) => s.groups.flatMap((g) => g.rows)).find((a) => a.code === code);
const cfAcc = (r, code) => r.sections.flatMap((s) => s.rows).find((a) => a.code === code);
const IS = (s, q, c = s.admin) => c.get('/api/financial-statements/income-statement?' + q);
const BS = (s, q, c = s.admin) => c.get('/api/financial-statements/balance-sheet?' + q);
const CF = (s, q, c = s.admin) => c.get('/api/financial-statements/cash-flow?' + q);

async function ready(t) {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedFs(s);
  return { s, seed };
}

test('م5 (1، 17): قائمة دخل لسنة رابحة — البنود من التصنيف الفعلي، والمجاميع صحيحة، ومطابقة لميزان المراجعة لكل حساب', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const r = ok(await IS(s, `fiscalYearId=${seed.fy[2024].id}`));
  assert.deepEqual(r.lines.map((l) => [l.key, V(l)]), [['revenue', '5000'], ['cogs', '1500'], ['gross_profit', '3500'], ['operating_expense', '2000'],
    ['operating_profit', '1500'], ['other_income', '200'], ['other_expense', '100'], ['net_profit', '1600']]);
  assert.equal(r.resultSide, 'profit'); assert.equal(r.netProfit.value, '1600');
  assert.deepEqual([r.complete, r.reconciliation.ok, r.issuable], [true, true, true]);
  assert.equal(acc(r, '5101').classification, 'class'); assert.equal(acc(r, '6101').classification, 'type');
  // صافي الربح = −(صافي حركة حسابات قائمة الدخل في الميزان قبل الإقفال)
  const tb = ok(await s.admin.get(`/api/ledger/trial-balance?fiscalYearId=${seed.fy[2024].id}&excludeClosing=1`));
  const D = s.app.services.decimal;
  const tbNet = D.sum(tb.rows.filter((x) => !x.isGroup && ['revenue', 'cogs', 'expense'].includes(x.classCode)).map((x) => D.sub(x.movementCredit, x.movementDebit)));
  assert.equal(D.canonical(tbNet), r.netProfit.value);
});

test('م5 (2، 3): قائمة دخل لسنة خاسرة ولسنة نتيجتها صفر', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await post(s, seed, '2024-02-01', [{ accountId: A.cash.id, debit: '300' }, { accountId: A.sales.id, credit: '300' }]);
  await post(s, seed, '2024-02-02', [{ accountId: A.salaries.id, debit: '900' }, { accountId: A.cash.id, credit: '900' }]);
  const loss = ok(await IS(s, `fiscalYearId=${seed.fy[2024].id}`));
  assert.deepEqual([loss.resultSide, loss.netProfit.value, V(line(loss, 'operating_profit'))], ['loss', '-600', '-600']);
  await post(s, seed, '2025-02-01', [{ accountId: A.cash.id, debit: '450' }, { accountId: A.sales.id, credit: '450' }]);
  await post(s, seed, '2025-02-02', [{ accountId: A.rent.id, debit: '450' }, { accountId: A.cash.id, credit: '450' }]);
  const zero = ok(await IS(s, `fiscalYearId=${seed.fy[2025].id}`));
  assert.deepEqual([zero.resultSide, zero.netProfit.value], ['zero', '0']);
});

test('م5 (4، 5، 10، 11، 12): المركز المالي متزن قبل الإقفال وبعده وبعد إعادة الفتح، بلا ازدواج من ترحيل الأرصدة، ومطابق للكشف والميزان', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const before = ok(await BS(s, 'asOf=2024-12-31'));
  assert.equal(before.balanced, true); assert.equal(V(before.difference), '0');
  assert.deepEqual([V(before.totalAssets), V(before.totalLiabilities), V(before.sections[2].unclosedResult), V(before.totalEquity)], ['17100', '5500', '1600', '11600']);
  assert.equal(before.reconciliation.ok, true);
  // البند = رصيد الكشف في التاريخ نفسه
  const st = ok(await s.admin.get(`/api/ledger/statement?accountId=${seed.acc.cash.id}&from=2024-01-01&to=2024-12-31`));
  assert.equal(st.closing.net, V(bsAcc(before, '1101')));
  const isBefore = ok(await IS(s, `fiscalYearId=${seed.fy[2024].id}`));
  // إقفال 2024 وترحيل أرصدتها
  await closePeriods(s, seed.fy[2024].id);
  ok(await closeYear(s, seed.fy[2024].id, { carryForward: true }));
  const after = ok(await BS(s, 'asOf=2024-12-31'));
  assert.equal(after.balanced, true);
  assert.deepEqual([V(after.totalAssets), V(after.sections[2].unclosedResult), V(bsAcc(after, '3201'))], ['17100', '0', '1600']);
  // قائمة الدخل للسنة المُقفلة لا تتغير (قيود الإقفال مستبعدة)
  const isAfter = ok(await IS(s, `fiscalYearId=${seed.fy[2024].id}`));
  assert.deepEqual(isAfter.lines.map((l) => V(l)), isBefore.lines.map((l) => V(l)));
  // بند الإيراد = كشف الحساب قبل الإقفال (بالنطاق نفسه)
  const stS = ok(await s.admin.get(`/api/ledger/statement?accountId=${seed.acc.sales.id}&from=2024-01-01&to=2024-12-31&excludeClosing=1`));
  assert.equal(stS.closing.net, '-' + V(acc(isAfter, '4101')));
  // أول يوم في 2025: لا ازدواج — نفس الأرصدة، والإيرادات لا تظهر أرصدة افتتاحية
  const jan1 = ok(await BS(s, 'asOf=2025-01-01'));
  assert.deepEqual([V(jan1.totalAssets), V(jan1.totalLiabilitiesAndEquity), V(jan1.sections[2].unclosedResult)], ['17100', '17100', '0']);
  const is25 = ok(await IS(s, `fiscalYearId=${seed.fy[2025].id}`));
  assert.equal(is25.netProfit.value, '0'); assert.ok(is25.lines.every((l) => !l.rows || l.rows.length === 0));
  const cf25 = ok(await CF(s, `fiscalYearId=${seed.fy[2025].id}`));
  assert.deepEqual([V(cf25.openingCash), V(cf25.netChange), V(cf25.closingCash)], [V(bsAcc(after, '1101')), '0', V(bsAcc(after, '1101'))]);
  // السنة المُقفلة: الحالة نهائية فقط بعد قفل الفترات؛ والسنة المفتوحة غير نهائية
  assert.equal(after.finality.final, false);
  assert.ok(ok(await BS(s, 'asOf=2025-06-30')).finality.reasons.some((x) => x.code === 'PERIOD_OPEN'));
  assert.ok(!ok(await BS(s, 'asOf=2025-06-30')).finality.reasons.some((x) => x.code === 'PRIOR_YEAR_NOT_CLOSED'));
  // إعادة الفتح ⇒ النتيجة تعود «غير مُقفلة» والقائمة متزنة، وقائمة الدخل كما هي
  ok(await s.admin.post('/api/year-end/reopen', { fiscalYearId: seed.fy[2024].id, branchId: seed.hq.id, reason: 'تصحيح', includeCarryForward: true, idempotencyKey: key(), confirm: true }));
  const re = ok(await BS(s, 'asOf=2024-12-31'));
  assert.deepEqual([re.balanced, V(re.sections[2].unclosedResult), bsAcc(re, '3201') ? V(bsAcc(re, '3201')) : '0'], [true, '1600', '0']);
  assert.deepEqual(ok(await IS(s, `fiscalYearId=${seed.fy[2024].id}`)).lines.map((l) => V(l)), isBefore.lines.map((l) => V(l)));
  assert.equal(ok(await BS(s, 'asOf=2025-01-01')).balanced, true);
});

test('م5 (6): المقارنات — سنة بسنة، فترة بسابقتها (تنبيه عدم التساوي)، نفس الفترة من السنة السابقة، والفروق والنسب', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const A = seed.acc;
  await post(s, seed, '2025-03-10', [{ accountId: A.cash.id, debit: '7500' }, { accountId: A.sales.id, credit: '7500' }]);
  await post(s, seed, '2025-02-10', [{ accountId: A.rent.id, debit: '1000' }, { accountId: A.cash.id, credit: '1000' }]);
  const y = ok(await IS(s, `fiscalYearId=${seed.fy[2025].id}&compare=previous_year`));
  assert.deepEqual(y.columns.map((c) => [c.from, c.to]), [['2025-01-01', '2025-12-31'], ['2024-01-01', '2024-12-31']]);
  const rev = line(y, 'revenue');
  assert.deepEqual([V(rev, 0), V(rev, 1), rev.difference.value, rev.percent.value, rev.trend], ['7500', '5000', '2500', '50', 'up']);
  assert.equal(line(y, 'cogs').percent.value, '-100'); assert.equal(line(y, 'cogs').trend, 'down');
  assert.equal(y.reconciliation.ok, true);
  // الفترة السابقة لفبراير = يناير (31 يومًا مقابل 28) ⇒ تنبيه
  const feb = s.app.db.prepare("SELECT id FROM fiscal_periods WHERE start_date = '2025-02-01'").get().id;
  const p = ok(await IS(s, `periodId=${feb}&compare=previous_period`));
  assert.deepEqual([p.comparativePeriod.from, p.comparativePeriod.to], ['2025-01-01', '2025-01-31']);
  assert.ok(p.warnings.some((w) => w.code === 'UNEQUAL_PERIODS'));
  const sp = ok(await IS(s, `from=2025-03-01&to=2025-03-31&compare=same_period_last_year`));
  assert.deepEqual([sp.comparativePeriod.from, sp.comparativePeriod.to, V(line(sp, 'revenue'), 1)], ['2024-03-01', '2024-03-31', '5000']);
  assert.equal(E(await IS(s, `from=2025-03-01&to=2025-03-31&compare=previous_year`)), 'COMPARE_NEEDS_FULL_YEAR');
  // نسبة على مقارن صفري = بلا نسبة (لا قسمة على صفر)
  assert.equal(line(ok(await IS(s, `fiscalYearId=${seed.fy[2024].id}&compare=previous_year`)), 'revenue').percent, null);
  const b = ok(await BS(s, 'asOf=2025-12-31&compare=previous_year'));
  assert.deepEqual([b.comparativeDate.asOf, b.balanced, V(b.totalAssets, 1)], ['2024-12-31', true, '17100']);
  const cf = ok(await CF(s, `fiscalYearId=${seed.fy[2025].id}&compare=previous_year`));
  assert.equal(V(cf.closingCash, 1), V(cf.openingCash, 0));
});

test('م5 (7، 13): الفروع — فرع، مجموعة، الكل، والتوزيع على أعمدة يساوي الإجمالي؛ ونطاق مستخدم الفرع في الخادم', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const A = seed.acc;
  await post(s, seed, '2024-04-04', [{ accountId: A.cash.id, debit: '900' }, { accountId: A.sales.id, credit: '900' }], { branch: seed.alx });
  await post(s, seed, '2024-04-05', [{ accountId: A.rent.id, debit: '400' }, { accountId: A.cash.id, credit: '400' }], { branch: seed.alx });
  const y = `fiscalYearId=${seed.fy[2024].id}`;
  const hq = ok(await IS(s, `${y}&branch=${seed.hq.id}`)); const alx = ok(await IS(s, `${y}&branch=${seed.alx.id}`));
  const all = ok(await IS(s, y)); const grp = ok(await IS(s, `${y}&branch=${seed.hq.id},${seed.alx.id}`));
  assert.deepEqual([hq.netProfit.value, alx.netProfit.value, all.netProfit.value, grp.netProfit.value], ['1600', '500', '2100', '2100']);
  assert.deepEqual(grp.scope.branches.map((b) => b.code).sort(), ['ALX', 'HQ']); assert.equal(grp.reconciliation.ok, true);
  const bd = ok(await IS(s, `${y}&breakdown=branch`));
  assert.equal(bd.breakdownCheck.ok, true);
  assert.deepEqual(bd.columns.map((c) => (c.label ? c.label.code : c.key)).sort(), ['ALX', 'HQ', 'total']);
  assert.deepEqual(line(bd, 'net_profit').values.map((v) => v.value).sort(), ['1600', '2100', '500'].sort());
  assert.equal(E(await IS(s, `${y}&breakdown=branch&compare=previous_year`)), 'BREAKDOWN_WITH_COMPARE');
  const bsHq = ok(await BS(s, `asOf=2024-12-31&branch=${seed.hq.id}`)); const bsAlx = ok(await BS(s, `asOf=2024-12-31&branch=${seed.alx.id}`));
  assert.deepEqual([bsHq.balanced, bsAlx.balanced, V(bsAlx.totalAssets), V(bsAlx.sections[2].unclosedResult)], [true, true, '500', '500']);
  // مستخدم فرع ALX
  const u = await makeUser(s, { username: 'fsalx', permissions: ['financial_statements.view', 'ledger.view'], branchIds: [seed.alx.id] });
  assert.equal(ok(await IS(s, y, u.client)).netProfit.value, '500');
  assert.equal(E(await IS(s, `${y}&branch=${seed.hq.id}`, u.client)), 'BRANCH_FORBIDDEN');
  assert.equal(E(await IS(s, `${y}&branch=${seed.hq.id},${seed.alx.id}`, u.client)), 'BRANCH_FORBIDDEN');
  assert.equal(E(await BS(s, `asOf=2024-12-31&branch=${seed.hq.id}`, u.client)), 'BRANCH_FORBIDDEN');
  // مجموعة الفروع تعمل أيضًا في ميزان المراجعة وكشف الحساب (الكشف من القائمة بالنطاق نفسه)
  const tb = ok(await s.admin.get(`/api/ledger/trial-balance?${y}&branch=${seed.hq.id},${seed.alx.id}`));
  assert.equal(tb.branch.code.split(', ').sort().join(), 'ALX,HQ');
});

test('م5 (8): مراكز التكلفة — تحليل لقائمة الدخل فقط، والتوزيع على المراكز (وبلا مركز) يساوي الإجمالي', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const y = `fiscalYearId=${seed.fy[2024].id}`;
  const c1 = ok(await IS(s, `${y}&costCenterIds=${seed.cc1.id}`));
  assert.equal(c1.scope.analytical, true); assert.equal(V(line(c1, 'operating_expense')), '1200'); assert.equal(c1.reconciliation.ok, true);
  const both = ok(await IS(s, `${y}&costCenterIds=${seed.cc1.id},${seed.cc2.id}`));
  assert.equal(V(line(both, 'operating_expense')), '2000');
  const bd = ok(await IS(s, `${y}&breakdown=cost_center`));
  assert.equal(bd.breakdownCheck.ok, true);
  assert.ok(bd.columns.some((c) => c.label && c.label.none));
  assert.equal(E(await BS(s, `asOf=2024-12-31&costCenterIds=${seed.cc1.id}`)), 'COST_CENTER_NOT_SUPPORTED');
  assert.equal(E(await CF(s, `${y}&costCenterIds=${seed.cc1.id}`)), 'COST_CENTER_NOT_SUPPORTED');
  assert.equal(E(await IS(s, `${y}&costCenterIds=999`)), 'VALIDATION');
});

test('م5 (9): العملات الأجنبية — المبالغ الأساسية المحفوظة في الأستاذ، بلا إعادة تقييم عند تغير السعر', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  await post(s, seed, '2024-02-10', [{ accountId: A.bankUsd.id, currencyId: seed.usd.id, debit: '100' }, { accountId: A.sales.id, currencyId: seed.usd.id, credit: '100' }]);
  ok(await s.admin.post(`/api/currencies/${seed.usd.id}/rates`, { rateType: 'average', effectiveDate: '2024-06-01', rate: '55' }));
  await post(s, seed, '2024-07-10', [{ accountId: A.bankUsd.id, currencyId: seed.usd.id, debit: '10' }, { accountId: A.otherRev.id, currencyId: seed.usd.id, credit: '10' }]);
  const r = ok(await IS(s, `fiscalYearId=${seed.fy[2024].id}`));
  assert.deepEqual([V(line(r, 'revenue')), V(line(r, 'other_income')), r.baseCurrency], ['4850', '550', 'EGP']);
  const b = ok(await BS(s, 'asOf=2024-12-31'));
  assert.deepEqual([V(bsAcc(b, '1102')), b.balanced], ['5400', true]);
  const cf = ok(await CF(s, `fiscalYearId=${seed.fy[2024].id}`));
  assert.deepEqual([V(cf.closingCash), cf.reconciliation.ok], ['5400', true]);
});

test('م5: قائمة التدفقات النقدية — صافي الربح والتعديلات والأنشطة الثلاثة، والافتتاحي رصيد أول مدة، وإثبات النقدية', async (t) => {
  const { s, seed } = await ready(t);
  const A = seed.acc;
  // قيد افتتاحي في أول يوم من أول سنة: رصيد أول مدة لا تدفق
  const ob = ok(await s.admin.post('/api/journal', { branchId: seed.hq.id, entryType: 'opening', entryDate: '2024-01-01', description: 'افتتاحي', lines: [{ accountId: A.cash.id, debit: '2000' }, { accountId: A.capital.id, credit: '2000' }] }));
  ok(await s.admin.post(`/api/journal/${ob.id}/post`, {}));
  await profit2024(s, seed);
  const r = ok(await CF(s, `fiscalYearId=${seed.fy[2024].id}`));
  assert.deepEqual([r.complete, r.issuable, r.reconciliation.ok], [true, true, true]);
  const sec = (k) => r.sections.find((x) => x.key === k);
  assert.equal(V(r.netIncome), '1600');
  assert.deepEqual([V(cfAcc(r, '1201')), V(cfAcc(r, '2101'))], ['-1000', '500']);
  assert.deepEqual([V(sec('operating')), V(sec('investing')), V(sec('financing'))], ['1100', '-3000', '15000']);
  assert.deepEqual([V(r.openingCash), V(r.netChange), V(r.closingCash)], ['2000', '13100', '15100']);
  // النقدية آخر المدة = رصيد الصندوق في المركز المالي
  assert.equal(V(bsAcc(ok(await BS(s, 'asOf=2024-12-31')), '1101')), '15100');
});

test('م5 (16): بيانات ناقصة — حساب بلا تصنيف يجعل القائمة غير مكتملة (النتيجة صحيحة) ويمنع الطباعة والتصدير حتى يُصنَّف', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const odd = ok(await s.admin.post('/api/accounts', { code: '4199', nameAr: 'إيراد متنوع', nameEn: 'Misc income', parentId: seed.groups.revenue.id }));
  await post(s, seed, '2024-08-01', [{ accountId: seed.acc.cash.id, debit: '50' }, { accountId: odd.id, credit: '50' }]);
  const y = `fiscalYearId=${seed.fy[2024].id}`;
  const r = ok(await IS(s, y));
  assert.deepEqual([r.complete, r.issuable, r.netProfit.value, V(line(r, 'unclassified'))], [false, false, '1650', '50']);
  assert.equal(r.issues[0].accounts[0].code, '4199');
  assert.equal(E(await s.admin.get(`/api/financial-statements/income-statement/print?${y}`)), 'STATEMENT_INCOMPLETE');
  assert.equal(E(await s.admin.get(`/api/financial-statements/income-statement/export.xlsx?${y}`)), 'STATEMENT_INCOMPLETE');
  const st = ok(await s.admin.get('/api/financial-statements/settings'));
  assert.ok(st.unclassified.some((a) => a.code === '4199' && a.hasActivity));
  // تصنيف غير مناسب للتصنيف الأساسي ⇒ مرفوض (الخادم والقاعدة)
  assert.equal((await s.admin.put('/api/financial-statements/settings/accounts/' + odd.id, { isLine: 'operating_expense' })).body.error.details.fields.isLine, 'CLASS_MISMATCH');
  assert.equal((await s.admin.put('/api/financial-statements/settings/accounts/' + odd.id, { cfActivity: 'cash' })).body.error.details.fields.cfActivity, 'NOT_ALLOWED');
  assert.throws(() => s.app.db.prepare("INSERT INTO fs_account_settings (account_id, is_line) VALUES (?, 'cogs')").run(odd.id), /does not fit the account class/);
  ok(await s.admin.put('/api/financial-statements/settings/accounts/' + odd.id, { isLine: 'other_income' }));
  const fixed = ok(await IS(s, y));
  assert.deepEqual([fixed.complete, V(line(fixed, 'other_income')), fixed.netProfit.value], [true, '250', '1650']);
  // حساب ميزانية بنوع بلا نشاط افتراضي (أصول أخرى) ⇒ التدفقات غير مكتملة؛ وبلا حساب نقدية ⇒ تنبيه مانع
  const types = Object.fromEntries(s.app.db.prepare('SELECT code, id FROM account_types').all().map((x) => [x.code, x.id]));
  const dep = ok(await s.admin.post('/api/accounts', { code: '1401', nameAr: 'تأمينات', nameEn: 'Deposits', parentId: seed.groups.assets.id, typeId: types.OTHER_ASSET }));
  await post(s, seed, '2024-09-01', [{ accountId: dep.id, debit: '70' }, { accountId: seed.acc.cash.id, credit: '70' }]);
  let cf = ok(await CF(s, y));
  assert.deepEqual([cf.complete, cf.reconciliation.ok], [false, true]);
  ok(await s.admin.put('/api/financial-statements/settings/types/' + types.OTHER_ASSET, { cfActivity: 'investing' }));
  cf = ok(await CF(s, y)); assert.equal(cf.complete, true);
  ok(await s.admin.put('/api/financial-statements/settings/types/' + types.CASH, { cfActivity: null }));
  ok(await s.admin.put('/api/financial-statements/settings/types/' + types.BANK, { cfActivity: 'operating' }));
  cf = ok(await CF(s, y));
  assert.ok(cf.issues.some((i) => i.code === 'NO_CASH_ACCOUNTS'));
  const acts = s.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'financial_statements.%'").all().map((x) => x.action);
  assert.ok(acts.includes('financial_statements.account_classified') && acts.includes('financial_statements.type_classified'));
});

test('م5 (14، 15، 13): الطباعة والتصدير بالعربية والإنجليزية ببيانات الإصدار والحالة، والصلاحيات المستقلة', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const y = `fiscalYearId=${seed.fy[2024].id}`;
  const ar = ok(await s.admin.get(`/api/financial-statements/income-statement/print?${y}&lang=ar&compare=previous_year`));
  assert.equal(ar.title, 'قائمة الدخل');
  assert.ok(ar.meta.some((m) => m.includes('شركة اختبار')) && ar.meta.some((m) => m.includes('2024-01-01 → 2024-12-31')) && ar.meta.some((m) => m.includes('EGP')));
  assert.ok(ar.meta.some((m) => m.includes('غير نهائي')) && ar.meta.some((m) => m.startsWith('تاريخ الإصدار')));
  assert.ok(ar.rows.some((r) => r[0] === 'صافي الربح (الخسارة)' && r[1] === '1,600.00'));
  assert.deepEqual(ar.columns.slice(-2), ['الفرق', 'النسبة']);
  const en = ok(await s.admin.get(`/api/financial-statements/balance-sheet/print?asOf=2024-12-31&lang=en`));
  assert.equal(en.title, 'Statement of financial position'); assert.ok(en.meta.some((m) => m.startsWith('Company: Test Company')));
  assert.ok(en.rows.some((r) => r[0] === 'Total liabilities and equity' && r[1] === '17,100.00'));
  const cfp = ok(await s.admin.get(`/api/financial-statements/cash-flow/print?${y}&lang=en`));
  assert.ok(cfp.meta.includes('Indirect method'));
  // Excel: خلايا رقمية بنص المحرك العشري (لا نص منسق)
  const x = await fetch(s.base + `/api/financial-statements/income-statement/export.xlsx?${y}&lang=ar`, { headers: { cookie: s.admin.state.cookie } });
  assert.equal(x.status, 200);
  const sheet = readSheet(Buffer.from(await x.arrayBuffer()));
  const rows = sheet.rows || sheet;
  const flat = JSON.stringify(rows);
  assert.ok(flat.includes('قائمة الدخل') && flat.includes('1600') && !flat.includes('1,600.00'), flat.slice(0, 400));
  // الصلاحيات
  const viewer = await makeUser(s, { username: 'fsview', permissions: ['financial_statements.view'], allBranches: true });
  assert.equal((await viewer.client.get(`/api/financial-statements/income-statement/print?${y}`)).status, 403);
  assert.equal((await viewer.client.get(`/api/financial-statements/income-statement/export.xlsx?${y}`)).status, 403);
  assert.equal((await viewer.client.put('/api/financial-statements/settings/types/1', { cfActivity: 'cash' })).status, 403);
  assert.equal(ok(await IS(s, y, viewer.client)).netProfit.value, '1600');
  const none = await makeUser(s, { username: 'fsnone', permissions: ['ledger.view'], allBranches: true });
  assert.equal((await IS(s, y, none.client)).status, 403);
  assert.equal((await none.client.get('/api/financial-statements/settings')).status, 403);
});

test('م5 (17): عدم المطابقة مع ميزان المراجعة يُكتشف ويمنع الإصدار', async (t) => {
  const { s, seed } = await ready(t);
  await profit2024(s, seed);
  const lr = s.app.services.ledgerReports;
  const orig = lr.trialBalance;
  lr.trialBalance = (ctx, q) => { const r = orig(ctx, q); const row = r.rows.find((x) => x.code === '4101'); if (row) row.movementCredit = '4999'; return r; };
  const y = `fiscalYearId=${seed.fy[2024].id}`;
  const r = ok(await IS(s, y));
  lr.trialBalance = orig;
  assert.equal(r.reconciliation.ok, false); assert.equal(r.reconciliation.differences[0].code, '4101'); assert.deepEqual(r.blockers, ['STATEMENT_NOT_RECONCILED']);
  assert.equal(ok(await IS(s, y)).reconciliation.ok, true);
});

'use strict';
/* المرحلة 3 (الدفعة 3.1): محرك الترحيل والأستاذ العام — الترحيل، الاتزان، الدقة العشرية، العملات والأسعار، السياسات. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { createDecimalService } = require('../server/core/decimal');
const { startReady, makeUser } = require('./helpers');
const { ok, seedLedger, draft, postEntry, postNew } = require('./ledger-helpers');

const D = createDecimalService();
const count = (s, t, where = '1') => s.app.db.prepare(`SELECT count(*) c FROM ${t} WHERE ${where}`).get().c;

test('ledger: قيد متزن يُرحَّل — رقم، أستاذ مطابق، تدقيق، والسجلات (الاستخدام والنشاط المالي)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '1250.75' }, { accountId: seed.acc.sales.id, credit: '1250.75', costCenterId: seed.cc.id }]));
  assert.equal(d.status, 'draft'); assert.equal(d.number, null);
  assert.deepEqual(d.lines.map((l) => [l.rateSource, l.rate, l.debit, l.credit]), [['base', '1', '0', '0'], ['base', '1', '0', '0']]);
  assert.equal(count(s, 'gl_entries'), 0);                                         // المسودة لا تمس الأستاذ
  const p = ok(await postEntry(s, d.id));
  assert.equal(p.status, 'posted'); assert.equal(p.number, 'JV-HQ-FY2026-000001'); assert.equal(p.totalBase, '1250.75');
  assert.deepEqual(p.lines.map((l) => [l.debit, l.credit]), [['1250.75', '0'], ['0', '1250.75']]);
  const gl = s.app.db.prepare('SELECT * FROM gl_entries ORDER BY id').all();
  assert.equal(gl.length, 2);
  assert.deepEqual(gl.map((g) => [g.doc_number, g.account_id, g.cost_center_id, g.debit, g.credit, g.entry_kind, g.posting_date]),
    [['JV-HQ-FY2026-000001', seed.acc.cash.id, null, '1250.75', '0', 'normal', '2026-03-15'], ['JV-HQ-FY2026-000001', seed.acc.sales.id, seed.cc.id, '0', '1250.75', 'normal', '2026-03-15']]);
  assert.equal(gl[0].fiscal_period_id, p.fiscalPeriodId);
  const ev = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action = 'ledger.posted'").get().details);
  assert.equal(ev.number, 'JV-HQ-FY2026-000001'); assert.equal(ev.totalBase, '1250.75'); assert.equal(ev.lines.length, 2);
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'journal_entry.created'").get());
  assert.ok(JSON.parse(p.lines && s.app.db.prepare('SELECT decimal_snapshot d FROM journal_entries WHERE id = ?').get(d.id).d).amount.EGP);
  assert.deepEqual(s.app.services.ledger.integrity(), { ok: true, problems: [] });
  // الاستخدام: الحساب المرحَّل عليه لا يُحذف، والفترة كذلك؛ والنشاط المالي مسجل
  assert.equal((await s.admin.del('/api/accounts/' + seed.acc.rent.id)).status, 200);              // غير مستخدم
  assert.equal((await s.admin.del('/api/accounts/' + seed.acc.cash.id)).body.error.code, 'IN_USE');
  assert.deepEqual(s.app.services.usage.usedBy('fiscal_period', p.fiscalPeriodId), ['journal']);
  assert.ok(s.app.services.financialActivity.sources().includes('journal'));
  // إعادة الترحيل أو الحذف بعد الترحيل مرفوضة
  assert.equal((await postEntry(s, d.id)).body.error.code, 'NOT_DRAFT');
  assert.equal((await s.admin.del('/api/journal/' + d.id)).body.error.code, 'NOT_DRAFT');
});

test('ledger: قيد غير متزن يُرفض (ولو بفرق 0.00000001) ولا يُكتب شيء ولا يُستهلك رقم', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '100' }, { accountId: seed.acc.sales.id, credit: '99.99999999' }]));
  const r = await postEntry(s, d.id);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'UNBALANCED');
  assert.deepEqual(r.body.error.details, { totalDebit: '100', totalCredit: '99.99999999', difference: '0.00000001', currency: 'EGP' });
  assert.equal(count(s, 'gl_entries'), 0); assert.equal(count(s, 'issued_numbers'), 0); assert.equal(count(s, 'document_counters'), 0);
  assert.equal(ok(await s.admin.get('/api/journal/' + d.id)).status, 'draft');
  // القيد التالي يأخذ الرقم 1 (لم يُستهلك شيء)
  const p = await postNew(s, seed, [{ accountId: seed.acc.cash.id, debit: '5' }, { accountId: seed.acc.sales.id, credit: '5' }]);
  assert.equal(p.number, 'JV-HQ-FY2026-000001');
  // طرف واحد بالضبط عند الإدخال، وموجب، وبدقة العملة
  const bad = async (lines, field, code) => assert.equal((await draft(s, seed, lines)).body.error.details.fields[field], code);
  await bad([{ accountId: seed.acc.cash.id, debit: '5', credit: '5' }, { accountId: seed.acc.sales.id, credit: '5' }], 'lines.0.debit', 'ONE_SIDE_REQUIRED');
  await bad([{ accountId: seed.acc.cash.id }, { accountId: seed.acc.sales.id, credit: '5' }], 'lines.0.debit', 'ONE_SIDE_REQUIRED');
  await bad([{ accountId: seed.acc.cash.id, debit: '-5' }, { accountId: seed.acc.sales.id, credit: '5' }], 'lines.0.debit', 'MUST_BE_POSITIVE');
  await bad([{ accountId: seed.acc.cash.id, debit: '0.0' }, { accountId: seed.acc.sales.id, credit: '5' }], 'lines.0.debit', 'MUST_BE_POSITIVE');
  await bad([{ accountId: seed.acc.cash.id, debit: '5.123456789' }, { accountId: seed.acc.sales.id, credit: '5' }], 'lines.0.debit', 'TOO_PRECISE');
  await bad([{ accountId: seed.acc.cash.id, debit: 5 }, { accountId: seed.acc.sales.id, credit: '5' }], 'lines.0.debit', 'DECIMAL_MUST_BE_STRING');
  await bad([{ accountId: seed.acc.cash.id, debit: '1e5' }, { accountId: seed.acc.sales.id, credit: '5' }], 'lines.0.debit', 'INVALID');
  assert.equal((await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '5' }])).body.error.details.fields.lines, 'TOO_FEW_LINES');
});

test('ledger: الدقة العشرية — التحويل الجماعي بلا فروق تقريب، والنتيجة حتمية ومطابقة لمرجع مستقل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const U = (accountId, side, amount) => ({ accountId, currencyId: seed.usd.id, [side]: amount });
  // المثال الموثّق: تحويل كل سطر منفردًا يعطي فرق 0.00000001
  const perLine = ['33.33', '33.33', '33.34'].map((a) => D.commit(D.mul(a, '48.123456789012'), 'amount', 'EGP'));
  assert.equal(D.canonical(D.sum(perLine)), '4812.34567891');
  const p = await postNew(s, seed, [U(seed.acc.bankUsd.id, 'debit', '33.33'), U(seed.acc.bankUsd.id, 'debit', '33.33'), U(seed.acc.bankUsd.id, 'debit', '33.34'), U(seed.acc.sales.id, 'credit', '100')]);
  assert.deepEqual(p.lines.map((l) => [l.debit, l.credit]), [['1603.95481478', '0'], ['1603.95481478', '0'], ['1604.43604934', '0'], ['0', '4812.3456789']]);
  assert.equal(p.totalBase, '4812.3456789'); assert.deepEqual(p.lines.map((l) => l.rateSource), ['table', 'table', 'table', 'table']);
  assert.ok(p.lines.every((l) => l.rateId === seed.usdRateRow.id && l.rate === '48.123456789012'));

  // 120 قيدًا عشوائيًا بعملات مختلفة: كلها متزنة بالضبط، ومجموع كل طرف = تحويل المجموع مرة واحدة (مرجع مستقل)
  let seedN = 7; const rnd = () => { seedN = (seedN * 1103515245 + 12345) % 2147483648; return seedN; };
  const amt = () => `${rnd() % 100000}.${String(rnd() % 100).padStart(2, '0')}`.replace(/^0\./, '1.');
  for (let k = 0; k < 120; k++) {
    const cur = [seed.usd, seed.eur, seed.egp][k % 3];
    const rate = { USD: '48.123456789012', EUR: '53.9', EGP: '1' }[cur.code];
    const debits = Array.from({ length: 1 + (rnd() % 4) }, amt);
    const total = D.canonical(D.sum(debits));
    const lines = [...debits.map((a) => ({ accountId: seed.acc.bankUsd.id, currencyId: cur.id, debit: a })), { accountId: seed.acc.sales.id, currencyId: cur.id, credit: total }];
    const e = await postNew(s, seed, lines);
    const baseD = e.lines.filter((l) => l.debit !== '0').map((l) => l.debit);
    const expected = D.commit(D.mul(total, rate), 'amount', 'EGP');
    assert.equal(D.canonical(D.sum(baseD)), expected, `entry ${k}`);
    assert.equal(e.lines.at(-1).credit, expected);
    assert.equal(e.totalBase, expected);
    // كل جزء يبعد عن تحويله المنفرد بأقل من وحدة اعتماد واحدة (التوزيع لا يخلق ولا يضيّع)
    e.lines.slice(0, -1).forEach((l, i) => assert.ok(D.lte(D.abs(D.sub(l.debit, D.mul(debits[i], rate))), '0.00000001')));
  }
  // حتمية: نفس المدخلات في قاعدة جديدة ⇒ نفس المبالغ الأساسية حرفيًا
  const s2 = await startReady(); t.after(s2.stop);
  const seed2 = await seedLedger(s2);
  const p2 = await postNew(s2, seed2, [U(seed2.acc.bankUsd.id, 'debit', '33.33'), U(seed2.acc.bankUsd.id, 'debit', '33.33'), U(seed2.acc.bankUsd.id, 'debit', '33.34'), U(seed2.acc.sales.id, 'credit', '100')]);
  assert.deepEqual(p2.lines.map((l) => [l.debit, l.credit]), p.lines.map((l) => [l.debit, l.credit]));
  // الأستاذ: مجموع المدين = الدائن بالضبط (dec_sum، لا SUM)
  const tot = s.app.db.prepare('SELECT dec_sum(debit) d, dec_sum(credit) c FROM gl_entries').get();
  assert.equal(tot.d, tot.c);
  assert.deepEqual(s.app.services.ledger.integrity(), { ok: true, problems: [] });
});

test('ledger: قيد متعدد العملات — الفرق الحقيقي يُرفض بقيمته، ويُرحَّل بعد سطر صريح', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s, { usdRate: '48.5', eurRate: '53.9' });
  const lines = [{ accountId: seed.acc.bankEur.id, currencyId: seed.eur.id, debit: '900' }, { accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, credit: '1000' }];
  const d = ok(await draft(s, seed, lines));
  const r = await postEntry(s, d.id);
  assert.equal(r.body.error.code, 'UNBALANCED');
  assert.deepEqual(r.body.error.details, { totalDebit: '48510', totalCredit: '48500', difference: '10', currency: 'EGP' });
  const p = await postNew(s, seed, [...lines, { accountId: seed.acc.fxDiff.id, credit: '10' }]);
  assert.equal(p.isMultiCurrency, true); assert.equal(p.totalBase, '48510');
  assert.deepEqual(p.lines.map((l) => [l.rateSource, l.debitFc, l.creditFc, l.debit, l.credit]),
    [['table', '900', '0', '48510', '0'], ['table', '0', '1000', '0', '48500'], ['base', '0', '10', '0', '10']]);
});

test('ledger: BASE_AMOUNT_ZERO — سطر أجنبي يصبح أساسيه صفرًا بعد التحويل يُرفض', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const xts = ok(await s.admin.post('/api/currencies', { code: 'XTS', nameAr: 'عملة اختبار', nameEn: 'Test currency', displayDecimals: 8 }));
  ok(await s.admin.post(`/api/currencies/${xts.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '0.000001' }));
  // 0.001 × 0.000001 = 0.000000001 ⇒ يُعتمد بثماني خانات = 0
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, currencyId: xts.id, debit: '0.001' }, { accountId: seed.acc.sales.id, currencyId: xts.id, credit: '0.001' }]));
  const r = await postEntry(s, d.id);
  assert.equal(r.status, 409); assert.equal(r.body.error.code, 'BASE_AMOUNT_ZERO');
  assert.deepEqual(r.body.error.details, { line: 1, amount: '0.001', currency: 'XTS' });
  assert.equal(count(s, 'gl_entries'), 0); assert.equal(count(s, 'issued_numbers'), 0);
});

test('ledger: السعر من الجدول لقطة يُتحقق منها عند الترحيل؛ والسعر اليدوي بصلاحية وسبب ومُدقَّق', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s, { usdRate: '48.5' });
  const L = (extra = {}) => [{ accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '100', ...extra }, { accountId: seed.acc.sales.id, currencyId: seed.usd.id, credit: '100' }];
  // تصحيح السعر بعد إنشاء المسودة ⇒ RATE_NOT_CURRENT (لا يُرحَّل بسعر لم يعد ساريًا)
  const stale = ok(await draft(s, seed, L()));
  ok(await s.admin.post(`/api/currencies/rates/${seed.usdRateRow.id}/correct`, { rate: '48.6', reason: 'تصحيح نشرة البنك' }));
  const r = await postEntry(s, stale.id);
  assert.equal(r.body.error.code, 'RATE_NOT_CURRENT'); assert.equal(r.body.error.details.current, '48.6');
  // عملة أجنبية بلا سعر ساري ⇒ NO_RATE عند الإنشاء
  const gbp = ok(await s.admin.post('/api/currencies', { code: 'GBP', nameAr: 'إسترليني', nameEn: 'Pound', displayDecimals: 2 }));
  assert.equal((await draft(s, seed, [{ accountId: seed.acc.cash.id, currencyId: gbp.id, debit: '1' }, { accountId: seed.acc.sales.id, currencyId: gbp.id, credit: '1' }])).body.error.code, 'NO_RATE');
  // سعر للعملة الأساسية مرفوض
  assert.equal((await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '1', rate: '2' }, { accountId: seed.acc.sales.id, credit: '1' }])).body.error.details.fields['lines.0.rate'], 'NOT_ALLOWED');

  // السعر اليدوي: بلا صلاحية ⇒ 403؛ بلا سبب ⇒ رفض؛ بالصلاحية والسبب ⇒ يُحفظ ويُدقَّق
  const clerk = await makeUser(s, { username: 'clerk', permissions: ['journal.view', 'journal.create', 'journal.post'], allBranches: true });
  assert.equal((await draft(s, seed, L({ rate: '48.62', rateReason: 'سعر البنك الفعلي' }), {}, clerk.client)).body.error.code, 'RATE_OVERRIDE_FORBIDDEN');
  const fx = await makeUser(s, { username: 'fxclerk', permissions: ['journal.view', 'journal.create', 'journal.post', 'journal.override_rate'], allBranches: true });
  assert.equal((await draft(s, seed, L({ rate: '48.62' }), {}, fx.client)).body.error.details.fields['lines.0.rateReason'], 'REQUIRED');
  assert.equal((await draft(s, seed, L({ rate: '48.62', rateReason: 'سب' }), {}, fx.client)).body.error.details.fields['lines.0.rateReason'], 'TOO_SHORT');
  assert.equal((await draft(s, seed, L({ rate: '48.1234567890123', rateReason: 'دقة زائدة' }), {}, fx.client)).body.error.details.fields['lines.0.rate'], 'TOO_PRECISE');
  const m = ok(await draft(s, seed, [{ accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '100', rate: '48.62', rateReason: 'سعر البنك الفعلي للتحويل' },
    { accountId: seed.acc.sales.id, currencyId: seed.usd.id, credit: '100', rate: '48.62', rateReason: 'سعر البنك الفعلي للتحويل' }], {}, fx.client));
  assert.deepEqual([m.lines[0].rateSource, m.lines[0].rate, m.lines[0].tableRate, m.lines[0].rateReason], ['manual', '48.62', '48.6', 'سعر البنك الفعلي للتحويل']);
  assert.equal(m.lines[0].rateSetBy, s.app.db.prepare("SELECT id FROM users WHERE username = 'fxclerk'").get().id); assert.ok(m.lines[0].rateSetAt);
  const ov = s.app.db.prepare("SELECT actor, details FROM audit_log WHERE action = 'journal.rate_overridden' ORDER BY id").all();
  assert.equal(ov.length, 2); assert.equal(ov[0].actor, 'fxclerk');
  assert.deepEqual((({ currency, rate, tableRate, reason, rateSource }) => ({ currency, rate, tableRate, reason, rateSource }))(JSON.parse(ov[0].details)),
    { currency: 'USD', rate: '48.62', tableRate: '48.6', reason: 'سعر البنك الفعلي للتحويل', rateSource: 'manual' });
  // المرحِّل بلا الصلاحية لا يرحّل قيدًا بسعر يدوي (الترحيل هو ما يجعل السعر نافذًا)
  const rr = await postEntry(s, m.id, clerk.client);
  assert.equal(rr.status, 403); assert.equal(rr.body.error.code, 'RATE_OVERRIDE_FORBIDDEN'); assert.equal(rr.body.error.details.line, 1);
  const p = ok(await postEntry(s, m.id, fx.client));
  assert.deepEqual(p.lines.map((l) => [l.debit, l.credit]), [['4862', '0'], ['0', '4862']]);
  const posted = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action = 'ledger.posted'").get().details);
  assert.equal(posted.lines[0].rateSource, 'manual'); assert.equal(posted.lines[0].rateReason, 'سعر البنك الفعلي للتحويل');
});

test('ledger: سياسات الحساب ومركز التكلفة والفرع والفترة والتاريخ المستقبلي والقيد الافتتاحي', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const two = (a, b = {}) => [{ accountId: a, debit: '10', ...b }, { accountId: seed.acc.sales.id, credit: '10' }];
  const tryPost = async (lines, extra) => { const d = ok(await draft(s, seed, lines, extra)); return (await postEntry(s, d.id)).body.error; };
  // الحساب التجميعي، والمعطّل، وحساب المراقبة
  assert.deepEqual([(await tryPost(two(seed.acc.assets.id))).code, (await tryPost(two(seed.acc.assets.id))).details.reason], ['NOT_USABLE', 'GROUP']);
  ok(await s.admin.put('/api/accounts/' + seed.acc.rent.id, { allowManualEntry: false }));
  assert.equal((await tryPost(two(seed.acc.rent.id))).code, 'MANUAL_ENTRY_NOT_ALLOWED');
  ok(await s.admin.put('/api/accounts/' + seed.acc.rent.id, { allowManualEntry: true, costCenterPolicy: 'required' }));
  assert.equal((await tryPost(two(seed.acc.rent.id))).code, 'COST_CENTER_REQUIRED');
  assert.ok((await postNew(s, seed, two(seed.acc.rent.id, { costCenterId: seed.cc.id }))).number);
  ok(await s.admin.put('/api/accounts/' + seed.acc.cash.id, { costCenterPolicy: 'none' }));
  assert.equal((await tryPost(two(seed.acc.cash.id, { costCenterId: seed.cc.id }))).code, 'COST_CENTER_NOT_ALLOWED');
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'account.updated' AND details LIKE '%costCenterPolicy%'").get());
  ok(await s.admin.post(`/api/cost-centers/${seed.cc.id}/status`, { active: false }));
  assert.equal((await tryPost(two(seed.acc.rent.id, { costCenterId: seed.cc.id }))).details.reason, 'INACTIVE');
  // الفترة المغلقة، والتاريخ خارج السنوات
  const fy = (await s.admin.get('/api/fiscal-years')).body[0];
  const periods = ok(await s.admin.get('/api/fiscal-years/' + fy.id)).periods;
  ok(await s.admin.post(`/api/fiscal-periods/${periods[1].id}/close`, { reason: 'مراجعة فبراير' }));
  assert.equal((await tryPost(two(seed.acc.cash.id), { entryDate: '2026-02-10' })).code, 'PERIOD_NOT_OPEN');
  assert.equal((await draft(s, seed, two(seed.acc.cash.id), { entryDate: '2025-12-31' })).status, 200);
  assert.equal((await tryPost(two(seed.acc.cash.id), { entryDate: '2025-12-31' })).code, 'NO_FISCAL_PERIOD');
  // التاريخ المستقبلي يحتاج تأكيدًا صريحًا: «غدًا» بالنسبة لتاريخ تشغيل الاختبار، بسنوات متصلة حتى سنته (P5)
  const tomorrow = (() => { const d = new Date(s.app.services.ledger.today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1); return d.toISOString().slice(0, 10); })();
  for (let y = 2027; y <= Number(tomorrow.slice(0, 4)); y++) ok(await s.admin.post('/api/fiscal-years', { code: 'FY' + y, nameAr: String(y), nameEn: String(y), startDate: `${y}-01-01`, endDate: `${y}-12-31`, periodType: 'monthly' }));
  assert.equal((await tryPost(two(seed.acc.cash.id), { entryDate: tomorrow })).code, 'FUTURE_DATE_NOT_CONFIRMED');
  const fut = await postNew(s, seed, two(seed.acc.cash.id), { entryDate: tomorrow, futureDateConfirmed: true });
  assert.match(fut.number, new RegExp(`^JV-HQ-FY${tomorrow.slice(0, 4)}-\\d{6}$`)); assert.equal(fut.futureDateConfirmed, true);
  // الافتتاحي: صلاحية خاصة، وأول يوم من أول سنة فقط
  const noOpen = await makeUser(s, { username: 'noopen', permissions: ['journal.create', 'journal.post', 'journal.view'], allBranches: true });
  assert.equal((await draft(s, seed, two(seed.acc.cash.id), { entryType: 'opening', entryDate: '2026-01-01' }, noOpen.client)).status, 403);
  assert.equal((await draft(s, seed, two(seed.acc.cash.id), { entryType: 'opening', entryDate: '2026-01-02' })).body.error.code, 'OPENING_DATE');   // يُرفض من المسودة
  const ob = await postNew(s, seed, two(seed.acc.cash.id), { entryType: 'opening', entryDate: '2026-01-01' });
  assert.equal(ob.number, 'OB-HQ-FY2026-000001');
  assert.equal(s.app.db.prepare('SELECT DISTINCT entry_kind k FROM gl_entries WHERE source_id = ?').get(ob.id).k, 'opening');
});

test('ledger: الصلاحيات ونطاق الفروع على القيود', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const alx = ok(await s.admin.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  const viewer = await makeUser(s, { username: 'jview', permissions: ['journal.view'], allBranches: true });
  const lines = [{ accountId: seed.acc.cash.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '10' }];
  assert.equal((await draft(s, seed, lines, {}, viewer.client)).status, 403);
  const d = ok(await draft(s, seed, lines));
  assert.equal((await postEntry(s, d.id, viewer.client)).status, 403);
  assert.equal((await viewer.client.del('/api/journal/' + d.id)).status, 403);
  const alxOnly = await makeUser(s, { username: 'alxacc', permissions: ['journal.view', 'journal.create', 'journal.post', 'journal.delete'], branchIds: [alx.id] });
  assert.equal((await alxOnly.client.get('/api/journal/' + d.id)).status, 404);                 // قيد فرع آخر = غير موجود
  assert.equal((await postEntry(s, d.id, alxOnly.client)).status, 404);
  assert.equal((await draft(s, seed, lines, {}, alxOnly.client)).body.error.code, 'BRANCH_FORBIDDEN');
  const own = ok(await draft(s, seed, lines, { branchId: alx.id }, alxOnly.client));
  assert.equal(ok(await postEntry(s, own.id, alxOnly.client)).number, 'JV-ALX-FY2026-000001');
  assert.equal(ok(await postEntry(s, d.id)).number, 'JV-HQ-FY2026-000001');
  // حذف المسودة مسموح ويُدقَّق
  const d2 = ok(await draft(s, seed, lines));
  ok(await s.admin.del('/api/journal/' + d2.id));
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'journal_entry.deleted'").get());
  assert.equal(count(s, 'journal_lines', 'entry_id = ' + d2.id), 0);
});

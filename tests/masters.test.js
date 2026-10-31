'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { writeSheet } = require('../server/core/xlsx');
const { startReady, makeUser } = require('./helpers');

async function branches(s) {
  for (const code of ['ALX', 'GIZ']) await s.admin.post('/api/branches', { code, nameAr: 'فرع ' + code, nameEn: 'Branch ' + code });
  const id = (c) => s.app.db.prepare('SELECT id FROM branches WHERE code = ?').get(c).id;
  return { HQ: id('HQ'), ALX: id('ALX'), GIZ: id('GIZ') };
}

// ── مراكز التكلفة ──
test('cost centers: شجرة، نوع، فرع موروث من الأب، منع عدم التطابق والدورات، وتقرير أساسي', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const b = await branches(s);
  const prodType = s.app.db.prepare("SELECT id FROM cost_center_types WHERE code='PRODUCTION'").get().id;
  const root = (await s.admin.post('/api/cost-centers', { code: 'CC1', nameAr: 'المصنع', nameEn: 'Factory', isGroup: true, branchId: b.ALX, typeId: prodType })).body;
  const line = (await s.admin.post('/api/cost-centers', { code: 'cc11', nameAr: 'خط 1', nameEn: 'Line 1', parentId: root.id, typeId: prodType })).body;
  assert.equal(line.code, 'CC11'); assert.equal(line.branchId, b.ALX); assert.equal(line.level, 2);
  assert.equal((await s.admin.post('/api/cost-centers', { code: 'CC12', nameAr: 'خط', nameEn: 'L', parentId: root.id, branchId: b.GIZ })).body.error.code, 'BRANCH_MISMATCH');
  assert.equal((await s.admin.post('/api/cost-centers', { code: 'CC11', nameAr: 'مكرر', nameEn: 'Dup' })).body.error.details.fields.code, 'TAKEN');
  const sub = (await s.admin.post('/api/cost-centers', { code: 'CC1G', nameAr: 'قسم', nameEn: 'Dept', parentId: root.id, isGroup: true })).body;
  assert.equal((await s.admin.put('/api/cost-centers/' + root.id, { parentId: sub.id })).body.error.code, 'TREE_CYCLE');
  assert.equal((await s.admin.put('/api/cost-centers/' + root.id, { parentId: line.id })).body.error.code, 'PARENT_NOT_GROUP');
  const admin = (await s.admin.post('/api/cost-centers', { code: 'ADM', nameAr: 'الإدارة العامة', nameEn: 'Head office admin' })).body;   // عام
  assert.equal(admin.branchId, null);
  const sum = (await s.admin.get('/api/cost-centers/summary')).body;
  assert.equal(sum.byType.find((x) => x.code === 'PRODUCTION').total, 2);
  assert.equal(sum.byBranch.find((x) => x.code === 'ALX').total, 3);
  const f = (await s.admin.get(`/api/cost-centers?typeId=${prodType}&isGroup=0`)).body.items.map((x) => x.code);
  assert.deepEqual(f, ['CC11']);
  // المركز التجميعي أو المعطّل لا يُستخدم في حركة جديدة
  assert.throws(() => s.app.services.costCenters.assertUsable(root.id), (e) => e.details.reason === 'GROUP');
  await s.admin.post(`/api/cost-centers/${line.id}/status`, { active: false });
  assert.throws(() => s.app.services.costCenters.assertUsable(line.id), (e) => e.details.reason === 'INACTIVE');
  assert.equal(s.app.services.costCenters.assertUsable(admin.id).id, admin.id);
});

test('cost centers: نطاق الفروع — المحدود يرى فرعه والعام فقط، ولا ينشئ مركزًا عامًا، والمستخدم لا يُحذف', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const b = await branches(s);
  for (const [code, branchId] of [['A1', b.ALX], ['G1', b.GIZ], ['ALL', null]]) await s.admin.post('/api/cost-centers', { code, nameAr: code, nameEn: code, branchId });
  const u = await makeUser(s, { username: 'ccalx', permissions: ['cost_centers.view', 'cost_centers.create', 'cost_centers.update', 'cost_centers.delete'], branchIds: [b.ALX] });
  assert.deepEqual((await u.client.get('/api/cost-centers')).body.items.map((x) => x.code).sort(), ['A1', 'ALL']);
  const g1 = s.app.db.prepare("SELECT id FROM cost_centers WHERE code='G1'").get().id;
  const all = s.app.db.prepare("SELECT id FROM cost_centers WHERE code='ALL'").get().id;
  assert.equal((await u.client.get('/api/cost-centers/' + g1)).status, 404);
  assert.equal((await u.client.put('/api/cost-centers/' + g1, { nameEn: 'x' })).status, 404);
  assert.equal((await u.client.put('/api/cost-centers/' + all, { nameEn: 'x' })).body.error.code, 'BRANCH_SCOPE_EXCEEDED');
  assert.equal((await u.client.post('/api/cost-centers', { code: 'NEWALL', nameAr: 'x', nameEn: 'x' })).body.error.code, 'BRANCH_SCOPE_EXCEEDED');
  assert.equal((await u.client.post('/api/cost-centers', { code: 'A2', nameAr: 'x', nameEn: 'x', branchId: b.GIZ })).body.error.code, 'BRANCH_FORBIDDEN');
  assert.equal((await u.client.post('/api/cost-centers', { code: 'A2', nameAr: 'x', nameEn: 'x', branchId: b.ALX })).status, 200);
  // مركز سبق استخدامه لا يُحذف (وحدة قادمة تسجّل الاستخدام)
  const a1 = s.app.db.prepare("SELECT id FROM cost_centers WHERE code='A1'").get().id;
  s.app.services.usage.register('cost_center', 'probe-docs', (db, id) => id === a1);
  assert.equal((await u.client.del('/api/cost-centers/' + a1)).body.error.code, 'IN_USE');
  assert.equal((await u.client.put('/api/cost-centers/' + a1, { code: 'A1X' })).body.error.code, 'CODE_LOCKED');
});

// ── الخزائن والبنوك ──
test('treasury: خزينة نقدية وحساب بنكي، IBAN، الفرع والعملة، ومنع غير النشط', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const b = await branches(s);
  const egp = (await s.admin.get('/api/currencies/lookup?q=EGP')).body.items[0].id;
  const cash = await s.admin.post('/api/treasuries', { code: 'TILL1', nameAr: 'خزينة الفرع', nameEn: 'Branch till', kind: 'cash', branchId: b.ALX, currencyId: egp });
  assert.equal(cash.status, 200); assert.equal(cash.body.currencyCode, 'EGP');
  assert.equal((await s.admin.post('/api/treasuries', { code: 'T2', nameAr: 'x', nameEn: 'x', kind: 'cash', branchId: b.ALX, currencyId: egp, iban: 'GB82WEST12345698765432' })).body.error.details.fields.iban, 'CASH_NO_BANK_DATA');
  assert.equal((await s.admin.post('/api/treasuries', { code: 'B1', nameAr: 'x', nameEn: 'x', kind: 'bank', branchId: b.ALX, currencyId: egp })).body.error.details.fields.bankName, 'REQUIRED');
  assert.equal((await s.admin.post('/api/treasuries', { code: 'B1', nameAr: 'x', nameEn: 'x', kind: 'bank', bankName: 'بنك', branchId: b.ALX, currencyId: egp, iban: 'GB82WEST12345698765431' })).body.error.details.fields.iban, 'INVALID_IBAN');
  const bank = await s.admin.post('/api/treasuries', { code: 'B1', nameAr: 'حساب جاري', nameEn: 'Current account', kind: 'bank', bankName: 'بنك اختبار', accountNumber: '1234567890', iban: 'gb82 west 1234 5698 7654 32', branchId: b.ALX, currencyId: egp });
  assert.equal(bank.body.iban, 'GB82WEST12345698765432');
  assert.equal((await s.admin.post('/api/treasuries', { code: 'TILL1', nameAr: 'x', nameEn: 'x', kind: 'cash', branchId: b.ALX, currencyId: egp })).body.error.details.fields.code, 'TAKEN');
  // الخزينة غير النشطة/غير المتاحة لا تُستخدم في العمليات الجديدة
  await s.admin.post(`/api/treasuries/${cash.body.id}/status`, { active: false });
  assert.throws(() => s.app.services.treasuries.assertUsable(cash.body.id), (e) => e.details.reason === 'INACTIVE');
  await s.admin.put('/api/treasuries/' + bank.body.id, { isUsable: false });
  assert.throws(() => s.app.services.treasuries.assertUsable(bank.body.id), (e) => e.details.reason === 'NOT_AVAILABLE');
  assert.deepEqual((await s.admin.get('/api/treasuries/lookup?usable=1')).body.items, []);
  // العملة المعطّلة تمنع ربط خزينة جديدة بها، وتجعل الخزينة غير قابلة للاستخدام
  const usd = (await s.admin.post('/api/currencies', { code: 'USD', nameAr: 'دولار', nameEn: 'US dollar', symbol: '$', displayDecimals: 2 })).body;
  const t3 = (await s.admin.post('/api/treasuries', { code: 'T3', nameAr: 'دولار', nameEn: 'USD till', kind: 'cash', branchId: b.HQ, currencyId: usd.id })).body;
  await s.admin.post(`/api/currencies/${usd.id}/status`, { active: false });
  assert.throws(() => s.app.services.treasuries.assertUsable(t3.id), (e) => e.details.reason === 'CURRENCY_INACTIVE');
  assert.equal((await s.admin.post('/api/treasuries', { code: 'T4', nameAr: 'x', nameEn: 'x', kind: 'cash', branchId: b.HQ, currencyId: usd.id })).body.error.code, 'CURRENCY_INACTIVE');
  assert.equal((await s.admin.del('/api/currencies/' + usd.id)).body.error.code, 'IN_USE');
});

test('treasury: البيانات البنكية الحساسة مقنّعة لغير المصرح له في العرض والتصدير والتدقيق، ونطاق الفروع مفروض', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const b = await branches(s);
  const egp = (await s.admin.get('/api/currencies/lookup?q=EGP')).body.items[0].id;
  const mk = (code, branchId) => s.admin.post('/api/treasuries', { code, nameAr: code, nameEn: code, kind: 'bank', bankName: 'بنك', accountNumber: '9988776655', iban: 'GB82WEST12345698765432', branchId, currencyId: egp });
  const alx = (await mk('BALX', b.ALX)).body; await mk('BGIZ', b.GIZ);
  assert.equal(alx.accountNumber, '9988776655');                                          // المدير العام يرى
  const u = await makeUser(s, { username: 'cashier', permissions: ['treasury.view', 'treasury.update', 'treasury.export'], branchIds: [b.ALX] });
  const list = (await u.client.get('/api/treasuries')).body.items;
  assert.deepEqual(list.map((x) => x.code), ['BALX']);                                     // فرعه فقط
  assert.equal(list[0].accountNumber, '••••6655'); assert.equal(list[0].iban, '••••5432'); assert.equal(list[0].sensitiveVisible, false);
  const gizId = s.app.db.prepare("SELECT id FROM treasuries WHERE code='BGIZ'").get().id;
  assert.equal((await u.client.get('/api/treasuries/' + gizId)).status, 404);
  assert.equal((await u.client.put('/api/treasuries/' + alx.id, { iban: 'GB82WEST12345698765432' })).body.error.code, 'SENSITIVE_FORBIDDEN');
  assert.equal((await u.client.put('/api/treasuries/' + alx.id, { nameEn: 'Renamed' })).status, 200);
  const x = await fetch(s.base + '/api/treasuries/export.xlsx', { headers: { cookie: u.client.state.cookie } });
  const txt = require('../server/core/xlsx').readSheet(Buffer.from(await x.arrayBuffer())).flat().join('|');
  assert.ok(!txt.includes('9988776655') && txt.includes('••••6655'));
  // صاحب الصلاحية الخاصة يرى؛ والتدقيق لا يحفظ القيم الحساسة أبدًا
  const v = await makeUser(s, { username: 'treasurer', permissions: ['treasury.view', 'treasury.view_sensitive', 'treasury.update'], branchIds: [b.ALX] });
  assert.equal((await v.client.get('/api/treasuries/' + alx.id)).body.accountNumber, '9988776655');
  await v.client.put('/api/treasuries/' + alx.id, { accountNumber: '1111222233' });
  const audit = s.app.db.prepare("SELECT group_concat(details) d FROM audit_log WHERE entity_type = 'treasury'").get().d;
  assert.ok(!audit.includes('9988776655') && !audit.includes('1111222233') && !audit.includes('GB82WEST'));
  assert.ok(audit.includes('[MASKED]'));
});

// ── شروط وطرق السداد ──
test('payment terms: الأنواع الخمسة، مجموع النسب 100 بالضبط، وجدول الاستحقاق يساوي المبلغ', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const P = (b) => s.admin.post('/api/payment-terms', b);
  const cash = (await s.admin.get('/api/payment-terms?q=CASH')).body.items[0];
  assert.deepEqual(cash.lines.map((l) => [l.dueDays, l.percent]), [[0, '100']]);                 // مرجعي مُهيأ
  const net = (await P({ code: 'NET30', nameAr: 'آجل 30 يوم', nameEn: 'Net 30', kind: 'net', netDays: 30 })).body;
  assert.deepEqual(net.lines.map((l) => [l.dueDays, l.percent]), [[30, '100']]);
  const adv = (await P({ code: 'ADV', nameAr: 'مقدم 30%', nameEn: '30% advance', kind: 'advance', advancePercent: '30', netDays: 60 })).body;
  assert.deepEqual(adv.lines.map((l) => [l.dueDays, l.percent]), [[0, '30'], [60, '70']]);
  const inst = (await P({ code: 'Q3', nameAr: 'ثلاث دفعات', nameEn: 'Three payments', kind: 'installments', lines: [{ dueDays: 0, percent: '33.33333333' }, { dueDays: 30, percent: '33.33333333' }, { dueDays: 60, percent: '33.33333334' }] })).body;
  assert.equal(inst.lines.length, 3);
  assert.equal((await P({ code: 'BAD1', nameAr: 'x', nameEn: 'x', kind: 'installments', lines: [{ dueDays: 0, percent: '50' }, { dueDays: 30, percent: '49.99999999' }] })).body.error.details.fields.lines, 'PERCENT_TOTAL_NOT_100');
  assert.equal((await P({ code: 'BAD2', nameAr: 'x', nameEn: 'x', kind: 'custom', lines: [{ dueDays: 0, percent: 100 }] })).body.error.details.fields['lines.0.percent'], 'DECIMAL_MUST_BE_STRING');
  assert.equal((await P({ code: 'BAD3', nameAr: 'x', nameEn: 'x', kind: 'installments', lines: [{ dueDays: 30, percent: '50' }, { dueDays: 10, percent: '50' }] })).body.error.details.fields['lines.1.dueDays'], 'NOT_ASCENDING');
  assert.equal((await P({ code: 'BAD4', nameAr: 'x', nameEn: 'x', kind: 'advance', advancePercent: '100', netDays: 5 })).body.error.details.fields.advancePercent, 'OUT_OF_RANGE');
  // جدول الاستحقاق: 100 على 3 أقساط ⇒ المجموع 100 بالضبط
  const sch = (await s.admin.post(`/api/payment-terms/${inst.id}/schedule-preview`, { amount: '100', docDate: '2026-01-31' })).body;
  assert.deepEqual(sch.map((x) => [x.dueDate, x.amount]), [['2026-01-31', '33.33333333'], ['2026-03-02', '33.33333333'], ['2026-04-01', '33.33333334']]);
  const sum = s.app.services.decimal.sum(sch.map((x) => x.amount));
  assert.equal(s.app.services.decimal.canonical(sum), '100');
  // تعديل الأقساط يُدقَّق، والتعطيل يمنع الاستخدام
  await s.admin.put('/api/payment-terms/' + net.id, { kind: 'net', netDays: 45 });
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'payment_term.schedule.updated'").get());
  await s.admin.post(`/api/payment-terms/${net.id}/status`, { active: false });
  assert.throws(() => s.app.services.paymentTerms.snapshot(net.id), (e) => e.code === 'NOT_USABLE');
  const methods = (await s.admin.get('/api/payment-methods')).body.items.map((m) => [m.code, m.kind]);
  assert.deepEqual(methods, [['BANK_TRANSFER', 'bank_transfer'], ['CASH', 'cash'], ['CHEQUE', 'cheque']]);
  assert.equal((await s.admin.post('/api/payment-methods', { code: 'CARD', nameAr: 'بطاقة', nameEn: 'Card', kind: 'card', treasuryKind: 'bank' })).status, 200);
});

// ── وحدات القياس ──
test('units: قاموس عام بلا معاملات تحويل، ومنع التكرار بالكود والاسم المطبّع والرمز داخل التصنيف', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const U = (b) => s.admin.post('/api/units', b);
  const seeded = (await s.admin.get('/api/units')).body.items.map((u) => u.code);
  assert.ok(['PCS', 'BOX', 'CTN', 'KG', 'L'].every((c) => seeded.includes(c)));
  assert.equal((await U({ code: 'pcs', nameAr: 'حبة', nameEn: 'Each', category: 'count' })).body.error.details.fields.code, 'TAKEN');
  assert.equal((await U({ code: 'BX2', nameAr: 'عُلبه', nameEn: 'Box two', category: 'count' })).body.error.details.fields.nameAr, 'TAKEN');   // علبة
  assert.equal((await U({ code: 'BX3', nameAr: 'صندوق', nameEn: 'BOX', category: 'count' })).body.error.details.fields.nameEn, 'TAKEN');
  assert.equal((await U({ code: 'KG2', nameAr: 'كيلو', nameEn: 'Kilo', symbol: 'KG', category: 'weight' })).body.error.details.fields.symbol, 'TAKEN');
  assert.equal((await U({ code: 'KGL', nameAr: 'كيلو طول', nameEn: 'Kilo length', symbol: 'kg', category: 'length' })).status, 200);   // نفس الرمز بتصنيف آخر
  const cols = s.app.db.prepare("SELECT name FROM pragma_table_info('units')").all().map((c) => c.name);
  assert.ok(!cols.some((c) => /factor|conversion|ratio/.test(c)));                        // لا معامل تحويل عام
  assert.deepEqual((await s.admin.get('/api/units?q=' + encodeURIComponent('كرتونه'))).body.items.map((u) => u.code), ['CTN']);
  // الاستيراد
  const data = writeSheet({ header: ['الكود', 'الاسم العربي', 'الاسم الإنجليزي', 'الرمز', 'التصنيف'], rows: [['BAG', 'كيس', 'Bag', 'bag', 'count'], ['ROLL', 'لفة', 'Roll', '', 'كمية'], ['BAG', 'كيس2', 'Bag2', '', 'count']] }).toString('base64');
  const p = (await s.admin.post('/api/units/import/preview', { data })).body;
  assert.deepEqual(p.summary, { total: 3, valid: 2, invalid: 1 });
  assert.equal((await s.admin.post('/api/units/import/commit', { data })).status, 409);
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM units WHERE code IN ('BAG','ROLL')").get().c, 0);
});

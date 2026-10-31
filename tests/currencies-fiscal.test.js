'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startReady, makeUser } = require('./helpers');

// ── العملات وأسعار الصرف ──
test('currencies: العملة الأساسية من التأسيس — موجودة تلقائيًا ومحمية', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const list = (await s.admin.get('/api/currencies')).body.items;
  const egp = list.find((c) => c.code === 'EGP');
  assert.equal(egp.isBase, true); assert.equal(egp.nameAr, 'جنيه مصري'); assert.equal(egp.displayDecimals, 2);
  assert.equal((await s.admin.post(`/api/currencies/${egp.id}/status`, { active: false })).body.error.code, 'BASE_CURRENCY_PROTECTED');
  assert.equal((await s.admin.del('/api/currencies/' + egp.id)).body.error.code, 'BASE_CURRENCY_PROTECTED');
  assert.equal((await s.admin.put('/api/currencies/' + egp.id, { code: 'EGX' })).body.error.code, 'BASE_CURRENCY_PROTECTED');
  assert.equal((await s.admin.post(`/api/currencies/${egp.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '1' })).body.error.code, 'BASE_CURRENCY_RATE');
  assert.equal((await s.admin.post('/api/currencies', { code: 'usd', nameAr: 'دولار', nameEn: 'Dollar', displayDecimals: 2 })).body.isIso, true);
  assert.equal((await s.admin.post('/api/currencies', { code: 'XYZ', nameAr: 'تجريبية', nameEn: 'Test unit', displayDecimals: 4 })).body.isIso, false);
  assert.equal((await s.admin.post('/api/currencies', { code: 'US', nameAr: 'x', nameEn: 'x', displayDecimals: 2 })).body.error.details.fields.code, 'INVALID');
});

test('currencies: أسعار بتاريخ سريان — تاريخية، غير قابلة للتعديل، بلا تكرار، وبدقة كاملة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const usd = (await s.admin.post('/api/currencies', { code: 'USD', nameAr: 'دولار', nameEn: 'US dollar', displayDecimals: 2 })).body;
  const R = (b) => s.admin.post(`/api/currencies/${usd.id}/rates`, b);
  assert.equal((await R({ rateType: 'average', effectiveDate: '2026-01-01', rate: '48.5' })).status, 200);
  assert.equal((await R({ rateType: 'average', effectiveDate: '2026-03-01', rate: '49.123456789012' })).status, 200);
  assert.equal((await R({ rateType: 'buy', effectiveDate: '2026-03-01', rate: '49' })).status, 200);
  const dup = await R({ rateType: 'average', effectiveDate: '2026-03-01', rate: '50' });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'RATE_EXISTS');
  assert.equal((await R({ rateType: 'average', effectiveDate: '2026-04-01', rate: '49.1234567890123' })).body.error.details.fields.rate, 'TOO_PRECISE');
  assert.equal((await R({ rateType: 'average', effectiveDate: '2026-04-01', rate: 49.5 })).body.error.details.fields.rate, 'DECIMAL_MUST_BE_STRING');
  assert.equal((await R({ rateType: 'average', effectiveDate: '2026-04-01', rate: '0' })).body.error.details.fields.rate, 'MUST_BE_POSITIVE');
  assert.equal((await R({ rateType: 'average', effectiveDate: '2026-02-30', rate: '1' })).body.error.details.fields.effectiveDate, 'INVALID');
  assert.throws(() => s.app.db.prepare("UPDATE exchange_rates SET rate = '1'").run(), /historical/);
  // السعر الساري = آخر سعر تاريخه ≤ التاريخ المطلوب
  const snap = (d, type = 'average') => s.app.services.currencies.rateSnapshot('USD', d, type);
  assert.equal(snap('2026-02-15').rate, '48.5');
  assert.equal(snap('2026-03-01').rate, '49.123456789012');
  assert.equal(snap('2026-03-01', 'buy').rate, '49');
  assert.throws(() => snap('2025-12-31'), (e) => e.code === 'NO_RATE');
  assert.equal(s.app.services.currencies.rateSnapshot('EGP', '2020-01-01').rate, '1');
  assert.equal((await s.admin.get('/api/currencies/rate?code=USD&date=2026-02-15')).body.rate, '48.5');
  assert.equal((await s.admin.get(`/api/currencies/${usd.id}/rates?type=average`)).body.length, 2);
});

test('currencies: المستند يحفظ لقطة السعر — سعر جديد لاحقًا لا يغيّر حساب المستند القديم', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const usd = (await s.admin.post('/api/currencies', { code: 'USD', nameAr: 'دولار', nameEn: 'US dollar', displayDecimals: 2 })).body;
  await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '48.5' });
  const cur = s.app.services.currencies;
  const docSnap = JSON.parse(JSON.stringify(cur.rateSnapshot('USD', '2026-01-10')));                 // محفوظ داخل المستند
  assert.equal(cur.convert('1234.57', docSnap, 'base'), '59876.645');
  assert.equal(cur.convert('100', docSnap, 'foreign'), '2.06185567');
  await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-05', rate: '60' });   // سعر لاحق الإضافة
  assert.equal(cur.convert('1234.57', docSnap, 'base'), '59876.645');                                // نفس النتيجة
  assert.equal(cur.rateSnapshot('USD', '2026-01-10').rate, '60');                                    // المستندات الجديدة فقط
  // خانات عرض العملة تُستخدم في العرض (ما لم يوجد تخصيص في شاشة الدقة)
  await s.admin.put('/api/currencies/' + usd.id, { displayDecimals: 3 });
  assert.equal(s.app.services.decimal.format('1234.5', 'amount', 'USD'), '1,234.500');
  assert.equal(s.app.services.decimal.format('1234.5', 'amount', 'EGP'), '1,234.50');
});

test('currencies: وجود أسعار صرف يقفل تغيير العملة الأساسية (قواعد المرحلة 1)، وإدارة الأسعار بصلاحية خاصة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  assert.equal((await s.admin.put('/api/company', { baseCurrency: 'SAR' })).status, 200);
  assert.equal((await s.admin.get('/api/currencies')).body.items.find((c) => c.isBase).code, 'SAR');     // سجل الأساسية الجديدة
  await s.admin.put('/api/company', { baseCurrency: 'EGP' });
  const usd = (await s.admin.post('/api/currencies', { code: 'USD', nameAr: 'دولار', nameEn: 'US dollar', displayDecimals: 2 })).body;
  const viewer = await makeUser(s, { username: 'fxview', permissions: ['currencies.view', 'currencies.update'], allBranches: true });
  assert.equal((await viewer.client.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '48' })).status, 403);
  const fx = await makeUser(s, { username: 'fxmgr', permissions: ['currencies.view', 'currencies.manage_rates'], allBranches: true });
  const r = (await fx.client.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '48' })).body;
  const lock = await s.admin.put('/api/company', { baseCurrency: 'SAR' });
  assert.equal(lock.body.error.code, 'BASE_CURRENCY_LOCKED'); assert.deepEqual(lock.body.error.details.sources, ['exchange-rates']);
  assert.equal((await s.admin.del('/api/currencies/' + usd.id)).body.error.code, 'IN_USE');
  assert.equal((await fx.client.del('/api/currencies/rates/' + r.id)).status, 200);                  // سعر غير مستخدم يُحذف ويُدقَّق
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'exchange_rate.deleted'").get());
  assert.equal((await s.admin.put('/api/company', { baseCurrency: 'SAR' })).status, 200);
});

// ── السنوات والفترات المالية ──
test('fiscal: سنة لا تبدأ في يناير ⇒ 12 فترة متصلة، ومنع التداخل والتواريخ غير الصحيحة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const F = (b) => s.admin.post('/api/fiscal-years', b);
  const y = (await F({ code: 'fy2026', nameAr: 'السنة المالية 2026/2027', nameEn: 'FY 2026/27', startDate: '2026-07-01', endDate: '2027-06-30', periodType: 'monthly' })).body;
  assert.equal(y.code, 'FY2026'); assert.equal(y.periodCount, 12); assert.equal(y.status, 'open');
  assert.deepEqual([y.periods[0].startDate, y.periods[0].endDate, y.periods[11].endDate], ['2026-07-01', '2026-07-31', '2027-06-30']);
  for (let i = 1; i < 12; i++) {
    const prev = new Date(y.periods[i - 1].endDate + 'T00:00:00Z'); prev.setUTCDate(prev.getUTCDate() + 1);
    assert.equal(prev.toISOString().slice(0, 10), y.periods[i].startDate);                     // بلا فجوات
  }
  const ov = await F({ code: 'FYX', nameAr: 'x', nameEn: 'x', startDate: '2027-06-30', endDate: '2028-06-29', periodType: 'monthly' });
  assert.equal(ov.status, 409); assert.equal(ov.body.error.code, 'FISCAL_OVERLAP');
  assert.equal((await F({ code: 'FYB', nameAr: 'x', nameEn: 'x', startDate: '2028-02-30', endDate: '2029-01-01', periodType: 'monthly' })).body.error.details.fields.startDate, 'INVALID');
  assert.equal((await F({ code: 'FYB', nameAr: 'x', nameEn: 'x', startDate: '2029-01-01', endDate: '2028-12-31', periodType: 'monthly' })).body.error.details.fields.endDate, 'END_BEFORE_START');
  assert.equal((await F({ code: 'FYB', nameAr: 'x', nameEn: 'x', startDate: '2029-01-01', endDate: '2031-06-30', periodType: 'monthly' })).body.error.details.fields.endDate, 'YEAR_TOO_LONG');
  const q = (await F({ code: 'FY2027Q', nameAr: 'ربع سنوي', nameEn: 'Quarterly', startDate: '2027-07-01', endDate: '2028-06-30', periodType: 'quarterly' })).body;
  assert.equal(q.periodCount, 4);
  // دفاع القاعدة: إدخال مباشر متداخل يُرفض
  assert.throws(() => s.app.db.prepare("INSERT INTO fiscal_years (code,name_ar,name_en,start_date,end_date,period_type) VALUES ('Z','z','z','2026-12-01','2027-01-31','monthly')").run(), /overlap/);
  assert.throws(() => s.app.db.prepare("INSERT INTO fiscal_periods (fiscal_year_id,seq,name_ar,name_en,start_date,end_date) VALUES (?,99,'z','z','2026-07-15','2026-07-20')").run(y.id), /overlap/);
  assert.throws(() => s.app.db.prepare("UPDATE fiscal_periods SET end_date = '2026-08-15' WHERE id = ?").run(y.periods[0].id), /fixed/);
});

test('fiscal: الإغلاق وإعادة الفتح والقفل النهائي — بصلاحيات منفصلة وسبب إلزامي وسجل لا يُعدَّل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const y = (await s.admin.post('/api/fiscal-years', { code: 'FY26', nameAr: '2026', nameEn: '2026', startDate: '2026-01-01', endDate: '2026-12-31', periodType: 'monthly' })).body;
  const jan = y.periods[0].id; const feb = y.periods[1].id;
  const closer = await makeUser(s, { username: 'closer', permissions: ['fiscal_years.view', 'fiscal_years.close'], allBranches: true });
  assert.equal((await closer.client.post(`/api/fiscal-periods/${jan}/close`, {})).body.error.details.fields.reason, 'REQUIRED');
  const c = await closer.client.post(`/api/fiscal-periods/${jan}/close`, { reason: 'انتهاء الشهر وتسوية الحسابات' });
  assert.equal(c.body.status, 'closed');
  assert.equal((await closer.client.post(`/api/fiscal-periods/${jan}/close`, { reason: 'مرة ثانية' })).body.error.code, 'PERIOD_STATUS');
  assert.equal((await closer.client.post(`/api/fiscal-periods/${jan}/reopen`, { reason: 'تصحيح' })).status, 403);   // تحتاج صلاحية خاصة
  const reopener = await makeUser(s, { username: 'reopener', permissions: ['fiscal_years.view', 'fiscal_years.reopen'], allBranches: true });
  assert.equal((await reopener.client.post(`/api/fiscal-periods/${jan}/reopen`, { reason: 'تصحيح خطأ في التسوية' })).body.status, 'open');
  // القفل النهائي: يمنحه المدير العام فقط، ومن حالة مغلقة فقط، ولا رجعة
  const r = await s.admin.post('/api/roles', { nameAr: 'قفل', nameEn: 'Lock', permissions: ['fiscal_years.lock'] });
  assert.equal(r.status, 200);
  const sub = await makeUser(s, { username: 'subfin', permissions: ['roles.view', 'roles.create', 'fiscal_years.lock'], allBranches: true });
  assert.equal((await sub.client.post('/api/roles', { nameAr: 'نسخة', nameEn: 'Copy', permissions: ['fiscal_years.lock'] })).body.error.code, 'SUPER_ADMIN_ONLY');
  assert.equal((await s.admin.post(`/api/fiscal-periods/${feb}/lock`, { reason: 'قفل' })).body.error.code, 'PERIOD_STATUS');
  await s.admin.post(`/api/fiscal-periods/${feb}/close`, { reason: 'إغلاق فبراير' });
  assert.equal((await s.admin.post(`/api/fiscal-periods/${feb}/lock`, { reason: 'اعتماد نهائي بعد المراجعة' })).body.status, 'locked');
  assert.equal((await s.admin.post(`/api/fiscal-periods/${feb}/reopen`, { reason: 'محاولة' })).body.error.code, 'PERIOD_STATUS');
  assert.throws(() => s.app.db.prepare("UPDATE fiscal_periods SET status = 'open' WHERE id = ?").run(feb), /final/);
  // السجل: من ومتى ولماذا — إضافة فقط، وفي التدقيق أيضًا
  const ev = (await s.admin.get(`/api/fiscal-periods/${jan}/events`)).body;
  assert.deepEqual(ev.map((e) => [e.action, e.username]), [['closed', 'closer'], ['reopened', 'reopener']]);
  assert.equal(ev[1].reason, 'تصحيح خطأ في التسوية');
  assert.throws(() => s.app.db.prepare('DELETE FROM fiscal_period_events').run(), /append-only/);
  const acts = s.app.db.prepare("SELECT action, details FROM audit_log WHERE action LIKE 'fiscal_period.%' ORDER BY id").all();
  assert.deepEqual(acts.map((a) => a.action), ['fiscal_period.closed', 'fiscal_period.reopened', 'fiscal_period.closed', 'fiscal_period.locked']);
  assert.equal(JSON.parse(acts[1].details).reason, 'تصحيح خطأ في التسوية');
  // سنة بها فترة غير مفتوحة لا تُحذف
  assert.equal((await s.admin.del('/api/fiscal-years/' + y.id)).body.error.code, 'FISCAL_YEAR_NOT_OPEN');
});

test('fiscal: البنية للمستندات القادمة — assertOpen ترفض التاريخ خارج الفترات أو في فترة غير مفتوحة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const y = (await s.admin.post('/api/fiscal-years', { code: 'FY26', nameAr: '2026', nameEn: '2026', startDate: '2026-01-01', endDate: '2026-12-31', periodType: 'monthly' })).body;
  const f = s.app.services.fiscal;
  assert.equal(f.assertOpen('2026-03-15').seq, 3);
  assert.throws(() => f.assertOpen('2027-01-01'), (e) => e.code === 'NO_FISCAL_PERIOD');
  await s.admin.post(`/api/fiscal-periods/${y.periods[2].id}/close`, { reason: 'إغلاق مارس' });
  assert.throws(() => f.assertOpen('2026-03-15'), (e) => e.code === 'PERIOD_NOT_OPEN' && e.details.status === 'closed');
  assert.deepEqual((await s.admin.get('/api/fiscal-periods/check?date=2026-03-15')).body.open, false);
  // سنة مفتوحة بالكامل وغير مستخدمة تُحذف (لتصحيح الإدخال)
  const y2 = (await s.admin.post('/api/fiscal-years', { code: 'FY27', nameAr: '2027', nameEn: '2027', startDate: '2027-01-01', endDate: '2027-12-31', periodType: 'monthly' })).body;
  assert.equal((await s.admin.del('/api/fiscal-years/' + y2.id)).status, 200);
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM fiscal_periods WHERE fiscal_year_id = ?').get(y2.id).c, 0);
});

test('phase2: لا تأثير على بيانات وإعدادات المرحلة 1 (الشركة، المستخدمون، الفروع، الدقة)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const snap = () => s.app.db.prepare(`SELECT (SELECT group_concat(name_en || base_currency || default_language) FROM company) c,
    (SELECT group_concat(code || is_active || is_main) FROM branches) b, (SELECT group_concat(username || is_active || password_hash) FROM users) u,
    (SELECT group_concat(kind || currency || commit_scale || display_scale || rounding) FROM decimal_policy) p, (SELECT group_concat(key || value) FROM settings) st`).get();
  const before = snap();
  // نشاط كامل في وحدات المرحلة 2
  const root = (await s.admin.post('/api/accounts', { code: '1', nameAr: 'الأصول', nameEn: 'Assets', classCode: 'asset', isGroup: true })).body;
  await s.admin.post('/api/accounts', { code: '1101', nameAr: 'نقدية', nameEn: 'Cash', parentId: root.id });
  await s.admin.post('/api/cost-centers', { code: 'C1', nameAr: 'مركز', nameEn: 'Center' });
  await s.admin.post('/api/fiscal-years', { code: 'FY', nameAr: 'س', nameEn: 'Y', startDate: '2026-01-01', endDate: '2026-12-31', periodType: 'monthly' });
  await s.admin.post('/api/units', { code: 'BAG', nameAr: 'كيس', nameEn: 'Bag', category: 'count' });
  assert.deepEqual(snap(), before);
});

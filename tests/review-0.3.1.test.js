'use strict';
/* مراجعة الإصدار 0.3.1: قرارات اعتماد المرحلة 2 (1–5)، وتصحيح أسعار الصرف بأثر تدقيقي كامل. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODULES } = require('../server/app');
const { MAX_DEPTH } = require('../server/core/master');
const { writeSheet } = require('../server/core/xlsx');
const { startReady, makeUser } = require('./helpers');

// وحدة اختبار تمثل مستندات قادمة تستخدم سعر صرف أو فترة مالية (تسجّل في سجل الارتباطات).
const probe = {
  name: 'usage-probe', dependsOn: ['company-setup'],
  register(router, services) {
    services.db.exec('CREATE TABLE IF NOT EXISTS probe_docs (id INTEGER PRIMARY KEY, rate_id INTEGER, period_id INTEGER) STRICT');
    services.usage.register('exchange_rate', 'probe-docs', (db, id) => !!db.prepare('SELECT 1 FROM probe_docs WHERE rate_id = ?').get(id));
    services.usage.register('fiscal_period', 'probe-docs', (db, id) => !!db.prepare('SELECT 1 FROM probe_docs WHERE period_id = ?').get(id));
  },
};
const newUsd = async (s) => (await s.admin.post('/api/currencies', { code: 'USD', nameAr: 'دولار', nameEn: 'US dollar', displayDecimals: 2 })).body;
const xlsx64 = (header, rows) => writeSheet({ header, rows }).toString('base64');

// ── القرار 2: التصحيح سطر جديد بسبب، والسابق محفوظ، ولا حذف ──
test('0.3.1 تصحيح السعر: سطر جديد بسبب إلزامي، السابق يبقى، والسعر الساري يتغير للمستندات الجديدة فقط', async (t) => {
  const s = await startReady({ modules: [...MODULES, probe] }); t.after(s.stop);
  const db = s.app.db; const cur = s.app.services.currencies;
  const usd = await newUsd(s);
  await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2025-12-01', rate: '47' });
  const r = (await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '48.5' })).body;
  assert.equal(r.kind, 'original'); assert.equal(r.status, 'current');
  const docSnap = JSON.parse(JSON.stringify(cur.rateSnapshot('USD', '2026-01-10')));            // مستند حفظ السعر الخاطئ
  db.prepare('INSERT INTO probe_docs (rate_id) VALUES (?)').run(docSnap.rateId);
  const C = (id, b) => s.admin.post(`/api/currencies/rates/${id}/correct`, b);

  assert.equal((await C(r.id, { rate: '49' })).body.error.details.fields.reason, 'REQUIRED');
  assert.equal((await C(r.id, { rate: '49', reason: 'خ' })).body.error.code, 'VALIDATION');
  assert.equal((await C(r.id, { rate: '48.50', reason: 'نفس القيمة' })).body.error.code, 'NO_CHANGE');
  assert.equal((await C(r.id, { rate: '49.1234567890123', reason: 'دقة زائدة' })).body.error.details.fields.rate, 'TOO_PRECISE');

  const c = await C(r.id, { rate: '49', reason: 'خطأ في إدخال نشرة البنك' });
  assert.equal(c.status, 200);
  assert.equal(c.body.kind, 'correction'); assert.equal(c.body.supersedesId, r.id); assert.equal(c.body.reason, 'خطأ في إدخال نشرة البنك');
  assert.deepEqual(c.body.usedBy, ['probe-docs']);                                              // للعلم: المستند المستخدم لا يتغير

  // السطر الأصلي باقٍ كما هو؛ القائمة تعرض الساري، والسجل يعرض الاثنين بالترتيب
  assert.equal(db.prepare('SELECT rate FROM exchange_rates WHERE id = ?').get(r.id).rate, '48.5');
  const heads = (await s.admin.get(`/api/currencies/${usd.id}/rates`)).body;
  assert.deepEqual(heads.map((x) => [x.effectiveDate, x.rate, x.status, x.hasHistory]), [['2026-01-01', '49', 'current', true], ['2025-12-01', '47', 'current', false]]);
  assert.equal((await s.admin.get(`/api/currencies/${usd.id}/rates?history=1`)).body.length, 3);
  const hist = (await s.admin.get(`/api/currencies/rates/${r.id}/history`)).body;
  assert.deepEqual(hist.map((x) => [x.kind, x.rate, x.status, x.reason]), [['original', '48.5', 'superseded', null], ['correction', '49', 'current', 'خطأ في إدخال نشرة البنك']]);
  assert.equal(hist[1].createdBy, s.app.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id);

  // السعر الساري للمستندات الجديدة = المصحَّح؛ المستند القديم يحسب بلقطته كما هو
  assert.equal(cur.rateSnapshot('USD', '2026-01-10').rate, '49');
  assert.equal(cur.rateSnapshot('USD', '2026-01-10').rateId, c.body.id);
  assert.equal(cur.convert('100', docSnap, 'base'), '4850');
  assert.equal((await s.admin.get(`/api/currencies`)).body.items.find((x) => x.code === 'USD').latestRates.average.rate, '49');

  // سلسلة خطية: تصحيح سطر حلّ غيره محله يُرفض ويدل على السطر الحالي؛ وإضافة نفس التاريخ تدل على التصحيح
  const stale = await C(r.id, { rate: '50', reason: 'تصحيح ثانٍ' });
  assert.equal(stale.body.error.code, 'RATE_SUPERSEDED'); assert.equal(stale.body.error.details.rateId, c.body.id);
  const dup = await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '50' });
  assert.equal(dup.body.error.code, 'RATE_EXISTS'); assert.equal(dup.body.error.details.rateId, c.body.id);

  // التدقيق: من/إلى/السبب/السطر المستبدل
  const ev = JSON.parse(db.prepare("SELECT details FROM audit_log WHERE action = 'exchange_rate.corrected'").get().details);
  assert.equal(ev.from, '48.5'); assert.equal(ev.to, '49'); assert.equal(ev.supersedes, r.id); assert.equal(ev.reason, 'خطأ في إدخال نشرة البنك');
  assert.deepEqual(ev.usedBy, ['probe-docs']);
});

test('0.3.1 إلغاء السعر: سطر إلغاء بسبب (لا حذف)، الساري يعود لما قبله، ويمكن تصحيح الإلغاء لاحقًا', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const db = s.app.db; const cur = s.app.services.currencies;
  const usd = await newUsd(s);
  await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'sell', effectiveDate: '2026-01-01', rate: '48' });
  const wrong = (await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'sell', effectiveDate: '2026-03-01', rate: '52' })).body;   // تاريخ خاطئ
  const V = (id, b) => s.admin.post(`/api/currencies/rates/${id}/void`, b);
  assert.equal((await V(wrong.id, {})).body.error.details.fields.reason, 'REQUIRED');
  const v = await V(wrong.id, { reason: 'التاريخ الصحيح 2026-04-01' });
  assert.equal(v.status, 200); assert.equal(v.body.kind, 'void'); assert.equal(v.body.rate, null); assert.equal(v.body.status, 'void');
  assert.equal(cur.rateSnapshot('USD', '2026-03-15', 'sell').rate, '48');                       // يعود للسعر السابق
  assert.equal((await V(v.body.id, { reason: 'مرة أخرى' })).body.error.code, 'RATE_VOID');
  assert.equal((await V(wrong.id, { reason: 'السطر القديم' })).body.error.code, 'RATE_SUPERSEDED');
  assert.equal(db.prepare('SELECT count(*) c FROM exchange_rates').get().c, 3);                   // لا شيء حُذف
  // تصحيح الإلغاء = إعادة السعر بقيمة (سطر رابع)
  const back = await s.admin.post(`/api/currencies/rates/${v.body.id}/correct`, { rate: '51', reason: 'السعر صحيح في هذا التاريخ بعد المراجعة' });
  assert.equal(back.body.status, 'current');
  assert.equal(cur.rateSnapshot('USD', '2026-03-15', 'sell').rate, '51');
  assert.deepEqual((await s.admin.get(`/api/currencies/rates/${wrong.id}/history`)).body.map((x) => x.kind), ['original', 'void', 'correction']);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'exchange_rate.voided'").get());
});

test('0.3.1 الأسعار لا تُحذف: لا مسار حذف، والقاعدة نفسها ترفض الحذف والتعديل والتصحيح المخالف', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const db = s.app.db;
  const usd = await newUsd(s);
  const r = (await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'buy', effectiveDate: '2026-01-01', rate: '48' })).body;
  assert.ok(!s.app.router.routes.some((x) => x.method === 'DELETE' && x.pattern.includes('rates')));
  assert.notEqual((await s.admin.del('/api/currencies/rates/' + r.id)).status, 200);
  assert.throws(() => db.prepare('DELETE FROM exchange_rates WHERE id = ?').run(r.id), /cannot be deleted/);
  assert.throws(() => db.prepare("UPDATE exchange_rates SET rate = '1' WHERE id = ?").run(r.id), /historical/);
  const ins = db.prepare(`INSERT INTO exchange_rates (currency_id, rate_type, effective_date, entry_kind, rate, supersedes_id, reason)
    VALUES (@c, 'buy', @d, @k, @rate, @s, @why)`);
  const base = { c: usd.id, d: '2026-01-01', k: 'correction', rate: '49', s: r.id, why: 'سبب كافٍ' };
  assert.throws(() => ins.run({ ...base, d: '2026-01-02' }), /keep currency, rate type and effective date/);
  assert.throws(() => ins.run({ ...base, why: null }), /CHECK constraint/);
  assert.throws(() => ins.run({ ...base, k: 'original', s: null, why: null }), /UNIQUE/);           // سلسلة واحدة لكل تاريخ
  ins.run(base);
  assert.throws(() => ins.run({ ...base, rate: '50' }), /UNIQUE/);                                  // لا تفرّع للسلسلة
  assert.equal(db.prepare('SELECT count(*) c FROM exchange_rates').get().c, 2);
  // المشاهد يرى السجل ولا يصحّح
  const viewer = await makeUser(s, { username: 'fxview2', permissions: ['currencies.view'], allBranches: true });
  assert.equal((await viewer.client.get(`/api/currencies/rates/${r.id}/history`)).status, 200);
  assert.equal((await viewer.client.post(`/api/currencies/rates/${r.id}/correct`, { rate: '50', reason: 'محاولة' })).status, 403);
  assert.equal((await viewer.client.post(`/api/currencies/rates/${r.id}/void`, { reason: 'محاولة' })).status, 403);
});

// ── القرار 1: تسجيل أي سعر صرف يقفل العملة الأساسية نهائيًا ──
test('0.3.1 القرار 1: العملة الأساسية تُقفل بأول سعر، وتبقى مقفلة بعد التصحيح والإلغاء', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const usd = await newUsd(s);
  assert.equal((await s.admin.get('/api/company')).body.baseCurrencyLocked, false);
  const r = (await s.admin.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: '48' })).body;
  assert.equal((await s.admin.get('/api/company')).body.baseCurrencyLocked, true);
  await s.admin.post(`/api/currencies/rates/${r.id}/void`, { reason: 'سعر خاطئ' });
  const lock = await s.admin.put('/api/company', { baseCurrency: 'SAR' });
  assert.equal(lock.status, 409); assert.equal(lock.body.error.code, 'BASE_CURRENCY_LOCKED');
  assert.deepEqual(lock.body.error.details.sources, ['exchange-rates']);
});

// ── القرار 3: الاستيراد يضيف فقط ──
test('0.3.1 القرار 3: استيراد Excel يضيف فقط — كود موجود يُرفض ولا يُعدَّل السجل القائم', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const root = (await s.admin.post('/api/accounts', { code: '1', nameAr: 'الأصول', nameEn: 'Assets', classCode: 'asset', isGroup: true })).body;
  const before = s.app.db.prepare('SELECT * FROM accounts WHERE id = ?').get(root.id);
  const hdr = ['code', 'name_ar', 'name_en', 'parent_code', 'class', 'is_group'];
  const data = xlsx64(hdr, [['1', 'اسم جديد', 'New name', '', 'asset', '1'], ['2', 'الخصوم', 'Liabilities', '', 'liability', '1']]);
  const p = (await s.admin.post('/api/accounts/import/preview', { data })).body;
  assert.deepEqual(p.rows[0].errors.map((e) => e.code), ['CODE_EXISTS']);
  assert.equal((await s.admin.post('/api/accounts/import/commit', { data })).body.error.code, 'IMPORT_HAS_ERRORS');
  assert.deepEqual(s.app.db.prepare('SELECT * FROM accounts WHERE id = ?').get(root.id), before);
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM accounts WHERE code = '2'").get().c, 0);   // الكل أو لا شيء
});

// ── القرار 4: الحد الأقصى للشجرة 15 مستوى (الإدخال والاستيراد) ──
test('0.3.1 القرار 4: حد الشجرة 15 مستوى في الإدخال المباشر والاستيراد', async (t) => {
  const s = await startReady(); t.after(s.stop);
  assert.equal(MAX_DEPTH, 15);
  const rows = [['L1', 'م1', 'L1', '', 'asset', '1']];
  for (let i = 2; i <= 16; i++) rows.push(['L' + i, 'م' + i, 'L' + i, 'L' + (i - 1), '', '1']);
  const p = (await s.admin.post('/api/accounts/import/preview', { data: xlsx64(['code', 'name_ar', 'name_en', 'parent_code', 'class', 'is_group'], rows) })).body;
  assert.deepEqual(p.rows.filter((r) => r.errors.length).map((r) => [r.line, r.errors[0].code]), [[17, 'TREE_TOO_DEEP']]);
  const ok = xlsx64(['code', 'name_ar', 'name_en', 'parent_code', 'class', 'is_group'], rows.slice(0, 15));
  assert.deepEqual((await s.admin.post('/api/accounts/import/commit', { data: ok })).body, { created: 15 });
  const leaf = s.app.db.prepare("SELECT id FROM accounts WHERE code = 'L15'").get().id;
  assert.equal((await s.admin.post('/api/accounts', { code: 'L16', nameAr: 'م', nameEn: 'L', parentId: leaf })).body.error.code, 'TREE_TOO_DEEP');
});

// ── القرار 5: حذف السنة فقط إن لم تُستخدم وكل فتراتها مفتوحة (وبلا سجل إغلاق) ──
test('0.3.1 القرار 5: حذف السنة المالية — مسموح للسنة غير المستخدمة المفتوحة فقط', async (t) => {
  const s = await startReady({ modules: [...MODULES, probe] }); t.after(s.stop);
  const db = s.app.db;
  const Y = (code, start, end) => s.admin.post('/api/fiscal-years', { code, nameAr: code, nameEn: code, startDate: start, endDate: end, periodType: 'monthly' });
  const fresh = (await Y('FY24', '2024-01-01', '2024-12-31')).body;
  assert.equal((await s.admin.del('/api/fiscal-years/' + fresh.id)).status, 200);
  assert.ok(db.prepare("SELECT 1 FROM audit_log WHERE action = 'fiscal_year.deleted'").get());

  const used = (await Y('FY25', '2025-01-01', '2025-12-31')).body;
  const p = (await s.admin.get(`/api/fiscal-years/${used.id}`)).body.periods[0].id;
  db.prepare('INSERT INTO probe_docs (period_id) VALUES (?)').run(p);
  const r1 = await s.admin.del('/api/fiscal-years/' + used.id);
  assert.equal(r1.body.error.code, 'IN_USE'); assert.deepEqual(r1.body.error.details.usedBy, ['probe-docs']);

  const reopened = (await Y('FY26', '2026-01-01', '2026-12-31')).body;
  const q = (await s.admin.get(`/api/fiscal-years/${reopened.id}`)).body.periods[0].id;
  await s.admin.post(`/api/fiscal-periods/${q}/close`, { reason: 'إغلاق' });
  assert.equal((await s.admin.del('/api/fiscal-years/' + reopened.id)).body.error.code, 'FISCAL_YEAR_NOT_OPEN');
  await s.admin.post(`/api/fiscal-periods/${q}/reopen`, { reason: 'إعادة فتح' });
  assert.equal((await s.admin.del('/api/fiscal-years/' + reopened.id)).body.error.code, 'FISCAL_YEAR_HAS_HISTORY');   // كل الفترات مفتوحة لكن لها سجل
  assert.equal(db.prepare('SELECT count(*) c FROM fiscal_years').get().c, 2);
});

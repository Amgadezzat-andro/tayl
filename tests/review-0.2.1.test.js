'use strict';
/* مراجعة الإصدار 0.2.1: قرارات المنتج المعتمدة + مراجعة محرك الدقة + مراجعة الصلاحيات بطلبات مباشرة للخادم. */
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODULES } = require('../server/app');
const { createDecimalService, createPolicy, defaultRows } = require('../server/core/decimal');
const { startReady, makeUser, ADMIN } = require('./helpers');

const D = createDecimalService();
const S = (x) => D.canonical(x);

// ── القرار 2: العملة الأساسية ──

// وحدة اختبار تمثل وحدة مالية قادمة: مستندات بحالة draft/approved/posted.
const finance = {
  name: 'finance-probe', dependsOn: ['company-setup'],
  register(router, services) {
    services.db.exec("CREATE TABLE IF NOT EXISTS probe_fin (id INTEGER PRIMARY KEY, status TEXT NOT NULL) STRICT");
    services.financialActivity.register('probe-docs', (db) => !!db.prepare("SELECT 1 FROM probe_fin WHERE status IN ('approved','posted') LIMIT 1").get());
  },
};

test('0.2.1 العملة: تتغير قبل النشاط المالي مع تدقيق صريح، وتُقفل بعد وجود بيانات معتمدة', async (t) => {
  const s = await startReady({ modules: [...MODULES, finance] }); t.after(s.stop);
  const db = s.app.db;
  assert.equal((await s.admin.get('/api/company')).body.baseCurrencyLocked, false);
  const ok = await s.admin.put('/api/company', { baseCurrency: 'SAR' });
  assert.equal(ok.status, 200); assert.equal(ok.body.baseCurrency, 'SAR');
  const ev = db.prepare("SELECT details FROM audit_log WHERE action = 'company.base_currency.changed'").get();
  assert.deepEqual(JSON.parse(ev.details).from, 'EGP');
  assert.deepEqual(JSON.parse(ev.details).to, 'SAR');

  db.prepare("INSERT INTO probe_fin (status) VALUES ('draft')").run();                 // المسودة لا تُقفل
  assert.equal((await s.admin.put('/api/company', { baseCurrency: 'EGP' })).status, 200);

  db.prepare("INSERT INTO probe_fin (status) VALUES ('approved')").run();              // بيانات معتمدة (ليست قيدًا)
  const c = (await s.admin.get('/api/company')).body;
  assert.equal(c.baseCurrencyLocked, true); assert.deepEqual(c.baseCurrencyLockedBy, ['probe-docs']);
  const locked = await s.admin.put('/api/company', { baseCurrency: 'USD' });
  assert.equal(locked.status, 409); assert.equal(locked.body.error.code, 'BASE_CURRENCY_LOCKED');
  assert.deepEqual(locked.body.error.details.sources, ['probe-docs']);
  assert.equal(db.prepare('SELECT base_currency FROM company').get().base_currency, 'EGP');
  // باقي البيانات وإعادة إرسال نفس العملة مسموحة
  assert.equal((await s.admin.put('/api/company', { baseCurrency: 'EGP', taxNumber: '111-222-333' })).status, 200);
  assert.equal(db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'company.base_currency.changed'").get().c, 2);
});

// ── القرار 3: النسب المئوية ──

test('0.2.1 النسب: 14 تعني 14% — الحساب والاعتماد والتخزين والعرض والتقريب', async (t) => {
  assert.equal(S(D.percentOf('1000', '14')), '140');
  assert.equal(S(D.percentOf('1000', '0.14')), '1.4');                               // 0.14 تعني 0.14% وليست 14%
  assert.equal(S(D.percentOf('0.07', '14')), '0.0098');
  assert.equal(S(D.percentOf('333.33333333', '14')), '46.6666666662');                 // دقيق قبل الاعتماد
  assert.equal(D.commit(D.percentOf('333.33333333', '14'), 'amount'), '46.66666667');
  assert.equal(D.commit(D.percentOf('-250', '14'), 'amount'), '-35');                  // إشعار دائن سالب
  assert.equal(S(D.percentOf('100', '12.5')), '12.5');
  assert.equal(S(D.percentOf('99999999999999999999.99999999', '100')), '99999999999999999999.99999999');
  // تقريب النصف بقاعدتين على مبلغ الضريبة (عند خانتين)
  const p2 = (mode) => createDecimalService(createPolicy(defaultRows().map((r) => (r.kind === 'amount' ? { ...r, commitScale: 2, rounding: mode } : r))));
  assert.equal(p2('HALF_UP').commit(D.percentOf('0.25', '10'), 'amount'), '0.03');      // 0.025
  assert.equal(p2('HALF_EVEN').commit(D.percentOf('0.25', '10'), 'amount'), '0.02');
  // التخزين: 8 خانات للنسبة، الشكل القانوني، والحدود
  assert.equal(D.commit('14', 'rate'), '14');
  assert.equal(D.commit('14.123456789', 'rate'), '14.12345679');
  assert.throws(() => D.toStorage('14.123456789', 'rate'), (e) => e.code === 'SCALE_EXCEEDED');
  assert.throws(() => D.assertPercent('100.00000001'), (e) => e.code === 'RATE_OUT_OF_RANGE');
  assert.throws(() => D.assertPercent('-0.5'), (e) => e.code === 'RATE_OUT_OF_RANGE');
  assert.equal(S(D.assertPercent('0')), '0'); assert.equal(S(D.assertPercent('100')), '100');
  // العرض
  assert.equal(D.formatPercent('14'), '14.00%');
  assert.equal(D.formatPercent('0.125'), '0.13%');
  // مرجع مستقل: base × rate ÷ 100 بأعداد صحيحة
  for (const [b, r] of [['123.45', '14'], ['-0.01', '5'], ['7', '33.33333333'], ['1000000.5', '0.00000001']]) {
    const [bi, bf = ''] = b.replace('-', '').split('.'); const [ri, rf = ''] = r.split('.');
    const n = BigInt(bi + bf) * BigInt(ri + rf) * (b.startsWith('-') ? -1n : 1n);
    const scale = bf.length + rf.length + 2;
    assert.equal(D.cmp(D.percentOf(b, r), D.div(n.toString(), (10n ** BigInt(scale)).toString())), 0, `${b} × ${r}%`);
  }
  // عبر الخادم: معاينة نوع النسبة تعرض %
  const s = await startReady(); t.after(s.stop);
  const prev = await s.admin.post('/api/precision/preview', { kind: 'rate', value: '14' });
  assert.deepEqual([prev.body.stored, prev.body.display], ['14', '14.00%']);
});

// ── مراجعة المحرك: التوزيع، الحتمية، لقطات السياسة ──

test('0.2.1 التوزيع: قاعدة ثابتة للباقي، نتائج متطابقة عند الإعادة، ويساوي المجموع حسب سياسة الاعتماد', () => {
  // القاعدة: كل جزء يُقرَّب لأسفل بوحدة الاعتماد، والوحدات الباقية لأكبر الكسور، والتعادل للأسبق ترتيبًا.
  assert.deepEqual(D.allocate('0.00000002', ['1', '1', '1'], 'amount'), ['0.00000001', '0.00000001', '0']);
  assert.deepEqual(D.allocate('100', ['1', '1', '1'], 'amount'), ['33.33333334', '33.33333333', '33.33333333']);
  assert.deepEqual(D.allocate('10', ['1', '2', '1'], 'amount'), ['2.5', '5', '2.5']);
  assert.deepEqual(D.allocate('1', ['0', '1', '0'], 'amount'), ['0', '1', '0']);
  assert.deepEqual(D.allocate('0', ['1', '1'], 'amount'), ['0', '0']);
  assert.deepEqual(D.allocate('-100', ['1', '1', '1'], 'amount'), ['-33.33333334', '-33.33333333', '-33.33333333']);
  // حسب العملة: الدينار الكويتي 3 خانات
  const kwd = createDecimalService(createPolicy([...defaultRows(), { kind: 'amount', currency: 'KWD', commitScale: 3, displayScale: 3, rounding: 'HALF_UP' }]));
  assert.deepEqual(kwd.allocate('10', ['1', '1', '1'], 'amount', 'KWD'), ['3.334', '3.333', '3.333']);
  assert.throws(() => kwd.allocate('10.0001', ['1', '1'], 'amount', 'KWD'), (e) => e.code === 'NOT_COMMITTED');
  // الحتمية: نفس المدخلات 200 مرة = نفس النتيجة حرفيًا
  const w = ['3.3', '1.7', '0.00000001', '9', '2.25'];
  const first = JSON.stringify(D.allocate('12345.67891234', w, 'amount'));
  for (let i = 0; i < 200; i++) assert.equal(JSON.stringify(D.allocate('12345.67891234', w, 'amount')), first);
  assert.equal(S(D.sum(JSON.parse(first))), '12345.67891234');
});

test('0.2.1 تغيير السياسة لا يغيّر المستندات المعتمدة سابقًا، واللقطة تعيد الحساب كما كان', async (t) => {
  const svc = createDecimalService();
  const snapBefore = svc.snapshot('amount', '');
  const storedBefore = svc.commit('1.23456789', 'amount');                               // معتمد بـ 8 خانات
  const partsBefore = svc.allocate('100', ['1', '1', '1'], 'amount');
  svc.setPolicy(createPolicy(defaultRows().map((r) => (r.kind === 'amount' ? { ...r, commitScale: 2, displayScale: 2 } : r))));
  assert.equal(svc.commit('1.23456789', 'amount'), '1.23');                              // العمليات الجديدة فقط
  assert.equal(svc.commit('1.23456789', 'amount', '', snapBefore), storedBefore);        // إعادة الحساب باللقطة
  assert.deepEqual(svc.allocate('100', ['1', '1', '1'], 'amount', '', snapBefore), partsBefore);
  assert.equal(S(svc.fromStorage(storedBefore, 'amount')), '1.23456789');                // المخزن يُقرأ كما هو
  assert.throws(() => svc.round('1', 'amount', '', { ...snapBefore, commitScale: 99 }), (e) => e.code === 'BAD_POLICY');
  assert.throws(() => svc.round('1', 'quantity', '', snapBefore), (e) => e.code === 'BAD_POLICY');

  // عبر الخادم والقاعدة: قيمة محفوظة قبل تعديل السياسة لا تتغير بعده
  const s = await startReady(); t.after(s.stop);
  const db = s.app.db;
  db.exec('CREATE TABLE probe_lines (id INTEGER PRIMARY KEY, amount TEXT NOT NULL, policy TEXT NOT NULL) STRICT');
  const dec = s.app.services.decimal;
  const snap = dec.snapshot('amount', 'EGP');
  db.prepare('INSERT INTO probe_lines (amount, policy) VALUES (?, ?)').run(dec.commit('10.987654321', 'amount', 'EGP'), JSON.stringify(snap));
  const rows = (await s.admin.get('/api/precision')).body.rows.map((r) => (r.kind === 'amount' ? { ...r, commitScale: 2, displayScale: 2, rounding: 'DOWN' } : r));
  assert.equal((await s.admin.put('/api/precision', { rows })).status, 200);
  const line = db.prepare('SELECT * FROM probe_lines').get();
  assert.equal(line.amount, '10.98765432');
  assert.equal(dec.commit('10.987654321', 'amount', 'EGP', JSON.parse(line.policy)), line.amount);
  assert.equal(dec.commit('10.987654321', 'amount', 'EGP'), '10.98');
});

test('0.2.1 الاتزان: مقارنة قيمية دقيقة بلا هامش سماح', () => {
  assert.equal(D.balance(['1.10'], ['1.1']).balanced, true);                              // نفس القيمة بشكل مختلف
  assert.equal(D.balance(['1.1'], ['1.10000001']).balanced, false);
  assert.equal(D.balance(['-5', '5'], ['0']).balanced, true);
  const r = D.balance(['33.33333334', '33.33333333', '33.33333333'], ['100']);
  assert.equal(r.balanced, true); assert.equal(r.difference, '0');
  assert.equal(D.balance(['33.33333333', '33.33333333', '33.33333333'], ['100']).difference, '-0.00000001');
});

// ── القرار 4: رؤية المستخدمين مقيدة بنطاق الفروع ──

async function branches(s) {
  const id = (code) => s.app.db.prepare('SELECT id FROM branches WHERE code = ?').get(code).id;
  for (const code of ['ALX', 'GIZ']) await s.admin.post('/api/branches', { code, nameAr: 'فرع ' + code, nameEn: 'Branch ' + code });
  return { HQ: id('HQ'), ALX: id('ALX'), GIZ: id('GIZ') };
}

test('0.2.1 المستخدمون: المحدود يرى ويدير مستخدمي نطاقه فقط — في كل المسارات', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const b = await branches(s);
  const mgr = await makeUser(s, { username: 'alxmgr', permissions: ['users.view', 'users.update', 'users.disable', 'audit.view'], branchIds: [b.ALX] });
  const inScope = await makeUser(s, { username: 'alxclerk', branchIds: [b.ALX] });
  const other = await makeUser(s, { username: 'gizclerk', branchIds: [b.GIZ] });
  const mixed = await makeUser(s, { username: 'mixed1', branchIds: [b.ALX, b.GIZ] });
  const global = await makeUser(s, { username: 'everywhere', allBranches: true });
  const adminId = s.app.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  const c = mgr.client;

  assert.deepEqual((await c.get('/api/users')).body.map((u) => u.username).sort(), ['alxclerk', 'alxmgr']);
  for (const hidden of [other.id, mixed.id, global.id, adminId]) {
    assert.equal((await c.get(`/api/users/${hidden}`)).status, 404);
    assert.equal((await c.put(`/api/users/${hidden}`, { displayName: 'x' })).status, 404);
    assert.equal((await c.post(`/api/users/${hidden}/status`, { active: false })).status, 404);
    assert.equal((await c.post(`/api/users/${hidden}/password`, { password: 'Hack-Pass-99' })).status, 404);
  }
  assert.equal((await c.get(`/api/users/${inScope.id}`)).status, 200);
  assert.equal((await c.put(`/api/users/${inScope.id}`, { displayName: 'Clerk A' })).status, 200);
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM users WHERE is_active = 1').get().c, 6);   // لم يُعطَّل أحد
  // لوحة المعلومات وسجل التدقيق مقيدان بنفس النطاق
  assert.equal((await c.get('/api/dashboard')).body.counts.users, 2);
  const actors = new Set((await c.get('/api/audit?limit=1000')).body.map((r) => r.actor));
  assert.ok(!actors.has('admin') && !actors.has('gizclerk'), [...actors].join(','));
  // لا يُخرج مستخدمًا من رؤيته بإزالة كل فروعه
  const emptied = await c.put(`/api/users/${inScope.id}`, { branchIds: [] });
  assert.equal(emptied.status, 400); assert.equal(emptied.body.error.details.fields.branchIds, 'REQUIRED');
});

test('0.2.1 المستخدمون: الصلاحية الشاملة users.manage_all صريحة ويمنحها المدير العام فقط', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const b = await branches(s);
  // المدير العام يمنحها
  const hr = await makeUser(s, { username: 'hradmin', permissions: ['users.view', 'users.create', 'users.update', 'users.manage_all', 'roles.view', 'roles.create'], branchIds: [b.HQ] });
  const giz = await makeUser(s, { username: 'gizclerk', branchIds: [b.GIZ] });
  const list = (await hr.client.get('/api/users')).body.map((u) => u.username);
  assert.ok(list.includes('gizclerk') && list.includes('admin'));
  assert.equal((await hr.client.put(`/api/users/${giz.id}`, { displayName: 'Giza clerk' })).status, 200);
  // لكنه لا يمنحها لغيره (حتى وهو يملكها) ولا يدير المدير العام
  const r = await hr.client.post('/api/roles', { nameAr: 'نسخة', nameEn: 'Copy', permissions: ['users.manage_all'] });
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'SUPER_ADMIN_ONLY');
  const adminId = s.app.db.prepare("SELECT id FROM users WHERE username = 'admin'").get().id;
  assert.equal((await hr.client.put(`/api/users/${adminId}`, { displayName: 'x' })).body.error.code, 'SUPER_ADMIN_ONLY');
  // مدير محدود بلا الصلاحية الشاملة لا ينشئ مستخدمًا بلا فروع (يخرج عن رؤيته)
  const mgr = await makeUser(s, { username: 'alxmgr', permissions: ['users.view', 'users.create'], branchIds: [b.ALX] });
  const none = await mgr.client.post('/api/users', { username: 'orphan1', displayName: 'O', password: 'Orph-Pass-12' });
  assert.equal(none.status, 400); assert.equal(none.body.error.details.fields.branchIds, 'REQUIRED');
  // الصلاحية تظهر في الكتالوج كصلاحية خاصة محجوزة
  const cat = (await s.admin.get('/api/permissions')).body.resources.find((x) => x.resource === 'users');
  assert.deepEqual([cat.special, cat.superOnlyGrant], [['manage_all'], ['manage_all']]);
});

// ── مراجعة الصلاحيات بطلبات مباشرة لكل مسار ──

test('0.2.1 الصلاحيات: العرض لا يمنح أي تعديل — كل مسار مغيِّر يرفض صاحب صلاحيات العرض فقط', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const viewPerms = (await s.admin.get('/api/permissions')).body.resources.map((r) => r.resource + '.view');
  const viewer = await makeUser(s, { username: 'viewall', permissions: viewPerms, allBranches: true });
  const before = s.app.db.prepare("SELECT (SELECT group_concat(name_en) FROM company) c, (SELECT count(*) FROM branches) b, (SELECT count(*) FROM roles) r, (SELECT group_concat(value) FROM settings) st").get();
  const mutating = s.app.router.routes.filter((r) => r.permission && r.method !== 'GET' && !r.permission.endsWith('.view'));
  assert.ok(mutating.length >= 15, String(mutating.length));
  for (const r of mutating) {
    const p = r.pattern.replace(/:[a-z]+/g, '1');
    const res = await viewer.client[{ POST: 'post', PUT: 'put', DELETE: 'del' }[r.method]](p, r.method === 'DELETE' ? undefined : { active: false, nameEn: 'x', rows: [] });
    assert.equal(res.status, 403, `${r.method} ${r.pattern}`);
    assert.equal(res.body.error.code, 'FORBIDDEN', `${r.method} ${r.pattern}`);
  }
  // مسارات القراءة بصلاحية view تعمل له؛ ومسارات GET التي تتطلب غيرها (تصدير/طباعة/استيراد/إنشاء — م2) تُرفض.
  // (بعض مسارات العرض تتطلب معاملات استعلام فقد ترد 400؛ المهم ألا ترد 403.)
  for (const r of s.app.router.routes.filter((x) => x.method === 'GET' && x.permission && !x.pattern.includes(':'))) {
    const st = (await viewer.client.get(r.pattern)).status;
    if (r.permission.endsWith('.view')) assert.notEqual(st, 403, r.pattern);
    else assert.equal(st, 403, `${r.pattern} (${r.permission})`);
  }
  const after = s.app.db.prepare("SELECT (SELECT group_concat(name_en) FROM company) c, (SELECT count(*) FROM branches) b, (SELECT count(*) FROM roles) r, (SELECT group_concat(value) FROM settings) st").get();
  assert.deepEqual(after, before);
});

test('0.2.1 الصلاحيات: مستخدم بلا أي صلاحية يُرفض في كل مسار يطلب صلاحية (قراءة وتعديل)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const nobody = await makeUser(s, { username: 'nobody1' });
  const routes = s.app.router.routes.filter((r) => r.permission);
  assert.ok(routes.length >= 25);
  for (const r of routes) {
    const p = r.pattern.replace(/:[a-z]+/g, '1');
    const res = await nobody.client[{ GET: 'get', POST: 'post', PUT: 'put', DELETE: 'del' }[r.method]](p, ['GET', 'DELETE'].includes(r.method) ? undefined : {});
    assert.equal(res.status, 403, `${r.method} ${r.pattern}`);
  }
  // ما يُسمح لأي مستخدم مسجّل: جلسته ولوحته وحسابه فقط
  assert.equal((await nobody.client.get('/api/dashboard')).status, 200);
  assert.deepEqual((await nobody.client.get('/api/dashboard')).body.counts, { branches: null, users: null, roles: null });
});

test('0.2.1 الحماية: لا تسريب لتجزئة كلمات المرور أو الجلسات، والتدقيق باقٍ إضافة فقط وبلا أسرار', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const u = await makeUser(s, { username: 'probeuser' });
  await s.admin.post(`/api/users/${u.id}/password`, { password: 'Reset-Pass-77' });
  for (const p of ['/api/users', `/api/users/${u.id}`, '/api/auth/session', '/api/dashboard', '/api/audit?limit=1000']) {
    const txt = (await s.admin.get(p)).text;
    assert.ok(!/scrypt\$|password_hash|token_hash|Reset-Pass-77|Temp-Pass-123|Real-Pass-456/.test(txt), p);
  }
  assert.ok(!/csrf_token/.test((await s.admin.get('/api/audit?limit=1000')).text));
  assert.throws(() => s.app.db.prepare("UPDATE audit_log SET actor = 'x'").run(), /append-only/);
  assert.throws(() => s.app.db.prepare('DELETE FROM audit_log').run(), /append-only/);
  assert.equal((await s.client().login('probeuser', 'Reset-Pass-77')).body.user.mustChangePassword, true);
  assert.equal((await s.client().login(ADMIN.username, ADMIN.password)).status, 200);
});

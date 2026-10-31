'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { writeSheet, readSheet } = require('../server/core/xlsx');
const { startReady, makeUser } = require('./helpers');

const A = (s) => ({
  post: (b) => s.admin.post('/api/accounts', b),
  put: (id, b) => s.admin.put('/api/accounts/' + id, b),
});

async function seed(s) {
  const a = A(s);
  const root = (await a.post({ code: '1', nameAr: 'الأصول', nameEn: 'Assets', classCode: 'asset', isGroup: true })).body;
  const cur = (await a.post({ code: '11', nameAr: 'الأصول المتداولة', nameEn: 'Current assets', parentId: root.id, isGroup: true })).body;
  const cash = (await a.post({ code: '1101', nameAr: 'الصندوق الرئيسي', nameEn: 'Main cash', parentId: cur.id })).body;
  const liab = (await a.post({ code: '2', nameAr: 'الالتزامات', nameEn: 'Liabilities', classCode: 'liability', isGroup: true })).body;
  return { root, cur, cash, liab };
}

test('accounts: بناء الشجرة — المستوى والمسار والتصنيف الموروث والطبيعة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const { root, cur, cash } = await seed(s);
  assert.deepEqual([root.level, cur.level, cash.level], [1, 2, 3]);
  assert.equal(cash.classCode, 'asset');                 // موروث من الأب
  assert.equal(cash.normalBalance, 'debit');             // من التصنيف
  assert.equal(cash.isGroup, false);
  const row = s.app.db.prepare('SELECT path FROM accounts WHERE id = ?').get(cash.id);
  assert.equal(row.path, `/${root.id}/${cur.id}/${cash.id}/`);
  const accum = (await A(s).post({ code: '1199', nameAr: 'مجمع الإهلاك', nameEn: 'Accumulated depreciation', parentId: cur.id,
    typeId: s.app.db.prepare("SELECT id FROM account_types WHERE code='ACCUM_DEPR'").get().id })).body;
  assert.equal(accum.normalBalance, 'credit');            // حساب مقابل: الطبيعة من النوع
  const tree = (await s.admin.get('/api/accounts/tree')).body;
  assert.deepEqual(tree.map((r) => r.code), ['1', '11', '1101', '1199', '2']);
  assert.deepEqual(tree.map((r) => r.hasChildren), [true, true, false, false, false]);
  assert.deepEqual((await s.admin.get('/api/accounts/classes')).body.map((c) => c.code), ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense']);
});

test('accounts: منع الأكواد المكررة والأب التفصيلي وعدم تطابق التصنيف والنوع', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const { root, cash, liab } = await seed(s);
  const dup = await A(s).post({ code: '1101', nameAr: 'س', nameEn: 'x', parentId: root.id });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.details.fields.code, 'TAKEN');
  assert.equal((await A(s).post({ code: 'ab-1', nameAr: 'س', nameEn: 'x', classCode: 'asset' })).body.code, 'AB-1');
  assert.equal((await A(s).post({ code: 'Ab-1', nameAr: 'س', nameEn: 'x', classCode: 'asset' })).body.error.details.fields.code, 'TAKEN');
  assert.equal((await A(s).post({ code: '110101', nameAr: 'س', nameEn: 'x', parentId: cash.id })).body.error.code, 'PARENT_NOT_GROUP');
  assert.equal((await A(s).post({ code: '1102', nameAr: 'س', nameEn: 'x', parentId: root.id, classCode: 'expense' })).body.error.code, 'CLASS_MISMATCH');
  const salesType = s.app.db.prepare("SELECT id FROM account_types WHERE code='SALES'").get().id;
  assert.equal((await A(s).post({ code: '1103', nameAr: 'س', nameEn: 'x', parentId: root.id, typeId: salesType })).body.error.code, 'TYPE_CLASS_MISMATCH');
  assert.equal((await A(s).post({ code: '9', nameAr: 'س', nameEn: 'x' })).body.error.details.fields.classCode, 'REQUIRED');
  assert.equal((await A(s).put(cash.id, { parentId: liab.id })).body.error.code, 'CLASS_MISMATCH');
  // دفاع في القاعدة نفسها
  assert.throws(() => s.app.db.prepare("INSERT INTO accounts (code,name_ar,name_en,parent_id,path,level,class_code,normal_balance) VALUES ('X1','x','x',?, '', 1, 'asset','debit')").run(cash.id), /group/);
});

test('accounts: منع الدورات والعمق الزائد، والنقل يحدّث المسار والمستوى للفروع', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const { root, cur, cash } = await seed(s);
  assert.equal((await A(s).put(root.id, { parentId: cur.id })).body.error.code, 'TREE_CYCLE');
  assert.equal((await A(s).put(root.id, { parentId: root.id })).body.error.code, 'TREE_CYCLE');
  // نقل المجموعة 11 تحت مجموعة جديدة 10 ⇒ 1101 يصبح في المستوى 4
  const g = (await A(s).post({ code: '10', nameAr: 'مجموعة', nameEn: 'Group', parentId: root.id, isGroup: true })).body;
  assert.equal((await A(s).put(cur.id, { parentId: g.id })).status, 200);
  const moved = (await s.admin.get('/api/accounts/' + cash.id)).body;
  assert.equal(moved.level, 4);
  assert.equal(s.app.db.prepare('SELECT path FROM accounts WHERE id = ?').get(cash.id).path, `/${root.id}/${g.id}/${cur.id}/${cash.id}/`);
  // حد العمق (15)
  let parent = root.id;
  for (let i = 2; i <= 15; i++) parent = (await A(s).post({ code: 'D' + i, nameAr: 'م' + i, nameEn: 'L' + i, parentId: parent, isGroup: true })).body.id;
  const deep = await A(s).post({ code: 'D16', nameAr: 'م', nameEn: 'L', parentId: parent });
  assert.equal(deep.body.error.code, 'TREE_TOO_DEEP');
});

test('accounts: الحذف والتعطيل وتحويل النوع وإعادة الترتيب وفق القواعد', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const { root, cur, cash } = await seed(s);
  assert.equal((await s.admin.del('/api/accounts/' + cur.id)).body.error.code, 'HAS_CHILDREN');
  assert.equal((await A(s).put(cur.id, { isGroup: false })).body.error.code, 'HAS_CHILDREN');
  assert.equal((await s.admin.post(`/api/accounts/${root.id}/status`, { active: false })).body.error.code, 'HAS_ACTIVE_CHILDREN');
  assert.equal((await s.admin.post(`/api/accounts/${cash.id}/status`, { active: false })).body.isActive, false);
  assert.equal((await s.admin.post(`/api/accounts/${cur.id}/status`, { active: false })).body.isActive, false);
  assert.equal((await s.admin.post(`/api/accounts/${cash.id}/status`, { active: true })).body.error.code, 'PARENT_INACTIVE');
  await s.admin.post(`/api/accounts/${cur.id}/status`, { active: true });
  // إعادة الترتيب: الهوية والكود لا يتغيران
  const b = (await A(s).post({ code: '1102', nameAr: 'البنك', nameEn: 'Bank', parentId: cur.id })).body;
  assert.deepEqual((await s.admin.get('/api/accounts/tree')).body.filter((r) => r.parentId === cur.id).map((r) => r.code), ['1101', '1102']);
  const r = await s.admin.post(`/api/accounts/${b.id}/reorder`, { direction: 'up' });
  assert.equal(r.body.id, b.id); assert.equal(r.body.code, '1102');
  assert.deepEqual((await s.admin.get('/api/accounts/tree')).body.filter((x) => x.parentId === cur.id).map((x) => x.code), ['1102', '1101']);
  // حذف حساب ورقي غير مستخدم
  assert.equal((await s.admin.del('/api/accounts/' + b.id)).status, 200);
  const acts = s.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'account.%' ORDER BY id").all().map((x) => x.action);
  assert.ok(['account.created', 'account.deactivated', 'account.activated', 'account.reordered', 'account.deleted'].every((a) => acts.includes(a)));
});

test('accounts: الحساب المستخدم (مرتبط بخزينة) لا يُحذف ولا يتغير كوده، والتجميعي لا يقبل الربط', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const { cur, cash, liab } = await seed(s);
  const egp = (await s.admin.get('/api/currencies/lookup?q=EGP')).body.items[0];
  const branch = s.app.db.prepare("SELECT id FROM branches WHERE code='HQ'").get().id;
  const base = { code: 'T1', nameAr: 'خزينة', nameEn: 'Till', kind: 'cash', branchId: branch, currencyId: egp.id };
  assert.equal((await s.admin.post('/api/treasuries', { ...base, accountId: cur.id })).body.error.reason, undefined);
  assert.equal((await s.admin.post('/api/treasuries', { ...base, accountId: cur.id })).body.error.code, 'NOT_USABLE');      // تجميعي
  const pay = (await A(s).post({ code: '2101', nameAr: 'موردون', nameEn: 'Suppliers', parentId: liab.id })).body;
  assert.equal((await s.admin.post('/api/treasuries', { ...base, accountId: pay.id })).body.error.code, 'ACCOUNT_NOT_ASSET');
  assert.equal((await s.admin.post('/api/treasuries', { ...base, accountId: cash.id })).status, 200);
  assert.equal((await s.admin.del('/api/accounts/' + cash.id)).body.error.code, 'IN_USE');
  assert.equal((await A(s).put(cash.id, { code: '1109' })).body.error.code, 'CODE_LOCKED');
  assert.equal((await A(s).put(cash.id, { nameEn: 'Main till' })).status, 200);            // الاسم مسموح
  assert.throws(() => s.app.services.accounts.assertPostable(cur.id), (e) => e.code === 'NOT_USABLE' && e.details.reason === 'GROUP');
});

test('accounts: البحث بالكود والاسم العربي والإنجليزي، جزئي ومتسامح مع الكتابة العربية', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const { cur } = await seed(s);
  await A(s).post({ code: '1110', nameAr: 'مصروفات مدفوعة مقدمًا', nameEn: 'Prepaid Expenses', parentId: cur.id });
  await A(s).post({ code: '1120', nameAr: 'أوراق القبض', nameEn: 'Notes receivable', parentId: cur.id });
  const q = async (x) => (await s.admin.get('/api/accounts?q=' + encodeURIComponent(x))).body.items.map((r) => r.code);
  assert.deepEqual(await q('1101'), ['1101']);
  assert.deepEqual(await q('11'), ['11', '1101', '1110', '1120']);          // الكود المطابق تمامًا أولًا
  assert.deepEqual(await q('prepaid'), ['1110']);                          // إنجليزي بلا حساسية حالة
  assert.deepEqual(await q('مدفوعه'), ['1110']);                           // ة/ه
  assert.deepEqual(await q('اوراق'), ['1120']);                            // أ/ا
  assert.deepEqual(await q('صندوق'), ['1101']);                            // جزئي
  assert.deepEqual(await q('١١٠١'), ['1101']);                             // أرقام عربية
  assert.deepEqual(await q('%'), []);                                       // لا حقن LIKE
  const lk = (await s.admin.get('/api/accounts/lookup?q=1&usable=1')).body;
  assert.ok(lk.items.every((r) => !r.isGroup));
  assert.equal((await s.admin.get('/api/accounts/lookup?q=1&limit=2')).body.hasMore, true);
  const tree = (await s.admin.get('/api/accounts/tree?q=' + encodeURIComponent('صندوق'))).body;
  assert.deepEqual(tree.map((r) => [r.code, r.match]), [['1', false], ['11', false], ['1101', true]]);   // المطابقة مع أسلافها
});

test('accounts: التصدير Excel والطباعة بعناوين اللغة المختارة، وبصلاحياتهما فقط', async (t) => {
  const s = await startReady(); t.after(s.stop);
  await seed(s);
  const r = await fetch(s.base + '/api/accounts/export.xlsx?lang=ar', { headers: { cookie: s.admin.state.cookie } });
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /spreadsheetml/);
  const rows = readSheet(Buffer.from(await r.arrayBuffer()));
  assert.equal(rows[0][0], 'كود الحساب');
  assert.deepEqual(rows.slice(1).map((x) => x[0]), ['1', '11', '1101', '2']);
  const en = (await s.admin.get('/api/accounts/print?lang=en')).body;
  assert.equal(en.columns[0], 'Account code');
  assert.equal(en.rows.length, 4);
  const viewer = await makeUser(s, { username: 'accview', permissions: ['accounts.view'], allBranches: true });
  assert.equal((await viewer.client.get('/api/accounts/export.xlsx')).status, 403);
  assert.equal((await viewer.client.get('/api/accounts/print')).status, 403);
  assert.equal((await viewer.client.post('/api/accounts/import/preview', { data: 'AAAA' })).status, 403);
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'accounts.exported'").get().c, 1);
});

const xlsx64 = (header, rows) => writeSheet({ header, rows }).toString('base64');
const HDR = ['كود الحساب', 'الاسم العربي', 'الاسم الإنجليزي', 'كود الأب', 'التصنيف', 'تجميعي'];

test('accounts import: المعاينة تكشف كل الأخطاء، والحفظ يرفض الملف كله إن وُجد خطأ واحد', async (t) => {
  const s = await startReady(); t.after(s.stop);
  await seed(s);
  const data = xlsx64(HDR, [
    ['3', 'حقوق الملكية', 'Equity', '', 'حقوق الملكية', 'نعم'],
    ['31', 'رأس المال', 'Capital', '3', '', 'لا'],
    ['1101', 'مكرر مع القاعدة', 'Dup', '11', '', 'لا'],           // CODE_EXISTS
    ['32', 'أ', 'A', '3', '', 'لا'], ['32', 'ب', 'B', '3', '', 'لا'],   // DUPLICATE_IN_FILE
    ['33', 'بلا أب', 'Orphan', '99', '', 'لا'],                  // PARENT_NOT_FOUND
    ['34', 'تحت تفصيلي', 'Under detail', '31', '', 'لا'],         // PARENT_NOT_GROUP
    ['35', 'تصنيف مختلف', 'Mismatch', '3', 'الإيرادات', 'لا'],     // CLASS_MISMATCH
    ['36', 'منطقي خاطئ', 'Bad bool', '3', '', 'ربما'],            // INVALID
    ['C1', 'دورة 1', 'Cycle 1', 'C2', '', 'نعم'], ['C2', 'دورة 2', 'Cycle 2', 'C1', 'equity', 'نعم'],   // TREE_CYCLE
    ['37', '', 'No arabic name', '3', '', 'لا'],                  // REQUIRED
  ]);
  const p = (await s.admin.post('/api/accounts/import/preview', { data })).body;
  assert.equal(p.summary.total, 12);
  const err = (line) => p.rows.find((r) => r.line === line).errors.map((e) => e.code);
  assert.deepEqual(err(2), []); assert.deepEqual(err(3), []);
  assert.ok(err(4).includes('CODE_EXISTS'));
  assert.ok(err(5).includes('DUPLICATE_IN_FILE') && err(6).includes('DUPLICATE_IN_FILE'));
  assert.ok(err(7).includes('PARENT_NOT_FOUND'));
  assert.ok(err(8).includes('PARENT_NOT_GROUP'));
  assert.ok(err(9).includes('CLASS_MISMATCH'));
  assert.ok(err(10).includes('INVALID'));
  assert.ok(err(11).includes('TREE_CYCLE') || err(12).includes('TREE_CYCLE'));
  assert.ok(err(13).includes('REQUIRED'));
  const before = s.app.db.prepare('SELECT count(*) c FROM accounts').get().c;
  const c = await s.admin.post('/api/accounts/import/commit', { data });
  assert.equal(c.status, 409); assert.equal(c.body.error.code, 'IMPORT_HAS_ERRORS');
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM accounts').get().c, before);            // لا حفظ جزئي
});

test('accounts import: ملف سليم (الأبناء قبل الآباء، عناوين عربية) يُحفظ كله في معاملة واحدة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const data = fs.readFileSync(path.join(__dirname, 'fixtures/openpyxl-accounts.xlsx')).toString('base64');
  const p = (await s.admin.post('/api/accounts/import/preview', { data })).body;
  assert.deepEqual(p.summary, { total: 5, valid: 5, invalid: 0 });
  const c = await s.admin.post('/api/accounts/import/commit', { data });
  assert.deepEqual(c.body, { created: 5 });
  const tree = (await s.admin.get('/api/accounts/tree')).body;
  assert.deepEqual(tree.map((r) => [r.code, r.level, r.classCode, r.isGroup]),
    [['1', 1, 'asset', true], ['11', 2, 'asset', true], ['1101', 3, 'asset', false], ['1102', 3, 'asset', false], ['2', 1, 'liability', true]]);
  // ترتيب الملف معكوس (الابن أولًا) يعمل أيضًا
  const rev = xlsx64(['code', 'name_ar', 'name_en', 'parent_code', 'class', 'is_group'], [['41', 'مبيعات', 'Sales', '4', '', '0'], ['4', 'الإيرادات', 'Revenue', '', 'revenue', '1']]);
  assert.deepEqual((await s.admin.post('/api/accounts/import/commit', { data: rev })).body, { created: 2 });
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'accounts.imported'").get().c, 2);
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'account.created'").get().c, 7);
  // ملف غير Excel / بلا الأعمدة الإلزامية / القالب
  assert.equal((await s.admin.post('/api/accounts/import/preview', { data: Buffer.from('hello').toString('base64') })).body.error.code, 'BAD_XLSX');
  assert.deepEqual((await s.admin.post('/api/accounts/import/preview', { data: xlsx64(['code'], [['1']]) })).body.error.details.missing, ['name_ar', 'name_en']);
  const tpl = await fetch(s.base + '/api/accounts/import/template.xlsx?lang=en', { headers: { cookie: s.admin.state.cookie } });
  assert.equal(readSheet(Buffer.from(await tpl.arrayBuffer()))[0][0], 'code *');
});

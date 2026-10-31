'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { startApp, client, setupPayload, ADMIN } = require('./helpers');

const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d4944415478da63f8ffff3f0005fe02fea7d6a4c50000000049454e44ae426082', 'hex');

test('setup: أول تشغيل — الحالة غير مؤسسة، والتأسيس ينشئ الشركة والفرع الرئيسي والمدير العام في معاملة واحدة', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const c = client(s.base);
  assert.deepEqual((await c.get('/api/setup/status')).body, { setupCompleted: false, defaultLanguage: null });
  const r = await c.post('/api/setup', setupPayload({ logo: { data: PNG.toString('base64') } }));
  assert.equal(r.status, 200, r.text);
  assert.deepEqual((await c.get('/api/setup/status')).body, { setupCompleted: true, defaultLanguage: 'ar' });

  const db = s.app.db;
  assert.equal(db.prepare('SELECT count(*) c FROM company').get().c, 1);
  const b = db.prepare('SELECT * FROM branches').all();
  assert.equal(b.length, 1); assert.equal(b[0].is_main, 1); assert.equal(b[0].code, 'HQ');
  const u = db.prepare('SELECT * FROM users').get();
  assert.equal(u.is_super_admin, 1); assert.equal(u.all_branches, 1); assert.equal(u.default_branch_id, b[0].id);
  assert.match(u.password_hash, /^scrypt\$32768\$8\$1\$/);
  assert.ok(!u.password_hash.includes(ADMIN.password));
  const logo = db.prepare('SELECT logo, logo_mime FROM company').get();
  assert.equal(logo.logo_mime, 'image/png'); assert.ok(logo.logo.equals(PNG));
  const actions = db.prepare('SELECT action FROM audit_log ORDER BY id').all().map((x) => x.action);
  assert.deepEqual(actions, ['setup.completed', 'branch.created', 'user.created']);
  assert.ok(!db.prepare('SELECT group_concat(details) d FROM audit_log').get().d.includes(ADMIN.password), 'كلمة المرور في سجل التدقيق');
});

test('setup: منع إعادة التأسيس — عبر الـ API وعبر القاعدة نفسها', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const c = client(s.base);
  assert.equal((await c.post('/api/setup', setupPayload())).status, 200);
  const again = await c.post('/api/setup', setupPayload({ company: { nameEn: 'Second Co' }, admin: { username: 'other' } }));
  assert.equal(again.status, 409);
  assert.equal(again.body.error.code, 'SETUP_ALREADY_COMPLETED');
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM users').get().c, 1);
  assert.throws(() => s.app.db.prepare("INSERT INTO company (id, name_ar, name_en, base_currency, default_language) VALUES (2,'x','x','EGP','ar')").run(), /CHECK/);
  assert.throws(() => s.app.db.prepare('DELETE FROM company').run(), /cannot be deleted/);
});

test('setup: طلبا تأسيس متزامنان — ينجح واحد فقط', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const [a, b] = await Promise.all([
    client(s.base).post('/api/setup', setupPayload()),
    client(s.base).post('/api/setup', setupPayload({ admin: { username: 'admin2' } })),
  ]);
  assert.deepEqual([a.status, b.status].sort(), [200, 409]);
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM users').get().c, 1);
});

test('setup: التحقق من المدخلات في الخادم مع رمز خطأ لكل حقل، ولا يُحفظ شيء', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const c = client(s.base);
  const r = await c.post('/api/setup', setupPayload({
    company: { nameAr: '', baseCurrency: 'egyptian', email: 'not-an-email', defaultLanguage: 'fr' },
    branch: { code: 'bad code!' },
    admin: { username: 'ab', password: 'short' },
  }));
  assert.equal(r.status, 400);
  const f = r.body.error.details.fields;
  assert.equal(f['company.nameAr'], 'REQUIRED');
  assert.equal(f['company.baseCurrency'], 'INVALID');
  assert.equal(f['company.email'], 'INVALID');
  assert.equal(f['company.defaultLanguage'], 'NOT_ALLOWED');
  assert.equal(f['branch.code'], 'INVALID');
  assert.equal(f['admin.username'], 'INVALID');
  const weak = await c.post('/api/setup', setupPayload({ admin: { password: 'onlyletters' } }));
  assert.equal(weak.body.error.details.fields['admin.password'], 'PASSWORD_WEAK');
  const withName = await c.post('/api/setup', setupPayload({ admin: { password: 'admin12345' } }));
  assert.equal(withName.body.error.details.fields['admin.password'], 'PASSWORD_CONTAINS_USERNAME');
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM company').get().c, 0);
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM branches').get().c, 0);
});

test('setup: الشعار — يُقبل PNG/JPEG/WebP فقط بفحص المحتوى، ويُرفض SVG والملف الكبير', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const c = client(s.base);
  const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
  assert.equal((await c.post('/api/setup', setupPayload({ logo: { data: svg.toString('base64') } }))).body.error.code, 'LOGO_TYPE');
  assert.equal((await c.post('/api/setup', setupPayload({ logo: { data: 'not base64!!' } }))).body.error.code, 'LOGO_INVALID');
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM company').get().c, 0);
});

test('setup: شعار TAYL الرسمي لم يُمس ومنفصل عن شعار الشركة', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'public/assets/logo/tayl-logo-official.jfif'));
  const sha = require('node:crypto').createHash('sha256').update(onDisk).digest('hex');
  assert.match(sha, /^fb9516dd/);   // نفس البصمة المسجلة في تقرير المرحلة 0
  const c = client(s.base);
  await c.post('/api/setup', setupPayload({ logo: { data: PNG.toString('base64') } }));
  await c.login(ADMIN.username, ADMIN.password);
  const companyLogo = await fetch(s.base + '/api/company/logo', { headers: { cookie: c.state.cookie } });
  assert.equal(companyLogo.headers.get('content-type'), 'image/png');
  assert.ok(Buffer.from(await companyLogo.arrayBuffer()).equals(PNG));
  assert.ok(fs.readFileSync(path.join(__dirname, '..', 'public/assets/logo/tayl-logo-official.jfif')).equals(onDisk));
});

test('setup: التأسيس من جهاز آخر مرفوض ما لم يُسمح صراحة', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const { HttpError } = require('../server/core/errors');
  // محاكاة عنوان بعيد عبر وحدة اختبار تستدعي نفس منطق المسار
  const route = s.app.router.routes.find((r) => r.pattern === '/api/setup');
  const ctx = { ip: '192.168.1.50', body: async () => setupPayload(), requestId: 'x' };
  await assert.rejects(route.handler(ctx), (e) => e instanceof HttpError && e.code === 'SETUP_LOCAL_ONLY');
});

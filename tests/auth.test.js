'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { loadConfig } = require('../server/core/config');
const { createApp } = require('../server/app');
const { startApp, startReady, client, setupPayload, makeUser, ADMIN, tmpDir, silent } = require('./helpers');

test('auth: الدخول يضع كوكي HttpOnly + SameSite=Strict، ويُخزَّن hash الجلسة فقط', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const c = client(s.base);
  await c.post('/api/setup', setupPayload());
  const r = await c.login(ADMIN.username, ADMIN.password);
  assert.equal(r.status, 200);
  const sc = r.headers.get('set-cookie');
  assert.match(sc, /tayl_sid=[A-Za-z0-9_-]{40,}/);
  assert.match(sc, /HttpOnly/); assert.match(sc, /SameSite=Strict/); assert.match(sc, /Path=\//);
  assert.ok(!/Secure/.test(sc));   // HTTP محلي في الاختبار (auto)
  assert.equal(r.body.user.username, 'admin');
  assert.equal(r.body.user.isSuperAdmin, true);
  assert.equal(r.body.branch.code, 'HQ');
  assert.ok(r.body.csrfToken.length >= 32);
  const token = /tayl_sid=([^;]+)/.exec(sc)[1];
  const row = s.app.db.prepare('SELECT * FROM sessions').get();
  assert.equal(row.token_hash, crypto.createHash('sha256').update(token).digest('hex'));
  assert.ok(!JSON.stringify(row).includes(token));
});

test('auth: الكوكي Secure عند الإعداد cookieSecure=true', async (t) => {
  const s = await startApp({ config: { cookieSecure: true } }); t.after(s.stop);
  const c = client(s.base);
  await c.post('/api/setup', setupPayload());
  assert.match((await c.login(ADMIN.username, ADMIN.password)).headers.get('set-cookie'), /; Secure/);
});

test('auth: بيانات خاطئة => 401 بنفس الرسالة لاسم موجود وغير موجود، ويُسجَّل الفشل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const a = await s.client().login('admin', 'wrong-password-1');
  const b = await s.client().login('ghost', 'wrong-password-1');
  assert.equal(a.status, 401); assert.equal(b.status, 401);
  assert.equal(a.body.error.code, 'INVALID_CREDENTIALS'); assert.deepEqual(a.body.error.message, b.body.error.message);
  const fails = s.app.db.prepare("SELECT details FROM audit_log WHERE action = 'auth.login.failure'").all().map((r) => JSON.parse(r.details));
  assert.deepEqual(fails.map((f) => f.username), ['admin', 'ghost']);
  assert.ok(fails.every((f) => !JSON.stringify(f).includes('wrong-password-1')));
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'auth.login.success'").get().c, 1);
});

test('auth: القفل بعد محاولات متكررة (حتى لاسم غير موجود) ويستمر بعد كلمة صحيحة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  for (let i = 0; i < 4; i++) assert.equal((await s.client().login('admin', 'bad-pass-' + i)).status, 401);
  const fifth = await s.client().login('admin', 'bad-pass-5');
  assert.equal(fifth.status, 429);
  const correct = await s.client().login('admin', ADMIN.password);
  assert.equal(correct.status, 429);                      // مقفل حتى مع كلمة صحيحة
  assert.ok(correct.body.error.details.retryAfterSeconds > 0);
  for (let i = 0; i < 5; i++) await s.client().login('nobody', 'bad-pass-' + i);
  assert.equal((await s.client().login('nobody', 'x')).status, 429);
  assert.ok(s.app.db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'auth.login.blocked'").get().c >= 2);
  // انتهاء مدة القفل يعيد السماح
  s.app.db.prepare('UPDATE login_throttle SET locked_until = 1, window_start = 1').run();
  assert.equal((await s.client().login('admin', ADMIN.password)).status, 200);
});

test('auth: الخروج ينهي الجلسة على الخادم (الكوكي القديم لا يعمل بعدها)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const cookie = s.admin.state.cookie;
  assert.equal((await s.admin.get('/api/auth/session')).status, 200);
  const out = await s.admin.post('/api/auth/logout');
  assert.equal(out.status, 200);
  assert.match(out.headers.get('set-cookie'), /Max-Age=0/);
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM sessions').get().c, 0);
  const replay = await fetch(s.base + '/api/auth/session', { headers: { cookie } });
  assert.equal(replay.status, 401);
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM audit_log WHERE action = 'auth.logout'").get().c, 1);
});

test('auth: انتهاء الجلسة بالخمول وبالحد المطلق', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const db = s.app.db;
  db.prepare('UPDATE sessions SET last_seen_at = ?').run(Date.now() - 31 * 60000);   // الافتراضي 30 دقيقة
  assert.equal((await s.admin.get('/api/auth/session')).status, 401);
  assert.equal(db.prepare('SELECT count(*) c FROM sessions').get().c, 0);
  await s.admin.login(ADMIN.username, ADMIN.password);
  db.prepare('UPDATE sessions SET expires_at = ?').run(Date.now() - 1);
  assert.equal((await s.admin.get('/api/auth/session')).status, 401);
});

test('auth: كل مسار محمي يرفض بلا جلسة (401) — لا توجد شاشة/مسار محمي مفتوح', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const anon = s.client();
  const protectedRoutes = s.app.router.routes.filter((r) => !r.public);
  assert.ok(protectedRoutes.length >= 25);
  for (const r of protectedRoutes) {
    const p = r.pattern.replace(/:[a-z]+/g, '1');
    const res = await anon[{ GET: 'get', POST: 'post', PUT: 'put', DELETE: 'del' }[r.method]](p, r.method === 'GET' || r.method === 'DELETE' ? undefined : {});
    assert.equal(res.status, 401, `${r.method} ${r.pattern}`);
  }
  // المسارات العامة محدودة ومعروفة
  assert.deepEqual(s.app.router.routes.filter((r) => r.public).map((r) => `${r.method} ${r.pattern}`).sort(),
    ['GET /api/setup/status', 'GET /api/system/health', 'GET /api/system/info', 'GET /api/system/modules', 'POST /api/auth/login', 'POST /api/setup'].sort());
});

test('auth: مسار لا يعلن متطلبات الوصول يُرفض حتى للمدير العام (fail-closed)', async (t) => {
  const undeclared = { name: 'probe2', dependsOn: ['security'], register(r) { r.get('/api/probe2/x', () => ({ leaked: true })); } };
  const { MODULES } = require('../server/app');
  const s = await startReady({ modules: [...MODULES, undeclared] }); t.after(s.stop);
  const r = await s.admin.get('/api/probe2/x');
  assert.equal(r.status, 403); assert.equal(r.body.error.code, 'ROUTE_NOT_DECLARED');
});

test('auth: CSRF — طلب مغيِّر بلا رمز أو برمز خاطئ يُرفض، وOrigin مختلف يُرفض', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const body = { nameAr: 'دور', nameEn: 'Role', permissions: [] };
  const noToken = await s.admin.post('/api/roles', body, { csrf: false });
  assert.equal(noToken.status, 403); assert.equal(noToken.body.error.code, 'CSRF_INVALID');
  const wrong = await s.admin.post('/api/roles', body, { csrf: false, headers: { 'x-csrf-token': 'x'.repeat(43) } });
  assert.equal(wrong.body.error.code, 'CSRF_INVALID');
  const evil = await s.admin.post('/api/roles', body, { headers: { origin: 'http://evil.example' } });
  assert.equal(evil.status, 403); assert.equal(evil.body.error.code, 'CROSS_ORIGIN');
  const site = await s.admin.post('/api/roles', body, { headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(site.body.error.code, 'CROSS_ORIGIN');
  const sameOrigin = await s.admin.post('/api/roles', body, { headers: { origin: s.base } });
  assert.equal(sameOrigin.status, 200);
  // نموذج HTML (text/plain) لا يمر
  const form = await fetch(s.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ username: 'admin', password: ADMIN.password }) });
  assert.equal(form.status, 415);
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM roles').get().c, 1);
});

test('auth: تغيير كلمة المرور — يتحقق من الحالية، يطبق السياسة، وينهي الجلسات الأخرى', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const other = s.client(); await other.login(ADMIN.username, ADMIN.password);
  const wrong = await s.admin.post('/api/auth/password', { currentPassword: 'nope-123x', newPassword: 'New-Pass-789' });
  assert.equal(wrong.body.error.details.fields.currentPassword, 'WRONG_PASSWORD');
  const weak = await s.admin.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'abc' });
  assert.equal(weak.body.error.details.fields.newPassword, 'TOO_SHORT');
  const same = await s.admin.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: ADMIN.password });
  assert.equal(same.body.error.details.fields.newPassword, 'PASSWORD_UNCHANGED');
  assert.equal((await s.admin.post('/api/auth/password', { currentPassword: ADMIN.password, newPassword: 'New-Pass-789' })).status, 200);
  assert.equal((await other.get('/api/auth/session')).status, 401);     // الجهاز الآخر خرج
  assert.equal((await s.admin.get('/api/auth/session')).status, 200);   // الحالي باقٍ
  assert.equal((await s.client().login('admin', ADMIN.password)).status, 401);
  assert.equal((await s.client().login('admin', 'New-Pass-789')).status, 200);
  const details = s.app.db.prepare('SELECT group_concat(details) d FROM audit_log').get().d;
  assert.ok(!details.includes('New-Pass-789') && !details.includes(ADMIN.password));
});

test('auth: مستخدم جديد مُلزم بتغيير كلمة المرور قبل أي عملية', async (t) => {
  const s = await startReady(); t.after(s.stop);
  await s.admin.post('/api/users', { username: 'clerk', displayName: 'Clerk', password: 'Temp-Pass-1' });
  const c = s.client();
  const l = await c.login('clerk', 'Temp-Pass-1');
  assert.equal(l.body.user.mustChangePassword, true);
  assert.equal((await c.get('/api/dashboard')).body.error.code, 'PASSWORD_CHANGE_REQUIRED');
  assert.equal((await c.post('/api/auth/password', { currentPassword: 'Temp-Pass-1', newPassword: 'Mine-Pass-22' })).status, 200);
  assert.equal((await c.get('/api/dashboard')).status, 200);
});

test('auth: تعطيل المستخدم ينهي جلساته فورًا ويمنع دخوله', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const u = await makeUser(s, { username: 'temp1' });
  assert.equal((await u.client.get('/api/auth/session')).status, 200);
  assert.equal((await s.admin.post(`/api/users/${u.id}/status`, { active: false })).status, 200);
  assert.equal((await u.client.get('/api/auth/session')).status, 401);
  const again = await s.client().login('temp1', u.password);
  assert.equal(again.status, 403); assert.equal(again.body.error.code, 'ACCOUNT_DISABLED');
});

test('auth: إعادة تشغيل البرنامج تحفظ البيانات والجلسات وإعدادات الدقة', async () => {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir, port: 0 });
  let app = await createApp({ config, logger: silent });
  let addr = await app.listen();
  let c = client(`http://127.0.0.1:${addr.port}`);
  await c.post('/api/setup', setupPayload());
  await c.login(ADMIN.username, ADMIN.password);
  const rows = (await c.get('/api/precision')).body.rows.map((r) => (r.kind === 'amount' ? { ...r, commitScale: 4, displayScale: 2 } : r));
  assert.equal((await c.put('/api/precision', { rows })).status, 200);
  await c.post('/api/branches', { code: 'ALX', nameAr: 'فرع اختبار', nameEn: 'Test Branch' });
  const cookie = c.state.cookie;
  await app.close();

  app = await createApp({ config, logger: silent });
  assert.deepEqual(app.migrationsApplied, []);
  addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  const s2 = await fetch(base + '/api/auth/session', { headers: { cookie } });
  assert.equal(s2.status, 200);                                   // الجلسة باقية بعد إعادة التشغيل
  assert.equal(D(app).round('1.23456', 'amount').toFixed(), '1.2346');   // السياسة المحفوظة حُمّلت
  c = client(base); await c.login(ADMIN.username, ADMIN.password);
  assert.deepEqual((await c.get('/api/branches')).body.map((b) => b.code), ['HQ', 'ALX']);
  assert.equal((await c.get('/api/setup/status')).body.setupCompleted, true);
  await app.close();
});
const D = (app) => app.services.decimal;

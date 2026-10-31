'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { startReady, makeUser } = require('./helpers');

test('rbac: الصلاحية تُفرض في الخادم لكل مسار — العرض لا يعني التعديل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const viewer = await makeUser(s, { username: 'viewer', permissions: ['company.view', 'branches.view'], allBranches: true });
  const c = viewer.client;
  assert.equal((await c.get('/api/company')).status, 200);
  const put = await c.put('/api/company', { nameEn: 'Hacked' });
  assert.equal(put.status, 403); assert.equal(put.body.error.code, 'FORBIDDEN');
  for (const [m, p] of [['get', '/api/users'], ['get', '/api/roles'], ['get', '/api/settings'], ['get', '/api/precision'], ['get', '/api/audit'], ['post', '/api/branches']]) {
    assert.equal((await c[m](p, m === 'post' ? { code: 'X', nameAr: 'x', nameEn: 'x' } : undefined)).status, 403, p);
  }
  assert.equal(s.app.db.prepare('SELECT name_en FROM company').get().name_en, 'Test Company');
  const dash = (await c.get('/api/dashboard')).body;
  assert.equal(dash.counts.users, null);         // لا يرى عدد المستخدمين بلا صلاحية
  assert.equal(dash.counts.branches, 1);
});

test('rbac: صلاحيات تعدد الأدوار = اتحادها، وتعديل الدور يسري فورًا على الجلسات القائمة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const r1 = (await s.admin.post('/api/roles', { nameAr: 'أ', nameEn: 'A', permissions: ['company.view'] })).body;
  const r2 = (await s.admin.post('/api/roles', { nameAr: 'ب', nameEn: 'B', permissions: ['users.view'] })).body;
  const u = await makeUser(s, { username: 'multi' });
  await s.admin.put(`/api/users/${u.id}`, { roleIds: [r1.id, r2.id] });
  assert.deepEqual((await u.client.get('/api/auth/session')).body.user.permissions, ['company.view', 'users.view']);
  assert.equal((await u.client.get('/api/users')).status, 200);
  await s.admin.put(`/api/roles/${r2.id}`, { permissions: [] });
  assert.equal((await u.client.get('/api/users')).status, 403);
  const log = s.app.db.prepare("SELECT details FROM audit_log WHERE action = 'role.updated'").get();
  assert.deepEqual(JSON.parse(log.details).permissionsRemoved, ['users.view']);
});

test('rbac: إدارة الأدوار — صلاحية غير معروفة، اسم مكرر، حذف دور مستخدم', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const bad = await s.admin.post('/api/roles', { nameAr: 'س', nameEn: 'X', permissions: ['company.fly'] });
  assert.equal(bad.status, 400); assert.equal(bad.body.error.details.fields.permissions, 'UNKNOWN_PERMISSION');
  const r = (await s.admin.post('/api/roles', { nameAr: 'محاسب', nameEn: 'Accountant', permissions: ['company.view'] })).body;
  assert.equal((await s.admin.post('/api/roles', { nameAr: 'آخر', nameEn: 'accountant', permissions: [] })).body.error.code, 'ROLE_NAME_TAKEN');
  const u = await makeUser(s, { username: 'acc1' });
  await s.admin.put(`/api/users/${u.id}`, { roleIds: [r.id] });
  assert.equal((await s.admin.del(`/api/roles/${r.id}`)).body.error.code, 'ROLE_IN_USE');
  await s.admin.put(`/api/users/${u.id}`, { roleIds: [] });
  assert.equal((await s.admin.del(`/api/roles/${r.id}`)).status, 200);
  const cat = (await s.admin.get('/api/permissions')).body;
  assert.deepEqual(cat.actions, ['view', 'create', 'update', 'delete', 'disable', 'approve', 'post', 'print', 'export']);
  assert.ok(cat.resources.some((x) => x.resource === 'branches'));
  const acts = s.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'role.%' ORDER BY id").all().map((x) => x.action);
  assert.deepEqual(acts.filter((a) => a !== 'role.updated'), ['role.created', 'role.deleted']);   // الاسم المكرر لم يُنشئ شيئًا
});

test('rbac: منع تصعيد الصلاحيات — لا يمنح المدير الفرعي ما لا يملكه', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const sub = await makeUser(s, { username: 'subadmin', permissions: ['users.view', 'users.create', 'users.update', 'roles.view', 'roles.create', 'roles.update'], allBranches: true });
  const c = sub.client;
  const esc = await c.post('/api/roles', { nameAr: 'كامل', nameEn: 'Full', permissions: ['settings.update'] });
  assert.equal(esc.status, 403); assert.equal(esc.body.error.code, 'PERMISSION_ESCALATION');
  const powerful = (await s.admin.post('/api/roles', { nameAr: 'قوي', nameEn: 'Powerful', permissions: ['precision.update'] })).body;
  const viaUser = await c.post('/api/users', { username: 'puppet', displayName: 'P', password: 'Puppet-Pass-1', roleIds: [powerful.id] });
  assert.equal(viaUser.body.error.code, 'PERMISSION_ESCALATION');
  const superU = await c.post('/api/users', { username: 'puppet2', displayName: 'P', password: 'Puppet-Pass-1', isSuperAdmin: true });
  assert.equal(superU.body.error.code, 'SUPER_ADMIN_ONLY');
  // تعديل دور أقوى منه مرفوض أيضًا
  assert.equal((await c.put(`/api/roles/${powerful.id}`, { permissions: [] })).body.error.code, 'PERMISSION_ESCALATION');
  // لا يعدّل أدواره بنفسه
  assert.equal((await c.put(`/api/users/${sub.id}`, { roleIds: [] })).body.error.code, 'SELF_MODIFICATION');
  // لا يدير المدير العام
  const adminId = s.app.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  assert.equal((await c.put(`/api/users/${adminId}`, { displayName: 'x' })).body.error.code, 'SUPER_ADMIN_ONLY');
  // ضمن صلاحياته: مسموح
  const ok = (await c.post('/api/roles', { nameAr: 'قارئ', nameEn: 'Reader', permissions: ['users.view'] })).body;
  assert.equal((await c.post('/api/users', { username: 'reader1', displayName: 'R', password: 'Reader-Pass-1', roleIds: [ok.id] })).status, 200);
});

test('rbac: المدير العام الأخير لا يُعطَّل ولا يُنزع، ولا يعطّل المستخدم نفسه', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const adminId = s.app.db.prepare("SELECT id FROM users WHERE username='admin'").get().id;
  assert.equal((await s.admin.post(`/api/users/${adminId}/status`, { active: false })).body.error.code, 'SELF_MODIFICATION');
  const sa2 = await makeUser(s, { username: 'super2' });
  assert.equal((await s.admin.put(`/api/users/${sa2.id}`, { isSuperAdmin: true })).status, 200);
  assert.equal((await sa2.client.post(`/api/users/${adminId}/status`, { active: false })).status, 200);
  // الآن super2 هو الأخير
  assert.equal((await sa2.client.put(`/api/users/${sa2.id}`, { isSuperAdmin: false })).body.error.code, 'SELF_MODIFICATION');
  await sa2.client.post(`/api/users/${adminId}/status`, { active: true });
  // admin يحاول نزع super2 ثم نفسه: الثاني مرفوض
  const a2 = s.client(); await a2.login('admin', require('./helpers').ADMIN.password);
  assert.equal((await a2.put(`/api/users/${sa2.id}`, { isSuperAdmin: false })).status, 200);
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM users WHERE is_super_admin=1 AND is_active=1').get().c, 1);
  assert.throws(() => s.app.db.prepare('DELETE FROM users').run(), /cannot be deleted/);
});

test('rbac: إدارة المستخدمين — تكرار الاسم (بلا حساسية حالة)، إعادة تعيين كلمة المرور، والتدقيق', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const a = await s.admin.post('/api/users', { username: 'Sara', displayName: 'S', password: 'Strong-Pass-11' });
  assert.equal(a.status, 200); assert.equal(a.body.mustChangePassword, true);
  const dup = await s.admin.post('/api/users', { username: 'sara', displayName: 'S2', password: 'Strong-Pass-11' });
  assert.equal(dup.status, 409); assert.equal(dup.body.error.code, 'USERNAME_TAKEN');
  assert.equal((await s.admin.put(`/api/users/${a.body.id}`, { displayName: 'Sara Test' })).body.displayName, 'Sara Test');
  const reset = await s.admin.post(`/api/users/${a.body.id}/password`, { password: 'Reset-Pass-22' });
  assert.equal(reset.status, 200); assert.equal(reset.body.mustChangePassword, true);
  assert.equal((await s.client().login('sara', 'Reset-Pass-22')).status, 200);
  const acts = s.app.db.prepare("SELECT action, details FROM audit_log WHERE action LIKE 'user.%' ORDER BY id").all();
  assert.deepEqual(acts.map((x) => x.action), ['user.created', 'user.created', 'user.updated', 'user.password.reset']);
  assert.ok(!acts.some((x) => /Pass-/.test(x.details)));
});

test('rbac: سجل التدقيق append-only حتى بعد إضافة المرحلة 1، ولا يحتوي أسرارًا', async (t) => {
  const s = await startReady(); t.after(s.stop);
  assert.throws(() => s.app.db.prepare("UPDATE audit_log SET action='x'").run(), /append-only/);
  assert.throws(() => s.app.db.prepare('DELETE FROM audit_log').run(), /append-only/);
  const { sanitize } = require('../server/core/audit');
  assert.deepEqual(sanitize({ password: 'p', newPassword: 'n', token: 't', nested: { csrf_token: 'c', ok: 1 }, mustChangePassword: true }),
    { password: '[REDACTED]', newPassword: '[REDACTED]', token: '[REDACTED]', nested: { csrf_token: '[REDACTED]', ok: 1 }, mustChangePassword: true });
  const list = (await s.admin.get('/api/audit?limit=2')).body;
  assert.equal(list.length, 2);
  assert.ok(list[0].id > list[1].id);
  const filtered = (await s.admin.get('/api/audit?action=auth.')).body;
  assert.ok(filtered.length >= 1 && filtered.every((r) => r.action.startsWith('auth.')));
});

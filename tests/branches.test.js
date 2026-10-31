'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { MODULES } = require('../server/app');
const { startReady, makeUser } = require('./helpers');

async function threeBranches(s) {
  const ids = {};
  ids.HQ = s.app.db.prepare("SELECT id FROM branches WHERE code='HQ'").get().id;
  for (const code of ['ALX', 'GIZ']) {
    const r = await s.admin.post('/api/branches', { code, nameAr: 'فرع ' + code, nameEn: 'Branch ' + code, phone: '+20 100 000 0000', email: `${code.toLowerCase()}@example.test` });
    assert.equal(r.status, 200, r.text);
    ids[code] = r.body.id;
  }
  return ids;
}

test('branches: إنشاء وتعديل وتعطيل، كود فريد بأحرف كبيرة، والتدقيق', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const ids = await threeBranches(s);
  assert.equal((await s.admin.post('/api/branches', { code: 'alx', nameAr: 'x', nameEn: 'x' })).body.error.code, 'BRANCH_CODE_TAKEN');
  const up = await s.admin.put(`/api/branches/${ids.ALX}`, { nameEn: 'Alexandria (test)', addressAr: 'عنوان اختبار' });
  assert.equal(up.body.nameEn, 'Alexandria (test)');
  assert.equal((await s.admin.post(`/api/branches/${ids.GIZ}/status`, { active: false })).body.isActive, false);
  assert.equal((await s.admin.post(`/api/branches/${ids.HQ}/status`, { active: false })).body.error.code, 'MAIN_BRANCH_CANNOT_DISABLE');
  assert.throws(() => s.app.db.prepare('DELETE FROM branches').run(), /cannot be deleted/);
  const acts = s.app.db.prepare("SELECT action FROM audit_log WHERE action LIKE 'branch.%' ORDER BY id").all().map((x) => x.action);
  assert.deepEqual(acts, ['branch.created', 'branch.created', 'branch.created', 'branch.updated', 'branch.deactivated']);
});

test('branches: فرع رئيسي واحد دائمًا — نقل الرئيسي ذري، ولا يكون معطّلًا', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const ids = await threeBranches(s);
  assert.equal((await s.admin.put(`/api/branches/${ids.HQ}`, { isMain: false })).body.error.code, 'MAIN_BRANCH_REQUIRED');
  assert.equal((await s.admin.put(`/api/branches/${ids.ALX}`, { isMain: true })).body.isMain, true);
  assert.deepEqual(s.app.db.prepare('SELECT code FROM branches WHERE is_main=1').all().map((r) => r.code), ['ALX']);
  await s.admin.post(`/api/branches/${ids.GIZ}/status`, { active: false });
  assert.equal((await s.admin.put(`/api/branches/${ids.GIZ}`, { isMain: true })).body.error.code, 'BRANCH_INACTIVE');
  assert.throws(() => s.app.db.prepare('UPDATE branches SET is_main=1').run(), /UNIQUE|CHECK/);
});

test('branches: مستخدم بفرع واحد لا يرى ولا يعدّل غيره، ولا يتحول إليه (يُفرض في الخادم)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const ids = await threeBranches(s);
  const u = await makeUser(s, { username: 'alxuser', permissions: ['branches.view', 'branches.update', 'branches.create'], branchIds: [ids.ALX] });
  const c = u.client;
  assert.deepEqual((await c.get('/api/branches')).body.map((b) => b.code), ['ALX']);
  assert.equal((await c.get(`/api/branches/${ids.GIZ}`)).body.error.code, 'BRANCH_FORBIDDEN');
  assert.equal((await c.put(`/api/branches/${ids.GIZ}`, { nameEn: 'x' })).body.error.code, 'BRANCH_FORBIDDEN');
  assert.equal((await c.put(`/api/branches/${ids.ALX}`, { nameEn: 'mine' })).status, 200);
  assert.equal((await c.post('/api/branches', { code: 'NEW', nameAr: 'x', nameEn: 'x' })).body.error.code, 'BRANCH_SCOPE_EXCEEDED');
  assert.equal((await c.put(`/api/branches/${ids.ALX}`, { isMain: true })).body.error.code, 'BRANCH_SCOPE_EXCEEDED');
  const sess = (await c.get('/api/auth/session')).body;
  assert.equal(sess.branch.code, 'ALX');
  assert.deepEqual(sess.branches.map((b) => b.code), ['ALX']);
  assert.equal((await c.post('/api/auth/branch', { branchId: ids.HQ })).body.error.code, 'BRANCH_FORBIDDEN');
});

test('branches: تبديل الفرع الحالي، وفرع معطّل يُستبدل تلقائيًا في الجلسة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const ids = await threeBranches(s);
  const u = await makeUser(s, { username: 'two', branchIds: [ids.ALX, ids.GIZ] });
  const c = u.client;
  assert.equal((await c.post('/api/auth/branch', { branchId: ids.GIZ })).body.branch.code, 'GIZ');
  await s.admin.post(`/api/branches/${ids.GIZ}/status`, { active: false });
  const sess = (await c.get('/api/auth/session')).body;
  assert.equal(sess.branch.code, 'ALX');
  assert.deepEqual(sess.branches.map((b) => b.code), ['ALX']);
  assert.equal((await c.post('/api/auth/branch', { branchId: ids.GIZ })).body.error.code, 'BRANCH_INACTIVE');
});

test('branches: المدير الفرعي لا يمنح فروعًا خارج نطاقه ولا يدير مستخدمي فروع أخرى', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const ids = await threeBranches(s);
  const mgr = await makeUser(s, { username: 'alxmgr', permissions: ['users.view', 'users.create', 'users.update', 'users.disable'], branchIds: [ids.ALX] });
  const out = await mgr.client.post('/api/users', { username: 'gg1', displayName: 'G', password: 'Gg-Pass-111', branchIds: [ids.GIZ] });
  assert.equal(out.body.error.code, 'BRANCH_SCOPE_EXCEEDED');
  const all = await mgr.client.post('/api/users', { username: 'gg2', displayName: 'G', password: 'Gg-Pass-111', allBranches: true });
  assert.equal(all.body.error.code, 'BRANCH_SCOPE_EXCEEDED');
  assert.equal((await mgr.client.post('/api/users', { username: 'aa1', displayName: 'A', password: 'Aa-Pass-111', branchIds: [ids.ALX] })).status, 200);
  const giz = await makeUser(s, { username: 'gizuser', branchIds: [ids.GIZ] });
  assert.equal((await mgr.client.post(`/api/users/${giz.id}/status`, { active: false })).body.error.code, 'BRANCH_SCOPE_EXCEEDED');
});

test('branches: نطاق التقارير — فرع محدد أو جميع الفروع المصرح بها (نمط المراحل القادمة)', async (t) => {
  // وحدة اختبار تمثل مستندات مستقبلية مربوطة بالفرع، وتجمع مبالغها بدقة.
  const docs = {
    name: 'docs-probe', dependsOn: ['security'],
    register(router, services) {
      services.db.exec("CREATE TABLE IF NOT EXISTS probe_docs (id INTEGER PRIMARY KEY, branch_id INTEGER NOT NULL REFERENCES branches(id), amount TEXT NOT NULL) STRICT");
      router.post('/api/probe-docs', { auth: true }, async (ctx) => {
        const b = await ctx.body();
        ctx.access.assertBranch(b.branchId);
        services.db.prepare('INSERT INTO probe_docs (branch_id, amount) VALUES (?, ?)').run(b.branchId, services.decimal.commit(b.amount, 'amount'));
        return { ok: true };
      });
      router.get('/api/probe-docs/total', { auth: true }, (ctx) => {
        const f = ctx.access.sqlFilter('branch_id', ctx.query.branch);
        return services.db.prepare(`SELECT dec_sum(amount) total, count(*) n FROM probe_docs WHERE ${f.sql}`).get(...f.params);
      });
    },
  };
  const s = await startReady({ modules: [...MODULES, docs] }); t.after(s.stop);
  const ids = await threeBranches(s);
  for (const [b, a] of [[ids.HQ, '0.1'], [ids.ALX, '0.2'], [ids.ALX, '1000000.00000001'], [ids.GIZ, '5']]) {
    assert.equal((await s.admin.post('/api/probe-docs', { branchId: b, amount: a })).status, 200);
  }
  assert.deepEqual((await s.admin.get('/api/probe-docs/total?branch=all')).body, { total: '1000005.30000001', n: 4 });
  assert.deepEqual((await s.admin.get(`/api/probe-docs/total?branch=${ids.ALX}`)).body, { total: '1000000.20000001', n: 2 });

  const u = await makeUser(s, { username: 'rep', branchIds: [ids.HQ, ids.ALX] });
  assert.deepEqual((await u.client.get('/api/probe-docs/total')).body, { total: '1000000.30000001', n: 3 });   // "الكل" = فروعه فقط
  assert.equal((await u.client.get(`/api/probe-docs/total?branch=${ids.GIZ}`)).body.error.code, 'BRANCH_FORBIDDEN');
  assert.equal((await u.client.post('/api/probe-docs', { branchId: ids.GIZ, amount: '1' })).body.error.code, 'BRANCH_FORBIDDEN');
  assert.equal((await u.client.get('/api/probe-docs/total?branch=abc')).body.error.code, 'BAD_BRANCH');
});

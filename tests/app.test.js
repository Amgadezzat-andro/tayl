'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadConfig } = require('../server/core/config');
const { createApp } = require('../server/app');
const { openDatabase } = require('../server/core/db');
const { listBackups } = require('../server/core/backup');
const { tmpDir, silent } = require('./helpers');
const { MODULES } = require('../server/app');

test('app: أول تشغيل ينشئ القاعدة والجداول بلا نسخة احتياطية (لا بيانات بعد)', async () => {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir, port: 0 });
  const app = await createApp({ config, logger: silent });
  // المرحلة 1 أضافت ترحيلات company-setup و security (القائمة الكاملة بترتيب الاعتماد).
  assert.deepEqual(app.migrationsApplied, ['system/0001_core', 'company-setup/0001_company_branches', 'security/0001_users_roles_sessions',
    // المرحلة 2
    'fiscal-years/0001_fiscal_years', 'chart-accounts/0001_chart_of_accounts', 'cost-centers/0001_cost_centers', 'currencies/0001_currencies_rates',
    'treasury/0001_treasuries', 'payment-terms/0001_payment_terms_methods', 'units/0001_units']);
  assert.equal(app.preMigrationBackup, null);
  assert.equal(app.db.prepare("SELECT value FROM app_meta WHERE key='app_id'").get().value, 'TAYL');
  await app.close();
});

test('app: إعادة التشغيل تحفظ البيانات ولا تعيد الترحيل', async () => {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir, port: 0 });
  let app = await createApp({ config, logger: silent });
  app.services.audit.record({ action: 'persist.check', source: 'tests' });
  await app.close();
  app = await createApp({ config, logger: silent });
  assert.deepEqual(app.migrationsApplied, []);
  assert.equal(app.services.audit.list().length, 1);
  await app.close();
});

test('app: ترحيل جديد على قاعدة بها بيانات => نسخة احتياطية تلقائية موثّقة قبله', async () => {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir, port: 0 });
  let app = await createApp({ config, logger: silent });
  app.services.audit.record({ action: 'seed', source: 'tests' });
  await app.close();

  const extraDir = tmpDir();
  fs.writeFileSync(path.join(extraDir, '0001_extra.sql'), 'CREATE TABLE extra(id INTEGER PRIMARY KEY) STRICT;');
  const extra = { name: 'extra', version: '1', dependsOn: ['system'], migrationsDir: extraDir, register() {} };
  app = await createApp({ config, logger: silent, modules: [...MODULES, extra] });   // المرحلة 1: كل الوحدات + الوحدة الجديدة
  assert.deepEqual(app.migrationsApplied, ['extra/0001_extra']);
  assert.ok(app.preMigrationBackup);
  const b = listBackups(config.backupDir);
  assert.equal(b.length, 1);
  assert.match(b[0].file, /pre-migration/);
  const snap = openDatabase(b[0].path, { readonly: true });
  assert.equal(snap.prepare("SELECT count(*) c FROM sqlite_master WHERE name='extra'").get().c, 0);   // النسخة قبل الترحيل
  snap.close(); await app.close();
});

test('app: وحدة جديدة تُضاف دون تعديل الوحدات الأخرى (مساراتها وترحيلاتها)', async () => {
  const dir = tmpDir();
  const mdir = tmpDir();
  fs.writeFileSync(path.join(mdir, '0001_t.sql'), 'CREATE TABLE widgets(id INTEGER PRIMARY KEY, n TEXT) STRICT; INSERT INTO widgets(n) VALUES (\'a\');');
  const widgets = { name: 'widgets', version: '1', dependsOn: ['system'], migrationsDir: mdir,
    register(r, s) { r.get('/api/widgets', { public: true }, () => s.db.prepare('SELECT * FROM widgets').all()); } };
  const app = await createApp({ config: loadConfig({ dataDir: dir, port: 0 }), logger: silent, modules: [widgets, MODULES[0]] });
  const addr = await app.listen();
  const rows = await (await fetch(`http://127.0.0.1:${addr.port}/api/widgets`)).json();
  assert.deepEqual(rows, [{ id: 1, n: 'a' }]);
  const mods = await (await fetch(`http://127.0.0.1:${addr.port}/api/system/modules`)).json();
  assert.deepEqual(mods.loaded.map((m) => m.name), ['system', 'widgets']);
  await app.close();
});

test('app: config.json تالف يُرفض برسالة واضحة، ومنفذ غير صالح كذلك', () => {
  const dir = tmpDir();
  fs.writeFileSync(path.join(dir, 'config.json'), '{bad');
  assert.throws(() => loadConfig({ dataDir: dir }), /config\.json/);
  assert.throws(() => loadConfig({ dataDir: tmpDir(), port: 99999 }), /المنفذ/);
});

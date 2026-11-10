'use strict';
const fs = require('node:fs');
const { openDatabase } = require('./core/db');
const migrator = require('./core/migrator');
const backup = require('./core/backup');
const { createAudit } = require('./core/audit');
const { Router } = require('./core/router');
const { resolveOrder } = require('./core/module-loader');
const { createHttpServer } = require('./core/http');
const { createDecimalService } = require('./core/decimal');
const { registerDecimalSql } = require('./core/decimal/sql');
const { createPermissionCatalog } = require('./core/permissions');
const { registerSearchSql } = require('./core/search');
const { createUsageRegistry } = require('./core/usage');
const { loadLocales } = require('./core/i18n');
const pkg = require('../package.json');

const BRAND = Object.freeze({
  name: 'TAYL',
  tagline: 'STRATEGIC ACCOUNTING | FINANCE | COST SOLUTIONS',
  support: '01123401333',
});

/** سجل الوحدات: إضافة وحدة = سطر هنا. الترتيب الفعلي يُحسب من dependsOn. */
const MODULES = [
  require('./modules/system'),
  require('./modules/company-setup'),   // المرحلة 1: الشركة والفروع والإعدادات وسياسة الدقة
  require('./modules/security'),        // المرحلة 1: المستخدمون والأدوار والجلسات والتأسيس
  // المرحلة 2: البيانات الرئيسية والبنية المحاسبية (بلا قيود ولا ترحيل)
  require('./modules/fiscal-years'),
  require('./modules/chart-accounts'),
  require('./modules/cost-centers'),
  require('./modules/currencies'),
  require('./modules/treasury'),
  require('./modules/payment-terms'),
  require('./modules/units'),
  // المرحلة 3: ترقيم المستندات، القيود اليومية والأستاذ العام ومحرك الترحيل
  require('./modules/numbering'),
  require('./modules/journal'),
];

async function createApp({ config, logger, modules = MODULES }) {
  const ordered = resolveOrder(modules);
  const db = openDatabase(config.dbFile);
  registerDecimalSql(db);   // dec_sum / dec_cmp: جمع ومقارنة عشرية دقيقة داخل SQL
  registerSearchSql(db);    // tayl_norm: بحث عربي/إنجليزي موحد

  // أمان الترحيل: قبل أي تغيير في هيكل قاعدة تحوي بيانات، نأخذ نسخة احتياطية موثّقة.
  const { pending, applied } = migrator.plan(db, ordered);
  let preMigrationBackup = null;
  if (pending.length && applied.length && config.dbFile !== ':memory:') {
    preMigrationBackup = await backup.createBackup(db, { dir: config.backupDir, reason: 'pre-migration', retention: config.backupRetention, appVersion: pkg.version });
    logger.info('pre-migration backup', { file: preMigrationBackup.path });
  }
  const done = migrator.migrate(db, ordered, { onApply: (m) => logger.info('migration applied', { module: m.module, id: m.id }) });

  const audit = createAudit(db);
  const router = new Router();
  const services = {
    db, audit, config, logger, brand: BRAND, version: pkg.version,
    modules: ordered, authorizer: null,    // تسجّله وحدة security
    decimal: createDecimalService(),       // محرك الدقة المركزي؛ تحمّل company-setup سياسته من القاعدة
    permissions: createPermissionCatalog(),
    usage: createUsageRegistry(db),        // [م2] منع حذف/تغيير كود ما هو مستخدم
    i18n: loadLocales(config.publicDir),   // [م2] عناوين التصدير والطباعة باللغتين
    backup: { create: (reason = 'manual') => backup.createBackup(db, { dir: config.backupDir, reason, retention: config.backupRetention, appVersion: pkg.version }) },
  };
  for (const m of ordered) m.register(router, services);

  const server = createHttpServer({ router, config, logger, services });
  let closed = false;
  return {
    server, db, services, router, migrationsApplied: done, preMigrationBackup,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(config.port, config.host, () => { server.off('error', reject); resolve(server.address()); });
    }),
    close: () => new Promise((resolve) => {
      if (closed) return resolve();
      closed = true;
      const finish = () => { try { db.close(); } catch { /* مغلقة */ } resolve(); };
      if (server.listening) { server.closeAllConnections?.(); server.close(finish); } else finish();
    }),
  };
}
module.exports = { createApp, BRAND, MODULES };

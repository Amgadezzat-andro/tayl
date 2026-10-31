'use strict';
const fs = require('node:fs');
const { openDatabase } = require('./core/db');
const migrator = require('./core/migrator');
const backup = require('./core/backup');
const { createAudit } = require('./core/audit');
const { Router } = require('./core/router');
const { resolveOrder } = require('./core/module-loader');
const { createHttpServer } = require('./core/http');
const pkg = require('../package.json');

const BRAND = Object.freeze({
  name: 'TAYL',
  tagline: 'STRATEGIC ACCOUNTING | FINANCE | COST SOLUTIONS',
  support: '01123401333',
});

/** سجل الوحدات: إضافة وحدة = سطر هنا. الترتيب الفعلي يُحسب من dependsOn. */
const MODULES = [
  require('./modules/system'),
];

async function createApp({ config, logger, modules = MODULES }) {
  const ordered = resolveOrder(modules);
  const db = openDatabase(config.dbFile);

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
    modules: ordered, authorizer: null,    // المرحلة 1 تسجّل المُصرِّح هنا
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

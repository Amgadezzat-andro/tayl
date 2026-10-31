'use strict';
const path = require('node:path');
const roadmap = require('./roadmap');

/** وحدة النظام الأساسية: صحة الخادم، معلومات الإصدار، خريطة الوحدات. */
module.exports = {
  name: 'system',
  version: '0.1.0',
  dependsOn: [],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db, brand, modules } = services;

    router.get('/api/system/health', { public: true }, () => {
      const ok = db.prepare('SELECT 1 AS ok').get().ok === 1;
      return { status: ok ? 'ok' : 'fail', db: ok ? 'ok' : 'fail' };
    });

    router.get('/api/system/info', { public: true }, () => ({
      name: brand.name, tagline: brand.tagline, support: brand.support,
      version: services.version,
      node: process.version,
      migrations: db.prepare('SELECT module, id FROM schema_migrations ORDER BY module, id').all(),
    }));

    router.get('/api/system/modules', { public: true }, () => {
      const loaded = new Set(modules.map((m) => m.name));
      return {
        loaded: modules.map((m) => ({ name: m.name, version: m.version })),
        roadmap: roadmap.map((r) => ({ ...r, status: loaded.has(r.id) ? 'active' : 'planned' })),
      };
    });
  },
};

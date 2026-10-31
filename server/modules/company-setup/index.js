'use strict';
const path = require('node:path');
const { createCompanyService, registerCompanyRoutes } = require('./company');
const { createBranchService, registerBranchRoutes } = require('./branches');
const { createSettingsService, registerSettingsRoutes } = require('./settings');
const { createPrecisionService, registerPrecisionRoutes } = require('./precision');
const { createFinancialActivity } = require('./financial-activity');

/**
 * وحدة تأسيس الشركة: بيانات الشركة الوحيدة، الفروع، إعدادات النظام، سياسة الدقة الحسابية.
 * المسارات المحمية تعتمد على المُصرِّح (وحدة security) لتعبئة ctx.user و ctx.access.
 */
module.exports = {
  name: 'company-setup',
  version: '1.0.0',
  dependsOn: ['system'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    services.permissions.register('company-setup', [
      { resource: 'company', group: 'company', actions: ['view', 'update'] },
      { resource: 'branches', group: 'company', actions: ['view', 'create', 'update', 'disable'] },
      { resource: 'settings', group: 'system', actions: ['view', 'update'] },
      { resource: 'precision', group: 'system', actions: ['view', 'update'] },
    ]);

    services.financialActivity = createFinancialActivity(services);
    services.company = createCompanyService(services);
    services.branches = createBranchService(services);
    services.settings = createSettingsService(services);
    services.precision = createPrecisionService(services);
    services.precision.load();

    // عام: الواجهة تحتاجه قبل تسجيل الدخول لتقرر عرض شاشة التأسيس أو الدخول.
    router.get('/api/setup/status', { public: true }, () => {
      const c = services.company.get();
      return { setupCompleted: !!c, defaultLanguage: c ? c.defaultLanguage : null };
    });

    registerCompanyRoutes(router, services);
    registerBranchRoutes(router, services);
    registerSettingsRoutes(router, services);
    registerPrecisionRoutes(router, services);
  },
};

'use strict';
const path = require('node:path');
const { createSessionStore } = require('./sessions');
const { createThrottle } = require('./throttle');
const { createAccessLoader, createGrantGuard } = require('./access');
const { createAuthorizer } = require('./authorizer');
const { createUserService, registerUserRoutes } = require('./users');
const { createRoleService, registerRoleRoutes } = require('./roles');
const { registerAuthRoutes } = require('./auth-routes');
const { registerSetupRoute } = require('./setup');
const { registerOverviewRoutes } = require('./overview');

/**
 * وحدة الأمان: المستخدمون، الأدوار (RBAC)، نطاق الفروع، الجلسات، التأسيس الأول، وسجل التدقيق.
 * تسجّل services.authorizer فيصبح كل مسار محمي في كل الوحدات خاضعًا للجلسة والصلاحية على الخادم.
 */
module.exports = {
  name: 'security',
  version: '1.0.0',
  dependsOn: ['system', 'company-setup'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    services.permissions.register('security', [
      // manage_all: رؤية وإدارة كل المستخدمين بغض النظر عن نطاق الفروع — صريحة، ولا يمنحها إلا المدير العام.
      { resource: 'users', group: 'security', actions: ['view', 'create', 'update', 'disable'], special: ['manage_all'], superOnlyGrant: ['manage_all'] },
      { resource: 'roles', group: 'security', actions: ['view', 'create', 'update', 'delete'] },
      { resource: 'audit', group: 'security', actions: ['view'] },
    ]);

    services.sessions = createSessionStore(services);
    services.throttle = createThrottle(services);
    services.accessLoader = createAccessLoader(services);
    services.guard = createGrantGuard(services);
    services.users = createUserService(services);
    services.roles = createRoleService(services);
    services.authorizer = createAuthorizer(services);

    registerSetupRoute(router, services);
    registerAuthRoutes(router, services);
    registerUserRoutes(router, services);
    registerRoleRoutes(router, services);
    registerOverviewRoutes(router, services);
  },
};

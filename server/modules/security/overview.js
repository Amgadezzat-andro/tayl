'use strict';
const { validator } = require('../../core/validate');

/** سجل التدقيق (قراءة فقط) ولوحة المعلومات بعد الدخول. */
function registerOverviewRoutes(router, services) {
  const { db, audit, company, guard } = services;
  // المستخدم محدود النطاق يرى أحداث المستخدمين المرئيين له فقط (ومنهم نفسه إن كان مرئيًا).
  const auditScope = (ctx) => guard.visibleUserIds(ctx);

  router.get('/api/audit', { permission: 'audit.view' }, (ctx) => {
    const q = ctx.query;
    const toInt = (s) => (/^[1-9]\d{0,15}$/.test(String(s || '')) ? Number(s) : undefined);
    const f = validator({ action: q.action || undefined }, { partial: true }).str('action', { max: 60, pattern: /^[a-z0-9_.]+$/ }).done();
    const rows = audit.list({ limit: toInt(q.limit) || 100, beforeId: toInt(q.before), userId: toInt(q.userId), userIds: auditScope(ctx) || undefined, action: f.action || undefined, entityType: q.entityType || undefined });
    return rows.map((r) => ({ ...r, details: r.details ? JSON.parse(r.details) : null }));
  });

  function countActive(ids) {
    if (ids && !ids.length) return 0;
    return db.prepare(`SELECT count(*) c FROM users WHERE is_active = 1 ${ids ? `AND id IN (${ids.map(() => '?').join(',')})` : ''}`).get(...(ids || [])).c;
  }
  function lastLogins(ids) {
    if (ids && !ids.length) return [];
    return db.prepare(`SELECT occurred_at, COALESCE(json_extract(details, '$.username'), actor) AS actor, action FROM audit_log
      WHERE action IN ('auth.login.success','auth.login.failure') ${ids ? `AND actor_user_id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY id DESC LIMIT 5`).all(...(ids || []));
  }

  router.get('/api/dashboard', { auth: true }, (ctx) => {
    const c = company.get();
    const can = (p) => ctx.access.can(p);
    const scoped = ctx.access.sqlFilter('id', 'all');
    return {
      company: c ? { nameAr: c.nameAr, nameEn: c.nameEn, baseCurrency: c.baseCurrency, hasLogo: c.hasLogo } : null,
      counts: {
        branches: can('branches.view') ? db.prepare(`SELECT count(*) c FROM branches WHERE is_active = 1 AND ${scoped.sql}`).get(...scoped.params).c : null,
        users: can('users.view') ? countActive(guard.visibleUserIds(ctx)) : null,
        roles: can('roles.view') ? db.prepare('SELECT count(*) c FROM roles').get().c : null,
      },
      lastLogins: can('audit.view') ? lastLogins(auditScope(ctx)) : null,
    };
  });
}

module.exports = { registerOverviewRoutes };

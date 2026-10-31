'use strict';
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');

function createRoleService({ db, audit, permissions, guard }) {
  const row = (id) => db.prepare('SELECT * FROM roles WHERE id = ?').get(id);
  const permsOf = (id) => db.prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission').all(id).map((r) => r.permission);
  const toApi = (r) => ({
    id: r.id, nameAr: r.name_ar, nameEn: r.name_en, description: r.description, permissions: permsOf(r.id),
    userCount: db.prepare('SELECT count(*) c FROM user_roles WHERE role_id = ?').get(r.id).c, createdAt: r.created_at, updatedAt: r.updated_at,
  });

  function validateRole(body, { partial }) {
    const d = validator(body, { partial })
      .str('nameAr', { required: true, max: 100 })
      .str('nameEn', { required: true, max: 100 })
      .str('description', { max: 500, multiline: true })
      .strings('permissions', { required: !partial, max: 500 })
      .done();
    if (d.permissions) {
      const unknown = d.permissions.filter((p) => !permissions.has(p));
      if (unknown.length) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { permissions: 'UNKNOWN_PERMISSION' }, permissions: unknown });
    }
    return d;
  }
  const nameTaken = (e) => {
    if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') return new HttpError(409, 'ROLE_NAME_TAKEN', 'اسم الدور مستخدم من قبل');
    return e;
  };
  function setPerms(id, list) {
    db.prepare('DELETE FROM role_permissions WHERE role_id = ?').run(id);
    const ins = db.prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    for (const p of list) ins.run(id, p);
  }

  return {
    list: () => db.prepare('SELECT * FROM roles ORDER BY name_en').all().map(toApi),
    get(id) { const r = row(id); if (!r) throw new HttpError(404, 'NOT_FOUND', 'الدور غير موجود'); return toApi(r); },

    create(ctx, body) {
      const d = validateRole(body, { partial: false });
      guard.assertPermissionsSubset(ctx, d.permissions);
      return inTransaction(db, () => {
        let id;
        try { id = Number(db.prepare('INSERT INTO roles (name_ar, name_en, description) VALUES (?, ?, ?)').run(d.nameAr, d.nameEn, d.description ?? null).lastInsertRowid); }
        catch (e) { throw nameTaken(e); }
        setPerms(id, d.permissions);
        audit.fromCtx(ctx, { action: 'role.created', source: 'security', entityType: 'role', entityId: id, details: { nameAr: d.nameAr, nameEn: d.nameEn, permissions: d.permissions } });
        return toApi(row(id));
      });
    },

    update(ctx, id, body) {
      const d = validateRole(body, { partial: true });
      return inTransaction(db, () => {
        const r = row(id);
        if (!r) throw new HttpError(404, 'NOT_FOUND', 'الدور غير موجود');
        const before = toApi(r);
        // من ليس مديرًا عامًا لا يعدّل دورًا أقوى منه، ولا يضيف صلاحية لا يملكها.
        guard.assertPermissionsSubset(ctx, before.permissions);
        if (d.permissions) guard.assertPermissionsSubset(ctx, d.permissions);
        try {
          db.prepare(`UPDATE roles SET name_ar = ?, name_en = ?, description = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
            .run(d.nameAr ?? r.name_ar, d.nameEn ?? r.name_en, 'description' in d ? d.description : r.description, id);
        } catch (e) { throw nameTaken(e); }
        if (d.permissions) setPerms(id, d.permissions);
        const after = toApi(row(id));
        const added = after.permissions.filter((p) => !before.permissions.includes(p));
        const removed = before.permissions.filter((p) => !after.permissions.includes(p));
        const changes = {};
        for (const k of ['nameAr', 'nameEn', 'description']) if (before[k] !== after[k]) changes[k] = { from: before[k], to: after[k] };
        if (added.length || removed.length || Object.keys(changes).length) {
          audit.fromCtx(ctx, { action: 'role.updated', source: 'security', entityType: 'role', entityId: id, details: { changes, permissionsAdded: added, permissionsRemoved: removed, affectedUsers: after.userCount } });
        }
        return after;
      });
    },

    remove(ctx, id) {
      return inTransaction(db, () => {
        const r = row(id);
        if (!r) throw new HttpError(404, 'NOT_FOUND', 'الدور غير موجود');
        const before = toApi(r);
        guard.assertPermissionsSubset(ctx, before.permissions);
        if (before.userCount > 0) throw new HttpError(409, 'ROLE_IN_USE', 'الدور مُسنَد لمستخدمين؛ أزله منهم أولًا', { userCount: before.userCount });
        db.prepare('DELETE FROM roles WHERE id = ?').run(id);
        audit.fromCtx(ctx, { action: 'role.deleted', source: 'security', entityType: 'role', entityId: id, details: { nameAr: r.name_ar, nameEn: r.name_en, permissions: before.permissions } });
        return { ok: true };
      });
    },
  };
}

function registerRoleRoutes(router, services) {
  const { roles, permissions } = services;
  router.get('/api/permissions', { permission: 'roles.view' }, () => ({
    actions: permissions.ACTIONS,
    resources: permissions.list(),
  }));
  router.get('/api/roles', { permission: 'roles.view' }, () => roles.list());
  router.get('/api/roles/:id', { permission: 'roles.view' }, (ctx) => roles.get(idParam(ctx.params.id)));
  router.post('/api/roles', { permission: 'roles.create' }, async (ctx) => roles.create(ctx, await ctx.body()));
  router.put('/api/roles/:id', { permission: 'roles.update' }, async (ctx) => roles.update(ctx, idParam(ctx.params.id), await ctx.body()));
  router.delete('/api/roles/:id', { permission: 'roles.delete' }, (ctx) => roles.remove(ctx, idParam(ctx.params.id)));
}

module.exports = { createRoleService, registerRoleRoutes };

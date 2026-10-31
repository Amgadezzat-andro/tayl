'use strict';
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { hashPassword, passwordProblem } = require('./passwords');

// أحرف لاتينية فقط لاسم الدخول: يمنع تشابه الحروف المضلِّل بين أسماء مختلفة.
const USERNAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{2,63}$/;

function createUserService({ db, audit, sessions, guard, settings, branches, throttle }) {
  const row = (id) => db.prepare('SELECT * FROM users WHERE id = ?').get(id);
  const roleIdsOf = (id) => db.prepare('SELECT role_id FROM user_roles WHERE user_id = ? ORDER BY role_id').all(id).map((r) => r.role_id);
  const branchIdsOf = (id) => db.prepare('SELECT branch_id FROM user_branches WHERE user_id = ? ORDER BY branch_id').all(id).map((r) => r.branch_id);

  function toApi(u) {
    return {
      id: u.id, username: u.username, displayName: u.display_name, isActive: u.is_active === 1, isSuperAdmin: u.is_super_admin === 1,
      allBranches: u.all_branches === 1, defaultBranchId: u.default_branch_id, mustChangePassword: u.must_change_password === 1,
      roleIds: roleIdsOf(u.id), branchIds: branchIdsOf(u.id), lastLoginAt: u.last_login_at, createdAt: u.created_at, updatedAt: u.updated_at,
    };
  }

  function assertRolesExist(ids) {
    if (!ids.length) return;
    const n = db.prepare(`SELECT count(*) c FROM roles WHERE id IN (${ids.map(() => '?').join(',')})`).get(...ids).c;
    if (n !== ids.length) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { roleIds: 'NOT_FOUND' } });
  }
  function assertBranchesExist(ids) {
    if (!ids.every((id) => branches.exists(id))) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { branchIds: 'NOT_FOUND' } });
  }
  function assertDefaultBranch(defaultBranchId, { allBranches, branchIds }) {
    if (defaultBranchId == null) return;
    if (!branches.isActive(defaultBranchId) || !(allBranches || branchIds.includes(defaultBranchId))) {
      throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { defaultBranchId: 'NOT_IN_SCOPE' } });
    }
  }
  function assertPassword(pw, username, field = 'password') {
    const p = passwordProblem(pw, { username, minLength: settings.get().passwordMinLength });
    if (p) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: p } });
  }
  /** يجب أن يبقى مدير عام نشط واحد على الأقل. */
  function assertNotLastSuperAdmin(id) {
    const others = db.prepare('SELECT count(*) c FROM users WHERE is_super_admin = 1 AND is_active = 1 AND id <> ?').get(id).c;
    if (others === 0) throw new HttpError(409, 'LAST_SUPER_ADMIN', 'لا يمكن إزالة آخر مدير عام نشط');
  }
  function setLinks(id, roleIds, branchIds) {
    db.prepare('DELETE FROM user_roles WHERE user_id = ?').run(id);
    db.prepare('DELETE FROM user_branches WHERE user_id = ?').run(id);
    const r = db.prepare('INSERT INTO user_roles (user_id, role_id) VALUES (?, ?)');
    const b = db.prepare('INSERT INTO user_branches (user_id, branch_id) VALUES (?, ?)');
    for (const x of roleIds) r.run(id, x);
    for (const x of branchIds) b.run(id, x);
  }

  /** إدراج مستخدم (يستخدمه التأسيس أيضًا لإنشاء المدير العام الأول). كلمة المرور مجزأة مسبقًا. */
  function insert(d, passwordHash, { createdBy = null } = {}) {
    try {
      const info = db.prepare(`INSERT INTO users (username, display_name, password_hash, is_active, is_super_admin, all_branches, default_branch_id, must_change_password, created_by)
        VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?)`).run(d.username, d.displayName, passwordHash, d.isSuperAdmin ? 1 : 0, d.allBranches || d.isSuperAdmin ? 1 : 0,
        d.defaultBranchId ?? null, d.mustChangePassword ? 1 : 0, createdBy);
      const id = Number(info.lastInsertRowid);
      setLinks(id, d.roleIds || [], d.allBranches || d.isSuperAdmin ? [] : (d.branchIds || []));
      return id;
    } catch (e) {
      if (e && e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'USERNAME_TAKEN', 'اسم المستخدم مستخدم من قبل', { fields: { username: 'TAKEN' } });
      throw e;
    }
  }

  function validateUser(body, { partial }) {
    const v = validator(body, { partial })
      .str('displayName', { required: true, max: 120 })
      .ids('roleIds')
      .ids('branchIds')
      .bool('allBranches')
      .id('defaultBranchId')
      .bool('isSuperAdmin');
    if (!partial) v.str('username', { required: true, pattern: USERNAME_RE, max: 64 }).secret('password', { required: true, min: 1 });
    return v.done();
  }

  return {
    insert, toApi, assertPassword, USERNAME_RE,
    list: () => db.prepare('SELECT * FROM users ORDER BY username').all().map(toApi),
    get(id) { const u = row(id); if (!u) throw new HttpError(404, 'NOT_FOUND', 'المستخدم غير موجود'); return toApi(u); },

    async create(ctx, body) {
      const d = validateUser(body, { partial: false });
      d.roleIds = d.roleIds || []; d.branchIds = d.branchIds || [];
      d.allBranches = !!d.allBranches; d.isSuperAdmin = !!d.isSuperAdmin;
      assertRolesExist(d.roleIds); assertBranchesExist(d.branchIds);
      guard.assertCanGrant(ctx, d);
      assertDefaultBranch(d.defaultBranchId, d);
      assertPassword(d.password, d.username);
      const hash = await hashPassword(d.password);
      return inTransaction(db, () => {
        // كلمة مرور يضعها المدير ⇒ يغيّرها المستخدم عند أول دخول.
        const id = insert({ ...d, mustChangePassword: true }, hash, { createdBy: ctx.user.id });
        audit.fromCtx(ctx, { action: 'user.created', source: 'security', entityType: 'user', entityId: id,
          details: { username: d.username, displayName: d.displayName, roleIds: d.roleIds, branchIds: d.branchIds, allBranches: d.allBranches, isSuperAdmin: d.isSuperAdmin, defaultBranchId: d.defaultBranchId ?? null } });
        return toApi(row(id));
      });
    },

    update(ctx, id, body) {
      const d = validateUser(body, { partial: true });
      return inTransaction(db, () => {
        const u = row(id);
        if (!u) throw new HttpError(404, 'NOT_FOUND', 'المستخدم غير موجود');
        guard.assertCanManage(ctx, u);
        const before = toApi(u);
        const next = {
          displayName: d.displayName ?? before.displayName,
          roleIds: d.roleIds ?? before.roleIds,
          isSuperAdmin: d.isSuperAdmin ?? before.isSuperAdmin,
          allBranches: d.allBranches ?? before.allBranches,
          branchIds: d.branchIds ?? before.branchIds,
          defaultBranchId: 'defaultBranchId' in d ? d.defaultBranchId : before.defaultBranchId,
        };
        if (next.isSuperAdmin) next.allBranches = true;
        if (next.allBranches) next.branchIds = [];
        const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
        const accessChanged = !same(next.roleIds, before.roleIds) || !same(next.branchIds, before.branchIds)
          || next.allBranches !== before.allBranches || next.isSuperAdmin !== before.isSuperAdmin;

        // لا يعدّل المستخدم أدواره أو نطاقه بنفسه (يمنع التصعيد الذاتي وإغلاق الحساب على نفسه).
        if (accessChanged && id === ctx.user.id) throw new HttpError(403, 'SELF_MODIFICATION', 'لا يمكنك تعديل صلاحياتك أو نطاقك بنفسك');
        if (next.isSuperAdmin !== before.isSuperAdmin && !ctx.user.isSuperAdmin) throw new HttpError(403, 'SUPER_ADMIN_ONLY', 'هذا الإجراء للمدير العام فقط');
        if (before.isSuperAdmin && !next.isSuperAdmin) assertNotLastSuperAdmin(id);
        assertRolesExist(next.roleIds); assertBranchesExist(next.branchIds);
        // يُتحقق فقط مما يُضاف فعلًا (ما كان ممنوحًا قبلًا لا يُعاد فحصه).
        guard.assertCanGrant(ctx, {
          roleIds: next.roleIds.filter((r) => !before.roleIds.includes(r)),
          branchIds: next.branchIds.filter((b) => !before.branchIds.includes(b)),
          allBranches: next.allBranches && !before.allBranches,
          isSuperAdmin: next.isSuperAdmin && !before.isSuperAdmin,
        });
        assertDefaultBranch(next.defaultBranchId, next);

        db.prepare(`UPDATE users SET display_name = ?, is_super_admin = ?, all_branches = ?, default_branch_id = ?,
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
          .run(next.displayName, next.isSuperAdmin ? 1 : 0, next.allBranches ? 1 : 0, next.defaultBranchId ?? null, id);
        setLinks(id, next.roleIds, next.branchIds);

        const changes = {};
        for (const k of Object.keys(next)) {
          const a = before[k]; const b = next[k];
          if (Array.isArray(a) ? !same(a, b) : a !== b) changes[k] = { from: a, to: b };
        }
        if (Object.keys(changes).length) {
          audit.fromCtx(ctx, { action: accessChanged ? 'user.access.updated' : 'user.updated', source: 'security', entityType: 'user', entityId: id, details: { username: u.username, changes } });
        }
        return toApi(row(id));
      });
    },

    setActive(ctx, id, active) {
      return inTransaction(db, () => {
        const u = row(id);
        if (!u) throw new HttpError(404, 'NOT_FOUND', 'المستخدم غير موجود');
        if (id === ctx.user.id) throw new HttpError(403, 'SELF_MODIFICATION', 'لا يمكنك تعطيل حسابك بنفسك');
        guard.assertCanManage(ctx, u);
        if ((u.is_active === 1) === active) return toApi(u);
        if (!active && u.is_super_admin === 1) assertNotLastSuperAdmin(id);
        db.prepare("UPDATE users SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(active ? 1 : 0, id);
        const ended = active ? 0 : sessions.destroyForUser(id);
        audit.fromCtx(ctx, { action: active ? 'user.activated' : 'user.deactivated', source: 'security', entityType: 'user', entityId: id, details: { username: u.username, sessionsEnded: ended } });
        return toApi(row(id));
      });
    },

    /** إعادة تعيين كلمة المرور بواسطة المدير: تُنهي جلسات المستخدم وتفك القفل وتُلزمه بتغييرها. */
    async resetPassword(ctx, id, body) {
      const { password } = validator(body).secret('password', { required: true, min: 1 }).done();
      const u0 = row(id);
      if (!u0) throw new HttpError(404, 'NOT_FOUND', 'المستخدم غير موجود');
      if (id === ctx.user.id) throw new HttpError(403, 'SELF_MODIFICATION', 'غيّر كلمة مرورك من شاشة حسابك');
      guard.assertCanManage(ctx, u0);
      assertPassword(password, u0.username);
      const hash = await hashPassword(password);
      return inTransaction(db, () => {
        db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 1, password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(hash, id);
        const ended = sessions.destroyForUser(id);
        throttle.reset('u:' + u0.username.toLowerCase());
        audit.fromCtx(ctx, { action: 'user.password.reset', source: 'security', entityType: 'user', entityId: id, details: { username: u0.username, sessionsEnded: ended } });
        return toApi(row(id));
      });
    },
  };
}

function registerUserRoutes(router, services) {
  const { users } = services;
  router.get('/api/users', { permission: 'users.view' }, () => users.list());
  router.get('/api/users/:id', { permission: 'users.view' }, (ctx) => users.get(idParam(ctx.params.id)));
  router.post('/api/users', { permission: 'users.create' }, async (ctx) => users.create(ctx, await ctx.body()));
  router.put('/api/users/:id', { permission: 'users.update' }, async (ctx) => users.update(ctx, idParam(ctx.params.id), await ctx.body()));
  router.post('/api/users/:id/status', { permission: 'users.disable' }, async (ctx) => {
    const { active } = validator(await ctx.body()).bool('active', { required: true }).done();
    return users.setActive(ctx, idParam(ctx.params.id), active);
  });
  router.post('/api/users/:id/password', { permission: 'users.update' }, async (ctx) => users.resetPassword(ctx, idParam(ctx.params.id), await ctx.body()));
}

module.exports = { createUserService, registerUserRoutes, USERNAME_RE };

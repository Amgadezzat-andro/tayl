'use strict';
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { verifyPassword, dummyVerify, hashPassword, passwordProblem } = require('./passwords');

function registerAuthRoutes(router, services) {
  const { db, audit, sessions, throttle, accessLoader, branches, settings } = services;

  function sessionPayload(ctx, s, user, access) {
    const list = branches.list({ ids: access.operationalBranchIds() });
    const current = list.find((b) => b.id === s.branch_id) || null;
    return {
      user: {
        id: user.id, username: user.username, displayName: user.displayName, isSuperAdmin: user.isSuperAdmin,
        allBranches: user.allBranches, mustChangePassword: user.mustChangePassword, permissions: [...user.permissions].sort(),
      },
      branch: current,
      branches: list,
      csrfToken: s.csrf_token,
      session: { expiresAt: s.expires_at, idleExpiresAt: s.idleExpiresAt, idleMinutes: settings.get().sessionIdleMinutes },
    };
  }

  router.post('/api/auth/login', { public: true }, async (ctx) => {
    const body = validator(await ctx.body())
      .str('username', { required: true, max: 64 })
      .secret('password', { required: true, min: 1, max: 128 })
      .done();
    const keys = throttle.keysFor(body.username, ctx.ip);
    try { throttle.check(keys); } catch (e) {
      audit.fromCtx(ctx, { action: 'auth.login.blocked', source: 'security', entityType: 'user', details: { username: body.username } });
      throw e;
    }

    const u = db.prepare('SELECT * FROM users WHERE username = ?').get(body.username);
    const ok = u ? await verifyPassword(body.password, u.password_hash) : await dummyVerify(body.password);
    if (!ok) {
      const locked = inTransaction(db, () => {
        const l = throttle.fail(keys);
        audit.fromCtx(ctx, { action: 'auth.login.failure', source: 'security', entityType: 'user', entityId: u ? u.id : null, details: { username: body.username, reason: 'bad_credentials', locked: l } });
        return l;
      });
      if (locked) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'محاولات دخول كثيرة، حاول لاحقًا');
      throw new HttpError(401, 'INVALID_CREDENTIALS', 'اسم المستخدم أو كلمة المرور غير صحيحة');
    }
    if (u.is_active !== 1) {
      audit.fromCtx(ctx, { action: 'auth.login.failure', source: 'security', entityType: 'user', entityId: u.id, details: { username: u.username, reason: 'inactive' } });
      throw new HttpError(403, 'ACCOUNT_DISABLED', 'هذا الحساب معطّل');
    }

    const loaded = accessLoader.load(u.id);
    const operational = loaded.access.operationalBranchIds();
    const branchId = u.default_branch_id != null && operational.includes(u.default_branch_id) ? u.default_branch_id : (operational[0] ?? null);
    const created = inTransaction(db, () => {
      throttle.reset(keys[0].key);
      sessions.purgeExpired();
      const c = sessions.create({ userId: u.id, branchId, ip: ctx.ip, userAgent: ctx.req.headers['user-agent'] });
      db.prepare("UPDATE users SET last_login_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(u.id);
      audit.fromCtx(ctx, { action: 'auth.login.success', source: 'security', entityType: 'user', entityId: u.id, userId: u.id, actor: u.username, details: { branchId } });
      return c;
    });
    sessions.setCookie(ctx, created.token);
    const s = { branch_id: branchId, csrf_token: created.csrf, expires_at: created.expiresAt, idleExpiresAt: Date.now() + settings.get().sessionIdleMinutes * 60000 };
    return sessionPayload(ctx, s, loaded.user, loaded.access);
  });

  router.post('/api/auth/logout', { auth: true }, (ctx) => {
    inTransaction(db, () => {
      sessions.destroy(ctx.session.token_hash);
      audit.fromCtx(ctx, { action: 'auth.logout', source: 'security', entityType: 'user', entityId: ctx.user.id });
    });
    sessions.clearCookie(ctx);
    return { ok: true };
  });

  router.get('/api/auth/session', { auth: true }, (ctx) => sessionPayload(ctx, ctx.session, ctx.user, ctx.access));

  router.post('/api/auth/password', { auth: true }, async (ctx) => {
    const body = validator(await ctx.body())
      .secret('currentPassword', { required: true, min: 1 })
      .secret('newPassword', { required: true, min: 1 })
      .done();
    const u = db.prepare('SELECT * FROM users WHERE id = ?').get(ctx.user.id);
    if (!(await verifyPassword(body.currentPassword, u.password_hash))) {
      audit.fromCtx(ctx, { action: 'auth.password.change_failed', source: 'security', entityType: 'user', entityId: u.id, details: { reason: 'bad_current_password' } });
      throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { currentPassword: 'WRONG_PASSWORD' } });
    }
    const problem = passwordProblem(body.newPassword, { username: u.username, minLength: settings.get().passwordMinLength });
    if (problem) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { newPassword: problem } });
    if (await verifyPassword(body.newPassword, u.password_hash)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { newPassword: 'PASSWORD_UNCHANGED' } });
    const hash = await hashPassword(body.newPassword);
    inTransaction(db, () => {
      db.prepare(`UPDATE users SET password_hash = ?, must_change_password = 0, password_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'),
        updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(hash, u.id);
      const ended = sessions.destroyForUser(u.id, ctx.session.token_hash);   // أي جلسة أخرى (جهاز آخر) تنتهي
      audit.fromCtx(ctx, { action: 'auth.password.changed', source: 'security', entityType: 'user', entityId: u.id, details: { otherSessionsEnded: ended } });
    });
    return { ok: true };
  });

  // تبديل الفرع الحالي للجلسة — فقط إلى فرع نشط مصرح به.
  router.post('/api/auth/branch', { auth: true }, async (ctx) => {
    const { branchId } = validator(await ctx.body()).id('branchId', { required: true }).done();
    ctx.access.assertBranch(branchId);
    if (!ctx.access.operationalBranchIds().includes(branchId)) throw new HttpError(409, 'BRANCH_INACTIVE', 'الفرع معطّل');
    sessions.setBranch(ctx.session.token_hash, branchId);
    ctx.session.branch_id = branchId;
    return sessionPayload(ctx, ctx.session, ctx.user, ctx.access);
  });
}

module.exports = { registerAuthRoutes };

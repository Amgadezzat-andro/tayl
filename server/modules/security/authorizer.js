'use strict';
const { HttpError } = require('../../core/errors');

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
// المسارات المتاحة لمستخدم مطلوب منه تغيير كلمة المرور قبل أي شيء آخر.
const PASSWORD_CHANGE_ALLOWED = new Set(['/api/auth/session', '/api/auth/logout', '/api/auth/password']);

/**
 * المُصرِّح المسجَّل في services.authorizer — يُستدعى من http.js لكل مسار غير عام:
 *  1) جلسة سارية من الكوكي، ومستخدم نشط  ← وإلا 401
 *  2) رمز CSRF للطلبات المغيِّرة           ← وإلا 403
 *  3) الفرع الحالي ما زال نشطًا ومصرحًا به ← وإلا يُختار غيره تلقائيًا
 *  4) تغيير كلمة المرور الإجباري           ← وإلا 403 لكل شيء آخر
 *  5) الصلاحية المطلوبة للمسار            ← وإلا 403
 */
function createAuthorizer({ sessions, accessLoader, logger }) {
  return async function authorizer(ctx, permission) {
    const s = sessions.lookup(ctx.req);
    if (!s) throw new HttpError(401, 'UNAUTHENTICATED', 'يلزم تسجيل الدخول');
    const loaded = accessLoader.load(s.user_id);
    if (!loaded) {
      sessions.destroy(s.token_hash);
      throw new HttpError(401, 'UNAUTHENTICATED', 'يلزم تسجيل الدخول');
    }
    if (UNSAFE.has(ctx.req.method) && !sessions.csrfMatches(s, ctx.req.headers['x-csrf-token'])) {
      throw new HttpError(403, 'CSRF_INVALID', 'رمز الحماية غير صالح؛ أعد تحميل الصفحة');
    }
    ctx.user = loaded.user;
    ctx.access = loaded.access;
    ctx.session = s;

    const operational = loaded.access.operationalBranchIds();
    if (s.branch_id == null || !operational.includes(s.branch_id)) {
      const d = loaded.user.defaultBranchId;
      const next = d != null && operational.includes(d) ? d : (operational[0] ?? null);
      if (next !== s.branch_id) { sessions.setBranch(s.token_hash, next); s.branch_id = next; }
    }
    ctx.branchId = s.branch_id;

    const pathname = new URL(ctx.req.url, 'http://x').pathname.replace(/\/$/, '');
    if (loaded.user.mustChangePassword && !PASSWORD_CHANGE_ALLOWED.has(pathname)) {
      throw new HttpError(403, 'PASSWORD_CHANGE_REQUIRED', 'يجب تغيير كلمة المرور أولًا');
    }
    if (permission && !loaded.access.can(permission)) {
      logger.warn('access denied', { requestId: ctx.requestId, user: loaded.user.username, permission, path: pathname });
      throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية');
    }
  };
}

module.exports = { createAuthorizer };

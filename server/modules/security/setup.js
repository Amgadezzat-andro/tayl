'use strict';
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { hashPassword } = require('./passwords');
const { USERNAME_RE } = require('./users');

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);

/**
 * التأسيس الأول — مرة واحدة فقط في عمر النسخة:
 * الشركة + الفرع الرئيسي + المدير العام الأول، في معاملة واحدة (كل شيء أو لا شيء).
 * بعد اكتماله يُرفض المسار نهائيًا (409)، وجدول company نفسه لا يقبل صفًا ثانيًا.
 * تعديل بيانات التأسيس لاحقًا = شاشة بيانات الشركة والفروع، وتتطلب صلاحيات company.update / branches.update.
 */
function registerSetupRoute(router, services) {
  const { db, audit, company, branches, users, config } = services;

  router.post('/api/setup', { public: true }, async (ctx) => {
    if (company.isSetUp()) throw new HttpError(409, 'SETUP_ALREADY_COMPLETED', 'تم تأسيس النظام مسبقًا');
    // قبل وجود أي مستخدم لا توجد مصادقة، فنقصر التأسيس على نفس الجهاز ما لم يُسمح صراحة.
    if (!config.allowRemoteSetup && !LOOPBACK.has(ctx.ip)) throw new HttpError(403, 'SETUP_LOCAL_ONLY', 'التأسيس الأول مسموح من جهاز الخادم فقط');

    const body = await ctx.body();
    if (!body || typeof body !== 'object') throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { _: 'OBJECT_REQUIRED' } });
    const errors = {};
    const collect = (prefix, fn) => {
      try { return fn(); } catch (e) {
        if (e instanceof HttpError && e.code === 'VALIDATION') { for (const [k, v] of Object.entries(e.details.fields)) errors[`${prefix}.${k}`] = v; return null; }
        throw e;
      }
    };
    const c = collect('company', () => company.validateProfile(body.company));
    const b = collect('branch', () => branches.validateBranch(body.branch));
    const a = collect('admin', () => validator(body.admin)
      .str('username', { required: true, pattern: USERNAME_RE, max: 64 })
      .str('displayName', { required: true, max: 120 })
      .secret('password', { required: true, min: 1 })
      .done());
    if (a) collect('admin', () => users.assertPassword(a.password, a.username));
    if (Object.keys(errors).length) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: errors });
    const logo = body.logo ? company.decodeLogo(body.logo.data) : null;

    const hash = await hashPassword(a.password);
    try {
      return inTransaction(db, () => {
        if (company.isSetUp()) throw new HttpError(409, 'SETUP_ALREADY_COMPLETED', 'تم تأسيس النظام مسبقًا');
        company.insert(c, logo);
        const branchId = branches.insert(b, { isMain: true });
        const userId = users.insert({ username: a.username, displayName: a.displayName, isSuperAdmin: true, allBranches: true, defaultBranchId: branchId }, hash);
        const actor = { userId, actor: a.username };
        audit.fromCtx(ctx, { ...actor, action: 'setup.completed', source: 'security', entityType: 'company', entityId: 1,
          details: { company: c, logo: logo ? { mime: logo.mime, bytes: logo.logo.length, sha256: logo.sha256 } : null } });
        audit.fromCtx(ctx, { ...actor, action: 'branch.created', source: 'security', entityType: 'branch', entityId: branchId, details: { branch: b, isMain: true } });
        audit.fromCtx(ctx, { ...actor, action: 'user.created', source: 'security', entityType: 'user', entityId: userId, details: { username: a.username, displayName: a.displayName, isSuperAdmin: true } });
        return { ok: true };
      });
    } catch (e) {
      // طلبا تأسيس متزامنان: الثاني يصطدم بقيد الشركة الوحيدة في القاعدة.
      if (e && /SQLITE_CONSTRAINT/.test(e.code || '') && company.isSetUp()) throw new HttpError(409, 'SETUP_ALREADY_COMPLETED', 'تم تأسيس النظام مسبقًا');
      throw e;
    }
  });
}

module.exports = { registerSetupRoute };

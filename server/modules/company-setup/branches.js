'use strict';
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');

const CODE_RE = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
const FIELDS = [
  ['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['addressAr', 'address_ar'],
  ['addressEn', 'address_en'], ['phone', 'phone'], ['email', 'email'],
];

function toApi(r) {
  if (!r) return null;
  return {
    id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, addressAr: r.address_ar, addressEn: r.address_en,
    phone: r.phone, email: r.email, isMain: r.is_main === 1, isActive: r.is_active === 1, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function validateBranch(body, { partial = false } = {}) {
  return validator(body, { partial })
    .str('code', { required: true, upper: true, pattern: CODE_RE })
    .str('nameAr', { required: true, max: 200 })
    .str('nameEn', { required: true, max: 200 })
    .str('addressAr', { max: 500, multiline: true })
    .str('addressEn', { max: 500, multiline: true })
    .phone('phone')
    .email('email')
    .done();
}

const isUniqueViolation = (e) => e && e.code === 'SQLITE_CONSTRAINT_UNIQUE';

function createBranchService({ db, audit }) {
  const byId = (id) => db.prepare('SELECT * FROM branches WHERE id = ?').get(id);

  function insert(data, { isMain = false } = {}) {
    try {
      const info = db.prepare(`INSERT INTO branches (${FIELDS.map((f) => f[1]).join(', ')}, is_main, is_active)
        VALUES (${FIELDS.map(() => '?').join(', ')}, ?, 1)`).run(...FIELDS.map(([api]) => data[api] ?? null), isMain ? 1 : 0);
      return Number(info.lastInsertRowid);
    } catch (e) {
      if (isUniqueViolation(e)) throw new HttpError(409, 'BRANCH_CODE_TAKEN', 'كود الفرع مستخدم من قبل', { fields: { code: 'TAKEN' } });
      throw e;
    }
  }

  return {
    validateBranch,
    insert,
    get: (id) => toApi(byId(id)),
    exists: (id) => !!byId(id),
    isActive: (id) => { const b = byId(id); return !!b && b.is_active === 1; },
    /** كل الفروع، أو المحددة فقط إذا مُرِّرت قائمة (نطاق المستخدم). */
    list({ ids = null, activeOnly = false } = {}) {
      const where = [];
      const args = [];
      if (ids) { if (!ids.length) return []; where.push(`id IN (${ids.map(() => '?').join(',')})`); args.push(...ids); }
      if (activeOnly) where.push('is_active = 1');
      return db.prepare(`SELECT * FROM branches ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY is_main DESC, code`).all(...args).map(toApi);
    },

    create(ctx, body) {
      const data = validateBranch(body);
      return inTransaction(db, () => {
        const id = insert(data);
        audit.fromCtx(ctx, { action: 'branch.created', source: 'company-setup', entityType: 'branch', entityId: id, details: { branch: data } });
        return toApi(byId(id));
      });
    },

    update(ctx, id, body) {
      const data = validateBranch(body, { partial: true });
      const v = validator(body || {}, { partial: true }).bool('isMain').done();
      return inTransaction(db, () => {
        const before = byId(id);
        if (!before) throw new HttpError(404, 'NOT_FOUND', 'الفرع غير موجود');
        const changes = FIELDS.filter(([api]) => api in data);
        if (changes.length) {
          try {
            db.prepare(`UPDATE branches SET ${changes.map(([, c]) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
              .run(...changes.map(([api]) => data[api]), id);
          } catch (e) {
            if (isUniqueViolation(e)) throw new HttpError(409, 'BRANCH_CODE_TAKEN', 'كود الفرع مستخدم من قبل', { fields: { code: 'TAKEN' } });
            throw e;
          }
        }
        const diff = {};
        for (const [api, col] of changes) if (before[col] !== data[api]) diff[api] = { from: before[col], to: data[api] };

        if (v.isMain === false && before.is_main === 1) throw new HttpError(409, 'MAIN_BRANCH_REQUIRED', 'يجب تحديد فرع رئيسي آخر بدلًا من إلغاء الرئيسي');
        if (v.isMain === true && before.is_main === 0) {
          // تغيير الفرع الرئيسي يؤثر على كل الفروع، فيتطلب نطاق جميع الفروع.
          if (!ctx.access.allBranches) throw new HttpError(403, 'BRANCH_SCOPE_EXCEEDED', 'تغيير الفرع الرئيسي يتطلب صلاحية الوصول لجميع الفروع');
          if (before.is_active !== 1) throw new HttpError(409, 'BRANCH_INACTIVE', 'لا يمكن جعل فرع معطّل فرعًا رئيسيًا');
          const old = db.prepare('SELECT id FROM branches WHERE is_main = 1').get();
          db.prepare("UPDATE branches SET is_main = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE is_main = 1").run();
          db.prepare("UPDATE branches SET is_main = 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(id);
          audit.fromCtx(ctx, { action: 'branch.main.changed', source: 'company-setup', entityType: 'branch', entityId: id, details: { from: old ? old.id : null, to: id } });
        }
        if (Object.keys(diff).length) audit.fromCtx(ctx, { action: 'branch.updated', source: 'company-setup', entityType: 'branch', entityId: id, details: { changes: diff } });
        return toApi(byId(id));
      });
    },

    setActive(ctx, id, active) {
      return inTransaction(db, () => {
        const b = byId(id);
        if (!b) throw new HttpError(404, 'NOT_FOUND', 'الفرع غير موجود');
        if (!active && b.is_main === 1) throw new HttpError(409, 'MAIN_BRANCH_CANNOT_DISABLE', 'لا يمكن تعطيل الفرع الرئيسي');
        if ((b.is_active === 1) === active) return toApi(b);
        db.prepare("UPDATE branches SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(active ? 1 : 0, id);
        audit.fromCtx(ctx, { action: active ? 'branch.activated' : 'branch.deactivated', source: 'company-setup', entityType: 'branch', entityId: id, details: { code: b.code } });
        return toApi(byId(id));
      });
    },
  };
}

function registerBranchRoutes(router, services) {
  const { branches } = services;

  // القائمة مقيّدة بنطاق المستخدم: لا يرى فرعًا غير مصرح له به.
  router.get('/api/branches', { permission: 'branches.view' }, (ctx) => branches.list({ ids: ctx.access.allBranches ? null : ctx.access.branchIds() }));

  router.get('/api/branches/:id', { permission: 'branches.view' }, (ctx) => {
    const id = idParam(ctx.params.id);
    ctx.access.assertBranch(id);
    const b = branches.get(id);
    if (!b) throw new HttpError(404, 'NOT_FOUND', 'الفرع غير موجود');
    return b;
  });

  router.post('/api/branches', { permission: 'branches.create' }, async (ctx) => {
    // فرع جديد خارج أي نطاق محدود؛ إنشاؤه يتطلب صلاحية جميع الفروع.
    if (!ctx.access.allBranches) throw new HttpError(403, 'BRANCH_SCOPE_EXCEEDED', 'إنشاء فرع يتطلب صلاحية الوصول لجميع الفروع');
    return branches.create(ctx, await ctx.body());
  });

  router.put('/api/branches/:id', { permission: 'branches.update' }, async (ctx) => {
    const id = idParam(ctx.params.id);
    ctx.access.assertBranch(id);
    return branches.update(ctx, id, await ctx.body());
  });

  router.post('/api/branches/:id/status', { permission: 'branches.disable' }, async (ctx) => {
    const id = idParam(ctx.params.id);
    ctx.access.assertBranch(id);
    const { active } = validator(await ctx.body()).bool('active', { required: true }).done();
    return branches.setActive(ctx, id, active);
  });
}

module.exports = { createBranchService, registerBranchRoutes, validateBranch, CODE_RE };

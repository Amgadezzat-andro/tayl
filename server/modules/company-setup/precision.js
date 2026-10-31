'use strict';
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { createPolicy, validateRow, KINDS, ROUNDING } = require('../../core/decimal');
const { INTERMEDIATE_PRECISION } = require('../../core/decimal/engine');

/**
 * سياسة الدقة المحفوظة في القاعدة (decimal_policy) ← تُحمَّل في services.decimal عند التشغيل وبعد كل تعديل.
 * هذا هو المكان الوحيد الذي تُغيَّر منه قواعد التقريب؛ الوحدات لا تضع قواعدها الخاصة.
 */
function createPrecisionService({ db, audit, decimal }) {
  const order = Object.keys(KINDS);
  const rows = () => db.prepare('SELECT kind, currency, commit_scale, display_scale, rounding FROM decimal_policy ORDER BY currency').all()
    .map((r) => ({ kind: r.kind, currency: r.currency, commitScale: r.commit_scale, displayScale: r.display_scale, rounding: r.rounding }))
    .sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind) || a.currency.localeCompare(b.currency));

  const load = () => decimal.setPolicy(createPolicy(rows()));

  /** يستبدل السياسة كاملة: صف افتراضي لكل نوع + أي تخصيصات حسب العملة. */
  function replace(ctx, body) {
    const list = body && body.rows;
    if (!Array.isArray(list) || list.length > 500) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { rows: 'INVALID' } });
    const fields = {};
    const clean = list.map((r, i) => {
      const c = r && typeof r === 'object'
        ? { kind: r.kind, currency: typeof r.currency === 'string' ? r.currency.trim().toUpperCase() : r.currency, commitScale: r.commitScale, displayScale: r.displayScale, rounding: r.rounding }
        : null;
      const errs = validateRow(c);
      if (errs.length) fields[`rows.${i}`] = errs[0];
      return c;
    });
    if (Object.keys(fields).length) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields });
    let policy;
    try { policy = createPolicy(clean); } catch { throw new HttpError(400, 'POLICY_INCOMPLETE', 'يجب وجود صف افتراضي واحد لكل نوع بلا تكرار'); }

    return inTransaction(db, () => {
      const before = rows();
      db.prepare("DELETE FROM decimal_policy WHERE currency <> ''").run();
      const up = db.prepare(`INSERT INTO decimal_policy (kind, currency, commit_scale, display_scale, rounding, updated_by) VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT (kind, currency) DO UPDATE SET commit_scale = excluded.commit_scale, display_scale = excluded.display_scale,
          rounding = excluded.rounding, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      for (const r of policy.rows()) up.run(r.kind, r.currency, r.commitScale, r.displayScale, r.rounding, ctx.user ? ctx.user.id : null);
      const after = rows();
      const key = (r) => `${r.kind}|${r.currency}`;
      const show = (r) => (r ? `${r.commitScale}/${r.displayScale}/${r.rounding}` : null);
      const b = new Map(before.map((r) => [key(r), r]));
      const a = new Map(after.map((r) => [key(r), r]));
      const changes = {};
      for (const k of new Set([...b.keys(), ...a.keys()])) if (show(b.get(k)) !== show(a.get(k))) changes[k] = { from: show(b.get(k)), to: show(a.get(k)) };
      if (Object.keys(changes).length) audit.fromCtx(ctx, { action: 'precision.updated', source: 'company-setup', entityType: 'decimal_policy', details: { changes } });
      decimal.setPolicy(policy);   // بعد نجاح الكتابة فقط (إن فشلت المعاملة تبقى السياسة السابقة)
      return after;
    });
  }

  function describe() {
    return {
      intermediatePrecision: INTERMEDIATE_PRECISION,
      kinds: Object.entries(KINDS).map(([kind, k]) => ({ kind, storageScale: k.storageScale, maxIntegerDigits: k.maxIntegerDigits })),
      roundingModes: Object.keys(ROUNDING),
      rows: rows(),
    };
  }

  return { load, rows, replace, describe };
}

function registerPrecisionRoutes(router, services) {
  const { precision, decimal } = services;
  router.get('/api/precision', { permission: 'precision.view' }, () => precision.describe());
  router.put('/api/precision', { permission: 'precision.update' }, async (ctx) => {
    precision.replace(ctx, await ctx.body());
    return precision.describe();
  });

  // معاينة أثر السياسة على قيمة: كل الحساب على الخادم بالمحرك المركزي.
  router.post('/api/precision/preview', { permission: 'precision.view' }, async (ctx) => {
    const v = validator(await ctx.body())
      .oneOf('kind', Object.keys(KINDS), { required: true })
      .str('currency', { max: 3, upper: true, pattern: /^[A-Z]{3}$/ })
      .decimal('value', { required: true })
      .done();
    const p = decimal.policy().resolve(v.kind, v.currency || '');
    const committed = decimal.round(v.value, v.kind, v.currency || '');
    return {
      input: decimal.canonical(v.value),
      committed: decimal.canonical(committed),
      stored: decimal.toStorage(committed, v.kind),
      display: decimal.format(committed, v.kind, v.currency || ''),
      policy: p,
    };
  });
}

module.exports = { createPrecisionService, registerPrecisionRoutes };

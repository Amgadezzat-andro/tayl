'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { createMasterService, registerMasterRoutes, masterActions } = require('../../core/master');
const ISO = require('./iso4217');

/**
 * العملات وأسعار الصرف.
 *  - العملة الأساسية = عملة الشركة من التأسيس (تُنشأ تلقائيًا كسجل)، لا تُعطَّل ولا تُحذف ولا يُعرَّف لها سعر.
 *  - تغيير العملة الأساسية من شاشة الشركة فقط وبقواعد المرحلة 1؛ ووجود أسعار صرف (المحسوبة نسبة إليها) يقفلها.
 *  - الأسعار تاريخية: لا تعديل، ولا تكرار لنفس (العملة، النوع، التاريخ).
 *  - للمستندات القادمة: rateSnapshot() تُحفظ داخل المستند، و convert() تحسب بالمحرك العشري؛ لا إعادة حساب بالسعر الحالي.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const RATE_TYPES = ['buy', 'sell', 'average'];
const validDate = (s) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s + 'T00:00:00Z')) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;

module.exports = {
  name: 'currencies',
  version: '1.0.0',
  dependsOn: ['company-setup'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db, decimal, audit, company } = services;
    services.permissions.register('currencies', [
      { resource: 'currencies', group: 'accounting', actions: masterActions(), special: ['manage_rates'] },
    ]);
    const baseCode = () => { const c = company.get(); return c ? c.baseCurrency : null; };
    const byCode = (code) => db.prepare('SELECT * FROM currencies WHERE code = ?').get(code);

    /** يضمن وجود سجل للعملة الأساسية (بعد التأسيس أو بعد تغييرها). */
    function ensureBase() {
      const code = baseCode();
      if (!code || byCode(code)) return;
      const iso = ISO[code];
      db.prepare('INSERT INTO currencies (code, name_ar, name_en, symbol, display_decimals, is_iso) VALUES (?, ?, ?, ?, ?, ?)')
        .run(code, iso ? iso[2] : code, iso ? iso[3] : code, iso ? iso[1] : null, iso ? Math.min(iso[0], 8) : 2, iso ? 1 : 0);
    }

    const svc = createMasterService(services, {
      entity: 'currency', table: 'currencies', source: 'currencies', titleKey: 'nav.currencies',
      columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['symbol', 'symbol'], ['displayDecimals', 'display_decimals'], ['isIso', 'is_iso']],
      validate(body, { partial }) {
        const d = validator(body, { partial })
          .str('code', { required: true, upper: true, pattern: /^[A-Z]{3}$/ })
          .str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 })
          .str('symbol', { max: 8 }).int('displayDecimals', { required: true, min: 0, max: 8 })
          .done();
        if (d.code) d.isIso = ISO[d.code] ? 1 : 0;
        return d;
      },
      beforeSave(ctx, d, before) {
        if (before && 'code' in d && d.code !== before.code && before.code === baseCode()) throw new HttpError(409, 'BASE_CURRENCY_PROTECTED', 'كود العملة الأساسية يتغير من شاشة الشركة فقط');
        if (before && 'code' in d && d.code !== before.code && db.prepare('SELECT 1 FROM exchange_rates WHERE currency_id = ? LIMIT 1').get(before.id)) {
          throw new HttpError(409, 'CODE_LOCKED', 'لا يمكن تغيير كود عملة لها أسعار صرف');
        }
      },
      beforeActive(ctx, row, active) {
        if (!active && row.code === baseCode()) throw new HttpError(409, 'BASE_CURRENCY_PROTECTED', 'لا يمكن تعطيل العملة الأساسية');
      },
      beforeDelete(ctx, row) {
        if (row.code === baseCode()) throw new HttpError(409, 'BASE_CURRENCY_PROTECTED', 'لا يمكن حذف العملة الأساسية');
        if (db.prepare('SELECT 1 FROM exchange_rates WHERE currency_id = ? LIMIT 1').get(row.id)) throw new HttpError(409, 'IN_USE', 'للعملة أسعار صرف مسجلة؛ عطّلها بدل حذفها', { usedBy: ['exchange-rates'] });
      },
      toApi: (r) => ({
        id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, symbol: r.symbol, displayDecimals: r.display_decimals,
        isIso: r.is_iso === 1, isActive: r.is_active === 1, isBase: r.code === baseCode(),
        latestRates: Object.fromEntries(RATE_TYPES.map((t) => {
          const x = db.prepare('SELECT effective_date, rate FROM exchange_rates WHERE currency_id = ? AND rate_type = ? ORDER BY effective_date DESC LIMIT 1').get(r.id, t);
          return [t, x ? { effectiveDate: x.effective_date, rate: x.rate } : null];
        })),
      }),
      lookupExtra: (r) => ({ symbol: r.symbol, isBase: r.code === baseCode() }),
      exportColumns: [
        { label: 'currency.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
        { label: 'currency.symbol', value: (r) => r.symbol }, { label: 'currency.displayDecimals', value: (r) => String(r.displayDecimals) },
        { label: 'currency.isBase', value: (r, t) => (r.isBase ? t('common.yes') : '') },
        { label: 'currency.rate.average', value: (r) => (r.latestRates.average ? `${r.latestRates.average.rate} (${r.latestRates.average.effectiveDate})` : '') },
        { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
      ],
    });

    // خانات عرض العملة تغذي سياسة الدقة المركزية (ما لم يوجد صف مخصص لها في شاشة الدقة)
    decimal.setCurrencyDisplay((code) => { const r = byCode(code); return r ? r.display_decimals : null; });
    // أسعار الصرف محسوبة نسبة للعملة الأساسية ⇒ وجودها يقفل تغيير العملة الأساسية (قواعد المرحلة 1)
    services.financialActivity.register('exchange-rates', (d) => !!d.prepare('SELECT 1 FROM exchange_rates LIMIT 1').get());
    // الوحدات القادمة تسجّل استخدام سعر الصرف في مستنداتها: services.usage.register('exchange_rate', ...)

    // ── الأسعار ──
    const rateApi = (r) => ({ id: r.id, currencyId: r.currency_id, rateType: r.rate_type, effectiveDate: r.effective_date, rate: r.rate, note: r.note, createdBy: r.created_by, createdAt: r.created_at });
    function rates(currencyId, { type, from, to } = {}) {
      const w = ['currency_id = ?']; const p = [currencyId];
      if (RATE_TYPES.includes(type)) { w.push('rate_type = ?'); p.push(type); }
      if (validDate(from || '')) { w.push('effective_date >= ?'); p.push(from); }
      if (validDate(to || '')) { w.push('effective_date <= ?'); p.push(to); }
      return db.prepare(`SELECT * FROM exchange_rates WHERE ${w.join(' AND ')} ORDER BY effective_date DESC, rate_type`).all(...p).map(rateApi);
    }
    function addRate(ctx, currencyId, body) {
      const v = validator(body).oneOf('rateType', RATE_TYPES, { required: true }).str('effectiveDate', { required: true, pattern: DATE_RE })
        .decimal('rate', { required: true }).str('note', { max: 300 }).done();
      if (!validDate(v.effectiveDate)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { effectiveDate: 'INVALID' } });
      if (!decimal.gt(v.rate, '0')) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { rate: 'MUST_BE_POSITIVE' } });
      // لا تقريب صامت: السعر يجب أن يكون بدقة اعتماد أسعار الصرف
      const stored = decimal.commit(v.rate, 'fx_rate');
      if (!decimal.eq(stored, v.rate)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { rate: 'TOO_PRECISE' } });
      return inTransaction(db, () => {
        const cur = svc.byId(currencyId);
        if (!cur) throw new HttpError(404, 'NOT_FOUND', 'العملة غير موجودة');
        if (cur.code === baseCode()) throw new HttpError(409, 'BASE_CURRENCY_RATE', 'سعر العملة الأساسية 1 دائمًا');
        if (cur.is_active !== 1) throw new HttpError(409, 'NOT_USABLE', 'العملة معطّلة', { reason: 'INACTIVE' });
        let id;
        try {
          id = Number(db.prepare('INSERT INTO exchange_rates (currency_id, rate_type, effective_date, rate, note, created_by) VALUES (?, ?, ?, ?, ?, ?)')
            .run(currencyId, v.rateType, v.effectiveDate, stored, v.note ?? null, ctx.user.id).lastInsertRowid);
        } catch (e) {
          if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'RATE_EXISTS', 'يوجد سعر لنفس العملة والنوع والتاريخ', { fields: { effectiveDate: 'TAKEN' } });
          throw e;
        }
        audit.fromCtx(ctx, { action: 'exchange_rate.created', source: 'currencies', entityType: 'exchange_rate', entityId: id,
          details: { currency: cur.code, rateType: v.rateType, effectiveDate: v.effectiveDate, rate: stored } });
        return rateApi(db.prepare('SELECT * FROM exchange_rates WHERE id = ?').get(id));
      });
    }
    function deleteRate(ctx, rateId) {
      return inTransaction(db, () => {
        const r = db.prepare('SELECT x.*, c.code FROM exchange_rates x JOIN currencies c ON c.id = x.currency_id WHERE x.id = ?').get(rateId);
        if (!r) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
        const used = services.usage.usedBy('exchange_rate', rateId);
        if (used.length) throw new HttpError(409, 'IN_USE', 'السعر مستخدم في مستندات', { usedBy: used });
        db.prepare('DELETE FROM exchange_rates WHERE id = ?').run(rateId);
        audit.fromCtx(ctx, { action: 'exchange_rate.deleted', source: 'currencies', entityType: 'exchange_rate', entityId: rateId,
          details: { currency: r.code, rateType: r.rate_type, effectiveDate: r.effective_date, rate: r.rate } });
        return { ok: true };
      });
    }

    /**
     * لقطة سعر الصرف الساري في تاريخ معين (آخر سعر تاريخه ≤ التاريخ). تُحفظ كما هي داخل المستند،
     * فلا يتأثر المستند بأي سعر يُضاف لاحقًا.
     */
    function rateSnapshot(code, date, type = 'average') {
      if (!validDate(date)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { date: 'INVALID' } });
      if (!RATE_TYPES.includes(type)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { type: 'NOT_ALLOWED' } });
      const base = baseCode();
      if (code === base) return Object.freeze({ currency: code, baseCurrency: base, rateType: type, effectiveDate: null, rate: '1', rateId: null });
      const cur = byCode(code);
      if (!cur) throw new HttpError(404, 'NOT_FOUND', 'العملة غير موجودة');
      const r = db.prepare('SELECT * FROM exchange_rates WHERE currency_id = ? AND rate_type = ? AND effective_date <= ? ORDER BY effective_date DESC LIMIT 1').get(cur.id, type, date);
      if (!r) throw new HttpError(409, 'NO_RATE', 'لا يوجد سعر صرف ساري في هذا التاريخ', { currency: code, date, rateType: type });
      return Object.freeze({ currency: code, baseCurrency: base, rateType: type, effectiveDate: r.effective_date, rate: r.rate, rateId: r.id });
    }
    /** تحويل بلقطة محفوظة (وليس بالسعر الحالي). to: 'base' (×) أو 'foreign' (÷). الناتج نص معتمد بسياسة عملة الهدف. */
    function convert(amount, snap, to = 'base') {
      if (!snap || !snap.rate || !snap.currency || !snap.baseCurrency) throw new HttpError(400, 'VALIDATION', 'لقطة سعر غير صالحة');
      return to === 'base'
        ? decimal.commit(decimal.mul(amount, snap.rate), 'amount', snap.baseCurrency)
        : decimal.commit(decimal.div(amount, snap.rate), 'amount', snap.currency);
    }

    services.currencies = { ...svc, ensureBase, baseCode, rateSnapshot, convert, rates, byCode };
    ensureBase();

    // كل طلبات العملات تضمن وجود سجل العملة الأساسية أولًا (بعد التأسيس أو بعد تغييرها)
    const withBase = (fn) => (ctx) => { ensureBase(); return fn(ctx); };
    router.get('/api/currencies/iso', { permission: 'currencies.view' }, () => Object.entries(ISO).map(([code, [minor, symbol, ar, en]]) => ({ code, minor, symbol, nameAr: ar, nameEn: en })));
    router.get('/api/currencies/rate', { permission: 'currencies.view' }, withBase((ctx) => rateSnapshot(String(ctx.query.code || '').toUpperCase(), String(ctx.query.date || ''), ctx.query.type || 'average')));
    router.get('/api/currencies/:id/rates', { permission: 'currencies.view' }, withBase((ctx) => rates(idParam(ctx.params.id), ctx.query)));
    router.post('/api/currencies/:id/rates', { permission: 'currencies.manage_rates' }, async (ctx) => addRate(ctx, idParam(ctx.params.id), await ctx.body()));
    router.delete('/api/currencies/rates/:rateId', { permission: 'currencies.manage_rates' }, (ctx) => deleteRate(ctx, idParam(ctx.params.rateId)));
    router.get('/api/currencies', { permission: 'currencies.view' }, withBase((ctx) => svc.list(ctx, ctx.query)));
    router.get('/api/currencies/lookup', { auth: true }, withBase((ctx) => {
      if (!['currencies.view', 'treasury.create', 'treasury.update'].some((p) => ctx.access.can(p))) throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية');
      return svc.lookup(ctx, ctx.query);
    }));
    registerMasterRoutes(router, svc, { base: '/api/currencies', resource: 'currencies', exportFile: 'currencies' });
  },
};

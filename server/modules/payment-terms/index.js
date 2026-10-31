'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { createMasterService, registerMasterRoutes, masterActions } = require('../../core/master');

/**
 * شروط السداد (نقدي، آجل بعد أيام، دفعة مقدمة + الباقي، أقساط، مخصص) وطرق السداد.
 * كل شرط يُحوَّل إلى أسطر (أيام، نسبة مئوية) مجموعها 100 تمامًا.
 * للمستندات القادمة: services.paymentTerms.schedule(termId, { amount, docDate, currency }) يوزّع المبلغ
 * على الأقساط بالمحرك العشري (مجموع الأقساط = المبلغ بالضبط)، وsnapshot(termId) يُحفظ داخل المستند.
 */
const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const KINDS = ['cash', 'net', 'advance', 'installments', 'custom'];
const field = (name, code) => new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [name]: code } });

module.exports = {
  name: 'payment-terms',
  version: '1.0.0',
  dependsOn: ['company-setup'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db, decimal, audit } = services;
    services.permissions.register('payment-terms', [
      { resource: 'payment_terms', group: 'reference', actions: masterActions() },
      { resource: 'payment_methods', group: 'reference', actions: masterActions() },
    ]);
    const linesOf = (id) => db.prepare('SELECT * FROM payment_term_lines WHERE term_id = ? ORDER BY seq').all(id)
      .map((l) => ({ seq: l.seq, dueDays: l.due_days, percent: l.percent, description: l.description }));

    /** يبني أسطر الشرط من نوعه ويتحقق منها. */
    function buildLines(kind, body) {
      const pct = (v, name) => {
        if (typeof v !== 'string' || !/^\d+(\.\d+)?$/.test(v)) throw field(name, typeof v === 'number' ? 'DECIMAL_MUST_BE_STRING' : 'INVALID');
        const c = decimal.commit(v, 'rate');
        if (!decimal.eq(c, v)) throw field(name, 'TOO_PRECISE');
        if (!decimal.gt(c, '0') || decimal.gt(c, '100')) throw field(name, 'OUT_OF_RANGE');
        return c;
      };
      const days = (v, name) => { if (!Number.isInteger(v) || v < 0 || v > 3650) throw field(name, 'OUT_OF_RANGE'); return v; };
      if (kind === 'cash') return [{ dueDays: 0, percent: '100' }];
      if (kind === 'net') return [{ dueDays: days(body.netDays, 'netDays'), percent: '100' }];
      if (kind === 'advance') {
        const p = pct(body.advancePercent, 'advancePercent');
        if (!decimal.lt(p, '100')) throw field('advancePercent', 'OUT_OF_RANGE');
        return [{ dueDays: 0, percent: p }, { dueDays: days(body.netDays, 'netDays'), percent: decimal.canonical(decimal.sub('100', p)) }];
      }
      const lines = body.lines;
      if (!Array.isArray(lines) || !lines.length || lines.length > 60) throw field('lines', 'REQUIRED');
      if (kind === 'installments' && lines.length < 2) throw field('lines', 'MIN_TWO');
      const out = lines.map((l, i) => ({
        dueDays: days(l && l.dueDays, `lines.${i}.dueDays`),
        percent: pct(l && l.percent, `lines.${i}.percent`),
        description: l && typeof l.description === 'string' ? l.description.trim().slice(0, 200) || null : null,
      }));
      for (let i = 1; i < out.length; i++) {
        if (out[i].dueDays < out[i - 1].dueDays || (kind === 'installments' && out[i].dueDays === out[i - 1].dueDays)) throw field(`lines.${i}.dueDays`, 'NOT_ASCENDING');
      }
      // مجموع النسب = 100 بالضبط (بدون هامش سماح)
      if (!decimal.eq(decimal.sum(out.map((l) => l.percent)), '100')) throw field('lines', 'PERCENT_TOTAL_NOT_100');
      return out;
    }

    const terms = createMasterService(services, {
      entity: 'payment_term', table: 'payment_terms', source: 'payment-terms', titleKey: 'nav.paymentTerms', usableCol: 'is_usable',
      columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['kind', 'kind'], ['description', 'description'], ['isUsable', 'is_usable']],
      validate(body, { partial }) {
        const d = validator(body, { partial })
          .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
          .str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 })
          .oneOf('kind', KINDS, { required: true }).str('description', { max: 500, multiline: true }).bool('isUsable')
          .done();
        if ('isUsable' in d) d.isUsable = d.isUsable ? 1 : 0;
        // الأسطر تُعاد بناؤها عند إرسال النوع أو أي من معاملاته
        const touches = ['kind', 'netDays', 'advancePercent', 'lines'].some((k) => body && k in body);
        if (!partial || touches) {
          d._lines = { kind: d.kind, body };
        }
        return d;
      },
      beforeSave(ctx, d, before) {
        if (d._lines) {
          const kind = d._lines.kind || before.kind;
          d._linesBuilt = buildLines(kind, d._lines.body || {});
          if (before && services.usage.usedBy('payment_term', before.id).length) throw new HttpError(409, 'IN_USE', 'لا يمكن تغيير أقساط شرط مستخدم');
        }
      },
      afterSave(ctx, id, d) {
        if (!d._linesBuilt) return;
        const before = linesOf(id);
        db.prepare('DELETE FROM payment_term_lines WHERE term_id = ?').run(id);
        const ins = db.prepare('INSERT INTO payment_term_lines (term_id, seq, due_days, percent, description) VALUES (?, ?, ?, ?, ?)');
        d._linesBuilt.forEach((l, i) => ins.run(id, i + 1, l.dueDays, l.percent, l.description ?? null));
        if (JSON.stringify(before.map((l) => [l.dueDays, l.percent])) !== JSON.stringify(d._linesBuilt.map((l) => [l.dueDays, l.percent]))) {
          audit.fromCtx(ctx, { action: 'payment_term.schedule.updated', source: 'payment-terms', entityType: 'payment_term', entityId: id,
            details: { from: before.map((l) => `${l.dueDays}d:${l.percent}%`), to: d._linesBuilt.map((l) => `${l.dueDays}d:${l.percent}%`) } });
        }
      },
      toApi: (r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, kind: r.kind, description: r.description,
        isActive: r.is_active === 1, isUsable: r.is_usable === 1, lines: linesOf(r.id) }),
      filters: { kind: (v) => (KINDS.includes(v) ? { sql: 'kind = ?', params: [v] } : null) },
      lookupExtra: (r) => ({ kind: r.kind }),
      exportColumns: [
        { label: 'pt.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
        { label: 'pt.kind', value: (r, t) => t('pt.kind.' + r.kind) },
        { label: 'pt.schedule', value: (r) => r.lines.map((l) => `${l.dueDays}d: ${l.percent}%`).join(' | ') },
        { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
      ],
    });

    const methods = createMasterService(services, {
      entity: 'payment_method', table: 'payment_methods', source: 'payment-terms', titleKey: 'pm.title', usableCol: 'is_usable',
      columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['kind', 'kind'], ['treasuryKind', 'treasury_kind'], ['description', 'description'], ['isUsable', 'is_usable']],
      validate(body, { partial }) {
        const d = validator(body, { partial })
          .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
          .str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 })
          .oneOf('kind', ['cash', 'bank_transfer', 'cheque', 'card', 'other'], { required: true })
          .oneOf('treasuryKind', ['cash', 'bank']).str('description', { max: 500, multiline: true }).bool('isUsable')
          .done();
        if ('isUsable' in d) d.isUsable = d.isUsable ? 1 : 0;
        return d;
      },
      toApi: (r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, kind: r.kind, treasuryKind: r.treasury_kind,
        description: r.description, isActive: r.is_active === 1, isUsable: r.is_usable === 1 }),
      lookupExtra: (r) => ({ kind: r.kind, treasuryKind: r.treasury_kind }),
      exportColumns: [
        { label: 'pm.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
        { label: 'pm.kind', value: (r, t) => t('pm.kind.' + r.kind) }, { label: 'pm.treasuryKind', value: (r, t) => (r.treasuryKind ? t('treasury.kind.' + r.treasuryKind) : '') },
        { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
      ],
    });

    const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
    /** لقطة الشرط لحفظها داخل المستند (لا تتأثر بتعديل الشرط لاحقًا). */
    const snapshot = (termId) => { const t = terms.assertUsable(termId); return Object.freeze({ termId: t.id, code: t.code, kind: t.kind, lines: linesOf(t.id) }); };
    /** جدول الاستحقاق: المبلغ يوزَّع على الأقساط بنسبها؛ مجموع الأقساط = المبلغ بالضبط وفق سياسة اعتماد العملة. */
    function schedule(termOrSnapshot, { amount, docDate, currency = '' }) {
      const snap = typeof termOrSnapshot === 'object' ? termOrSnapshot : snapshot(termOrSnapshot);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(docDate || '')) throw field('docDate', 'INVALID');
      const total = decimal.commit(amount, 'amount', currency);
      const parts = decimal.allocate(total, snap.lines.map((l) => l.percent), 'amount', currency);
      return snap.lines.map((l, i) => ({ seq: l.seq, dueDate: addDays(docDate, l.dueDays), percent: l.percent, amount: parts[i] }));
    }
    services.paymentTerms = { ...terms, snapshot, schedule, buildLines };
    services.paymentMethods = methods;

    registerMasterRoutes(router, terms, { base: '/api/payment-terms', resource: 'payment_terms', exportFile: 'payment-terms' });
    registerMasterRoutes(router, methods, { base: '/api/payment-methods', resource: 'payment_methods', exportFile: 'payment-methods' });
    router.post('/api/payment-terms/:id/schedule-preview', { permission: 'payment_terms.view' }, async (ctx) => {
      const b = await ctx.body();
      const v = validator(b).decimal('amount', { required: true }).str('docDate', { required: true }).done();
      return schedule(idParam(ctx.params.id), { amount: v.amount, docDate: v.docDate, currency: (services.company.get() || {}).baseCurrency || '' });
    });
  },
};

'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { idParam } = require('../../core/validate');
const { createYearEnd } = require('./engine');
const { registerReports } = require('./reports');

/**
 * الإقفال السنوي وترحيل الأرصدة (المرحلة 4).
 *  - فحص الجاهزية والمعاينة بلا كتابة؛ التنفيذ يعيد الفحص كاملًا داخل معاملة BEGIN IMMEDIATE واحدة ويرفض أي خطأ مانع،
 *    أو تحذير غير مُقَر، أو بصمة معاينة تغيرت، ويمنع التكرار بمفتاح الطلب (idempotencyKey) وبفهرس «عملية نشطة واحدة».
 *  - الكتابة في الأستاذ عبر services.ledger.post() فقط (origin = 'system')، بأرقام من الترقيم المركزي.
 *  - حراس على المحرك والفترات: لا ترحيل يومي بتاريخ حتى نهاية سنة مُقفلة لفرعه؛ آخر فترة لا تُقفل نهائيًا قبل
 *    إقفال كل الفروع المطلوبة (P10). كل ذلك مكرر في القاعدة بـ triggers (0001_year_end).
 *  - الصلاحيات مستقلة لكل إجراء، ونطاق الفروع مطبق على كل طلب.
 */
module.exports = {
  name: 'year-end',
  version: '1.0.0',
  dependsOn: ['company-setup', 'security', 'fiscal-years', 'chart-accounts', 'currencies', 'numbering', 'journal'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db } = services;
    services.permissions.register('year-end', [{
      resource: 'year_end', group: 'accounting', actions: ['view', 'print', 'export'],
      special: ['check', 'preview', 'close', 'carry_forward', 'reopen', 'revert_carry_forward', 'settings'],
      superOnlyGrant: ['reopen', 'revert_carry_forward'],
    }]);
    const ye = createYearEnd(services);
    services.yearEnd = ye;

    // حراس المحرك والفترات وحالة السنة
    services.ledger.registerGuard((ctx, doc) => {
      if (doc.origin === 'system') return;
      const y = ye.closedCovering(doc.branchId, doc.date);
      if (y) throw new HttpError(409, 'YEAR_CLOSED', 'السنة المالية مُقفلة لهذا الفرع؛ لا ترحيل بتاريخ حتى نهايتها', { year: y.code, endDate: y.end_date, date: doc.date });
    });
    services.ledger.registerIntegrity(() => ye.integrityProblems());
    services.fiscal.registerYearClosed((y) => ye.yearClosed(y));
    services.fiscal.registerPeriodGuard((op, p) => {
      if (op !== 'lock') return;
      const y = ye.yearRow(p.fiscal_year_id);
      if (p.end_date !== y.end_date) return;
      const open = ye.requiredBranchIds(y).filter((b) => !ye.activeClosing(y.id, b));
      if (open.length) {
        throw new HttpError(409, 'YEAR_NOT_CLOSED_FOR_LOCK', 'آخر فترة في السنة تُقفل نهائيًا بعد إقفال السنة لكل الفروع',
          { branches: open.map((id) => db.prepare('SELECT code FROM branches WHERE id = ?').get(id).code) });
      }
    });
    services.fiscal.registerPeriodActivity('year-end', (d, periodId) => d.prepare("SELECT count(*) c FROM year_end_entries WHERE fiscal_period_id = ? AND status = 'posted'").get(periodId).c);
    // سجل الارتباطات: ما في مستند إقفال أو في الإعدادات لا يُحذف
    for (const [entity, col] of [['account', 'account_id'], ['cost_center', 'cost_center_id'], ['currency', 'currency_id']]) {
      services.usage.register(entity, 'year-end', (d, id) => !!d.prepare(`SELECT 1 FROM year_end_lines WHERE ${col} = ? LIMIT 1`).get(id));
    }
    // سنة لها عملية إقفال أو ترحيل أو طلب (ولو بلا قيود) لا تُحذف
    services.usage.register('fiscal_period', 'year-end', (d, id) => !!d.prepare(`SELECT 1 FROM fiscal_periods p WHERE p.id = ? AND (
      EXISTS (SELECT 1 FROM year_closings c WHERE c.fiscal_year_id = p.fiscal_year_id)
      OR EXISTS (SELECT 1 FROM carry_forwards f WHERE f.from_year_id = p.fiscal_year_id OR f.to_year_id = p.fiscal_year_id)
      OR EXISTS (SELECT 1 FROM year_end_requests r WHERE r.fiscal_year_id = p.fiscal_year_id))`).get(id));
    services.usage.register('account', 'year-end-settings', (d, id) => !!d.prepare('SELECT 1 FROM year_end_settings WHERE retained_earnings_account_id = ?').get(id));

    const P = (a) => ({ permission: `year_end.${a}` });
    const yearQ = (ctx) => { const id = Number.parseInt(ctx.query.fiscalYearId, 10); if (!Number.isSafeInteger(id)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { fiscalYearId: 'REQUIRED' } }); return id; };
    router.get('/api/year-end/settings', P('view'), () => ye.getSettings());
    router.put('/api/year-end/settings', P('settings'), async (ctx) => ye.updateSettings(ctx, await ctx.body()));
    // السنوات للمركز والتقارير (لا يُشترط fiscal_years.view)
    router.get('/api/year-end/years', P('view'), () => db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn, start_date startDate, end_date endDate FROM fiscal_years ORDER BY start_date DESC').all());
    router.get('/api/year-end/status', P('view'), (ctx) => ye.status(ctx, yearQ(ctx)));
    router.get('/api/year-end/history', P('view'), (ctx) => ye.history(ctx, yearQ(ctx)));
    router.get('/api/year-end/entries/:id', P('view'), (ctx) => ye.entry(ctx, idParam(ctx.params.id)));
    router.post('/api/year-end/check', P('check'), async (ctx) => ye.check(ctx, await ctx.body()));
    router.post('/api/year-end/preview', P('preview'), async (ctx) => ye.preview(ctx, await ctx.body()));
    router.post('/api/year-end/close', P('close'), async (ctx) => ye.close(ctx, await ctx.body()));
    router.post('/api/year-end/carry-forward', P('carry_forward'), async (ctx) => ye.carryForward(ctx, await ctx.body()));
    router.post('/api/year-end/reopen', P('reopen'), async (ctx) => ye.reopen(ctx, await ctx.body()));
    router.post('/api/year-end/revert-carry-forward', P('revert_carry_forward'), async (ctx) => ye.revertCarry(ctx, await ctx.body()));

    registerReports(router, services, ye);
  },
};

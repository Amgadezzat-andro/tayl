'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { writeSheet, sendXlsx } = require('../../core/xlsx');
const { createStatements } = require('./engine');

/**
 * القوائم المالية والتقارير المالية (المرحلة 5).
 *  - قائمة الدخل، قائمة المركز المالي، قائمة التدفقات النقدية — من الأستاذ العام وحده عبر engine.js.
 *  - المقارنات (الفترة السابقة، نفس الفترة من السنة السابقة، السنة السابقة)، الفروع (فرع، مجموعة، الكل ضمن الصلاحيات)،
 *    مراكز التكلفة (تحليل لقائمة الدخل فقط)، والتوزيع على أعمدة الفروع أو المراكز.
 *  - الطباعة والتصدير فقط لقائمة مكتملة التصنيف، متطابقة مع ميزان المراجعة، ومتزنة؛ مع ختم النهائية وبيانات الإصدار.
 *  - إعداد التصنيف (fs_type_settings / fs_account_settings) بصلاحية مستقلة وتدقيق.
 */
module.exports = {
  name: 'financial-statements',
  version: '1.0.0',
  dependsOn: ['company-setup', 'security', 'fiscal-years', 'chart-accounts', 'cost-centers', 'currencies', 'journal', 'year-end'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db, audit } = services;
    services.permissions.register('financial-statements', [{
      resource: 'financial_statements', group: 'accounting', actions: ['view', 'print', 'export'], special: ['settings'],
    }]);
    const fs = createStatements(services);
    services.financialStatements = fs;
    services.usage.register('account', 'financial-statements', (d, id) => !!d.prepare('SELECT 1 FROM fs_account_settings WHERE account_id = ?').get(id));
    services.usage.register('account_type', 'financial-statements', (d, id) => !!d.prepare('SELECT 1 FROM fs_type_settings WHERE type_id = ? AND (is_line IS NOT NULL OR cf_activity IS NOT NULL)').get(id));

    const REPORTS = { 'income-statement': fs.incomeStatement, 'balance-sheet': fs.balanceSheet, 'cash-flow': fs.cashFlow };

    // ── الطباعة والتصدير ──
    function table(r, lang) {
      const t = (k, v) => services.i18n.t(lang, k, v);
      const nm = (x) => (lang === 'ar' ? x.nameAr : x.nameEn) || x.nameAr || x.nameEn || '';
      const cmp = !!r.comparison;
      const colLabel = (c) => (c.label && c.label.code ? c.label.code : c.key === 'total' ? t('fs.total') : c.asOf ? c.asOf : `${c.from} → ${c.to}`);
      const header = [t('fs.item'), ...r.columns.map(colLabel), ...(cmp ? [t('fs.difference'), t('fs.percent')] : [])];
      const rows = []; const xrows = [];
      const push = (label, v, indent = 0) => {
        const vals = v ? v.values : [];
        rows.push(['  '.repeat(indent) + label, ...vals.map((x) => x.text), ...(cmp && v ? [v.difference.text, v.percent ? v.percent.text : '—'] : [])]);
        xrows.push(['  '.repeat(indent) + label, ...vals.map((x) => ({ num: x.value })), ...(cmp && v ? [{ num: v.difference.value }, v.percent ? { num: v.percent.value } : ''] : [])]);
      };
      const acc = (a, indent) => push(`${a.code} ${nm(a)}`, a, indent);
      if (r.statement === 'income_statement') {
        for (const l of r.lines) {
          if (l.rows) { push(t('fs.line.' + l.key), null); l.rows.forEach((a) => acc(a, 1)); push(t('fs.totalOf', { item: t('fs.line.' + l.key) }), l); } else push(t('fs.line.' + l.key), l);
        }
      } else if (r.statement === 'balance_sheet') {
        for (const s of r.sections) {
          push(t('fs.class.' + s.key), null);
          for (const g of s.groups) {
            push(g.typeCode ? nm({ nameAr: g.typeNameAr, nameEn: g.typeNameEn }) : t('fs.noType'), null, 1);
            g.rows.forEach((a) => acc(a, 2));
            push(t('fs.totalOf', { item: g.typeCode ? nm({ nameAr: g.typeNameAr, nameEn: g.typeNameEn }) : t('fs.noType') }), g, 1);
          }
          if (s.key === 'equity') push(t('fs.unclosedResult'), s.unclosedResult, 1);
          push(t('fs.totalOf', { item: t('fs.class.' + s.key) }), s);
        }
        push(t('fs.totalLiabilitiesAndEquity'), r.totalLiabilitiesAndEquity);
        push(t('fs.difference'), r.difference);
      } else {
        for (const s of r.sections) {
          push(t('fs.activity.' + s.key), null);
          if (s.key === 'operating') push(t('fs.netIncome'), r.netIncome, 1);
          s.rows.forEach((a) => acc(a, 1));
          push(t('fs.totalOf', { item: t('fs.activity.' + s.key) }), s);
        }
        push(t('fs.netChange'), r.netChange); push(t('fs.openingCash'), r.openingCash); push(t('fs.closingCash'), r.closingCash);
      }
      const company = services.company.get() || {};
      const scope = r.scope.all ? t('ledger.allBranches') : r.scope.branches.map((b) => `${b.code} ${nm(b)}`).join(' / ');
      const fin = r.finality.final ? t('ledger.final') : `${t('ledger.notFinal')}: ${r.finality.reasons.map((x) => t('ledger.reason.' + x.code)).join(' — ')}`;
      const meta = [
        `${t('fs.company')}: ${lang === 'ar' ? company.nameAr || company.name_ar || '' : company.nameEn || company.name_en || ''}`,
        `${t('fs.branches')}: ${scope}`,
        ...(r.scope.analytical ? [`${t('fs.costCenters')}: ${r.scope.costCenters.map((c) => c.code).join(', ')} — ${t('fs.analytical')}`] : []),
        r.asOf ? `${t('fs.asOf')}: ${r.asOf}` : `${t('fs.period')}: ${r.from} → ${r.to}`,
        ...(r.comparativePeriod ? [`${t('fs.comparative')}: ${r.comparativePeriod.from} → ${r.comparativePeriod.to}`] : []),
        ...(r.comparativeDate ? [`${t('fs.comparative')}: ${r.comparativeDate.asOf}`] : []),
        ...(r.method ? [t('fs.method.' + r.method)] : []),
        `${t('fs.currency')}: ${r.baseCurrency}`,
        `${t('fs.issuedAt')}: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
        `${t('fs.status')}: ${fin}`,
        ...(r.warnings || []).map((w) => t('fs.warn.' + w.code)),
      ];
      return { title: t('fs.report.' + r.statement), meta, columns: header, rows, xrows, finality: r.finality };
    }
    function issuable(r) {
      if (r.issuable) return;
      const code = r.blockers[0];
      throw new HttpError(409, code, { STATEMENT_INCOMPLETE: 'القائمة غير مكتملة التصنيف؛ لا تُطبع ولا تُصدَّر', STATEMENT_UNBALANCED: 'القائمة غير متزنة',
        STATEMENT_NOT_RECONCILED: 'القائمة لا تطابق ميزان المراجعة' }[code], { blockers: r.blockers, issues: r.issues, differences: r.reconciliation.differences.slice(0, 20) });
    }
    const P = (a) => ({ permission: `financial_statements.${a}` });
    for (const [name, fn] of Object.entries(REPORTS)) {
      router.get(`/api/financial-statements/${name}`, P('view'), (ctx) => fn(ctx, ctx.query));
      router.get(`/api/financial-statements/${name}/print`, P('print'), (ctx) => {
        const r = fn(ctx, ctx.query); issuable(r);
        const { xrows, ...d } = table(r, ctx.query.lang === 'en' ? 'en' : 'ar');
        return d;
      });
      router.get(`/api/financial-statements/${name}/export.xlsx`, P('export'), (ctx) => {
        const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
        const r = fn(ctx, ctx.query); issuable(r);
        const d = table(r, lang);
        audit.fromCtx(ctx, { action: 'financial_statements.exported', source: 'financial-statements', entityType: 'financial_statement', details: { statement: r.statement, final: r.finality.final, query: ctx.query } });
        sendXlsx(ctx.res, `${name}.xlsx`, writeSheet({ sheetName: name, header: d.columns, rows: [[d.title], ...d.meta.map((m) => [m]), [], ...d.xrows], rtl: lang === 'ar' }));
      });
    }

    // ── إعداد التصنيف ──
    router.get('/api/financial-statements/settings', P('view'), () => fs.settings());
    router.put('/api/financial-statements/settings/types/:id', P('settings'), async (ctx) => { const b = await ctx.body(); return inTransaction(db, () => fs.setType(ctx, idParam(ctx.params.id), b)); });
    router.put('/api/financial-statements/settings/accounts/:id', P('settings'), async (ctx) => { const b = await ctx.body(); return inTransaction(db, () => fs.setAccount(ctx, idParam(ctx.params.id), b)); });
    // السنوات والفترات لمركز التقارير (لا يُشترط fiscal_years.view)
    router.get('/api/financial-statements/periods', P('view'), () => db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn, start_date startDate, end_date endDate FROM fiscal_years ORDER BY start_date DESC').all()
      .map((y) => ({ ...y, periods: db.prepare('SELECT id, seq, name_ar nameAr, name_en nameEn, start_date startDate, end_date endDate, status FROM fiscal_periods WHERE fiscal_year_id = ? ORDER BY seq').all(y.id) })));
  },
};

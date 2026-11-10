'use strict';
const { HttpError } = require('../../core/errors');
const { writeSheet, sendXlsx } = require('../../core/xlsx');

/**
 * تقارير الإقفال السنوي (المرحلة 4): نتيجة السنة، مستندات الإقفال، الأرصدة المرحّلة، المطابقة، حالة الفروع، فحص الجاهزية.
 * المصدر المحاسبي: gl_entries ومستندات النظام المرحّلة؛ كل جمع بالمحرك العشري. نطاق الفروع مطبق، والطباعة والتصدير
 * بصلاحياتهما مع ختم النهائية (services.fiscal.finality) لسنة التقرير.
 */
function registerReports(router, services, ye) {
  const { db, decimal: D, audit } = services;
  const base = () => services.ledger.baseCurrency().code;
  const fmt = (x, cur) => D.format(x, 'amount', cur || base());
  const vErr = (fields) => new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields });

  function yearOf(q) {
    const y = ye.yearRow(Number.parseInt(q.fiscalYearId, 10));
    if (!y) throw vErr({ fiscalYearId: q.fiscalYearId ? 'NOT_FOUND' : 'REQUIRED' });
    return y;
  }
  /** الفروع في نطاق التقرير: فرع محدد (ضمن النطاق) أو كل الفروع المصرح بها. */
  function branchesOf(ctx, q) {
    if (q.branch && q.branch !== 'all') {
      const id = Number.parseInt(q.branch, 10);
      const b = db.prepare('SELECT * FROM branches WHERE id = ?').get(id);
      if (!b) throw vErr({ branch: 'NOT_FOUND' });
      ctx.access.assertBranch(id);
      return [b];
    }
    return db.prepare('SELECT * FROM branches ORDER BY code').all().filter((b) => ctx.access.branchAllowed(b.id));
  }
  const brApi = (b) => ({ id: b.id, code: b.code, nameAr: b.name_ar, nameEn: b.name_en });
  const inList = (ids) => (ids.length ? ids.map(() => '?').join(',') : 'NULL');

  // ── نتيجة السنة: الإيرادات والمصروفات قبل الإقفال وبعده لكل حساب ──
  function result(ctx, q) {
    const y = yearOf(q); const brs = branchesOf(ctx, q); const ids = brs.map((b) => b.id);
    const agg = (excludeClosing) => db.prepare(`SELECT g.account_id id, dec_sum(g.debit) d, dec_sum(g.credit) c FROM gl_entries g
        JOIN accounts a ON a.id = g.account_id JOIN account_classes k ON k.code = a.class_code
      WHERE g.branch_id IN (${inList(ids)}) AND g.posting_date <= ? AND g.source_type <> 'carry_forward' AND k.statement = 'income_statement'
        ${excludeClosing ? "AND NOT (g.source_type = 'year_closing' AND g.fiscal_year_id = ?)" : ''} GROUP BY g.account_id`)
      .all(...ids, y.end_date, ...(excludeClosing ? [y.id] : []));
    const before = new Map(agg(true).map((r) => [r.id, D.sub(r.d, r.c)]));
    const after = new Map(agg(false).map((r) => [r.id, D.sub(r.d, r.c)]));
    const accs = db.prepare(`SELECT id, code, name_ar, name_en, class_code FROM accounts WHERE id IN (${inList([...before.keys()])}) ORDER BY code`).all(...before.keys());
    const rows = accs.map((a) => {
      const b = before.get(a.id) || D.parse('0'); const af = after.get(a.id) || D.parse('0');
      return { accountId: a.id, code: a.code, nameAr: a.name_ar, nameEn: a.name_en, classCode: a.class_code,
        before: D.canonical(b), after: D.canonical(af), beforeText: fmt(D.abs(b)), afterText: fmt(D.abs(af)),
        beforeSide: D.isZero(b) ? null : D.isNegative(b) ? 'credit' : 'debit', afterSide: D.isZero(af) ? null : D.isNegative(af) ? 'credit' : 'debit' };
    });
    const rev = D.sum(rows.filter((r) => r.classCode === 'revenue').map((r) => D.neg(r.before)).concat(['0']));
    const exp = D.sum(rows.filter((r) => r.classCode !== 'revenue').map((r) => r.before).concat(['0']));
    const net = D.sub(rev, exp);
    const closedBranches = brs.filter((b) => ye.activeClosing(y.id, b.id)).length;
    return {
      fiscalYear: { id: y.id, code: y.code, startDate: y.start_date, endDate: y.end_date }, baseCurrency: base(), branch: brs.length === 1 && q.branch && q.branch !== 'all' ? brApi(brs[0]) : null,
      rows, totals: { revenue: D.canonical(rev), expense: D.canonical(exp), net: D.canonical(net), revenueText: fmt(rev), expenseText: fmt(exp), netText: fmt(D.abs(net)),
        resultSide: D.isZero(net) ? 'zero' : D.isNegative(net) ? 'loss' : 'profit' },
      closedBranches, branches: brs.length, allZeroAfter: rows.every((r) => r.after === '0'),
      finality: services.fiscal.finality(y.start_date, y.end_date),
    };
  }

  // ── مستندات الإقفال والترحيل للسنة ──
  function entries(ctx, q) {
    const y = yearOf(q); const ids = branchesOf(ctx, q).map((b) => b.id);
    const rows = db.prepare(`SELECT e.*, b.code branch_code, o.number reverses_number FROM year_end_entries e JOIN branches b ON b.id = e.branch_id
      LEFT JOIN year_end_entries o ON o.id = e.reverses_id WHERE e.closing_year_id = ? AND e.status = 'posted' AND e.branch_id IN (${inList(ids)}) ORDER BY e.id`).all(y.id, ...ids);
    return { fiscalYear: { id: y.id, code: y.code }, baseCurrency: base(), finality: services.fiscal.finality(y.start_date, y.end_date),
      items: rows.map((e) => ({ id: e.id, number: e.number, kind: e.kind, isReversal: e.is_reversal === 1, reverses: e.reverses_number, reason: e.reason, date: e.entry_date,
        branchCode: e.branch_code, description: e.description, totalBase: e.total_base, totalText: fmt(e.total_base), postedAt: e.posted_at,
        reversed: !!db.prepare("SELECT 1 FROM year_end_entries WHERE reverses_id = ? AND status = 'posted'").get(e.id) })) };
  }

  // ── الأرصدة المرحّلة إلى السنة التالية ──
  function carried(ctx, q) {
    const y = yearOf(q); const brs = branchesOf(ctx, q);
    const rows = [];
    for (const b of brs) {
      const f = ye.activeCarry(y.id, b.id);
      if (!f) continue;
      const e = ye.originalOf('carry_forward_id', f.id);
      if (!e) continue;
      for (const l of db.prepare(`SELECT l.*, a.code account_code, a.name_ar account_ar, a.name_en account_en, cc.code cc_code, cu.code currency_code FROM year_end_lines l
          JOIN accounts a ON a.id = l.account_id JOIN currencies cu ON cu.id = l.currency_id LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id WHERE l.entry_id = ? ORDER BY l.line_no`).all(e.id)) {
        rows.push({ branchCode: b.code, number: e.number, entryId: e.id, date: e.entry_date, accountCode: l.account_code, accountNameAr: l.account_ar, accountNameEn: l.account_en,
          costCenterCode: l.cc_code, currency: l.currency_code, rate: l.rate, basis: l.basis, debitFc: l.debit_fc, creditFc: l.credit_fc, debit: l.debit, credit: l.credit,
          debitFcText: fmt(l.debit_fc, l.currency_code), creditFcText: fmt(l.credit_fc, l.currency_code), debitText: fmt(l.debit), creditText: fmt(l.credit) });
      }
    }
    const sum = (k) => D.canonical(D.sum(rows.map((r) => r[k]).concat(['0'])));
    const next = ye.nextYearOf(y);
    return { fiscalYear: { id: y.id, code: y.code }, nextYear: next ? { id: next.id, code: next.code, startDate: next.start_date } : null, baseCurrency: base(), rows,
      totals: { debit: sum('debit'), credit: sum('credit'), debitText: fmt(sum('debit')), creditText: fmt(sum('credit')), balanced: sum('debit') === sum('credit') },
      finality: services.fiscal.finality(y.start_date, y.end_date) };
  }

  // ── المطابقة: نهاية السنة = افتتاح التالية (لكل حساب وفرع ومركز تكلفة وعملة) ──
  function reconciliation(ctx, q) {
    const y = yearOf(q); const brs = branchesOf(ctx, q);
    const out = brs.map((b) => {
      const f = ye.activeCarry(y.id, b.id);
      if (!f) return { branch: brApi(b), carried: false, ok: null, rows: [] };
      const e = ye.originalOf('carry_forward_id', f.id);
      const rec = ye.reconcile(y, b.id, ye.cfLinesOf(e && e.id));
      return { branch: brApi(b), carried: true, number: e ? e.number : null, ok: rec.ok && rec.hash === f.reconciliation_hash, hashMatchesRecord: rec.hash === f.reconciliation_hash,
        incomeStatementRemaining: rec.incomeStatementRemaining, rows: rec.rows, totals: rec.totals };
    });
    return { fiscalYear: { id: y.id, code: y.code }, baseCurrency: base(), branches: out, ok: out.every((b) => b.ok !== false), finality: services.fiscal.finality(y.start_date, y.end_date) };
  }

  // ── حالة الفروع وعملياتها ──
  function branchStatus(ctx, q) {
    const y = yearOf(q);
    const s = ye.status(ctx, y.id);
    const only = q.branch && q.branch !== 'all' ? Number.parseInt(q.branch, 10) : null;
    if (only) ctx.access.assertBranch(only);
    return { ...s, branches: s.branches.filter((b) => !only || b.branch.id === only), history: ye.history(ctx, y.id).filter((h) => !only || h.branch.id === only),
      finality: services.fiscal.finality(y.start_date, y.end_date) };
  }

  // ── فحص الجاهزية (إقفال إن لم تُقفل، وإلا ترحيل) ──
  function readiness(ctx, q) {
    if (!ctx.access.can('year_end.check')) throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية');
    const y = yearOf(q);
    const brs = branchesOf(ctx, q).filter((b) => ye.requiredBranchIds(y).includes(b.id));
    const rows = [];
    for (const b of brs) {
      const op = ye.activeClosing(y.id, b.id) ? (ye.activeCarry(y.id, b.id) ? null : 'carry_forward') : 'close';
      if (!op) { rows.push({ branchCode: b.code, operation: 'done', level: 'info', code: 'COMPLETED' }); continue; }
      const r = ye.check(ctx, { fiscalYearId: y.id, branchIds: [b.id], operation: op }).branches[0];
      for (const [level, list] of [['error', r.errors], ['warning', r.warnings], ['info', r.info]]) {
        for (const i of list) rows.push({ branchCode: b.code, operation: op, level, ...i });
      }
    }
    return { fiscalYear: { id: y.id, code: y.code }, rows, ready: !rows.some((r) => r.level === 'error'), finality: services.fiscal.finality(y.start_date, y.end_date) };
  }

  const REPORTS = { result, entries, carried, reconciliation, branches: branchStatus, readiness };

  // ── الطباعة والتصدير ──
  const side = (t, s, text) => (s ? `${text} ${t('ledger.side.' + s)}` : '0');
  const TABLES = {
    result(r, t, lang) {
      const rows = r.rows.map((x) => [x.code, lang === 'ar' ? x.nameAr : x.nameEn, t('ye.class.' + x.classCode), side(t, x.beforeSide, x.beforeText), side(t, x.afterSide, x.afterText)]);
      rows.push(['', t('ye.totalRevenue'), '', r.totals.revenueText, '']);
      rows.push(['', t('ye.totalExpense'), '', r.totals.expenseText, '']);
      rows.push(['', t('ye.result.' + r.totals.resultSide), '', r.totals.netText, '']);
      return { titleKey: 'ye.report.result', columns: ['ledger.accountCode', 'ledger.accountName', 'ye.class', 'ye.beforeClosing', 'ye.afterClosing'], rows };
    },
    entries(r, t) {
      return { titleKey: 'ye.report.entries', columns: ['ledger.number', 'ye.docKind', 'ledger.date', 'journal.branch', 'ledger.description', 'ye.total', 'ye.reversalOf'],
        rows: r.items.map((e) => [e.number, t('ye.kind.' + e.kind + (e.isReversal ? '_reversal' : '')), e.date, e.branchCode, e.description, e.totalText, e.reverses || (e.reversed ? t('ye.reversed') : '')]) };
    },
    carried(r, t, lang) {
      const rows = r.rows.map((x) => [x.branchCode, x.number, x.accountCode + ' ' + (lang === 'ar' ? x.accountNameAr : x.accountNameEn), x.costCenterCode || '', x.currency, x.rate,
        t('ye.basis.' + x.basis), x.debitFcText, x.creditFcText, x.debitText, x.creditText]);
      rows.push(['', '', t('ledger.total'), '', '', '', '', '', '', r.totals.debitText, r.totals.creditText]);
      return { titleKey: 'ye.report.carried', columns: ['journal.branch', 'ledger.number', 'ledger.account', 'ledger.costCenter', 'ledger.currency', 'ledger.rate', 'ye.basisLabel',
        'ledger.debitFc', 'ledger.creditFc', 'ledger.debit', 'ledger.credit'], rows };
    },
    reconciliation(r, t, lang) {
      const rows = [];
      for (const b of r.branches) {
        if (!b.carried) { rows.push([b.branch.code, t('ye.notCarried'), '', '', '', '', '', '', '']); continue; }
        for (const x of b.rows) {
          rows.push([b.branch.code, x.accountCode + ' ' + (lang === 'ar' ? x.accountNameAr : x.accountNameEn), x.currency, x.endFcText, x.carriedFcText, x.endBaseText, x.carriedBaseText,
            x.fcMatch && x.baseMatch ? t('ye.match') : t('ye.mismatch'), x.residualMoved ? t('ye.residualMoved') : '']);
        }
      }
      return { titleKey: 'ye.report.reconciliation', columns: ['journal.branch', 'ledger.account', 'ledger.currency', 'ye.endFc', 'ye.carriedFc', 'ye.endBase', 'ye.carriedBase', 'ye.matchLabel', 'ye.note'], rows };
    },
    branches(r, t) {
      return { titleKey: 'ye.report.branches', columns: ['journal.branch', 'ye.state', 'ye.closingEntry', 'ye.resultLabel', 'ye.carryEntry', 'ye.closedAt'],
        rows: r.branches.map((b) => [b.branch.code, t('ye.state.' + b.state), b.closing && b.closing.entry ? b.closing.entry.number : '',
          b.closing ? `${t('ye.result.' + b.closing.resultSide)} ${b.closing.summary.netResultText}` : '', b.carryForward && b.carryForward.entry ? b.carryForward.entry.number : '',
          b.closing ? b.closing.createdAt : '']) };
    },
    readiness(r, t) {
      return { titleKey: 'ye.report.readiness', columns: ['journal.branch', 'ye.operation', 'ye.level', 'ye.issue'],
        rows: r.rows.map((x) => [x.branchCode, t('ye.op.' + x.operation), t('ye.level.' + x.level), t('ye.issue.' + x.code)]) };
    },
  };
  function stamp(lang, finality) {
    const t = (k) => services.i18n.t(lang, k);
    return finality.final ? t('ledger.final') : `${t('ledger.notFinal')}: ${finality.reasons.map((x) => t('ledger.reason.' + x.code)).join(' — ')}`;
  }
  function tabular(ctx, name, lang) {
    const r = REPORTS[name](ctx, ctx.query);
    const t = (k) => services.i18n.t(lang, k);
    const tb = TABLES[name](r, t, lang);
    const title = [t(tb.titleKey), r.fiscalYear.code, stamp(lang, r.finality)].join(' | ');
    return { title, columns: tb.columns.map(t), rows: tb.rows, finality: r.finality };
  }
  for (const name of Object.keys(REPORTS)) {
    router.get(`/api/year-end/reports/${name}`, { permission: name === 'readiness' ? 'year_end.check' : 'year_end.view' }, (ctx) => REPORTS[name](ctx, ctx.query));
    router.get(`/api/year-end/reports/${name}/print`, { permission: 'year_end.print' }, (ctx) => tabular(ctx, name, ctx.query.lang === 'en' ? 'en' : 'ar'));
    router.get(`/api/year-end/reports/${name}/export.xlsx`, { permission: 'year_end.export' }, (ctx) => {
      const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
      const d = tabular(ctx, name, lang);
      audit.fromCtx(ctx, { action: 'year_end.exported', source: 'year-end', entityType: 'year_end_report', details: { report: name, rows: d.rows.length, final: d.finality.final, query: ctx.query } });
      sendXlsx(ctx.res, `year-end-${name}.xlsx`, writeSheet({ sheetName: name, header: d.columns, rows: [[d.title, ...d.columns.slice(1).map(() => '')], ...d.rows], rtl: lang === 'ar' }));
    });
  }
}

module.exports = { registerReports };

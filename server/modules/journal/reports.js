'use strict';
const { HttpError } = require('../../core/errors');
const { writeSheet, sendXlsx } = require('../../core/xlsx');

/**
 * التقارير الثلاثة للمرحلة 3: دفتر اليومية، كشف الحساب، ميزان المراجعة.
 *  - المصدر المحاسبي الوحيد: gl_entries (المبالغ والتواريخ والحسابات). بيانات المستند (البيان، المرجع، علاقة العكس)
 *    تُقرأ من القيد للعرض فقط ولا تدخل في أي رقم.
 *  - كل جمع ورصيد بالمحرك العشري (dec_sum في SQL، services.decimal في JS) — لا Number ولا SUM.
 *  - نطاق الفروع: ctx.access.sqlFilter («كل الفروع» = المصرح بها فقط).
 *  - كل تقرير يرد finality (المقترح 7.3)، والطباعة والتصدير تحمل ختم «غير نهائي» بأسبابه.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const MAX_STATEMENT_ROWS = 20000;
const vErr = (fields) => new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields });
const intQ = (v, def, max) => { const n = Number.parseInt(v, 10); return Number.isSafeInteger(n) && n >= 0 ? Math.min(n, max) : def; };

function registerReports(router, services) {
  const { db, decimal: D, audit } = services;
  const base = () => services.ledger.baseCurrency().code;
  const fmt = (x, cur) => D.format(x, 'amount', cur || base());
  const P = (a) => ({ permission: `ledger.${a}` });

  /** الفترة: سنة مالية، أو فترة، أو من/إلى. */
  function range(q) {
    if (q.fiscalYearId) {
      const y = db.prepare('SELECT start_date s, end_date e FROM fiscal_years WHERE id = ?').get(Number.parseInt(q.fiscalYearId, 10));
      if (!y) throw vErr({ fiscalYearId: 'NOT_FOUND' });
      return { from: y.s, to: y.e };
    }
    if (q.periodId) {
      const p = db.prepare('SELECT start_date s, end_date e FROM fiscal_periods WHERE id = ?').get(Number.parseInt(q.periodId, 10));
      if (!p) throw vErr({ periodId: 'NOT_FOUND' });
      return { from: p.s, to: p.e };
    }
    const fields = {};
    if (!validDate(q.from)) fields.from = 'INVALID';
    if (!validDate(q.to)) fields.to = 'INVALID';
    if (!Object.keys(fields).length && q.to < q.from) fields.to = 'END_BEFORE_START';
    if (Object.keys(fields).length) throw vErr(fields);
    return { from: q.from, to: q.to };
  }
  /** شروط الفرع ومركز التكلفة على gl_entries (اسم مستعار g). */
  function scope(ctx, q) {
    const f = ctx.access.sqlFilter('g.branch_id', q.branch);
    const w = [f.sql]; const p = [...f.params];
    if (q.costCenterId) { w.push('g.cost_center_id = ?'); p.push(Number.parseInt(q.costCenterId, 10)); }
    return { sql: w.join(' AND '), params: p };
  }
  /** رصيد صافٍ ⇒ { debit, credit } (طرف واحد موجب) + النص. */
  function split(net, cur) {
    const n = D.parse(net);
    const debit = D.isNegative(n) ? '0' : D.canonical(n);
    const credit = D.isNegative(n) ? D.canonical(D.neg(n)) : '0';
    return { net: D.canonical(n), debit, credit, side: D.isZero(n) ? null : D.isNegative(n) ? 'credit' : 'debit', debitText: fmt(debit, cur), creditText: fmt(credit, cur) };
  }
  const branchLabel = (ctx, q) => {
    if (!q.branch || q.branch === 'all') return null;
    return db.prepare('SELECT code, name_ar nameAr, name_en nameEn FROM branches WHERE id = ?').get(Number.parseInt(q.branch, 10)) || null;
  };

  // ── دفتر اليومية ──
  function journalRegister(ctx, q) {
    const { from, to } = range(q);
    const s = scope(ctx, q);
    const w = [s.sql, 'g.posting_date BETWEEN ? AND ?']; const p = [...s.params, from, to];
    if (q.number) { w.push("g.doc_number LIKE ? ESCAPE '\\'"); p.push('%' + String(q.number).slice(0, 60).replace(/[\\%_]/g, (m) => '\\' + m) + '%'); }
    if (q.accountId) { w.push('EXISTS (SELECT 1 FROM gl_entries x WHERE x.source_type = g.source_type AND x.source_id = g.source_id AND x.account_id = ?)'); p.push(Number.parseInt(q.accountId, 10)); }
    if (['opening', 'normal'].includes(q.kind)) { w.push('g.entry_kind = ?'); p.push(q.kind); }
    const where = w.join(' AND ');
    const limit = intQ(q.limit, 50, 500); const offset = intQ(q.offset, 0, 1e7);
    const docs = db.prepare(`SELECT g.source_type, g.source_id, g.doc_number, g.posting_date, g.branch_id, min(g.id) first_id, dec_sum(g.debit) d, dec_sum(g.credit) c
      FROM gl_entries g WHERE ${where} GROUP BY g.source_type, g.source_id ORDER BY g.posting_date, first_id LIMIT ? OFFSET ?`).all(...p, limit + 1, offset);
    const tot = db.prepare(`SELECT dec_sum(g.debit) d, dec_sum(g.credit) c, count(DISTINCT g.source_type || ':' || g.source_id) n FROM gl_entries g WHERE ${where}`).get(...p);
    // بمرشح مركز التكلفة: السطور المعروضة = السطور التي جُمعت (نفس الشرط)
    const ccId = q.costCenterId ? Number.parseInt(q.costCenterId, 10) : null;
    const lineQ = db.prepare(`SELECT g.*, a.code account_code, a.name_ar account_ar, a.name_en account_en, cc.code cc_code, cu.code currency_code
      FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN currencies cu ON cu.id = g.currency_id LEFT JOIN cost_centers cc ON cc.id = g.cost_center_id
      WHERE g.source_type = ? AND g.source_id = ?${ccId ? ' AND g.cost_center_id = ?' : ''} ORDER BY g.id`);
    const meta = db.prepare(`SELECT e.description, e.reference, e.entry_type, e.reason, o.id rev_id, o.number rev_number, r.id by_id, r.number by_number, b.code branch_code
      FROM journal_entries e JOIN branches b ON b.id = e.branch_id LEFT JOIN journal_entries o ON o.id = e.reverses_id
      LEFT JOIN journal_entries r ON r.reverses_id = e.id AND r.status = 'posted' WHERE e.id = ?`);
    const items = docs.slice(0, limit).map((d) => {
      const m = d.source_type === 'journal' ? meta.get(d.source_id) : {};
      return {
        sourceType: d.source_type, sourceId: d.source_id, number: d.doc_number, date: d.posting_date, branchCode: m.branch_code,
        entryType: m.entry_type, description: m.description, reference: m.reference, reason: m.reason,
        reverses: m.rev_id ? { id: m.rev_id, number: m.rev_number } : null, reversedBy: m.by_id ? { id: m.by_id, number: m.by_number } : null,
        totalDebit: d.d, totalCredit: d.c, totalDebitText: fmt(d.d), totalCreditText: fmt(d.c),
        lines: lineQ.all(d.source_type, d.source_id, ...(ccId ? [ccId] : [])).map((l) => ({
          accountId: l.account_id, accountCode: l.account_code, accountNameAr: l.account_ar, accountNameEn: l.account_en, costCenterCode: l.cc_code,
          description: l.description, currency: l.currency_code, rate: l.rate, rateSource: l.rate_source,
          debitFc: l.debit_fc, creditFc: l.credit_fc, debit: l.debit, credit: l.credit,
          debitFcText: fmt(l.debit_fc, l.currency_code), creditFcText: fmt(l.credit_fc, l.currency_code), debitText: fmt(l.debit), creditText: fmt(l.credit),
        })),
      };
    });
    return {
      from, to, baseCurrency: base(), branch: branchLabel(ctx, q), items, hasMore: docs.length > limit, documents: tot.n,
      totals: { debit: tot.d, credit: tot.c, debitText: fmt(tot.d), creditText: fmt(tot.c), balanced: D.eq(tot.d, tot.c) },
      finality: services.fiscal.finality(from, to),
    };
  }

  // ── كشف الحساب ──
  function statement(ctx, q) {
    const { from, to } = range(q);
    const accountId = Number.parseInt(q.accountId, 10);
    const acc = Number.isSafeInteger(accountId) ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(accountId) : null;
    if (!acc) throw vErr({ accountId: acc === null && q.accountId ? 'NOT_FOUND' : 'REQUIRED' });
    // الحساب التجميعي = كل الحسابات التفصيلية تحته
    const ids = acc.is_group ? db.prepare("SELECT id FROM accounts WHERE path LIKE ? AND is_group = 0").all(acc.path + '%').map((r) => r.id) : [acc.id];
    const s = scope(ctx, q);
    const w = [s.sql, `g.account_id IN (${ids.length ? ids.map(() => '?').join(',') : 'NULL'})`]; const p = [...s.params, ...ids];
    let cur = null;
    if (q.currencyId) {
      cur = db.prepare('SELECT id, code FROM currencies WHERE id = ?').get(Number.parseInt(q.currencyId, 10));
      if (!cur) throw vErr({ currencyId: 'NOT_FOUND' });
      w.push('g.currency_id = ?'); p.push(cur.id);
    }
    const where = w.join(' AND ');
    const op = db.prepare(`SELECT dec_sum(g.debit) d, dec_sum(g.credit) c, dec_sum(g.debit_fc) fd, dec_sum(g.credit_fc) fc FROM gl_entries g WHERE ${where} AND g.posting_date < ?`).get(...p, from);
    const n = db.prepare(`SELECT count(*) n FROM gl_entries g WHERE ${where} AND g.posting_date BETWEEN ? AND ?`).get(...p, from, to).n;
    if (n > MAX_STATEMENT_ROWS) throw new HttpError(409, 'REPORT_TOO_LARGE', 'الحركات أكثر من حد الكشف؛ ضيّق الفترة', { rows: n, max: MAX_STATEMENT_ROWS });
    // ترتيب محاسبي: تاريخ الترحيل ثم تسلسل الترحيل نفسه (ترتيب كتابة الأستاذ)
    const rows = db.prepare(`SELECT g.*, a.code account_code, cc.code cc_code, cu.code currency_code, e.reference, e.entry_type
      FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN currencies cu ON cu.id = g.currency_id
      LEFT JOIN cost_centers cc ON cc.id = g.cost_center_id LEFT JOIN journal_entries e ON g.source_type = 'journal' AND e.id = g.source_id
      WHERE ${where} AND g.posting_date BETWEEN ? AND ? ORDER BY g.posting_date, g.id`).all(...p, from, to);
    let bal = D.sub(op.d, op.c);
    let fbal = cur ? D.sub(op.fd, op.fc) : null;
    const out = rows.map((r) => {
      bal = D.add(bal, D.sub(r.debit, r.credit));
      if (cur) fbal = D.add(fbal, D.sub(r.debit_fc, r.credit_fc));
      const b = split(bal);
      return {
        date: r.posting_date, number: r.doc_number, sourceType: r.source_type, sourceId: r.source_id, entryType: r.entry_type, kind: r.entry_kind,
        description: r.description, reference: r.reference, accountCode: r.account_code, costCenterCode: r.cc_code,
        currency: r.currency_code, rate: r.rate, rateSource: r.rate_source, debitFc: r.debit_fc, creditFc: r.credit_fc, debit: r.debit, credit: r.credit,
        debitFcText: fmt(r.debit_fc, r.currency_code), creditFcText: fmt(r.credit_fc, r.currency_code), debitText: fmt(r.debit), creditText: fmt(r.credit),
        balance: b, ...(cur ? { balanceFc: split(fbal, cur.code) } : {}),
      };
    });
    const mv = { d: D.canonical(D.sum(rows.map((r) => r.debit).concat(['0']))), c: D.canonical(D.sum(rows.map((r) => r.credit).concat(['0']))) };
    return {
      account: { id: acc.id, code: acc.code, nameAr: acc.name_ar, nameEn: acc.name_en, isGroup: acc.is_group === 1, normalBalance: acc.normal_balance },
      from, to, baseCurrency: base(), currency: cur ? cur.code : null, branch: branchLabel(ctx, q),
      opening: split(D.sub(op.d, op.c)), ...(cur ? { openingFc: split(D.sub(op.fd, op.fc), cur.code) } : {}),
      rows: out,
      totals: { debit: mv.d, credit: mv.c, debitText: fmt(mv.d), creditText: fmt(mv.c) },
      closing: split(bal), ...(cur ? { closingFc: split(fbal, cur.code) } : {}),
      finality: services.fiscal.finality(from, to),
    };
  }

  // ── ميزان المراجعة ──
  function trialBalance(ctx, q) {
    const { from, to } = range(q);
    const s = scope(ctx, q);
    const agg = db.prepare(`SELECT g.account_id id,
        dec_sum(CASE WHEN g.posting_date < ? THEN g.debit ELSE '0' END) od, dec_sum(CASE WHEN g.posting_date < ? THEN g.credit ELSE '0' END) oc,
        dec_sum(CASE WHEN g.posting_date >= ? THEN g.debit ELSE '0' END) md, dec_sum(CASE WHEN g.posting_date >= ? THEN g.credit ELSE '0' END) mc
      FROM gl_entries g WHERE ${s.sql} AND g.posting_date <= ? GROUP BY g.account_id`).all(from, from, from, from, ...s.params, to);
    const accounts = db.prepare('SELECT id, path, level, is_group, parent_id FROM accounts').all();
    const byId = new Map(accounts.map((a) => [a.id, a]));
    const Z = () => ({ open: D.parse('0'), md: D.parse('0'), mc: D.parse('0') });
    const sums = new Map();
    const add = (id, v) => { const x = sums.get(id) || Z(); x.open = D.add(x.open, v.open); x.md = D.add(x.md, v.md); x.mc = D.add(x.mc, v.mc); sums.set(id, x); };
    const leaves = [];
    for (const r of agg) {
      const v = { open: D.sub(r.od, r.oc), md: D.parse(r.md), mc: D.parse(r.mc) };
      leaves.push(v);
      const a = byId.get(r.id);
      for (const anc of a.path.split('/').filter(Boolean).map(Number)) add(anc, v);   // الحساب نفسه وكل أسلافه
    }
    const maxLevel = intQ(q.level, 15, 15) || 15;
    const withZero = q.includeZero === '1';
    const rows = [];
    for (const t of services.accounts.treeList(ctx)) {
      if (t.level > maxLevel) continue;
      const v = sums.get(t.id) || Z();
      const closing = D.add(v.open, D.sub(v.md, v.mc));
      if (!withZero && D.isZero(v.open) && D.isZero(v.md) && D.isZero(v.mc)) continue;
      rows.push({
        accountId: t.id, code: t.code, nameAr: t.nameAr, nameEn: t.nameEn, level: t.level, parentId: t.parentId, isGroup: t.isGroup, classCode: t.classCode,
        opening: split(v.open), movementDebit: D.canonical(v.md), movementCredit: D.canonical(v.mc),
        movementDebitText: fmt(v.md), movementCreditText: fmt(v.mc), closing: split(closing),
      });
    }
    // الإجماليات من الحسابات التفصيلية فقط (التجميعي مجموعها) — يجب أن يتزن كل عمود
    const T = { od: [], oc: [], md: [], mc: [], cd: [], cc: [] };
    for (const v of leaves) {
      const o = split(v.open); const c = split(D.add(v.open, D.sub(v.md, v.mc)));
      T.od.push(o.debit); T.oc.push(o.credit); T.md.push(v.md); T.mc.push(v.mc); T.cd.push(c.debit); T.cc.push(c.credit);
    }
    const tot = Object.fromEntries(Object.entries(T).map(([k, a]) => [k, D.canonical(D.sum(a.concat(['0'])))]));
    const totals = {
      openingDebit: tot.od, openingCredit: tot.oc, movementDebit: tot.md, movementCredit: tot.mc, closingDebit: tot.cd, closingCredit: tot.cc,
      texts: Object.fromEntries(Object.entries(tot).map(([k, v]) => [k, fmt(v)])),
      balanced: { opening: D.eq(tot.od, tot.oc), movement: D.eq(tot.md, tot.mc), closing: D.eq(tot.cd, tot.cc) },
    };
    totals.balanced.all = totals.balanced.opening && totals.balanced.movement && totals.balanced.closing;
    return { from, to, baseCurrency: base(), branch: branchLabel(ctx, q), level: maxLevel, rows, totals, finality: services.fiscal.finality(from, to) };
  }

  // ── الطباعة والتصدير (نفس البيانات، مع ختم النهائية) ──
  function stamp(lang, finality) {
    const t = (k, v) => services.i18n.t(lang, k, v);
    return finality.final ? t('ledger.final') : `${t('ledger.notFinal')}: ${finality.reasons.map((r) => t('ledger.reason.' + r.code)).join(' — ')}`;
  }
  const TABLES = {
    journal(r, lang) {
      const t = (k) => services.i18n.t(lang, k);
      const rows = [];
      for (const d of r.items) {
        for (const l of d.lines) {
          rows.push([d.date, d.number, d.description || '', d.reference || '', l.accountCode + ' ' + (lang === 'ar' ? l.accountNameAr : l.accountNameEn), l.costCenterCode || '',
            l.currency, l.rate, l.debitFcText, l.creditFcText, l.debitText, l.creditText]);
        }
      }
      rows.push(['', '', '', '', t('ledger.total'), '', '', '', '', '', r.totals.debitText, r.totals.creditText]);
      return { titleKey: 'nav.journalRegister', columns: ['ledger.date', 'ledger.number', 'ledger.description', 'ledger.reference', 'ledger.account', 'ledger.costCenter',
        'ledger.currency', 'ledger.rate', 'ledger.debitFc', 'ledger.creditFc', 'ledger.debit', 'ledger.credit'], rows };
    },
    statement(r, lang) {
      const t = (k) => services.i18n.t(lang, k);
      const bal = (b) => (b.side ? `${b.side === 'debit' ? b.debitText : b.creditText} ${t('ledger.side.' + b.side)}` : '0');
      const rows = [['', '', t('ledger.openingBalance'), '', '', '', r.opening.debitText, r.opening.creditText, bal(r.opening)]];
      for (const x of r.rows) rows.push([x.date, x.number, x.description || '', x.reference || '', x.currency, x.rate, x.debitText, x.creditText, bal(x.balance)]);
      rows.push(['', '', t('ledger.total'), '', '', '', r.totals.debitText, r.totals.creditText, bal(r.closing)]);
      return { titleKey: 'nav.accountStatement', subtitle: `${r.account.code} — ${lang === 'ar' ? r.account.nameAr : r.account.nameEn}`,
        columns: ['ledger.date', 'ledger.number', 'ledger.description', 'ledger.reference', 'ledger.currency', 'ledger.rate', 'ledger.debit', 'ledger.credit', 'ledger.balance'], rows };
    },
    trialBalance(r, lang) {
      const t = (k) => services.i18n.t(lang, k);
      const rows = r.rows.map((x) => ['  '.repeat(x.level - 1) + x.code, lang === 'ar' ? x.nameAr : x.nameEn,
        x.opening.debitText, x.opening.creditText, x.movementDebitText, x.movementCreditText, x.closing.debitText, x.closing.creditText]);
      const T = r.totals.texts;
      rows.push(['', t('ledger.total'), T.od, T.oc, T.md, T.mc, T.cd, T.cc]);
      return { titleKey: 'nav.trialBalance', columns: ['ledger.accountCode', 'ledger.accountName', 'ledger.openingDebit', 'ledger.openingCredit',
        'ledger.movementDebit', 'ledger.movementCredit', 'ledger.closingDebit', 'ledger.closingCredit'], rows };
    },
  };
  const REPORTS = { journal: journalRegister, statement, 'trial-balance': trialBalance };
  const TABLE_OF = { journal: 'journal', statement: 'statement', 'trial-balance': 'trialBalance' };
  function tabular(ctx, name, lang) {
    const r = REPORTS[name](ctx, { ...ctx.query, ...(name === 'journal' ? { limit: '500', offset: '0' } : {}) });
    // المطبوع/المصدَّر كامل أو لا شيء: الإجمالي يجب أن يطابق السطور المعروضة
    if (name === 'journal' && r.hasMore) throw new HttpError(409, 'REPORT_TOO_LARGE', 'المستندات أكثر من حد الطباعة والتصدير؛ ضيّق الفترة', { documents: r.documents, max: 500 });
    const tb = TABLES[TABLE_OF[name]](r, lang);
    const t = (k) => services.i18n.t(lang, k);
    const title = [t(tb.titleKey), tb.subtitle, `${r.from} → ${r.to}`, r.branch ? r.branch.code : t('ledger.allBranches'), stamp(lang, r.finality)].filter(Boolean).join(' | ');
    return { title, columns: tb.columns.map(t), rows: tb.rows, finality: r.finality };
  }

  for (const [name, fn] of Object.entries(REPORTS)) {
    router.get(`/api/ledger/${name}`, P('view'), (ctx) => fn(ctx, ctx.query));
    router.get(`/api/ledger/${name}/print`, P('print'), (ctx) => tabular(ctx, name, ctx.query.lang === 'en' ? 'en' : 'ar'));
    router.get(`/api/ledger/${name}/export.xlsx`, P('export'), (ctx) => {
      const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
      const d = tabular(ctx, name, lang);
      audit.fromCtx(ctx, { action: 'ledger.exported', source: 'journal', entityType: 'ledger_report', details: { report: name, rows: d.rows.length, final: d.finality.final, query: ctx.query } });
      // السطر الأول: العنوان وختم النهائية؛ ثم الجدول
      sendXlsx(ctx.res, `${name}.xlsx`, writeSheet({ sheetName: name, header: d.columns, rows: [[d.title, ...d.columns.slice(1).map(() => '')], ...d.rows], rtl: lang === 'ar' }));
    });
  }
}

module.exports = { registerReports };

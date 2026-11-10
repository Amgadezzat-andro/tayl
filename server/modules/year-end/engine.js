'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('../../core/errors');
const { inTransaction } = require('../../core/db');

/**
 * محرك الإقفال السنوي وترحيل الأرصدة (المرحلة 4). كل كتابة في الأستاذ عبر services.ledger.post() (origin = 'system').
 *
 * النطاق: (سنة مالية × فرع). أرصدة الفروع لا تختلط: كل فرع يُقفل ويُرحَّل بقيوده الخاصة، وحساب النتيجة واحد للشركة
 * بفرع كل قيد. السنة «مُقفلة للشركة» حين يُقفلها كل فرع له حركات حتى نهايتها (الفروع المطلوبة).
 *
 * الأرصدة تراكمية من الأستاذ حتى نهاية السنة **عدا قيود الترحيل** (carry_forward)، لكل (حساب، مركز تكلفة، عملة):
 *   - الإقفال يصفّر حسابات قائمة الدخل (التصنيف income_statement) ويحوّل الصافي إلى حساب النتيجة بالعملة الأساسية.
 *     الإقفال التسلسلي (السنة السابقة مُقفلة ومُرحّلة أولًا) يجعل الرصيد التراكمي = نتيجة هذه السنة وحدها.
 *   - الترحيل يعيد إنشاء أرصدة حسابات الميزانية في أول يوم من السنة التالية (مستند موثق ومرقم)، والتقارير لا تجمعه
 *     (يساوي ما قبله بالضبط)، فلا ازدواج ولا فقد مهما كانت حالة الترحيل.
 *
 * تمثيل الرصيد بسطر: الطرف الواحد في الأستاذ يلزم أن يكون المبلغ الأصلي والأساسي موجبين في الطرف نفسه.
 *   - رصيد أصلي وأساسي بالإشارة نفسها ⇒ سطر واحد بعملته، سعره المشتق = الأساسي ÷ الأصلي (للعرض؛ المبالغ محفوظة كما هي).
 *   - رصيد أساسي بلا أصلي (فرق عملة متبقٍ) ⇒ سطر بالعملة الأساسية (residual).
 *   - رصيد أصلي بأساسي صفري أو معاكس ⇒ الجزء الأجنبي بسعر الجدول في تاريخ نهاية السنة (split) + باقي الأساسي (residual).
 *   الأساسي لكل (حساب، مركز) محفوظ بالضبط، والأصلي لكل (حساب، مركز، عملة أجنبية) محفوظ بالضبط — تثبته المطابقة.
 */
const sha = (x) => crypto.createHash('sha256').update(typeof x === 'string' ? x : JSON.stringify(x)).digest('hex');
const DOC = {
  closing: { docType: 'year_closing', reversal: 'year_closing_reversal', source: 'year_closing', kind: 'closing' },
  carry_forward: { docType: 'carry_forward', reversal: 'carry_forward_reversal', source: 'carry_forward', kind: 'opening' },
};

function createYearEnd(services) {
  const { db, decimal: D, audit } = services;
  const ledger = services.ledger;
  const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };

  // ── السنوات والفروع والعمليات ──
  const yearRow = (id) => db.prepare('SELECT * FROM fiscal_years WHERE id = ?').get(id);
  const nextYearOf = (y) => db.prepare("SELECT * FROM fiscal_years WHERE start_date = date(?, '+1 day')").get(y.end_date) || null;
  const prevYearOf = (y) => db.prepare("SELECT * FROM fiscal_years WHERE end_date = date(?, '-1 day')").get(y.start_date) || null;
  const branchRow = (id) => db.prepare('SELECT * FROM branches WHERE id = ?').get(id);
  const activeClosing = (yearId, branchId) => db.prepare("SELECT * FROM year_closings WHERE fiscal_year_id = ? AND branch_id = ? AND status = 'active'").get(yearId, branchId) || null;
  const activeCarry = (yearId, branchId) => db.prepare("SELECT * FROM carry_forwards WHERE from_year_id = ? AND branch_id = ? AND status = 'active'").get(yearId, branchId) || null;
  const hasHistory = (branchId, beforeDate) => !!db.prepare('SELECT 1 FROM gl_entries WHERE branch_id = ? AND posting_date < ? LIMIT 1').get(branchId, beforeDate);
  /** الفروع المطلوبة لإقفال السنة: لها أي حركة في الأستاذ حتى نهاية السنة. */
  const requiredBranchIds = (y) => db.prepare('SELECT id FROM branches b WHERE EXISTS (SELECT 1 FROM gl_entries g WHERE g.branch_id = b.id AND g.posting_date <= ?) ORDER BY id')
    .all(y.end_date).map((r) => r.id);
  /** السنة مُقفلة للشركة: كل فرع مطلوب أقفلها، وأُقفلت صراحة مرة على الأقل (سنة بلا حركات لا تُعد مُقفلة ضمنًا). */
  const yearClosed = (y) => {
    const req = requiredBranchIds(y);
    return req.every((b) => activeClosing(y.id, b)) && (req.length > 0 || !!db.prepare("SELECT 1 FROM year_closings WHERE fiscal_year_id = ? AND status = 'active'").get(y.id));
  };
  /** أحدث سنة مُقفلة للفرع يقع التاريخ في نهايتها أو قبلها (لا ترحيل يومي فيها ولا قبلها). */
  const closedCovering = (branchId, date) => db.prepare(`SELECT y.* FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id
    WHERE c.branch_id = ? AND c.status = 'active' AND ? <= y.end_date ORDER BY y.start_date LIMIT 1`).get(branchId, date) || null;
  const currencyById = (id) => db.prepare('SELECT id, code FROM currencies WHERE id = ?').get(id);
  const accountLabel = (id) => db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn FROM accounts WHERE id = ?').get(id);

  // ── الأرصدة ──
  /** أرصدة فرع حتى تاريخ لحسابات قائمة (income_statement | balance_sheet)، تراكميًا من الأستاذ عدا قيود الترحيل. */
  function balances(branchId, toDate, statement, { excludeClosingOf = null } = {}) {
    return db.prepare(`SELECT g.account_id, g.cost_center_id, g.currency_id, min(a.code) account_code, min(a.class_code) class_code,
        dec_sum(g.debit_fc) dfc, dec_sum(g.credit_fc) cfc, dec_sum(g.debit) d, dec_sum(g.credit) c
      FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN account_classes k ON k.code = a.class_code
      WHERE g.branch_id = ? AND g.posting_date <= ? AND g.source_type <> 'carry_forward' AND k.statement = ?
        ${excludeClosingOf ? "AND NOT (g.source_type = 'year_closing' AND g.fiscal_year_id = ?)" : ''}
      GROUP BY g.account_id, g.cost_center_id, g.currency_id ORDER BY account_code, g.cost_center_id, g.currency_id`)
      .all(branchId, toDate, statement, ...(excludeClosingOf ? [excludeClosingOf] : []))
      .map((r) => ({ accountId: r.account_id, accountCode: r.account_code, classCode: r.class_code, costCenterId: r.cost_center_id, currencyId: r.currency_id,
        fc: D.sub(r.dfc, r.cfc), base: D.sub(r.d, r.c) }))
      .filter((r) => !D.isZero(r.fc) || !D.isZero(r.base));
  }

  const sideOf = (x) => (D.isNegative(x) ? 'credit' : 'debit');
  function mkLine(b, cur, base, basis, fcAmt, baseAmt, rate) {
    const side = sideOf(baseAmt);
    const fc = D.canonical(D.abs(fcAmt)); const bs = D.canonical(D.abs(baseAmt));
    return { accountId: b.accountId, costCenterId: b.costCenterId ?? null, currencyId: cur.id, currencyCode: cur.code, basis,
      rate: D.canonical(rate), rateSource: cur.id === base.id ? 'base' : 'manual',
      debitFc: side === 'debit' ? fc : '0', creditFc: side === 'credit' ? fc : '0', debit: side === 'debit' ? bs : '0', credit: side === 'credit' ? bs : '0' };
  }
  /** سطور تضيف sign × الرصيد إلى الأستاذ (sign = -1 للإقفال: تصفير، +1 للترحيل: إعادة إنشاء). */
  function linesFor(b, sign, base, rateDate, issues) {
    const F = sign < 0 ? D.neg(b.fc) : D.parse(b.fc);
    const B = sign < 0 ? D.neg(b.base) : D.parse(b.base);
    if (D.isZero(F) && D.isZero(B)) return [];
    const cur = currencyById(b.currencyId);
    const where = { accountId: b.accountId, account: b.accountCode, costCenterId: b.costCenterId, currency: cur.code };
    if (cur.id === base.id) {
      if (!D.eq(F, B)) { issues.push({ code: 'BASE_CURRENCY_MISMATCH', ...where }); return []; }
      return [mkLine(b, cur, base, 'balance', F, B, '1')];
    }
    if (!D.isZero(F) && !D.isZero(B) && D.isNegative(F) === D.isNegative(B)) {
      const rate = D.commit(D.div(D.abs(B), D.abs(F)), 'fx_rate');
      if (D.gt(rate, '0')) return [mkLine(b, cur, base, 'balance', F, B, rate)];
    }
    if (D.isZero(F)) return [mkLine(b, base, base, 'residual', B, B, '1')];
    let snap;
    try { snap = services.currencies.rateSnapshot(cur.code, rateDate, 'average'); } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      issues.push({ code: 'SPLIT_RATE_MISSING', ...where, date: rateDate }); return [];
    }
    const part = D.commit(D.mul(D.abs(F), snap.rate), 'amount', base.code);
    if (D.isZero(part)) { issues.push({ code: 'UNREPRESENTABLE_BALANCE', ...where }); return []; }
    const signedPart = D.isNegative(F) ? D.neg(part) : part;
    const out = [mkLine(b, cur, base, 'split', F, signedPart, snap.rate)];
    const R = D.sub(B, signedPart);
    if (!D.isZero(R)) out.push(mkLine(b, base, base, 'residual', R, R, '1'));
    return out;
  }
  const signed = (l, k) => D.sub(l['debit' + k], l['credit' + k]);
  const lineKey = (l) => JSON.stringify([l.accountId, l.costCenterId, l.currencyId, l.basis, l.rate, l.debitFc, l.creditFc, l.debit, l.credit]);

  /** قيد الإقفال المحسوب لفرع: سطور التصفير + سطر النتيجة، والإجماليات. */
  function computeClosing(y, branchId, reAccountId) {
    const base = ledger.baseCurrency();
    const issues = [];
    const bals = balances(branchId, y.end_date, 'income_statement');
    const lines = bals.flatMap((b) => linesFor(b, -1, base, y.end_date, issues));
    // صافي النتيجة = مجموع سطور التصفير (موجب = ربح: الإيرادات الدائنة تُصفَّر بطرف مدين)
    const net = D.sum(lines.map((l) => signed(l, '')).concat(['0']));
    if (!D.isZero(net) && reAccountId) lines.push(mkLine({ accountId: reAccountId, costCenterId: null }, base, base, 'result', D.neg(net), D.neg(net), '1'));
    const rev = D.sum(bals.filter((b) => b.classCode === 'revenue').map((b) => D.neg(b.base)).concat(['0']));
    const exp = D.sum(bals.filter((b) => b.classCode !== 'revenue').map((b) => b.base).concat(['0']));
    const resultSide = D.isZero(net) ? 'zero' : D.isNegative(net) ? 'loss' : 'profit';
    const fmt = (x) => D.format(x, 'amount', base.code);
    return {
      lines, issues, resultSide, net: D.canonical(D.abs(net)),
      summary: { baseCurrency: base.code, totalRevenue: D.canonical(rev), totalExpense: D.canonical(exp), netResult: D.canonical(net),
        totalRevenueText: fmt(rev), totalExpenseText: fmt(exp), netResultText: fmt(D.abs(net)), resultSide, balances: bals.length, lines: lines.length,
        splitLines: lines.filter((l) => l.basis === 'split').length },
    };
  }

  /** قيد الترحيل المحسوب لفرع: أرصدة الميزانية في نهاية السنة (+ أثر قيد إقفال لم يُرحَّل بعد عند التنفيذ المشترك). */
  function computeCarry(y, branchId, { pendingClosingLines = [] } = {}) {
    const base = ledger.baseCurrency();
    const issues = [];
    const map = new Map();
    for (const b of balances(branchId, y.end_date, 'balance_sheet')) map.set(`${b.accountId}|${b.costCenterId}|${b.currencyId}`, b);
    for (const l of pendingClosingLines.filter((x) => x.basis === 'result')) {
      const k = `${l.accountId}|${l.costCenterId}|${l.currencyId}`;
      const b = map.get(k) || { accountId: l.accountId, accountCode: (accountLabel(l.accountId) || {}).code, costCenterId: l.costCenterId, currencyId: l.currencyId, fc: D.parse('0'), base: D.parse('0') };
      map.set(k, { ...b, fc: D.add(b.fc, signed(l, 'Fc')), base: D.add(b.base, signed(l, '')) });
    }
    const bals = [...map.values()].filter((b) => !D.isZero(b.fc) || !D.isZero(b.base))
      .sort((a, b) => (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : (a.costCenterId ?? 0) - (b.costCenterId ?? 0) || a.currencyId - b.currencyId));
    const lines = bals.flatMap((b) => linesFor(b, +1, base, y.end_date, issues));
    const fmt = (x) => D.format(x, 'amount', base.code);
    const total = D.sum(lines.map((l) => l.debit).concat(['0']));
    const bal = D.balance(lines.map((l) => l.debit).concat(['0']), lines.map((l) => l.credit).concat(['0']));
    return { lines, issues, balanced: bal.balanced, difference: bal.difference,
      summary: { baseCurrency: base.code, balances: bals.length, lines: lines.length, totalBase: D.canonical(total), totalBaseText: fmt(total),
        splitLines: lines.filter((l) => l.basis === 'split').length, residualLines: lines.filter((l) => l.basis === 'residual').length } };
  }

  /**
   * المطابقة: رصيد نهاية السنة لحسابات الميزانية = قيد الترحيل. الأساسي لكل (حساب، مركز) والأصلي لكل
   * (حساب، مركز، عملة أجنبية) بالضبط بلا أي فرق مسموح؛ وحسابات قائمة الدخل صفر في نهاية السنة بعد الإقفال.
   */
  function reconcile(y, branchId, cfLines) {
    const base = ledger.baseCurrency();
    const end = balances(branchId, y.end_date, 'balance_sheet');
    const rows = new Map();
    const row = (accountId, costCenterId, currencyId) => {
      const k = `${accountId}|${costCenterId ?? ''}|${currencyId}`;
      if (!rows.has(k)) rows.set(k, { accountId, costCenterId: costCenterId ?? null, currencyId, endFc: D.parse('0'), endBase: D.parse('0'), cfFc: D.parse('0'), cfBase: D.parse('0') });
      return rows.get(k);
    };
    for (const b of end) { const r = row(b.accountId, b.costCenterId, b.currencyId); r.endFc = D.add(r.endFc, b.fc); r.endBase = D.add(r.endBase, b.base); }
    for (const l of cfLines) { const r = row(l.accountId, l.costCenterId, l.currencyId); r.cfFc = D.add(r.cfFc, signed(l, 'Fc')); r.cfBase = D.add(r.cfBase, signed(l, '')); }
    const byAcc = new Map();
    for (const r of rows.values()) {
      const k = `${r.accountId}|${r.costCenterId ?? ''}`;
      const a = byAcc.get(k) || { end: D.parse('0'), cf: D.parse('0') };
      byAcc.set(k, { end: D.add(a.end, r.endBase), cf: D.add(a.cf, r.cfBase) });
    }
    const out = [...rows.values()].map((r) => {
      const acc = accountLabel(r.accountId); const cur = currencyById(r.currencyId);
      const fcOk = r.currencyId === base.id || D.eq(r.endFc, r.cfFc);
      const a = byAcc.get(`${r.accountId}|${r.costCenterId ?? ''}`);
      return { accountId: r.accountId, accountCode: acc.code, accountNameAr: acc.nameAr, accountNameEn: acc.nameEn, costCenterId: r.costCenterId, currency: cur.code,
        endFc: D.canonical(r.endFc), carriedFc: D.canonical(r.cfFc), endBase: D.canonical(r.endBase), carriedBase: D.canonical(r.cfBase),
        endFcText: D.format(r.endFc, 'amount', cur.code), carriedFcText: D.format(r.cfFc, 'amount', cur.code),
        endBaseText: D.format(r.endBase, 'amount', base.code), carriedBaseText: D.format(r.cfBase, 'amount', base.code),
        fcMatch: fcOk, baseMatch: D.eq(a.end, a.cf), residualMoved: !D.eq(r.endBase, r.cfBase) && D.eq(a.end, a.cf) };
    }).sort((a, b) => (a.accountCode < b.accountCode ? -1 : a.accountCode > b.accountCode ? 1 : (a.costCenterId ?? 0) - (b.costCenterId ?? 0) || (a.currency < b.currency ? -1 : 1)));
    const plLeft = balances(branchId, y.end_date, 'income_statement');
    const total = (k) => D.canonical(D.sum(out.map((r) => r[k]).concat(['0'])));
    const result = {
      ok: out.every((r) => r.fcMatch && r.baseMatch) && plLeft.length === 0,
      rows: out, incomeStatementRemaining: plLeft.length,
      totals: { endBase: total('endBase'), carriedBase: total('carriedBase') },
    };
    result.hash = sha(result.rows.map((r) => [r.accountId, r.costCenterId, r.currency, r.endFc, r.carriedFc, r.endBase, r.carriedBase]));
    return result;
  }

  // ── حساب نتيجة السنة ──
  const settingsRow = () => db.prepare('SELECT * FROM year_end_settings WHERE id = 1').get();
  /** أسباب عدم صلاحية حساب النتيجة: تفصيلي، نشط، حقوق ملكية، ليس حساب مراقبة، ولا يُلزم بمركز تكلفة. */
  function reAccountIssues(id) {
    if (id == null) return [{ code: 'RE_ACCOUNT_NOT_SET' }];
    const a = db.prepare('SELECT a.*, t.code type_code FROM accounts a LEFT JOIN account_types t ON t.id = a.type_id WHERE a.id = ?').get(id);
    if (!a) return [{ code: 'RE_ACCOUNT_INVALID', reason: 'NOT_FOUND' }];
    const out = [];
    const bad = (reason) => out.push({ code: 'RE_ACCOUNT_INVALID', reason, account: a.code });
    if (a.is_group === 1) bad('GROUP');
    if (a.is_active !== 1) bad('INACTIVE');
    if (a.class_code !== 'equity') bad('NOT_EQUITY');
    if (a.allow_manual_entry !== 1) bad('CONTROL_ACCOUNT');
    if (a.cost_center_policy === 'required') bad('COST_CENTER_REQUIRED');
    return out;
  }
  const reAccountWarnings = (id) => {
    const a = id == null ? null : db.prepare('SELECT a.code, t.code type_code FROM accounts a LEFT JOIN account_types t ON t.id = a.type_id WHERE a.id = ?').get(id);
    return a && a.type_code !== 'RETAINED' ? [{ code: 'RE_ACCOUNT_TYPE', account: a.code }] : [];
  };
  /** سنوات مُقفلة جزئيًا: بعض الفروع المطلوبة أقفلتها دون بعض (حساب النتيجة لا يتغير خلالها). */
  const partialYears = () => db.prepare("SELECT DISTINCT y.* FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id WHERE c.status = 'active'").all()
    .filter((y) => !yearClosed(y));

  // ── فحص الجاهزية (مستقل عن الواجهة؛ يُعاد داخل معاملة التنفيذ) ──
  // فحص السلامة يمس الأستاذ كله: مرة واحدة لكل طلب (فحص/معاينة/تنفيذ) مهما كان عدد الفروع
  let integrityMemo = null;
  function integrityIssue(ctx) {
    const r = integrityMemo || ledger.integrity();
    integrityMemo = r;
    if (r.ok) return null;
    // مستخدم فرع: عدد المشكلات فقط (لا تكشف بيانات فروع أخرى)
    return { code: 'LEDGER_INTEGRITY', problems: r.problems.length, ...(ctx.access.allBranches ? { details: r.problems.slice(0, 20) } : {}) };
  }
  function branchBalanceIssue(branchId, toDate) {
    const r = db.prepare('SELECT dec_sum(debit) d, dec_sum(credit) c FROM gl_entries WHERE branch_id = ? AND posting_date <= ?').get(branchId, toDate);
    return D.eq(r.d, r.c) ? null : { code: 'BRANCH_UNBALANCED', totalDebit: r.d, totalCredit: r.c };
  }
  function periodIssues(y) {
    const ps = db.prepare('SELECT id, seq, name_ar nameAr, name_en nameEn, start_date startDate, end_date endDate, status FROM fiscal_periods WHERE fiscal_year_id = ? ORDER BY start_date').all(y.id);
    const out = [];
    let cursor = y.start_date; let contiguous = ps.length > 0;
    for (const p of ps) { if (p.startDate !== cursor) contiguous = false; cursor = db.prepare("SELECT date(?, '+1 day') d").get(p.endDate).d; }
    if (!contiguous || !ps.length || ps[ps.length - 1].endDate !== y.end_date) out.push({ code: 'PERIODS_INVALID' });
    const open = ps.filter((p) => p.status === 'open');
    if (open.length) out.push({ code: 'PERIODS_OPEN', periods: open });
    const last = ps[ps.length - 1];
    if (last && last.status === 'locked') out.push({ code: 'LAST_PERIOD_LOCKED', period: last });
    return out;
  }

  /** فحص إقفال (سنة، فرع): { errors, warnings, info, plan }. */
  function checkClose(ctx, y, branchId) {
    const errors = []; const warnings = []; const info = [];
    const br = branchRow(branchId);
    if (br.is_active !== 1) errors.push({ code: 'BRANCH_INACTIVE', branch: br.code });
    if (!(ledger.today() > y.end_date)) errors.push({ code: 'YEAR_NOT_ENDED', endDate: y.end_date, today: ledger.today() });
    const existing = activeClosing(y.id, branchId);
    if (existing) errors.push({ code: 'ALREADY_CLOSED', closingId: existing.id });
    const prev = prevYearOf(y);
    if (prev && hasHistory(branchId, y.start_date)) {
      if (!activeClosing(prev.id, branchId)) errors.push({ code: 'PREVIOUS_YEAR_NOT_CLOSED', year: prev.code, yearId: prev.id });
      else if (!activeCarry(prev.id, branchId)) errors.push({ code: 'PREVIOUS_YEAR_NOT_CARRIED', year: prev.code, yearId: prev.id });
    }
    errors.push(...periodIssues(y));
    const drafts = db.prepare("SELECT id, entry_type entryType, entry_date date, description FROM journal_entries WHERE branch_id = ? AND status = 'draft' AND entry_date <= ? ORDER BY entry_date LIMIT 50")
      .all(branchId, y.end_date);
    if (drafts.length) errors.push({ code: 'DRAFTS_EXIST', count: db.prepare("SELECT count(*) n FROM journal_entries WHERE branch_id = ? AND status = 'draft' AND entry_date <= ?").get(branchId, y.end_date).n, drafts });
    const integ = integrityIssue(ctx); if (integ) errors.push(integ);
    const unb = branchBalanceIssue(branchId, y.end_date); if (unb) errors.push(unb);
    const reId = settingsRow().retained_earnings_account_id;
    errors.push(...reAccountIssues(reId));
    warnings.push(...reAccountWarnings(reId));
    const other = db.prepare("SELECT DISTINCT retained_earnings_account_id id FROM year_closings WHERE fiscal_year_id = ? AND status = 'active' AND retained_earnings_account_id IS NOT ?").all(y.id, reId);
    if (other.length) errors.push({ code: 'RE_ACCOUNT_DIFFERS_IN_YEAR', accounts: other.map((o) => (accountLabel(o.id) || {}).code) });
    const plan = computeClosing(y, branchId, reId);
    errors.push(...plan.issues);
    if (!plan.lines.length) warnings.push({ code: 'NO_INCOME_STATEMENT_BALANCES' });
    if (plan.summary.splitLines) warnings.push({ code: 'SPLIT_LINES', count: plan.summary.splitLines });
    const inactive = db.prepare(`SELECT DISTINCT a.code FROM accounts a WHERE a.is_active = 0 AND a.id IN (${plan.lines.map(() => '?').join(',') || 'NULL'})`).all(...plan.lines.map((l) => l.accountId));
    if (inactive.length) info.push({ code: 'INACTIVE_ACCOUNTS_CLOSED', accounts: inactive.map((a) => a.code) });
    const next = nextYearOf(y);
    if (!next) warnings.push({ code: 'NEXT_YEAR_MISSING' });
    if (!hasHistory(branchId, db.prepare("SELECT date(?, '+1 day') d").get(y.end_date).d)) info.push({ code: 'BRANCH_NO_ACTIVITY' });
    info.push({ code: 'RESULT', ...plan.summary });
    return { errors, warnings, info, plan };
  }

  /** فحص ترحيل (سنة، فرع). pendingClosing: سطور إقفال محسوبة لم تُرحَّل بعد (التنفيذ المشترك). */
  function checkCarry(ctx, y, branchId, { pendingClosing = null } = {}) {
    const errors = []; const warnings = []; const info = [];
    const br = branchRow(branchId);
    if (br.is_active !== 1) errors.push({ code: 'BRANCH_INACTIVE', branch: br.code });
    if (!pendingClosing && !activeClosing(y.id, branchId)) errors.push({ code: 'NOT_CLOSED' });
    const done = activeCarry(y.id, branchId);
    if (done) errors.push({ code: 'ALREADY_CARRIED', carryForwardId: done.id });
    const next = nextYearOf(y);
    if (!next) errors.push({ code: 'NEXT_YEAR_MISSING' });
    else {
      const p = db.prepare('SELECT id, status, name_ar nameAr, name_en nameEn FROM fiscal_periods WHERE fiscal_year_id = ? AND ? BETWEEN start_date AND end_date').get(next.id, next.start_date);
      if (!p) errors.push({ code: 'NEXT_YEAR_NOT_INITIALIZED', year: next.code });
      else if (p.status === 'locked') errors.push({ code: 'NEXT_YEAR_FIRST_PERIOD_LOCKED', year: next.code, period: p });
      if (activeClosing(next.id, branchId)) errors.push({ code: 'NEXT_YEAR_CLOSED', year: next.code });
    }
    if (!pendingClosing) {
      const integ = integrityIssue(ctx); if (integ) errors.push(integ);
      const unb = branchBalanceIssue(branchId, y.end_date); if (unb) errors.push(unb);
      const pl = balances(branchId, y.end_date, 'income_statement');
      if (pl.length) errors.push({ code: 'INCOME_STATEMENT_NOT_ZERO', balances: pl.length });
    }
    const plan = computeCarry(y, branchId, { pendingClosingLines: pendingClosing ? pendingClosing.lines : [] });
    errors.push(...plan.issues);
    if (!plan.balanced) errors.push({ code: 'CARRY_FORWARD_UNBALANCED', difference: plan.difference });
    if (!plan.lines.length) warnings.push({ code: 'NO_BALANCES_TO_CARRY' });
    if (plan.summary.residualLines) info.push({ code: 'RESIDUAL_LINES', count: plan.summary.residualLines });
    if (plan.summary.splitLines) warnings.push({ code: 'SPLIT_LINES', count: plan.summary.splitLines });
    info.push({ code: 'CARRY_SUMMARY', ...plan.summary, toYear: next ? next.code : null });
    return { errors, warnings, info, plan, next };
  }

  // ── الطلب: السنة والفروع والصلاحيات ──
  function resolve(ctx, body, { op }) {
    const yearId = Number(body.fiscalYearId);
    const y = Number.isSafeInteger(yearId) ? yearRow(yearId) : null;
    if (!y) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { fiscalYearId: y === null && body.fiscalYearId ? 'NOT_FOUND' : 'REQUIRED' } });
    let ids;
    if (body.branchIds === 'all' || body.branchIds == null) {
      // «كل الفروع» = المطلوبة لهذه السنة ضمن نطاق المستخدم (فرع بلا حركات لا يحتاج إقفالًا)؛
      // سنة بلا أي حركات: الفروع النشطة ضمن النطاق (إقفال صريح بلا قيود)
      let req = op === 'carry_forward' ? db.prepare("SELECT branch_id id FROM year_closings WHERE fiscal_year_id = ? AND status = 'active'").all(y.id).map((r) => r.id) : requiredBranchIds(y);
      if (op === 'close' && !req.length) req = db.prepare('SELECT id FROM branches WHERE is_active = 1 ORDER BY id').all().map((r) => r.id);
      ids = req.filter((id) => ctx.access.branchAllowed(id));
      if (!ids.length) fail(409, 'NO_BRANCHES', 'لا توجد فروع مطلوبة ضمن نطاقك لهذه العملية');
    } else {
      if (!Array.isArray(body.branchIds) || !body.branchIds.length || body.branchIds.length > 200 || !body.branchIds.every((x) => Number.isSafeInteger(x) && x > 0)) {
        fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { branchIds: 'INVALID' } });
      }
      ids = [...new Set(body.branchIds)].sort((a, b) => a - b);
      for (const id of ids) {
        if (!branchRow(id)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { branchIds: 'NOT_FOUND' } });
        ctx.access.assertBranch(id);
      }
    }
    return { y, ids };
  }
  const combined = (fps) => sha(fps.join('|'));
  const strip = (r) => ({ errors: r.errors, warnings: r.warnings, info: r.info });

  function previewLines(lines) {
    const base = ledger.baseCurrency().code;
    return lines.map((l, i) => {
      const a = accountLabel(l.accountId);
      const cc = l.costCenterId ? db.prepare('SELECT code FROM cost_centers WHERE id = ?').get(l.costCenterId) : null;
      return { lineNo: i + 1, accountId: l.accountId, accountCode: a.code, accountNameAr: a.nameAr, accountNameEn: a.nameEn, costCenterCode: cc ? cc.code : null,
        currency: l.currencyCode, rate: l.rate, basis: l.basis, debitFc: l.debitFc, creditFc: l.creditFc, debit: l.debit, credit: l.credit,
        debitFcText: D.format(l.debitFc, 'amount', l.currencyCode), creditFcText: D.format(l.creditFc, 'amount', l.currencyCode),
        debitText: D.format(l.debit, 'amount', base), creditText: D.format(l.credit, 'amount', base) };
    });
  }

  /** فحص الجاهزية أو المعاينة لعدة فروع (لا كتابة). */
  function plan(ctx, body, { withLines }) {
    const op = body.operation === 'carry_forward' ? 'carry_forward' : 'close';
    const { y, ids } = resolve(ctx, body, { op });
    const withCarry = op === 'close' && body.carryForward === true;
    const internals = new Map();
    integrityMemo = null;
    const branches = ids.map((id) => {
      const br = branchRow(id);
      const c = op === 'close' ? checkClose(ctx, y, id) : checkCarry(ctx, y, id);
      internals.set(id, c);
      const cf = withCarry ? checkCarry(ctx, y, id, { pendingClosing: c.plan }) : null;
      const fp = sha({ op, withCarry, yearId: y.id, branchId: id, re: op === 'close' ? settingsRow().retained_earnings_account_id : null,
        lines: c.plan.lines.map(lineKey), cf: cf ? cf.plan.lines.map(lineKey) : null });
      return {
        branchId: id, branch: { id: br.id, code: br.code, nameAr: br.name_ar, nameEn: br.name_en },
        ...strip(c), ready: c.errors.length === 0 && (!cf || cf.errors.length === 0), fingerprint: fp,
        ...(cf ? { carryForward: strip(cf) } : {}),
        ...(withLines ? { lines: previewLines(c.plan.lines), summary: c.plan.summary, ...(cf ? { carryForwardLines: previewLines(cf.plan.lines), carryForwardSummary: cf.plan.summary } : {}) } : {}),
      };
    });
    const out = {
      operation: op, carryForward: withCarry, fiscalYear: { id: y.id, code: y.code, startDate: y.start_date, endDate: y.end_date },
      ready: branches.every((b) => b.ready), hasWarnings: branches.some((b) => b.warnings.length || (b.carryForward && b.carryForward.warnings.length)),
      fingerprint: combined(branches.map((b) => b.fingerprint)),
      canExecute: ctx.access.can(op === 'close' ? 'year_end.close' : 'year_end.carry_forward') && (!withCarry || ctx.access.can('year_end.carry_forward')),
      branches,
    };
    Object.defineProperty(out, 'internals', { value: internals });   // للتنفيذ في المعاملة نفسها؛ لا يُرسَل للعميل
    integrityMemo = null;
    return out;
  }

  // ── منع التكرار ──
  const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
  function replay(ctx, key, op) {
    const r = db.prepare('SELECT * FROM year_end_requests WHERE idempotency_key = ?').get(key);
    if (!r) return null;
    if (r.operation !== op || r.user_id !== ctx.user.id) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'مفتاح الطلب مستخدم لعملية أخرى');
    return { ...JSON.parse(r.result), replayed: true };
  }
  const remember = (ctx, key, op, yearId, result) =>
    db.prepare('INSERT INTO year_end_requests (idempotency_key, operation, fiscal_year_id, user_id, result) VALUES (?, ?, ?, ?, ?)').run(key, op, yearId, ctx.user.id, JSON.stringify(result));
  function execBody(body) {
    const fields = {};
    if (typeof body.idempotencyKey !== 'string' || !KEY_RE.test(body.idempotencyKey)) fields.idempotencyKey = 'INVALID';
    if (Object.keys(fields).length) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields });
    if (body.confirm !== true) fail(409, 'CONFIRM_REQUIRED', 'يلزم تأكيد صريح للتنفيذ');
  }

  // ── مستندات النظام ──
  const toEngine = (l) => ({ lineNo: l.line_no, lineId: l.id, accountId: l.account_id, costCenterId: l.cost_center_id, description: l.description,
    currencyId: l.currency_id, rate: l.rate, rateSource: l.rate_source, rateId: null, debitFc: l.debit_fc, creditFc: l.credit_fc, debit: l.debit, credit: l.credit });
  function postDoc(ctx, d) {
    const meta = DOC[d.kind];
    const docType = d.reverses ? meta.reversal : meta.docType;
    const series = services.numbering.seriesFor(docType);
    const id = Number(db.prepare(`INSERT INTO year_end_entries (kind, closing_id, carry_forward_id, is_reversal, reverses_id, reason, closing_year_id, fiscal_year_id,
      branch_id, entry_date, series_id, description, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(d.kind, d.closingId ?? null, d.carryForwardId ?? null, d.reverses ? 1 : 0, d.reverses ? d.reverses.id : null, d.reason ?? null,
        d.closingYearId, d.fiscalYearId, d.branchId, d.date, series.id, d.description, ctx.user.id).lastInsertRowid);
    if (d.reverses) {
      db.prepare(`INSERT INTO year_end_lines (entry_id, line_no, account_id, cost_center_id, currency_id, basis, rate, rate_source, debit_fc, credit_fc, debit, credit, description, reverses_line_id)
        SELECT ?, line_no, account_id, cost_center_id, currency_id, basis, rate, rate_source, credit_fc, debit_fc, credit, debit, description, id FROM year_end_lines WHERE entry_id = ? ORDER BY line_no`)
        .run(id, d.reverses.id);
    } else {
      const ins = db.prepare(`INSERT INTO year_end_lines (entry_id, line_no, account_id, cost_center_id, currency_id, basis, rate, rate_source, debit_fc, credit_fc, debit, credit)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      d.lines.forEach((l, i) => ins.run(id, i + 1, l.accountId, l.costCenterId, l.currencyId, l.basis, l.rate, l.rateSource, l.debitFc, l.creditFc, l.debit, l.credit));
    }
    const r = ledger.post(ctx, {
      sourceType: meta.source, sourceId: id, docType, seriesId: series.id, entryKind: meta.kind, origin: 'system',
      branchId: d.branchId, date: d.date, description: d.description, futureDateConfirmed: false,
      lines: db.prepare('SELECT * FROM year_end_lines WHERE entry_id = ? ORDER BY line_no').all(id).map(toEngine),
      persist: (res) => db.prepare(`UPDATE year_end_entries SET status = 'posted', number = ?, fiscal_period_id = ?, decimal_snapshot = ?, total_base = ?, posted_by = ?, posted_at = ? WHERE id = ?`)
        .run(res.number, res.periodId, res.decimalSnapshot, res.totalBase, ctx.user.id, res.postedAt, id),
    });
    return { id, number: r.number, totalBase: r.totalBase };
  }
  const originalOf = (col, opId) => db.prepare(`SELECT * FROM year_end_entries WHERE ${col} = ? AND is_reversal = 0 AND status = 'posted'`).get(opId) || null;
  const cfLinesOf = (entryId) => (entryId ? db.prepare('SELECT * FROM year_end_lines WHERE entry_id = ? ORDER BY line_no').all(entryId)
    .map((l) => ({ accountId: l.account_id, costCenterId: l.cost_center_id, currencyId: l.currency_id, debitFc: l.debit_fc, creditFc: l.credit_fc, debit: l.debit, credit: l.credit })) : []);

  /**
   * ترحيل فرع واحد داخل معاملة قائمة: الخطة ← سجل العملية بالمطابقة المتوقعة ← المستند عبر المحرك ← إعادة المطابقة الفعلية
   * من الأستاذ والمستند المرحّل والتأكد أنها مطابقة للمتوقعة بالضبط (وإلا تُلغى المعاملة كلها).
   */
  function carryOne(ctx, y, next, branchId, readiness, fingerprint) {
    const closing = activeClosing(y.id, branchId);
    const plan = computeCarry(y, branchId);
    if (plan.issues.length || !plan.balanced) fail(409, 'NOT_READY', 'ترحيل الأرصدة غير جاهز', { branchId, errors: plan.issues });
    const expected = reconcile(y, branchId, plan.lines);
    if (!expected.ok) fail(409, 'RECONCILIATION_FAILED', 'المطابقة المتوقعة غير متطابقة؛ لم يُحفظ شيء', { branchId });
    const fid = Number(db.prepare(`INSERT INTO carry_forwards (from_year_id, to_year_id, branch_id, closing_id, reconciliation, reconciliation_hash, fingerprint, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(y.id, next.id, branchId, closing.id, JSON.stringify({ ...expected, readiness }), expected.hash, fingerprint, ctx.user.id).lastInsertRowid);
    let entry = null;
    if (plan.lines.length) {
      entry = postDoc(ctx, { kind: 'carry_forward', carryForwardId: fid, closingYearId: y.id, fiscalYearId: next.id, branchId, date: next.start_date,
        description: `ترحيل أرصدة ${y.code} إلى ${next.code} / Balances carried forward ${y.code} → ${next.code}`, lines: plan.lines });
    }
    const actual = reconcile(y, branchId, cfLinesOf(entry && entry.id));
    if (!actual.ok || actual.hash !== expected.hash) fail(500, 'RECONCILIATION_FAILED', 'فشلت مطابقة رصيد نهاية السنة مع الترحيل؛ لم يُحفظ شيء', { branchId });
    audit.fromCtx(ctx, { action: 'year_end.carried_forward', source: 'year-end', entityType: 'carry_forward', entityId: fid, details: {
      fromYear: y.code, toYear: next.code, branch: branchRow(branchId).code, entry: entry ? entry.number : null, lines: plan.lines.length,
      totalBase: plan.summary.totalBase, reconciliationHash: expected.hash, fingerprint } });
    return { carryForwardId: fid, branchId, entry, reconciliation: { ok: true, hash: expected.hash, rows: expected.rows.length } };
  }

  function closeOne(ctx, y, branchId, checked, fingerprint) {
    const reId = settingsRow().retained_earnings_account_id;
    const p = checked.plan;
    const cid = Number(db.prepare(`INSERT INTO year_closings (fiscal_year_id, branch_id, retained_earnings_account_id, closing_date, result_side, net_result, summary, readiness, fingerprint, created_by)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(y.id, branchId, reId, y.end_date, p.resultSide, p.net, JSON.stringify(p.summary), JSON.stringify(strip(checked)), fingerprint, ctx.user.id).lastInsertRowid);
    let entry = null;
    if (p.lines.length) {
      entry = postDoc(ctx, { kind: 'closing', closingId: cid, closingYearId: y.id, fiscalYearId: y.id, branchId, date: y.end_date,
        description: `قيد إقفال السنة ${y.code} / Year-end closing ${y.code}`, lines: p.lines });
    }
    // بعد الإقفال: حسابات قائمة الدخل صفر للفرع في نهاية السنة (وإلا تُلغى المعاملة)
    if (balances(branchId, y.end_date, 'income_statement').length) fail(500, 'CLOSING_FAILED', 'لم تُصفَّر حسابات قائمة الدخل؛ لم يُحفظ شيء', { branchId });
    audit.fromCtx(ctx, { action: 'year_end.closed', source: 'year-end', entityType: 'year_closing', entityId: cid, details: {
      year: y.code, branch: branchRow(branchId).code, entry: entry ? entry.number : null, retainedEarningsAccount: (accountLabel(reId) || {}).code,
      resultSide: p.resultSide, netResult: p.net, totalRevenue: p.summary.totalRevenue, totalExpense: p.summary.totalExpense,
      warnings: checked.warnings.map((w) => w.code), fingerprint } });
    return { closingId: cid, branchId, entry, resultSide: p.resultSide, netResult: p.net, netResultText: p.summary.netResultText };
  }

  /** تنفيذ الإقفال (وترحيل الأرصدة اختياريًا) لفرع أو أكثر: معاملة واحدة، كل الفروع أو لا شيء. */
  function close(ctx, body) {
    execBody(body);
    const withCarry = body.carryForward === true;
    if (withCarry && !ctx.access.can('year_end.carry_forward')) fail(403, 'FORBIDDEN', 'ترحيل الأرصدة يتطلب صلاحية خاصة');
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'close');
      if (prior) return prior;
      const p = plan(ctx, { ...body, operation: 'close' }, { withLines: false });
      gate(p, body);
      const y = yearRow(p.fiscalYear.id);
      const results = p.branches.map((b) => {
        const r = closeOne(ctx, y, b.branchId, p.internals.get(b.branchId), b.fingerprint);   // الخطة نفسها التي فُحصت داخل المعاملة
        if (withCarry) r.carryForward = carryOne(ctx, y, nextYearOf(y), b.branchId, b.carryForward, b.fingerprint);
        return r;
      });
      const result = { operation: 'close', fiscalYearId: y.id, carryForward: withCarry, branches: results, companyClosed: yearClosed(y) };
      remember(ctx, body.idempotencyKey, 'close', y.id, result);
      return result;
    });
  }
  /** ترحيل الأرصدة خطوة مستقلة بعد الإقفال. */
  function carryForward(ctx, body) {
    execBody(body);
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'carry_forward');
      if (prior) return prior;
      const p = plan(ctx, { ...body, operation: 'carry_forward' }, { withLines: false });
      gate(p, body);
      const y = yearRow(p.fiscalYear.id);
      const next = nextYearOf(y);
      const results = p.branches.map((b) => carryOne(ctx, y, next, b.branchId, strip(b), b.fingerprint));
      const result = { operation: 'carry_forward', fiscalYearId: y.id, branches: results };
      remember(ctx, body.idempotencyKey, 'carry_forward', y.id, result);
      return result;
    });
  }
  /** الشروط في الخادم قبل أي كتابة: لا أخطاء مانعة، والتحذيرات مُقرّة، والمعاينة لم تتغير. */
  function gate(p, body) {
    if (!p.ready) {
      fail(409, 'NOT_READY', 'توجد أخطاء مانعة؛ لم يُنفَّذ شيء', { branches: p.branches.filter((b) => !b.ready)
        .map((b) => ({ branchId: b.branchId, branch: b.branch.code, errors: b.errors.concat(b.carryForward ? b.carryForward.errors : []) })) });
    }
    if (p.hasWarnings && body.acknowledgeWarnings !== true) fail(409, 'WARNINGS_NOT_ACKNOWLEDGED', 'توجد تحذيرات تتطلب إقرارًا صريحًا');
    if (typeof body.fingerprint !== 'string' || body.fingerprint !== p.fingerprint) fail(409, 'PREVIEW_STALE', 'تغيّرت البيانات منذ المعاينة؛ أعد المعاينة قبل التنفيذ');
  }

  // ── إعادة الفتح والتصحيح ──
  function revertBody(ctx, body) {
    execBody(body);
    const reason = typeof body.reason === 'string' ? body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 500) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { reason: reason ? 'TOO_SHORT' : 'REQUIRED' } });
    const branchId = Number(body.branchId);
    if (!Number.isSafeInteger(branchId) || !branchRow(branchId)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { branchId: 'NOT_FOUND' } });
    ctx.access.assertBranch(branchId);
    const y = yearRow(Number(body.fiscalYearId));
    if (!y) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { fiscalYearId: 'NOT_FOUND' } });
    return { reason, branchId, y };
  }
  /** نشاط الفرع في السنة التالية غير مستند الترحيل نفسه. */
  const nextYearActivity = (next, branchId) => db.prepare("SELECT count(DISTINCT source_type || ':' || source_id) n FROM gl_entries WHERE branch_id = ? AND fiscal_year_id = ? AND source_type <> 'carry_forward'").get(branchId, next.id).n;

  function revertCarryCore(ctx, y, branchId, reason, body) {
    const cf = activeCarry(y.id, branchId);
    if (!cf) fail(409, 'NOT_CARRIED', 'لا يوجد ترحيل أرصدة نشط لهذه السنة والفرع');
    const next = yearRow(cf.to_year_id);
    if (activeClosing(next.id, branchId)) fail(409, 'NEXT_YEAR_CLOSED', 'السنة التالية مُقفلة لهذا الفرع؛ أعد فتحها أولًا (بالتسلسل من الأحدث)', { year: next.code });
    const original = originalOf('carry_forward_id', cf.id);
    if (original) {
      const p = services.fiscal.periodFor(original.entry_date);
      if (!p || p.status === 'locked') fail(409, 'PERIOD_LOCKED', 'فترة مستند الترحيل مقفلة نهائيًا؛ لا يمكن عكسه', { date: original.entry_date });
    }
    const n = nextYearActivity(next, branchId);
    if (n > 0 && body.confirmNextYearActivity !== true) {
      fail(409, 'NEXT_YEAR_HAS_ACTIVITY', 'للفرع حركات في السنة التالية؛ أرصدتها تبقى صحيحة (تُحسب من الأستاذ)، ويلزم تأكيد صريح وإعادة الترحيل بعد التصحيح', { entries: n, year: next.code });
    }
    let rev = null;
    if (original) {
      rev = postDoc(ctx, { kind: 'carry_forward', carryForwardId: cf.id, reverses: original, reason, closingYearId: y.id, fiscalYearId: next.id, branchId,
        date: original.entry_date, description: `عكس ${original.number} / Reversal of ${original.number}` });
    }
    db.prepare("UPDATE carry_forwards SET status = 'reverted', reverted_by = ?, reverted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revert_reason = ? WHERE id = ?").run(ctx.user.id, reason, cf.id);
    audit.fromCtx(ctx, { action: 'year_end.carry_forward_reverted', source: 'year-end', entityType: 'carry_forward', entityId: cf.id, details: {
      fromYear: y.code, toYear: next.code, branch: branchRow(branchId).code, original: original ? original.number : null, reversal: rev ? rev.number : null,
      reason, nextYearEntries: n, confirmed: body.confirmNextYearActivity === true } });
    return { carryForwardId: cf.id, reversal: rev };
  }

  function revertCarry(ctx, body) {
    const { reason, branchId, y } = revertBody(ctx, body);
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'revert_carry_forward');
      if (prior) return prior;
      const r = revertCarryCore(ctx, y, branchId, reason, body);
      const result = { operation: 'revert_carry_forward', fiscalYearId: y.id, branchId, ...r };
      remember(ctx, body.idempotencyKey, 'revert_carry_forward', y.id, result);
      return result;
    });
  }

  /**
   * إعادة فتح السنة لفرع: عكس قيد الإقفال (وترحيل الأرصدة قبله عند includeCarryForward) بقيود عكسية مرقمة، وتغيير حالة
   * العمليات إلى «ملغاة» مع حفظ السجل. لا تصحيح جزئي: أي شرط غير مستوفى يوقف العملية كلها ويشرح المطلوب.
   */
  function reopen(ctx, body) {
    const { reason, branchId, y } = revertBody(ctx, body);
    const withCarry = body.includeCarryForward === true;
    if (withCarry && !ctx.access.can('year_end.revert_carry_forward')) fail(403, 'FORBIDDEN', 'إلغاء ترحيل الأرصدة يتطلب صلاحية خاصة');
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'reopen');
      if (prior) return prior;
      const closing = activeClosing(y.id, branchId);
      if (!closing) fail(409, 'NOT_CLOSED', 'السنة غير مُقفلة لهذا الفرع');
      const next = nextYearOf(y);
      if (next && activeClosing(next.id, branchId)) fail(409, 'NEXT_YEAR_CLOSED', 'السنة التالية مُقفلة لهذا الفرع؛ أعد فتحها أولًا (بالتسلسل من الأحدث)', { year: next.code });
      const cf = activeCarry(y.id, branchId);
      if (cf && !withCarry) fail(409, 'CARRY_FORWARD_ACTIVE', 'أرصدة هذه السنة مُرحّلة؛ يلزم إلغاء الترحيل معها (includeCarryForward) وصلاحيته', { carryForwardId: cf.id });
      const original = originalOf('closing_id', closing.id);
      if (original) {
        const p = services.fiscal.periodFor(original.entry_date);
        if (!p || p.status === 'locked') fail(409, 'PERIOD_LOCKED', 'آخر فترة في السنة مقفلة نهائيًا؛ لا يمكن عكس قيد الإقفال', { date: original.entry_date });
      }
      const carried = cf ? revertCarryCore(ctx, y, branchId, reason, body) : null;
      let rev = null;
      if (original) {
        rev = postDoc(ctx, { kind: 'closing', closingId: closing.id, reverses: original, reason, closingYearId: y.id, fiscalYearId: y.id, branchId,
          date: original.entry_date, description: `عكس ${original.number} / Reversal of ${original.number}` });
      }
      db.prepare("UPDATE year_closings SET status = 'reverted', reverted_by = ?, reverted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), revert_reason = ? WHERE id = ?").run(ctx.user.id, reason, closing.id);
      audit.fromCtx(ctx, { action: 'year_end.reopened', source: 'year-end', entityType: 'year_closing', entityId: closing.id, details: {
        year: y.code, branch: branchRow(branchId).code, original: original ? original.number : null, reversal: rev ? rev.number : null, reason,
        carryForwardReverted: !!carried } });
      const result = { operation: 'reopen', fiscalYearId: y.id, branchId, closingId: closing.id, reversal: rev, carryForward: carried };
      remember(ctx, body.idempotencyKey, 'reopen', y.id, result);
      return result;
    });
  }

  // ── الحالة والسجل ──
  const userName = (id) => (id == null ? null : (db.prepare('SELECT username FROM users WHERE id = ?').get(id) || {}).username || null);
  const entryRef = (e) => (e ? { id: e.id, number: e.number, date: e.entry_date, totalBase: e.total_base } : null);
  function closingApi(c) {
    if (!c) return null;
    const orig = originalOf('closing_id', c.id);
    const rev = orig ? db.prepare("SELECT * FROM year_end_entries WHERE reverses_id = ? AND status = 'posted'").get(orig.id) : null;
    return { id: c.id, status: c.status, fiscalYearId: c.fiscal_year_id, branchId: c.branch_id, closingDate: c.closing_date, resultSide: c.result_side, netResult: c.net_result,
      summary: JSON.parse(c.summary), retainedEarningsAccount: accountLabel(c.retained_earnings_account_id), entry: entryRef(orig), reversal: entryRef(rev),
      createdBy: userName(c.created_by), createdAt: c.created_at, revertedBy: userName(c.reverted_by), revertedAt: c.reverted_at, revertReason: c.revert_reason,
      fingerprint: c.fingerprint };
  }
  function carryApi(f) {
    if (!f) return null;
    const orig = originalOf('carry_forward_id', f.id);
    const rev = orig ? db.prepare("SELECT * FROM year_end_entries WHERE reverses_id = ? AND status = 'posted'").get(orig.id) : null;
    const rec = JSON.parse(f.reconciliation);
    return { id: f.id, status: f.status, fromYearId: f.from_year_id, toYearId: f.to_year_id, branchId: f.branch_id, entry: entryRef(orig), reversal: entryRef(rev),
      reconciliationOk: rec.ok === true, reconciliationHash: f.reconciliation_hash, createdBy: userName(f.created_by), createdAt: f.created_at,
      revertedBy: userName(f.reverted_by), revertedAt: f.reverted_at, revertReason: f.revert_reason };
  }
  /** حالة السنة لكل فرع ضمن نطاق المستخدم: غير جاهز/جاهز لا يُحسب هنا (فحص الجاهزية يحسبه)، بل الحالة المسجلة. */
  function status(ctx, yearId) {
    const y = yearRow(yearId);
    if (!y) fail(404, 'NOT_FOUND', 'السنة غير موجودة');
    const required = new Set(requiredBranchIds(y));
    const next = nextYearOf(y); const prev = prevYearOf(y);
    const branches = db.prepare('SELECT * FROM branches ORDER BY code').all().filter((b) => ctx.access.branchAllowed(b.id) && (required.has(b.id) || b.is_active === 1))
      .map((b) => {
        const c = activeClosing(y.id, b.id); const f = activeCarry(y.id, b.id);
        const state = c ? (f ? 'carried' : (next ? 'closed' : 'closed_no_next_year')) : (required.has(b.id) ? 'open' : 'not_required');
        return { branch: { id: b.id, code: b.code, nameAr: b.name_ar, nameEn: b.name_en, isActive: b.is_active === 1 }, required: required.has(b.id), state,
          closing: closingApi(c), carryForward: carryApi(f) };
      });
    const periods = db.prepare('SELECT id, seq, name_ar nameAr, name_en nameEn, start_date startDate, end_date endDate, status FROM fiscal_periods WHERE fiscal_year_id = ? ORDER BY seq').all(y.id);
    const reId = settingsRow().retained_earnings_account_id;
    return {
      fiscalYear: { id: y.id, code: y.code, nameAr: y.name_ar, nameEn: y.name_en, startDate: y.start_date, endDate: y.end_date, ended: ledger.today() > y.end_date },
      nextYear: next ? { id: next.id, code: next.code, startDate: next.start_date } : null, previousYear: prev ? { id: prev.id, code: prev.code } : null,
      periods, companyClosed: yearClosed(y), retainedEarningsAccount: reId ? accountLabel(reId) : null, branches,
    };
  }
  function history(ctx, yearId) {
    const vis = (b) => ctx.access.branchAllowed(b);
    const br = (id) => { const b = branchRow(id); return { id: b.id, code: b.code, nameAr: b.name_ar, nameEn: b.name_en }; };
    const closings = db.prepare('SELECT * FROM year_closings WHERE fiscal_year_id = ? ORDER BY id').all(yearId).filter((c) => vis(c.branch_id)).map((c) => ({ type: 'closing', branch: br(c.branch_id), ...closingApi(c) }));
    const carries = db.prepare('SELECT * FROM carry_forwards WHERE from_year_id = ? ORDER BY id').all(yearId).filter((f) => vis(f.branch_id)).map((f) => ({ type: 'carry_forward', branch: br(f.branch_id), ...carryApi(f) }));
    return [...closings, ...carries].sort((a, b) => (a.createdAt < b.createdAt ? -1 : a.createdAt > b.createdAt ? 1 : 0));
  }
  function entry(ctx, id) {
    const e = db.prepare('SELECT * FROM year_end_entries WHERE id = ?').get(id);
    if (!e || !ctx.access.branchAllowed(e.branch_id)) fail(404, 'NOT_FOUND', 'المستند غير موجود');
    const base = ledger.baseCurrency().code;
    const lines = db.prepare(`SELECT l.*, a.code account_code, a.name_ar account_ar, a.name_en account_en, cc.code cc_code, cu.code currency_code FROM year_end_lines l
      JOIN accounts a ON a.id = l.account_id JOIN currencies cu ON cu.id = l.currency_id LEFT JOIN cost_centers cc ON cc.id = l.cost_center_id WHERE l.entry_id = ? ORDER BY l.line_no`).all(id);
    const y = yearRow(e.closing_year_id); const b = branchRow(e.branch_id);
    const reverses = e.reverses_id ? db.prepare('SELECT id, number FROM year_end_entries WHERE id = ?').get(e.reverses_id) : null;
    const reversedBy = db.prepare("SELECT id, number, reason FROM year_end_entries WHERE reverses_id = ? AND status = 'posted'").get(e.id) || null;
    const sum = (k) => D.canonical(D.sum(lines.map((l) => l[k]).concat(['0'])));
    return { id: e.id, kind: e.kind, isReversal: e.is_reversal === 1, reason: e.reason, status: e.status, number: e.number, date: e.entry_date,
      closingYear: { id: y.id, code: y.code }, branch: { id: b.id, code: b.code, nameAr: b.name_ar, nameEn: b.name_en }, description: e.description,
      closingId: e.closing_id, carryForwardId: e.carry_forward_id, reverses, reversedBy, baseCurrency: base,
      postedBy: userName(e.posted_by), postedAt: e.posted_at, totalBase: e.total_base,
      totals: { debit: sum('debit'), credit: sum('credit'), debitText: D.format(sum('debit'), 'amount', base), creditText: D.format(sum('credit'), 'amount', base) },
      lines: lines.map((l) => ({ lineNo: l.line_no, accountId: l.account_id, accountCode: l.account_code, accountNameAr: l.account_ar, accountNameEn: l.account_en,
        costCenterCode: l.cc_code, currency: l.currency_code, rate: l.rate, basis: l.basis, debitFc: l.debit_fc, creditFc: l.credit_fc, debit: l.debit, credit: l.credit,
        debitFcText: D.format(l.debit_fc, 'amount', l.currency_code), creditFcText: D.format(l.credit_fc, 'amount', l.currency_code),
        debitText: D.format(l.debit, 'amount', base), creditText: D.format(l.credit, 'amount', base) })) };
  }

  // ── الإعدادات ──
  function getSettings() {
    const s = settingsRow();
    return { retainedEarningsAccountId: s.retained_earnings_account_id, retainedEarningsAccount: s.retained_earnings_account_id ? accountLabel(s.retained_earnings_account_id) : null,
      issues: s.retained_earnings_account_id ? reAccountIssues(s.retained_earnings_account_id) : [], warnings: reAccountWarnings(s.retained_earnings_account_id),
      lockedBy: partialYears().map((y) => y.code), updatedBy: userName(s.updated_by), updatedAt: s.updated_at };
  }
  function updateSettings(ctx, body) {
    const id = Number(body.retainedEarningsAccountId);
    if (!Number.isSafeInteger(id) || id <= 0) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { retainedEarningsAccountId: 'REQUIRED' } });
    return inTransaction(db, () => {
      const issues = reAccountIssues(id);
      if (issues.length) fail(409, 'RE_ACCOUNT_INVALID', 'الحساب لا يصلح حسابًا لنتيجة السنة', { reasons: issues.map((i) => i.reason) });
      const partial = partialYears();
      const old = settingsRow().retained_earnings_account_id;
      if (old !== id && partial.length) fail(409, 'CLOSING_IN_PROGRESS', 'لا يتغير حساب النتيجة وسنة مُقفلة لبعض الفروع دون بعض', { years: partial.map((y) => y.code) });
      if (old !== id) {
        db.prepare("UPDATE year_end_settings SET retained_earnings_account_id = ?, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1").run(id, ctx.user.id);
        audit.fromCtx(ctx, { action: 'year_end.settings_updated', source: 'year-end', entityType: 'year_end_settings', entityId: 1, details: {
          retainedEarningsAccount: { from: old ? (accountLabel(old) || {}).code : null, to: accountLabel(id).code } } });
      }
      return getSettings();
    });
  }

  // ── السلامة: تُضاف إلى ledger.integrity() ──
  function integrityProblems() {
    const problems = [];
    for (const r of db.prepare("SELECT id FROM year_end_entries WHERE status = 'pending'").all()) problems.push({ type: 'PENDING_YEAR_END_ENTRY', entryId: r.id });
    for (const r of db.prepare(`SELECT e.id, e.number FROM year_end_entries e WHERE e.status = 'posted' AND (SELECT count(*) FROM year_end_lines l WHERE l.entry_id = e.id)
        <> (SELECT count(*) FROM gl_entries g WHERE g.source_type = CASE e.kind WHEN 'closing' THEN 'year_closing' ELSE 'carry_forward' END AND g.source_id = e.id)`).all()) {
      problems.push({ type: 'LEDGER_MISMATCH', yearEndEntryId: r.id, number: r.number });
    }
    for (const c of db.prepare("SELECT c.*, y.end_date FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id WHERE c.status = 'active'").all()) {
      if (balances(c.branch_id, c.end_date, 'income_statement').length) problems.push({ type: 'CLOSED_YEAR_INCOME_NOT_ZERO', closingId: c.id });
    }
    for (const f of db.prepare("SELECT * FROM carry_forwards WHERE status = 'active'").all()) {
      const orig = originalOf('carry_forward_id', f.id);
      const rec = reconcile(yearRow(f.from_year_id), f.branch_id, cfLinesOf(orig && orig.id));
      if (!rec.ok || rec.hash !== f.reconciliation_hash) problems.push({ type: 'CARRY_FORWARD_MISMATCH', carryForwardId: f.id });
    }
    return problems;
  }

  return {
    yearClosed, requiredBranchIds, activeClosing, activeCarry, closedCovering, balances, computeClosing, computeCarry, reconcile, cfLinesOf, originalOf,
    check: (ctx, body) => plan(ctx, body, { withLines: false }), preview: (ctx, body) => plan(ctx, body, { withLines: true }),
    close, carryForward, reopen, revertCarry, status, history, entry, getSettings, updateSettings, integrityProblems, nextYearOf, prevYearOf, yearRow,
  };
}

module.exports = { createYearEnd };

'use strict';
const { HttpError, DecimalError } = require('../../core/errors');
const { inTransaction } = require('../../core/db');

/**
 * محرك الترحيل — services.ledger.post(): النقطة المركزية الوحيدة للكتابة في الأستاذ العام (gl_entries).
 *
 * معاملة واحدة (BEGIN IMMEDIATE) تشمل: التحقق، المبالغ الأساسية، إصدار الرقم، حفظ المستند (persist)، الأستاذ، التدقيق.
 * أي فشل ⇒ لا شيء يُحفظ ولا رقم يُستهلك. القاعدة تعيد فحص القواعد نفسها بـ triggers (الدفاع الثاني).
 *
 * لا ثقة بما فُحص عند الحفظ: كل مبلغ وسعر يُقرأ كما هو مخزن ويمر بـ decimal.fromStorage (يرفض غير القانوني)
 * ثم يُتحقق من الموجب والطرف الواحد ودقة الاعتماد — حتى لو دخلت قيمة بتجاوز CHECK (PRAGMA ignore_check_constraints).
 *
 * المبالغ الأساسية: السطور تُجمَّع حسب (العملة، السعر، الطرف)؛ مجموع كل مجموعة يُحوَّل مرة واحدة بسياسة العملة الأساسية
 * ثم يُوزَّع على سطورها بـ decimal.allocate (أكبر الباقي، حتمي). الاتزان بالعملة الأساسية بالضبط بلا هامش؛
 * والقيد بعملة واحدة يتزن بها أيضًا. الفرق الحقيقي لا يُسوّى آليًا: يُرفض الترحيل ويُعرض الفرق.
 */
const pad2 = (n) => String(n).padStart(2, '0');
/** تاريخ اليوم المحلي للجهاز (للتحقق من التاريخ المستقبلي فقط). */
const localToday = () => { const d = new Date(); return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; };

function createLedger(services, { today = localToday } = {}) {
  const { db, decimal: D, audit } = services;
  const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };

  function baseCurrency() {
    services.currencies.ensureBase();
    const code = services.currencies.baseCode();
    const row = code ? services.currencies.byCode(code) : null;
    if (!row) fail(409, 'NO_BASE_CURRENCY', 'العملة الأساسية غير معرّفة');
    return row;
  }

  /** قيمة مخزنة: الشكل القانوني فقط، غير سالبة، وبدقة الاعتماد لعملتها (لا تقريب صامت). */
  function stored(text, kind, currency, where) {
    let v;
    try {
      if (typeof text !== 'string') throw new DecimalError('CORRUPT_VALUE', 'not text');
      v = D.fromStorage(text, kind);
    } catch (e) {
      if (e instanceof DecimalError) fail(409, 'INVALID_AMOUNT', 'قيمة عشرية غير صالحة في السطر', { ...where, reason: e.code });
      throw e;
    }
    if (D.isNegative(v)) fail(409, 'INVALID_AMOUNT', 'قيمة سالبة في السطر', { ...where, reason: 'NEGATIVE' });
    if (kind === 'amount' && !D.eq(D.commit(v, 'amount', currency), v)) fail(409, 'TOO_PRECISE', 'خانات عشرية أكثر من دقة اعتماد العملة', where);
    return v;
  }

  /** يغلف أخطاء الخدمات القائمة (assertPostable/assertUsable) برقم السطر. */
  function atLine(lineNo, fn) {
    try { return fn(); } catch (e) {
      if (e instanceof HttpError) throw new HttpError(e.status, e.code, e.message, { ...(e.details || {}), line: lineNo });
      throw e;
    }
  }

  /**
   * القيد العكسي (origin = 'reversal') معفى فقط مما قد يتغير بعد ترحيل الأصل: الحساب/المركز/العملة نشط،
   * allow_manual_entry، سياسة مركز التكلفة الحالية، وسريان سطر السعر (السعر منسوخ من الأصل). لا إعفاء من:
   * الحساب تفصيلي، الفترة مفتوحة، نطاق الفرع، الاتزان، وصحة القيم.
   */
  function checkLine(ctx, doc, l, base, origin) {
    const where = { line: l.lineNo };
    if (origin === 'reversal') return checkReversalLine(doc, l, base, where);
    // الحساب: تفصيلي نشط (خدمة دليل الحسابات نفسها)، ويقبل القيد اليدوي/الافتتاحي
    const acc = atLine(l.lineNo, () => services.accounts.assertPostable(l.accountId, ctx));
    if (acc.allow_manual_entry !== 1) fail(409, 'MANUAL_ENTRY_NOT_ALLOWED', 'الحساب حساب مراقبة لا يقبل قيدًا يدويًا', { ...where, account: acc.code });
    // مركز التكلفة: سياسة الحساب، نشط وتفصيلي وضمن النطاق، وفرعه (إن وُجد) = فرع القيد
    if (acc.cost_center_policy === 'required' && l.costCenterId == null) fail(409, 'COST_CENTER_REQUIRED', 'مركز التكلفة إلزامي لهذا الحساب', { ...where, account: acc.code });
    if (acc.cost_center_policy === 'none' && l.costCenterId != null) fail(409, 'COST_CENTER_NOT_ALLOWED', 'هذا الحساب لا يقبل مركز تكلفة', { ...where, account: acc.code });
    if (l.costCenterId != null) {
      const cc = atLine(l.lineNo, () => services.costCenters.assertUsable(l.costCenterId, ctx));
      if (cc.branch_id != null && cc.branch_id !== doc.branchId) fail(409, 'COST_CENTER_BRANCH', 'مركز التكلفة يتبع فرعًا آخر', { ...where, costCenter: cc.code });
    }
    // العملة والسعر
    const cur = services.currencies.byId(l.currencyId);
    if (!cur) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { currencyId: 'NOT_FOUND' }, ...where });
    if (cur.is_active !== 1) fail(409, 'CURRENCY_INACTIVE', 'العملة معطّلة', { ...where, currency: cur.code });
    const rate = stored(l.rate, 'fx_rate', null, { ...where, field: 'rate' });
    if (!D.gt(rate, '0')) fail(409, 'INVALID_AMOUNT', 'سعر الصرف يجب أن يكون موجبًا', { ...where, field: 'rate' });
    const isBase = cur.id === base.id;
    if (isBase !== (l.rateSource === 'base')) fail(409, 'RATE_SOURCE_INVALID', 'مصدر السعر لا يطابق العملة', { ...where, rateSource: l.rateSource });
    if (l.rateSource === 'base' && l.rate !== '1') fail(409, 'RATE_SOURCE_INVALID', 'سعر العملة الأساسية 1 دائمًا', where);
    if (l.rateSource === 'table') {
      // السعر لحظة الترحيل = الساري في تاريخ القيد (رأس سلسلته غير الملغى) بنفس قيمته
      const x = db.prepare('SELECT * FROM exchange_rates WHERE id = ?').get(l.rateId);
      let snap = null;
      if (x && x.currency_id === cur.id) {
        try { snap = services.currencies.rateSnapshot(cur.code, doc.date, x.rate_type); } catch (e) { if (!(e instanceof HttpError)) throw e; }
      }
      if (!snap || snap.rateId !== l.rateId || snap.rate !== l.rate) fail(409, 'RATE_NOT_CURRENT', 'سعر الصرف لم يعد الساري في تاريخ القيد؛ حدّث السطر', { ...where, currency: cur.code, current: snap ? snap.rate : null });
    }
    if (l.rateSource === 'manual') {
      if (!ctx.access.can('journal.override_rate')) fail(403, 'RATE_OVERRIDE_FORBIDDEN', 'السعر اليدوي يتطلب صلاحية تعديل السعر', where);
      if (!l.rateReason || l.rateSetBy == null || !l.rateSetAt) fail(409, 'RATE_SOURCE_INVALID', 'السعر اليدوي بلا سبب أو بلا من أدخله', where);
    }
    // المبالغ: طرف واحد بالضبط، موجب، بدقة عملة السطر
    const debit = stored(l.debitFc, 'amount', cur.code, { ...where, field: 'debit' });
    const credit = stored(l.creditFc, 'amount', cur.code, { ...where, field: 'credit' });
    if (D.isZero(debit) === D.isZero(credit)) fail(409, 'LINE_SIDE', 'السطر يجب أن يكون مدينًا أو دائنًا (طرف واحد بمبلغ موجب)', where);
    return { ...l, currencyCode: cur.code, rateText: l.rate, rate, side: D.isZero(credit) ? 'debit' : 'credit', amount: D.isZero(credit) ? debit : credit };
  }

  /** سطر عكسي: مرآة سطر مرحّل بمبالغه الأساسية المحفوظة (لا تحويل جديد). القاعدة تتحقق من المطابقة التامة (C1–C4). */
  function checkReversalLine(doc, l, base, where) {
    const acc = db.prepare('SELECT id, code, is_group FROM accounts WHERE id = ?').get(l.accountId);
    if (!acc) fail(409, 'NOT_USABLE', 'الحساب غير موجود', { ...where, reason: 'NOT_FOUND' });
    if (acc.is_group === 1) fail(409, 'NOT_USABLE', 'لا يُستخدم الحساب التجميعي في الحركات', { ...where, reason: 'GROUP' });
    const cur = db.prepare('SELECT id, code FROM currencies WHERE id = ?').get(l.currencyId);
    if (!cur) fail(409, 'NOT_USABLE', 'العملة غير موجودة', { ...where, reason: 'NOT_FOUND' });
    const rate = stored(l.rate, 'fx_rate', null, { ...where, field: 'rate' });
    if (!D.gt(rate, '0') || (cur.id === base.id) !== (l.rateSource === 'base')) fail(409, 'RATE_SOURCE_INVALID', 'مصدر السعر لا يطابق العملة', where);
    const debit = stored(l.debitFc, 'amount', cur.code, { ...where, field: 'debit' });
    const credit = stored(l.creditFc, 'amount', cur.code, { ...where, field: 'credit' });
    const bd = stored(l.debit, 'amount', base.code, { ...where, field: 'baseDebit' });
    const bc = stored(l.credit, 'amount', base.code, { ...where, field: 'baseCredit' });
    if (D.isZero(debit) === D.isZero(credit) || D.isZero(bd) !== D.isZero(debit) || D.isZero(bc) !== D.isZero(credit)) fail(409, 'LINE_SIDE', 'سطر عكسي غير صالح', where);
    const side = D.isZero(credit) ? 'debit' : 'credit';
    return { ...l, currencyCode: cur.code, rateText: l.rate, rate, side, amount: side === 'debit' ? debit : credit, base: D.canonical(side === 'debit' ? bd : bc) };
  }

  /**
   * المبالغ الأساسية لكل سطر بالتحويل الجماعي + التوزيع الحتمي. الدالة نفسها تخدم المعاينة (strict = false:
   * السطر الصفري يُعلَّم baseZero بدل الرفض) والترحيل، فلا تختلف المعاينة عن الترحيل أبدًا.
   * lines: [{ lineNo, currencyId, currencyCode, rate (Decimal), side, amount (Decimal) }]
   */
  function baseAmounts(lines, base, { strict = true } = {}) {
    const groups = new Map();
    for (const l of lines) {
      const k = `${l.currencyId}|${D.canonical(l.rate)}|${l.side}`;
      if (!groups.has(k)) groups.set(k, []);
      groups.get(k).push(l);
    }
    for (const g of groups.values()) {
      const total = D.sum(g.map((l) => l.amount));
      const totalBase = D.commit(D.mul(total, g[0].rate), 'amount', base.code);
      const parts = D.allocate(totalBase, g.map((l) => l.amount), 'amount', base.code);
      g.forEach((l, i) => {
        if (D.isZero(parts[i])) {
          if (strict) fail(409, 'BASE_AMOUNT_ZERO', 'المبلغ بالعملة الأساسية لهذا السطر صفر بعد التحويل؛ ادمجه أو عدّل المبلغ', { line: l.lineNo, amount: D.canonical(l.amount), currency: l.currencyCode });
          l.baseZero = true;
        }
        l.base = parts[i];
      });
    }
  }

  /**
   * doc = { sourceType, sourceId, docType, seriesId, entryKind: 'normal'|'opening', origin: 'manual'|'opening'|'reversal',
   *         branchId, date, description, futureDateConfirmed, lines: [{ lineNo, lineId, accountId, costCenterId,
   *         currencyId, rate, rateSource, rateId, rateReason, rateSetBy, rateSetAt, debitFc, creditFc, description }],
   *         persist(result) — يكتب المستند في جداوله داخل المعاملة نفسها قبل الأستاذ }
   */
  function post(ctx, doc) {
    return inTransaction(db, () => {
      if (doc.entryKind === 'closing') fail(409, 'ENTRY_TYPE_NOT_SUPPORTED', 'قيود الإقفال غير متاحة قبل المرحلة 4');
      if (!['manual', 'opening', 'reversal'].includes(doc.origin)) fail(409, 'ENTRY_TYPE_NOT_SUPPORTED', 'نوع الترحيل غير مدعوم في هذه المرحلة');
      const base = baseCurrency();
      // الفرع
      const br = db.prepare('SELECT * FROM branches WHERE id = ?').get(doc.branchId);
      if (!br) fail(404, 'NOT_FOUND', 'الفرع غير موجود');
      ctx.access.assertBranch(br.id);
      if (br.is_active !== 1) fail(409, 'BRANCH_INACTIVE', 'الفرع معطّل');
      // التاريخ والفترة والسنة
      if (doc.date > today() && !doc.futureDateConfirmed) fail(409, 'FUTURE_DATE_NOT_CONFIRMED', 'تاريخ القيد بعد اليوم؛ يلزم تأكيد صريح', { date: doc.date });
      const period = services.fiscal.assertOpen(doc.date);
      const year = db.prepare('SELECT * FROM fiscal_years WHERE id = ?').get(period.fiscalYearId);
      if (doc.origin === 'opening') {
        const first = db.prepare('SELECT min(start_date) d FROM fiscal_years').get().d;
        if (doc.date !== first) fail(409, 'OPENING_DATE', 'القيد الافتتاحي بتاريخ أول يوم من أول سنة مالية فقط', { required: first });
      }
      if (!Array.isArray(doc.lines) || doc.lines.length < 2) fail(409, 'TOO_FEW_LINES', 'القيد يحتاج سطرين على الأقل');

      const lines = doc.lines.map((l) => checkLine(ctx, doc, l, base, doc.origin));
      if (doc.origin !== 'reversal') baseAmounts(lines, base);          // العكسي يحمل المبالغ الأساسية المحفوظة للأصل
      const dr = lines.filter((l) => l.side === 'debit');
      const cr = lines.filter((l) => l.side === 'credit');
      const bal = D.balance(dr.map((l) => l.base), cr.map((l) => l.base));
      if (!bal.balanced) fail(409, 'UNBALANCED', 'القيد غير متزن بالعملة الأساسية', { totalDebit: bal.totalDebit, totalCredit: bal.totalCredit, difference: bal.difference, currency: base.code });
      const currencies = [...new Set(lines.map((l) => l.currencyCode))];
      if (currencies.length === 1) {
        const fc = D.balance(dr.map((l) => l.amount), cr.map((l) => l.amount));
        if (!fc.balanced) fail(409, 'UNBALANCED', 'القيد غير متزن بعملته', { totalDebit: fc.totalDebit, totalCredit: fc.totalCredit, difference: fc.difference, currency: currencies[0] });
      }

      // الرقم: داخل المعاملة نفسها، فيُلغى مع أي فشل لاحق
      const num = services.numbering.issue({ seriesId: doc.seriesId, docType: doc.docType, branchId: br.id, fiscalYearId: year.id, sourceId: doc.sourceId, userId: ctx.user.id });
      const decimalSnapshot = JSON.stringify({
        amount: Object.fromEntries([...new Set([base.code, ...currencies])].map((c) => [c, D.snapshot('amount', c)])),
        fx_rate: D.snapshot('fx_rate'),
      });
      const postedAt = new Date().toISOString();
      const result = {
        number: num.number, seq: num.seq, periodId: period.id, fiscalYearId: year.id, totalBase: bal.totalDebit,
        isMultiCurrency: currencies.length > 1, decimalSnapshot, postedAt, baseCurrency: base.code,
        lines: lines.map((l) => ({ lineId: l.lineId, lineNo: l.lineNo, debit: l.side === 'debit' ? l.base : '0', credit: l.side === 'credit' ? l.base : '0' })),
      };
      doc.persist(result);

      const ins = db.prepare(`INSERT INTO gl_entries (source_type, source_id, source_line_id, doc_number, entry_kind, posting_date, fiscal_period_id, fiscal_year_id,
        branch_id, account_id, cost_center_id, currency_id, rate, rate_source, debit_fc, credit_fc, debit, credit, description, posted_by, posted_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      lines.forEach((l, i) => {
        const b = result.lines[i];
        ins.run(doc.sourceType, doc.sourceId, l.lineId, num.number, doc.entryKind, doc.date, period.id, year.id, br.id, l.accountId, l.costCenterId ?? null,
          l.currencyId, l.rateText, l.rateSource, l.debitFc, l.creditFc, b.debit, b.credit, l.description ?? doc.description, ctx.user.id, postedAt);
      });
      audit.fromCtx(ctx, { action: 'ledger.posted', source: 'journal', entityType: doc.sourceType, entityId: doc.sourceId, details: {
        number: num.number, date: doc.date, branch: br.code, kind: doc.entryKind, totalBase: bal.totalDebit, baseCurrency: base.code, currencies,
        lines: lines.map((l, i) => ({ line: l.lineNo, account: l.accountId, costCenter: l.costCenterId ?? null, currency: l.currencyCode, rate: l.rateText,
          rateSource: l.rateSource, ...(l.rateSource === 'manual' ? { rateReason: l.rateReason, rateSetBy: l.rateSetBy, rateSetAt: l.rateSetAt } : {}),
          debitFc: l.debitFc, creditFc: l.creditFc, debit: result.lines[i].debit, credit: result.lines[i].credit })),
      } });
      return result;
    });
  }

  /**
   * فحص سلامة الأستاذ (كشف، لا منع): كل قيم الأستاذ قانونية، كل مستند مرحّل متزن فيه، الأستاذ يطابق سطور القيود،
   * ولا فجوات ولا تكرار في الأرقام الصادرة، والعدادات = آخر رقم صادر.
   */
  function integrity() {
    const problems = [];
    for (const r of db.prepare('SELECT id, debit_fc, credit_fc, debit, credit, rate FROM gl_entries').iterate()) {
      try { for (const k of ['debit_fc', 'credit_fc', 'debit', 'credit']) D.fromStorage(r[k], 'amount'); D.fromStorage(r.rate, 'fx_rate'); } catch { problems.push({ type: 'CORRUPT_VALUE', glId: r.id }); }
    }
    for (const r of db.prepare(`SELECT source_type, source_id, doc_number FROM gl_entries GROUP BY source_type, source_id
        HAVING dec_cmp(dec_sum(debit), dec_sum(credit)) <> 0`).all()) problems.push({ type: 'UNBALANCED_SOURCE', ...r });
    for (const r of db.prepare(`SELECT e.id, e.number FROM journal_entries e WHERE e.status = 'posted' AND (
        (SELECT count(*) FROM journal_lines l WHERE l.entry_id = e.id) <> (SELECT count(*) FROM gl_entries g WHERE g.source_type = 'journal' AND g.source_id = e.id))`).all()) {
      problems.push({ type: 'LEDGER_MISMATCH', entryId: r.id, number: r.number });
    }
    for (const r of db.prepare("SELECT id FROM journal_entries WHERE status = 'draft' AND entry_type = 'reversal'").all()) problems.push({ type: 'DRAFT_REVERSAL', entryId: r.id });
    for (const r of db.prepare(`SELECT c.series_id, c.branch_key, c.year_key, c.last_value, count(n.id) n, max(n.seq) mx
        FROM document_counters c LEFT JOIN issued_numbers n ON n.series_id = c.series_id AND n.branch_key = c.branch_key AND n.year_key = c.year_key
        GROUP BY c.series_id, c.branch_key, c.year_key`).all()) {
      if (r.n !== r.last_value || r.mx !== r.last_value) problems.push({ type: 'NUMBERING_GAP', ...r });
    }
    return { ok: problems.length === 0, problems };
  }

  return { post, integrity, baseCurrency, baseAmounts, today };
}

module.exports = { createLedger, localToday };

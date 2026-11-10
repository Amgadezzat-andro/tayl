'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { createLedger } = require('./ledger');
const { registerReports } = require('./reports');

/**
 * القيود اليومية والأستاذ العام (المرحلة 3).
 *  - مسودة (بلا رقم: تُنشأ وتُعدَّل وتُحذف) ← ترحيل عبر services.ledger.post() فقط (رقم + أستاذ + قفل نهائي).
 *  - العملة والسعر ومصدره والمبلغ الأصلي على مستوى السطر؛ السعر من الجدول (الساري في تاريخ القيد)
 *    أو يدوي بصلاحية journal.override_rate وسبب إلزامي (يُسجَّل في السطر وفي التدقيق).
 *  - القيد المرحّل يُصحَّح بقيد عكسي فقط (journal.reverse): سطوره يولّدها الخادم مرآة لسطور الأصل بمبالغه المحفوظة.
 *  - الافتتاحي (journal.opening): أول يوم من أول سنة، وقيد فعّال واحد لكل فرع.
 *  - فصل المهام اختياري (إعداد journalSegregatePosting): من أنشأ المسودة أو عدّلها آخر مرة لا يرحّلها.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const DOC_TYPE = { general: 'journal', opening: 'journal_opening', reversal: 'journal_reversal' };
const MAX_LINES = 500;
const vErr = (fields) => new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields });

module.exports = {
  name: 'journal',
  version: '1.1.0',
  dependsOn: ['company-setup', 'security', 'fiscal-years', 'chart-accounts', 'cost-centers', 'currencies', 'numbering'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db, decimal: D, audit } = services;
    services.permissions.register('journal', [
      { resource: 'journal', group: 'accounting', actions: ['view', 'create', 'update', 'delete', 'post', 'print'], special: ['reverse', 'opening', 'override_rate'] },
      { resource: 'ledger', group: 'accounting', actions: ['view', 'print', 'export'] },
    ]);
    const ledger = createLedger(services);
    services.ledger = ledger;

    // سجل الارتباطات: ما يستخدمه قيد (ولو مسودة) لا يُحذف ولا يتغير كوده
    services.usage.register('account', 'journal', (d, id) => !!d.prepare('SELECT 1 FROM journal_lines WHERE account_id = ? LIMIT 1').get(id));
    services.usage.register('cost_center', 'journal', (d, id) => !!d.prepare('SELECT 1 FROM journal_lines WHERE cost_center_id = ? LIMIT 1').get(id));
    services.usage.register('currency', 'journal', (d, id) => !!d.prepare('SELECT 1 FROM journal_lines WHERE currency_id = ? LIMIT 1').get(id));
    services.usage.register('exchange_rate', 'journal', (d, id) => !!d.prepare('SELECT 1 FROM journal_lines WHERE rate_id = ? LIMIT 1').get(id));
    services.usage.register('fiscal_period', 'journal', (d, id) => !!d.prepare('SELECT 1 FROM gl_entries WHERE fiscal_period_id = ? LIMIT 1').get(id));
    // القيود المرحّلة فقط تقفل العملة الأساسية (المسودات لا تقفل شيئًا)
    services.financialActivity.register('journal', (d) => !!d.prepare('SELECT 1 FROM gl_entries LIMIT 1').get());
    // P4: عدد القيود المرحّلة في فترة؛ P6: لا سنة قبل الأولى بعد أول ترحيل
    services.fiscal.registerPeriodActivity('journal', (d, periodId) => d.prepare("SELECT count(*) c FROM journal_entries WHERE fiscal_period_id = ? AND status = 'posted'").get(periodId).c);
    services.fiscal.registerYearGuard((y) => {
      const first = db.prepare('SELECT min(start_date) d FROM fiscal_years').get().d;
      if (first && y.startDate < first && db.prepare('SELECT 1 FROM gl_entries LIMIT 1').get()) {
        throw new HttpError(409, 'FISCAL_YEAR_BEFORE_FIRST', 'بعد أول ترحيل لا تُضاف سنة قبل أول سنة مالية');
      }
    });

    const entryRow = (id) => db.prepare('SELECT * FROM journal_entries WHERE id = ?').get(id);
    const linesOf = (id) => db.prepare(`SELECT l.*, a.code account_code, a.name_ar account_name_ar, a.name_en account_name_en,
        c.code cc_code, c.name_ar cc_name_ar, c.name_en cc_name_en, cu.code currency_code
      FROM journal_lines l JOIN accounts a ON a.id = l.account_id JOIN currencies cu ON cu.id = l.currency_id
      LEFT JOIN cost_centers c ON c.id = l.cost_center_id WHERE l.entry_id = ? ORDER BY l.line_no`).all(id);
    const notFound = () => new HttpError(404, 'NOT_FOUND', 'القيد غير موجود');
    /** خارج نطاق الفروع = غير موجود (لا نكشف وجود القيد). */
    function visibleEntry(ctx, id) {
      const e = entryRow(id);
      if (!e || !ctx.access.branchAllowed(e.branch_id)) throw notFound();
      return e;
    }
    const baseCode = () => ledger.baseCurrency().code;
    const fmt = (x, cur) => D.format(x, 'amount', cur);
    const userName = (id) => (id == null ? null : (db.prepare('SELECT username FROM users WHERE id = ?').get(id) || {}).username || null);
    const lineApi = (l, base) => ({
      id: l.id, lineNo: l.line_no, accountId: l.account_id, accountCode: l.account_code, accountNameAr: l.account_name_ar, accountNameEn: l.account_name_en,
      costCenterId: l.cost_center_id, costCenterCode: l.cc_code, costCenterNameAr: l.cc_name_ar, costCenterNameEn: l.cc_name_en, description: l.description,
      currencyId: l.currency_id, currencyCode: l.currency_code, rate: l.rate, rateSource: l.rate_source, rateId: l.rate_id, tableRate: l.table_rate,
      rateReason: l.rate_reason, rateSetBy: l.rate_set_by, rateSetAt: l.rate_set_at, reversesLineId: l.reverses_line_id,
      debitFc: l.debit_fc, creditFc: l.credit_fc, debit: l.debit, credit: l.credit,
      display: { debitFc: fmt(l.debit_fc, l.currency_code), creditFc: fmt(l.credit_fc, l.currency_code), debit: fmt(l.debit, base), credit: fmt(l.credit, base) },
    });
    function entryApi(e) {
      const base = baseCode();
      const lines = linesOf(e.id).map((l) => lineApi(l, base));
      const reverses = e.reverses_id ? db.prepare('SELECT id, number, entry_date date FROM journal_entries WHERE id = ?').get(e.reverses_id) : null;
      const reversedBy = db.prepare("SELECT id, number, entry_date date, reason FROM journal_entries WHERE reverses_id = ? AND status = 'posted'").get(e.id) || null;
      const br = db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn FROM branches WHERE id = ?').get(e.branch_id);
      const sum = (k) => D.canonical(D.sum(lines.map((l) => l[k])));
      return {
        id: e.id, branchId: e.branch_id, branch: br, entryType: e.entry_type, status: e.status, entryDate: e.entry_date, number: e.number,
        seriesId: e.series_id, defaultCurrencyId: e.default_currency_id, description: e.description, reference: e.reference,
        totalBase: e.total_base, isMultiCurrency: e.is_multi_currency === 1, fiscalPeriodId: e.fiscal_period_id, baseCurrency: base,
        futureDateConfirmed: e.future_date_confirmed === 1, reason: e.reason, reverses, reversedBy,
        createdBy: e.created_by, createdByName: userName(e.created_by), createdAt: e.created_at, updatedBy: e.updated_by, updatedByName: userName(e.updated_by), updatedAt: e.updated_at,
        postedBy: e.posted_by, postedByName: userName(e.posted_by), postedAt: e.posted_at,
        totals: e.status === 'posted' ? { debit: sum('debit'), credit: sum('credit'), debitText: fmt(sum('debit'), base), creditText: fmt(sum('credit'), base) } : null,
        lines,
      };
    }

    // ── بناء السطور: مشترك بين الإنشاء والتعديل والمعاينة، فلا تختلف قواعدها ──
    function parseHeader(body) {
      const v = validator(body)
        .id('branchId').oneOf('entryType', ['general', 'opening']).str('entryDate', { required: true, pattern: DATE_RE })
        .str('description', { required: true, max: 500, multiline: true }).str('reference', { max: 100 })
        .id('defaultCurrencyId').bool('futureDateConfirmed').done();
      if (!validDate(v.entryDate)) throw vErr({ entryDate: 'INVALID' });
      return v;
    }
    function parseLines(body, { min = 2 } = {}) {
      if (!Array.isArray(body.lines) || body.lines.length < min || body.lines.length > MAX_LINES) {
        throw vErr({ lines: Array.isArray(body.lines) && body.lines.length > MAX_LINES ? 'TOO_LONG' : 'TOO_FEW_LINES' });
      }
      return body.lines.map((l, i) => {
        try {
          return validator(l).id('accountId', { required: min > 0 }).id('costCenterId').id('currencyId')
            .decimal('debit').decimal('credit').decimal('rate').str('rateReason', { min: 3, max: 500, multiline: true })
            .str('description', { max: 300 }).done();
        } catch (e) {
          if (e instanceof HttpError && e.details && e.details.fields) throw vErr(Object.fromEntries(Object.entries(e.details.fields).map(([k, c]) => [`lines.${i}.${k}`, c])));
          throw e;
        }
      });
    }
    /** مبلغ مدخل: نص عشري موجب بدقة اعتماد عملة السطر (لا تقريب صامت). */
    function inputAmount(raw, currency, field, i) {
      if (raw == null) return '0';
      const v = D.parse(raw);
      if (D.isNegative(v) || D.isZero(v)) throw vErr({ [`lines.${i}.${field}`]: 'MUST_BE_POSITIVE' });
      const c = D.commit(v, 'amount', currency);
      if (!D.eq(c, v)) throw vErr({ [`lines.${i}.${field}`]: 'TOO_PRECISE' });
      return c;
    }
    /** سطر جاهز للحفظ: العملة، المبلغان، والسعر (أساسي / من الجدول الساري في التاريخ / يدوي بصلاحية وسبب). */
    function buildLine(ctx, l, i, date, base, defaultCur, { checkRefs = true, dropManual = false } = {}) {
      const fld = (k, code) => vErr({ [`lines.${i}.${k}`]: code });
      if (checkRefs) {
        if (!db.prepare('SELECT 1 FROM accounts WHERE id = ?').get(l.accountId)) throw fld('accountId', 'NOT_FOUND');
        if (l.costCenterId != null) {
          // مركز خارج نطاق فروع المستخدم = غير موجود (لا تكشف المسودة بياناته)
          const cc = services.costCenters.byId(l.costCenterId);
          if (!cc || !services.costCenters.visible(ctx, cc)) throw fld('costCenterId', 'NOT_FOUND');
        }
      }
      const cur = l.currencyId ? services.currencies.byId(l.currencyId) : defaultCur;
      if (!cur) throw fld('currencyId', 'NOT_FOUND');
      const debit = inputAmount(l.debit, cur.code, 'debit', i);
      const credit = inputAmount(l.credit, cur.code, 'credit', i);
      if ((debit === '0') === (credit === '0')) throw fld('debit', 'ONE_SIDE_REQUIRED');
      const r = { accountId: l.accountId, costCenterId: l.costCenterId ?? null, description: l.description ?? null, currency: cur, debit, credit,
        rate: '1', source: 'base', rateId: null, tableRate: null, reason: null, setBy: null, setAt: null };
      if (cur.id === base.id) {
        if (l.rate != null) throw fld('rate', 'NOT_ALLOWED');
      } else if (l.rate != null && !dropManual) {
        if (!ctx.access.can('journal.override_rate')) throw new HttpError(403, 'RATE_OVERRIDE_FORBIDDEN', 'السعر اليدوي يتطلب صلاحية تعديل السعر', { line: i + 1 });
        if (!l.rateReason) throw fld('rateReason', 'REQUIRED');
        const x = D.parse(l.rate);
        if (!D.gt(x, '0')) throw fld('rate', 'MUST_BE_POSITIVE');
        const rate = D.commit(x, 'fx_rate');
        if (!D.eq(rate, x)) throw fld('rate', 'TOO_PRECISE');
        try { r.tableRate = services.currencies.rateSnapshot(cur.code, date, 'average').rate; } catch (e) { if (!(e instanceof HttpError)) throw e; }
        Object.assign(r, { rate, source: 'manual', reason: l.rateReason, setBy: ctx.user.id, setAt: new Date().toISOString() });
      } else {
        const snap = services.currencies.rateSnapshot(cur.code, date, 'average');   // 409 NO_RATE إن لم يوجد
        Object.assign(r, { rate: snap.rate, rateId: snap.rateId, source: 'table' });
      }
      return r;
    }
    function insertLines(entryId, built) {
      const ins = db.prepare(`INSERT INTO journal_lines (entry_id, line_no, account_id, cost_center_id, description, currency_id, rate, rate_source,
        rate_id, table_rate, rate_reason, rate_set_by, rate_set_at, debit_fc, credit_fc) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
      return built.map((r, i) => Number(ins.run(entryId, i + 1, r.accountId, r.costCenterId, r.description, r.currency.id, r.rate, r.source,
        r.rateId, r.tableRate, r.reason, r.setBy, r.setAt, r.debit, r.credit).lastInsertRowid));
    }
    function firstYearStart() { return db.prepare('SELECT min(start_date) d FROM fiscal_years').get().d; }
    /** يدقق كل سعر يدوي جديد أو متغير (المستخدم، التوقيت، السعر، المصدر، سعر الجدول، السبب). */
    function auditOverrides(ctx, entryId, built, previous, dateChanged) {
      built.forEach((r, i) => {
        if (r.source !== 'manual') return;
        const p = previous && previous[i];
        if (p && !dateChanged && p.rate_source === 'manual' && p.currency_id === r.currency.id && p.rate === r.rate && p.rate_reason === r.reason) return;
        audit.fromCtx(ctx, { action: 'journal.rate_overridden', source: 'journal', entityType: 'journal_entry', entityId: entryId,
          details: { line: i + 1, currency: r.currency.code, rate: r.rate, tableRate: r.tableRate, reason: r.reason, rateSource: 'manual', setAt: r.setAt } });
      });
    }

    function createDraft(ctx, body) {
      const v = parseHeader(body);
      const raw = parseLines(body);
      const entryType = v.entryType || 'general';
      if (entryType === 'opening' && !ctx.access.can('journal.opening')) throw new HttpError(403, 'FORBIDDEN', 'القيد الافتتاحي يتطلب صلاحية خاصة');
      const branchId = v.branchId || ctx.branchId;
      if (!branchId) throw vErr({ branchId: 'REQUIRED' });
      ctx.access.assertBranch(branchId);
      return inTransaction(db, () => {
        if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(branchId)) throw vErr({ branchId: 'NOT_FOUND' });
        if (entryType === 'opening' && v.entryDate !== firstYearStart()) throw new HttpError(409, 'OPENING_DATE', 'القيد الافتتاحي بتاريخ أول يوم من أول سنة مالية فقط', { required: firstYearStart() });
        const base = ledger.baseCurrency();
        const defaultCur = v.defaultCurrencyId ? services.currencies.byId(v.defaultCurrencyId) : base;
        if (!defaultCur) throw vErr({ defaultCurrencyId: 'NOT_FOUND' });
        const built = raw.map((l, i) => buildLine(ctx, l, i, v.entryDate, base, defaultCur));
        const series = services.numbering.seriesFor(DOC_TYPE[entryType]);
        const id = Number(db.prepare(`INSERT INTO journal_entries (branch_id, entry_type, entry_date, series_id, default_currency_id, description, reference,
          future_date_confirmed, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(branchId, entryType, v.entryDate, series.id, defaultCur.id, v.description, v.reference ?? null, v.futureDateConfirmed ? 1 : 0, ctx.user.id, ctx.user.id).lastInsertRowid);
        insertLines(id, built);
        audit.fromCtx(ctx, { action: 'journal_entry.created', source: 'journal', entityType: 'journal_entry', entityId: id,
          details: { entryType, date: v.entryDate, branchId, lines: built.length } });
        auditOverrides(ctx, id, built, null, false);
        return entryApi(entryRow(id));
      });
    }

    /** تعديل المسودة: استبدال الرأس والسطور كاملة (نوع القيد ثابت). السعر من الجدول يُعاد حسابه لتاريخ المسودة الجديد. */
    function updateDraft(ctx, id, body) {
      const v = parseHeader(body);
      const raw = parseLines(body);
      return inTransaction(db, () => {
        const e = visibleEntry(ctx, id);
        if (e.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'القيد المرحّل لا يُعدَّل؛ استخدم القيد العكسي');
        if (e.entry_type === 'reversal') throw new HttpError(409, 'ENTRY_TYPE_NOT_SUPPORTED', 'القيد العكسي لا يُعدَّل');
        if (v.entryType && v.entryType !== e.entry_type) throw vErr({ entryType: 'LOCKED' });
        if (e.entry_type === 'opening' && !ctx.access.can('journal.opening')) throw new HttpError(403, 'FORBIDDEN', 'القيد الافتتاحي يتطلب صلاحية خاصة');
        if (e.entry_type === 'opening' && v.entryDate !== firstYearStart()) throw new HttpError(409, 'OPENING_DATE', 'القيد الافتتاحي بتاريخ أول يوم من أول سنة مالية فقط', { required: firstYearStart() });
        const branchId = v.branchId || e.branch_id;
        ctx.access.assertBranch(branchId);
        if (!db.prepare('SELECT 1 FROM branches WHERE id = ?').get(branchId)) throw vErr({ branchId: 'NOT_FOUND' });
        const base = ledger.baseCurrency();
        const defaultCur = v.defaultCurrencyId ? services.currencies.byId(v.defaultCurrencyId) : services.currencies.byId(e.default_currency_id);
        if (!defaultCur) throw vErr({ defaultCurrencyId: 'NOT_FOUND' });
        const previous = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no').all(id);
        // المقترح 6.3: تغيير التاريخ أو عملة السطر يُسقط السعر اليدوي (يعود سعر الجدول) ما لم يُعَد تأكيده صراحة بسببه
        const reconfirm = body.reconfirmManualRates === true;
        const built = raw.map((l, i) => {
          const curId = l.currencyId || defaultCur.id;
          const p = previous[i];
          const carried = !!(p && p.rate_source === 'manual' && (v.entryDate !== e.entry_date || p.currency_id !== curId));
          return buildLine(ctx, l, i, v.entryDate, base, defaultCur, { dropManual: carried && !reconfirm });
        });
        const changes = {};
        for (const [k, col, val] of [['branchId', 'branch_id', branchId], ['entryDate', 'entry_date', v.entryDate], ['description', 'description', v.description],
          ['reference', 'reference', v.reference ?? null], ['defaultCurrencyId', 'default_currency_id', defaultCur.id], ['futureDateConfirmed', 'future_date_confirmed', v.futureDateConfirmed ? 1 : 0]]) {
          if (e[col] !== val) changes[k] = { from: e[col], to: val };
        }
        db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(id);
        insertLines(id, built);
        db.prepare(`UPDATE journal_entries SET branch_id = ?, entry_date = ?, description = ?, reference = ?, default_currency_id = ?, future_date_confirmed = ?,
          updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
          .run(branchId, v.entryDate, v.description, v.reference ?? null, defaultCur.id, v.futureDateConfirmed ? 1 : 0, ctx.user.id, id);
        audit.fromCtx(ctx, { action: 'journal_entry.updated', source: 'journal', entityType: 'journal_entry', entityId: id,
          details: { changes, lines: { from: previous.length, to: built.length } } });
        auditOverrides(ctx, id, built, previous, !!changes.entryDate);
        return entryApi(entryRow(id));
      });
    }

    function deleteDraft(ctx, id) {
      return inTransaction(db, () => {
        const e = visibleEntry(ctx, id);
        if (e.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'القيد المرحّل لا يُحذف؛ استخدم القيد العكسي');
        if (e.entry_type === 'opening' && !ctx.access.can('journal.opening')) throw new HttpError(403, 'FORBIDDEN', 'القيد الافتتاحي يتطلب صلاحية خاصة');
        db.prepare('DELETE FROM journal_entries WHERE id = ?').run(id);
        audit.fromCtx(ctx, { action: 'journal_entry.deleted', source: 'journal', entityType: 'journal_entry', entityId: id, details: { date: e.entry_date, description: e.description, entryType: e.entry_type } });
        return { ok: true };
      });
    }

    const toEngineLine = (l) => ({
      lineNo: l.line_no, lineId: l.id, accountId: l.account_id, costCenterId: l.cost_center_id, description: l.description,
      currencyId: l.currency_id, rate: l.rate, rateSource: l.rate_source, rateId: l.rate_id,
      rateReason: l.rate_reason, rateSetBy: l.rate_set_by, rateSetAt: l.rate_set_at, debitFc: l.debit_fc, creditFc: l.credit_fc, debit: l.debit, credit: l.credit,
    });
    /** persist: يكتب نتيجة الترحيل في القيد داخل معاملة المحرك نفسها (قبل الأستاذ). */
    const persistInto = (ctx, entryId) => (r) => {
      const setBase = db.prepare('UPDATE journal_lines SET debit = ?, credit = ? WHERE id = ?');
      for (const b of r.lines) setBase.run(b.debit, b.credit, b.lineId);
      db.prepare(`UPDATE journal_entries SET status = 'posted', number = ?, fiscal_period_id = ?, decimal_snapshot = ?, total_base = ?,
        is_multi_currency = ?, posted_by = ?, posted_at = ?, updated_at = ? WHERE id = ?`)
        .run(r.number, r.periodId, r.decimalSnapshot, r.totalBase, r.isMultiCurrency ? 1 : 0, ctx.user.id, r.postedAt, r.postedAt, entryId);
    };
    function effectiveOpening(branchId, exceptId) {
      return db.prepare(`SELECT id, number FROM journal_entries o WHERE o.entry_type = 'opening' AND o.status = 'posted' AND o.branch_id = ? AND o.id <> ?
        AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = o.id AND r.status = 'posted')`).get(branchId, exceptId);
    }

    /** الترحيل: يقرأ المسودة كما هي مخزنة ويمررها لمحرك الترحيل. */
    function postEntry(ctx, id) {
      return inTransaction(db, () => {
        const e = visibleEntry(ctx, id);
        if (e.status !== 'draft') throw new HttpError(409, 'NOT_DRAFT', 'القيد مرحّل من قبل');
        if (e.entry_type === 'reversal') throw new HttpError(409, 'ENTRY_TYPE_NOT_SUPPORTED', 'القيد العكسي يُرحَّل من شاشة العكس فقط');
        if (e.entry_type === 'opening') {
          if (!ctx.access.can('journal.opening')) throw new HttpError(403, 'FORBIDDEN', 'القيد الافتتاحي يتطلب صلاحية خاصة');
          const other = effectiveOpening(e.branch_id, e.id);
          if (other) throw new HttpError(409, 'OPENING_EXISTS', 'يوجد قيد افتتاحي مرحّل لهذا الفرع؛ اعكسه أولًا لتصحيحه', { number: other.number, id: other.id });
        }
        if (services.settings.get().journalSegregatePosting === 1 && (e.created_by === ctx.user.id || e.updated_by === ctx.user.id)) {
          throw new HttpError(409, 'SEGREGATION_REQUIRED', 'فصل المهام مفعّل: يرحّل القيد مستخدم غير من أنشأه أو عدّله');
        }
        // سلسلة المسودة عُطّلت بعد إنشائها ⇒ السلسلة الافتراضية الحالية لنوعها (لا رقم صدر للمسودة بعد)
        let seriesId = e.series_id;
        if (!db.prepare('SELECT is_active FROM document_series WHERE id = ?').get(seriesId).is_active) {
          seriesId = services.numbering.seriesFor(DOC_TYPE[e.entry_type]).id;
          db.prepare('UPDATE journal_entries SET series_id = ? WHERE id = ?').run(seriesId, e.id);
        }
        ledger.post(ctx, {
          sourceType: 'journal', sourceId: e.id, docType: DOC_TYPE[e.entry_type], seriesId,
          entryKind: e.entry_type === 'opening' ? 'opening' : 'normal', origin: e.entry_type === 'opening' ? 'opening' : 'manual',
          branchId: e.branch_id, date: e.entry_date, description: e.description, futureDateConfirmed: e.future_date_confirmed === 1,
          lines: db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no').all(e.id).map(toEngineLine),
          persist: persistInto(ctx, e.id),
        });
        return entryApi(entryRow(id));
      });
    }

    /**
     * القيد العكسي: من قيد مرحّل غير معكوس وليس عكسيًا، بسبب إلزامي. الخادم يولّد سطرًا لكل سطر في الأصل
     * (الطرفان متبادلان، والعملة والسعر ومصدره والمبالغ الأصلية والأساسية ومركز التكلفة منسوخة كما هي)،
     * ثم يرحّله عبر المحرك في المعاملة نفسها. تاريخه تاريخ الأصل إن كانت فترته مفتوحة، وإلا تاريخ يختاره المستخدم (لا قبل الأصل).
     */
    function reverseEntry(ctx, id, body) {
      const v = validator(body).str('reason', { required: true, min: 3, max: 500, multiline: true }).str('date', { pattern: DATE_RE }).bool('confirmFutureDate').done();
      if (v.date != null && !validDate(v.date)) throw vErr({ date: 'INVALID' });
      return inTransaction(db, () => {
        const e = visibleEntry(ctx, id);
        if (e.status !== 'posted') throw new HttpError(409, 'NOT_POSTED', 'لا يُعكس إلا قيد مرحّل');
        if (e.entry_type === 'reversal') throw new HttpError(409, 'REVERSAL_NOT_REVERSIBLE', 'القيد العكسي لا يُعكس؛ أدخل قيدًا جديدًا');
        if (e.entry_type === 'opening' && !ctx.access.can('journal.opening')) throw new HttpError(403, 'FORBIDDEN', 'عكس القيد الافتتاحي يتطلب صلاحية القيود الافتتاحية');
        const done = db.prepare("SELECT id, number FROM journal_entries WHERE reverses_id = ? AND status = 'posted'").get(e.id);
        if (done) throw new HttpError(409, 'ALREADY_REVERSED', 'القيد معكوس من قبل', { id: done.id, number: done.number });
        let date = v.date;
        if (!date) {
          const p = services.fiscal.periodFor(e.entry_date);
          if (!p || p.status !== 'open') throw new HttpError(409, 'REVERSAL_DATE_REQUIRED', 'فترة القيد الأصلي غير مفتوحة؛ اختر تاريخًا في فترة مفتوحة', { originalDate: e.entry_date, periodStatus: p ? p.status : null });
          date = e.entry_date;
        }
        if (date < e.entry_date) throw vErr({ date: 'BEFORE_ORIGINAL' });
        const series = services.numbering.seriesFor(DOC_TYPE.reversal);
        const revId = Number(db.prepare(`INSERT INTO journal_entries (branch_id, entry_type, entry_date, series_id, default_currency_id, description, reference,
          future_date_confirmed, created_by, updated_by, reverses_id, reason) VALUES (?, 'reversal', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(e.branch_id, date, series.id, e.default_currency_id, e.description, e.number, v.confirmFutureDate ? 1 : 0, ctx.user.id, ctx.user.id, e.id, v.reason).lastInsertRowid);
        const mirror = db.prepare(`INSERT INTO journal_lines (entry_id, line_no, account_id, cost_center_id, description, currency_id, rate, rate_source, rate_id,
          table_rate, rate_reason, rate_set_by, rate_set_at, debit_fc, credit_fc, debit, credit, reverses_line_id)
          SELECT ?, line_no, account_id, cost_center_id, description, currency_id, rate, rate_source, rate_id, table_rate, rate_reason, rate_set_by, rate_set_at,
            credit_fc, debit_fc, credit, debit, id FROM journal_lines WHERE entry_id = ? ORDER BY line_no`);
        mirror.run(revId, e.id);
        const r = ledger.post(ctx, {
          sourceType: 'journal', sourceId: revId, docType: DOC_TYPE.reversal, seriesId: series.id,
          entryKind: e.entry_type === 'opening' ? 'opening' : 'normal', origin: 'reversal',
          branchId: e.branch_id, date, description: e.description, futureDateConfirmed: v.confirmFutureDate === true,
          lines: db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no').all(revId).map(toEngineLine),
          persist: persistInto(ctx, revId),
        });
        audit.fromCtx(ctx, { action: 'journal_entry.reversed', source: 'journal', entityType: 'journal_entry', entityId: e.id,
          details: { original: e.number, reversal: r.number, reversalId: revId, date, reason: v.reason } });
        return entryApi(entryRow(revId));
      });
    }

    /** قائمة القيود (المستندات: مسودات ومرحّلة) ضمن نطاق الفروع، بتصفية وترقيم. */
    function list(ctx, q) {
      const f = ctx.access.sqlFilter('e.branch_id', q.branch);
      const w = [f.sql]; const p = [...f.params];
      if (['draft', 'posted'].includes(q.status)) { w.push('e.status = ?'); p.push(q.status); }
      if (q.status === 'reversed') w.push("EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = e.id AND r.status = 'posted')");
      if (['general', 'opening', 'reversal'].includes(q.type)) { w.push('e.entry_type = ?'); p.push(q.type); }
      if (validDate(q.from)) { w.push('e.entry_date >= ?'); p.push(q.from); }
      if (validDate(q.to)) { w.push('e.entry_date <= ?'); p.push(q.to); }
      if (q.q) {
        const like = '%' + String(q.q).slice(0, 80).replace(/[\\%_]/g, (m) => '\\' + m) + '%';
        w.push("(e.number LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\' OR e.reference LIKE ? ESCAPE '\\')"); p.push(like, like, like);
      }
      const limit = Math.min(Math.max(Number.parseInt(q.limit, 10) || 50, 1), 200);
      const offset = Math.max(Number.parseInt(q.offset, 10) || 0, 0);
      const rows = db.prepare(`SELECT e.*, b.code branch_code,
          (SELECT count(*) FROM journal_lines l WHERE l.entry_id = e.id) line_count,
          (SELECT number FROM journal_entries o WHERE o.id = e.reverses_id) reverses_number,
          (SELECT r.id FROM journal_entries r WHERE r.reverses_id = e.id AND r.status = 'posted') reversed_by_id,
          (SELECT r.number FROM journal_entries r WHERE r.reverses_id = e.id AND r.status = 'posted') reversed_by_number
        FROM journal_entries e JOIN branches b ON b.id = e.branch_id WHERE ${w.join(' AND ')}
        ORDER BY e.entry_date DESC, e.id DESC LIMIT ? OFFSET ?`).all(...p, limit + 1, offset);
      const base = baseCode();
      return {
        items: rows.slice(0, limit).map((e) => ({
          id: e.id, number: e.number, status: e.status, entryType: e.entry_type, entryDate: e.entry_date, branchCode: e.branch_code,
          description: e.description, reference: e.reference, lineCount: e.line_count, totalBase: e.total_base,
          totalText: e.status === 'posted' ? fmt(e.total_base, base) : null,
          reverses: e.reverses_id ? { id: e.reverses_id, number: e.reverses_number } : null,
          reversedBy: e.reversed_by_id ? { id: e.reversed_by_id, number: e.reversed_by_number } : null,
        })),
        hasMore: rows.length > limit,
      };
    }

    /**
     * المعاينة للواجهة (الواجهة لا تحسب أي مبلغ): نفس قواعد السطر ونفس دالة المبالغ الأساسية في المحرك.
     * متسامحة مع السطور غير المكتملة: السطر بلا مبلغ يُتجاهل، وخطأ السطر يُعاد في errors بدل رفض الطلب كله.
     */
    function preview(ctx, body) {
      const v = validator(body).str('entryDate', { required: true, pattern: DATE_RE }).id('defaultCurrencyId').done();
      if (!validDate(v.entryDate)) throw vErr({ entryDate: 'INVALID' });
      const raw = parseLines(body, { min: 0 });
      const base = ledger.baseCurrency();
      const defaultCur = (v.defaultCurrencyId && services.currencies.byId(v.defaultCurrencyId)) || base;
      const errors = []; const ok = [];
      raw.forEach((l, i) => {
        if (l.debit == null && l.credit == null) return;
        try {
          const r = buildLine(ctx, l, i, v.entryDate, base, defaultCur, { checkRefs: false });
          const side = r.debit !== '0' ? 'debit' : 'credit';
          ok.push({ index: i, lineNo: i + 1, currencyId: r.currency.id, currencyCode: r.currency.code, rate: D.parse(r.rate), rateText: r.rate,
            rateSource: r.source, side, amount: D.parse(side === 'debit' ? r.debit : r.credit) });
        } catch (e) {
          if (!(e instanceof HttpError)) throw e;
          errors.push({ index: i, code: e.code, fields: e.details && e.details.fields, details: e.details });
        }
      });
      if (ok.length) ledger.baseAmounts(ok, base, { strict: false });
      const dr = ok.filter((l) => l.side === 'debit').map((l) => l.base);
      const cr = ok.filter((l) => l.side === 'credit').map((l) => l.base);
      const bal = D.balance(dr.length ? dr : ['0'], cr.length ? cr : ['0']);
      const curs = [...new Set(ok.map((l) => l.currencyCode))];
      let fc = null;
      if (curs.length === 1 && curs[0] !== base.code) {
        const f = D.balance(ok.filter((l) => l.side === 'debit').map((l) => l.amount).concat(['0']), ok.filter((l) => l.side === 'credit').map((l) => l.amount).concat(['0']));
        fc = { currency: curs[0], ...f, totalDebitText: fmt(f.totalDebit, curs[0]), totalCreditText: fmt(f.totalCredit, curs[0]), differenceText: fmt(f.difference, curs[0]) };
      }
      return {
        baseCurrency: base.code,
        lines: ok.map((l) => ({ index: l.index, rate: l.rateText, rateSource: l.rateSource, base: l.base, baseText: fmt(l.base, base.code), baseZero: !!l.baseZero, side: l.side })),
        totalDebit: bal.totalDebit, totalCredit: bal.totalCredit, difference: bal.difference, balanced: bal.balanced && ok.length >= 2 && !ok.some((l) => l.baseZero) && (!fc || fc.balanced),
        totalDebitText: fmt(bal.totalDebit, base.code), totalCreditText: fmt(bal.totalCredit, base.code), differenceText: fmt(bal.difference, base.code),
        foreign: fc, currencies: curs, errors,
      };
    }

    services.journal = { createDraft, updateDraft, deleteDraft, postEntry, reverseEntry, list, preview, get: (ctx, id) => entryApi(visibleEntry(ctx, id)) };

    const P = (a) => ({ permission: `journal.${a}` });
    router.get('/api/journal', P('view'), (ctx) => list(ctx, ctx.query));
    router.post('/api/journal', P('create'), async (ctx) => createDraft(ctx, await ctx.body()));
    router.post('/api/journal/preview', { auth: true }, async (ctx) => {
      if (!['journal.create', 'journal.update'].some((x) => ctx.access.can(x))) throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية');
      return preview(ctx, await ctx.body());
    });
    router.get('/api/journal/:id', P('view'), (ctx) => entryApi(visibleEntry(ctx, idParam(ctx.params.id))));
    router.put('/api/journal/:id', P('update'), async (ctx) => updateDraft(ctx, idParam(ctx.params.id), await ctx.body()));
    router.delete('/api/journal/:id', P('delete'), (ctx) => deleteDraft(ctx, idParam(ctx.params.id)));
    router.post('/api/journal/:id/post', P('post'), (ctx) => postEntry(ctx, idParam(ctx.params.id)));
    router.post('/api/journal/:id/reverse', { permission: 'journal.reverse' }, async (ctx) => reverseEntry(ctx, idParam(ctx.params.id), await ctx.body()));
    // فحص السلامة يمس كل الفروع: لصاحب نطاق «جميع الفروع» فقط
    router.get('/api/ledger/integrity', { permission: 'ledger.view' }, (ctx) => {
      if (!ctx.access.allBranches) throw new HttpError(403, 'BRANCH_SCOPE_EXCEEDED', 'فحص السلامة يتطلب نطاق جميع الفروع');
      return ledger.integrity();
    });
    // سند القيد للطباعة: صلاحية journal.print في الخادم
    router.get('/api/journal/:id/print', P('print'), (ctx) => entryApi(visibleEntry(ctx, idParam(ctx.params.id))));
    // P9 + معلومات للواجهة: تحذيرات السنوات المنتهية غير المقفلة، وأول سنة (للقيد الافتتاحي)
    router.get('/api/ledger/status', { auth: true }, (ctx) => {
      if (!['ledger.view', 'journal.view'].some((x) => ctx.access.can(x))) throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية');
      const ended = services.fiscal.endedYears(ledger.today());
      return {
        today: ledger.today(), firstYearStart: firstYearStart(), baseCurrency: baseCode(), segregatePosting: services.settings.get().journalSegregatePosting === 1,
        warnings: ended.map((y) => ({ code: 'YEAR_ENDED_NOT_CLOSED', year: y })),
      };
    });

    registerReports(router, services);
  },
};

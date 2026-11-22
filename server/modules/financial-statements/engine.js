'use strict';
const { HttpError } = require('../../core/errors');

/**
 * القوائم المالية (المرحلة 5): قائمة الدخل، قائمة المركز المالي، قائمة التدفقات النقدية (الطريقة غير المباشرة).
 *
 * المصدر: gl_entries وحده بنفس قواعد التقارير القائمة — كل جمع بـ dec_sum والمحرك العشري، ونطاق الفروع من ctx.access.
 *   - قيود ترحيل الأرصدة (carry_forward) لا تدخل أي رصيد ولا حركة (تساوي ما قبلها بالضبط — قرار المرحلة 4).
 *   - قيود الإقفال وعكسها (year_closing) لا تدخل قائمة الدخل ولا التدفقات (تنقل النتيجة داخل حقوق الملكية فقط)،
 *     وتدخل المركز المالي (الرصيد التراكمي الفعلي)؛ ونتيجة الفترات غير المُقفلة تظهر بندًا مستقلًا في حقوق الملكية،
 *     فالقائمة متزنة قبل الإقفال وبعده وبعد إعادة الفتح.
 *   - التصنيف من هيكل الحسابات الفعلي (التصنيف الأساسي + إعداد النوع/الحساب في fs_*_settings)، لا من أكواد مفترضة.
 *     حساب غير مصنف ⇒ يظهر في بند «غير مصنف» والقائمة «غير مكتملة» (لا طباعة ولا تصدير) — النتيجة الإجمالية تبقى صحيحة.
 *   - كل قائمة تُطابَق مع ميزان المراجعة نفسه (services.ledgerReports.trialBalance) لكل حساب؛ أي فرق يمنع الإصدار.
 */
const IS_LINES = ['revenue', 'cogs', 'operating_expense', 'other_income', 'other_expense'];
const CF_ACTIVITIES = ['cash', 'operating', 'investing', 'financing'];
const INCOME = new Set(['revenue', 'other_income']);
const COMPARE = ['none', 'previous_period', 'same_period_last_year', 'previous_year'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const d2s = (d) => d.toISOString().slice(0, 10);
const addDays = (s, n) => { const d = new Date(s + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d2s(d); };
const days = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000) + 1;
const lastOfMonth = (s) => d2s(new Date(Date.UTC(+s.slice(0, 4), +s.slice(5, 7), 0))) === s;
/** نفس اليوم قبل سنة؛ آخر يوم في الشهر يبقى آخر يوم (29 فبراير ⇄ 28 فبراير). */
function yearBack(s) {
  const y = +s.slice(0, 4) - 1; const m = +s.slice(5, 7);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  const day = lastOfMonth(s) ? last : Math.min(+s.slice(8, 10), last);
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
const vErr = (fields) => new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields });

function createStatements(services) {
  const { db, decimal: D } = services;
  const Z = () => D.parse('0');
  const baseCode = () => services.ledger.baseCurrency().code;
  const fmt = (x) => D.format(x, 'amount', baseCode());

  // ── التصنيف ──
  /** لكل حساب تفصيلي: التصنيف الأساسي والقائمة وبند الدخل ونشاط التدفق ومصدرهما (حساب/نوع/تصنيف/لا شيء). */
  function classification() {
    const rows = db.prepare(`SELECT a.id, a.code, a.name_ar, a.name_en, a.class_code, k.statement, a.type_id, t.code type_code, t.name_ar type_ar, t.name_en type_en,
        ts.is_line t_is, ts.cf_activity t_cf, s.is_line a_is, s.cf_activity a_cf
      FROM accounts a JOIN account_classes k ON k.code = a.class_code LEFT JOIN account_types t ON t.id = a.type_id
      LEFT JOIN fs_type_settings ts ON ts.type_id = a.type_id LEFT JOIN fs_account_settings s ON s.account_id = a.id
      WHERE a.is_group = 0`).all();
    const fits = (cls, line) => (cls === 'revenue' ? INCOME.has(line) : cls === 'cogs' ? line === 'cogs' : cls === 'expense' ? ['operating_expense', 'other_expense'].includes(line) : false);
    const map = new Map();
    for (const r of rows) {
      const c = { id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, classCode: r.class_code, statement: r.statement,
        typeId: r.type_id, typeCode: r.type_code, typeNameAr: r.type_ar, typeNameEn: r.type_en, isLine: null, cfActivity: null, source: null };
      if (r.statement === 'income_statement') {
        if (r.class_code === 'cogs') Object.assign(c, { isLine: 'cogs', source: 'class' });
        else if (r.a_is && fits(r.class_code, r.a_is)) Object.assign(c, { isLine: r.a_is, source: 'account' });
        else if (r.t_is && fits(r.class_code, r.t_is)) Object.assign(c, { isLine: r.t_is, source: 'type' });
      } else if (r.a_cf) Object.assign(c, { cfActivity: r.a_cf, source: 'account' });
      else if (r.t_cf) Object.assign(c, { cfActivity: r.t_cf, source: 'type' });
      map.set(r.id, c);
    }
    return map;
  }

  // ── النطاق والفترة والمقارنة ──
  function scope(ctx, q, { costCenters = false } = {}) {
    const s = ctx.access.scope(q.branch);
    const where = s.all ? '1 = 1' : s.ids.length ? `g.branch_id IN (${s.ids.map(() => '?').join(',')})` : '0 = 1';
    const params = s.all ? [] : s.ids;
    const branches = (s.all ? db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn FROM branches ORDER BY code').all()
      : s.ids.map((id) => db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn FROM branches WHERE id = ?').get(id)).filter(Boolean));
    let cc = [];
    const raw = q.costCenterIds || q.costCenterId;
    if (raw) {
      if (!costCenters) throw new HttpError(400, 'COST_CENTER_NOT_SUPPORTED', 'التحليل بمراكز التكلفة متاح لقائمة الدخل فقط');
      const ids = String(raw).split(',');
      if (ids.length > 50 || !ids.every((x) => /^[1-9]\d{0,15}$/.test(x))) throw vErr({ costCenterIds: 'INVALID' });
      cc = [...new Set(ids.map(Number))].map((id) => {
        const c = services.costCenters.byId(id);
        if (!c || !services.costCenters.visible(ctx, c)) throw vErr({ costCenterIds: 'NOT_FOUND' });
        return { id: c.id, code: c.code, nameAr: c.name_ar, nameEn: c.name_en };
      });
    }
    const ccWhere = cc.length ? ` AND g.cost_center_id IN (${cc.map(() => '?').join(',')})` : '';
    return { all: s.all, where: where + ccWhere, params: [...params, ...cc.map((c) => c.id)], branches, costCenters: cc,
      branchParam: s.all ? 'all' : s.ids.join(','), analytical: cc.length > 0 };
  }
  const periodByRange = (from, to) => db.prepare('SELECT * FROM fiscal_periods WHERE start_date = ? AND end_date = ?').get(from, to);
  const yearByRange = (from, to) => db.prepare('SELECT * FROM fiscal_years WHERE start_date = ? AND end_date = ?').get(from, to);
  const yearContaining = (d) => db.prepare('SELECT * FROM fiscal_years WHERE ? BETWEEN start_date AND end_date').get(d);
  const covered = (from, to) => {
    const r = db.prepare('SELECT min(start_date) s, max(end_date) e, count(*) n FROM fiscal_periods WHERE start_date <= ? AND end_date >= ?').get(to, from);
    return r.n > 0 && r.s <= from && r.e >= to;
  };
  function rangeOf(q) {
    const { from, to } = services.ledgerReports.range(q);
    const kind = yearByRange(from, to) ? 'year' : periodByRange(from, to) ? 'period' : 'custom';
    return { from, to, kind };
  }
  /** فترة المقارنة لنطاق (قائمة الدخل والتدفقات) مع تحذيرات عدم التساوي وعدم التغطية. */
  function compareRange(r, mode) {
    if (!mode || mode === 'none') return null;
    if (!COMPARE.includes(mode)) throw vErr({ compare: 'INVALID' });
    let c;
    if (mode === 'previous_year') {
      if (r.kind !== 'year') throw new HttpError(400, 'COMPARE_NEEDS_FULL_YEAR', 'المقارنة بالسنة السابقة لنطاق سنة مالية كاملة فقط');
      const p = db.prepare('SELECT * FROM fiscal_years WHERE end_date = ?').get(addDays(r.from, -1));
      c = p ? { from: p.start_date, to: p.end_date, label: p.code } : { from: yearBack(r.from), to: addDays(r.from, -1), label: null };
    } else if (mode === 'previous_period') {
      if (r.kind === 'year') {
        const p = db.prepare('SELECT * FROM fiscal_years WHERE end_date = ?').get(addDays(r.from, -1));
        if (p) c = { from: p.start_date, to: p.end_date, label: p.code };
      } else if (r.kind === 'period') {
        const p = db.prepare('SELECT * FROM fiscal_periods WHERE end_date = ?').get(addDays(r.from, -1));
        if (p) c = { from: p.start_date, to: p.end_date, label: null };
      }
      if (!c) { const n = days(r.from, r.to); c = { from: addDays(r.from, -n), to: addDays(r.from, -1), label: null }; }
    } else c = { from: yearBack(r.from), to: yearBack(r.to), label: null };
    const warnings = [];
    if (days(c.from, c.to) !== days(r.from, r.to)) warnings.push({ code: 'UNEQUAL_PERIODS', currentDays: days(r.from, r.to), comparativeDays: days(c.from, c.to) });
    if (!covered(c.from, c.to)) warnings.push({ code: 'COMPARATIVE_NOT_COVERED' });
    return { mode, ...c, warnings };
  }
  /** تاريخ المقارنة لقائمة المركز المالي. */
  function compareDate(asOf, mode) {
    if (!mode || mode === 'none') return null;
    if (!COMPARE.includes(mode)) throw vErr({ compare: 'INVALID' });
    let d;
    if (mode === 'same_period_last_year') d = yearBack(asOf);
    else if (mode === 'previous_year') { const y = yearContaining(asOf); d = y ? addDays(y.start_date, -1) : yearBack(asOf); }
    else { const p = db.prepare('SELECT * FROM fiscal_periods WHERE ? BETWEEN start_date AND end_date').get(asOf); d = p ? addDays(p.start_date, -1) : addDays(asOf, -1); }
    const warnings = covered(d, d) ? [] : [{ code: 'COMPARATIVE_NOT_COVERED' }];
    return { mode, asOf: d, warnings };
  }

  // ── التجميع من الأستاذ ──
  const NOT_CF = "g.source_type <> 'carry_forward'";
  /** صافي (مدين − دائن) لكل حساب [ولكل بُعد] في نطاق؛ dim: null | 'branch' | 'cost_center'. */
  function sums(sc, cond, params, dim = null) {
    const dcol = dim === 'branch' ? 'g.branch_id' : dim === 'cost_center' ? 'g.cost_center_id' : 'NULL';
    const out = new Map();
    for (const r of db.prepare(`SELECT g.account_id id, ${dcol} dim, dec_sum(g.debit) d, dec_sum(g.credit) c FROM gl_entries g
        WHERE ${sc.where} AND ${cond} GROUP BY g.account_id, dim`).iterate(...sc.params, ...params)) {
      const k = dim ? String(r.dim ?? 'none') : 'total';
      if (!out.has(k)) out.set(k, new Map());
      out.get(k).set(r.id, D.sub(r.d, r.c));
    }
    return out;
  }
  const isRange = "g.posting_date BETWEEN ? AND ? AND g.source_type NOT IN ('year_closing', 'carry_forward')";

  // ── بناء الأعمدة والفروق ──
  const cell = (v) => ({ value: D.canonical(v), text: fmt(v) });
  function diffCells(cur, cmp) {
    const diff = D.sub(cur, cmp);
    // النسبة = الفرق × 100 ÷ |المقارن| (الضرب أولًا بلا فقد، ثم القسمة وتقريب الاعتماد لنوع rate)؛ مقارن صفري = بلا نسبة
    const pct = D.isZero(cmp) ? null : D.commit(D.div(D.mul(diff, '100'), D.abs(cmp)), 'rate');
    return { difference: cell(diff), percent: pct === null ? null : { value: D.canonical(pct), text: D.formatPercent(pct) },
      trend: D.isZero(diff) ? 'flat' : D.isNegative(diff) ? 'down' : 'up' };
  }
  /** صف: القيم لكل عمود + فرق ونسبة عند المقارنة. */
  function rowValues(vals, cmpMode) {
    const r = { values: vals.map(cell) };
    if (cmpMode) Object.assign(r, diffCells(vals[0], vals[1]));
    return r;
  }

  /** حالة الإصدار: مكتملة التصنيف، متطابقة مع الميزان، (متزنة للمركز المالي)، ونهائية حسب الفترات. */
  function issuance(r) {
    const blockers = [];
    if (!r.complete) blockers.push('STATEMENT_INCOMPLETE');
    if (r.balanced === false) blockers.push('STATEMENT_UNBALANCED');
    if (!r.reconciliation.ok) blockers.push('STATEMENT_NOT_RECONCILED');
    return { issuable: blockers.length === 0, blockers };
  }
  const columnsMeta = (cols, cmpMode) => ({ columns: cols.map((c) => ({ key: c.key, label: c.label, from: c.from, to: c.to, asOf: c.asOf })), comparison: cmpMode || null });

  // ── قائمة الدخل ──
  const IS_ORDER = [
    { key: 'revenue', line: 'revenue' }, { key: 'cogs', line: 'cogs' }, { key: 'gross_profit', subtotal: ['revenue', '-cogs'] },
    { key: 'operating_expense', line: 'operating_expense' }, { key: 'operating_profit', subtotal: ['gross_profit', '-operating_expense'] },
    { key: 'other_income', line: 'other_income' }, { key: 'other_expense', line: 'other_expense' },
    { key: 'unclassified', line: null }, { key: 'net_profit', subtotal: ['operating_profit', 'other_income', '-other_expense', 'unclassified'] },
  ];
  function incomeStatement(ctx, q) {
    const r = rangeOf(q);
    const sc = scope(ctx, q, { costCenters: true });
    const breakdown = q.breakdown === 'branch' || q.breakdown === 'cost_center' ? q.breakdown : null;
    const cmp = compareRange(r, q.compare);
    if (breakdown && cmp) throw new HttpError(400, 'BREAKDOWN_WITH_COMPARE', 'التوزيع على أعمدة والمقارنة لا يجتمعان في تقرير واحد');
    const cls = classification();
    const isAcc = (id) => { const c = cls.get(id); return c && c.statement === 'income_statement'; };
    // الأعمدة: الفترة الحالية [+ المقارنة] أو التوزيع [+ الإجمالي]
    let cols;
    if (breakdown) {
      const byDim = sums(sc, isRange, [r.from, r.to], breakdown);
      const keys = [...byDim.keys()].sort();
      if (keys.length > 30) throw new HttpError(409, 'REPORT_TOO_LARGE', 'أعمدة التوزيع أكثر من الحد', { columns: keys.length, max: 30 });
      const label = (k) => {
        if (k === 'none') return { code: '—', none: true };
        const row = breakdown === 'branch' ? db.prepare('SELECT code, name_ar nameAr, name_en nameEn FROM branches WHERE id = ?').get(Number(k))
          : db.prepare('SELECT code, name_ar nameAr, name_en nameEn FROM cost_centers WHERE id = ?').get(Number(k));
        return row;
      };
      cols = keys.map((k) => ({ key: breakdown + ':' + k, label: label(k), from: r.from, to: r.to, amounts: byDim.get(k) }));
      cols.push({ key: 'total', label: null, from: r.from, to: r.to, amounts: (sums(sc, isRange, [r.from, r.to]).get('total') || new Map()) });
    } else {
      cols = [{ key: 'current', label: null, from: r.from, to: r.to, amounts: sums(sc, isRange, [r.from, r.to]).get('total') || new Map() }];
      if (cmp) cols.push({ key: 'comparative', label: cmp.label, from: cmp.from, to: cmp.to, amounts: sums(sc, isRange, [cmp.from, cmp.to]).get('total') || new Map() });
    }
    // الحسابات المتحركة في أي عمود
    const ids = new Set();
    for (const c of cols) for (const id of c.amounts.keys()) if (isAcc(id)) ids.add(id);
    const accounts = [...ids].map((id) => cls.get(id)).sort((a, b) => (a.code < b.code ? -1 : 1));
    const nat = (c, v) => (INCOME.has(c.isLine) || c.isLine === null ? D.neg(v) : v);   // إيراد/غير مصنف: دائن − مدين؛ تكلفة/مصروف: مدين − دائن
    const sections = {};
    for (const s of IS_ORDER.filter((x) => !x.subtotal)) {
      const accs = accounts.filter((a) => a.isLine === s.line);
      const rows = accs.map((a) => ({ accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, classification: a.source,
        ...rowValues(cols.map((c) => nat(a, c.amounts.get(a.id) || Z())), !!cmp) }));
      const totals = cols.map((c, i) => D.sum(accs.map((a) => nat(a, c.amounts.get(a.id) || Z())).concat(['0'])));
      sections[s.key] = { key: s.key, rows, totals };
    }
    for (const s of IS_ORDER.filter((x) => x.subtotal)) {
      sections[s.key] = { key: s.key, totals: cols.map((_, i) => D.sum(s.subtotal.map((k) => (k.startsWith('-') ? D.neg(sections[k.slice(1)].totals[i]) : sections[k].totals[i])).concat(['0']))) };
    }
    const lines = IS_ORDER.filter((s) => s.key !== 'unclassified' || sections.unclassified.rows.length).map((s) => ({
      key: s.key, subtotal: !!s.subtotal, rows: sections[s.key].rows || null, ...rowValues(sections[s.key].totals, !!cmp),
    }));
    const unclassified = sections.unclassified.rows.map((x) => ({ accountId: x.accountId, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn }));
    // المطابقة مع ميزان المراجعة (قبل الإقفال) لكل حساب ولكل عمود فترة
    const recon = reconcileIS(ctx, q, sc, cols.filter((c) => c.key === 'current' || c.key === 'comparative' || c.key === 'total'), cls);
    const totalIdx = breakdown ? cols.length - 1 : 0;   // عمود الإجمالي (التوزيع) أو الفترة الحالية
    const netTotal = sections.net_profit.totals[totalIdx];
    const res = {
      statement: 'income_statement', from: r.from, to: r.to, rangeKind: r.kind, baseCurrency: baseCode(),
      scope: { all: sc.all, branches: sc.branches, branchParam: sc.branchParam, costCenters: sc.costCenters, analytical: sc.analytical },
      breakdown, ...columnsMeta(cols, cmp ? cmp.mode : null), comparativePeriod: cmp, lines,
      netProfit: cell(netTotal), resultSide: D.isZero(netTotal) ? 'zero' : D.isNegative(netTotal) ? 'loss' : 'profit',
      complete: unclassified.length === 0, issues: unclassified.length ? [{ code: 'UNCLASSIFIED_ACCOUNTS', accounts: unclassified }] : [],
      warnings: cmp ? cmp.warnings : [], reconciliation: recon,
      finality: services.fiscal.finality(r.from, r.to),
    };
    if (breakdown) {
      // الأعمدة تساوي الإجمالي بالضبط (لا اختلاط ولا ازدواج)
      const net = sections.net_profit.totals;
      res.breakdownCheck = { ok: D.eq(D.sum(net.slice(0, -1).concat(['0'])), net[net.length - 1]) };
      if (!res.breakdownCheck.ok) res.reconciliation.ok = false;
    }
    return { ...res, ...issuance(res) };
  }
  function reconcileIS(ctx, q, sc, cols, cls) {
    const differences = [];
    for (const c of cols) {
      const tb = services.ledgerReports.trialBalance(ctx, { from: c.from, to: c.to, branch: sc.branchParam, excludeClosing: '1', level: '15',
        ...(sc.costCenters.length === 1 ? { costCenterId: String(sc.costCenters[0].id) } : {}) });
      if (sc.costCenters.length > 1) continue;   // الميزان يقبل مركزًا واحدًا؛ مجموعة المراكز تُطابَق بمجموع أعمدتها (اختبار)
      for (const row of tb.rows.filter((x) => !x.isGroup)) {
        const a = cls.get(row.accountId);
        if (!a || a.statement !== 'income_statement') continue;
        const mv = D.sub(row.movementDebit, row.movementCredit);
        const mine = c.amounts.get(row.accountId) || Z();
        if (!D.eq(mv, mine)) differences.push({ column: c.key, accountId: row.accountId, code: row.code, trialBalance: D.canonical(mv), statement: D.canonical(mine) });
      }
      for (const [id, v] of c.amounts) {
        const a = cls.get(id);
        if (a && a.statement === 'income_statement' && !D.isZero(v) && !tb.rows.some((x) => x.accountId === id)) differences.push({ column: c.key, accountId: id, code: a.code, trialBalance: '0', statement: D.canonical(v) });
      }
    }
    return { ok: differences.length === 0, against: 'trial_balance', differences };
  }

  // ── قائمة المركز المالي ──
  const BS_CLASSES = ['asset', 'liability', 'equity'];
  function balanceSheet(ctx, q) {
    let asOf = q.asOf;
    if (q.fiscalYearId || q.periodId) asOf = services.ledgerReports.range(q).to;
    if (!validDate(asOf)) throw vErr({ asOf: asOf ? 'INVALID' : 'REQUIRED' });
    const sc = scope(ctx, q);
    const cmp = compareDate(asOf, q.compare);
    const cls = classification();
    const at = (d) => sums(sc, `g.posting_date <= ? AND ${NOT_CF}`, [d]).get('total') || new Map();
    const cols = [{ key: 'current', asOf, amounts: at(asOf) }];
    if (cmp) cols.push({ key: 'comparative', asOf: cmp.asOf, amounts: at(cmp.asOf) });
    const ids = new Set(); for (const c of cols) for (const [id, v] of c.amounts) if (!D.isZero(v)) ids.add(id);
    const accs = [...ids].map((id) => cls.get(id)).filter(Boolean);
    const sign = (cl, v) => (cl === 'asset' ? v : D.neg(v));    // الأصول مدين − دائن؛ الالتزامات وحقوق الملكية دائن − مدين
    const sections = BS_CLASSES.map((k) => {
      const list = accs.filter((a) => a.classCode === k).sort((a, b) => (a.code < b.code ? -1 : 1));
      // مجموعات حسب نوع الحساب (عرض فقط؛ إجمالي التصنيف لا يعتمد عليها)
      const groups = new Map();
      for (const a of list) { const g = a.typeId ? String(a.typeId) : 'none'; if (!groups.has(g)) groups.set(g, []); groups.get(g).push(a); }
      const groupRows = [...groups.entries()].map(([g, gl]) => ({
        typeCode: g === 'none' ? null : gl[0].typeCode, typeNameAr: g === 'none' ? null : gl[0].typeNameAr, typeNameEn: g === 'none' ? null : gl[0].typeNameEn,
        rows: gl.map((a) => ({ accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, ...rowValues(cols.map((c) => sign(k, c.amounts.get(a.id) || Z())), !!cmp) })),
        ...rowValues(cols.map((c) => D.sum(gl.map((a) => sign(k, c.amounts.get(a.id) || Z())).concat(['0']))), !!cmp),
      }));
      return { key: k, groups: groupRows, totals: cols.map((c) => D.sum(list.map((a) => sign(k, c.amounts.get(a.id) || Z())).concat(['0']))) };
    });
    // نتيجة الفترات غير المُقفلة (حسابات قائمة الدخل التراكمية بعد قيود الإقفال) — جزء من حقوق الملكية
    const unclosed = cols.map((c) => D.neg(D.sum([...c.amounts].filter(([id]) => { const a = cls.get(id); return a && a.statement === 'income_statement'; }).map(([, v]) => v).concat(['0']))));
    const [A, L, E] = sections.map((s) => s.totals);
    const equityTotal = cols.map((_, i) => D.add(E[i], unclosed[i]));
    const liabEq = cols.map((_, i) => D.add(L[i], equityTotal[i]));
    const difference = cols.map((_, i) => D.sub(A[i], liabEq[i]));
    const balanced = difference.every((x) => D.isZero(x));
    const recon = reconcileBS(ctx, sc, cols, cls);
    const y = yearContaining(asOf);
    const res = {
      statement: 'balance_sheet', asOf, baseCurrency: baseCode(),
      scope: { all: sc.all, branches: sc.branches, branchParam: sc.branchParam, costCenters: [], analytical: false },
      ...columnsMeta(cols, cmp ? cmp.mode : null), comparativeDate: cmp,
      sections: sections.map((s, i) => ({ key: s.key, groups: s.groups, ...rowValues(s.key === 'equity' ? equityTotal : s.totals, !!cmp),
        ...(s.key === 'equity' ? { unclosedResult: rowValues(unclosed, !!cmp), accountsTotal: rowValues(E, !!cmp) } : {}) })),
      totalAssets: rowValues(A, !!cmp), totalLiabilities: rowValues(L, !!cmp), totalEquity: rowValues(equityTotal, !!cmp), totalLiabilitiesAndEquity: rowValues(liabEq, !!cmp),
      difference: rowValues(difference, !!cmp), balanced,
      complete: true, issues: [], warnings: cmp ? cmp.warnings : [], reconciliation: recon,
      fiscalYearStart: y ? y.start_date : null,
      finality: services.fiscal.finality(y ? y.start_date : asOf, asOf),
    };
    return { ...res, ...issuance(res) };
  }
  function reconcileBS(ctx, sc, cols, cls) {
    const differences = [];
    for (const c of cols) {
      const tb = services.ledgerReports.trialBalance(ctx, { from: c.asOf, to: c.asOf, branch: sc.branchParam, level: '15' });
      const seen = new Set();
      for (const row of tb.rows.filter((x) => !x.isGroup)) {
        seen.add(row.accountId);
        const mine = c.amounts.get(row.accountId) || Z();
        if (!D.eq(row.closing.net, mine)) differences.push({ column: c.key, accountId: row.accountId, code: row.code, trialBalance: row.closing.net, statement: D.canonical(mine) });
      }
      for (const [id, v] of c.amounts) if (!D.isZero(v) && !seen.has(id) && cls.has(id)) differences.push({ column: c.key, accountId: id, code: cls.get(id).code, trialBalance: '0', statement: D.canonical(v) });
    }
    return { ok: differences.length === 0, against: 'trial_balance', differences };
  }

  // ── قائمة التدفقات النقدية (الطريقة غير المباشرة) ──
  /**
   * التغير في النقدية = −Σ تغير كل الحسابات غير النقدية (القيد المزدوج متزن لكل فرع). كل حساب غير نقدي يُنسب لنشاطه:
   * حسابات قائمة الدخل ⇒ صافي الربح (تشغيلي)، وحسابات الميزانية بنشاطها المحدد (تشغيلي/استثماري/تمويلي).
   * الحركات: قيود يومية فقط عدا القيود الافتتاحية (الافتتاحي رصيد أول مدة لا تدفق)، فلا إقفال ولا ترحيل أرصدة.
   * يُتحقق أن النقدية أول المدة + صافي التدفق = النقدية آخر المدة بالضبط.
   */
  function cashFlow(ctx, q) {
    const r = rangeOf(q);
    const sc = scope(ctx, q);
    const cmp = compareRange(r, q.compare);
    const cls = classification();
    const cash = [...cls.values()].filter((a) => a.cfActivity === 'cash').map((a) => a.id);
    const issues = [];
    if (!cash.length) issues.push({ code: 'NO_CASH_ACCOUNTS' });
    const period = (from, to) => {
      const mv = sums(sc, "g.posting_date BETWEEN ? AND ? AND g.source_type = 'journal' AND g.entry_kind <> 'opening'", [from, to]).get('total') || new Map();
      const cashBal = (cond, params) => D.sum([...(sums(sc, cond, params).get('total') || new Map())].filter(([id]) => cash.includes(id)).map(([, v]) => v).concat(['0']));
      const opening = cashBal(`${NOT_CF} AND (g.posting_date < ? OR (g.posting_date BETWEEN ? AND ? AND g.source_type = 'journal' AND g.entry_kind = 'opening'))`, [from, from, to]);
      const closing = cashBal(`${NOT_CF} AND g.posting_date <= ?`, [to]);
      return { mv, opening, closing };
    };
    const periods = [period(r.from, r.to)];
    if (cmp) periods.push(period(cmp.from, cmp.to));
    const ids = new Set(); for (const p of periods) for (const [id, v] of p.mv) if (!D.isZero(v) && !cash.includes(id)) ids.add(id);
    const accs = [...ids].map((id) => cls.get(id)).filter(Boolean).sort((a, b) => (a.code < b.code ? -1 : 1));
    const flow = (p, id) => D.neg(p.mv.get(id) || Z());           // دائن − مدين للحساب غير النقدي = أثره على النقدية
    const plAccs = accs.filter((a) => a.statement === 'income_statement');
    const netIncome = periods.map((p) => D.sum(plAccs.map((a) => flow(p, a.id)).concat(['0'])));
    const act = (k) => accs.filter((a) => a.statement === 'balance_sheet' && (k === 'unclassified' ? !a.cfActivity : a.cfActivity === k));
    const sectionOf = (k) => {
      const list = act(k);
      const rows = list.map((a) => ({ accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, classification: a.source, ...rowValues(periods.map((p) => flow(p, a.id)), !!cmp) }));
      const totals = periods.map((p, i) => D.sum(list.map((a) => flow(p, a.id)).concat(k === 'operating' ? [netIncome[i]] : []).concat(['0'])));
      return { key: k, rows, ...rowValues(totals, !!cmp), totalsRaw: totals };
    };
    const S = ['operating', 'investing', 'financing', 'unclassified'].map(sectionOf);
    const unclassified = S[3].rows;
    if (unclassified.length) issues.push({ code: 'UNCLASSIFIED_ACCOUNTS', accounts: unclassified.map((x) => ({ accountId: x.accountId, code: x.code, nameAr: x.nameAr, nameEn: x.nameEn })) });
    const net = periods.map((_, i) => D.sum(S.map((s) => s.totalsRaw[i]).concat(['0'])));
    const proof = periods.map((p, i) => D.eq(D.add(p.opening, net[i]), p.closing));
    const plOpening = db.prepare(`SELECT 1 FROM gl_entries g JOIN accounts a ON a.id = g.account_id JOIN account_classes k ON k.code = a.class_code
      WHERE ${sc.where} AND g.posting_date BETWEEN ? AND ? AND g.entry_kind = 'opening' AND g.source_type = 'journal' AND k.statement = 'income_statement' LIMIT 1`).get(...sc.params, r.from, r.to);
    const warnings = (cmp ? cmp.warnings : []).concat(plOpening ? [{ code: 'OPENING_ENTRY_ON_INCOME_ACCOUNTS' }] : []);
    const res = {
      statement: 'cash_flow', method: 'indirect', from: r.from, to: r.to, rangeKind: r.kind, baseCurrency: baseCode(),
      scope: { all: sc.all, branches: sc.branches, branchParam: sc.branchParam, costCenters: [], analytical: false },
      ...columnsMeta(periods.map((_, i) => (i ? { key: 'comparative', from: cmp.from, to: cmp.to, label: cmp.label } : { key: 'current', from: r.from, to: r.to })), cmp ? cmp.mode : null),
      comparativePeriod: cmp,
      netIncome: rowValues(netIncome, !!cmp),
      sections: S.filter((s) => s.key !== 'unclassified' || s.rows.length).map(({ totalsRaw, ...s }) => s),
      netChange: rowValues(net, !!cmp), openingCash: rowValues(periods.map((p) => p.opening), !!cmp), closingCash: rowValues(periods.map((p) => p.closing), !!cmp),
      cashAccounts: cash.map((id) => { const a = cls.get(id); return { accountId: id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn }; }),
      complete: issues.length === 0, issues, warnings,
      reconciliation: reconcileCF(ctx, sc, r, periods[0], cash, proof),
      finality: services.fiscal.finality(r.from, r.to),
    };
    return { ...res, ...issuance(res) };
  }
  function reconcileCF(ctx, sc, r, p, cash, proof) {
    const differences = [];
    if (!proof.every(Boolean)) differences.push({ code: 'CASH_PROOF_FAILED' });
    const tb = services.ledgerReports.trialBalance(ctx, { from: r.from, to: r.to, branch: sc.branchParam, level: '15' });
    const tbCash = D.sum(tb.rows.filter((x) => !x.isGroup && cash.includes(x.accountId)).map((x) => x.closing.net).concat(['0']));
    if (!D.eq(tbCash, p.closing)) differences.push({ code: 'CLOSING_CASH_VS_TRIAL_BALANCE', trialBalance: D.canonical(tbCash), statement: D.canonical(p.closing) });
    return { ok: differences.length === 0, against: 'trial_balance', differences };
  }

  // ── الإعدادات ──
  function settings() {
    const types = db.prepare(`SELECT t.id, t.code, t.class_code, t.name_ar, t.name_en, t.is_active, k.statement, s.is_line, s.cf_activity
      FROM account_types t JOIN account_classes k ON k.code = t.class_code LEFT JOIN fs_type_settings s ON s.type_id = t.id ORDER BY k.sort_order, t.code`).all()
      .map((t) => ({ typeId: t.id, code: t.code, classCode: t.class_code, statement: t.statement, nameAr: t.name_ar, nameEn: t.name_en, isActive: t.is_active === 1, isLine: t.is_line, cfActivity: t.cf_activity }));
    const cls = classification();
    const overrides = db.prepare('SELECT * FROM fs_account_settings ORDER BY account_id').all()
      .map((o) => { const a = cls.get(o.account_id); return a ? { accountId: o.account_id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, classCode: a.classCode, isLine: o.is_line, cfActivity: o.cf_activity } : null; }).filter(Boolean);
    const moved = new Set(db.prepare("SELECT DISTINCT account_id id FROM gl_entries WHERE source_type <> 'carry_forward'").all().map((x) => x.id));
    const unclassified = [...cls.values()].filter((a) => (a.statement === 'income_statement' ? !a.isLine : !a.cfActivity))
      .sort((a, b) => (a.code < b.code ? -1 : 1))
      .map((a) => ({ accountId: a.id, code: a.code, nameAr: a.nameAr, nameEn: a.nameEn, classCode: a.classCode, statement: a.statement, typeCode: a.typeCode, hasActivity: moved.has(a.id) }));
    return { types, overrides, unclassified, options: { isLines: IS_LINES, cfActivities: CF_ACTIVITIES } };
  }
  function checkValues(statement, classCode, v) {
    const fields = {};
    if (v.isLine != null) {
      if (statement !== 'income_statement') fields.isLine = 'NOT_ALLOWED';
      else if (!IS_LINES.includes(v.isLine)) fields.isLine = 'INVALID';
      else if (!(classCode === 'revenue' ? INCOME.has(v.isLine) : classCode === 'cogs' ? v.isLine === 'cogs' : ['operating_expense', 'other_expense'].includes(v.isLine))) fields.isLine = 'CLASS_MISMATCH';
    }
    if (v.cfActivity != null) {
      if (statement !== 'balance_sheet') fields.cfActivity = 'NOT_ALLOWED';
      else if (!CF_ACTIVITIES.includes(v.cfActivity)) fields.cfActivity = 'INVALID';
    }
    if (Object.keys(fields).length) throw vErr(fields);
  }
  const norm = (body) => ({ isLine: body.isLine === '' ? null : body.isLine ?? null, cfActivity: body.cfActivity === '' ? null : body.cfActivity ?? null });
  function setType(ctx, typeId, body) {
    const t = db.prepare('SELECT t.*, k.statement FROM account_types t JOIN account_classes k ON k.code = t.class_code WHERE t.id = ?').get(typeId);
    if (!t) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
    const v = norm(body);
    checkValues(t.statement, t.class_code, v);
    const before = db.prepare('SELECT is_line, cf_activity FROM fs_type_settings WHERE type_id = ?').get(typeId) || { is_line: null, cf_activity: null };
    db.prepare(`INSERT INTO fs_type_settings (type_id, is_line, cf_activity, updated_by) VALUES (?, ?, ?, ?)
      ON CONFLICT (type_id) DO UPDATE SET is_line = excluded.is_line, cf_activity = excluded.cf_activity, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
      .run(typeId, v.isLine, v.cfActivity, ctx.user.id);
    services.audit.fromCtx(ctx, { action: 'financial_statements.type_classified', source: 'financial-statements', entityType: 'account_type', entityId: typeId,
      details: { type: t.code, isLine: { from: before.is_line, to: v.isLine }, cfActivity: { from: before.cf_activity, to: v.cfActivity } } });
    return settings();
  }
  function setAccount(ctx, accountId, body) {
    const a = db.prepare('SELECT a.*, k.statement FROM accounts a JOIN account_classes k ON k.code = a.class_code WHERE a.id = ?').get(accountId);
    if (!a) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
    if (a.is_group === 1) throw vErr({ accountId: 'GROUP' });
    const v = norm(body);
    checkValues(a.statement, a.class_code, v);
    const before = db.prepare('SELECT is_line, cf_activity FROM fs_account_settings WHERE account_id = ?').get(accountId) || { is_line: null, cf_activity: null };
    if (v.isLine == null && v.cfActivity == null) db.prepare('DELETE FROM fs_account_settings WHERE account_id = ?').run(accountId);
    else {
      db.prepare(`INSERT INTO fs_account_settings (account_id, is_line, cf_activity, updated_by) VALUES (?, ?, ?, ?)
        ON CONFLICT (account_id) DO UPDATE SET is_line = excluded.is_line, cf_activity = excluded.cf_activity, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`)
        .run(accountId, v.isLine, v.cfActivity, ctx.user.id);
    }
    services.audit.fromCtx(ctx, { action: 'financial_statements.account_classified', source: 'financial-statements', entityType: 'account', entityId: accountId,
      details: { account: a.code, isLine: { from: before.is_line, to: v.isLine }, cfActivity: { from: before.cf_activity, to: v.cfActivity } } });
    return settings();
  }

  return { classification, incomeStatement, balanceSheet, cashFlow, settings, setType, setAccount, yearBack };
}

module.exports = { createStatements, yearBack, IS_LINES, CF_ACTIVITIES };

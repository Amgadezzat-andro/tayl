'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { writeSheet, sendXlsx } = require('../../core/xlsx');

/**
 * السنوات والفترات المالية.
 *  - الفترات تُولَّد تلقائيًا شهرية أو ربع سنوية من تاريخ بداية السنة (تدعم السنة التي لا تبدأ في يناير
 *    والتي لا تبدأ في أول الشهر)، وآخر فترة تنتهي بنهاية السنة.
 *  - الحالة: open → closed (صلاحية close) → open (صلاحية reopen الخاصة) أو → locked (نهائي، صلاحية lock).
 *  - كل تغيير حالة يتطلب سببًا ويُسجَّل في fiscal_period_events وفي سجل التدقيق.
 *  - للمستندات القادمة: services.fiscal.assertOpen(date) قبل اعتماد أي مستند.
 *  - [م3] ضوابط القسم 7 من مقترح المرحلة 3 (الخادم + triggers في 0002):
 *    P2 القفل النهائي بالتسلسل عبر كل الفترات السابقة (ذري: الفحص والتحديث في معاملة BEGIN IMMEDIATE واحدة)،
 *    P3 تحذير عند إغلاق فترة وقبلها فترة مفتوحة، P4 إعادة فتح فترة بها قيود مرحّلة تتطلب تأكيدًا صريحًا،
 *    P5 السنوات متصلة بلا فجوات (والحذف للسنة الأولى أو الأخيرة فقط)، P6 عبر yearGuards تسجّلها وحدة القيود.
 *    finality(from, to) لنهائية التقارير، endedYears(today) لتحذير P9.
 *  - [م4] وحدة الإقفال السنوي تسجّل: yearClosed(yearRow) (السنة مُقفلة لكل الفروع المطلوبة) فتُستبعد من
 *    PRIOR_YEAR_NOT_CLOSED ومن تحذير P9، وحراس تغيير حالة الفترة (P10: آخر فترة لا تُقفل نهائيًا قبل إقفال السنة).
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const validDate = (s) => typeof s === 'string' && DATE_RE.test(s) && new Date(s + 'T00:00:00Z').toISOString().slice(0, 10) === s;
const d2s = (d) => d.toISOString().slice(0, 10);
const parse = (s) => new Date(s + 'T00:00:00Z');
function addMonths(s, n) {
  const d = parse(s);
  const day = d.getUTCDate();
  const t = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + n, 1));
  const last = new Date(Date.UTC(t.getUTCFullYear(), t.getUTCMonth() + 1, 0)).getUTCDate();
  t.setUTCDate(Math.min(day, last));
  return d2s(t);
}
const prevDay = (s) => { const d = parse(s); d.setUTCDate(d.getUTCDate() - 1); return d2s(d); };

const MONTHS_AR = ['يناير', 'فبراير', 'مارس', 'أبريل', 'مايو', 'يونيو', 'يوليو', 'أغسطس', 'سبتمبر', 'أكتوبر', 'نوفمبر', 'ديسمبر'];
const MONTHS_EN = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** يولّد الفترات: [{ seq, start, end, nameAr, nameEn }] تغطي السنة كاملة بلا فجوات ولا تداخل. */
function generatePeriods(start, end, type) {
  const step = type === 'quarterly' ? 3 : 1;
  const out = [];
  for (let k = 0; ; k++) {
    const s = addMonths(start, k * step);
    if (s > end) break;
    let e = prevDay(addMonths(start, (k + 1) * step));
    if (e > end) e = end;
    const d = parse(s);
    const seq = k + 1;
    const nameAr = type === 'quarterly' ? `الربع ${seq} — ${s}` : `${MONTHS_AR[d.getUTCMonth()]} ${d.getUTCFullYear()}${d.getUTCDate() !== 1 ? ` (${s})` : ''}`;
    const nameEn = type === 'quarterly' ? `Q${seq} — ${s}` : `${MONTHS_EN[d.getUTCMonth()]} ${d.getUTCFullYear()}${d.getUTCDate() !== 1 ? ` (${s})` : ''}`;
    out.push({ seq, start: s, end: e, nameAr, nameEn });
    if (e === end) break;
  }
  return out;
}

module.exports = {
  name: 'fiscal-years',
  version: '1.0.0',
  dependsOn: ['company-setup'],
  migrationsDir: path.join(__dirname, 'migrations'),
  generatePeriods,

  register(router, services) {
    const { db, audit, usage } = services;
    services.permissions.register('fiscal-years', [{
      resource: 'fiscal_years', group: 'accounting', actions: ['view', 'create', 'update', 'delete', 'print', 'export'],
      special: ['close', 'reopen', 'lock'], superOnlyGrant: ['lock'],
    }]);

    const periodApi = (p) => ({
      id: p.id, fiscalYearId: p.fiscal_year_id, seq: p.seq, nameAr: p.name_ar, nameEn: p.name_en, startDate: p.start_date, endDate: p.end_date,
      status: p.status, statusChangedAt: p.status_changed_at, statusChangedBy: p.status_changed_by, statusReason: p.status_reason,
    });
    const periodsOf = (yid) => db.prepare('SELECT * FROM fiscal_periods WHERE fiscal_year_id = ? ORDER BY seq').all(yid).map(periodApi);
    function yearApi(y, withPeriods = true) {
      const ps = periodsOf(y.id);
      const count = (s) => ps.filter((p) => p.status === s).length;
      return {
        id: y.id, code: y.code, nameAr: y.name_ar, nameEn: y.name_en, startDate: y.start_date, endDate: y.end_date, periodType: y.period_type,
        periodCount: ps.length, openCount: count('open'), closedCount: count('closed'), lockedCount: count('locked'),
        status: ps.length && count('locked') === ps.length ? 'locked' : (count('open') === ps.length ? 'open' : 'partial'),
        createdAt: y.created_at, ...(withPeriods ? { periods: ps } : {}),
      };
    }
    const yearRow = (id) => db.prepare('SELECT * FROM fiscal_years WHERE id = ?').get(id);
    const notFound = () => new HttpError(404, 'NOT_FOUND', 'غير موجود');
    const nextDay = (s) => { const d = parse(s); d.setUTCDate(d.getUTCDate() + 1); return d2s(d); };
    // [م3] وحدات أخرى تسجّل: نشاط الفترة (عدد المستندات المرحّلة فيها) وحراس إنشاء السنة (P6)
    const periodActivity = new Map();
    const yearGuards = [];
    const periodGuards = [];
    let yearClosed = () => false;
    const postedIn = (periodId) => [...periodActivity.values()].reduce((n, fn) => n + fn(db, periodId), 0);

    function createYear(ctx, body) {
      const v = validator(body)
        .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
        .str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 })
        .str('startDate', { required: true, pattern: DATE_RE }).str('endDate', { required: true, pattern: DATE_RE })
        .oneOf('periodType', ['monthly', 'quarterly'], { required: true })
        .done();
      const fields = {};
      if (!validDate(v.startDate)) fields.startDate = 'INVALID';
      if (!validDate(v.endDate)) fields.endDate = 'INVALID';
      if (!Object.keys(fields).length && v.endDate <= v.startDate) fields.endDate = 'END_BEFORE_START';
      if (!Object.keys(fields).length && (parse(v.endDate) - parse(v.startDate)) / 86400000 > 730) fields.endDate = 'YEAR_TOO_LONG';
      if (Object.keys(fields).length) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields });
      return inTransaction(db, () => {
        const clash = db.prepare('SELECT code FROM fiscal_years WHERE ? <= end_date AND ? >= start_date').get(v.startDate, v.endDate);
        if (clash) throw new HttpError(409, 'FISCAL_OVERLAP', 'السنة المالية تتداخل مع سنة أخرى', { with: clash.code });
        // P5: تلي آخر سنة مباشرة أو تسبق أول سنة مباشرة
        const b = db.prepare('SELECT min(start_date) first, max(end_date) last FROM fiscal_years').get();
        if (b.first && v.startDate !== nextDay(b.last) && nextDay(v.endDate) !== b.first) {
          throw new HttpError(409, 'FISCAL_YEAR_GAP', 'السنوات المالية متصلة: تبدأ السنة الجديدة في اليوم التالي لنهاية آخر سنة', { expectedStart: nextDay(b.last) });
        }
        // P2: سنة قبل الأولى ستضع فترات مفتوحة قبل فترة مغلقة/مقفلة
        if (b.first && v.startDate < b.first && db.prepare("SELECT 1 FROM fiscal_periods WHERE status <> 'open' LIMIT 1").get()) {
          throw new HttpError(409, 'FISCAL_YEAR_BEFORE_CLOSED', 'لا تُضاف سنة قبل أول سنة بعد إغلاق أو قفل أي فترة');
        }
        for (const g of yearGuards) g(v);                       // P6 وأمثاله
        let id;
        try {
          id = Number(db.prepare('INSERT INTO fiscal_years (code, name_ar, name_en, start_date, end_date, period_type, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
            .run(v.code, v.nameAr, v.nameEn, v.startDate, v.endDate, v.periodType, ctx.user.id).lastInsertRowid);
        } catch (e) {
          if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'DUPLICATE', 'القيمة مستخدمة من قبل', { fields: { code: 'TAKEN' } });
          throw e;
        }
        const ins = db.prepare('INSERT INTO fiscal_periods (fiscal_year_id, seq, name_ar, name_en, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)');
        const periods = generatePeriods(v.startDate, v.endDate, v.periodType);
        for (const p of periods) ins.run(id, p.seq, p.nameAr, p.nameEn, p.start, p.end);
        audit.fromCtx(ctx, { action: 'fiscal_year.created', source: 'fiscal-years', entityType: 'fiscal_year', entityId: id,
          details: { code: v.code, startDate: v.startDate, endDate: v.endDate, periodType: v.periodType, periods: periods.length } });
        return yearApi(yearRow(id));
      });
    }

    function updateYear(ctx, id, body) {
      const v = validator(body, { partial: true }).str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 }).done();
      return inTransaction(db, () => {
        const y = yearRow(id);
        if (!y) throw notFound();
        const changes = {};
        if (v.nameAr && v.nameAr !== y.name_ar) changes.nameAr = { from: y.name_ar, to: v.nameAr };
        if (v.nameEn && v.nameEn !== y.name_en) changes.nameEn = { from: y.name_en, to: v.nameEn };
        if (Object.keys(changes).length) {
          db.prepare("UPDATE fiscal_years SET name_ar = ?, name_en = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(v.nameAr ?? y.name_ar, v.nameEn ?? y.name_en, id);
          audit.fromCtx(ctx, { action: 'fiscal_year.updated', source: 'fiscal-years', entityType: 'fiscal_year', entityId: id, details: { code: y.code, changes } });
        }
        return yearApi(yearRow(id));
      });
    }

    /** الحذف فقط إذا كانت كل الفترات مفتوحة وغير مستخدمة (لتصحيح سنة أُدخلت خطأ قبل أي استخدام). */
    function deleteYear(ctx, id) {
      return inTransaction(db, () => {
        const y = yearRow(id);
        if (!y) throw notFound();
        const ps = periodsOf(id);
        if (ps.some((p) => p.status !== 'open')) throw new HttpError(409, 'FISCAL_YEAR_NOT_OPEN', 'لا تُحذف سنة بها فترات مغلقة');
        const around = db.prepare('SELECT (SELECT count(*) FROM fiscal_years WHERE start_date < ?) before, (SELECT count(*) FROM fiscal_years WHERE start_date > ?) after').get(y.start_date, y.start_date);
        if (around.before && around.after) throw new HttpError(409, 'FISCAL_YEAR_NOT_EDGE', 'لا تُحذف سنة في الوسط (تترك فجوة)؛ الأولى أو الأخيرة فقط');
        const used = ps.flatMap((p) => usage.usedBy('fiscal_period', p.id));
        if (used.length) throw new HttpError(409, 'IN_USE', 'السنة مستخدمة في مستندات', { usedBy: [...new Set(used)] });
        if (db.prepare('SELECT 1 FROM fiscal_period_events e JOIN fiscal_periods p ON p.id = e.period_id WHERE p.fiscal_year_id = ? LIMIT 1').get(id)) {
          throw new HttpError(409, 'FISCAL_YEAR_HAS_HISTORY', 'للسنة سجل إغلاق سابق؛ لا تُحذف');
        }
        db.prepare('DELETE FROM fiscal_periods WHERE fiscal_year_id = ?').run(id);
        db.prepare('DELETE FROM fiscal_years WHERE id = ?').run(id);
        audit.fromCtx(ctx, { action: 'fiscal_year.deleted', source: 'fiscal-years', entityType: 'fiscal_year', entityId: id, details: { code: y.code, startDate: y.start_date, endDate: y.end_date } });
        return { ok: true };
      });
    }

    const TRANSITIONS = { close: ['open', 'closed', 'closed'], reopen: ['closed', 'open', 'reopened'], lock: ['closed', 'locked', 'locked'] };
    function changeStatus(ctx, periodId, op, body) {
      const { reason, confirm } = validator(body).str('reason', { required: true, min: 3, max: 500, multiline: true }).bool('confirm').done();
      const [from, to, action] = TRANSITIONS[op];
      // الفحص والتحديث في معاملة BEGIN IMMEDIATE واحدة: لا يتغير شيء بينهما (P2 ذري)
      return inTransaction(db, () => {
        const p = db.prepare('SELECT p.*, y.code year_code FROM fiscal_periods p JOIN fiscal_years y ON y.id = p.fiscal_year_id WHERE p.id = ?').get(periodId);
        if (!p) throw notFound();
        if (p.status !== from) throw new HttpError(409, 'PERIOD_STATUS', 'حالة الفترة لا تسمح بهذا الإجراء', { status: p.status, required: from });
        const earlier = (cond) => db.prepare(`SELECT id, name_ar nameAr, name_en nameEn, start_date startDate, status FROM fiscal_periods WHERE start_date < ? AND ${cond} ORDER BY start_date`).all(p.start_date);
        const warnings = [];
        if (op === 'lock') {                                     // P2
          const blocking = earlier("status <> 'locked'");
          if (blocking.length) throw new HttpError(409, 'PERIOD_LOCK_SEQUENCE', 'اقفل الفترات السابقة أولًا (القفل النهائي بالتسلسل)', { periods: blocking });
        }
        if (op === 'close') {                                    // P3 (تحذير فقط)
          const open = earlier("status = 'open'");
          if (open.length) warnings.push({ code: 'EARLIER_PERIODS_OPEN', periods: open });
        }
        for (const g of periodGuards) g(op, p);                 // P10 وأمثاله
        let postedEntries = 0;
        if (op === 'reopen') {                                   // P4
          postedEntries = postedIn(p.id);
          if (postedEntries > 0 && confirm !== true) throw new HttpError(409, 'REOPEN_CONFIRM_REQUIRED', 'الفترة بها قيود مرحّلة؛ يلزم تأكيد صريح لإعادة فتحها', { postedEntries });
        }
        db.prepare("UPDATE fiscal_periods SET status = ?, status_changed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), status_changed_by = ?, status_reason = ? WHERE id = ?")
          .run(to, ctx.user.id, reason, periodId);
        db.prepare('INSERT INTO fiscal_period_events (period_id, action, from_status, to_status, reason, user_id, username) VALUES (?, ?, ?, ?, ?, ?, ?)')
          .run(periodId, action, from, to, reason, ctx.user.id, ctx.user.username);
        audit.fromCtx(ctx, { action: `fiscal_period.${action}`, source: 'fiscal-years', entityType: 'fiscal_period', entityId: periodId,
          details: { year: p.year_code, seq: p.seq, startDate: p.start_date, endDate: p.end_date, from, to, reason, ...(op === 'reopen' ? { postedEntries, confirmed: confirm === true } : {}), ...(warnings.length ? { warnings: warnings.map((w) => w.code) } : {}) } });
        return { ...periodApi(db.prepare('SELECT * FROM fiscal_periods WHERE id = ?').get(periodId)), warnings };
      });
    }

    /** للمستندات القادمة: الفترة التي يقع فيها التاريخ. */
    function periodFor(date) {
      if (!validDate(date)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { date: 'INVALID' } });
      const p = db.prepare('SELECT p.*, y.code year_code FROM fiscal_periods p JOIN fiscal_years y ON y.id = p.fiscal_year_id WHERE ? BETWEEN p.start_date AND p.end_date').get(date);
      return p ? { ...periodApi(p), yearCode: p.year_code } : null;
    }
    /** يرفض اعتماد مستند بتاريخ خارج أي فترة أو في فترة غير مفتوحة. */
    function assertOpen(date) {
      const p = periodFor(date);
      if (!p) throw new HttpError(409, 'NO_FISCAL_PERIOD', 'التاريخ لا يقع في أي فترة مالية معرّفة', { date });
      if (p.status !== 'open') throw new HttpError(409, 'PERIOD_NOT_OPEN', 'الفترة المالية غير مفتوحة', { date, status: p.status, period: p.id });
      return p;
    }
    /**
     * نهائية تقرير يغطي [from, to] (المقترح 7.3): نهائي فقط إن كانت كل فتراته مقفلة نهائيًا وكل سنة مالية قبله
     * مُقفلة لكل الفروع المطلوبة ([م4]).
     */
    function finality(from, to) {
      const reasons = [];
      const ps = db.prepare('SELECT p.status, y.start_date ys FROM fiscal_periods p JOIN fiscal_years y ON y.id = p.fiscal_year_id WHERE p.start_date <= ? AND p.end_date >= ?').all(to, from);
      if (!ps.length) reasons.push({ code: 'NO_FISCAL_PERIOD' });
      if (ps.some((p) => p.status === 'open')) reasons.push({ code: 'PERIOD_OPEN' });
      if (ps.some((p) => p.status === 'closed')) reasons.push({ code: 'PERIOD_NOT_LOCKED' });
      // أيام من النطاق لا تغطيها فترة معرّفة (السنوات متصلة بـ P5، فيكفي فحص الطرفين) — قد تُضاف سنة ويُرحَّل فيها لاحقًا
      const cover = db.prepare('SELECT min(start_date) s, max(end_date) e FROM fiscal_periods').get();
      if (ps.length && (!cover.s || cover.s > from || cover.e < to)) reasons.push({ code: 'RANGE_NOT_COVERED' });
      const prior = db.prepare('SELECT * FROM fiscal_years WHERE start_date < ? ORDER BY start_date').all(ps.length ? ps.reduce((m, p) => (p.ys < m ? p.ys : m), ps[0].ys) : from)
        .filter((y) => !yearClosed(y));
      if (prior.length) reasons.push({ code: 'PRIOR_YEAR_NOT_CLOSED', years: prior.map((y) => y.code) });
      return { final: reasons.length === 0, reasons };
    }
    /** P9: السنوات التي انتهى تاريخها ولم تُقفل لكل الفروع المطلوبة. */
    const endedYears = (today) => db.prepare('SELECT * FROM fiscal_years WHERE end_date < ? ORDER BY start_date').all(today)
      .filter((y) => !yearClosed(y)).map((y) => ({ id: y.id, code: y.code, nameAr: y.name_ar, nameEn: y.name_en, startDate: y.start_date, endDate: y.end_date }));

    services.fiscal = {
      periodFor, assertOpen, generatePeriods, finality, endedYears,
      registerPeriodActivity: (name, fn) => periodActivity.set(name, fn),
      registerYearGuard: (fn) => yearGuards.push(fn),
      registerPeriodGuard: (fn) => periodGuards.push(fn),
      registerYearClosed: (fn) => { yearClosed = fn; },
    };

    function exportData(lang) {
      const t = (k) => services.i18n.t(lang, k);
      const rows = [];
      for (const y of db.prepare('SELECT * FROM fiscal_years ORDER BY start_date').all()) {
        for (const p of periodsOf(y.id)) rows.push([y.code, lang === 'ar' ? p.nameAr : p.nameEn, p.startDate, p.endDate, t('period.status.' + p.status), p.statusReason || '']);
      }
      return { title: t('nav.fiscalYears'), columns: ['fiscal.code', 'fiscal.period', 'fiscal.startDate', 'fiscal.endDate', 'common.status', 'fiscal.reason'].map(t), rows };
    }

    const P = (a) => ({ permission: `fiscal_years.${a}` });
    router.get('/api/fiscal-years', P('view'), () => db.prepare('SELECT * FROM fiscal_years ORDER BY start_date DESC').all().map((y) => yearApi(y, false)));
    router.get('/api/fiscal-years/export.xlsx', P('export'), (ctx) => {
      const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
      const d = exportData(lang);
      audit.fromCtx(ctx, { action: 'fiscal_years.exported', source: 'fiscal-years', entityType: 'fiscal_years', details: { rows: d.rows.length } });
      sendXlsx(ctx.res, 'fiscal-periods.xlsx', writeSheet({ sheetName: d.title, header: d.columns, rows: d.rows, rtl: lang === 'ar' }));
    });
    router.get('/api/fiscal-years/print', P('print'), (ctx) => exportData(ctx.query.lang === 'en' ? 'en' : 'ar'));
    router.get('/api/fiscal-years/preview', P('create'), (ctx) => {
      const { start, end, type } = ctx.query;
      if (!validDate(start) || !validDate(end) || end <= start || !['monthly', 'quarterly'].includes(type)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة');
      return generatePeriods(start, end, type);
    });
    router.get('/api/fiscal-periods/check', P('view'), (ctx) => {
      const p = periodFor(String(ctx.query.date || ''));
      return { period: p, open: !!p && p.status === 'open' };
    });
    router.get('/api/fiscal-periods/:id/events', P('view'), (ctx) => db.prepare('SELECT * FROM fiscal_period_events WHERE period_id = ? ORDER BY id').all(idParam(ctx.params.id))
      .map((e) => ({ id: e.id, action: e.action, fromStatus: e.from_status, toStatus: e.to_status, reason: e.reason, username: e.username, occurredAt: e.occurred_at })));
    router.post('/api/fiscal-periods/:id/close', P('close'), async (ctx) => changeStatus(ctx, idParam(ctx.params.id), 'close', await ctx.body()));
    router.post('/api/fiscal-periods/:id/reopen', P('reopen'), async (ctx) => changeStatus(ctx, idParam(ctx.params.id), 'reopen', await ctx.body()));
    router.post('/api/fiscal-periods/:id/lock', P('lock'), async (ctx) => changeStatus(ctx, idParam(ctx.params.id), 'lock', await ctx.body()));
    router.get('/api/fiscal-years/:id', P('view'), (ctx) => { const y = yearRow(idParam(ctx.params.id)); if (!y) throw notFound(); return yearApi(y); });
    router.post('/api/fiscal-years', P('create'), async (ctx) => createYear(ctx, await ctx.body()));
    router.put('/api/fiscal-years/:id', P('update'), async (ctx) => updateYear(ctx, idParam(ctx.params.id), await ctx.body()));
    router.delete('/api/fiscal-years/:id', P('delete'), (ctx) => deleteYear(ctx, idParam(ctx.params.id)));
  },
};

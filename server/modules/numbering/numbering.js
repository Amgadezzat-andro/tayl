'use strict';
const { HttpError } = require('../../core/errors');

/**
 * إصدار أرقام المستندات. يُستدعى **داخل** معاملة المستند نفسها (inTransaction = BEGIN IMMEDIATE)،
 * فالزيادة والإصدار والترحيل عملية ذرية واحدة: فشل أي خطوة يلغي زيادة العداد مع كل شيء.
 *
 * الصيغة: PREFIX[-BRANCHCODE][-FYyyyy]-NNNNNN
 *   - مقطع الفرع: كود الفرع وقت الإصدار؛ التسلسل يتبع branch_id (تغيير الكود لا يغيّر الأرقام الصادرة ولا يقطع التسلسل).
 *   - مقطع السنة: FY + سنة تاريخ بداية السنة المالية (FY2026). سنتان ماليتان تبدآن في السنة الميلادية نفسها
 *     تشتركان في عداد واحد، فلا يتكرر النص.
 * لا تعتمد على أي وحدة أخرى (db فقط) لتعمل كما هي في اختبارات التزامن متعددة العمليات.
 */
function createNumbering(db) {
  const seriesById = db.prepare('SELECT * FROM document_series WHERE id = ?');
  const defaultSeries = db.prepare('SELECT * FROM document_series WHERE doc_type = ? AND is_default = 1');
  const branchRow = db.prepare('SELECT id, code FROM branches WHERE id = ?');
  const yearRow = db.prepare('SELECT id, start_date FROM fiscal_years WHERE id = ?');
  const bump = db.prepare(`INSERT INTO document_counters (series_id, branch_key, year_key, last_value) VALUES (?, ?, ?, 1)
    ON CONFLICT (series_id, branch_key, year_key) DO UPDATE SET last_value = last_value + 1 RETURNING last_value`);
  const record = db.prepare(`INSERT INTO issued_numbers (series_id, branch_key, year_key, seq, number, doc_type, source_id, branch_id, fiscal_year_id, issued_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);

  /** السلسلة الافتراضية النشطة لنوع مستند (تُحفظ في المسودة عند إنشائها). */
  function seriesFor(docType) {
    const s = defaultSeries.get(docType);
    if (!s) throw new HttpError(409, 'NO_SERIES', 'لا توجد سلسلة ترقيم افتراضية لهذا النوع من المستندات', { docType });
    return s;
  }

  const format = (s, branchCode, year, seq) =>
    [s.prefix, s.per_branch ? branchCode : null, s.reset_yearly ? `FY${year}` : null, String(seq).padStart(s.padding, '0')].filter(Boolean).join('-');

  /** يصدر الرقم التالي ويسجّله. يجب أن يكون داخل معاملة. */
  function issue({ seriesId, docType, branchId, fiscalYearId, sourceId, userId }) {
    if (!db.inTransaction) throw new Error('numbering.issue يجب أن يُستدعى داخل معاملة المستند');
    const s = seriesById.get(seriesId);
    if (!s || s.doc_type !== docType) throw new HttpError(409, 'NO_SERIES', 'سلسلة الترقيم غير صالحة لهذا المستند', { docType });
    if (s.is_active !== 1) throw new HttpError(409, 'SERIES_INACTIVE', 'سلسلة الترقيم معطّلة', { series: s.code });
    const branch = branchRow.get(branchId);
    const fy = yearRow.get(fiscalYearId);
    if (!branch || !fy) throw new HttpError(409, 'NO_SERIES', 'الفرع أو السنة المالية غير موجودين');
    const year = Number(fy.start_date.slice(0, 4));
    const branchKey = s.per_branch ? branch.id : 0;
    const yearKey = s.reset_yearly ? year : 0;
    const seq = bump.get(s.id, branchKey, yearKey).last_value;
    const number = format(s, branch.code, year, seq);
    try {
      record.run(s.id, branchKey, yearKey, seq, number, docType, sourceId, branch.id, fy.id, userId);
    } catch (e) {
      // النص نفسه صدر من قبل (مثلًا: فرع أخذ كودًا كان لفرع آخر). لا يتكرر رقم أبدًا؛ تُلغى العملية كلها.
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'NUMBER_CONFLICT', 'نص رقم المستند صدر من قبل؛ لم يُرحَّل شيء', { number });
      throw e;
    }
    return { seriesId: s.id, seq, number };
  }

  return { issue, seriesFor, format };
}

module.exports = { createNumbering };

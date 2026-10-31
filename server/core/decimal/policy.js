'use strict';
const { Dec } = require('./engine');
const { DecimalError } = require('../errors');

/**
 * سياسة الدقة المركزية. أربعة مستويات منفصلة:
 *  1) storageScale  : أقصى خانات عشرية تُخزَّن (ثابت في الكود + قيد CHECK في القاعدة). تغييره = ترحيل، لا إعداد.
 *  2) دقة الحساب الوسيط: 120 رقمًا معنويًا (engine.js) — ثابتة.
 *  3) commitScale   : خانات التقريب عند اعتماد العملية (≤ storageScale) — قابلة للتخصيص حسب النوع والعملة.
 *  4) displayScale  : خانات العرض في الشاشات والتقارير (≤ commitScale) — قابلة للتخصيص.
 * maxIntegerDigits: حد الأرقام الصحيحة المخزَّنة؛ يضمن أن الضرب بين قيمتين مسموحتين يبقى دقيقًا.
 */
const KINDS = Object.freeze({
  amount:     Object.freeze({ storageScale: 8,  maxIntegerDigits: 20, defaultDisplay: 2 }),   // المبالغ المالية
  quantity:   Object.freeze({ storageScale: 8,  maxIntegerDigits: 20, defaultDisplay: 3 }),   // الكميات
  unit_price: Object.freeze({ storageScale: 10, maxIntegerDigits: 20, defaultDisplay: 4 }),   // أسعار الوحدات
  fx_rate:    Object.freeze({ storageScale: 12, maxIntegerDigits: 12, defaultDisplay: 6 }),   // أسعار الصرف
  rate:       Object.freeze({ storageScale: 8,  maxIntegerDigits: 12, defaultDisplay: 2 }),   // نسب الضرائب والخصومات (كنسبة مئوية: 14 = 14%)
  unit_cost:  Object.freeze({ storageScale: 10, maxIntegerDigits: 20, defaultDisplay: 4 }),   // تكاليف الإنتاج وتكلفة الوحدة
});

const ROUNDING = Object.freeze({
  HALF_UP: Dec.ROUND_HALF_UP,       // الأقرب، والمتساوي بعيدًا عن الصفر (2.5→3، -2.5→-3) — الافتراضي المحاسبي
  HALF_EVEN: Dec.ROUND_HALF_EVEN,   // تقريب المصرفيين (2.5→2، 3.5→4)
  HALF_DOWN: Dec.ROUND_HALF_DOWN,
  UP: Dec.ROUND_UP,                 // بعيدًا عن الصفر
  DOWN: Dec.ROUND_DOWN,             // نحو الصفر (اقتطاع)
  CEIL: Dec.ROUND_CEIL,
  FLOOR: Dec.ROUND_FLOOR,
});

const CURRENCY_RE = /^[A-Z]{3}$/;

function kindInfo(kind) {
  const k = Object.prototype.hasOwnProperty.call(KINDS, kind) ? KINDS[kind] : null;
  if (!k) throw new DecimalError('UNKNOWN_KIND', `نوع قيمة غير معروف: ${kind}`);
  return k;
}

function defaultRows() {
  return Object.entries(KINDS).map(([kind, k]) => ({ kind, currency: '', commitScale: k.storageScale, displayScale: k.defaultDisplay, rounding: 'HALF_UP' }));
}

/** يتحقق من صف واحد ويعيد قائمة أخطاء (فارغة = سليم). */
function validateRow(r) {
  const errs = [];
  if (!r || !Object.prototype.hasOwnProperty.call(KINDS, r.kind)) return ['UNKNOWN_KIND'];
  const k = KINDS[r.kind];
  if (typeof r.currency !== 'string' || (r.currency !== '' && !CURRENCY_RE.test(r.currency))) errs.push('BAD_CURRENCY');
  if (!Number.isInteger(r.commitScale) || r.commitScale < 0 || r.commitScale > k.storageScale) errs.push('COMMIT_SCALE_RANGE');
  if (!Number.isInteger(r.displayScale) || r.displayScale < 0 || r.displayScale > r.commitScale) errs.push('DISPLAY_SCALE_RANGE');
  if (!Object.prototype.hasOwnProperty.call(ROUNDING, r.rounding)) errs.push('BAD_ROUNDING');
  return errs;
}

/** يبني سياسة غير قابلة للتعديل من صفوف. يجب وجود صف افتراضي (currency='') لكل نوع. */
function createPolicy(rows = defaultRows()) {
  const map = new Map();
  for (const r of rows) {
    const errs = validateRow(r);
    if (errs.length) throw new DecimalError('BAD_POLICY', `سياسة دقة غير صالحة (${r && r.kind}/${r && r.currency}): ${errs.join(',')}`);
    const key = `${r.kind}|${r.currency}`;
    if (map.has(key)) throw new DecimalError('BAD_POLICY', `صف سياسة مكرر: ${key}`);
    map.set(key, Object.freeze({ kind: r.kind, currency: r.currency, commitScale: r.commitScale, displayScale: r.displayScale, rounding: r.rounding }));
  }
  for (const kind of Object.keys(KINDS)) {
    if (!map.has(`${kind}|`)) throw new DecimalError('BAD_POLICY', `لا توجد سياسة افتراضية للنوع ${kind}`);
  }
  return Object.freeze({
    rows: () => [...map.values()],
    /** سياسة العملة إن وُجدت، وإلا الافتراضي للنوع. */
    resolve(kind, currency = '') {
      const k = kindInfo(kind);
      const r = (currency && map.get(`${kind}|${currency}`)) || map.get(`${kind}|`);
      return { ...r, currency: currency || '', storageScale: k.storageScale, maxIntegerDigits: k.maxIntegerDigits };
    },
  });
}

module.exports = { KINDS, ROUNDING, CURRENCY_RE, kindInfo, defaultRows, validateRow, createPolicy };

'use strict';
const DecimalLib = require('decimal.js');
const { DecimalError } = require('../errors');

/**
 * محرك الحساب العشري الدقيق (Decimal Engine) — الطبقة الحسابية الخالصة.
 *
 * قواعد صارمة:
 *  - لا Number في أي عملية مالية: المدخلات نصوص عشرية (أو أعداد صحيحة آمنة فقط) والمخرجات Decimal/نص.
 *  - الجمع والطرح والضرب دقيقة تمامًا: دقة الحساب الوسيط 120 رقمًا معنويًا تكفي ناتج ضرب قيمتين
 *    مسموحتين (حتى 20 رقمًا صحيحًا + 12 عشريًا لكلٍّ منهما = 64 رقمًا).
 *    قبل كل عملية يُحسب الحد الأعلى للأرقام اللازمة للناتج الدقيق؛ إن تجاوز 120 والمعاملان قيمتان
 *    دقيقتان نرمي PRECISION_OVERFLOW بدل إرجاع رقم مقرَّب بصمت (يفشل آمنًا).
 *  - القسمة وحدها غير منتهية بطبيعتها (1÷3)، فتُقرَّب عند 120 رقمًا معنويًا (خطأ نسبي < 10^-119).
 *    ناتجها قيمة وسيطة مقرَّبة أصلًا؛ العمليات التالية عليها تبقى بنفس الدقة الوسيطة، ثم يجب اعتماد
 *    الناتج النهائي عبر round()/commit() حسب سياسة نوع القيمة قبل أي تخزين أو مقارنة.
 *  - لا يوجد هنا أي API يقرّب لعدد خانات يختاره المستدعي؛ التقريب يمر فقط بسياسة الدقة المركزية (policy.js).
 */

const INTERMEDIATE_PRECISION = 120;

// نسخة معزولة من المكتبة: لا تتأثر بأي إعداد عام قد تغيّره مكتبة أخرى.
const Dec = DecimalLib.clone({
  precision: INTERMEDIATE_PRECISION,
  rounding: DecimalLib.ROUND_HALF_EVEN,   // تقريب الحساب الوسيط (القسمة فقط) — لا أثر عملي عند 120 رقمًا
  toExpNeg: -9e15,
  toExpPos: 9e15,
  minE: -9e15,
  maxE: 9e15,
  crypto: false,
});

const MAX_INPUT_LENGTH = 80;
const DECIMAL_RE = /^[+-]?\d+(\.\d+)?$/;
const CANONICAL_RE = /^-?(0|[1-9]\d*)(\.\d*[1-9])?$/;

function parse(v) {
  if (v instanceof Dec) return v;
  if (typeof v === 'bigint') return new Dec(v.toString());
  if (typeof v === 'number') {
    // عدد صحيح آمن فقط (ممثَّل بدقة). الكسور العشرية كـ Number ممنوعة: 0.1 ليست 0.1 داخل Number.
    if (Number.isSafeInteger(v)) return new Dec(v);
    throw new DecimalError('NUMBER_NOT_ALLOWED', 'لا يُقبل Number كسري أو خارج النطاق الآمن؛ مرّر القيمة نصًا عشريًا');
  }
  if (typeof v !== 'string') throw new DecimalError('INVALID_DECIMAL', 'قيمة عشرية غير صالحة');
  if (v.length > MAX_INPUT_LENGTH || !DECIMAL_RE.test(v)) throw new DecimalError('INVALID_DECIMAL', 'قيمة عشرية غير صالحة');
  return new Dec(v);
}

const intDigits = (d) => (d.isZero() ? 0 : Math.max(0, d.e + 1));
// ناتج قسمة غير منتهية يملأ الدقة الوسيطة بالكامل: هو تقريب وسيط وليس قيمة دقيقة.
const isIntermediate = (d) => !d.isZero() && d.sd(true) >= INTERMEDIATE_PRECISION;

/**
 * يرمي إن كان الناتج الدقيق لمعاملين دقيقين يحتاج أكثر من الدقة الوسيطة (كان سيُقرَّب بصمت).
 * needed = حد أعلى لعدد أرقام الناتج الدقيق.
 */
function guard(x, y, needed) {
  if (needed > INTERMEDIATE_PRECISION && !isIntermediate(x) && !isIntermediate(y)) {
    throw new DecimalError('PRECISION_OVERFLOW', 'الناتج يتجاوز دقة الحساب الوسيط');
  }
}
const addNeeded = (x, y) => Math.max(intDigits(x), intDigits(y)) + 1 + Math.max(x.decimalPlaces(), y.decimalPlaces());

function finite(r) {
  if (!r.isFinite()) throw new DecimalError('OUT_OF_RANGE', 'ناتج خارج النطاق');
  return r;
}
function add(a, b) { const x = parse(a); const y = parse(b); guard(x, y, addNeeded(x, y)); return finite(x.plus(y)); }
function sub(a, b) { const x = parse(a); const y = parse(b); guard(x, y, addNeeded(x, y)); return finite(x.minus(y)); }
function mul(a, b) { const x = parse(a); const y = parse(b); guard(x, y, x.sd(true) + y.sd(true)); return finite(x.times(y)); }

function div(a, b) {
  const d = parse(b);
  if (d.isZero()) throw new DecimalError('DIVISION_BY_ZERO', 'قسمة على صفر');
  const r = parse(a).div(d);
  if (!r.isFinite()) throw new DecimalError('OUT_OF_RANGE', 'ناتج خارج النطاق');
  return r;
}

function sum(values) {
  let t = new Dec(0);
  for (const v of values) t = add(t, v);
  return t;
}

const neg = (a) => parse(a).neg();
const abs = (a) => parse(a).abs();
/** مقارنة دقيقة: -1 أو 0 أو 1 — بلا تحويل إلى Number. */
const cmp = (a, b) => parse(a).cmp(parse(b));
const eq = (a, b) => cmp(a, b) === 0;
const lt = (a, b) => cmp(a, b) < 0;
const lte = (a, b) => cmp(a, b) <= 0;
const gt = (a, b) => cmp(a, b) > 0;
const gte = (a, b) => cmp(a, b) >= 0;
const isZero = (a) => parse(a).isZero();
const isNegative = (a) => { const d = parse(a); return !d.isZero() && d.isNeg(); };
const min = (...xs) => xs.map(parse).reduce((m, x) => (x.lt(m) ? x : m));
const max = (...xs) => xs.map(parse).reduce((m, x) => (x.gt(m) ? x : m));

/** الشكل القانوني: بلا أس، بلا أصفار زائدة، بلا "-0"، بلا أصفار بادئة. قيمتان متساويتان ⇔ نصان متطابقان. */
function canonical(a) {
  const d = parse(a);
  return d.isZero() ? '0' : d.toFixed();
}

const isCanonical = (s) => typeof s === 'string' && s.length <= MAX_INPUT_LENGTH && CANONICAL_RE.test(s);

/** عدد الخانات العشرية الفعلية وعدد الأرقام الصحيحة — للتحقق من حدود التخزين. */
function shape(a) {
  const d = parse(a);
  const [intPart] = d.abs().toFixed().split('.');
  return { scale: d.decimalPlaces(), integerDigits: intPart === '0' ? 0 : intPart.length };
}

module.exports = {
  Dec, INTERMEDIATE_PRECISION, MAX_INPUT_LENGTH,
  parse, add, sub, mul, div, sum, neg, abs, cmp, eq, lt, lte, gt, gte, isZero, isNegative, min, max,
  canonical, isCanonical, shape,
};

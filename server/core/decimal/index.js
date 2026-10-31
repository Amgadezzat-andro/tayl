'use strict';
const engine = require('./engine');
const { KINDS, ROUNDING, kindInfo, createPolicy, defaultRows, validateRow } = require('./policy');
const { DecimalError } = require('../errors');

const { Dec, parse } = engine;

/**
 * خدمة الدقة المركزية التي تستخدمها كل الوحدات (services.decimal).
 * الحساب الخالص من engine.js، والتقريب/التخزين/العرض يمر حصريًا بالسياسة المركزية.
 */
function createDecimalService(initialPolicy = createPolicy()) {
  let policy = initialPolicy;

  /**
   * لقطة من السياسة المركزية لنوع وعملة. المستند المعتمد يحفظ لقطته (commitScale/rounding)،
   * فإعادة حسابه لاحقًا تعطي نفس النتيجة حتى لو تغيّرت السياسة بعد اعتماده.
   */
  const snapshot = (kind, currency) => Object.freeze(policy.resolve(kind, currency));

  /** السياسة الفعلية: الحالية، أو لقطة سابقة (يُتحقق منها فلا تمر قواعد غير صالحة). */
  function effective(kind, currency, snap) {
    if (!snap) return policy.resolve(kind, currency);
    const errs = validateRow({ ...snap, currency: snap.currency || '' });
    if (errs.length || snap.kind !== kind) throw new DecimalError('BAD_POLICY', 'لقطة سياسة غير صالحة');
    return { ...snap, storageScale: KINDS[kind].storageScale, maxIntegerDigits: KINDS[kind].maxIntegerDigits };
  }

  /** تقريب الاعتماد: commitScale + قاعدة التقريب حسب النوع والعملة (أو لقطة سياسة محفوظة). */
  function round(x, kind, currency, snap) {
    const p = effective(kind, currency, snap);
    return parse(x).toDecimalPlaces(p.commitScale, ROUNDING[p.rounding]);
  }

  /**
   * تحويل للتخزين في SQLite كنص قانوني. لا تقريب صامت هنا أبدًا:
   * قيمة بخانات أكثر من storageScale تُرفض (يجب اعتمادها بـ round/commit أولًا).
   */
  function toStorage(x, kind) {
    const k = kindInfo(kind);
    const s = engine.shape(x);
    if (s.scale > k.storageScale) throw new DecimalError('SCALE_EXCEEDED', `خانات عشرية (${s.scale}) أكثر من المسموح تخزينه للنوع ${kind} (${k.storageScale})`);
    if (s.integerDigits > k.maxIntegerDigits) throw new DecimalError('OUT_OF_RANGE', `القيمة أكبر من الحد المسموح للنوع ${kind}`);
    return engine.canonical(x);
  }

  /** اعتماد + تخزين: الطريق القياسي لحفظ أي قيمة محسوبة. */
  const commit = (x, kind, currency, snap) => toStorage(round(x, kind, currency, snap), kind);

  /** قراءة من القاعدة: يرفض أي نص غير قانوني (يكشف التلف أو الكتابة من خارج المحرك). */
  function fromStorage(s, kind) {
    if (!engine.isCanonical(s)) throw new DecimalError('CORRUPT_VALUE', 'قيمة مخزنة ليست بالشكل العشري القانوني');
    toStorage(s, kind);
    return parse(s);
  }

  /** للعرض فقط: displayScale + تجميع الآلاف. الناتج نص، ولا يُستخدم في أي حساب. */
  function format(x, kind, currency, { grouping = true } = {}) {
    const p = policy.resolve(kind, currency);
    let s = parse(x).toFixed(p.displayScale, ROUNDING[p.rounding]);
    if (/^-0(\.0*)?$/.test(s)) s = s.slice(1);
    if (!grouping) return s;
    const negSign = s.startsWith('-') ? '-' : '';
    const [i, f] = s.replace('-', '').split('.');
    return negSign + i.replace(/\B(?=(\d{3})+(?!\d))/g, ',') + (f ? '.' + f : '');
  }

  /**
   * اتزان المدين والدائن بدقة كاملة: متزن فقط إذا كان الفرق صفرًا تمامًا. لا يوجد هامش سماح.
   * القيم يجب أن تكون معتمدة (مقرَّبة حسب السياسة) قبل المقارنة.
   */
  function balance(debits, credits) {
    const totalDebit = engine.sum(debits);
    const totalCredit = engine.sum(credits);
    const difference = totalDebit.minus(totalCredit);
    return { balanced: difference.isZero(), totalDebit: engine.canonical(totalDebit), totalCredit: engine.canonical(totalCredit), difference: engine.canonical(difference) };
  }

  /**
   * توزيع مبلغ على أوزان بحيث يساوي مجموع الأجزاء المبلغ الأصلي تمامًا (طريقة أكبر الباقي).
   * فروق التقريب تذهب لأكبر الكسور المتبقية (والتعادل للأسبق)، فلا يضيع ولا يُخلق أي جزء من الوحدة.
   */
  function allocate(total, weights, kind, currency, snap) {
    const p = effective(kind, currency, snap);
    const t = parse(total);
    if (!t.eq(t.toDecimalPlaces(p.commitScale))) throw new DecimalError('NOT_COMMITTED', 'المبلغ المراد توزيعه يجب أن يكون معتمدًا حسب السياسة أولًا');
    if (!Array.isArray(weights) || !weights.length) throw new DecimalError('BAD_WEIGHTS', 'لا توجد أوزان للتوزيع');
    const w = weights.map(parse);
    if (w.some((x) => x.isNeg() && !x.isZero())) throw new DecimalError('BAD_WEIGHTS', 'الأوزان لا تكون سالبة');
    const W = engine.sum(w);
    if (W.isZero()) throw new DecimalError('DIVISION_BY_ZERO', 'مجموع الأوزان صفر');

    const unit = new Dec(10).pow(p.commitScale);
    const T = t.abs().times(unit);                     // عدد صحيح من أصغر وحدة
    const raw = w.map((x) => T.times(x).div(W));
    const base = raw.map((r) => r.floor());
    let rest = T.minus(engine.sum(base));
    const order = raw.map((r, i) => ({ i, frac: r.minus(base[i]) })).sort((a, b) => b.frac.cmp(a.frac) || a.i - b.i);
    for (const o of order) {
      if (rest.lte(0)) break;
      base[o.i] = base[o.i].plus(1);
      rest = rest.minus(1);
    }
    const sign = t.isNeg() ? -1 : 1;
    return base.map((b) => engine.canonical(b.div(unit).times(sign)));
  }

  /**
   * النسب (الضرائب والخصومات) تُخزَّن كنسبة مئوية: 14 تعني 14%.
   * percentOf يعيد قيمة النسبة من الأساس **دون تقريب** (القسمة على 100 منتهية دائمًا فلا فقد)،
   * ثم يُعتمد الناتج بسياسة المبالغ: commit(percentOf(base, rate), 'amount', currency).
   */
  const percentOf = (base, ratePercent) => engine.mul(base, engine.div(ratePercent, '100'));
  /** يرفض نسبة سالبة أو أكبر من 100% (لنسب الضرائب والخصومات). */
  function assertPercent(ratePercent) {
    if (engine.lt(ratePercent, '0') || engine.gt(ratePercent, '100')) throw new DecimalError('RATE_OUT_OF_RANGE', 'النسبة يجب أن تكون بين 0 و100');
    return parse(ratePercent);
  }
  /** عرض النسبة: "14.00%". */
  const formatPercent = (ratePercent, currency) => format(ratePercent, 'rate', currency, { grouping: false }) + '%';

  return {
    ...engine,
    KINDS, ROUNDING,
    round, toStorage, commit, fromStorage, format, balance, allocate,
    snapshot, percentOf, assertPercent, formatPercent,
    policy: () => policy,
    setPolicy(p) { policy = p; },
  };
}

module.exports = { createDecimalService, createPolicy, defaultRows, validateRow, KINDS, ROUNDING, engine };

'use strict';
const engine = require('./engine');

/**
 * دوال SQLite دقيقة تُسجَّل على اتصال القاعدة.
 * سبب وجودها: SUM/AVG في SQLite تحوّل النصوص إلى REAL (فاصلة عائمة):
 *   SUM('0.1','0.2') = 0.30000000000000004
 * لذلك الجمع/المقارنة لأعمدة القيم العشرية تتم بـ dec_sum / dec_cmp / dec_add فقط.
 */
function registerDecimalSql(db) {
  db.aggregate('dec_sum', {
    start: () => engine.parse('0'),
    step: (total, v) => (v == null ? total : engine.add(total, strict(v))),
    result: (total) => engine.canonical(total),
    deterministic: true,
  });
  db.function('dec_cmp', { deterministic: true }, (a, b) => engine.cmp(strict(a), strict(b)));
  // [م6] جمع قيمتين بدقة: تحديث ملخصات المخزون داخل trigger حركة المخزون (inv_moves_apply)
  db.function('dec_add', { deterministic: true }, (a, b) => engine.canonical(engine.add(strict(a), strict(b))));
}

function strict(v) {
  if (!engine.isCanonical(v)) throw new Error('dec: قيمة ليست نصًا عشريًا قانونيًا');
  return v;
}

module.exports = { registerDecimalSql };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createDecimalService, createPolicy, defaultRows, KINDS } = require('../server/core/decimal');

const D = createDecimalService();
const S = (x) => D.canonical(x);

// ── مرجع مستقل للتحقق: حساب دقيق بأعداد BigInt صحيحة (لا يعتمد على decimal.js إطلاقًا) ──
function big(str) {
  const neg = str.startsWith('-');
  const [i, f = ''] = str.replace(/^[+-]/, '').split('.');
  const n = BigInt(i + f);
  return { n: neg ? -n : n, s: f.length };
}
const pow10 = (k) => 10n ** BigInt(k);
const align = (a, b) => { const s = Math.max(a.s, b.s); return [a.n * pow10(s - a.s), b.n * pow10(s - b.s), s]; };
const oAdd = (a, b) => { const [x, y, s] = align(a, b); return { n: x + y, s }; };
const oSub = (a, b) => { const [x, y, s] = align(a, b); return { n: x - y, s }; };
const oMul = (a, b) => ({ n: a.n * b.n, s: a.s + b.s });
function oStr({ n, s }) {
  const neg = n < 0n; let d = (neg ? -n : n).toString().padStart(s + 1, '0');
  let out = s ? d.slice(0, d.length - s) + '.' + d.slice(d.length - s) : d;
  if (out.includes('.')) out = out.replace(/0+$/, '').replace(/\.$/, '');
  return out === '0' ? '0' : (neg ? '-' : '') + out;
}
function oRound({ n, s }, d, mode) {
  if (s <= d) return { n, s };
  const div = pow10(s - d); let q = n / div; const r = n % div;   // BigInt: قسمة نحو الصفر
  const twice = (r < 0n ? -r : r) * 2n; const sign = n < 0n ? -1n : 1n;
  if (mode === 'HALF_UP' && twice >= div) q += sign;
  if (mode === 'HALF_EVEN' && (twice > div || (twice === div && (q % 2n !== 0n)))) q += sign;
  if (mode === 'DOWN') { /* اقتطاع */ }
  return { n: q, s: d };
}

// مولّد عشوائي بذرة ثابتة (نتائج قابلة للإعادة)
function rng(seed) { return () => { seed = (seed + 0x6D2B79F5) | 0; let t = Math.imul(seed ^ (seed >>> 15), 1 | seed); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
function randDec(r, maxInt = 20, maxFrac = 12) {
  const digits = (k) => Array.from({ length: k }, () => Math.floor(r() * 10)).join('');
  const i = digits(1 + Math.floor(r() * maxInt)).replace(/^0+(?=\d)/, '');
  const fl = Math.floor(r() * (maxFrac + 1));
  return (r() < 0.4 ? '-' : '') + i + (fl ? '.' + digits(fl) : '');
}

test('decimal: 0.1 + 0.2 = 0.3 تمامًا (بخلاف Number)', () => {
  assert.equal(S(D.add('0.1', '0.2')), '0.3');
  assert.notEqual(0.1 + 0.2, 0.3);   // توثيق المشكلة التي يمنعها المحرك
});

test('decimal: مطابقة مرجع BigInt في 5000 عملية جمع/طرح/ضرب عشوائية', () => {
  const r = rng(20261031);
  for (let k = 0; k < 5000; k++) {
    const a = randDec(r); const b = randDec(r);
    assert.equal(S(D.add(a, b)), oStr(oAdd(big(a), big(b))), `${a} + ${b}`);
    assert.equal(S(D.sub(a, b)), oStr(oSub(big(a), big(b))), `${a} - ${b}`);
    assert.equal(S(D.mul(a, b)), oStr(oMul(big(a), big(b))), `${a} × ${b}`);
  }
});

test('decimal: تقريب الاعتماد يطابق المرجع (HALF_UP و HALF_EVEN و DOWN) في 3000 حالة', () => {
  const r = rng(7);
  for (const mode of ['HALF_UP', 'HALF_EVEN', 'DOWN']) {
    const svc = createDecimalService(createPolicy(defaultRows().map((x) => ({ ...x, rounding: mode }))));
    for (let k = 0; k < 1000; k++) {
      const a = randDec(r, 12, 20);
      assert.equal(S(svc.round(a, 'amount')), oStr(oRound(big(a), 8, mode)), `${mode} ${a}`);
    }
  }
});

test('decimal: أرقام كبيرة جدًا وصغيرة جدًا بلا فقد', () => {
  assert.equal(S(D.add('99999999999999999999.99999999', '0.00000001')), '100000000000000000000');
  assert.equal(S(D.mul('12345678901234567890.123456789012', '98765432109876543210.987654321098')),
    oStr(oMul(big('12345678901234567890.123456789012'), big('98765432109876543210.987654321098'))));
  assert.equal(S(D.mul('0.00000001', '0.0000000001')), '0.000000000000000001');
  assert.equal(S(D.round(D.mul('0.00000001', '0.0000000001'), 'amount')), '0');   // يصغر عن دقة المبالغ
  assert.equal(S(D.sub('0.000000000001', '0.000000000001')), '0');
});

test('decimal: عمليات متتابعة طويلة لا تراكم خطأ', () => {
  let t = D.parse('0');
  for (let i = 0; i < 10000; i++) t = D.add(t, '0.01');
  assert.equal(S(t), '100');
  let x = D.parse('1000000');
  for (let i = 0; i < 1000; i++) x = D.sub(D.add(x, '0.00000001'), '0.00000001');
  assert.equal(S(x), '1000000');
  let n = 0; for (let i = 0; i < 10000; i++) n += 0.01;
  assert.notEqual(n, 100);   // نفس الحلقة بـ Number تنحرف
});

test('decimal: القسمة — كسور لا تنتهي تُعتمد بالسياسة، والقسمة على صفر ترمي خطأ', () => {
  const third = D.div('1', '3');
  assert.equal(S(D.round(third, 'amount')), '0.33333333');
  assert.equal(S(D.round(D.mul(third, '3'), 'amount')), '1');
  assert.equal(S(D.div('10', '4')), '2.5');
  assert.equal(S(D.round(D.div('2', '3'), 'fx_rate')), '0.666666666667');
  for (const z of ['0', '-0', '0.000', 0]) assert.throws(() => D.div('1', z), (e) => e.code === 'DIVISION_BY_ZERO');
  assert.throws(() => D.div('0', '0'), (e) => e.code === 'DIVISION_BY_ZERO');
});

test('decimal: فروق التقريب وقواعده (بما فيها القيم السالبة)', () => {
  const up = createDecimalService(createPolicy(defaultRows().map((r) => (r.kind === 'amount' ? { ...r, commitScale: 2 } : r))));
  assert.equal(S(up.round('2.345', 'amount')), '2.35');
  assert.equal(S(up.round('-2.345', 'amount')), '-2.35');   // HALF_UP: المتساوي بعيدًا عن الصفر
  assert.equal(S(up.round('2.344999999', 'amount')), '2.34');
  const even = createDecimalService(createPolicy(defaultRows().map((r) => (r.kind === 'amount' ? { ...r, commitScale: 2, rounding: 'HALF_EVEN' } : r))));
  assert.equal(S(even.round('2.345', 'amount')), '2.34');
  assert.equal(S(even.round('2.355', 'amount')), '2.36');
  // تقريب البنود منفردة ≠ تقريب المجموع: المحرك يكشف الفرق ولا يخفيه
  const lines = ['0.005', '0.005', '0.005'].map((x) => up.round(x, 'amount'));
  assert.equal(S(D.sum(lines)), '0.03');
  assert.equal(S(up.round(D.sum(['0.005', '0.005', '0.005']), 'amount')), '0.02');
});

test('decimal: القيم السالبة والمقارنة دون Number', () => {
  assert.equal(S(D.sub('5', '7.25')), '-2.25');
  assert.equal(S(D.mul('-1.5', '-2')), '3');
  assert.equal(S(D.neg('0')), '0');                       // لا يوجد "-0"
  assert.equal(S(D.mul('-0.5', '0')), '0');
  assert.equal(D.cmp('-0.00000001', '0'), -1);
  assert.equal(D.cmp('100000000000000000000.00000001', '100000000000000000000'), 1);
  assert.ok(D.eq('1.10', '1.1'));
  assert.ok(D.isNegative('-0.1') && !D.isNegative('-0'));
  assert.equal(S(D.abs('-3.5')), '3.5');
  assert.equal(S(D.max('1', '-2', '1.0000000001')), '1.0000000001');
});

test('decimal: سعر وحدة × كمية = مبلغ بكسور طويلة يُعتمد مرة واحدة', () => {
  const price = '1.2345678901';   // 10 خانات (unit_price)
  const qty = '3.33333333';       // 8 خانات (quantity)
  const exact = D.mul(price, qty);
  assert.equal(S(exact), oStr(oMul(big(price), big(qty))));
  assert.equal(S(exact), '4.115226296218107033');   // مُتحقق منه أيضًا بـ Python decimal
  assert.equal(D.commit(exact, 'amount'), '4.1152263');
  // تكلفة وحدة = إجمالي ÷ كمية، ثم إعادة الضرب تعطي الإجمالي بعد الاعتماد
  const unitCost = D.round(D.div('1000', '3'), 'unit_cost');
  assert.equal(S(unitCost), '333.3333333333');
  assert.equal(D.commit(D.mul(unitCost, '3'), 'amount'), '1000');
});

test('decimal: اتزان المدين والدائن بدقة كاملة بلا هامش سماح', () => {
  assert.deepEqual(D.balance(['0.1', '0.2'], ['0.3']), { balanced: true, totalDebit: '0.3', totalCredit: '0.3', difference: '0' });
  const off = D.balance(['100.00000001'], ['100']);
  assert.equal(off.balanced, false);
  assert.equal(off.difference, '0.00000001');               // أصغر فرق ممكن يُكتشف
  const many = Array.from({ length: 1000 }, () => '0.01');
  assert.equal(D.balance(many, ['10']).balanced, true);
  assert.equal(D.balance(many, ['10.00000001']).balanced, false);
  assert.equal(D.balance([], []).balanced, true);
});

test('decimal: التوزيع (allocate) يحفظ المجموع تمامًا ويوزع فرق التقريب', () => {
  const parts = D.allocate('100', ['1', '1', '1'], 'amount');
  assert.deepEqual(parts, ['33.33333334', '33.33333333', '33.33333333']);
  assert.equal(S(D.sum(parts)), '100');
  const neg = D.allocate('-0.00000002', ['1', '1', '1'], 'amount');
  assert.equal(S(D.sum(neg)), '-0.00000002');
  const r = rng(99);
  for (let k = 0; k < 300; k++) {
    const total = D.round(randDec(r, 10, 8), 'amount');
    const w = Array.from({ length: 1 + Math.floor(r() * 9) }, () => D.abs(randDec(r, 4, 6)));
    if (D.isZero(D.sum(w))) continue;
    assert.equal(S(D.sum(D.allocate(total, w, 'amount'))), S(total));
  }
  assert.throws(() => D.allocate('1', ['0', '0'], 'amount'), (e) => e.code === 'DIVISION_BY_ZERO');
  assert.throws(() => D.allocate('1.000000001', ['1'], 'amount'), (e) => e.code === 'NOT_COMMITTED');
});

test('decimal: مدخلات مرفوضة — Number كسري، صيغ أسية، نصوص غير عشرية', () => {
  for (const bad of ['1e5', 'NaN', 'Infinity', '0x10', ' 1', '1.', '.5', '', '1,000', '١٢', '--1', '+', null, undefined, {}, '9'.repeat(81)]) {
    assert.throws(() => D.parse(bad), (e) => e.code === 'INVALID_DECIMAL', String(bad));
  }
  for (const n of [0.1, 1.5, 1e21, Number.MAX_SAFE_INTEGER + 2, NaN, Infinity]) assert.throws(() => D.parse(n), (e) => e.code === 'NUMBER_NOT_ALLOWED');
  assert.equal(S(D.parse(42)), '42');                         // عدد صحيح آمن مقبول (ممثل بدقة)
  assert.equal(S(D.parse(12345678901234567890n)), '12345678901234567890');
  assert.equal(S(D.parse('+007.500')), '7.5');
});

test('decimal: التخزين يرفض التقريب الصامت وتجاوز الحدود', () => {
  assert.throws(() => D.toStorage('1.123456789', 'amount'), (e) => e.code === 'SCALE_EXCEEDED');
  assert.equal(D.toStorage('1.12345678', 'amount'), '1.12345678');
  assert.throws(() => D.toStorage('100000000000000000000', 'amount'), (e) => e.code === 'OUT_OF_RANGE');     // 21 رقمًا
  assert.equal(D.toStorage('99999999999999999999.99999999', 'amount'), '99999999999999999999.99999999');
  assert.throws(() => D.toStorage('1', 'money'), (e) => e.code === 'UNKNOWN_KIND');
  assert.throws(() => D.fromStorage('1.50', 'amount'), (e) => e.code === 'CORRUPT_VALUE');                  // غير قانوني
  assert.throws(() => D.fromStorage('1e3', 'amount'), (e) => e.code === 'CORRUPT_VALUE');
  assert.equal(D.toStorage('-0.000', 'amount'), '0');
});

test('decimal: فصل الدقة — تخزين/اعتماد/عرض مستقلة', () => {
  const p = D.policy().resolve('amount');
  assert.deepEqual([p.storageScale, p.commitScale, p.displayScale], [8, 8, 2]);
  const v = '1234567.125';
  assert.equal(D.commit(v, 'amount'), '1234567.125');           // الاعتماد بـ 8 خانات لا يغيّر القيمة
  assert.equal(D.format(v, 'amount'), '1,234,567.13');           // العرض فقط بخانتين
  assert.equal(D.format('-0.001', 'amount'), '0.00');
  assert.equal(D.format('-1234.5', 'amount', '', { grouping: false }), '-1234.50');
  assert.deepEqual(Object.fromEntries(Object.entries(KINDS).map(([k, v2]) => [k, v2.storageScale])),
    { amount: 8, quantity: 8, unit_price: 10, fx_rate: 12, rate: 8, unit_cost: 10 });
});

test('decimal: السياسة حسب العملة، والتحقق من صحة السياسة', () => {
  const svc = createDecimalService(createPolicy([...defaultRows(), { kind: 'amount', currency: 'KWD', commitScale: 3, displayScale: 3, rounding: 'HALF_EVEN' }]));
  assert.equal(S(svc.round('1.23450', 'amount', 'KWD')), '1.234');
  assert.equal(S(svc.round('1.23450', 'amount', 'EGP')), '1.2345');   // يرجع للافتراضي
  assert.equal(svc.format('1.5', 'amount', 'KWD'), '1.500');
  const bad = (row) => assert.throws(() => createPolicy([...defaultRows().filter((r) => r.kind !== row.kind), row]), (e) => e.code === 'BAD_POLICY');
  bad({ kind: 'amount', currency: '', commitScale: 9, displayScale: 2, rounding: 'HALF_UP' });     // > التخزين
  bad({ kind: 'amount', currency: '', commitScale: 2, displayScale: 3, rounding: 'HALF_UP' });     // عرض > اعتماد
  bad({ kind: 'amount', currency: '', commitScale: 2, displayScale: 2, rounding: 'ROUND' });
  bad({ kind: 'amount', currency: 'eg', commitScale: 2, displayScale: 2, rounding: 'HALF_UP' });
  assert.throws(() => createPolicy(defaultRows().slice(1)), (e) => e.code === 'BAD_POLICY');       // نوع بلا افتراضي
});

test('decimal: فقد الدقة المحتمل يُرفض بدل التقريب الصامت', () => {
  const huge = '9'.repeat(70);
  assert.throws(() => D.mul(huge, huge), (e) => e.code === 'PRECISION_OVERFLOW');
  assert.throws(() => D.add('1' + '0'.repeat(70), '0.' + '0'.repeat(55) + '1'), (e) => e.code === 'PRECISION_OVERFLOW');
  // ناتج القسمة قيمة وسيطة: سلسلة عمليات عليه مسموحة، ويُعتمد الناتج النهائي بالسياسة
  const q = D.div('2', '7');
  assert.equal(D.commit(D.add(D.mul(q, '7'), '0'), 'amount'), '2');
  assert.equal(D.commit(D.mul(D.div('1', '3'), D.div('1', '3')), 'amount'), '0.11111111');
});

test('decimal: كود المحرك لا يحوّل إلى Number ولا يستخدم parseFloat', () => {
  for (const f of ['engine.js', 'index.js', 'policy.js', 'sql.js']) {
    const src = fs.readFileSync(path.join(__dirname, '..', 'server/core/decimal', f), 'utf8');
    assert.ok(!/parseFloat|toNumber\(|Number\(|\+\s*value|Math\.round/.test(src), `استخدام Number في ${f}`);
  }
});

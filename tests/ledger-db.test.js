'use strict';
/* المرحلة 3 (الدفعة 3.1): الحماية داخل SQLite — اختبارات SQL مباشرة دون الخادم (مصفوفة الحماية، القسم 9 من المقترح). */
const test = require('node:test');
const assert = require('node:assert/strict');
const Database = require('better-sqlite3');
const { startReady } = require('./helpers');
const { ok, seedLedger, draft, postEntry, postNew } = require('./ledger-helpers');

const rejects = (fn, re) => assert.throws(fn, re);
const snapshot = (db) => JSON.stringify(['journal_entries', 'journal_lines', 'gl_entries', 'issued_numbers', 'document_counters']
  .map((t) => db.prepare(`SELECT * FROM ${t} ORDER BY 1`).all()));

test('ledger-db: القيد المرحّل وسطوره والأستاذ والأرقام الصادرة والعدادات لا تُعدَّل ولا تُحذف', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const p = await postNew(s, seed, [{ accountId: seed.acc.cash.id, debit: '100' }, { accountId: seed.acc.sales.id, credit: '100' }]);
  const db = s.app.db;
  const before = snapshot(db);
  rejects(() => db.prepare("UPDATE journal_entries SET description = 'x' WHERE id = ?").run(p.id), /posted journal entries cannot be modified/);
  rejects(() => db.prepare("UPDATE journal_entries SET status = 'draft', number = NULL WHERE id = ?").run(p.id), /cannot be modified/);
  rejects(() => db.prepare('DELETE FROM journal_entries WHERE id = ?').run(p.id), /cannot be deleted/);
  rejects(() => db.prepare("UPDATE journal_lines SET debit_fc = '200', debit = '200' WHERE entry_id = ?").run(p.id), /lines of a posted journal entry/);
  rejects(() => db.prepare('DELETE FROM journal_lines WHERE entry_id = ?').run(p.id), /lines of a posted journal entry/);
  rejects(() => db.prepare("INSERT INTO journal_lines (entry_id, line_no, account_id, currency_id, rate, rate_source, debit_fc, debit) VALUES (?, 9, ?, ?, '1', 'base', '5', '5')")
    .run(p.id, seed.acc.cash.id, seed.egp.id), /lines of a posted journal entry/);
  rejects(() => db.prepare("UPDATE gl_entries SET debit = '999' WHERE debit <> '0'").run(), /append-only/);
  rejects(() => db.prepare('DELETE FROM gl_entries').run(), /append-only/);
  rejects(() => db.prepare("UPDATE issued_numbers SET number = 'X-1'").run(), /permanent/);
  rejects(() => db.prepare('DELETE FROM issued_numbers').run(), /permanent/);
  rejects(() => db.prepare('UPDATE document_counters SET last_value = last_value - 1').run(), /only move forward/);
  rejects(() => db.prepare('UPDATE document_counters SET last_value = last_value + 2').run(), /only move forward/);
  rejects(() => db.prepare('DELETE FROM document_counters').run(), /cannot be deleted/);
  assert.equal(snapshot(db), before);                                                      // لم يتغير شيء
});

test('ledger-db: NOT NULL وصيغة الصفر الواحدة وشرط الطرف الواحد لا تُتجاوز بـ SQL مباشر', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '10' }]));
  const db = s.app.db;
  const ins = (o) => db.prepare(`INSERT INTO journal_lines (entry_id, line_no, account_id, currency_id, rate, rate_source, debit_fc, credit_fc, debit, credit, rate_id, rate_reason, rate_set_by, rate_set_at)
    VALUES (@e, @n, @a, @c, @rate, @src, @dfc, @cfc, @d, @cr, @rid, @why, @by, @at)`).run({
    e: d.id, n: 50, a: seed.acc.cash.id, c: seed.egp.id, rate: '1', src: 'base', dfc: '5', cfc: '0', d: '0', cr: '0', rid: null, why: null, by: null, at: null, ...o });
  // NULL في الأعمدة الإلزامية
  for (const k of ['rate', 'src', 'dfc', 'cfc', 'd', 'cr', 'a']) rejects(() => ins({ [k]: null }), /NOT NULL/, k);
  rejects(() => ins({ c: null }), /NOT NULL|base-currency lines only/);              // trigger السعر يسبق فحص NOT NULL؛ مرفوض في الحالتين
  // صيغ بديلة للصفر وقيم غير قانونية
  for (const v of ['0.0', '0.00', '00', '-0', '+0', ' 0', '0.', '-5', 'abc', '', '1e5', '01', '1.50', '1,000', '١٢', '0.000000001', '123456789012345678901'])
    rejects(() => ins({ dfc: v }), /CHECK constraint/, `debit_fc=${JSON.stringify(v)}`);
  rejects(() => ins({ dfc: 0 }), /cannot store INTEGER value in TEXT column|CHECK constraint/);     // STRICT: الرقم ليس نصًا
  // الطرف الواحد: صفر في الطرفين (بأي صيغة)، أو قيمة في الطرفين
  rejects(() => ins({ dfc: '0.0', cfc: '0' }), /CHECK constraint/);
  rejects(() => ins({ dfc: '0', cfc: '0' }), /CHECK constraint/);
  rejects(() => ins({ dfc: '5', cfc: '5' }), /CHECK constraint/);
  // المبلغ الأساسي في الطرف المعاكس للأصلي
  rejects(() => ins({ dfc: '5', cr: '5' }), /CHECK constraint/);
  // اتساق مصدر السعر
  const usdLine = { c: seed.usd.id, rate: '48' };                                               // سطر أجنبي ليعزل CHECK عن trigger العملة
  rejects(() => ins({ ...usdLine, src: 'manual' }), /CHECK constraint/);                         // يدوي بلا سبب/مستخدم/توقيت
  rejects(() => ins({ ...usdLine, src: 'manual', why: 'سبب كافٍ', by: 1, at: null }), /CHECK constraint/);
  rejects(() => ins({ ...usdLine, src: 'manual', why: 'سب', by: 1, at: 'now' }), /CHECK constraint/);   // سبب قصير
  rejects(() => ins({ ...usdLine, src: 'table' }), /CHECK constraint|table rate must reference/);   // جدول بلا rate_id (trigger أو CHECK)
  rejects(() => ins({ src: 'base', rate: '2' }), /CHECK constraint/);                            // base بسعر ≠ 1
  rejects(() => ins({ c: seed.usd.id }), /rate source base is for base-currency lines only/);    // base بعملة أجنبية
  rejects(() => ins({ src: 'manual', rate: '48', why: 'سبب كافٍ', by: 1, at: '2026-01-01T00:00:00Z' }), /rate source base is for base-currency/); // يدوي للعملة الأساسية
  const otherRate = s.app.db.prepare('SELECT id FROM exchange_rates WHERE currency_id = ?').get(seed.eur.id).id;
  rejects(() => ins({ c: seed.usd.id, src: 'table', rate: '53.9', rid: otherRate }), /table rate must reference a rate row of the same currency/);
  rejects(() => ins({ c: seed.usd.id, src: 'table', rate: '50', rid: seed.usdRateRow.id }), /same currency and value/);
  // الأستاذ: لا سطر أساسيه صفر في الطرفين ولا إدخال لا يطابق قيدًا مرحّلًا
  rejects(() => db.prepare(`INSERT INTO gl_entries (source_type, source_id, source_line_id, doc_number, entry_kind, posting_date, fiscal_period_id, fiscal_year_id, branch_id,
    account_id, currency_id, rate, rate_source, debit_fc, credit_fc, debit, credit, posted_by, posted_at) VALUES ('journal', ?, 1, 'X', 'normal', '2026-03-15', 3, 1, 1, ?, ?, '1', 'base', '5', '0', '0', '0', 1, 'now')`)
    .run(d.id, seed.acc.cash.id, seed.egp.id), /CHECK constraint|must match a line/);       // triggers BEFORE تسبق CHECK؛ مرفوض في الحالتين
  rejects(() => db.prepare(`INSERT INTO gl_entries (source_type, source_id, source_line_id, doc_number, entry_kind, posting_date, fiscal_period_id, fiscal_year_id, branch_id,
    account_id, currency_id, rate, rate_source, debit_fc, credit_fc, debit, credit, posted_by, posted_at) VALUES ('journal', ?, 1, 'X', 'normal', '2026-03-15', 3, 1, 1, ?, ?, '1', 'base', '5', '0', '5', '0', 1, 'now')`)
    .run(d.id, seed.acc.cash.id, seed.egp.id), /must match a line of the posted journal entry/);
});

test('ledger-db: تجاوز CHECK بـ PRAGMA ⇒ المحرك يرفض القيمة عند الترحيل ولا يُكتب شيء في الأستاذ', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const db = s.app.db;
  for (const bad of ['0.0', '1.50', '-5', 'abc', '1e5']) {
    const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '10' }]));
    db.pragma('ignore_check_constraints = ON');
    db.prepare("UPDATE journal_lines SET credit_fc = ? WHERE entry_id = ? AND line_no = 2").run(bad, d.id);
    db.pragma('ignore_check_constraints = OFF');
    const r = await postEntry(s, d.id);
    assert.equal(r.status, 409, bad);
    assert.ok(['INVALID_AMOUNT', 'TOO_PRECISE', 'LINE_SIDE'].includes(r.body.error.code), `${bad}: ${r.body.error.code}`);
    assert.equal(db.prepare('SELECT count(*) c FROM gl_entries').get().c, 0);
    assert.equal(db.prepare('SELECT count(*) c FROM issued_numbers').get().c, 0);
  }
});

test('ledger-db: trigger الترحيل — قيد غير متزن بـ SQL مباشر يُرفض، وخارج البرنامج يفشل الترحيل (fail-closed)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const db = s.app.db;
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '10' }]));
  const period = db.prepare("SELECT id FROM fiscal_periods WHERE '2026-03-15' BETWEEN start_date AND end_date").get().id;
  const post = (conn) => conn.prepare(`UPDATE journal_entries SET status = 'posted', number = 'HACK-1', fiscal_period_id = ?, decimal_snapshot = '{}', total_base = '10',
    posted_by = 1, posted_at = 'now' WHERE id = ?`).run(period, d.id);
  // المبالغ الأساسية لم تُحسب (المسودة)
  rejects(() => post(db), /non-zero base amount/);
  db.prepare("UPDATE journal_lines SET debit = '10' WHERE entry_id = ? AND line_no = 1").run(d.id);
  db.prepare("UPDATE journal_lines SET credit = '9' WHERE entry_id = ? AND line_no = 2").run(d.id);
  rejects(() => post(db), /not balanced in base currency/);
  // اتصال خارجي بلا دوال المحرك: حتى القيد المتزن لا يُرحَّل يدويًا
  db.prepare("UPDATE journal_lines SET credit = '10' WHERE entry_id = ? AND line_no = 2").run(d.id);
  const raw = new Database(s.config.dbFile);
  t.after(() => raw.close());
  rejects(() => post(raw), /no such function: dec_cmp|dec_sum/);
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(d.id).status, 'draft');
  // الحساب التجميعي والفترة المغلقة من القاعدة نفسها
  db.prepare("UPDATE journal_lines SET account_id = ? WHERE entry_id = ? AND line_no = 1").run(seed.acc.assets.id, d.id);
  rejects(() => post(db), /group accounts cannot be posted to/);
});

test('ledger-db: العملة الأساسية لا تتغير بعد الترحيل حتى بـ SQL مباشر، والإقفال محجوز', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  await postNew(s, seed, [{ accountId: seed.acc.cash.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '10' }]);
  const db = s.app.db;
  rejects(() => db.prepare("UPDATE company SET base_currency = 'USD'").run(), /base currency is locked/);
  assert.equal((await s.admin.put('/api/company', { baseCurrency: 'SAR' })).body.error.code, 'BASE_CURRENCY_LOCKED');
  rejects(() => db.prepare(`INSERT INTO journal_entries (branch_id, entry_type, entry_date, series_id, default_currency_id, description, created_by, updated_by)
    VALUES (1, 'closing', '2026-12-31', 1, ?, 'x', 1, 1)`).run(seed.egp.id), /closing entries are created by the year-end closing only/);   // م4: الرسالة استُبدلت؛ القيد اليومي لا يكون إقفالًا أبدًا
  rejects(() => db.prepare(`INSERT INTO journal_entries (branch_id, entry_type, status, entry_date, series_id, default_currency_id, description, created_by, updated_by)
    VALUES (1, 'general', 'posted', '2026-03-15', 1, ?, 'x', 1, 1)`).run(seed.egp.id), /created as drafts/);
});

test('ledger-db: اكتمال القيد العكسي (C1–C4) تفرضه القاعدة عند الإضافة والترحيل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const db = s.app.db;
  // أصل من 4 سطور: أول سطرين متزنان وحدهما، فعكس جزئي متزن لا يُكشف بالاتزان بل بالاكتمال
  const orig = await postNew(s, seed, [{ accountId: seed.acc.cash.id, debit: '60' }, { accountId: seed.acc.sales.id, credit: '60' }, { accountId: seed.acc.rent.id, debit: '40' }, { accountId: seed.acc.sales.id, credit: '40' }]);
  const other = await postNew(s, seed, [{ accountId: seed.acc.cash.id, debit: '7' }, { accountId: seed.acc.sales.id, credit: '7' }]);
  const O = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no').all(orig.id);
  const X = db.prepare('SELECT * FROM journal_lines WHERE entry_id = ? ORDER BY line_no').all(other.id);
  const period = db.prepare("SELECT id FROM fiscal_periods WHERE '2026-03-20' BETWEEN start_date AND end_date").get().id;
  const newRev = () => Number(db.prepare(`INSERT INTO journal_entries (branch_id, entry_type, entry_date, series_id, default_currency_id, description, created_by, updated_by, reverses_id, reason)
    VALUES (1, 'reversal', '2026-03-20', 2, ?, 'عكس', 1, 1, ?, 'تصحيح خطأ')`).run(seed.egp.id, orig.id).lastInsertRowid);
  const mirror = (rev, o, n, over = {}) => db.prepare(`INSERT INTO journal_lines (entry_id, line_no, account_id, cost_center_id, currency_id, rate, rate_source, rate_id,
    debit_fc, credit_fc, debit, credit, reverses_line_id) VALUES (@e, @n, @a, @cc, @c, @rate, @src, @rid, @dfc, @cfc, @d, @cr, @rl)`).run({
    e: rev, n, a: o.account_id, cc: o.cost_center_id, c: o.currency_id, rate: o.rate, src: o.rate_source, rid: o.rate_id,
    dfc: o.credit_fc, cfc: o.debit_fc, d: o.credit, cr: o.debit, rl: o.id, ...over });
  const post = (rev) => db.prepare(`UPDATE journal_entries SET status = 'posted', number = ?, fiscal_period_id = ?, decimal_snapshot = '{}', total_base = '100',
    posted_by = 1, posted_at = 'now' WHERE id = ?`).run('TEST-RV-' + rev, period, rev);

  // C1: سطر بلا ربط، أو مرآة خاطئة (حساب آخر، مبلغ آخر، الطرف نفسه)، أو سطر من قيد آخر
  let rev = newRev();
  rejects(() => mirror(rev, O[0], 1, { rl: null }), /must mirror a line of the reversed entry/);
  rejects(() => mirror(rev, O[0], 1, { a: seed.acc.bankUsd.id }), /must mirror/);
  rejects(() => mirror(rev, O[0], 1, { cfc: '61', cr: '61' }), /must mirror/);
  rejects(() => mirror(rev, O[0], 1, { dfc: O[0].debit_fc, cfc: '0', d: O[0].debit, cr: '0' }), /must mirror/);
  rejects(() => mirror(rev, X[0], 1), /must mirror/);
  rejects(() => db.prepare(`INSERT INTO journal_lines (entry_id, line_no, account_id, currency_id, rate, rate_source, debit_fc, reverses_line_id) VALUES (?, 1, ?, ?, '1', 'base', '5', ?)`)
    .run(other.id + 1000, seed.acc.cash.id, seed.egp.id, O[0].id), /FOREIGN KEY|lines of a posted|only reversal lines/);
  // C2: تكرار سطر أصل
  mirror(rev, O[0], 1);
  rejects(() => mirror(rev, O[0], 2), /UNIQUE constraint failed: journal_lines.entry_id, journal_lines.reverses_line_id/);
  // C3/C4: سطرا أصل ناقصان والباقي متزن ⇒ الترحيل مرفوض بالاكتمال
  mirror(rev, O[1], 2);
  rejects(() => post(rev), /reversal must mirror every line of the original exactly once/);
  // عدد مطابق لكن سطر ناقص (سطر أصل آخر مكرر غير ممكن بـ C2)، وسطر زائد من قيد آخر غير ممكن بـ C1
  // عكسي مسودة متروك لا يحجز العكس الصحيح (فهرس جزئي على المرحّل)، ويظهر في فحص السلامة
  assert.equal(s.app.services.ledger.integrity().problems.filter((p) => p.type === 'DRAFT_REVERSAL').length, 1);
  db.prepare('DELETE FROM journal_entries WHERE id = ?').run(rev);
  rev = newRev();
  O.forEach((o, i) => mirror(rev, o, i + 1));
  post(rev);                                                                                 // تقابل تام ⇒ يُقبل
  assert.equal(db.prepare('SELECT status FROM journal_entries WHERE id = ?').get(rev).status, 'posted');
  // لا عكس ثانٍ مرحّل، ولا عكس للعكسي
  const rev2 = newRev();
  O.forEach((o, i) => mirror(rev2, o, i + 1));
  rejects(() => post(rev2), /UNIQUE constraint failed: journal_entries.reverses_id/);
  rejects(() => db.prepare(`INSERT INTO journal_entries (branch_id, entry_type, entry_date, series_id, default_currency_id, description, created_by, updated_by, reverses_id, reason)
    VALUES (1, 'reversal', '2026-03-20', 2, ?, 'عكس العكس', 1, 1, ?, 'محاولة')`).run(seed.egp.id, rev), /only a posted, non-reversal entry can be reversed/);
  // سطر غير عكسي لا يحمل reverses_line_id
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '1' }, { accountId: seed.acc.sales.id, credit: '1' }]));
  rejects(() => db.prepare('UPDATE journal_lines SET reverses_line_id = ? WHERE entry_id = ? AND line_no = 1').run(O[0].id, d.id), /only reversal lines reference an original line/);
});

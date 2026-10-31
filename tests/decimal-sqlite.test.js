'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { openDatabase } = require('../server/core/db');
const { registerDecimalSql } = require('../server/core/decimal/sql');
const { createDecimalService, KINDS } = require('../server/core/decimal');
const { MODULES } = require('../server/app');
const { tmpDir } = require('./helpers');

const D = createDecimalService();

// النمط المعتمد لأي عمود عشري في المراحل القادمة: TEXT في جدول STRICT + قيد شكل.
const DDL = `CREATE TABLE amounts (
  id INTEGER PRIMARY KEY,
  amount TEXT NOT NULL CHECK (amount NOT GLOB '*[^0-9.-]*' AND length(amount) BETWEEN 1 AND 40)
) STRICT`;

function randAmount(i) {
  // قيم متنوعة حتمية: كبيرة، صغيرة، سالبة، بكسور طويلة
  const int = String((BigInt(i) * 7919n ** 4n) % 10n ** BigInt(1 + (i % 20)));
  const frac = String((i * 104729) % 100000000).padStart(8, '0').replace(/0+$/, '');
  const v = (i % 3 === 0 ? '-' : '') + int + (frac ? '.' + frac : '');
  return D.commit(v, 'amount');
}

test('decimal-sqlite: حفظ واسترجاع 2000 قيمة من ملف SQLite حقيقي بلا أي فقد', () => {
  const file = path.join(tmpDir(), 'x.db');
  let db = openDatabase(file);
  db.exec(DDL);
  const values = Array.from({ length: 2000 }, (_, i) => randAmount(i + 1));
  values.push('99999999999999999999.99999999', '-99999999999999999999.99999999', '0.00000001', '0');
  const ins = db.prepare('INSERT INTO amounts (amount) VALUES (?)');
  db.transaction(() => values.forEach((v) => ins.run(v)))();
  db.close();

  db = openDatabase(file);   // إعادة فتح من القرص
  const rows = db.prepare('SELECT amount, typeof(amount) t FROM amounts ORDER BY id').all();
  assert.equal(rows.length, values.length);
  rows.forEach((r, i) => {
    assert.equal(r.t, 'text');
    assert.equal(r.amount, values[i]);                                       // نص مطابق حرفيًا
    assert.equal(D.cmp(D.fromStorage(r.amount, 'amount'), values[i]), 0);    // وقيمة مطابقة
  });
  db.close();
});

test('decimal-sqlite: نتيجة الحساب قبل التخزين = بعد الاسترجاع (حساب ثم حفظ ثم إعادة حساب)', () => {
  const db = openDatabase(':memory:');
  db.exec(DDL);
  const price = '19.9999999999'; const qty = '7.33333333';
  const before = D.commit(D.mul(price, qty), 'amount');
  db.prepare('INSERT INTO amounts (amount) VALUES (?)').run(before);
  const after = db.prepare('SELECT amount FROM amounts').get().amount;
  assert.equal(after, before);
  assert.equal(D.commit(D.mul(D.fromStorage(after, 'amount'), '1'), 'amount'), before);
});

test('decimal-sqlite: dec_sum دقيق بينما SUM في SQLite يفقد الدقة (سبب منعه)', () => {
  const db = openDatabase(':memory:');
  registerDecimalSql(db);
  db.exec(DDL);
  const ins = db.prepare('INSERT INTO amounts (amount) VALUES (?)');
  ins.run('0.1'); ins.run('0.2');
  const r = db.prepare('SELECT dec_sum(amount) exact, sum(amount) lossy FROM amounts').get();
  assert.equal(r.exact, '0.3');
  assert.notEqual(String(r.lossy), '0.3');            // 0.30000000000000004
  db.exec('DELETE FROM amounts');
  ins.run('99999999999999999999.99999999'); ins.run('0.00000001');
  assert.equal(db.prepare('SELECT dec_sum(amount) s FROM amounts').get().s, '100000000000000000000');
  assert.equal(db.prepare('SELECT dec_sum(amount) s FROM amounts WHERE 0').get().s, '0');
  assert.deepEqual(db.prepare("SELECT dec_cmp('10', '9') a, dec_cmp('-1', '0.5') b, dec_cmp('1.5', '1.5') c").get(), { a: 1, b: -1, c: 0 });
  assert.throws(() => db.prepare("SELECT dec_cmp('1e3', '1') x").get(), /قانوني/);
});

test('decimal-sqlite: dec_sum يطابق مجموع المحرك لـ 2000 قيمة مع GROUP BY', () => {
  const db = openDatabase(':memory:');
  registerDecimalSql(db);
  db.exec('CREATE TABLE lines (branch INTEGER, amount TEXT NOT NULL) STRICT');
  const ins = db.prepare('INSERT INTO lines VALUES (?, ?)');
  const byBranch = { 1: [], 2: [] };
  for (let i = 1; i <= 2000; i++) { const v = randAmount(i); const b = (i % 2) + 1; byBranch[b].push(v); ins.run(b, v); }
  for (const r of db.prepare('SELECT branch, dec_sum(amount) total FROM lines GROUP BY branch').all()) {
    assert.equal(r.total, D.canonical(D.sum(byBranch[r.branch])));
  }
});

test('decimal-sqlite: لا يوجد عمود REAL/FLOAT/DOUBLE/NUMERIC في أي ترحيل', () => {
  for (const m of MODULES) {
    if (!m.migrationsDir || !fs.existsSync(m.migrationsDir)) continue;
    for (const f of fs.readdirSync(m.migrationsDir)) {
      const sql = fs.readFileSync(path.join(m.migrationsDir, f), 'utf8').replace(/--.*$/gm, '');
      assert.ok(!/\b(REAL|FLOAT|DOUBLE|NUMERIC|DECIMAL)\b/i.test(sql), `${m.name}/${f} يستخدم نوعًا عشريًا غير آمن`);
    }
  }
});

test('decimal-sqlite: قيود decimal_policy في القاعدة تطابق storage scale في الكود', () => {
  const sql = fs.readFileSync(path.join(__dirname, '..', 'server/modules/company-setup/migrations/0001_company_branches.sql'), 'utf8');
  for (const [kind, k] of Object.entries(KINDS)) {
    assert.match(sql, new RegExp(`WHEN '${kind}' THEN ${k.storageScale}\\b`), kind);
  }
});

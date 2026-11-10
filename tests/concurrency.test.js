'use strict';
/*
 * المرحلة 3 (الدفعة 3.1): التزامن الفعلي بعمليات تشغيل منفصلة على ملف قاعدة واحد (المقترح، القسم 8.2).
 * لا ينجح الاختبار إن فُقد إصدار، أو تكرر رقم، أو ظهرت فجوة، أو استُنفدت إعادات SQLITE_BUSY، أو ظهر خطأ غير معالج.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const { startReady, makeUser } = require('./helpers');
const { seedLedger } = require('./ledger-helpers');
const Database = require('better-sqlite3');

/** يشغّل العمال، ينتظر جاهزيتهم كلهم، ثم يطلقهم في اللحظة نفسها. */
async function runWorkers(script, argsList) {
  const kids = argsList.map((args) => fork(path.join(__dirname, 'workers', script), args.map(String), { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  await Promise.all(kids.map((k) => new Promise((res, rej) => { k.once('message', res); k.once('error', rej); })));
  const results = kids.map((k) => new Promise((res, rej) => {
    let got = null;
    k.on('message', (m) => { got = m; });
    k.once('exit', (code) => (code === 0 && got ? res(got) : rej(new Error(`worker exited ${code}`))));
  }));
  const t0 = Date.now();
  for (const k of kids) k.send('go');
  const out = await Promise.all(results);
  return { out, ms: Date.now() - t0 };
}
const seqOf = (n) => Number(n.slice(-6));

test('concurrency: 4 عمليات منفصلة × 250 إصدارًا مع 10% فشل متعمد ⇒ 1..N متصلة وفريدة بلا أثر للفاشل', { timeout: 180000 }, async (t) => {
  const s = await startReady();
  const seed = await seedLedger(s);
  const db = s.app.db;
  const series = db.prepare("SELECT id FROM document_series WHERE code = 'JV'").get().id;
  const fy = db.prepare('SELECT id FROM fiscal_years').get().id;
  await s.app.close();                                     // العمال وحدهم على الملف
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const W = 4; const N = 250;
  const { out, ms } = await runWorkers('numbering-worker.js', Array.from({ length: W }, (_, w) => [s.config.dbFile, w + 1, N, series, seed.hq.id, fy]));

  const check = new Database(s.config.dbFile, { readonly: true });
  t.after(() => check.close());
  const reported = out.flatMap((o) => o.numbers);
  const issued = check.prepare('SELECT number, seq FROM issued_numbers ORDER BY seq').all();
  const total = out.reduce((a, o) => a + o.numbers.length, 0);
  const intentional = out.reduce((a, o) => a + o.intentional, 0);
  // تزامن فعلي: العمال تداخلوا (لو عملوا متتابعين لكان تبدّل العامل على طول التسلسل W - 1 فقط)
  const bySeq = check.prepare('SELECT source_id FROM issued_numbers ORDER BY seq').all().map((r) => Math.floor(r.source_id / 100000));
  const switches = bySeq.filter((w, i) => i && w !== bySeq[i - 1]).length;
  const summary = { switches, workers: W, perWorker: N, issued: total, intentional, busyRetries: out.map((o) => o.busyRetries), exhausted: out.map((o) => o.exhausted), maxWaitMs: Math.max(...out.map((o) => o.maxWaitMs)), totalMs: ms };
  t.diagnostic(JSON.stringify(summary));
  // 5. صفر استنفاد وصفر أخطاء غير معالجة
  assert.deepEqual(out.flatMap((o) => o.unexpected), []);
  assert.equal(out.reduce((a, o) => a + o.exhausted, 0), 0);
  assert.ok(switches > W * 10, `workers did not interleave (switches=${switches})`);
  // 1. المجموع المبلغ = صفوف السجل = العداد
  assert.equal(total + intentional, W * N);
  assert.equal(issued.length, total);
  assert.equal(check.prepare('SELECT last_value v FROM document_counters WHERE series_id = ?').get(series).v, total);
  // 2. التسلسلات = {1..N} بالضبط
  assert.deepEqual(issued.map((r) => r.seq), Array.from({ length: total }, (_, i) => i + 1));
  // 3. اتحاد المبلغ = ما في القاعدة، ولا رقم مكرر
  assert.equal(new Set(reported).size, reported.length);
  assert.deepEqual([...reported].sort(), issued.map((r) => r.number).sort());
  assert.deepEqual(reported.map(seqOf).sort((a, b) => a - b), issued.map((r) => r.seq));
  // 4. لا أثر لأي فشل متعمد: كل source_id في السجل لمحاولة نجحت
  const failedSources = new Set(out.flatMap((o) => Array.from({ length: N }, (_, i) => i).filter((i) => i % 10 === o.workerId % 10).map((i) => o.workerId * 100000 + i)));
  assert.equal(check.prepare('SELECT source_id FROM issued_numbers').all().filter((r) => failedSources.has(r.source_id)).length, 0);
  // 6. سلامة الملف
  assert.equal(check.pragma('integrity_check', { simple: true }), 'ok');
  assert.deepEqual(check.pragma('foreign_key_check'), []);
});

test('concurrency: 3 نسخ برنامج منفصلة ترحّل قيودًا بالتزامن على قاعدة واحدة ⇒ أرقام متصلة وأستاذ سليم', { timeout: 180000 }, async (t) => {
  const s = await startReady();
  const seed = await seedLedger(s);
  const users = [];
  for (let w = 1; w <= 3; w++) users.push(await makeUser(s, { username: 'poster' + w, permissions: ['journal.view', 'journal.create', 'journal.post'], allBranches: true }));
  await s.app.close();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const K = 40;
  const { out, ms } = await runWorkers('posting-worker.js', users.map((u, i) => [s.dir, i + 1, K, seed.hq.id, seed.acc.cash.id, seed.acc.sales.id, u.client.state.cookie, u.client.state.csrf]));
  t.diagnostic(JSON.stringify({ workers: 3, perWorker: K, posted: out.map((o) => o.numbers.length), busyRetries: out.map((o) => o.busyRetries), exhausted: out.map((o) => o.exhausted), maxWaitMs: Math.max(...out.map((o) => o.maxWaitMs)), totalMs: ms }));
  assert.deepEqual(out.flatMap((o) => o.unexpected), []);
  assert.equal(out.reduce((a, o) => a + o.exhausted, 0), 0);
  const numbers = out.flatMap((o) => o.numbers);
  assert.equal(numbers.length, 3 * K);
  const owner = new Map(out.flatMap((o) => o.numbers.map((n) => [seqOf(n), o.workerId])));
  const order = [...owner.keys()].sort((a, b) => a - b).map((k) => owner.get(k));
  const switches = order.filter((w, i) => i && w !== order[i - 1]).length;
  t.diagnostic(`posting interleave switches=${switches}`);
  assert.ok(switches > 10, `apps did not interleave (switches=${switches})`);
  assert.equal(new Set(numbers).size, numbers.length);
  assert.deepEqual(numbers.map(seqOf).sort((a, b) => a - b), Array.from({ length: 3 * K }, (_, i) => i + 1));

  // إعادة فتح البرنامج على الملف: الأستاذ متزن ومطابق، ولا فجوات
  const { loadConfig } = require('../server/core/config');
  const { createApp } = require('../server/app');
  const { createLogger } = require('../server/core/logger');
  const app = await createApp({ config: loadConfig({ dataDir: s.dir, port: 0 }), logger: createLogger({}) });
  t.after(() => app.close());
  assert.deepEqual(app.services.ledger.integrity(), { ok: true, problems: [] });
  assert.equal(app.db.prepare('SELECT count(*) c FROM gl_entries').get().c, 2 * 3 * K);
  const tot = app.db.prepare('SELECT dec_sum(debit) d, dec_sum(credit) c FROM gl_entries').get();
  assert.equal(tot.d, tot.c);
  assert.equal(app.db.prepare("SELECT count(*) c FROM journal_entries WHERE status = 'posted'").get().c, 3 * K);
});

test('concurrency: قفل كتابة يتجاوز busy_timeout ⇒ 503 DB_BUSY والمعاملة أُلغيت كاملة، ثم ينجح بعد تحرير القفل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const { draft, postEntry, ok } = require('./ledger-helpers');
  const d = ok(await draft(s, seed, [{ accountId: seed.acc.cash.id, debit: '10' }, { accountId: seed.acc.sales.id, credit: '10' }]));
  const other = new Database(s.config.dbFile);
  t.after(() => other.close());
  other.prepare('BEGIN IMMEDIATE').run();                           // عملية أخرى تمسك قفل الكتابة
  s.app.db.pragma('busy_timeout = 100');                           // اختبار سريع بدل 5 ثوانٍ
  const r = await postEntry(s, d.id);
  assert.equal(r.status, 503); assert.equal(r.body.error.code, 'DB_BUSY');
  other.prepare('ROLLBACK').run();
  s.app.db.pragma('busy_timeout = 5000');
  assert.equal(ok(await s.admin.get('/api/journal/' + d.id)).status, 'draft');
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM issued_numbers').get().c, 0);
  assert.equal(ok(await postEntry(s, d.id)).number, 'JV-HQ-FY2026-000001');
});

test('concurrency: سياسة إعادة المحاولة — 5 إعادات بالانتظار المحدد ثم خطأ صريح، ولا تُخفي الأخطاء الأخرى', () => {
  const { withRetrySync, BACKOFF } = require('./workers/retry');
  assert.deepEqual(BACKOFF, [50, 100, 200, 400, 800]);
  const busyErr = Object.assign(new Error('database is locked'), { code: 'SQLITE_BUSY' });
  let calls = 0; const st = { busyRetries: 0, exhausted: 0, maxWaitMs: 0 };
  const t0 = Date.now();
  assert.throws(() => withRetrySync(() => { calls++; throw busyErr; }, st), /database is locked/);
  assert.equal(calls, 6); assert.equal(st.busyRetries, 5); assert.equal(st.exhausted, 1);
  assert.ok(Date.now() - t0 >= 1550);                               // 50+100+200+400+800
  let n = 0; const st2 = { busyRetries: 0, exhausted: 0, maxWaitMs: 0 };
  assert.equal(withRetrySync(() => { if (++n < 3) throw busyErr; return 'ok'; }, st2), 'ok');
  assert.equal(st2.busyRetries, 2); assert.equal(st2.exhausted, 0);
  const st3 = { busyRetries: 0, exhausted: 0, maxWaitMs: 0 };
  assert.throws(() => withRetrySync(() => { throw Object.assign(new Error('x'), { code: 'SQLITE_CONSTRAINT' }); }, st3), /x/);
  assert.equal(st3.busyRetries, 0);
});

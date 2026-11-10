'use strict';
/* المرحلة 3: ضوابط الفترات والسنوات P1–P9 ونهائية التقارير (المقترح، القسم 7) — عبر الـ API و SQL مباشر والتزامن. */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { fork } = require('node:child_process');
const Database = require('better-sqlite3');
const { startReady } = require('./helpers');
const { ok, seedLedger, draft, postEntry, postNew } = require('./ledger-helpers');

const L = (seed, a = '10') => [{ accountId: seed.acc.cash.id, debit: a }, { accountId: seed.acc.sales.id, credit: a }];
const Y = (s, code, start, end) => s.admin.post('/api/fiscal-years', { code, nameAr: code, nameEn: code, startDate: start, endDate: end, periodType: 'monthly' });
const periodsOf = async (s, yearId) => ok(await s.admin.get('/api/fiscal-years/' + yearId)).periods;
const yearOf = async (s, code) => ok(await s.admin.get('/api/fiscal-years')).find((y) => y.code === code);
const PS = (s, id, op, b = {}) => s.admin.post(`/api/fiscal-periods/${id}/${op}`, { reason: 'سبب الاختبار', ...b });

test('P1/P2: الترحيل في المغلقة والمقفلة مرفوض؛ القفل من «مغلقة» فقط وبالتسلسل عبر السنوات (API و SQL مباشر)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  ok(await Y(s, 'FY27', '2027-01-01', '2027-12-31'));
  const p26 = await periodsOf(s, (await yearOf(s, 'FY26')).id);
  const p27 = await periodsOf(s, (await yearOf(s, 'FY27')).id);
  const db = s.app.db;
  // P1
  ok(await PS(s, p26[0].id, 'close'));
  const d = ok(await draft(s, seed, L(seed), { entryDate: '2026-01-20' }));
  assert.equal((await postEntry(s, d.id)).body.error.code, 'PERIOD_NOT_OPEN');
  // القفل من «مغلقة» فقط
  assert.equal((await PS(s, p26[1].id, 'lock')).body.error.code, 'PERIOD_STATUS');
  assert.throws(() => db.prepare("UPDATE fiscal_periods SET status = 'locked' WHERE id = ?").run(p26[1].id), /locked only from closed/);
  // P2: فبراير مغلق ويناير مغلق غير مقفل ⇒ رفض
  ok(await PS(s, p26[1].id, 'close'));
  const r = await PS(s, p26[1].id, 'lock');
  assert.equal(r.body.error.code, 'PERIOD_LOCK_SEQUENCE'); assert.deepEqual(r.body.error.details.periods.map((p) => p.id), [p26[0].id]);
  assert.throws(() => db.prepare("UPDATE fiscal_periods SET status = 'locked' WHERE id = ?").run(p26[1].id), /earlier periods must be locked first/);
  // عبر السنوات: أول فترة في 2027 لا تُقفل وآخر فترة في 2026 غير مقفلة
  ok(await PS(s, p27[0].id, 'close'));
  assert.equal((await PS(s, p27[0].id, 'lock')).body.error.code, 'PERIOD_LOCK_SEQUENCE');
  // تحديث جماعي يتخطى يناير (فبراير..ديسمبر) يُلغى كله: لا تُقفل أي فترة
  for (const p of p26) if (p.status === 'open' && p.seq > 2) db.prepare("UPDATE fiscal_periods SET status = 'closed' WHERE id = ?").run(p.id);
  const fy26 = (await yearOf(s, 'FY26')).id;
  assert.throws(() => db.prepare("UPDATE fiscal_periods SET status = 'locked' WHERE fiscal_year_id = ? AND seq >= 2").run(fy26), /earlier periods must be locked first/);
  assert.equal(db.prepare("SELECT count(*) c FROM fiscal_periods WHERE status = 'locked'").get().c, 0);
  // بالترتيب الصحيح ينجح، وإعادة فتح فترة قبل مقفلة مستحيلة (لأنها مقفلة)
  assert.equal(ok(await PS(s, p26[0].id, 'lock')).status, 'locked');
  assert.equal(ok(await PS(s, p26[1].id, 'lock')).status, 'locked');
  assert.equal((await PS(s, p26[0].id, 'reopen')).body.error.code, 'PERIOD_STATUS');
  const inv = db.prepare(`SELECT count(*) c FROM fiscal_periods p WHERE p.status = 'locked' AND EXISTS (SELECT 1 FROM fiscal_periods q WHERE q.start_date < p.start_date AND q.status <> 'locked')`).get().c;
  assert.equal(inv, 0);
});

test('P3/P4: تحذير الإغلاق مع فترات سابقة مفتوحة؛ إعادة فتح فترة بها قيود تتطلب تأكيدًا صريحًا بعددها ومُدقَّقة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const p = await periodsOf(s, (await yearOf(s, 'FY26')).id);
  const c = ok(await PS(s, p[2].id, 'close'));
  assert.deepEqual(c.warnings.map((w) => w.code), ['EARLIER_PERIODS_OPEN']); assert.deepEqual(c.warnings[0].periods.map((x) => x.id), [p[0].id, p[1].id]);
  assert.deepEqual(ok(await PS(s, p[0].id, 'close')).warnings, []);
  // بلا قيود: إعادة الفتح بلا تأكيد
  assert.equal(ok(await PS(s, p[0].id, 'reopen')).status, 'open');
  // بقيود مرحّلة: تأكيد صريح
  await postNew(s, seed, L(seed), { entryDate: '2026-01-15' });
  await postNew(s, seed, L(seed), { entryDate: '2026-01-16' });
  ok(await PS(s, p[0].id, 'close'));
  const r = await PS(s, p[0].id, 'reopen');
  assert.equal(r.body.error.code, 'REOPEN_CONFIRM_REQUIRED'); assert.equal(r.body.error.details.postedEntries, 2);
  assert.equal(ok(await PS(s, p[0].id, 'reopen', { confirm: true })).status, 'open');
  const a = JSON.parse(s.app.db.prepare("SELECT details FROM audit_log WHERE action = 'fiscal_period.reopened' ORDER BY id DESC").get().details);
  assert.deepEqual([a.postedEntries, a.confirmed], [2, true]);
});

test('P5/P6: السنوات متصلة بلا فجوات، الحذف للأولى أو الأخيرة فقط، ولا سنة قبل الأولى بعد أول ترحيل (API و SQL)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedLedger(s);
  const db = s.app.db;
  const gap = await Y(s, 'FY28', '2028-01-01', '2028-12-31');
  assert.equal(gap.body.error.code, 'FISCAL_YEAR_GAP'); assert.equal(gap.body.error.details.expectedStart, '2027-01-01');
  assert.throws(() => db.prepare("INSERT INTO fiscal_years (code,name_ar,name_en,start_date,end_date,period_type) VALUES ('Z','z','z','2028-01-01','2028-12-31','monthly')").run(), /contiguous/);
  ok(await Y(s, 'FY27', '2027-01-01', '2027-12-31'));
  ok(await Y(s, 'FY25', '2025-01-01', '2025-12-31'));                      // تسبق الأولى مباشرة: مسموح قبل أي ترحيل
  const mid = await yearOf(s, 'FY26');
  assert.equal((await s.admin.del('/api/fiscal-years/' + mid.id)).body.error.code, 'FISCAL_YEAR_NOT_EDGE');
  assert.throws(() => db.prepare('DELETE FROM fiscal_years WHERE id = ?').run(mid.id), /first or the last/);
  ok(await s.admin.del('/api/fiscal-years/' + (await yearOf(s, 'FY27')).id));                   // الأخيرة: مسموح
  ok(await s.admin.del('/api/fiscal-years/' + (await yearOf(s, 'FY25')).id));                   // الأولى: مسموح
  // P6: بعد أول ترحيل لا سنة قبل الأولى
  await postNew(s, seed, L(seed));
  assert.equal((await Y(s, 'FY25', '2025-01-01', '2025-12-31')).body.error.code, 'FISCAL_YEAR_BEFORE_FIRST');
  assert.throws(() => db.prepare("INSERT INTO fiscal_years (code,name_ar,name_en,start_date,end_date,period_type) VALUES ('Z','z','z','2025-01-01','2025-12-31','monthly')").run(), /before the first one after posting/);
  ok(await Y(s, 'FY27', '2027-01-01', '2027-12-31'));                      // بعد الأخيرة: مسموح
});

test('P9 ونهائية التقارير: سنة منتهية غير مقفلة ⇒ تحذير؛ التقرير نهائي فقط بفترات مقفلة ولا سنة سابقة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  // سنة 2025 (منتهية قطعًا) ثم 2026
  ok(await Y(s, 'FY25', '2025-01-01', '2025-12-31'));
  const seed = await seedLedger(s);
  const st = ok(await s.admin.get('/api/ledger/status'));
  assert.ok(st.warnings.some((w) => w.code === 'YEAR_ENDED_NOT_CLOSED' && w.year.code === 'FY25'));
  await postNew(s, seed, L(seed), { entryDate: '2025-06-15' });
  const fin = async (q) => ok(await s.admin.get('/api/ledger/trial-balance?' + q)).finality;
  let f = await fin('from=2025-01-01&to=2025-01-31');
  assert.deepEqual(f.reasons.map((r) => r.code), ['PERIOD_OPEN']);
  const p25 = await periodsOf(s, (await yearOf(s, 'FY25')).id);
  ok(await PS(s, p25[0].id, 'close'));
  assert.deepEqual((await fin('from=2025-01-01&to=2025-01-31')).reasons.map((r) => r.code), ['PERIOD_NOT_LOCKED']);
  ok(await PS(s, p25[0].id, 'lock'));
  f = await fin('from=2025-01-01&to=2025-01-31');
  assert.deepEqual(f, { final: true, reasons: [] });
  // أي نطاق في السنة الثانية غير نهائي دائمًا (لا إقفال سنوي قبل المرحلة 4) — حتى لو أُقفلت كل فتراته نظريًا
  f = await fin('from=2026-01-01&to=2026-01-31');
  assert.equal(f.final, false); assert.ok(f.reasons.some((r) => r.code === 'PRIOR_YEAR_NOT_CLOSED' && r.years.includes('FY25')));
  assert.match(ok(await s.admin.get('/api/ledger/statement/print?accountId=' + seed.acc.cash.id + '&from=2026-01-01&to=2026-12-31')).title, /غير نهائي/);
  assert.equal(ok(await s.admin.get('/api/ledger/journal?from=2026-01-01&to=2026-01-31&lang=en')).finality.final, false);
});

async function runHttpWorkers(argsList) {
  const kids = argsList.map((a) => fork(path.join(__dirname, 'workers', 'http-worker.js'), a.map(String), { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  await Promise.all(kids.map((k) => new Promise((res, rej) => { k.once('message', (m) => (m.fatal ? rej(new Error(m.fatal)) : res())); k.once('error', rej); })));
  const done = kids.map((k) => new Promise((res, rej) => { let got = null; k.on('message', (m) => { got = m; }); k.once('exit', (c) => (c === 0 && got && !got.fatal ? res(got) : rej(new Error(got && got.fatal || 'exit ' + c)))); }));
  for (const k of kids) k.send('go');
  return Promise.all(done);
}

test('P2 تزامن: نسختا برنامج تقفلان 48 فترة متتالية بالتزامن ⇒ القفل بترتيب التاريخ دائمًا ولا خطأ غير معالج', { timeout: 240000 }, async (t) => {
  const s = await startReady();
  for (const y of [2027, 2028, 2029]) ok(await Y(s, 'FY' + y, `${y}-01-01`, `${y}-12-31`));
  ok(await Y(s, 'FY26', '2026-01-01', '2026-12-31'));
  const db = s.app.db;
  db.prepare("UPDATE fiscal_periods SET status = 'closed'").run();
  const ids = db.prepare('SELECT id FROM fiscal_periods ORDER BY start_date').all().map((r) => r.id);
  assert.equal(ids.length, 48);
  await s.app.close();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const { cookie, csrf } = s.admin.state;
  const out = await runHttpWorkers([
    [s.dir, 'lock', JSON.stringify(ids.filter((_, i) => i % 2 === 0)), cookie, csrf],
    [s.dir, 'lock', JSON.stringify(ids.filter((_, i) => i % 2 === 1)), cookie, csrf],
  ]);
  t.diagnostic(JSON.stringify({ locked: out.map((o) => o.results.length), sequenceRejections: out.map((o) => o.sequenceRejections), busyRetries: out.map((o) => o.busyRetries), maxWaitMs: Math.max(...out.map((o) => o.maxWaitMs)) }));
  assert.deepEqual(out.flatMap((o) => o.unexpected), []);
  assert.equal(out.reduce((a, o) => a + o.exhausted, 0), 0);
  const check = new Database(s.config.dbFile, { readonly: true });
  t.after(() => check.close());
  assert.equal(check.prepare("SELECT count(*) c FROM fiscal_periods WHERE status = 'locked'").get().c, 48);
  // سجل الأحداث (إضافة فقط) يثبت أن كل قفل حدث بعد قفل سابقتها
  const order = check.prepare("SELECT p.start_date d FROM fiscal_period_events e JOIN fiscal_periods p ON p.id = e.period_id WHERE e.action = 'locked' ORDER BY e.id").all().map((r) => r.d);
  assert.deepEqual(order, [...order].sort());
  assert.ok(out.reduce((a, o) => a + o.sequenceRejections, 0) > 0, 'workers never contended');
});

test('العكس تزامن: نسختا برنامج تعكسان القيد نفسه بالتزامن ⇒ ينجح واحد فقط والآخر ALREADY_REVERSED', { timeout: 120000 }, async (t) => {
  const s = await startReady();
  const seed = await seedLedger(s);
  const results = [];
  for (let round = 0; round < 5; round++) {
    const e = await postNew(s, seed, L(seed, String(round + 1)));
    results.push(e.id);
  }
  await s.app.close();
  t.after(() => fs.rmSync(s.dir, { recursive: true, force: true }));
  const { cookie, csrf } = s.admin.state;
  for (const id of results) {
    const out = await runHttpWorkers([[s.dir, 'reverse', id, cookie, csrf], [s.dir, 'reverse', id, cookie, csrf]]);
    const rs = out.flatMap((o) => o.results);
    assert.deepEqual(out.flatMap((o) => o.unexpected), []);
    assert.equal(rs.filter((r) => r.status === 200).length, 1, JSON.stringify(rs));
    assert.deepEqual(rs.filter((r) => r.status !== 200).map((r) => r.code), ['ALREADY_REVERSED']);
  }
  const check = new Database(s.config.dbFile, { readonly: true });
  t.after(() => check.close());
  assert.equal(check.prepare("SELECT count(*) c FROM journal_entries WHERE entry_type = 'reversal' AND status = 'posted'").get().c, 5);
  assert.deepEqual(check.prepare("SELECT seq FROM issued_numbers WHERE doc_type = 'journal_reversal' ORDER BY seq").all().map((r) => r.seq), [1, 2, 3, 4, 5]);
});

'use strict';
/*
 * قياس أداء الإقفال السنوي (المرحلة 4) — ليس ضمن npm test.
 * يرحّل N قيدًا في سنة منتهية (2024) لفرعين و40 حسابًا تفصيليًا و5 مراكز تكلفة عبر services.journal / ledger.post الحقيقية،
 * ثم يقيس: فحص الجاهزية، المعاينة، الإقفال + ترحيل الأرصدة (معاملة واحدة)، المطابقة، فحص السلامة، ميزان السنة التالية؛
 * مع أقصى ذاكرة (RSS) أثناء القياس. لا يحمّل قيود السنة في الذاكرة: الأرصدة تُجمع في SQL بـ dec_sum.
 *   node tests/perf/year-end-bench.js [entries=100000]
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadConfig } = require('../../server/core/config');
const { createApp } = require('../../server/app');
const { createLogger } = require('../../server/core/logger');
const { inTransaction } = require('../../server/core/db');

const N = Number(process.argv[2] || 100000);
let peakRss = 0;
const sample = () => { peakRss = Math.max(peakRss, process.memoryUsage().rss); };
(async () => {
  const dir = fs.mkdtempSync(path.join(process.env.TAYL_BENCH_DIR || os.tmpdir(), 'tayl-ye-bench-'));
  const app = await createApp({ config: loadConfig({ dataDir: dir, port: 0 }), logger: createLogger({}) });
  const { db, services: S } = app;
  db.prepare("INSERT INTO company (id, name_ar, name_en, base_currency, default_language) VALUES (1, 'شركة قياس', 'Bench Co', 'EGP', 'ar')").run();
  const br = ['HQ', 'ALX'].map((c, i) => Number(db.prepare("INSERT INTO branches (code, name_ar, name_en, is_main) VALUES (?, ?, ?, ?)").run(c, c, c, i === 0 ? 1 : 0).lastInsertRowid));
  const userId = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, is_super_admin, all_branches) VALUES ('bench', 'Bench', 'scrypt$bench-not-a-real-hash', 1, 1)").run().lastInsertRowid);
  const ctx = { user: { id: userId, username: 'bench' }, ip: '127.0.0.1', requestId: 'bench', branchId: br[0],
    access: { allBranches: true, can: () => true, assertBranch() {}, branchAllowed: () => true, branchIds: () => br, sqlFilter: () => ({ sql: '1 = 1', params: [] }) } };
  S.currencies.ensureBase();
  const mk = (code, cls, parent, group) => Number(db.prepare(`INSERT INTO accounts (code, name_ar, name_en, parent_id, path, level, class_code, normal_balance, is_group)
    VALUES (?, ?, ?, ?, '', ?, ?, 'debit', ?)`).run(code, code, code, parent, parent ? 2 : 1, cls, group).lastInsertRowid);
  const groups = { asset: mk('1', 'asset', null, 1), liability: mk('2', 'liability', null, 1), equity: mk('3', 'equity', null, 1), revenue: mk('4', 'revenue', null, 1), expense: mk('6', 'expense', null, 1) };
  const acc = [];
  for (const [cls, n] of [['asset', 12], ['liability', 6], ['revenue', 8], ['expense', 14]]) for (let i = 1; i <= n; i++) acc.push(mk(`${cls[0].toUpperCase()}${i}`, cls, groups[cls], 0));
  const re = mk('3201', 'equity', groups.equity, 0);
  for (const a of db.prepare('SELECT id, parent_id FROM accounts').all()) db.prepare('UPDATE accounts SET path = ? WHERE id = ?').run(a.parent_id ? `/${a.parent_id}/${a.id}/` : `/${a.id}/`, a.id);
  const ccType = db.prepare('SELECT id FROM cost_center_types LIMIT 1').get().id;
  const cc = [1, 2, 3, 4, 5].map((i) => Number(db.prepare("INSERT INTO cost_centers (code, name_ar, name_en, type_id, path, level) VALUES (?, ?, ?, ?, '', 1)").run('CC' + i, 'CC' + i, 'CC' + i, ccType).lastInsertRowid));
  for (const id of cc) db.prepare('UPDATE cost_centers SET path = ? WHERE id = ?').run(`/${id}/`, id);
  for (const [code, y] of [['FY24', 2024], ['FY25', 2025]]) {
    const fy = Number(db.prepare('INSERT INTO fiscal_years (code, name_ar, name_en, start_date, end_date, period_type) VALUES (?, ?, ?, ?, ?, ?)').run(code, code, code, `${y}-01-01`, `${y}-12-31`, 'monthly').lastInsertRowid);
    for (const p of S.fiscal.generatePeriods(`${y}-01-01`, `${y}-12-31`, 'monthly')) db.prepare('INSERT INTO fiscal_periods (fiscal_year_id, seq, name_ar, name_en, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)').run(fy, p.seq, p.nameAr, p.nameEn, p.start, p.end);
  }
  const y24 = db.prepare("SELECT id FROM fiscal_years WHERE code = 'FY24'").get().id;

  const t0 = Date.now();
  const BATCH = 2000;
  for (let i = 0; i < N; i += BATCH) {
    inTransaction(db, () => {
      for (let k = i; k < Math.min(N, i + BATCH); k++) {
        const m = String((k % 12) + 1).padStart(2, '0'); const d = String((k % 28) + 1).padStart(2, '0');
        const amt = `${(k % 9973) + 1}.${String(k % 100).padStart(2, '0')}`;
        const a = acc[k % acc.length]; const b = acc[(k * 7 + 3) % acc.length];
        const e = S.journal.createDraft(ctx, { branchId: br[k % 2], entryDate: `2024-${m}-${d}`, description: 'قيد قياس ' + k,
          lines: [{ accountId: a, debit: amt, costCenterId: cc[k % 5] }, { accountId: b === a ? acc[(k + 1) % acc.length] : b, credit: amt, costCenterId: cc[(k + 2) % 5] }] });
        S.journal.postEntry(ctx, e.id);
      }
    });
    if ((i / BATCH) % 10 === 0) process.stdout.write(`posted ${Math.min(N, i + BATCH)} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
  const postMs = Date.now() - t0;
  db.prepare("UPDATE fiscal_periods SET status = 'closed' WHERE fiscal_year_id = ?").run(y24);
  db.prepare('UPDATE year_end_settings SET retained_earnings_account_id = ? WHERE id = 1').run(re);
  global.gc && global.gc();
  peakRss = 0; sample();
  const timer = setInterval(sample, 20);
  const time = (label, fn) => { const a = process.hrtime.bigint(); const r = fn(); sample(); return { label, ms: Math.round(Number(process.hrtime.bigint() - a) / 1e6), r }; };
  const body = { fiscalYearId: y24, branchIds: 'all', operation: 'close', carryForward: true };
  const chk = time('readiness check (close + carry, 2 branches)', () => S.yearEnd.check(ctx, body));
  const pv = time('preview (lines for 2 branches)', () => S.yearEnd.preview(ctx, body));
  const ex = time('execute close + carry-forward (one transaction)', () => S.yearEnd.close(ctx, { ...body, fingerprint: pv.r.fingerprint, idempotencyKey: 'bench-key-0001', acknowledgeWarnings: true, confirm: true }));
  const rec = time('reconciliation (both branches)', () => br.map((b) => S.yearEnd.reconcile(S.yearEnd.yearRow(y24), b, S.yearEnd.cfLinesOf(S.yearEnd.originalOf('carry_forward_id', S.yearEnd.activeCarry(y24, b).id).id))));
  const integ = time('ledger integrity (incl. year-end checks)', () => S.ledger.integrity());
  const route = (p) => app.router.routes.find((r) => r.method === 'GET' && r.pattern === p).handler;
  const tb = time('trial balance FY2025 (opening from ledger)', () => route('/api/ledger/trial-balance')({ ...ctx, query: { from: '2025-01-01', to: '2025-12-31' } }));
  clearInterval(timer);
  const out = {
    entries: N, glLinesBefore: N * 2, glLinesAfter: db.prepare('SELECT count(*) c FROM gl_entries').get().c, postSeconds: Math.round(postMs / 1000),
    closingLines: db.prepare("SELECT count(*) c FROM year_end_lines l JOIN year_end_entries e ON e.id = l.entry_id WHERE e.kind = 'closing'").get().c,
    carryLines: db.prepare("SELECT count(*) c FROM year_end_lines l JOIN year_end_entries e ON e.id = l.entry_id WHERE e.kind = 'carry_forward'").get().c,
    numbers: ex.r.branches.map((b) => [b.entry.number, b.carryForward.entry.number]),
    timings: [chk, pv, ex, rec, integ, tb].map(({ label, ms }) => ({ label, ms })),
    reconciliationOk: rec.r.every((x) => x.ok), integrityOk: integ.r.ok, nextYearTrialBalanced: tb.r.totals.balanced.all,
    peakRssMB: Math.round(peakRss / 1048576), dbSizeMB: Math.round(fs.statSync(path.join(dir, 'tayl.db')).size / 1048576),
  };
  console.log(JSON.stringify(out, null, 2));
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/*
 * قياس أداء القوائم المالية (المرحلة 5) — ليس ضمن npm test.
 * يرحّل N قيدًا على سنتين (2024 و2025) لفرعين و40 حسابًا مصنفًا و5 مراكز تكلفة عبر services.journal / ledger.post الحقيقية،
 * ويُقفل 2024 ويرحّل أرصدتها، ثم يقيس كل قائمة (مع المطابقة الكاملة لميزان المراجعة المضمّنة في كل طلب) وأقصى ذاكرة.
 *   node tests/perf/fs-bench.js [entries=100000]
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
  const dir = fs.mkdtempSync(path.join(process.env.TAYL_BENCH_DIR || os.tmpdir(), 'tayl-fs-bench-'));
  const app = await createApp({ config: loadConfig({ dataDir: dir, port: 0 }), logger: createLogger({}) });
  const { db, services: S } = app;
  db.prepare("INSERT INTO company (id, name_ar, name_en, base_currency, default_language) VALUES (1, 'شركة قياس', 'Bench Co', 'EGP', 'ar')").run();
  const br = ['HQ', 'ALX'].map((c, i) => Number(db.prepare('INSERT INTO branches (code, name_ar, name_en, is_main) VALUES (?, ?, ?, ?)').run(c, c, c, i === 0 ? 1 : 0).lastInsertRowid));
  const userId = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, is_super_admin, all_branches) VALUES ('bench', 'Bench', 'scrypt$bench-not-a-real-hash', 1, 1)").run().lastInsertRowid);
  const ctx = { user: { id: userId, username: 'bench' }, ip: '127.0.0.1', requestId: 'bench', branchId: br[0],
    access: { allBranches: true, can: () => true, assertBranch() {}, branchAllowed: () => true, branchIds: () => br,
      scope: () => ({ all: true, ids: null }), sqlFilter: () => ({ sql: '1 = 1', params: [] }) } };
  S.currencies.ensureBase();
  const type = (code) => db.prepare('SELECT id FROM account_types WHERE code = ?').get(code).id;
  const mk = (code, cls, parent, group, typeCode) => Number(db.prepare(`INSERT INTO accounts (code, name_ar, name_en, parent_id, path, level, class_code, normal_balance, is_group, type_id)
    VALUES (?, ?, ?, ?, '', ?, ?, 'debit', ?, ?)`).run(code, code, code, parent, parent ? 2 : 1, cls, group, typeCode ? type(typeCode) : null).lastInsertRowid);
  const g = { asset: mk('1', 'asset', null, 1), liability: mk('2', 'liability', null, 1), equity: mk('3', 'equity', null, 1), revenue: mk('4', 'revenue', null, 1), cogs: mk('5', 'cogs', null, 1), expense: mk('6', 'expense', null, 1) };
  const acc = [];
  const plan = [['asset', 'CASH', 3], ['asset', 'RECEIVABLE', 4], ['asset', 'FIXED_ASSET', 3], ['liability', 'PAYABLE', 4], ['liability', 'LOAN', 2],
    ['equity', 'CAPITAL', 1], ['revenue', 'SALES', 6], ['revenue', 'OTHER_REVENUE', 2], ['cogs', null, 3], ['expense', 'OPEX', 8], ['expense', 'FIN_EXP', 3]];
  for (const [cls, t, n] of plan) for (let i = 1; i <= n; i++) acc.push(mk(`${cls.slice(0, 3).toUpperCase()}${t || ''}${i}`, cls, g[cls], 0, t));
  const re = mk('3201', 'equity', g.equity, 0, 'RETAINED');
  for (const a of db.prepare('SELECT id, parent_id FROM accounts').all()) db.prepare('UPDATE accounts SET path = ? WHERE id = ?').run(a.parent_id ? `/${a.parent_id}/${a.id}/` : `/${a.id}/`, a.id);
  const ccType = db.prepare('SELECT id FROM cost_center_types LIMIT 1').get().id;
  const cc = [1, 2, 3, 4, 5].map((i) => Number(db.prepare("INSERT INTO cost_centers (code, name_ar, name_en, type_id, path, level) VALUES (?, ?, ?, ?, '', 1)").run('CC' + i, 'CC' + i, 'CC' + i, ccType).lastInsertRowid));
  for (const id of cc) db.prepare('UPDATE cost_centers SET path = ? WHERE id = ?').run(`/${id}/`, id);
  const years = {};
  for (const y of [2024, 2025]) {
    years[y] = Number(db.prepare('INSERT INTO fiscal_years (code, name_ar, name_en, start_date, end_date, period_type) VALUES (?, ?, ?, ?, ?, ?)').run('FY' + y, 'FY' + y, 'FY' + y, `${y}-01-01`, `${y}-12-31`, 'monthly').lastInsertRowid);
    for (const p of S.fiscal.generatePeriods(`${y}-01-01`, `${y}-12-31`, 'monthly')) db.prepare('INSERT INTO fiscal_periods (fiscal_year_id, seq, name_ar, name_en, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)').run(years[y], p.seq, p.nameAr, p.nameEn, p.start, p.end);
  }
  const t0 = Date.now();
  const BATCH = 2000;
  for (let i = 0; i < N; i += BATCH) {
    inTransaction(db, () => {
      for (let k = i; k < Math.min(N, i + BATCH); k++) {
        const y = k < N / 2 ? 2024 : 2025;
        // الأيام 2–28: أول يوم في السنة لا يحمل إلا قيد ترحيل الأرصدة، فتثبت المقارنة عدم الازدواج
        const m = String((k % 12) + 1).padStart(2, '0'); const d = String((k % 27) + 2).padStart(2, '0');
        const amt = `${(k % 9973) + 1}.${String(k % 100).padStart(2, '0')}`;
        const a = acc[k % acc.length]; let b = acc[(k * 7 + 3) % acc.length]; if (b === a) b = acc[(k + 1) % acc.length];
        const e = S.journal.createDraft(ctx, { branchId: br[k % 2], entryDate: `${y}-${m}-${d}`, description: 'قيد قياس ' + k,
          lines: [{ accountId: a, debit: amt, costCenterId: cc[k % 5] }, { accountId: b, credit: amt, costCenterId: cc[(k + 2) % 5] }] });
        S.journal.postEntry(ctx, e.id);
      }
    });
    if ((i / BATCH) % 10 === 0) process.stdout.write(`posted ${Math.min(N, i + BATCH)} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
  const postMs = Date.now() - t0;
  // إقفال 2024 وترحيل أرصدتها (لإثبات عدم الازدواج على حجم كبير)
  db.prepare("UPDATE fiscal_periods SET status = 'closed' WHERE fiscal_year_id = ?").run(years[2024]);
  db.prepare('UPDATE year_end_settings SET retained_earnings_account_id = ? WHERE id = 1').run(re);
  const body = { fiscalYearId: years[2024], branchIds: 'all', operation: 'close', carryForward: true };
  const pv = S.yearEnd.preview(ctx, body);
  S.yearEnd.close(ctx, { ...body, fingerprint: pv.fingerprint, idempotencyKey: 'fs-bench-0001', acknowledgeWarnings: true, confirm: true });
  global.gc && global.gc();
  peakRss = 0; sample();
  const timer = setInterval(sample, 20);
  const time = (label, fn) => { const a = process.hrtime.bigint(); const r = fn(); sample(); return { label, ms: Math.round(Number(process.hrtime.bigint() - a) / 1e6), r }; };
  const F = S.financialStatements;
  const isY = time('income statement FY2025 + previous year (with TB reconciliation)', () => F.incomeStatement(ctx, { fiscalYearId: String(years[2025]), compare: 'previous_year' }));
  const isB = time('income statement FY2025 by branch columns', () => F.incomeStatement(ctx, { fiscalYearId: String(years[2025]), breakdown: 'branch' }));
  const isC = time('income statement FY2025 by cost center columns', () => F.incomeStatement(ctx, { fiscalYearId: String(years[2025]), breakdown: 'cost_center' }));
  const isM = time('income statement one month (2025-06)', () => F.incomeStatement(ctx, { from: '2025-06-01', to: '2025-06-30', compare: 'same_period_last_year' }));
  const bs = time('balance sheet 2025-12-31 vs 2024-12-31', () => F.balanceSheet(ctx, { asOf: '2025-12-31', compare: 'previous_year' }));
  const bs0 = time('balance sheet 2025-01-01 (after carry-forward)', () => F.balanceSheet(ctx, { asOf: '2025-01-01' }));
  const cf = time('cash flow FY2025 + previous year', () => F.cashFlow(ctx, { fiscalYearId: String(years[2025]), compare: 'previous_year' }));
  clearInterval(timer);
  const bs24 = F.balanceSheet(ctx, { asOf: '2024-12-31' });
  const out = {
    entries: N, glLines: db.prepare('SELECT count(*) c FROM gl_entries').get().c, postSeconds: Math.round(postMs / 1000),
    timings: [isY, isB, isC, isM, bs, bs0, cf].map(({ label, ms }) => ({ label, ms })),
    checks: {
      incomeReconciled: isY.r.reconciliation.ok, incomeComplete: isY.r.complete, branchColumnsSumToTotal: isB.r.breakdownCheck.ok, costCenterColumnsSumToTotal: isC.r.breakdownCheck.ok,
      balanceSheetBalanced: bs.r.balanced && bs0.r.balanced, balanceSheetReconciled: bs.r.reconciliation.ok,
      noDuplicationAfterCarryForward: bs0.r.totalAssets.values[0].value === bs24.totalAssets.values[0].value && bs0.r.sections[2].unclosedResult.values[0].value === '0',
      cashFlowProofAndReconciled: cf.r.reconciliation.ok, cashFlowComplete: cf.r.complete,
    },
    netProfit2025: isY.r.netProfit.value, peakRssMB: Math.round(peakRss / 1048576), dbSizeMB: Math.round(fs.statSync(path.join(dir, 'tayl.db')).size / 1048576),
  };
  console.log(JSON.stringify(out, null, 2));
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });

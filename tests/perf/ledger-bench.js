'use strict';
/*
 * قياس أداء تقارير الأستاذ (المقترح، المرحلة الفرعية 3.7) — ليس ضمن npm test.
 * يرحّل N قيدًا (سطران لكل قيد، 6 حسابات، 12 شهرًا) عبر services.journal / services.ledger.post الحقيقية
 * (كل قيد بتحققه وترقيمه وtriggers القاعدة)، ثم يقيس ميزان المراجعة وكشف الحساب ودفتر اليومية.
 *   node tests/perf/ledger-bench.js [entries=100000]
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { loadConfig } = require('../../server/core/config');
const { createApp } = require('../../server/app');
const { createLogger } = require('../../server/core/logger');
const { inTransaction } = require('../../server/core/db');

const N = Number(process.argv[2] || 100000);
(async () => {
  // تنبيه: os.tmpdir() قد يكون في الذاكرة (tmpfs)؛ للأحجام الكبيرة ضع القاعدة على القرص: TAYL_BENCH_DIR=/path/on/disk
  const dir = fs.mkdtempSync(path.join(process.env.TAYL_BENCH_DIR || os.tmpdir(), 'tayl-bench-'));
  const app = await createApp({ config: loadConfig({ dataDir: dir, port: 0 }), logger: createLogger({}) });
  const { db, services: S } = app;
  // تأسيس مباشر بالخدمات (بيانات اختبارية)
  db.prepare("INSERT INTO company (id, name_ar, name_en, base_currency, default_language) VALUES (1, 'شركة قياس', 'Bench Co', 'EGP', 'ar')").run();
  const branchId = Number(db.prepare("INSERT INTO branches (code, name_ar, name_en, is_main) VALUES ('HQ', 'الرئيسي', 'HQ', 1)").run().lastInsertRowid);
  const userId = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, is_super_admin, all_branches) VALUES ('bench', 'Bench', 'scrypt$bench-not-a-real-hash', 1, 1)").run().lastInsertRowid);
  const ctx = { user: { id: userId, username: 'bench' }, ip: '127.0.0.1', requestId: 'bench', branchId,
    access: { allBranches: true, can: () => true, assertBranch() {}, branchAllowed: () => true, branchIds: () => [branchId], sqlFilter: () => ({ sql: '1 = 1', params: [] }) } };
  S.fiscal; S.currencies.ensureBase();
  const mk = (code, cls, parent, group) => Number(db.prepare(`INSERT INTO accounts (code, name_ar, name_en, parent_id, path, level, class_code, normal_balance, is_group)
    VALUES (?, ?, ?, ?, '', ?, ?, 'debit', ?)`).run(code, code, code, parent, parent ? 2 : 1, cls, group).lastInsertRowid);
  const fixPath = () => { for (const a of db.prepare('SELECT id, parent_id FROM accounts').all()) db.prepare('UPDATE accounts SET path = ? WHERE id = ?').run(a.parent_id ? `/${a.parent_id}/${a.id}/` : `/${a.id}/`, a.id); };
  const g1 = mk('1', 'asset', null, 1); const g4 = mk('4', 'revenue', null, 1); const g5 = mk('5', 'expense', null, 1);
  const acc = [mk('1101', 'asset', g1, 0), mk('1102', 'asset', g1, 0), mk('4101', 'revenue', g4, 0), mk('4102', 'revenue', g4, 0), mk('5101', 'expense', g5, 0), mk('5102', 'expense', g5, 0)];
  fixPath();
  S.fiscal; db.prepare("INSERT INTO fiscal_years (code, name_ar, name_en, start_date, end_date, period_type) VALUES ('FY26', '2026', '2026', '2026-01-01', '2026-12-31', 'monthly')").run();
  const fy = db.prepare('SELECT id FROM fiscal_years').get().id;
  for (const p of S.fiscal.generatePeriods('2026-01-01', '2026-12-31', 'monthly')) db.prepare('INSERT INTO fiscal_periods (fiscal_year_id, seq, name_ar, name_en, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)').run(fy, p.seq, p.nameAr, p.nameEn, p.start, p.end);

  const t0 = Date.now();
  const BATCH = 2000;
  for (let i = 0; i < N; i += BATCH) {
    inTransaction(db, () => {
      for (let k = i; k < Math.min(N, i + BATCH); k++) {
        const m = String((k % 12) + 1).padStart(2, '0'); const d = String((k % 28) + 1).padStart(2, '0');
        const amt = `${(k % 9973) + 1}.${String(k % 100).padStart(2, '0')}`;
        const e = S.journal.createDraft(ctx, { branchId, entryDate: `2026-${m}-${d}`, description: 'قيد قياس ' + k, futureDateConfirmed: true,
          lines: [{ accountId: acc[k % 6], debit: amt }, { accountId: acc[(k + 3) % 6], credit: amt }] });
        S.journal.postEntry(ctx, e.id);
      }
    });
    if ((i / BATCH) % 10 === 0) process.stdout.write(`posted ${Math.min(N, i + BATCH)} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
  const postMs = Date.now() - t0;
  const gl = db.prepare('SELECT count(*) c FROM gl_entries').get().c;
  const req = (q) => ({ ...ctx, query: q });
  const time = (label, fn, runs = 3) => { const ms = []; let r; for (let i = 0; i < runs; i++) { const a = process.hrtime.bigint(); r = fn(); ms.push(Number(process.hrtime.bigint() - a) / 1e6); } return { label, bestMs: Math.round(Math.min(...ms)), worstMs: Math.round(Math.max(...ms)), r }; };
  // التقارير نفسها عبر المسارات المسجلة
  const route = (p) => app.router.routes.find((r) => r.method === 'GET' && r.pattern === p).handler;
  const tb = time('trial balance, full year', () => route('/api/ledger/trial-balance')(req({ from: '2026-01-01', to: '2026-12-31' })));
  const tbm = time('trial balance, one month', () => route('/api/ledger/trial-balance')(req({ from: '2026-06-01', to: '2026-06-30' })));
  const st = time('account statement, one month (July)', () => route('/api/ledger/statement')(req({ accountId: String(acc[0]), from: '2026-07-01', to: '2026-07-31' })));
  const jr = time('journal register, first page (50 docs)', () => route('/api/ledger/journal')(req({ from: '2026-01-01', to: '2026-12-31' })));
  const integ = time('ledger integrity check', () => S.ledger.integrity(), 1);
  const out = { entries: N, glLines: gl, postSeconds: Math.round(postMs / 1000), postsPerSecond: Math.round(N / (postMs / 1000)),
    dbSizeMB: Math.round(fs.statSync(path.join(dir, 'tayl.db')).size / 1048576),
    timings: [tb, tbm, st, jr, integ].map(({ label, bestMs, worstMs }) => ({ label, bestMs, worstMs })),
    trialBalanceBalanced: tb.r.totals.balanced.all, integrityOk: integ.r.ok, statementRows: st.r.rows.length };
  console.log(JSON.stringify(out, null, 2));
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });

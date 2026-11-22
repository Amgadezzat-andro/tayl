'use strict';
/*
 * قياس أداء المخزون (المرحلة 6) — ليس ضمن npm test.
 * يرحّل مستندات حقيقية عبر المحرك المركزي (services.inventory.documents) حتى يتجاوز السجل N حركة: أذون إضافة (منها دفعات
 * بصلاحية)، أذون صرف (FEFO آلي للدفعات)، وتحويلات بين المخازن، على 200 صنف و6 مخازن في فرعين — كل مستند بقيده عبر ledger.post.
 * ثم يقيس: الرصيد الحالي، الرصيد حسب المخزن، كارت صنف نشط، التقييم الحالي والتاريخي، المطابقة مع الأستاذ، بدء جرد (لقطة)،
 * والتحقق الكامل من الملخصات مقابل السجل، وأقصى ذاكرة.
 *   node tests/perf/inv-bench.js [moves=100000]
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
  const dir = fs.mkdtempSync(path.join(process.env.TAYL_BENCH_DIR || os.tmpdir(), 'tayl-inv-bench-'));
  const app = await createApp({ config: loadConfig({ dataDir: dir, port: 0 }), logger: createLogger({}) });
  const { db, services: S } = app;
  db.prepare("INSERT INTO company (id, name_ar, name_en, base_currency, default_language) VALUES (1, 'شركة قياس', 'Bench Co', 'EGP', 'ar')").run();
  const br = ['HQ', 'ALX'].map((c, i) => Number(db.prepare('INSERT INTO branches (code, name_ar, name_en, is_main) VALUES (?, ?, ?, ?)').run(c, c, c, i === 0 ? 1 : 0).lastInsertRowid));
  const userId = Number(db.prepare("INSERT INTO users (username, display_name, password_hash, is_super_admin, all_branches) VALUES ('bench', 'Bench', 'scrypt$bench-not-a-real-hash', 1, 1)").run().lastInsertRowid);
  const ctx = { user: { id: userId, username: 'bench', isSuperAdmin: true }, ip: '127.0.0.1', requestId: 'bench', branchId: br[0],
    access: { allBranches: true, can: () => true, assertBranch() {}, branchAllowed: () => true, branchIds: () => br,
      scope: () => ({ all: true, ids: null }), sqlFilter: () => ({ sql: '1 = 1', params: [] }) } };
  S.currencies.ensureBase();
  const mk = (code, cls, parent, group) => Number(db.prepare(`INSERT INTO accounts (code, name_ar, name_en, parent_id, path, level, class_code, normal_balance, is_group)
    VALUES (?, ?, ?, ?, '', ?, ?, 'debit', ?)`).run(code, code, code, parent, parent ? 2 : 1, cls, group).lastInsertRowid);
  const g = { asset: mk('1', 'asset', null, 1), liability: mk('2', 'liability', null, 1), cogs: mk('5', 'cogs', null, 1), expense: mk('6', 'expense', null, 1) };
  const A = { inv: mk('1201', 'asset', g.asset, 0), transit: mk('1202', 'asset', g.asset, 0), grni: mk('2102', 'liability', g.liability, 0), cogs: mk('5101', 'cogs', g.cogs, 0), adj: mk('6201', 'expense', g.expense, 0) };
  for (const a of db.prepare('SELECT id, parent_id FROM accounts').all()) db.prepare('UPDATE accounts SET path = ? WHERE id = ?').run(a.parent_id ? `/${a.parent_id}/${a.id}/` : `/${a.id}/`, a.id);
  const fy = Number(db.prepare("INSERT INTO fiscal_years (code, name_ar, name_en, start_date, end_date, period_type) VALUES ('FY2026', 'FY2026', 'FY2026', '2026-01-01', '2026-12-31', 'monthly')").run().lastInsertRowid);
  for (const p of S.fiscal.generatePeriods('2026-01-01', '2026-12-31', 'monthly')) db.prepare('INSERT INTO fiscal_periods (fiscal_year_id, seq, name_ar, name_en, start_date, end_date) VALUES (?, ?, ?, ?, ?, ?)').run(fy, p.seq, p.nameAr, p.nameEn, p.start, p.end);
  const M = S.inventory.masters; const E = S.inventory.documents;
  M.saveSettings(ctx, { inventoryAccountId: A.inv, issueAccountId: A.cogs, adjustmentAccountId: A.adj, transitAccountId: A.transit });
  const kg = db.prepare("SELECT id FROM units WHERE code = 'KG'").get().id;
  const grp = M.groups.create(ctx, { code: 'G1', nameAr: 'مجموعة', nameEn: 'Group', defaultItemType: 'raw_material' });
  const items = [];
  for (let i = 1; i <= 200; i++) {
    const tracked = i % 4 === 0;
    items.push({ ...M.items.create(ctx, { code: 'IT' + String(i).padStart(4, '0'), nameAr: 'صنف ' + i, nameEn: 'Item ' + i, groupId: grp.id, baseUnitId: kg, ...(tracked ? { trackBatches: true, trackExpiry: true } : {}) }), tracked });
  }
  const wh = [];
  for (const [b, codes] of [[br[0], ['HQ-A', 'HQ-B', 'HQ-C']], [br[1], ['AX-A', 'AX-B', 'AX-C']]]) for (const c of codes) wh.push(M.warehouses.create(ctx, { code: c, nameAr: c, nameEn: c, branchId: b, whType: 'general' }));
  const sibling = (w) => wh.filter((x) => x.branchId === w.branchId && x.id !== w.id);
  const t0 = Date.now();
  let moves = 0; let docs = 0; let k = 0; let batchSeq = 0;
  const day = (n) => { const d = new Date(Date.UTC(2026, 0, 2) + Math.floor(n) * 86400000); return d.toISOString().slice(0, 10); };
  const totalSteps = Math.ceil(N / 16);
  const post = (body) => { const id = E.createDraft(ctx, body); E.post(ctx, id, {}); docs++; };
  while (moves < N) {
    inTransaction(db, () => {
      for (let j = 0; j < 100 && moves < N; j++, k++) {
        const date = day((k / totalSteps) * 320);   // 2 يناير ← منتصف نوفمبر، تواريخ غير متناقصة (لا ترحيل بأثر رجعي)
        const w = wh[k % wh.length];
        const pick = (o) => items[(k * 7 + o * 13) % items.length];
        // إضافة 5 أصناف (الدفعات برقم جديد وصلاحية)
        post({ docType: 'receipt', warehouseId: w.id, docDate: date, counterAccountId: A.grni, lines: [0, 1, 2, 3, 4].map((o) => {
          const it = pick(o);
          const exp = day(200 + ((k + o) % 300));
          return { itemId: it.id, qty: String(200 + ((k + o) % 50)), unitCost: `${5 + ((k + o) % 20)}.${String((k * 3 + o) % 100).padStart(2, '0')}`,
            ...(it.tracked ? { batchNo: 'B' + (++batchSeq), expiryDate: exp > '2026-12-31' ? '2027-06-30' : (exp > date ? exp : '2027-01-31') } : {}) };
        }) });
        // صرف من الأصناف نفسها (FEFO آلي للدفعات)
        post({ docType: 'issue', warehouseId: w.id, docDate: date, lines: [0, 1, 2, 3, 4].map((o) => ({ itemId: pick(o).id, qty: `${1 + ((k + o) % 9)}.${(k + o) % 10}` })) });
        // تحويل 3 أصناف لمخزن آخر في الفرع نفسه
        const to = sibling(w)[k % 2];
        post({ docType: 'transfer', warehouseId: w.id, toWarehouseId: to.id, docDate: date, lines: [0, 1, 2].map((o) => ({ itemId: pick(o).id, qty: String(1 + ((k + o) % 5)) })) });
        moves = db.prepare('SELECT count(*) c FROM inv_moves').get().c;
      }
    });
    if (k % 1000 < 100) process.stdout.write(`moves ${moves}, documents ${docs} (${Math.round((Date.now() - t0) / 1000)}s)\n`);
  }
  const postMs = Date.now() - t0;
  global.gc && global.gc();
  peakRss = 0; sample();
  const timer = setInterval(sample, 20);
  const time = (label, fn) => { const a = process.hrtime.bigint(); const r = fn(); sample(); return { label, ms: Math.round(Number(process.hrtime.bigint() - a) / 1e6), r }; };
  const R = S.inventory.reports;
  const busy = db.prepare('SELECT item_id, count(*) c FROM inv_moves GROUP BY item_id ORDER BY c DESC LIMIT 1').get();
  const mid = day(160);
  const stock = time('current stock by item (200 items, 6 warehouses)', () => R.run(ctx, 'stock', {}));
  const byWh = time('current stock by branch and warehouse', () => R.run(ctx, 'stock-by-warehouse', {}));
  const card = time(`item card, busiest item (${busy.c} movements, all warehouses)`, () => R.run(ctx, 'item-card', { itemId: String(busy.item_id) }));
  const valNow = time('valuation (current, from summaries)', () => R.run(ctx, 'valuation', {}));
  const valHist = time(`historical valuation as of ${mid} (from the movement log)`, () => R.run(ctx, 'valuation', { asOf: mid }));
  const batches = time('batches and expiry report', () => R.run(ctx, 'batches', {}));
  const recon = time('ledger reconciliation (inventory vs GL)', () => R.run(ctx, 'gl-reconciliation', {}));
  const count = time('start a count session (snapshot of one warehouse)', () => S.inventory.counts.create(ctx, { warehouseId: wh[0].id, countDate: day(321) }));
  const verify = time('full verification: rebuild every balance and pool from the log', () => E.verify());
  clearInterval(timer);
  const D = S.decimal;
  const glInv = db.prepare("SELECT dec_sum(debit) d, dec_sum(credit) c FROM gl_entries WHERE account_id = ?").get(A.inv);
  const out = {
    moves: db.prepare('SELECT count(*) c FROM inv_moves').get().c, documents: docs, batches: db.prepare('SELECT count(*) c FROM inv_batches').get().c,
    glLines: db.prepare('SELECT count(*) c FROM gl_entries').get().c, postSeconds: Math.round(postMs / 1000), docsPerSecond: Math.round(docs / (postMs / 1000)),
    timings: [stock, byWh, card, valNow, valHist, batches, recon, count, verify].map(({ label, ms }) => ({ label, ms })),
    checks: {
      verifyOk: verify.r.ok, reconciled: recon.r.reconciled,
      valuationEqualsGl: valNow.r.totals.value === D.canonical(D.sub(glInv.d, glInv.c)),
      itemCardEndsAtPoolBalance: card.r.totals.balanceQty === db.prepare('SELECT dec_sum(qty) q FROM inv_pools WHERE item_id = ?').get(busy.item_id).q,
      historicalBelowCurrentDate: valHist.r.meta.asOf === mid && valHist.r.rows.length > 0,
      countLines: count.r.lines.length, stockRows: stock.r.rows.length,
    },
    totalValue: valNow.r.totals.value, peakRssMB: Math.round(peakRss / 1048576), dbSizeMB: Math.round(fs.statSync(path.join(dir, 'tayl.db')).size / 1048576),
  };
  console.log(JSON.stringify(out, null, 2));
  await app.close();
  fs.rmSync(dir, { recursive: true, force: true });
})().catch((e) => { console.error(e); process.exit(1); });

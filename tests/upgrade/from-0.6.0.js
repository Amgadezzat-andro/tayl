'use strict';
/*
 * اختبار الترقية من 0.6.0 إلى 0.7.0 على قاعدة اختبارية (ليس ضمن npm test؛ لا يلمس data/tayl.db أبدًا).
 *  1) بنسخة 0.6.0 الفعلية (مستخرجة من Git): قاعدة ببيانات المراحل 1–5 (سنوات، قيود، إقفال 2024 وترحيل أرصدتها، تصنيف القوائم).
 *  2) بنسخة 0.7.0: نسخة من تلك القاعدة ⇒ نسخة احتياطية تلقائية، ترحيل المخزون وحده، بصمة كل جدول سابق دون تغيير
 *     (سلاسل الترقيم: الصفوف السابقة كما هي + 13 سلسلة مضافة)، القوائم المالية متزنة ومطابقة كما كانت، سلامة الأستاذ،
 *     ثم حركات مخزون بقيودها على القاعدة المرقّاة ومطابقتها، وإعادة التشغيل بلا ترحيلات.
 * التشغيل:
 *   git archive a03a309 --prefix=v060/ | tar -x -C <dir> && ln -s "$PWD/node_modules" <dir>/v060/node_modules
 *   node tests/upgrade/from-0.6.0.js <dir>/v060 <workdir>
 */
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const OLD = path.resolve(process.argv[2]);
const WORK = path.resolve(process.argv[3]);
const NEW = path.join(__dirname, '..', '..');

const results = [];
const check = (n, pass, extra = '') => { results.push({ n, ok: !!pass }); console.log((pass ? 'PASS ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); };
const ok = (r) => { if (r.status !== 200) throw new Error(`${r.status} ${r.text}`); return r.body; };
function hashes(db) {
  const out = {};
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
    const rows = db.prepare(`SELECT * FROM "${name}"`).all().map((r) => JSON.stringify(r)).sort();   // يشمل جداول WITHOUT ROWID
    out[name] = { n: rows.length, h: crypto.createHash('sha256').update(rows.join('\n')).digest('hex') };
  }
  return out;
}

(async () => {
  fs.rmSync(WORK, { recursive: true, force: true });
  const oldDir = path.join(WORK, 'v060-data'); const newDir = path.join(WORK, 'v070-data');
  fs.mkdirSync(oldDir, { recursive: true });

  // ── 1) بيانات 0.6.0 ──
  const H0 = require(path.join(OLD, 'tests/helpers'));
  const { seedFs, profit2024 } = require(path.join(OLD, 'tests/fs-helpers'));
  const YE = require(path.join(OLD, 'tests/year-end-helpers'));
  const s0 = await H0.startReady({ config: { dataDir: oldDir } });
  const seed = await seedFs(s0);
  await profit2024(s0, seed);
  await YE.post(s0, seed, '2025-03-01', [{ accountId: seed.acc.cash.id, debit: '700' }, { accountId: seed.acc.sales.id, credit: '700' }]);
  await YE.closePeriods(s0, seed.fy[2024].id);
  ok(await YE.closeYear(s0, seed.fy[2024].id, { carryForward: true }));
  const version0 = (await (await fetch(s0.base + '/api/system/info')).json()).version;
  const fsQ = { asOf: '2025-12-31' };
  const ctx0 = { user: { id: 1, isSuperAdmin: true }, access: { allBranches: true, can: () => true, assertBranch() {}, branchAllowed: () => true, branchIds: () => [], scope: () => ({ all: true, ids: null }), sqlFilter: () => ({ sql: '1 = 1', params: [] }) } };
  const bs0 = s0.app.services.financialStatements.balanceSheet(ctx0, fsQ);
  const is0 = s0.app.services.financialStatements.incomeStatement(ctx0, { from: '2025-01-01', to: '2025-12-31' });
  await s0.app.close();
  check('v0.6.0 database seeded with phases 1–5 data', version0 === '0.6.0', version0);

  // ── 2) الترقية بنسخة 0.7.0 على نسخة من القاعدة ──
  fs.mkdirSync(newDir, { recursive: true });
  fs.copyFileSync(path.join(oldDir, 'tayl.db'), path.join(newDir, 'tayl.db'));
  const Database = require(path.join(NEW, 'node_modules/better-sqlite3'));
  const raw0 = new Database(path.join(newDir, 'tayl.db'), { readonly: true });
  const before = hashes(raw0);
  const series0 = raw0.prepare('SELECT * FROM document_series ORDER BY id').all();
  const migs0 = raw0.prepare('SELECT module, id FROM schema_migrations').all().map((m) => `${m.module}/${m.id}`);
  raw0.close();
  const H1 = require(path.join(NEW, 'tests/helpers'));
  const { loadConfig } = require(path.join(NEW, 'server/core/config'));
  const { createApp } = require(path.join(NEW, 'server/app'));
  const app = await createApp({ config: loadConfig({ dataDir: newDir, port: 0 }), logger: H1.silent });
  const { port } = await app.listen();
  const base = `http://127.0.0.1:${port}`;
  const migs1 = app.db.prepare('SELECT module, id FROM schema_migrations').all().map((m) => `${m.module}/${m.id}`);
  check('only the inventory migration is applied', JSON.stringify(migs1.filter((m) => !migs0.includes(m))) === JSON.stringify(['inventory/0001_inventory_core']), migs1.filter((m) => !migs0.includes(m)).join(','));
  const backups = fs.existsSync(path.join(newDir, 'backups')) ? fs.readdirSync(path.join(newDir, 'backups')).filter((f) => f.endsWith('.db')) : [];
  check('automatic backup taken before migrating', backups.length >= 1, backups.join(','));
  const after = hashes(app.db);
  const changed = Object.keys(before).filter((t) => t !== 'schema_migrations' && t !== 'document_series' && (before[t].h !== after[t].h));
  check(`all ${Object.keys(before).length - 2} previous tables unchanged (row-level sha256)`, changed.length === 0, changed.join(','));
  const series1 = app.db.prepare('SELECT * FROM document_series ORDER BY id').all();
  check('document series: previous rows identical, 13 inventory series added', JSON.stringify(series1.slice(0, series0.length)) === JSON.stringify(series0) && series1.length === series0.length + 13);
  const bs1 = app.services.financialStatements.balanceSheet(ctx0, fsQ);
  const is1 = app.services.financialStatements.incomeStatement(ctx0, { from: '2025-01-01', to: '2025-12-31' });
  check('balance sheet identical after upgrade (balanced, reconciled)', bs1.balanced && bs1.reconciliation.ok && bs1.totalAssets.values[0].value === bs0.totalAssets.values[0].value);
  check('income statement identical after upgrade', is1.netProfit.value === is0.netProfit.value && is1.reconciliation.ok);
  check('ledger integrity ok after upgrade', app.services.ledger.integrity().ok);

  // ── 3) المخزون على القاعدة المرقّاة ──
  const c = H1.client(base);
  ok(await c.login(H1.ADMIN.username, H1.ADMIN.password));
  const acc = (b) => c.post('/api/accounts', b).then(ok);
  const invAcc = await acc({ code: '1401', nameAr: 'المخزون', nameEn: 'Inventory', parentId: seed.groups.assets.id });
  const grni = await acc({ code: '2401', nameAr: 'مستلم غير مفوتر', nameEn: 'GRNI', parentId: seed.groups.liab.id });
  ok(await c.put('/api/inventory/settings', { inventoryAccountId: invAcc.id, issueAccountId: seed.acc.cogs.id }));
  const g = ok(await c.post('/api/inventory/groups', { code: 'G', nameAr: 'مجموعة', nameEn: 'Group', defaultItemType: 'raw_material' }));
  const kg = app.db.prepare("SELECT id FROM units WHERE code = 'KG'").get().id;
  const item = ok(await c.post('/api/inventory/items', { code: 'UPG1', nameAr: 'صنف', nameEn: 'Item', groupId: g.id, baseUnitId: kg }));
  const w = ok(await c.post('/api/inventory/warehouses', { code: 'UPW', nameAr: 'مخزن', nameEn: 'Store', branchId: seed.hq.id, whType: 'general' }));
  const d1 = ok(await c.post('/api/inventory/documents', { docType: 'receipt', warehouseId: w.id, docDate: '2026-02-01', counterAccountId: grni.id, lines: [{ itemId: item.id, qty: '10', unitCost: '3' }] }));
  ok(await c.post(`/api/inventory/documents/${d1.id}/post`, {}));
  const d2 = ok(await c.post('/api/inventory/documents', { docType: 'issue', warehouseId: w.id, docDate: '2026-02-02', lines: [{ itemId: item.id, qty: '4' }] }));
  const p2 = ok(await c.post(`/api/inventory/documents/${d2.id}/post`, {}));
  const recon = ok(await c.get('/api/inventory/reports/gl-reconciliation'));
  check('inventory works on the upgraded database (receipt, issue, journal, reconciliation)', p2.total === '12' && recon.reconciled === true);
  const bs2 = app.services.financialStatements.balanceSheet(ctx0, { asOf: '2026-02-28' });
  check('balance sheet still balanced and reconciled with inventory entries', bs2.balanced && bs2.reconciliation.ok);
  const cf = app.services.financialStatements.cashFlow(ctx0, { from: '2026-01-01', to: '2026-02-28' });
  check('cash flow proof still holds with inventory entries (inventory source included)', cf.reconciliation.ok);
  await app.close();
  const app2 = await createApp({ config: loadConfig({ dataDir: newDir, port: 0 }), logger: H1.silent });
  check('restart applies no migration', app2.db.prepare('SELECT count(*) c FROM schema_migrations').get().c === migs1.length);
  await app2.close();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

'use strict';
/* المرحلة 6: نواة المخزون — اختبارات تكامل وHTTP على SQLite حقيقية (بيانات اختبارية فقط على قواعد مؤقتة). */
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { fork } = require('node:child_process');
const { startReady, makeUser } = require('./helpers');
const { ok } = require('./ledger-helpers');
const { setRetained, closePeriods, closeYear, post: postJournal } = require('./year-end-helpers');
const { seedInv, postNewDoc, receipt, issue, pool, glBalance, key } = require('./inv-helpers');

const err = (r) => (r.body && r.body.error ? r.body.error.code : `HTTP ${r.status}`);
const docLines = (s, id) => s.app.db.prepare('SELECT * FROM inv_document_lines WHERE doc_id = ? ORDER BY line_no').all(id);
const glOf = (s, docId) => s.app.db.prepare("SELECT account_id, debit, credit, branch_id FROM gl_entries WHERE source_type = 'inventory' AND source_id = ? ORDER BY account_id").all(docId);
/** مسودة + ترحيل؛ يعيد رمز الخطأ أو 'OK'. */
async function tryPost(client, body) {
  const d = await client.post('/api/inventory/documents', body);
  if (d.status !== 200) return err(d);
  const r = await client.post(`/api/inventory/documents/${d.body.id}/post`, {});
  return r.status === 200 ? 'OK' : err(r);
}
const verifyOk = async (s) => { const v = ok(await s.admin.get('/api/inventory/verify')); assert.equal(v.ok, true, JSON.stringify(v.problems)); };
const recon = async (s, q = '') => ok(await s.admin.get('/api/inventory/reports/gl-reconciliation' + q));

// ── أ) الأصناف والوحدات ──
test('inv 1–2: إنشاء/تعديل/إيقاف صنف، بحث بالباركود، منع تكرار الكود، ولا حذف لصنف له حركات', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const it = ok(await a.post('/api/inventory/items', { code: 'salt', nameAr: 'ملح', nameEn: 'Salt', groupId: seed.G.food.id, baseUnitId: seed.U.KG, attributes: { grade: 'A' } }));
  assert.equal(it.code, 'SALT'); assert.equal(it.itemType, 'raw_material'); assert.equal(it.valuationMethod, 'moving_average'); assert.deepEqual(it.attributes, { grade: 'A' });
  assert.equal(ok(await a.put(`/api/inventory/items/${it.id}`, { nameEn: 'Table salt' })).nameEn, 'Table salt');
  assert.equal(err(await a.post('/api/inventory/items', { code: 'SALT', nameAr: 'x', nameEn: 'x', groupId: seed.G.food.id, baseUnitId: seed.U.KG })), 'DUPLICATE');
  assert.equal(err(await a.post('/api/inventory/items', { code: 'X1', nameAr: 'x', nameEn: 'x', groupId: seed.G.raw.id, baseUnitId: seed.U.KG })), 'NOT_USABLE');   // مجموعة تجميعية
  assert.equal(ok(await a.get('/api/inventory/items?q=6221000000017')).items[0].code, 'SUGAR');
  assert.equal(ok(await a.post(`/api/inventory/items/${it.id}/status`, { active: false })).isActive, false);
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-02-01', counterAccountId: seed.A.grni.id, lines: [{ itemId: it.id, qty: '1', unitCost: '1' }] })), 'ITEM_INACTIVE');
  ok(await a.del(`/api/inventory/items/${it.id}`));   // غير مستخدم ⇒ يُحذف
  await receipt(s, seed, { lines: [{ itemId: seed.I.sugar.id, qty: '10', unitCost: '5' }] });
  assert.equal(err(await a.del(`/api/inventory/items/${seed.I.sugar.id}`)), 'IN_USE');
  assert.throws(() => s.app.db.prepare('DELETE FROM inv_items WHERE id = ?').run(seed.I.sugar.id), /cannot be deleted/);
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-02-01', counterAccountId: seed.A.grni.id, lines: [{ itemId: seed.I.service.id, qty: '1', unitCost: '1' }] })), 'ITEM_NOT_STOCK');
  assert.ok(s.app.db.prepare("SELECT count(*) c FROM audit_log WHERE action IN ('inv_item.created', 'inv_item.updated', 'inv_item.deactivated')").get().c >= 3);
});

test('inv 3–5: تحويل الوحدات الدقيق، تغيير المعامل لا يغيّر الحركات السابقة، ومنع التحويل الخاطئ', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const r1 = await receipt(s, seed, { lines: [{ itemId: seed.I.sugar.id, unitId: seed.U.BOX, qty: '2.5', unitCost: '250' }] });   // 2.5 كيس × 25 = 62.5 كجم
  assert.equal(docLines(s, r1.id)[0].base_qty, '62.5'); assert.equal(docLines(s, r1.id)[0].factor, '25'); assert.equal(r1.total, '625');
  ok(await a.put(`/api/inventory/items/${seed.I.sugar.id}/units`, { unitId: seed.U.BOX, factor: '20' }));
  const r2 = await receipt(s, seed, { date: '2026-02-02', lines: [{ itemId: seed.I.sugar.id, unitId: seed.U.BOX, qty: '1', unitCost: '200' }] });
  assert.equal(docLines(s, r2.id)[0].base_qty, '20');
  assert.equal(docLines(s, r1.id)[0].factor, '25');   // لقطة وقت الحركة ثابتة
  assert.equal(s.app.db.prepare('SELECT dec_sum(qty) q FROM inv_moves WHERE doc_id = ?').get(r1.id).q, '62.5');
  assert.equal(pool(s, seed.I.sugar.id, seed.W.raw.id).qty, '82.5');
  assert.equal(err(await a.put(`/api/inventory/items/${seed.I.sugar.id}/units`, { unitId: seed.U.G, factor: '0' })), 'VALIDATION');
  assert.equal(err(await a.put(`/api/inventory/items/${seed.I.sugar.id}/units`, { unitId: seed.U.G, factor: '-1' })), 'VALIDATION');
  assert.equal(err(await a.put(`/api/inventory/items/${seed.I.sugar.id}/units`, { unitId: seed.U.KG, factor: '2' })), 'BASE_UNIT_FACTOR');   // دوران/غموض مع وحدة الأساس
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-02-03', lines: [{ itemId: seed.I.sugar.id, unitId: seed.U.L, qty: '1' }] })), 'UNIT_NOT_DEFINED');
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-02-03', lines: [{ itemId: seed.I.sugar.id, qty: '0.000000001' }] })), 'VALIDATION');
  assert.equal(err(await a.put(`/api/inventory/items/${seed.I.sugar.id}`, { trackBatches: true })), 'ITEM_POLICY_LOCKED');
  assert.throws(() => s.app.db.prepare('UPDATE inv_items SET base_unit_id = ? WHERE id = ?').run(seed.U.G, seed.I.sugar.id), /policy is locked/);
  assert.throws(() => s.app.db.prepare('INSERT INTO inv_item_units (item_id, unit_id, factor) VALUES (?, ?, ?)').run(seed.I.sugar.id, seed.U.KG, '1'), /base unit/);
});

// ── ب) المخازن والصلاحيات ──
test('inv 6–9: عدة مخازن في الفرع، نطاق الفروع والمخازن في الخادم، المخزن الموقوف، ولا حذف لمخزن له حركات', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  assert.equal(ok(await a.get(`/api/inventory/warehouses?branchId=${seed.hq.id}`)).items.length, 3);
  await receipt(s, seed, { lines: [{ itemId: seed.I.sugar.id, qty: '10', unitCost: '5' }] });
  const perms = ['inventory.view', 'inventory_warehouses.view', 'inventory_items.view', 'inventory_documents.view', 'inventory_documents.create', 'inventory_documents.post', 'inventory_reports.view', 'inventory_valuation.view'];
  const alx = await makeUser(s, { username: 'alxinv', permissions: perms, branchIds: [seed.alx.id] });
  const c = alx.client;
  assert.deepEqual(ok(await c.get('/api/inventory/warehouses')).items.map((w) => w.code).sort(), ['ALX-MAIN', 'ALX-QRN']);
  assert.equal((await c.get(`/api/inventory/warehouses/${seed.W.raw.id}`)).status, 404);
  assert.equal((await c.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-02-01', counterAccountId: seed.A.grni.id, lines: [{ itemId: seed.I.sugar.id, qty: '1', unitCost: '1' }] })).status, 404);
  assert.equal(ok(await c.get('/api/inventory/reports/stock')).rows.length, 0);
  assert.equal(ok(await c.get('/api/inventory/documents')).total, 0);
  const hqDoc = s.app.db.prepare("SELECT id FROM inv_documents WHERE status = 'posted' LIMIT 1").get().id;
  assert.equal((await c.get(`/api/inventory/documents/${hqDoc}`)).status, 404);
  assert.equal((await c.get(`/api/inventory/reports/stock?warehouseId=${seed.W.raw.id}`)).status, 404);
  assert.equal((await c.get(`/api/inventory/reports/item-card?itemId=${seed.I.sugar.id}`)).body.rows.length, 1);   // سطر الرصيد الافتتاحي فقط
  // قيد على مستوى المخزن: مستخدم HQ مقيد بمخزن الخامات فقط
  const hqUser = await makeUser(s, { username: 'hqraw', permissions: perms, branchIds: [seed.hq.id] });
  ok(await a.put(`/api/inventory/warehouses/${seed.W.raw.id}/users`, { userId: hqUser.id, assigned: true }));
  assert.deepEqual(ok(await hqUser.client.get('/api/inventory/warehouses')).items.map((w) => w.code), ['HQ-RAW']);
  assert.equal((await hqUser.client.get(`/api/inventory/warehouses/${seed.W.fg.id}`)).status, 404);
  // المخزن الموقوف
  ok(await a.post(`/api/inventory/warehouses/${seed.W.fg.id}/status`, { active: false }));
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.fg.id, docDate: '2026-02-01', counterAccountId: seed.A.grni.id, lines: [{ itemId: seed.I.sugar.id, qty: '1', unitCost: '1' }] })), 'WAREHOUSE_INACTIVE');
  assert.equal(err(await a.del(`/api/inventory/warehouses/${seed.W.raw.id}`)), 'IN_USE');
  ok(await a.del(`/api/inventory/warehouses/${seed.W.fg.id}`));   // بلا مستندات ⇒ يُحذف
  assert.equal(err(await a.put(`/api/inventory/warehouses/${seed.W.raw.id}`, { branchId: seed.alx.id })), 'WAREHOUSE_LOCKED');
});

// ── ج) الحركات ──
test('inv 10–13: إضافة وصرف بأثر محاسبي، منع الصرف الزائد، العكس مرة واحدة، ولا تعديل لمرحّل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const r = await receipt(s, seed, { lines: [{ itemId: seed.I.sugar.id, qty: '100', unitCost: '10' }] });
  assert.match(r.number, /^IRC-HQ-FY2026-0000\d\d$/); assert.match(r.glNumber, /^IGL-HQ-FY2026-/);
  const sorted = (x) => x.sort((p, q) => p[0] - q[0]);
  assert.deepEqual(glOf(s, r.id).map((g) => [g.account_id, g.debit, g.credit]), sorted([[seed.A.inventory.id, '1000', '0'], [seed.A.grni.id, '0', '1000']]));
  const i = await issue(s, seed, { lines: [{ itemId: seed.I.sugar.id, qty: '40' }] });
  assert.deepEqual(glOf(s, i.id).map((g) => [g.account_id, g.debit, g.credit]), sorted([[seed.acc.cogs.id, '400', '0'], [seed.A.inventory.id, '0', '400']]));
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-02-11', lines: [{ itemId: seed.I.sugar.id, qty: '60.001' }] }).then(async (d) => a.post(`/api/inventory/documents/${d.body.id}/post`, {}))), 'INSUFFICIENT_STOCK');
  const rv = ok(await a.post(`/api/inventory/documents/${i.id}/reverse`, { reason: 'صرف بالخطأ' }));
  assert.match(rv.number, /^IRV-HQ-FY2026-/);
  assert.deepEqual(glOf(s, rv.id).map((g) => [g.account_id, g.debit, g.credit]), sorted([[seed.acc.cogs.id, '0', '400'], [seed.A.inventory.id, '400', '0']]));
  assert.equal(err(await a.post(`/api/inventory/documents/${i.id}/reverse`, { reason: 'مرة ثانية' })), 'ALREADY_REVERSED');
  assert.equal(err(await a.post(`/api/inventory/documents/${rv.id}/reverse`, { reason: 'عكس العكس' })), 'CANNOT_REVERSE_REVERSAL');
  assert.deepEqual(pool(s, seed.I.sugar.id, seed.W.raw.id), { qty: '100', value: '1000' });
  assert.equal(err(await a.put(`/api/inventory/documents/${r.id}`, { notes: 'تعديل' })), 'NOT_DRAFT');
  assert.equal(err(await a.post(`/api/inventory/documents/${r.id}/post`, {})), 'ALREADY_POSTED');
  assert.throws(() => s.app.db.prepare("UPDATE inv_documents SET doc_date = '2026-02-02' WHERE id = ?").run(r.id), /cannot be modified/);
  assert.throws(() => s.app.db.prepare("UPDATE inv_moves SET qty = '1' WHERE doc_id = ?").run(r.id), /immutable/);
  assert.throws(() => s.app.db.prepare('DELETE FROM inv_moves WHERE doc_id = ?').run(r.id), /immutable/);
  assert.throws(() => s.app.db.prepare("UPDATE inv_document_lines SET qty = '5' WHERE doc_id = ?").run(r.id), /drafts only/);
  // المسودة لا تؤثر على أي شيء
  const before = { moves: s.app.db.prepare('SELECT count(*) c FROM inv_moves').get().c, gl: s.app.db.prepare('SELECT count(*) c FROM gl_entries').get().c };
  const d = ok(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-02-12', lines: [{ itemId: seed.I.sugar.id, qty: '5' }] }));
  assert.equal(d.status, 'draft'); assert.equal(d.number, null);
  assert.deepEqual({ moves: s.app.db.prepare('SELECT count(*) c FROM inv_moves').get().c, gl: s.app.db.prepare('SELECT count(*) c FROM gl_entries').get().c }, before);
  ok(await a.post(`/api/inventory/documents/${d.id}/cancel`, {}));
  assert.equal(err(await a.post(`/api/inventory/documents/${d.id}/post`, {})), 'NOT_DRAFT');
  await verifyOk(s);
});

test('inv 14–15: فشل في منتصف الترحيل (عند القيد) لا يترك أثرًا جزئيًا، وidempotency للإنشاء والترحيل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin; const db = s.app.db;
  await receipt(s, seed, { lines: [{ itemId: seed.I.sugar.id, qty: '100', unitCost: '10' }] });
  const snap = () => ({ moves: db.prepare('SELECT count(*) c FROM inv_moves').get().c, gl: db.prepare('SELECT count(*) c FROM gl_entries').get().c, nums: db.prepare('SELECT count(*) c FROM issued_numbers').get().c,
    pool: pool(s, seed.I.sugar.id, seed.W.raw.id), batches: db.prepare('SELECT count(*) c FROM inv_batches').get().c });
  const before = snap();
  // الحساب المقابل يُعطَّل بعد إنشاء المسودة ⇒ تنجح الحركات ثم يفشل محرك الأستاذ ⇒ تُلغى المعاملة كلها
  const d = ok(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-02-10', counterAccountId: seed.A.consumables.id, lines: [{ itemId: seed.I.sugar.id, qty: '10' }] }));
  ok(await a.post(`/api/accounts/${seed.A.consumables.id}/status`, { active: false }));
  assert.equal(err(await a.post(`/api/inventory/documents/${d.id}/post`, {})), 'NOT_USABLE');
  assert.deepEqual(snap(), before);
  assert.equal(db.prepare('SELECT status FROM inv_documents WHERE id = ?').get(d.id).status, 'draft');
  // سطر ثانٍ يفشل ⇒ لا أثر للسطر الأول (ولا للدفعة الجديدة)
  const d2 = ok(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-02-10', counterAccountId: seed.A.grni.id,
    lines: [{ itemId: seed.I.milk.id, qty: '5', unitCost: '3', batchNo: 'M-1', expiryDate: '2027-01-01' }, { itemId: seed.I.sugar.id, qty: '1', unitCost: '1' }] }));
  ok(await a.post(`/api/inventory/items/${seed.I.sugar.id}/status`, { active: false }));
  assert.equal(err(await a.post(`/api/inventory/documents/${d2.id}/post`, {})), 'ITEM_INACTIVE');
  assert.deepEqual(snap(), before);
  ok(await a.post(`/api/inventory/items/${seed.I.sugar.id}/status`, { active: true }));
  // idempotency
  const k1 = key();
  const body = { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-02-11', counterAccountId: seed.A.grni.id, lines: [{ itemId: seed.I.sugar.id, qty: '1', unitCost: '10' }], idempotencyKey: k1 };
  const c1 = ok(await a.post('/api/inventory/documents', body)); const c2 = ok(await a.post('/api/inventory/documents', body));
  assert.equal(c1.id, c2.id); assert.equal(c2.replayed, true);
  const k2 = key();
  const p1 = ok(await a.post(`/api/inventory/documents/${c1.id}/post`, { idempotencyKey: k2 }));
  const p2 = ok(await a.post(`/api/inventory/documents/${c1.id}/post`, { idempotencyKey: k2 }));
  assert.equal(p1.number, p2.number); assert.equal(p2.replayed, true);
  assert.equal(db.prepare('SELECT count(*) c FROM inv_moves WHERE doc_id = ?').get(c1.id).c, 1);
  assert.equal(err(await a.post(`/api/inventory/documents/${c1.id}/reverse`, { reason: 'إعادة استخدام المفتاح', idempotencyKey: k2 })), 'IDEMPOTENCY_KEY_REUSED');
  await verifyOk(s);
});

/** يشغّل عمال HTTP (عمليات منفصلة على ملف القاعدة نفسه) ويطلقهم معًا. */
async function runWorkers(argsList) {
  const kids = argsList.map((args) => fork(path.join(__dirname, 'workers', 'http-worker.js'), args.map(String), { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] }));
  await Promise.all(kids.map((k) => new Promise((res, rej) => { k.once('message', res); k.once('error', rej); })));
  const results = kids.map((k) => new Promise((res, rej) => { let got = null; k.on('message', (m) => { got = m; }); k.once('exit', (code) => (code === 0 && got ? res(got) : rej(new Error(`worker exited ${code}`)))); }));
  for (const k of kids) k.send('go');
  return Promise.all(results);
}
test('inv 16: صرف متزامن من 6 عمليات منفصلة على الرصيد نفسه ⇒ لا صرف زائد، والرصيد والأستاذ متطابقان', { timeout: 120000 }, async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  await receipt(s, seed, { lines: [{ itemId: seed.I.sugar.id, qty: '100', unitCost: '7' }] });
  const drafts = [];
  for (let i = 0; i < 6; i++) drafts.push(ok(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-02-10', lines: [{ itemId: seed.I.sugar.id, qty: '30' }] })).id);
  const out = await runWorkers(drafts.map((id) => [s.dir, 'request', JSON.stringify({ path: `/api/inventory/documents/${id}/post`, body: { idempotencyKey: key() } }), a.state.cookie, a.state.csrf]));
  const res = out.flatMap((o) => o.results);
  assert.equal(res.filter((r) => r.status === 200).length, 3, JSON.stringify(res.map((r) => r.code)));
  assert.ok(res.filter((r) => r.status !== 200).every((r) => r.code === 'INSUFFICIENT_STOCK' || r.code === 'RESERVED_STOCK'));
  assert.deepEqual(pool(s, seed.I.sugar.id, seed.W.raw.id), { qty: '10', value: '70' });
  assert.equal(glBalance(s, seed.A.inventory.id), '70');
  await verifyOk(s);
});

test('inv 17: احترام الفترات المغلقة والسنوات المُقفلة (الترحيل والعكس)', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const r = await receipt(s, seed, { date: '2025-06-01', lines: [{ itemId: seed.I.sugar.id, qty: '10', unitCost: '5' }] });
  const jun = ok(await a.get('/api/fiscal-years/' + seed.fy[2025].id)).periods.find((p) => p.startDate === '2025-06-01');
  ok(await a.post(`/api/fiscal-periods/${jun.id}/close`, { reason: 'إغلاق' }));
  const d = ok(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2025-06-20', lines: [{ itemId: seed.I.sugar.id, qty: '1' }] }));
  assert.equal(err(await a.post(`/api/inventory/documents/${d.id}/post`, {})), 'PERIOD_NOT_OPEN');
  assert.equal(err(await a.post(`/api/inventory/documents/${r.id}/reverse`, { reason: 'عكس', date: '2025-06-25' })), 'PERIOD_NOT_OPEN');
  // إقفال 2025 لكل الفروع ⇒ لا مسودة ولا ترحيل بتاريخ فيها
  await setRetained(s, seed);
  await closePeriods(s, seed.fy[2025].id);
  ok(await closeYear(s, seed.fy[2025].id));
  assert.match(err(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2025-12-01', lines: [{ itemId: seed.I.sugar.id, qty: '1' }] })), /YEAR_CLOSED|PERIOD_NOT_OPEN/);
  assert.throws(() => s.app.db.prepare("UPDATE inv_documents SET status = 'posted', number = 'X-1', posted_by = 1, posted_at = 'x', series_id = 1, fiscal_period_id = ? WHERE id = ?").run(jun.id, d.id), /period must be open|closed for this branch/);
});

// ── د) التكلفة ──
test('inv 18–19، 22: المتوسط المرجح المتحرك مع إضافات متعددة، صرف جزئي، الكسور والتقريب (دقة اعتماد المبالغ 8 خانات) بلا بواقٍ', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const S = seed.I.sugar.id; const W = seed.W.raw.id;
  await receipt(s, seed, { date: '2026-02-01', lines: [{ itemId: S, qty: '100', unitCost: '10' }] });
  await receipt(s, seed, { date: '2026-02-02', lines: [{ itemId: S, qty: '50', unitCost: '12' }] });
  assert.deepEqual(pool(s, S, W), { qty: '150', value: '1600' });
  const i1 = await issue(s, seed, { date: '2026-02-03', lines: [{ itemId: S, qty: '30' }] });
  assert.equal(i1.total, '320');                                             // 1600 × 30 ÷ 150
  await receipt(s, seed, { date: '2026-02-04', lines: [{ itemId: S, qty: '0.5', unitCost: '13.3333' }] });   // 6.66665 (سياسة الاعتماد الافتراضية للمبالغ 8 خانات)
  assert.deepEqual(pool(s, S, W), { qty: '120.5', value: '1286.66665' });
  const i2 = await issue(s, seed, { date: '2026-02-05', lines: [{ itemId: S, qty: '0.333' }] });
  assert.equal(i2.total, '3.5556846');                                       // 1286.66665 × 0.333 ÷ 120.5 = 3.555684601… ⇒ 8 خانات
  const m = s.app.db.prepare('SELECT unit_cost FROM inv_moves WHERE doc_id = ?').get(i2.id);
  assert.equal(m.unit_cost, '10.6777315315');                                // لقطة تكلفة الوحدة (10 خانات)
  const rest = pool(s, S, W);
  const last = await issue(s, seed, { date: '2026-02-06', lines: [{ itemId: S, qty: rest.qty }] });
  assert.equal(last.total, rest.value);                                      // صرف كل الرصيد = كل القيمة
  assert.deepEqual(pool(s, S, W), { qty: '0', value: '0' });
  // ثلاث صرفيات لقيمة 10 على 3 كجم: الأخيرة تأخذ الباقي بالضبط (لا بواقي تقريب)
  await receipt(s, seed, { date: '2026-02-07', lines: [{ itemId: S, qty: '3', unitCost: '3.3333333333' }] });   // 9.9999999999 ⇒ 10
  const v = [];
  for (const d of ['2026-02-08', '2026-02-09', '2026-02-10']) v.push((await issue(s, seed, { date: d, lines: [{ itemId: S, qty: '1' }] })).total);
  assert.deepEqual(v, ['3.33333333', '3.33333334', '3.33333333']);
  assert.equal(glBalance(s, seed.A.inventory.id), '0');
  await verifyOk(s);
});

test('inv 20–21: المرتجع يعكس تكلفة الصرف الأصلي، والتحويل بين المخازن يحافظ على التكلفة ولا يضخم القيمة', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin; const S = seed.I.sugar.id;
  await receipt(s, seed, { date: '2026-02-01', lines: [{ itemId: S, qty: '10', unitCost: '10' }] });
  const i = await issue(s, seed, { date: '2026-02-02', lines: [{ itemId: S, qty: '4' }] });   // 40
  await receipt(s, seed, { date: '2026-02-03', lines: [{ itemId: S, qty: '10', unitCost: '20' }] });   // المتوسط الآن ≠ 10
  const line = docLines(s, i.id)[0];
  const ret = await postNewDoc(s, { docType: 'return', warehouseId: seed.W.raw.id, docDate: '2026-02-04', returnOfId: i.id, lines: [{ itemId: S, qty: '1.5', refLineId: line.id }] });
  assert.equal(ret.total, '15');
  const ret2 = await postNewDoc(s, { docType: 'return', warehouseId: seed.W.raw.id, docDate: '2026-02-04', returnOfId: i.id, lines: [{ itemId: S, qty: '2.5', refLineId: line.id }] });
  assert.equal(ret2.total, '25');                                            // الأخير يأخذ الباقي بالضبط
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'return', warehouseId: seed.W.raw.id, docDate: '2026-02-04', returnOfId: i.id, lines: [{ itemId: S, qty: '0.1', refLineId: line.id }] })
    .then((d) => a.post(`/api/inventory/documents/${d.body.id}/post`, {}))), 'RETURN_EXCEEDS_ISSUE');
  assert.deepEqual(glOf(s, ret.id).map((g) => [g.account_id, g.debit, g.credit]), [[seed.A.inventory.id, '15', '0'], [seed.acc.cogs.id, '0', '15']].sort((p, q) => p[0] - q[0]));
  const before = s.app.db.prepare('SELECT dec_sum(value) v FROM inv_pools').get().v;
  const glBefore = s.app.db.prepare('SELECT count(*) c FROM gl_entries').get().c;
  const tr = await postNewDoc(s, { docType: 'transfer', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.fg.id, docDate: '2026-02-05', lines: [{ itemId: S, qty: '6' }] });
  const avg = s.app.db.prepare("SELECT value FROM inv_moves WHERE doc_id = ? AND direction = 'out'").get(tr.id).value;
  assert.equal(s.app.db.prepare("SELECT value FROM inv_moves WHERE doc_id = ? AND direction = 'in'").get(tr.id).value, avg);
  assert.equal(s.app.db.prepare('SELECT dec_sum(value) v FROM inv_pools').get().v, before);   // لا تضخيم
  assert.equal(s.app.db.prepare('SELECT count(*) c FROM gl_entries').get().c, glBefore);      // نفس حساب المخزون ⇒ بلا قيد
  assert.equal(tr.glNumber, null);
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'transfer', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.raw.id, docDate: '2026-02-05', lines: [{ itemId: S, qty: '1' }] })), 'SAME_WAREHOUSE');
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'transfer', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.alx.id, docDate: '2026-02-05', lines: [{ itemId: S, qty: '1' }] })), 'TRANSFER_BRANCH');
  assert.equal((await recon(s)).reconciled, true);
  await verifyOk(s);
});

test('inv 23: منع التكلفة السالبة أو غير المحددة، والرصيد السالب بصلاحية وسبب مع تسوية الفرق', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin; const B = seed.I.bottle.id;
  const adj = (lines, extra = {}) => postNewDoc(s, { docType: 'adjust_in', warehouseId: seed.W.raw.id, docDate: '2026-02-01', reason: 'زيادة جرد', lines, ...extra }).catch((e) => e);
  assert.match(String(await adj([{ itemId: B, qty: '5' }])), /COST_REQUIRED/);
  const neg = (extra, client = a) => client.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-02-02', lines: [{ itemId: B, qty: '5' }], ...extra })
    .then((d) => client.post(`/api/inventory/documents/${d.body.id}/post`, {}));
  assert.equal(err(await neg({})), 'INSUFFICIENT_STOCK');
  assert.equal(err(await neg({ negativeReason: 'صرف عاجل قبل الاستلام' })), 'NEGATIVE_COST_UNKNOWN');   // لا تكلفة موثوقة سابقة
  const u = await makeUser(s, { username: 'negless', permissions: ['inventory_documents.create', 'inventory_documents.post', 'inventory_documents.view', 'inventory_warehouses.view'], allBranches: true });
  assert.equal(err(await neg({ negativeReason: 'صرف عاجل قبل الاستلام' }, u.client)), 'NEGATIVE_FORBIDDEN');
  await receipt(s, seed, { date: '2026-02-02', lines: [{ itemId: B, qty: '10', unitCost: '2' }] });
  await issue(s, seed, { date: '2026-02-03', lines: [{ itemId: B, qty: '10' }] });
  const n = ok(await neg({ docDate: '2026-02-04', negativeReason: 'صرف عاجل قبل الاستلام' }));   // بآخر تكلفة معروفة = 2
  assert.equal(n.total, '10'); assert.deepEqual(pool(s, B, seed.W.raw.id), { qty: '-5', value: '-10' });
  await receipt(s, seed, { date: '2026-02-05', lines: [{ itemId: B, qty: '8', unitCost: '3' }] });   // 24: 5 تسد السالب (10 مصروفة) + 3 × 3
  assert.deepEqual(pool(s, B, seed.W.raw.id), { qty: '3', value: '9' });
  assert.equal(glBalance(s, seed.A.inventory.id), '9');
  assert.equal(glBalance(s, seed.A.adjustment.id), '5');                     // فرق التكلفة (15 − 10) إلى حساب الفروق
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'inventory.document_posted' AND details LIKE '%negativeReason%'").get());
  assert.equal((await recon(s)).reconciled, true);
  await verifyOk(s);
});

test('inv 24، 42: تقييم المخزون يطابق الأستاذ؛ الرصيد الافتتاحي بلا قيد يظهر فرقًا حتى يقابله القيد الافتتاحي', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const op = await postNewDoc(s, { docType: 'opening', warehouseId: seed.W.raw.id, docDate: '2025-01-01', lines: [{ itemId: seed.I.sugar.id, qty: '20', unitCost: '5' }, { itemId: seed.I.bottle.id, qty: '100', unitCost: '0.5' }] });
  assert.equal(op.glNumber, null);                                           // لا رصيد محاسبي مزدوج
  let r = await recon(s, '?asOf=2025-12-31');
  assert.equal(r.reconciled, false);
  assert.equal(r.rows.find((x) => x.account === '1201').withoutGl, '150');
  assert.equal(r.rows.find((x) => x.account === '1201').difference, '-150');
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'opening', warehouseId: seed.W.raw.id, docDate: '2025-01-01', lines: [{ itemId: seed.I.sugar.id, qty: '1', unitCost: '5' }] })
    .then((d) => a.post(`/api/inventory/documents/${d.body.id}/post`, {}))), 'OPENING_EXISTS');
  // القيد الافتتاحي في الأستاذ (المرحلة 3) يتضمن المخزون ⇒ المطابقة تتم
  const j = ok(await a.post('/api/journal', { branchId: seed.hq.id, entryDate: '2025-01-01', entryType: 'opening', description: 'افتتاحي', lines: [{ accountId: seed.A.inventory.id, debit: '150' }, { accountId: seed.acc.capital.id, credit: '150' }] }));
  ok(await a.post(`/api/journal/${j.id}/post`, {}));
  await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: seed.I.sugar.id, qty: '10', unitCost: '6' }] });
  r = await recon(s);
  assert.equal(r.reconciled, true, JSON.stringify(r.rows));
  // قيد يدوي على حساب المخزون ⇒ فرق غير مفسر يمنع الاعتماد
  await postJournal(s, seed, '2026-03-02', [{ accountId: seed.A.inventory.id, debit: '7' }, { accountId: seed.acc.cash.id, credit: '7' }]);
  r = await recon(s);
  assert.equal(r.reconciled, false); assert.equal(r.rows.find((x) => x.account === '1201').glOther, '157');
});

// ── هـ) الدفعات والجودة والأرقام المسلسلة ──
async function seedBatches(s, seed) {
  const M = seed.I.milk.id;
  await receipt(s, seed, { date: '2026-01-05', lines: [
    { itemId: M, qty: '10', unitCost: '50', batchNo: 'B-LATE', productionDate: '2026-01-01', expiryDate: '2027-06-30' },
    { itemId: M, qty: '10', unitCost: '40', batchNo: 'B-EARLY', productionDate: '2025-12-01', expiryDate: '2026-12-31' },
    { itemId: M, qty: '5', unitCost: '30', batchNo: 'B-OLD', productionDate: '2025-01-01', expiryDate: '2026-03-01' },
  ] });
  const b = Object.fromEntries(s.app.db.prepare('SELECT batch_no, id FROM inv_batches WHERE item_id = ?').all(M).map((r) => [r.batch_no, r.id]));
  return { M, b };
}
test('inv 25–29: دفعات متعددة، FEFO آلي، منع المنتهي والمحجوز/المرفوض/الحجر، والتجاوز بصلاحية وسبب', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const { M, b } = await seedBatches(s, seed);
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-04-01', counterAccountId: seed.A.grni.id, lines: [{ itemId: M, qty: '1', unitCost: '1' }] })), 'BATCH_REQUIRED');
  assert.equal(pool(s, M, seed.W.raw.id, b['B-LATE']).value, '500');
  // FEFO آلي: صرف 12 بلا دفعة ⇒ B-EARLY كاملة ثم 2 من B-LATE (B-OLD منتهية تُستبعد)
  const i = await issue(s, seed, { date: '2026-04-01', lines: [{ itemId: M, qty: '12' }] });
  const mv = s.app.db.prepare('SELECT batch_id, qty, value FROM inv_moves WHERE doc_id = ? ORDER BY id').all(i.id);
  assert.deepEqual(mv.map((m) => [m.batch_id, m.qty, m.value]), [[b['B-EARLY'], '10', '400'], [b['B-LATE'], '2', '100']]);
  const sug = ok(await a.get(`/api/inventory/fefo?itemId=${M}&warehouseId=${seed.W.raw.id}&qty=3`));
  assert.deepEqual(sug.filter((x) => x.suggested).map((x) => x.batchNo), ['B-LATE']);
  assert.equal(sug.find((x) => x.batchNo === 'B-OLD').usable, false);
  // منتهية الصلاحية
  const tryIssue = (batchId, extra = {}, client = a) => client.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-04-02', lines: [{ itemId: M, qty: '1', batchId, ...(extra.line || {}) }], ...(extra.doc || {}) })
    .then((d) => client.post(`/api/inventory/documents/${d.body.id}/post`, {}));
  assert.equal(err(await tryIssue(b['B-OLD'])), 'BATCH_NOT_AVAILABLE');
  assert.equal(err(await tryIssue(b['B-OLD'], { line: { overrideFefo: true } })), 'OVERRIDE_REASON_REQUIRED');
  const lim = await makeUser(s, { username: 'nooverride', permissions: ['inventory_documents.create', 'inventory_documents.post', 'inventory_documents.view'], allBranches: true });
  assert.equal(err(await tryIssue(b['B-OLD'], { line: { overrideFefo: true }, doc: { overrideReason: 'إتلاف' } }, lim.client)), 'OVERRIDE_FORBIDDEN');
  const ov = ok(await tryIssue(b['B-OLD'], { line: { overrideFefo: true }, doc: { overrideReason: 'إتلاف دفعة منتهية' } }));
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'inventory.document_posted' AND entity_id = ? AND details LIKE '%BATCH_EXPIRED%'").get(String(ov.id)));
  // الحجر/الرفض/الإيقاف: حركة جودة
  const q = (to) => postNewDoc(s, { docType: 'quality', warehouseId: seed.W.raw.id, docDate: '2026-04-02', reason: 'فحص', lines: [{ itemId: M, batchId: b['B-LATE'], toStatus: to }] });
  for (const st of ['quarantine', 'rejected', 'hold', 'inspection']) {
    await q(st);
    assert.equal(err(await tryIssue(b['B-LATE'])), 'BATCH_NOT_AVAILABLE', st);
  }
  await q('available');
  ok(await tryIssue(b['B-LATE']));
  // FEFO صريح: دفعة أحدث مع وجود أقدم متاحة ⇒ مخالفة
  await receipt(s, seed, { date: '2026-04-03', lines: [{ itemId: M, qty: '5', unitCost: '45', batchNo: 'B-MID', expiryDate: '2027-01-31' }] });
  b['B-MID'] = s.app.db.prepare("SELECT id FROM inv_batches WHERE batch_no = 'B-MID'").get().id;
  const late = (extra = {}) => a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-04-04', lines: [{ itemId: M, qty: '1', batchId: b['B-LATE'], ...(extra.line || {}) }], ...(extra.doc || {}) })
    .then((d) => a.post(`/api/inventory/documents/${d.body.id}/post`, {}));
  assert.equal(err(await late()), 'FEFO_VIOLATION');
  ok(await late({ line: { overrideFefo: true }, doc: { overrideReason: 'طلب العميل دفعة محددة' } }));
  // حالة الجودة: صلاحيات منفصلة
  const qa = await makeUser(s, { username: 'qaonly', permissions: ['inventory_quality.view', 'inventory_quality.quarantine', 'inventory_documents.view'], allBranches: true });
  const qd = ok(await qa.client.post('/api/inventory/documents', { docType: 'quality', warehouseId: seed.W.raw.id, docDate: '2026-04-04', reason: 'اشتباه', lines: [{ itemId: M, batchId: b['B-MID'], toStatus: 'available' }] }));
  assert.equal(err(await qa.client.post(`/api/inventory/documents/${qd.id}/post`, {})), 'QUALITY_NO_CHANGE');
  assert.equal(err(await qa.client.put(`/api/inventory/documents/${qd.id}`, { lines: [{ itemId: M, batchId: b['B-MID'], toStatus: 'rejected' }] })), 'FORBIDDEN');   // لا تعديل مسودات
  ok(await a.put(`/api/inventory/documents/${qd.id}`, { lines: [{ itemId: M, batchId: b['B-MID'], toStatus: 'rejected' }] }));
  assert.equal(err(await qa.client.post(`/api/inventory/documents/${qd.id}/post`, {})), 'FORBIDDEN');   // الرفض صلاحية منفصلة
  ok(await a.put(`/api/inventory/documents/${qd.id}`, { lines: [{ itemId: M, batchId: b['B-MID'], toStatus: 'quarantine' }] }));
  ok(await qa.client.post(`/api/inventory/documents/${qd.id}/post`, {}));
  assert.equal(ok(await a.get(`/api/inventory/batches/${b['B-MID']}`)).status, 'quarantine');
  await verifyOk(s);
});

test('inv 30–31: نقل الدفعة بين المخازن والفروع يحفظ رقمها وتواريخها وحالتها، ومنع تكرار الرقم المسلسل', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const { M, b } = await seedBatches(s, seed);
  await postNewDoc(s, { docType: 'transfer', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.fg.id, docDate: '2026-04-01', lines: [{ itemId: M, qty: '4', batchId: b['B-LATE'] }] });
  const mv = s.app.db.prepare("SELECT batch_id, value FROM inv_moves WHERE warehouse_id = ? AND item_id = ?").all(seed.W.fg.id, M);
  assert.deepEqual(mv, [{ batch_id: b['B-LATE'], value: '200' }]);
  const bt = ok(await a.get(`/api/inventory/batches/${b['B-LATE']}`));
  assert.equal(bt.expiryDate, '2027-06-30'); assert.equal(bt.status, 'available');
  assert.deepEqual(bt.stock.map((x) => [x.warehouseCode, x.qty]).sort(), [['HQ-FG', '4'], ['HQ-RAW', '6']]);
  // الأرقام المسلسلة
  const P = seed.I.pump.id;
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-04-01', counterAccountId: seed.A.grni.id, lines: [{ itemId: P, qty: '2', unitCost: '1000', serials: ['SN-1'] }] })), 'SERIALS_REQUIRED');
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.raw.id, docDate: '2026-04-01', counterAccountId: seed.A.grni.id, lines: [{ itemId: P, qty: '2', unitCost: '1000', serials: ['SN-1', 'SN-1'] }] })), 'SERIAL_DUPLICATE');
  await receipt(s, seed, { date: '2026-04-01', lines: [{ itemId: P, qty: '2', unitCost: '1000', serials: ['SN-1', 'SN-2'] }] });
  const dup = ok(await a.post('/api/inventory/documents', { docType: 'receipt', warehouseId: seed.W.fg.id, docDate: '2026-04-02', counterAccountId: seed.A.grni.id, lines: [{ itemId: P, qty: '1', unitCost: '1000', serials: ['SN-2'] }] }));
  assert.equal(err(await a.post(`/api/inventory/documents/${dup.id}/post`, {})), 'SERIAL_IN_STOCK');
  assert.equal(await tryPost(a, { docType: 'issue', warehouseId: seed.W.fg.id, docDate: '2026-04-02', lines: [{ itemId: P, qty: '1', serials: ['SN-1'] }] }), 'INSUFFICIENT_STOCK');
  await postNewDoc(s, { docType: 'transfer', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.fg.id, docDate: '2026-04-02', lines: [{ itemId: P, qty: '1', serials: ['SN-1'] }] });
  const sn = ok(await a.get(`/api/inventory/serials?itemId=${P}`));
  assert.deepEqual(sn.map((x) => [x.serialNo, x.state, x.warehouseCode]), [['SN-1', 'in_stock', 'HQ-FG'], ['SN-2', 'in_stock', 'HQ-RAW']]);
  await issue(s, seed, { wh: seed.W.fg, date: '2026-04-03', lines: [{ itemId: P, qty: '1', serials: ['SN-1'] }] });
  assert.equal(await tryPost(a, { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-04-03', lines: [{ itemId: P, qty: '1', serials: ['SN-1'] }] }), 'SERIAL_NOT_IN_STOCK');
  assert.throws(() => s.app.db.prepare("UPDATE inv_serials SET state = 'in_stock', warehouse_id = ? WHERE serial_no = 'SN-1'").run(seed.W.raw.id), /follows its last movement/);
  await verifyOk(s);
});

// ── و) الجرد والتحويل والحجز ──
test('inv 32–35: جرد مطابق وعجز وزيادة، إعادة العد والعد الأعمى، الحركة أثناء الجرد، وترحيل الفروق محاسبيًا', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin; const S = seed.I.sugar.id; const B = seed.I.bottle.id; const P = seed.I.pump.id;
  await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: S, qty: '100', unitCost: '10' }, { itemId: B, qty: '50', unitCost: '2' }, { itemId: P, qty: '1', unitCost: '500', serials: ['P-1'] }] });
  const counter = await makeUser(s, { username: 'counter', permissions: ['inventory_counts.view', 'inventory_counts.count'], allBranches: true });
  const c = ok(await a.post('/api/inventory/counts', { warehouseId: seed.W.raw.id, countDate: '2026-03-10', blind: true }));
  assert.match(c.number, /^ICN-HQ-FY2026-/); assert.equal(c.lines.length, 3);
  const cc = ok(await counter.client.get(`/api/inventory/counts/${c.id}`));
  assert.equal(cc.systemHidden, true); assert.ok(cc.lines.every((l) => l.systemQty === null));
  assert.equal(ok(await a.get(`/api/inventory/counts/${c.id}`)).lines.find((l) => l.itemId === S).systemQty, '100');
  // حركة بعد اللقطة (بلا تجميد): صرف 10 سكر
  await issue(s, seed, { date: '2026-03-11', lines: [{ itemId: S, qty: '10' }] });
  const line = (id) => c.lines.find((l) => l.itemId === id).id;
  ok(await counter.client.post(`/api/inventory/counts/${c.id}/entries`, { lineId: line(S), qty: '97' }));      // عجز 3 عند القطع
  assert.equal(err(await counter.client.post(`/api/inventory/counts/${c.id}/entries`, { lineId: line(S), qty: '96' })), 'ALREADY_COUNTED');
  ok(await counter.client.post(`/api/inventory/counts/${c.id}/entries`, { lineId: line(S), qty: '98', recount: true }));   // إعادة عد صريحة
  ok(await counter.client.post(`/api/inventory/counts/${c.id}/entries`, { lineId: line(B), qty: '52' }));      // زيادة 2
  ok(await counter.client.post(`/api/inventory/counts/${c.id}/entries`, { lineId: line(P), qty: '1' }));       // مطابق
  ok(await counter.client.post(`/api/inventory/counts/${c.id}/submit`, {}));
  assert.equal(err(await counter.client.post(`/api/inventory/counts/${c.id}/entries`, { lineId: line(B), qty: '1', recount: true })), 'COUNT_NOT_OPEN');
  ok(await a.post(`/api/inventory/counts/${c.id}/approve`, {}));
  const done = ok(await a.post(`/api/inventory/counts/${c.id}/post`, { date: '2026-03-12', idempotencyKey: key() }));
  assert.equal(done.status, 'posted'); assert.equal(done.documents.length, 2);
  // الرصيد = العد − ما صُرف بعد القطع
  assert.equal(pool(s, S, seed.W.raw.id).qty, '88');
  assert.equal(pool(s, B, seed.W.raw.id).qty, '52');
  const docs = s.app.db.prepare('SELECT * FROM inv_documents WHERE count_id = ? ORDER BY id').all(c.id);
  assert.deepEqual(docs.map((d) => [d.doc_type, d.source_module, d.total_value]), [['adjust_out', 'counts', '20'], ['adjust_in', 'counts', '4']]);
  assert.equal(glBalance(s, seed.A.adjustment.id), '16');                   // عجز 20 − زيادة 4
  const diffs = ok(await a.get(`/api/inventory/reports/count-differences?countId=${c.id}`)).rows;
  assert.deepEqual(diffs.map((r) => [r.itemCode, r.difference]).sort(), [['BOTTLE', '2'], ['SUGAR', '-2']]);
  // تجميد الحركات أثناء الجرد
  const c2 = ok(await a.post('/api/inventory/counts', { warehouseId: seed.W.raw.id, countDate: '2026-03-20', freeze: true }));
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-03-21', lines: [{ itemId: S, qty: '1' }] }).then((d) => a.post(`/api/inventory/documents/${d.body.id}/post`, {}))), 'COUNT_IN_PROGRESS');
  assert.equal(err(await a.post('/api/inventory/counts', { warehouseId: seed.W.raw.id, countDate: '2026-03-20' })), 'COUNT_IN_PROGRESS');
  ok(await a.post(`/api/inventory/counts/${c2.id}/cancel`, { reason: 'إلغاء الجلسة' }));
  await issue(s, seed, { date: '2026-03-21', lines: [{ itemId: S, qty: '1' }] });
  assert.equal((await recon(s)).reconciled, true);
  await verifyOk(s);
});

test('inv 36–37: تحويل بين الفروع بالطريق، استلام جزئي ورفض للحجر وإغلاق بعجز موثق، ومنع التكرار', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin; const S = seed.I.sugar.id;
  await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: S, qty: '100', unitCost: '10' }] });
  const companyValue = () => s.app.services.decimal.canonical(s.app.services.decimal.add(s.app.db.prepare('SELECT dec_sum(value) v FROM inv_pools').get().v, glBalance(s, seed.A.transit.id)));
  const d = ok(await a.post('/api/inventory/documents', { docType: 'transfer_out', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.alx.id, docDate: '2026-03-02', lines: [{ itemId: S, qty: '40' }] }));
  const k = key();
  const sent = ok(await a.post(`/api/inventory/documents/${d.id}/post`, { idempotencyKey: k }));
  assert.equal(ok(await a.post(`/api/inventory/documents/${d.id}/post`, { idempotencyKey: k })).number, sent.number);
  assert.equal(err(await a.post(`/api/inventory/documents/${d.id}/post`, {})), 'ALREADY_POSTED');
  assert.equal(pool(s, S, seed.W.alx.id).qty, '0');                          // غير متاح بالوجهة قبل الاستلام
  assert.equal(glBalance(s, seed.A.transit.id, seed.hq.id), '400');
  assert.equal(companyValue(), '1000');                                      // لا تضخيم
  const tr = ok(await a.get('/api/inventory/transfers'));
  const tl = tr.rows[0];
  assert.equal(tl.remaining, '40'); assert.equal(tl.remainingValue, '400');
  const rk = key();
  const r1 = ok(await a.post(`/api/inventory/transfers/${tl.transferId}/receive`, { date: '2026-03-05', rejectWarehouseId: seed.W.alxQrn.id, lines: [{ transferLineId: tl.transferLineId, qty: '25', qtyRejected: '5' }], idempotencyKey: rk }));
  assert.equal(r1.status, 'partial');
  assert.equal(ok(await a.post(`/api/inventory/transfers/${tl.transferId}/receive`, { date: '2026-03-05', rejectWarehouseId: seed.W.alxQrn.id, lines: [{ transferLineId: tl.transferLineId, qty: '25', qtyRejected: '5' }], idempotencyKey: rk })).number, r1.number);
  assert.deepEqual(pool(s, S, seed.W.alx.id), { qty: '25', value: '250' });
  assert.deepEqual(pool(s, S, seed.W.alxQrn.id), { qty: '5', value: '50' });
  assert.equal(err(await a.post(`/api/inventory/transfers/${tl.transferId}/receive`, { date: '2026-03-06', lines: [{ transferLineId: tl.transferLineId, qty: '11' }] })), 'RECEIPT_EXCEEDS_TRANSIT');
  assert.equal(err(await a.post(`/api/inventory/transfers/${tl.transferId}/receive`, { date: '2026-03-06', lines: [{ transferLineId: tl.transferLineId, qty: '1' }, { transferLineId: tl.transferLineId, qty: '1' }] })), 'DUPLICATE_LINE');
  assert.equal(err(await a.post(`/api/inventory/documents/${d.id}/reverse`, { reason: 'إلغاء الإرسال' })), 'TRANSFER_HAS_RECEIPTS');
  const cl = ok(await a.post(`/api/inventory/transfers/${tl.transferId}/close`, { date: '2026-03-07', reason: 'فقد 10 كجم أثناء النقل' }));
  assert.equal(cl.shortValue, '100');
  assert.equal(glBalance(s, seed.A.transit.id), '0');                        // بالطريق صفر على مستوى الشركة
  assert.equal(glBalance(s, seed.A.transit.id, seed.alx.id), '-400');        // حساب وسيط بين الفروع
  assert.equal(glBalance(s, seed.A.adjustment.id, seed.alx.id), '100');
  assert.equal(companyValue(), '900');
  assert.equal(ok(await a.get('/api/inventory/transfers')).rows.length, 0);
  assert.equal(err(await a.post(`/api/inventory/transfers/${tl.transferId}/receive`, { date: '2026-03-08', lines: [{ transferLineId: tl.transferLineId, qty: '1' }] })), 'TRANSFER_NOT_OPEN');
  assert.equal((await recon(s)).reconciled, true);
  await verifyOk(s);
  // إرسال ثانٍ ثم عكسه قبل أي استلام
  const d2 = await postNewDoc(s, { docType: 'transfer_out', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.alx.id, docDate: '2026-03-08', lines: [{ itemId: S, qty: '5' }] });
  ok(await a.post(`/api/inventory/documents/${d2.id}/reverse`, { reason: 'إلغاء الإرسال', date: '2026-03-08' }));
  assert.equal(s.app.db.prepare('SELECT status FROM inv_transfers WHERE dispatch_doc_id = ?').get(d2.id).status, 'cancelled');
  assert.equal(glBalance(s, seed.A.transit.id), '0');
});

test('inv 38–39: حجز وفك حجز واستهلاك الحجز بالصرف، ومنع حجز أكبر من المتاح والصرف من المحجوز لغيره', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin; const S = seed.I.sugar.id; const W = seed.W.raw.id;
  await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: S, qty: '100', unitCost: '10' }] });
  const r1 = ok(await a.post('/api/inventory/reservations', { itemId: S, warehouseId: W, qty: '60', reference: 'أمر بيع مستقبلي 1' }));
  assert.equal(err(await a.post('/api/inventory/reservations', { itemId: S, warehouseId: W, qty: '41', reference: 'أمر 2' })), 'OVER_RESERVATION');
  const av = ok(await a.get(`/api/inventory/availability?itemId=${S}&warehouseId=${W}`));
  assert.deepEqual(av, { onHand: '100', unavailable: '0', reserved: '60', available: '40' });
  assert.deepEqual(pool(s, S, W), { qty: '100', value: '1000' });            // الحجز لا يغيّر الرصيد ولا القيمة
  assert.equal(err(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: W, docDate: '2026-03-02', lines: [{ itemId: S, qty: '50' }] }).then((d) => a.post(`/api/inventory/documents/${d.body.id}/post`, {}))), 'RESERVED_STOCK');
  const i = await issue(s, seed, { date: '2026-03-02', lines: [{ itemId: S, qty: '50', reservationId: r1.id }] });
  let r = ok(await a.get('/api/inventory/reservations')).find((x) => x.id === r1.id);
  assert.equal(r.consumedQty, '50'); assert.equal(r.status, 'active');
  await issue(s, seed, { date: '2026-03-03', lines: [{ itemId: S, qty: '10', reservationId: r1.id }] });
  r = ok(await a.get('/api/inventory/reservations')).find((x) => x.id === r1.id);
  assert.equal(r.status, 'consumed');
  ok(await a.post(`/api/inventory/documents/${i.id}/reverse`, { reason: 'عكس', date: '2026-03-04' }));
  r = ok(await a.get('/api/inventory/reservations')).find((x) => x.id === r1.id);
  assert.equal(r.status, 'active'); assert.equal(r.consumedQty, '10');
  const r2 = ok(await a.post('/api/inventory/reservations', { itemId: S, warehouseId: W, qty: '5', reference: 'أمر 3', expiresOn: '2026-12-31' }));
  ok(await a.post(`/api/inventory/reservations/${r2.id}/release`, { reason: 'ألغي الطلب' }));
  assert.equal(err(await a.post(`/api/inventory/reservations/${r2.id}/release`, { reason: 'مرة ثانية' })), 'RESERVATION_NOT_ACTIVE');
  assert.equal(s.app.db.prepare("SELECT count(*) c FROM gl_entries WHERE source_type = 'inventory'").get().c, 8);   // إضافة + صرفان + عكس (سطران لكل منها)؛ الحجوزات بلا أثر محاسبي
  const rep = ok(await a.get('/api/inventory/reports/reservations')).rows;
  assert.equal(rep.length, 1); assert.equal(rep[0].remaining, '50');
});

// ── ز) التقارير والتكامل ──
test('inv 40–41، 43–45: كارت الصنف، الرصيد التاريخي، التقارير حسب الفرع والمخزن، الدفعات، والتصدير والطباعة AR/EN', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin; const S = seed.I.sugar.id;
  await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: S, qty: '100', unitCost: '10' }] });
  await issue(s, seed, { date: '2026-03-05', lines: [{ itemId: S, qty: '30' }] });
  await receipt(s, seed, { wh: seed.W.alx, date: '2026-03-06', lines: [{ itemId: S, qty: '10', unitCost: '11' }] });
  await receipt(s, seed, { date: '2026-03-10', lines: [{ itemId: S, qty: '20', unitCost: '13' }] });
  const card = ok(await a.get(`/api/inventory/reports/item-card?itemId=${S}&warehouseId=${seed.W.raw.id}&from=2026-03-02`));
  assert.equal(card.rows[0].balanceQty, '100'); assert.equal(card.rows[0].balanceValue, '1000');
  assert.deepEqual(card.rows.slice(1).map((r) => [r.inQty, r.outQty, r.balanceQty]), [[null, '30', '70'], ['20', null, '90']]);
  assert.equal(card.totals.balanceQty, pool(s, S, seed.W.raw.id).qty);
  const hist = ok(await a.get('/api/inventory/reports/valuation?asOf=2026-03-07'));
  assert.deepEqual(hist.rows.map((r) => [r.warehouse, r.qty, r.value]), [['ALX-MAIN', '10', '110'], ['HQ-RAW', '70', '700']]);
  assert.equal(hist.totals.value, '810');
  const cur = ok(await a.get('/api/inventory/reports/valuation'));
  assert.equal(cur.totals.value, '1070');
  assert.equal(ok(await a.get(`/api/inventory/reports/stock?branchId=${seed.alx.id}`)).rows[0].qty, '10');
  assert.deepEqual(ok(await a.get('/api/inventory/reports/stock-by-warehouse')).rows.map((r) => [r.branch, r.warehouse, r.qty]), [['ALX', 'ALX-MAIN', '10'], ['HQ', 'HQ-RAW', '90']]);
  const { M } = await seedBatches(s, seed);
  assert.deepEqual(ok(await a.get('/api/inventory/reports/batches?expiry=expired')).rows.map((r) => r.batch), ['B-OLD']);
  assert.deepEqual(ok(await a.get('/api/inventory/reports/batches?expiry=near&days=60')).rows.map((r) => r.batch), ['B-EARLY']);
  ok(await a.put('/api/inventory/settings', { expiryAlertDays: 60 }));
  const alerts = ok(await a.get('/api/inventory/alerts'));
  assert.ok(alerts.some((x) => x.type === 'expired') && alerts.some((x) => x.type === 'near_expiry'));
  assert.equal(M > 0, true);
  // الطباعة AR/EN والتصدير برقم حقيقي
  const pa = ok(await a.get('/api/inventory/reports/valuation/print?asOf=2026-03-07'));
  assert.equal(pa.title, 'تقييم المخزون'); assert.ok(pa.meta.some((m) => m.includes('EGP')) && pa.meta.some((m) => m.includes('2026-03-07')));
  const pe = ok(await a.get('/api/inventory/reports/valuation/print?asOf=2026-03-07&lang=en'));
  assert.equal(pe.title, 'Inventory valuation'); assert.ok(pe.rows.some((r) => r.includes('700.00')));
  const x = await fetch(s.base + '/api/inventory/reports/valuation/export.xlsx?asOf=2026-03-07', { headers: { cookie: a.state.cookie } });
  assert.equal(x.status, 200);
  const buf = Buffer.from(await x.arrayBuffer());
  const zip = require('node:zlib');
  assert.ok(buf.length > 500 && buf.slice(0, 2).toString() === 'PK');
  void zip;
  assert.ok(s.app.db.prepare("SELECT 1 FROM audit_log WHERE action = 'inventory.report_exported'").get());
  const dp = ok(await a.get(`/api/inventory/documents/${s.app.db.prepare("SELECT id FROM inv_documents WHERE doc_type = 'receipt' LIMIT 1").get().id}/print?lang=en`));
  assert.match(dp.title, /^Stock receipt IRC-/);
});

test('inv 46: صلاحيات العرض والترحيل والعكس والتصدير وإخفاء القيم بلا صلاحية التقييم', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const r = await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: seed.I.sugar.id, qty: '10', unitCost: '10' }] });
  const viewer = await makeUser(s, { username: 'invview', permissions: ['inventory.view', 'inventory_documents.view', 'inventory_reports.view', 'inventory_warehouses.view'], allBranches: true });
  const v = viewer.client;
  assert.equal((await v.get(`/api/inventory/documents/${r.id}`)).status, 200);
  assert.equal(err(await v.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-03-02', lines: [{ itemId: seed.I.sugar.id, qty: '1' }] })), 'FORBIDDEN');
  const d = ok(await a.post('/api/inventory/documents', { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-03-02', lines: [{ itemId: seed.I.sugar.id, qty: '1' }] }));
  assert.equal(err(await v.post(`/api/inventory/documents/${d.id}/post`, {})), 'FORBIDDEN');
  assert.equal(err(await v.post(`/api/inventory/documents/${r.id}/reverse`, { reason: 'عكس' })), 'FORBIDDEN');
  assert.equal((await v.get('/api/inventory/reports/stock/export.xlsx')).status, 403);
  assert.equal((await v.get('/api/inventory/reports/stock/print')).status, 403);
  assert.equal((await v.get('/api/inventory/reports/valuation')).status, 403);
  const st = ok(await v.get('/api/inventory/reports/stock'));
  assert.equal(st.valuesHidden, true); assert.ok(!('value' in st.rows[0]) && !st.columns.some((c) => c.key === 'value'));
  assert.equal(ok(await v.get('/api/inventory/summary')).value, null);
  const adjOnly = await makeUser(s, { username: 'docpost', permissions: ['inventory_documents.create', 'inventory_documents.post', 'inventory_documents.view'], allBranches: true });
  const adj = ok(await adjOnly.client.post('/api/inventory/documents', { docType: 'adjust_out', warehouseId: seed.W.raw.id, docDate: '2026-03-02', reason: 'تالف', lines: [{ itemId: seed.I.sugar.id, qty: '1' }] }));
  assert.equal(err(await adjOnly.client.post(`/api/inventory/documents/${adj.id}/post`, {})), 'FORBIDDEN');   // تتطلب inventory_adjustments.post
  assert.equal((await v.get('/api/inventory/verify')).status, 403);
  // الحسابات: ربط حساب صنف يتطلب صلاحية إعدادات الربط
  const ed = await makeUser(s, { username: 'itemedit', permissions: ['inventory_items.view', 'inventory_items.update'], allBranches: true });
  assert.equal(err(await ed.client.put(`/api/inventory/items/${seed.I.sugar.id}`, { inventoryAccountId: seed.A.transit.id })), 'ACCOUNTING_SETTINGS_FORBIDDEN');
  assert.equal(err(await a.put('/api/inventory/settings', { inventoryAccountId: seed.acc.cogs.id })), 'ACCOUNT_CLASS_NOT_ALLOWED');
});

test('inv 47: لا مسار كتابة بديل — المحرك وحده يكتب الحركات والملخصات والأستاذ، والتحقق يكشف أي تلاعب ويعيد البناء', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const db = s.app.db;
  const r = await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: seed.I.sugar.id, qty: '10', unitCost: '10' }] });
  const line = docLines(s, r.id)[0];
  assert.throws(() => db.prepare("INSERT INTO inv_moves (doc_id, line_id, move_date, branch_id, warehouse_id, item_id, direction, qty, value, unit_cost, pool_qty_after, pool_value_after, posts_gl) VALUES (?, ?, '2026-03-01', ?, ?, ?, 'in', '5', '50', '10', '15', '150', 1)")
    .run(r.id, line.id, seed.hq.id, seed.W.raw.id, seed.I.sugar.id), /inventory engine for a posted document only/);
  assert.throws(() => db.prepare("UPDATE inv_balances SET qty = '999' WHERE item_id = ?").run(seed.I.sugar.id), /derived from movements only/);
  assert.throws(() => db.prepare("INSERT INTO inv_pools (item_id, warehouse_id, batch_key, qty, value, last_move_id) VALUES (?, ?, 0, '1', '1', 1)").run(seed.I.bottle.id, seed.W.raw.id), /derived from movements only/);
  assert.throws(() => db.prepare('DELETE FROM inv_pools').run(), /derived from movements only/);
  const g = db.prepare("SELECT * FROM gl_entries WHERE source_type = 'inventory' LIMIT 1").get();
  assert.throws(() => db.prepare(`INSERT INTO gl_entries (source_type, source_id, source_line_id, doc_number, entry_kind, posting_date, fiscal_period_id, fiscal_year_id, branch_id, account_id, currency_id, rate, rate_source, debit_fc, credit_fc, debit, credit, posted_by, posted_at)
    VALUES ('inventory', ?, ?, ?, 'normal', ?, ?, ?, ?, ?, ?, '1', 'base', '99', '0', '99', '0', 1, 'x')`).run(g.source_id, g.source_line_id, g.doc_number, g.posting_date, g.fiscal_period_id, g.fiscal_year_id, g.branch_id, g.account_id, g.currency_id), /must match a line of the posted inventory document/);
  assert.throws(() => db.prepare("INSERT INTO inv_gl_lines (doc_id, line_no, role, account_id, debit, credit) VALUES (?, 9, 'inventory', ?, '1', '0')").run(r.id, seed.A.inventory.id), /while posting the document only/);
  // تلاعب مقصود متجاوزًا الحراس (أعلام الصيانة) ⇒ التحقق يكشفه وإعادة البناء من السجل تصلحه
  db.prepare('UPDATE inv_settings SET rebuilding = 1').run();
  db.prepare("UPDATE inv_balances SET qty = '999' WHERE item_id = ?").run(seed.I.sugar.id);
  db.prepare('UPDATE inv_settings SET rebuilding = 0').run();
  const bad = ok(await s.admin.get('/api/inventory/verify'));
  assert.equal(bad.ok, false); assert.equal(bad.problems[0].type, 'BALANCE_MISMATCH');
  assert.ok(ok(await s.admin.get('/api/ledger/integrity')).problems.some((p) => p.type === 'INVENTORY_BALANCE_MISMATCH'));
  const fixed = ok(await s.admin.post('/api/inventory/rebuild', {}));
  assert.equal(fixed.ok, true);
  // لا origin بديل في محرك الأستاذ ولا مصدر غير معروف
  assert.throws(() => s.app.services.ledger.post({ user: { id: 1 }, access: { assertBranch() {}, can: () => true } }, { origin: 'inventory', lines: [] }), /ENTRY_TYPE_NOT_SUPPORTED|نوع الترحيل/);
});

test('inv أمان: حقن SQL في البحث والفلاتر، CSRF على مسارات الكتابة، ولا كشف لمستند خارج النطاق عبر الروابط، والقيد يرجع لمستنده', async (t) => {
  const s = await startReady(); t.after(s.stop);
  const seed = await seedInv(s);
  const a = s.admin;
  const r = await receipt(s, seed, { date: '2026-03-01', lines: [{ itemId: seed.I.sugar.id, qty: '10', unitCost: '10' }] });
  const evil = encodeURIComponent("' OR 1=1; DROP TABLE inv_moves; --");
  assert.equal(ok(await a.get(`/api/inventory/documents?q=${evil}`)).total, 0);
  assert.equal(ok(await a.get(`/api/inventory/batches?q=${evil}`)).length, 0);
  assert.equal(ok(await a.get(`/api/inventory/items?q=${evil}`)).items.length, 0);
  assert.equal((await a.get(`/api/inventory/reports/stock?warehouseId=${evil}`)).status, 400);
  assert.equal((await a.get(`/api/inventory/reports/movements?from=${evil}`)).status, 400);
  assert.equal((await a.get(`/api/inventory/reports/${evil}`)).status, 404);
  assert.ok(s.app.db.prepare('SELECT count(*) c FROM inv_moves').get().c > 0);
  const body = { docType: 'issue', warehouseId: seed.W.raw.id, docDate: '2026-03-02', lines: [{ itemId: seed.I.sugar.id, qty: '1' }] };
  const noToken = await a.post('/api/inventory/documents', body, { csrf: false });
  assert.equal(noToken.status, 403); assert.equal(noToken.body.error.code, 'CSRF_INVALID');
  assert.equal((await a.post(`/api/inventory/documents/${r.id}/reverse`, { reason: 'عكس' }, { csrf: false })).body.error.code, 'CSRF_INVALID');
  // مستخدم الإسكندرية لا يصل لمستند/قيد/دفعة HQ ولا لتقرير بمخزن HQ
  const alx = await makeUser(s, { username: 'alxsec', permissions: ['inventory_documents.view', 'inventory_reports.view', 'inventory_batches.view', 'inventory_counts.view', 'inventory_reservations.view'], branchIds: [seed.alx.id] });
  assert.equal((await alx.client.get(`/api/inventory/documents/${r.id}`)).status, 404);
  assert.equal((await alx.client.get(`/api/inventory/documents/${r.id}/print`)).status, 403);
  assert.equal((await alx.client.get(`/api/inventory/reports/item-card?itemId=${seed.I.sugar.id}&warehouseId=${seed.W.raw.id}`)).status, 404);
  assert.equal(ok(await alx.client.get('/api/inventory/reservations')).length, 0);
  const c = ok(await a.post('/api/inventory/counts', { warehouseId: seed.W.raw.id, countDate: '2026-03-03' }));
  assert.equal((await alx.client.get(`/api/inventory/counts/${c.id}`)).status, 404);
  // دفتر اليومية: قيد المخزون يحمل رقم المستند المخزني ونوعه
  const reg = ok(await a.get('/api/ledger/journal?from=2026-03-01&to=2026-03-01'));
  const e = reg.items.find((x) => x.sourceType === 'inventory');
  assert.equal(e.reference, r.number); assert.equal(e.entryType, 'inventory_receipt'); assert.equal(e.sourceId, r.id);
});

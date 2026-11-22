'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { idParam, validator } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { writeSheet, sendXlsx } = require('../../core/xlsx');
const { registerMasterRoutes } = require('../../core/master');
const { createWarehouseAccess } = require('./scope');
const { createMasters } = require('./masters');
const { createInventoryEngine } = require('./engine');
const { createReservations } = require('./reservations');
const { createCounts } = require('./counts');
const { createReports } = require('./reports');

/**
 * نواة المخزون (المرحلة 6، الإصدار 0.7.0).
 *  - البيانات الرئيسية: المجموعات، الأصناف، وحدات الصنف، المخازن والمواقع، نطاق المخازن، الإعدادات والربط المحاسبي (masters.js).
 *  - المحرك المركزي لكل حركة مخزنية والتقييم بالمتوسط المرجح المتحرك والأثر المحاسبي عبر services.ledger.post() (engine.js).
 *  - الحجوزات (reservations.js)، الجرد (counts.js)، التقارير والمطابقة مع الأستاذ (reports.js).
 *
 * نقاط التكامل للوحدات القادمة (المشتريات/المبيعات/التصنيع): services.inventory.documents.createDraft(ctx, body, { sourceModule })
 * ثم services.inventory.documents.post(ctx, id, { idempotencyKey }, { internal: true }) — المحرك نفسه، لا مسار موازٍ.
 *
 * الصلاحيات: آلية الموارد القائمة resource.action. التسمية المطلوبة inventory.<x>.<y> تقابل inventory_<x>.<y>
 * (مثل inventory.items.view = inventory_items.view)، والخاصة على المورد inventory نفسه (inventory.allow_negative ...).
 */
module.exports = {
  name: 'inventory',
  version: '1.0.0',
  dependsOn: ['company-setup', 'security', 'fiscal-years', 'chart-accounts', 'cost-centers', 'currencies', 'units', 'numbering', 'journal', 'year-end'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db, audit } = services;
    const G = 'inventory';
    services.permissions.register('inventory', [
      { resource: 'inventory', group: G, actions: ['view'], special: ['allow_negative', 'override_fefo', 'accounting_settings', 'maintenance'], superOnlyGrant: ['maintenance'] },
      { resource: 'inventory_items', group: G, actions: ['view', 'create', 'update', 'disable', 'delete', 'print', 'export'] },
      { resource: 'inventory_categories', group: G, actions: ['view'], special: ['manage'] },
      { resource: 'inventory_units', group: G, actions: ['view'], special: ['manage'] },
      { resource: 'inventory_warehouses', group: G, actions: ['view'], special: ['manage'] },
      { resource: 'inventory_documents', group: G, actions: ['view', 'create', 'approve', 'post', 'print'], special: ['edit_draft', 'reverse'] },
      { resource: 'inventory_transfers', group: G, actions: ['view', 'create'], special: ['dispatch', 'receive'] },
      { resource: 'inventory_adjustments', group: G, actions: ['view', 'post'] },
      { resource: 'inventory_counts', group: G, actions: ['view', 'create', 'approve', 'post'], special: ['count', 'review'] },
      { resource: 'inventory_costing', group: G, actions: ['view'], special: ['settings'] },
      { resource: 'inventory_valuation', group: G, actions: ['view'] },
      { resource: 'inventory_batches', group: G, actions: ['view'], special: ['manage'] },
      { resource: 'inventory_quality', group: G, actions: ['view'], special: ['release', 'quarantine', 'reject'] },
      { resource: 'inventory_reservations', group: G, actions: ['view'], special: ['manage'] },
      { resource: 'inventory_reports', group: G, actions: ['view', 'print', 'export'] },
    ]);
    const whAccess = createWarehouseAccess(db);
    const masters = createMasters(services, whAccess);
    const engine = createInventoryEngine(services, { masters, whAccess });
    const reservations = createReservations(services, { masters, whAccess, engine });
    const counts = createCounts(services, { masters, whAccess, engine });
    const reports = createReports(services, { masters, whAccess });
    services.inventory = { masters, documents: engine, reservations, counts, reports, warehouses: whAccess };

    // ── حماية البيانات المرتبطة من الحذف ──
    services.usage.register('unit', 'inventory', (d, id) => !!d.prepare('SELECT 1 FROM inv_items WHERE base_unit_id = ? UNION ALL SELECT 1 FROM inv_item_units WHERE unit_id = ? LIMIT 1').get(id, id));
    services.usage.register('account', 'inventory', (d, id) => !!d.prepare(`SELECT 1 FROM inv_settings WHERE ? IN (inventory_account_id, issue_account_id, adjustment_account_id, transit_account_id)
      UNION ALL SELECT 1 FROM inv_groups WHERE ? IN (inventory_account_id, issue_account_id, adjustment_account_id) UNION ALL SELECT 1 FROM inv_items WHERE ? IN (inventory_account_id, issue_account_id, adjustment_account_id)
      UNION ALL SELECT 1 FROM inv_documents WHERE counter_account_id = ? UNION ALL SELECT 1 FROM inv_gl_lines WHERE account_id = ? LIMIT 1`).get(id, id, id, id, id));
    services.usage.register('branch', 'inventory', (d, id) => !!d.prepare('SELECT 1 FROM inv_warehouses WHERE branch_id = ? LIMIT 1').get(id));
    services.usage.register('cost_center', 'inventory', (d, id) => !!d.prepare('SELECT 1 FROM inv_documents WHERE cost_center_id = ? UNION ALL SELECT 1 FROM inv_gl_lines WHERE cost_center_id = ? LIMIT 1').get(id, id));
    services.usage.register('inv_group', 'inventory', (d, id) => !!d.prepare('SELECT 1 FROM inv_items WHERE group_id = ? UNION ALL SELECT 1 FROM inv_counts WHERE group_id = ? LIMIT 1').get(id, id));
    services.usage.register('inv_item', 'inventory', (d, id) => !!d.prepare('SELECT 1 FROM inv_document_lines WHERE item_id = ? UNION ALL SELECT 1 FROM inv_batches WHERE item_id = ? UNION ALL SELECT 1 FROM inv_item_units WHERE item_id = ? LIMIT 1').get(id, id, id));
    services.usage.register('inv_warehouse', 'inventory', (d, id) => !!d.prepare('SELECT 1 FROM inv_documents WHERE warehouse_id = ? OR to_warehouse_id = ? UNION ALL SELECT 1 FROM inv_locations WHERE warehouse_id = ? LIMIT 1').get(id, id, id));
    // فحص سلامة الأستاذ يشمل المخزون؛ ونشاط الفترة يشمل مستندات المخزون المرحّلة
    services.ledger.registerIntegrity(() => engine.verify().problems.map((p) => ({ ...p, type: 'INVENTORY_' + p.type })));
    services.fiscal.registerPeriodActivity('inventory', (d, periodId) => d.prepare("SELECT count(*) c FROM inv_documents WHERE fiscal_period_id = ? AND status = 'posted'").get(periodId).c);

    const P = (p) => ({ permission: p });
    const anyOf = (ctx, perms) => { if (!perms.some((p) => ctx.access.can(p))) throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية'); };
    const B = '/api/inventory';
    const USE = ['inventory_items.view', 'inventory_documents.view', 'inventory_documents.create', 'inventory_transfers.create', 'inventory_counts.count', 'inventory_reservations.manage', 'inventory_reports.view', 'inventory_batches.view', 'inventory.view'];

    // ── الثوابت للواجهة ──
    router.get(`${B}/meta`, { auth: true }, () => ({
      itemTypes: masters.ITEM_TYPES, warehouseTypes: masters.WH_TYPES, docTypes: engine.MANUAL_TYPES, qualityStatuses: engine.QUALITY,
      reports: reports.REPORTS, baseCurrency: services.ledger.baseCurrency().code, today: services.ledger.today(),
    }));

    // ── قوائم مرجعية لنماذج المخزون (الوحدات، الحسابات، مراكز التكلفة، المستخدمون) دون اشتراط صلاحيات وحداتها ──
    const REF = ['inventory_items.create', 'inventory_items.update', 'inventory_units.manage', 'inventory_documents.create', 'inventory_documents.edit_draft', 'inventory.accounting_settings', 'inventory_reports.view', 'inventory_warehouses.manage'];
    router.get(`${B}/ref/units/lookup`, { auth: true }, (ctx) => { anyOf(ctx, REF); return services.units.lookup(ctx, ctx.query); });
    router.get(`${B}/ref/accounts/lookup`, { auth: true }, (ctx) => { anyOf(ctx, REF); return services.accounts.lookup(ctx, ctx.query); });
    router.get(`${B}/ref/cost-centers/lookup`, { auth: true }, (ctx) => { anyOf(ctx, REF); return services.costCenters.lookup(ctx, ctx.query); });
    router.get(`${B}/ref/users/lookup`, P('inventory_warehouses.manage'), (ctx) => {
      const ids = services.guard.visibleUserIds(ctx);
      const q = '%' + String(ctx.query.q || '').slice(0, 60).replace(/[\\%_]/g, '\\$&') + '%';
      const rows = db.prepare(`SELECT id, username, display_name FROM users WHERE is_active = 1 AND (username LIKE ? ESCAPE '\\' OR display_name LIKE ? ESCAPE '\\')
        ${ids ? `AND id IN (${ids.map(() => '?').join(',') || 'NULL'})` : ''} ORDER BY username LIMIT 21`).all(q, q, ...(ids || []));
      return { items: rows.slice(0, 20).map((u) => ({ id: u.id, code: u.username, nameAr: u.display_name, nameEn: u.display_name })), hasMore: rows.length > 20 };
    });

    // ── لوحة المخزون والتنبيهات ──
    function alerts(ctx) {
      const out = [];
      const add = (type, severity, rows, map) => { if (rows.length) out.push({ type, severity, count: rows.length, items: rows.slice(0, 15).map(map) }); };
      const r = reports.run(ctx, 'reorder', {}).rows;
      const brief = (x) => ({ itemId: x.itemId, itemCode: x.itemCode, itemName: x.itemName, qty: x.qty, warehouse: x.warehouse || null, batch: x.batch || null });
      add('out_of_stock', 'high', r.filter((x) => x.status === 'out_of_stock'), brief);
      add('below_min', 'high', r.filter((x) => x.status === 'below_min'), brief);
      add('reorder', 'medium', r.filter((x) => x.status === 'reorder'), brief);
      add('expired', 'high', reports.run(ctx, 'batches', { expiry: 'expired' }).rows, (x) => ({ ...brief(x), expiryDate: x.expiryDate }));
      add('near_expiry', 'medium', reports.run(ctx, 'batches', { expiry: 'near' }).rows, (x) => ({ ...brief(x), expiryDate: x.expiryDate, daysLeft: x.daysLeft }));
      add('quarantine', 'medium', reports.run(ctx, 'quality', {}).rows, (x) => ({ ...brief(x), reason: x.reason }));
      add('negative', 'high', reports.run(ctx, 'negative', {}).rows.filter((x) => x.reason === 'negative'), brief);
      const f = whAccess.sqlFilter(ctx, 'c.warehouse_id');
      add('count_differences', 'medium', db.prepare(`SELECT c.id, c.number, (SELECT count(*) FROM inv_count_lines l WHERE l.count_id = c.id AND l.final_qty IS NOT NULL AND dec_cmp(l.final_qty, l.system_qty) <> 0) n
        FROM inv_counts c WHERE ${f.sql} AND c.status = 'approved'`).all(...f.params).filter((x) => x.n > 0), (x) => ({ countId: x.id, count: x.number, lines: x.n }));
      const days = masters.settingsRow().stale_draft_days;
      const df = whAccess.sqlFilter(ctx, 'd.warehouse_id'); const bf = ctx.access.sqlFilter('d.branch_id');
      add('stale_drafts', 'low', db.prepare(`SELECT d.id, d.doc_type, d.doc_date, d.created_at FROM inv_documents d WHERE ${df.sql} AND ${bf.sql} AND d.status = 'draft'
        AND d.created_at < strftime('%Y-%m-%dT%H:%M:%fZ', 'now', ?) ORDER BY d.created_at`).all(...df.params, ...bf.params, `-${days} days`), (x) => ({ docId: x.id, docType: x.doc_type, docDate: x.doc_date, createdAt: x.created_at }));
      return out;
    }
    router.get(`${B}/alerts`, P('inventory.view'), (ctx) => alerts(ctx));
    router.get(`${B}/summary`, P('inventory.view'), (ctx) => {
      const f = whAccess.sqlFilter(ctx, 'w.id'); const bf = ctx.access.sqlFilter('w.branch_id');
      const value = ctx.access.can('inventory_valuation.view') ? db.prepare(`SELECT dec_sum(p.value) v FROM inv_pools p JOIN inv_warehouses w ON w.id = p.warehouse_id WHERE ${f.sql} AND ${bf.sql}`).get(...f.params, ...bf.params).v || '0' : null;
      const df = whAccess.sqlFilter(ctx, 'd.warehouse_id'); const dbf = ctx.access.sqlFilter('d.branch_id');
      return {
        items: db.prepare('SELECT count(*) c FROM inv_items WHERE is_active = 1').get().c,
        warehouses: db.prepare(`SELECT count(*) c FROM inv_warehouses w WHERE w.is_active = 1 AND ${f.sql} AND ${bf.sql}`).get(...f.params, ...bf.params).c,
        drafts: db.prepare(`SELECT count(*) c FROM inv_documents d WHERE d.status = 'draft' AND ${df.sql} AND ${dbf.sql}`).get(...df.params, ...dbf.params).c,
        openTransfers: db.prepare("SELECT count(*) c FROM inv_transfers WHERE status IN ('in_transit', 'partial')").get().c,
        openCounts: db.prepare(`SELECT count(*) c FROM inv_counts c WHERE c.status IN ('counting', 'review', 'approved') AND ${whAccess.sqlFilter(ctx, 'c.warehouse_id').sql}`).get(...whAccess.sqlFilter(ctx, 'c.warehouse_id').params).c,
        value, baseCurrency: services.ledger.baseCurrency().code, alerts: alerts(ctx),
      };
    });

    // ── المجموعات (إدارة بصلاحية واحدة inventory_categories.manage) ──
    const g = masters.groups;
    router.get(`${B}/groups/tree`, { auth: true }, (ctx) => { anyOf(ctx, ['inventory_categories.view', 'inventory_items.view', ...USE]); return g.treeList(ctx, ctx.query); });
    router.get(`${B}/groups/lookup`, { auth: true }, (ctx) => { anyOf(ctx, ['inventory_categories.view', 'inventory_items.view', ...USE]); return g.lookup(ctx, ctx.query); });
    router.get(`${B}/groups/:id`, P('inventory_categories.view'), (ctx) => g.get(ctx, idParam(ctx.params.id)));
    router.post(`${B}/groups`, P('inventory_categories.manage'), async (ctx) => g.create(ctx, await ctx.body()));
    router.put(`${B}/groups/:id`, P('inventory_categories.manage'), async (ctx) => g.update(ctx, idParam(ctx.params.id), await ctx.body()));
    router.post(`${B}/groups/:id/status`, P('inventory_categories.manage'), async (ctx) => {
      const b = await ctx.body();
      if (!b || typeof b.active !== 'boolean') throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { active: 'NOT_BOOLEAN' } });
      return g.setActive(ctx, idParam(ctx.params.id), b.active);
    });
    router.delete(`${B}/groups/:id`, P('inventory_categories.manage'), (ctx) => g.remove(ctx, idParam(ctx.params.id)));

    // ── الأصناف ووحداتها ──
    router.get(`${B}/items/:id/units`, { auth: true }, (ctx) => { anyOf(ctx, ['inventory_items.view', 'inventory_units.view', ...USE]); return masters.itemUnits(ctx, idParam(ctx.params.id)); });
    router.put(`${B}/items/:id/units`, P('inventory_units.manage'), async (ctx) => masters.setItemUnit(ctx, idParam(ctx.params.id), await ctx.body()));
    router.get(`${B}/items/:id/stock`, { auth: true }, (ctx) => {
      anyOf(ctx, ['inventory_items.view', ...USE]);
      const itemId = idParam(ctx.params.id);
      masters.items.get(ctx, itemId);
      const f = whAccess.sqlFilter(ctx, 'w.id'); const bf = ctx.access.sqlFilter('w.branch_id');
      return db.prepare(`SELECT DISTINCT w.id FROM inv_balances b JOIN inv_warehouses w ON w.id = b.warehouse_id WHERE b.item_id = ? AND ${f.sql} AND ${bf.sql}`).all(itemId, ...f.params, ...bf.params)
        .map((w) => ({ warehouse: db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn, wh_type whType FROM inv_warehouses WHERE id = ?').get(w.id), ...reservations.availability(ctx, itemId, w.id) }));
    });
    registerMasterRoutes(router, masters.items, { base: `${B}/items`, resource: 'inventory_items', lookupPerms: USE, exportFile: 'items' });

    // ── المخازن والمواقع ونطاق المستخدمين ──
    const wh = masters.warehouses;
    router.get(`${B}/warehouses`, P('inventory_warehouses.view'), (ctx) => masters.listWarehouses(ctx, ctx.query));
    router.get(`${B}/warehouses/lookup`, { auth: true }, (ctx) => {
      anyOf(ctx, ['inventory_warehouses.view', ...USE]);
      const r = wh.lookup(ctx, { ...ctx.query, limit: '50' });
      return { ...r, items: r.items.filter((w) => whAccess.allowed(ctx, { id: w.id, branch_id: w.branchId })) };
    });
    router.get(`${B}/warehouses/:id`, P('inventory_warehouses.view'), (ctx) => masters.getWarehouse(ctx, idParam(ctx.params.id)));
    router.post(`${B}/warehouses`, P('inventory_warehouses.manage'), async (ctx) => wh.create(ctx, await ctx.body()));
    router.put(`${B}/warehouses/:id`, P('inventory_warehouses.manage'), async (ctx) => { whAccess.assertWarehouse(ctx, idParam(ctx.params.id)); return wh.update(ctx, idParam(ctx.params.id), await ctx.body()); });
    router.post(`${B}/warehouses/:id/status`, P('inventory_warehouses.manage'), async (ctx) => {
      const b = await ctx.body();
      if (!b || typeof b.active !== 'boolean') throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { active: 'NOT_BOOLEAN' } });
      whAccess.assertWarehouse(ctx, idParam(ctx.params.id));
      return wh.setActive(ctx, idParam(ctx.params.id), b.active);
    });
    router.delete(`${B}/warehouses/:id`, P('inventory_warehouses.manage'), (ctx) => { whAccess.assertWarehouse(ctx, idParam(ctx.params.id)); return wh.remove(ctx, idParam(ctx.params.id)); });
    router.get(`${B}/warehouses/:id/locations`, { auth: true }, (ctx) => { anyOf(ctx, ['inventory_warehouses.view', ...USE]); return masters.locations(ctx, idParam(ctx.params.id)); });
    router.post(`${B}/warehouses/:id/locations`, P('inventory_warehouses.manage'), async (ctx) => masters.saveLocation(ctx, idParam(ctx.params.id), null, await ctx.body()));
    router.put(`${B}/warehouses/:id/locations/:locId`, P('inventory_warehouses.manage'), async (ctx) => masters.saveLocation(ctx, idParam(ctx.params.id), idParam(ctx.params.locId), await ctx.body()));
    router.get(`${B}/warehouses/:id/users`, P('inventory_warehouses.manage'), (ctx) => masters.warehouseUsers(ctx, idParam(ctx.params.id)));
    router.put(`${B}/warehouses/:id/users`, P('inventory_warehouses.manage'), async (ctx) => masters.setWarehouseUser(ctx, idParam(ctx.params.id), await ctx.body()));

    // ── الدفعات والأرقام المسلسلة ──
    const batchApi = (b) => ({ id: b.id, itemId: b.item_id, itemCode: b.item_code, itemNameAr: b.name_ar, itemNameEn: b.name_en, batchNo: b.batch_no, productionDate: b.production_date,
      expiryDate: b.expiry_date, status: b.status, expired: !!(b.expiry_date && b.expiry_date < services.ledger.today()), sourceRef: b.source_ref, notes: b.notes, qty: b.qty || '0' });
    router.get(`${B}/batches`, { auth: true }, (ctx) => {
      anyOf(ctx, ['inventory_batches.view', 'inventory_quality.view', ...USE]);
      const q = ctx.query; const w = ['1 = 1']; const p = [];
      const f = whAccess.sqlFilter(ctx, 'bl.warehouse_id');
      if (/^\d{1,15}$/.test(q.itemId || '')) { w.push('x.item_id = ?'); p.push(Number(q.itemId)); }
      if (engine.QUALITY.includes(q.status)) { w.push('x.status = ?'); p.push(q.status); }
      if (q.q) { w.push("(x.batch_no LIKE ? ESCAPE '\\' OR i.code LIKE ? ESCAPE '\\')"); const s = '%' + String(q.q).slice(0, 60).replace(/[\\%_]/g, '\\$&') + '%'; p.push(s, s); }
      const wq = /^\d{1,15}$/.test(q.warehouseId || '') ? Number(q.warehouseId) : null;
      if (wq) whAccess.assertWarehouse(ctx, wq);
      return db.prepare(`SELECT x.*, i.code item_code, i.name_ar, i.name_en, (SELECT dec_sum(bl.qty) FROM inv_balances bl WHERE bl.batch_key = x.id AND ${f.sql}${wq ? ' AND bl.warehouse_id = ?' : ''}) qty
        FROM inv_batches x JOIN inv_items i ON i.id = x.item_id WHERE ${w.join(' AND ')} ORDER BY (x.expiry_date IS NULL), x.expiry_date, x.id LIMIT 1000`).all(...f.params, ...(wq ? [wq] : []), ...p)
        .filter((b) => q.inStock !== '1' || (b.qty && b.qty !== '0')).map(batchApi);
    });
    router.get(`${B}/batches/:id`, { auth: true }, (ctx) => {
      anyOf(ctx, ['inventory_batches.view', 'inventory_quality.view', ...USE]);
      const b = db.prepare('SELECT x.*, i.code item_code, i.name_ar, i.name_en FROM inv_batches x JOIN inv_items i ON i.id = x.item_id WHERE x.id = ?').get(idParam(ctx.params.id));
      if (!b) throw new HttpError(404, 'NOT_FOUND', 'الدفعة غير موجودة');
      const f = whAccess.sqlFilter(ctx, 'bl.warehouse_id');
      const stock = db.prepare(`SELECT w.id warehouseId, w.code warehouseCode, dec_sum(bl.qty) qty FROM inv_balances bl JOIN inv_warehouses w ON w.id = bl.warehouse_id WHERE bl.batch_key = ? AND ${f.sql} GROUP BY w.id`).all(b.id, ...f.params);
      return { ...batchApi(b), stock };
    });
    router.put(`${B}/batches/:id`, P('inventory_batches.manage'), async (ctx) => {
      const d = validator(await ctx.body(), { partial: true }).str('sourceRef', { max: 120 }).str('notes', { max: 500, multiline: true }).done();
      return inTransaction(db, () => {
        const id = idParam(ctx.params.id);
        const b = db.prepare('SELECT * FROM inv_batches WHERE id = ?').get(id);
        if (!b) throw new HttpError(404, 'NOT_FOUND', 'الدفعة غير موجودة');
        db.prepare('UPDATE inv_batches SET source_ref = ?, notes = ? WHERE id = ?').run('sourceRef' in d ? d.sourceRef : b.source_ref, 'notes' in d ? d.notes : b.notes, id);
        audit.fromCtx(ctx, { action: 'inventory.batch_updated', source: 'inventory', entityType: 'inv_batch', entityId: id, details: d });
        return { ok: true };
      });
    });
    router.get(`${B}/serials`, { auth: true }, (ctx) => {
      anyOf(ctx, ['inventory_batches.view', ...USE]);
      const itemId = /^\d{1,15}$/.test(ctx.query.itemId || '') ? Number(ctx.query.itemId) : null;
      if (!itemId) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { itemId: 'REQUIRED' } });
      const f = whAccess.sqlFilter(ctx, 's.warehouse_id');
      const wq = /^\d{1,15}$/.test(ctx.query.warehouseId || '') ? Number(ctx.query.warehouseId) : null;
      return db.prepare(`SELECT s.serial_no serialNo, s.state, w.code warehouseCode, s.warehouse_id warehouseId FROM inv_serials s LEFT JOIN inv_warehouses w ON w.id = s.warehouse_id
        WHERE s.item_id = ? AND (s.state = 'out' OR ${f.sql})${wq ? ' AND s.warehouse_id = ?' : ''} ORDER BY s.serial_no LIMIT 2000`).all(itemId, ...f.params, ...(wq ? [wq] : []));
    });
    // اقتراح FEFO للصرف (أقرب انتهاء أولًا، المتاح فقط)
    router.get(`${B}/fefo`, { auth: true }, (ctx) => {
      anyOf(ctx, ['inventory_documents.create', 'inventory_documents.view', 'inventory_transfers.create']);
      const q = ctx.query;
      const itemId = idParam(q.itemId); const whId = idParam(q.warehouseId);
      const w = whAccess.assertWarehouse(ctx, whId);
      const today = services.ledger.today();
      const loc = /^\d{1,15}$/.test(q.locationId || '') ? Number(q.locationId) : 0;
      let rest = q.qty && /^\d+(\.\d+)?$/.test(q.qty) ? q.qty : null;
      const D = services.decimal;
      const rows = db.prepare(`SELECT x.id, x.batch_no, x.expiry_date, x.status, b.qty FROM inv_balances b JOIN inv_batches x ON x.id = b.batch_key WHERE b.item_id = ? AND b.warehouse_id = ? AND b.loc_key = ?
        AND dec_cmp(b.qty, '0') > 0 ORDER BY (x.expiry_date IS NULL), x.expiry_date, x.id`).all(itemId, w.id, loc);
      return rows.map((r) => {
        const usable = r.status === 'available' && !(r.expiry_date && r.expiry_date < today) && w.wh_type !== 'quarantine';
        let take = null;
        if (usable && rest != null && D.gt(rest, '0')) { take = D.canonical(D.min(rest, r.qty)); rest = D.canonical(D.sub(rest, take)); }
        return { batchId: r.id, batchNo: r.batch_no, expiryDate: r.expiry_date, status: r.status, qty: r.qty, usable, suggested: take };
      });
    });

    // ── المستندات ──
    const E = engine;
    router.get(`${B}/documents`, P('inventory_documents.view'), (ctx) => E.list(ctx, ctx.query));
    router.post(`${B}/documents`, { auth: true }, async (ctx) => {
      const body = await ctx.body();
      return inTransaction(db, () => {
        const prior = E.replay(ctx, body && body.idempotencyKey, 'create');
        if (prior) return { ...E.get(ctx, prior.id), replayed: true };
        const id = E.createDraft(ctx, body);
        const result = E.get(ctx, id);
        E.remember(ctx, body.idempotencyKey, 'create', { id, replayedDocument: true });
        return result;
      });
    });
    router.get(`${B}/documents/:id`, P('inventory_documents.view'), (ctx) => E.get(ctx, idParam(ctx.params.id)));
    router.put(`${B}/documents/:id`, P('inventory_documents.edit_draft'), async (ctx) => { const id = E.updateDraft(ctx, idParam(ctx.params.id), await ctx.body()); return E.get(ctx, id); });
    router.post(`${B}/documents/:id/cancel`, P('inventory_documents.edit_draft'), (ctx) => E.get(ctx, E.cancelDraft(ctx, idParam(ctx.params.id))));
    router.post(`${B}/documents/:id/approve`, P('inventory_documents.approve'), (ctx) => E.get(ctx, E.approve(ctx, idParam(ctx.params.id))));
    router.post(`${B}/documents/:id/preview`, { auth: true }, (ctx) => { anyOf(ctx, ['inventory_documents.post', 'inventory_documents.create', 'inventory_transfers.dispatch', 'inventory_adjustments.post']); return E.preview(ctx, idParam(ctx.params.id)); });
    router.post(`${B}/documents/:id/post`, { auth: true }, async (ctx) => { const r = E.post(ctx, idParam(ctx.params.id), (await ctx.body()) || {}); return { ...r, document: E.get(ctx, r.id) }; });
    router.post(`${B}/documents/:id/reverse`, P('inventory_documents.reverse'), async (ctx) => { const r = E.reverse(ctx, idParam(ctx.params.id), (await ctx.body()) || {}); return { ...r, document: E.get(ctx, r.id) }; });
    router.get(`${B}/documents/:id/print`, P('inventory_documents.print'), (ctx) => {
      const d = E.get(ctx, idParam(ctx.params.id));
      const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
      const t = (k, v) => services.i18n.t(lang, k, v);
      const D = services.decimal;
      const canValue = ctx.access.can('inventory_valuation.view');
      const company = services.company.get() || {};
      return {
        title: `${t('inv.doc.' + d.docType)} ${d.number || t('inv.status.draft')}`,
        meta: [`${t('fs.company')}: ${lang === 'ar' ? company.nameAr || '' : company.nameEn || ''}`, `${t('inv.col.warehouse')}: ${d.warehouse ? d.warehouse.code : ''}${d.toWarehouse ? ' → ' + d.toWarehouse.code : ''}`,
          `${t('inv.col.date')}: ${d.docDate}`, `${t('inv.col.status')}: ${t('inv.status.' + d.status)}`, `${t('fs.currency')}: ${d.baseCurrency}`,
          ...(d.glNumber ? [`${t('inv.glNumber')}: ${d.glNumber}`] : []), ...(d.reason ? [`${t('inv.reason')}: ${d.reason}`] : []),
          `${t('fs.issuedAt')}: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`],
        columns: [t('inv.col.itemCode'), t('inv.col.itemName'), t('inv.col.unit'), t('inv.col.qty'), t('inv.col.batch'), ...(canValue ? [t('inv.col.value')] : [])],
        rows: d.lines.map((l) => [l.itemCode, lang === 'ar' ? l.itemNameAr : l.itemNameEn, l.unitCode, D.format(l.qty, 'quantity'), l.batchNo || '', ...(canValue ? [l.value ? D.format(l.value, 'amount', d.baseCurrency) : ''] : [])]),
      };
    });

    // ── التحويلات بين الفروع ──
    router.get(`${B}/transfers`, P('inventory_transfers.view'), (ctx) => reports.run(ctx, 'transfers', ctx.query));
    router.post(`${B}/transfers/:id/receive`, P('inventory_transfers.receive'), async (ctx) => E.receive(ctx, idParam(ctx.params.id), (await ctx.body()) || {}));
    router.post(`${B}/transfers/:id/close`, P('inventory_transfers.receive'), async (ctx) => E.closeTransfer(ctx, idParam(ctx.params.id), (await ctx.body()) || {}));

    // ── الجرد ──
    const C = counts;
    router.get(`${B}/counts`, P('inventory_counts.view'), (ctx) => C.list(ctx, ctx.query));
    router.post(`${B}/counts`, P('inventory_counts.create'), async (ctx) => C.create(ctx, await ctx.body()));
    router.get(`${B}/counts/:id`, { auth: true }, (ctx) => { anyOf(ctx, ['inventory_counts.view', 'inventory_counts.count']); return C.get(ctx, idParam(ctx.params.id)); });
    router.post(`${B}/counts/:id/lines`, P('inventory_counts.count'), async (ctx) => C.addLine(ctx, idParam(ctx.params.id), await ctx.body()));
    router.post(`${B}/counts/:id/entries`, P('inventory_counts.count'), async (ctx) => C.enter(ctx, idParam(ctx.params.id), await ctx.body()));
    router.post(`${B}/counts/:id/submit`, P('inventory_counts.count'), (ctx) => C.submit(ctx, idParam(ctx.params.id)));
    router.post(`${B}/counts/:id/reopen`, P('inventory_counts.review'), (ctx) => C.reopen(ctx, idParam(ctx.params.id)));
    router.post(`${B}/counts/:id/approve`, P('inventory_counts.approve'), async (ctx) => C.approve(ctx, idParam(ctx.params.id), (await ctx.body()) || {}));
    router.post(`${B}/counts/:id/post`, P('inventory_counts.post'), async (ctx) => C.post(ctx, idParam(ctx.params.id), (await ctx.body()) || {}));
    router.post(`${B}/counts/:id/cancel`, P('inventory_counts.create'), async (ctx) => C.cancel(ctx, idParam(ctx.params.id), (await ctx.body()) || {}));

    // ── الحجوزات والمتاح ──
    router.get(`${B}/reservations`, P('inventory_reservations.view'), (ctx) => reservations.list(ctx, ctx.query));
    router.post(`${B}/reservations`, P('inventory_reservations.manage'), async (ctx) => reservations.create(ctx, await ctx.body()));
    router.post(`${B}/reservations/:id/release`, P('inventory_reservations.manage'), async (ctx) => reservations.release(ctx, idParam(ctx.params.id), await ctx.body()));
    router.get(`${B}/availability`, { auth: true }, (ctx) => { anyOf(ctx, USE); return reservations.availability(ctx, idParam(ctx.query.itemId), idParam(ctx.query.warehouseId)); });

    // ── الإعدادات (التقييم والربط المحاسبي) ──
    router.get(`${B}/settings`, { auth: true }, (ctx) => { anyOf(ctx, ['inventory_costing.view', 'inventory_costing.settings', 'inventory.accounting_settings', 'inventory.view']); return masters.settings(); });
    router.put(`${B}/settings`, { auth: true }, async (ctx) => { anyOf(ctx, ['inventory_costing.settings', 'inventory.accounting_settings']); return masters.saveSettings(ctx, await ctx.body()); });

    // ── التقارير ──
    router.get(`${B}/reports/:name`, P('inventory_reports.view'), (ctx) => reports.run(ctx, ctx.params.name, ctx.query));
    router.get(`${B}/reports/:name/print`, P('inventory_reports.print'), (ctx) => { const { xrows, ...d } = reports.table(reports.run(ctx, ctx.params.name, ctx.query), ctx.query.lang === 'en' ? 'en' : 'ar'); return d; });   // eslint-disable-line no-unused-vars
    router.get(`${B}/reports/:name/export.xlsx`, P('inventory_reports.export'), (ctx) => {
      const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
      const r = reports.run(ctx, ctx.params.name, ctx.query);
      const d = reports.table(r, lang);
      audit.fromCtx(ctx, { action: 'inventory.report_exported', source: 'inventory', entityType: 'inventory_report', details: { report: r.report, rows: r.rows.length, query: ctx.query } });
      sendXlsx(ctx.res, `${r.report}.xlsx`, writeSheet({ sheetName: r.report, header: d.columns, rows: [[d.title], ...d.meta.map((m) => [m]), [], ...d.xrows], rtl: lang === 'ar' }));
    });

    // ── الصيانة: التحقق من الملخصات وإعادة بنائها من السجل ──
    router.get(`${B}/verify`, P('inventory.maintenance'), () => E.verify());
    router.post(`${B}/rebuild`, P('inventory.maintenance'), (ctx) => E.rebuild(ctx));
  },
};

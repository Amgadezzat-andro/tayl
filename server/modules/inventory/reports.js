'use strict';
const { HttpError } = require('../../core/errors');

/**
 * تقارير المخزون. كل تقرير من سجل الحركات (inv_moves) أو من ملخصاته المشتقة منه، ضمن نطاق الفروع والمخازن للمستخدم.
 * التقارير التاريخية (as-of) تُبنى من السجل حتى التاريخ (قيمة كل حركة لقطة ثابتة، فالبناء دقيق دائمًا).
 * أعمدة القيمة والتكلفة لمن يملك inventory_valuation.view فقط.
 * كل تقرير: { report, columns: [{ key, label, type }], rows, totals, meta } — type: text | qty | amount | cost | date | int.
 */
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SIGNED_Q = "CASE m.direction WHEN 'in' THEN m.qty ELSE '-' || m.qty END";
const SIGNED_V = "CASE WHEN m.direction = 'in' OR m.value = '0' THEN m.value ELSE '-' || m.value END";

function createReports(services, { masters, whAccess }) {
  const { db, decimal: D } = services;
  const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };
  const today = () => services.ledger.today();
  const base = () => services.ledger.baseCurrency().code;
  const id = (v) => (/^[1-9]\d{0,15}$/.test(String(v ?? '')) ? Number(v) : null);
  const div = (v, q) => (D.isZero(q) ? null : D.commit(D.div(v, q), 'unit_cost'));

  /** نطاق المخازن: الفرع (أو مجموعة فروع) + نطاق المخازن + مخزن محدد. */
  function scope(ctx, q, wcol = 'w') {
    const parts = []; const params = [];
    const b = ctx.access.sqlFilter(`${wcol}.branch_id`, q.branchId); parts.push(b.sql); params.push(...b.params);
    const f = whAccess.sqlFilter(ctx, `${wcol}.id`); parts.push(f.sql); params.push(...f.params);
    const whId = id(q.warehouseId);
    if (q.warehouseId && !whId) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { warehouseId: 'INVALID' } });
    if (whId) { whAccess.assertWarehouse(ctx, whId); parts.push(`${wcol}.id = ?`); params.push(whId); }
    return { sql: parts.join(' AND '), params, warehouseId: whId };
  }
  function itemFilter(q, icol = 'i') {
    const parts = []; const params = [];
    const g = id(q.groupId);
    if (g) { parts.push(`${icol}.group_id IN (SELECT id FROM inv_groups WHERE path LIKE (SELECT path FROM inv_groups WHERE id = ?) || '%')`); params.push(g); }
    const it = id(q.itemId);
    if (it) { parts.push(`${icol}.id = ?`); params.push(it); }
    if (q.itemType && masters.ITEM_TYPES.includes(q.itemType)) { parts.push(`${icol}.item_type = ?`); params.push(q.itemType); }
    return { sql: parts.length ? parts.join(' AND ') : '1 = 1', params };
  }
  const dateQ = (v, field) => { if (v == null || v === '') return null; if (!DATE_RE.test(v)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: 'INVALID' } }); return v; };
  const col = (key, label, type = 'text', extra = {}) => ({ key, label, type, ...extra });
  const itemCols = () => [col('itemCode', 'inv.col.itemCode'), col('itemName', 'inv.col.itemName'), col('unit', 'inv.col.unit')];
  const itemVals = (r) => ({ itemId: r.item_id, itemCode: r.item_code, itemName: { ar: r.name_ar, en: r.name_en }, unit: r.unit });

  /** المحجوز وغير المتاح لكل (صنف، مخزن) ضمن النطاق. */
  function reservedMap(sc) {
    const m = new Map();
    for (const r of db.prepare(`SELECT r.item_id, r.warehouse_id, dec_sum(r.qty) q, dec_sum(r.consumed_qty) c FROM inv_reservations r JOIN inv_warehouses w ON w.id = r.warehouse_id
      WHERE ${sc.sql} AND r.status = 'active' AND (r.expires_on IS NULL OR r.expires_on >= ?) GROUP BY r.item_id, r.warehouse_id`).all(...sc.params, today())) m.set(`${r.item_id}|${r.warehouse_id}`, D.canonical(D.sub(r.q, r.c)));
    return m;
  }
  function unavailableMap(sc) {
    const m = new Map();
    for (const r of db.prepare(`SELECT b.item_id, b.warehouse_id, dec_sum(b.qty) q FROM inv_balances b JOIN inv_warehouses w ON w.id = b.warehouse_id LEFT JOIN inv_batches x ON x.id = b.batch_key
      WHERE ${sc.sql} AND (w.wh_type = 'quarantine' OR (b.batch_key <> 0 AND (x.status <> 'available' OR (x.expiry_date IS NOT NULL AND x.expiry_date < ?)))) GROUP BY b.item_id, b.warehouse_id`).all(...sc.params, today())) m.set(`${r.item_id}|${r.warehouse_id}`, r.q);
    return m;
  }

  // 1، 2) الأرصدة الحالية حسب الصنف، أو حسب الفرع والمخزن
  function stock(ctx, q, byWarehouse) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const rows = db.prepare(`SELECT p.item_id, p.warehouse_id, w.code wh_code, w.name_ar wh_ar, w.name_en wh_en, w.branch_id, br.code br_code, i.code item_code, i.name_ar, i.name_en, u.code unit,
      dec_sum(p.qty) qty, dec_sum(p.value) value FROM inv_pools p JOIN inv_items i ON i.id = p.item_id JOIN units u ON u.id = i.base_unit_id JOIN inv_warehouses w ON w.id = p.warehouse_id
      JOIN branches br ON br.id = w.branch_id WHERE ${sc.sql} AND ${it.sql} GROUP BY p.item_id, p.warehouse_id ORDER BY ${byWarehouse ? 'br.code, w.code, ' : ''}i.code`).all(...sc.params, ...it.params);
    const res = reservedMap(sc); const un = unavailableMap(sc);
    const agg = new Map();
    for (const r of rows) {
      const k = byWarehouse ? `${r.item_id}|${r.warehouse_id}` : String(r.item_id);
      const a = agg.get(k) || { ...itemVals(r), branch: r.br_code, warehouseId: r.warehouse_id, warehouse: r.wh_code, qty: '0', value: '0', reserved: '0', unavailable: '0' };
      const kk = `${r.item_id}|${r.warehouse_id}`;
      a.qty = D.canonical(D.add(a.qty, r.qty)); a.value = D.canonical(D.add(a.value, r.value));
      a.reserved = D.canonical(D.add(a.reserved, res.get(kk) || '0')); a.unavailable = D.canonical(D.add(a.unavailable, un.get(kk) || '0'));
      agg.set(k, a);
    }
    const out = [...agg.values()].filter((a) => q.zero === '1' || !D.isZero(a.qty) || !D.isZero(a.value))
      .map((a) => ({ ...a, available: D.canonical(D.sub(D.sub(a.qty, a.unavailable), a.reserved)), avgCost: D.gt(a.qty, '0') ? div(a.value, a.qty) : null }));
    return {
      report: byWarehouse ? 'stock-by-warehouse' : 'stock',
      columns: [...(byWarehouse ? [col('branch', 'inv.col.branch'), col('warehouse', 'inv.col.warehouse')] : []), ...itemCols(), col('qty', 'inv.col.onHand', 'qty'), col('reserved', 'inv.col.reserved', 'qty'),
        col('unavailable', 'inv.col.unavailable', 'qty'), col('available', 'inv.col.available', 'qty'), col('avgCost', 'inv.col.avgCost', 'cost'), col('value', 'inv.col.value', 'amount')],
      rows: out, totals: { value: D.canonical(D.sum(out.map((r) => r.value))) }, meta: { asOf: today(), current: true },
    };
  }

  // 3) كارت الصنف
  function itemCard(ctx, q) {
    const itemId = id(q.itemId);
    if (!itemId) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { itemId: 'REQUIRED' } });
    const item = db.prepare('SELECT i.*, u.code unit FROM inv_items i JOIN units u ON u.id = i.base_unit_id WHERE i.id = ?').get(itemId);
    if (!item) fail(404, 'NOT_FOUND', 'الصنف غير موجود');
    const sc = scope(ctx, q);
    const from = dateQ(q.from, 'from') || '0001-01-01'; const to = dateQ(q.to, 'to') || today();
    const batch = id(q.batchId);
    const bsql = batch ? ' AND m.batch_id = ?' : ''; const bp = batch ? [batch] : [];
    const open = db.prepare(`SELECT dec_sum(${SIGNED_Q}) q, dec_sum(${SIGNED_V}) v FROM inv_moves m JOIN inv_warehouses w ON w.id = m.warehouse_id WHERE ${sc.sql} AND m.item_id = ? AND m.move_date < ?${bsql}`).get(...sc.params, itemId, from, ...bp);
    let rq = open.q || '0'; let rv = open.v || '0';
    const rows = [{ date: from === '0001-01-01' ? null : from, document: null, docType: 'opening_balance', warehouse: null, batch: null, inQty: null, outQty: null, value: null, unitCost: null, balanceQty: rq, balanceValue: rv }];
    let tin = '0'; let tout = '0';
    for (const m of db.prepare(`SELECT m.*, d.number, d.doc_type, w.code wh_code, b.batch_no FROM inv_moves m JOIN inv_documents d ON d.id = m.doc_id JOIN inv_warehouses w ON w.id = m.warehouse_id
      LEFT JOIN inv_batches b ON b.id = m.batch_id WHERE ${sc.sql} AND m.item_id = ? AND m.move_date BETWEEN ? AND ?${bsql} ORDER BY m.move_date, m.id LIMIT 20001`).iterate(...sc.params, itemId, from, to, ...bp)) {
      const inQ = m.direction === 'in' ? m.qty : null; const outQ = m.direction === 'out' ? m.qty : null;
      rq = D.canonical(D.add(rq, inQ || D.neg(outQ))); rv = D.canonical(D.add(rv, m.direction === 'in' ? m.value : D.neg(m.value)));
      if (inQ) tin = D.canonical(D.add(tin, inQ)); else tout = D.canonical(D.add(tout, outQ));
      rows.push({ date: m.move_date, docId: m.doc_id, document: m.number, docType: m.doc_type, warehouse: m.wh_code, batch: m.batch_no, inQty: inQ, outQty: outQ,
        value: m.value, unitCost: m.unit_cost, balanceQty: rq, balanceValue: rv });
    }
    if (rows.length > 20001) fail(409, 'REPORT_TOO_LARGE', 'نطاق كبير جدًا؛ ضيّق الفترة', { limit: 20000 });
    return {
      report: 'item-card',
      columns: [col('date', 'inv.col.date', 'date'), col('document', 'inv.col.document'), col('docType', 'inv.col.docType', 'text', { i18n: 'inv.doc.' }), col('warehouse', 'inv.col.warehouse'), col('batch', 'inv.col.batch'),
        col('inQty', 'inv.col.in', 'qty'), col('outQty', 'inv.col.out', 'qty'), col('unitCost', 'inv.col.unitCost', 'cost'), col('value', 'inv.col.value', 'amount'),
        col('balanceQty', 'inv.col.balanceQty', 'qty'), col('balanceValue', 'inv.col.balanceValue', 'amount')],
      rows, totals: { inQty: tin, outQty: tout, balanceQty: rq, balanceValue: rv },
      meta: { from: from === '0001-01-01' ? null : from, to, item: { id: item.id, code: item.code, nameAr: item.name_ar, nameEn: item.name_en, unit: item.unit } },
    };
  }

  // 4) حركة الإضافة والصرف والتحويل والتسويات
  function movements(ctx, q) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const from = dateQ(q.from, 'from') || today().slice(0, 8) + '01'; const to = dateQ(q.to, 'to') || today();
    const w = [sc.sql, it.sql, 'm.move_date BETWEEN ? AND ?']; const p = [...sc.params, ...it.params, from, to];
    const types = ['opening', 'receipt', 'issue', 'transfer', 'transfer_out', 'transfer_in', 'adjust_in', 'adjust_out', 'return', 'reversal'];
    if (q.docType && types.includes(q.docType)) { w.push('d.doc_type = ?'); p.push(q.docType); }
    if (id(q.batchId)) { w.push('m.batch_id = ?'); p.push(id(q.batchId)); }
    const rows = db.prepare(`SELECT m.*, d.number, d.doc_type, w.code wh_code, i.code item_code, i.name_ar, i.name_en, u.code unit, b.batch_no FROM inv_moves m JOIN inv_documents d ON d.id = m.doc_id
      JOIN inv_warehouses w ON w.id = m.warehouse_id JOIN inv_items i ON i.id = m.item_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN inv_batches b ON b.id = m.batch_id
      WHERE ${w.join(' AND ')} ORDER BY m.move_date, m.id LIMIT 5001`).all(...p);
    if (rows.length > 5000) fail(409, 'REPORT_TOO_LARGE', 'نطاق كبير جدًا؛ ضيّق الفترة أو الفلاتر', { limit: 5000 });
    return {
      report: 'movements',
      columns: [col('date', 'inv.col.date', 'date'), col('document', 'inv.col.document'), col('docType', 'inv.col.docType', 'text', { i18n: 'inv.doc.' }), col('warehouse', 'inv.col.warehouse'),
        ...itemCols(), col('batch', 'inv.col.batch'), col('inQty', 'inv.col.in', 'qty'), col('outQty', 'inv.col.out', 'qty'), col('unitCost', 'inv.col.unitCost', 'cost'), col('value', 'inv.col.value', 'amount')],
      rows: rows.map((m) => ({ date: m.move_date, docId: m.doc_id, document: m.number, docType: m.doc_type, warehouse: m.wh_code, ...itemVals(m), batch: m.batch_no,
        inQty: m.direction === 'in' ? m.qty : null, outQty: m.direction === 'out' ? m.qty : null, unitCost: m.unit_cost, value: m.value })),
      totals: {}, meta: { from, to },
    };
  }

  // 5، 15) التقييم بالقيمة والتكلفة — حالي (الملخصات) أو كما في تاريخ (السجل حتى التاريخ)
  function valuation(ctx, q) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const asOf = dateQ(q.asOf, 'asOf');
    const rows = asOf
      ? db.prepare(`SELECT m.item_id, m.warehouse_id, w.code wh_code, br.code br_code, i.code item_code, i.name_ar, i.name_en, u.code unit, dec_sum(${SIGNED_Q}) qty, dec_sum(${SIGNED_V}) value
          FROM inv_moves m JOIN inv_items i ON i.id = m.item_id JOIN units u ON u.id = i.base_unit_id JOIN inv_warehouses w ON w.id = m.warehouse_id JOIN branches br ON br.id = w.branch_id
          WHERE ${sc.sql} AND ${it.sql} AND m.move_date <= ? GROUP BY m.item_id, m.warehouse_id ORDER BY br.code, w.code, i.code`).all(...sc.params, ...it.params, asOf)
      : db.prepare(`SELECT p.item_id, p.warehouse_id, w.code wh_code, br.code br_code, i.code item_code, i.name_ar, i.name_en, u.code unit, dec_sum(p.qty) qty, dec_sum(p.value) value
          FROM inv_pools p JOIN inv_items i ON i.id = p.item_id JOIN units u ON u.id = i.base_unit_id JOIN inv_warehouses w ON w.id = p.warehouse_id JOIN branches br ON br.id = w.branch_id
          WHERE ${sc.sql} AND ${it.sql} GROUP BY p.item_id, p.warehouse_id ORDER BY br.code, w.code, i.code`).all(...sc.params, ...it.params);
    const out = rows.filter((r) => !D.isZero(r.qty) || !D.isZero(r.value))
      .map((r) => ({ branch: r.br_code, warehouseId: r.warehouse_id, warehouse: r.wh_code, ...itemVals(r), qty: r.qty, avgCost: D.gt(r.qty, '0') ? div(r.value, r.qty) : null, value: r.value }));
    return {
      report: 'valuation',
      columns: [col('branch', 'inv.col.branch'), col('warehouse', 'inv.col.warehouse'), ...itemCols(), col('qty', 'inv.col.qty', 'qty'), col('avgCost', 'inv.col.avgCost', 'cost'), col('value', 'inv.col.value', 'amount')],
      rows: out, totals: { qty: D.canonical(D.sum(out.map((r) => r.qty))), value: D.canonical(D.sum(out.map((r) => r.value))) },
      meta: { asOf: asOf || today(), current: !asOf, method: 'moving_average' },
    };
  }

  // 6) المخزون الراكد
  function slowMoving(ctx, q) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const days = /^\d{1,4}$/.test(q.days || '') ? Number(q.days) : masters.settingsRow().slow_moving_days;
    const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() - days);
    const cutoff = d.toISOString().slice(0, 10);
    const rows = db.prepare(`SELECT p.item_id, p.warehouse_id, w.code wh_code, i.code item_code, i.name_ar, i.name_en, u.code unit, dec_sum(p.qty) qty, dec_sum(p.value) value,
      (SELECT max(m.move_date) FROM inv_moves m WHERE m.item_id = p.item_id AND m.warehouse_id = p.warehouse_id AND m.direction = 'out') last_out,
      (SELECT max(m.move_date) FROM inv_moves m WHERE m.item_id = p.item_id AND m.warehouse_id = p.warehouse_id) last_move
      FROM inv_pools p JOIN inv_items i ON i.id = p.item_id JOIN units u ON u.id = i.base_unit_id JOIN inv_warehouses w ON w.id = p.warehouse_id
      WHERE ${sc.sql} AND ${it.sql} GROUP BY p.item_id, p.warehouse_id HAVING dec_cmp(dec_sum(p.qty), '0') > 0 AND (last_out IS NULL OR last_out < ?) ORDER BY last_out, i.code`).all(...sc.params, ...it.params, cutoff);
    const age = (x) => (x ? Math.round((Date.parse(today()) - Date.parse(x)) / 86400000) : null);
    return {
      report: 'slow-moving',
      columns: [col('warehouse', 'inv.col.warehouse'), ...itemCols(), col('qty', 'inv.col.qty', 'qty'), col('value', 'inv.col.value', 'amount'), col('lastIssue', 'inv.col.lastIssue', 'date'), col('days', 'inv.col.daysIdle', 'int')],
      rows: rows.map((r) => ({ warehouseId: r.warehouse_id, warehouse: r.wh_code, ...itemVals(r), qty: r.qty, value: r.value, lastIssue: r.last_out, days: age(r.last_out || r.last_move) })),
      totals: { value: D.canonical(D.sum(rows.map((r) => r.value))) }, meta: { asOf: today(), days },
    };
  }

  // 7) الأصناف تحت الحد الأدنى وحد إعادة الطلب (والنفاد)
  function reorder(ctx, q) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const rows = db.prepare(`SELECT i.id item_id, i.code item_code, i.name_ar, i.name_en, u.code unit, i.min_qty, i.reorder_qty, i.max_qty,
      (SELECT dec_sum(b.qty) FROM inv_balances b JOIN inv_warehouses w ON w.id = b.warehouse_id WHERE b.item_id = i.id AND ${sc.sql}) qty
      FROM inv_items i JOIN units u ON u.id = i.base_unit_id WHERE i.is_active = 1 AND i.is_stock = 1 AND (i.min_qty IS NOT NULL OR i.reorder_qty IS NOT NULL) AND ${it.sql} ORDER BY i.code`).all(...sc.params, ...it.params);
    const out = [];
    for (const r of rows) {
      const qty = r.qty || '0';
      const status = !D.gt(qty, '0') ? 'out_of_stock' : r.min_qty != null && D.lt(qty, r.min_qty) ? 'below_min' : r.reorder_qty != null && D.lte(qty, r.reorder_qty) ? 'reorder' : null;
      if (!status) continue;
      const target = r.max_qty || r.reorder_qty || r.min_qty;
      out.push({ ...itemVals(r), qty, minQty: r.min_qty, reorderQty: r.reorder_qty, maxQty: r.max_qty, suggested: target && D.gt(target, qty) ? D.canonical(D.sub(target, qty)) : null, status });
    }
    return {
      report: 'reorder',
      columns: [...itemCols(), col('qty', 'inv.col.onHand', 'qty'), col('minQty', 'inv.col.minQty', 'qty'), col('reorderQty', 'inv.col.reorderQty', 'qty'), col('maxQty', 'inv.col.maxQty', 'qty'),
        col('suggested', 'inv.col.suggested', 'qty'), col('status', 'inv.col.status', 'text', { i18n: 'inv.alert.' })],
      rows: out, totals: {}, meta: { asOf: today(), current: true },
    };
  }

  // 8) الدفعات والصلاحية
  function batches(ctx, q) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const days = /^\d{1,4}$/.test(q.days || '') ? Number(q.days) : masters.settingsRow().expiry_alert_days;
    const d = new Date(today() + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + days);
    const near = d.toISOString().slice(0, 10);
    const w = [sc.sql, it.sql, "dec_cmp(b.qty, '0') <> 0"]; const p = [...sc.params, ...it.params];
    if (q.expiry === 'near') { w.push('x.expiry_date BETWEEN ? AND ?'); p.push(today(), near); }
    if (q.expiry === 'expired') { w.push('x.expiry_date < ?'); p.push(today()); }
    if (q.status && ['available', 'inspection', 'rejected', 'hold', 'quarantine'].includes(q.status)) { w.push('x.status = ?'); p.push(q.status); }
    const rows = db.prepare(`SELECT x.id batch_id, x.batch_no, x.production_date, x.expiry_date, x.status, b.warehouse_id, w.code wh_code, i.id item_id, i.code item_code, i.name_ar, i.name_en, u.code unit,
      dec_sum(b.qty) qty, (SELECT p.value FROM inv_pools p WHERE p.item_id = b.item_id AND p.warehouse_id = b.warehouse_id AND p.batch_key = b.batch_key) value
      FROM inv_balances b JOIN inv_batches x ON x.id = b.batch_key JOIN inv_items i ON i.id = b.item_id JOIN units u ON u.id = i.base_unit_id JOIN inv_warehouses w ON w.id = b.warehouse_id
      WHERE ${w.join(' AND ')} GROUP BY b.item_id, b.warehouse_id, b.batch_key ORDER BY (x.expiry_date IS NULL), x.expiry_date, i.code`).all(...p);
    const left = (e) => (e ? Math.round((Date.parse(e) - Date.parse(today())) / 86400000) : null);
    return {
      report: 'batches',
      columns: [col('batch', 'inv.col.batch'), ...itemCols(), col('warehouse', 'inv.col.warehouse'), col('productionDate', 'inv.col.productionDate', 'date'), col('expiryDate', 'inv.col.expiryDate', 'date'),
        col('daysLeft', 'inv.col.daysLeft', 'int'), col('status', 'inv.col.quality', 'text', { i18n: 'inv.q.' }), col('qty', 'inv.col.qty', 'qty'), col('value', 'inv.col.value', 'amount')],
      rows: rows.map((r) => ({ batchId: r.batch_id, batch: r.batch_no, ...itemVals(r), warehouseId: r.warehouse_id, warehouse: r.wh_code, productionDate: r.production_date, expiryDate: r.expiry_date,
        daysLeft: left(r.expiry_date), status: r.expiry_date && r.expiry_date < today() ? 'expired' : r.status, qty: r.qty, value: r.value })),
      totals: {}, meta: { asOf: today(), days },
    };
  }

  // 9) الحجر والجودة  10) الأرصدة السالبة أو غير المتاحة
  function quality(ctx, q, negative) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const cond = negative
      ? "(dec_cmp(b.qty, '0') < 0 OR (dec_cmp(b.qty, '0') > 0 AND (w.wh_type = 'quarantine' OR (b.batch_key <> 0 AND (x.status <> 'available' OR (x.expiry_date IS NOT NULL AND x.expiry_date < ?))))))"
      : "dec_cmp(b.qty, '0') <> 0 AND (w.wh_type = 'quarantine' OR (b.batch_key <> 0 AND x.status <> 'available'))";
    const rows = db.prepare(`SELECT b.*, w.code wh_code, w.wh_type, x.batch_no, x.status, x.expiry_date, i.code item_code, i.name_ar, i.name_en, u.code unit, l.code loc_code
      FROM inv_balances b JOIN inv_warehouses w ON w.id = b.warehouse_id JOIN inv_items i ON i.id = b.item_id JOIN units u ON u.id = i.base_unit_id
      LEFT JOIN inv_batches x ON x.id = b.batch_key LEFT JOIN inv_locations l ON l.id = b.loc_key WHERE ${sc.sql} AND ${it.sql} AND ${cond} ORDER BY w.code, i.code`)
      .all(...sc.params, ...it.params, ...(negative ? [today()] : []));
    const reason = (r) => (D.isNegative(r.qty) ? 'negative' : r.wh_type === 'quarantine' ? 'quarantine_warehouse' : r.expiry_date && r.expiry_date < today() ? 'expired' : r.status);
    return {
      report: negative ? 'negative' : 'quality',
      columns: [col('warehouse', 'inv.col.warehouse'), col('location', 'inv.col.location'), ...itemCols(), col('batch', 'inv.col.batch'), col('qty', 'inv.col.qty', 'qty'), col('reason', 'inv.col.reason', 'text', { i18n: 'inv.q.' })],
      rows: rows.map((r) => ({ warehouseId: r.warehouse_id, warehouse: r.wh_code, location: r.loc_code, ...itemVals(r), batch: r.batch_no, qty: r.qty, reason: reason(r) })),
      totals: {}, meta: { asOf: today(), current: true },
    };
  }

  // 11) الحجوزات والمتاح
  function reservations(ctx, q) {
    const sc = scope(ctx, q); const it = itemFilter(q);
    const rows = db.prepare(`SELECT r.*, w.code wh_code, i.code item_code, i.name_ar, i.name_en, u.code unit, x.batch_no FROM inv_reservations r JOIN inv_warehouses w ON w.id = r.warehouse_id
      JOIN inv_items i ON i.id = r.item_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN inv_batches x ON x.id = r.batch_id
      WHERE ${sc.sql} AND ${it.sql} AND r.status = 'active' AND (r.expires_on IS NULL OR r.expires_on >= ?) ORDER BY w.code, i.code, r.id`).all(...sc.params, ...it.params, today());
    const stockRows = stock(ctx, { ...q, zero: '1' }, true).rows;
    const avail = new Map(stockRows.map((s) => [`${s.itemId}|${s.warehouseId}`, s]));
    return {
      report: 'reservations',
      columns: [col('warehouse', 'inv.col.warehouse'), ...itemCols(), col('batch', 'inv.col.batch'), col('reference', 'inv.col.reference'), col('qty', 'inv.col.reserved', 'qty'),
        col('consumed', 'inv.col.consumed', 'qty'), col('remaining', 'inv.col.remaining', 'qty'), col('available', 'inv.col.available', 'qty'), col('expiresOn', 'inv.col.expiresOn', 'date')],
      rows: rows.map((r) => ({ reservationId: r.id, warehouseId: r.warehouse_id, warehouse: r.wh_code, ...itemVals(r), batch: r.batch_no, reference: r.reference, qty: r.qty, consumed: r.consumed_qty,
        remaining: D.canonical(D.sub(r.qty, r.consumed_qty)), available: avail.get(`${r.item_id}|${r.warehouse_id}`)?.available ?? '0', expiresOn: r.expires_on })),
      totals: {}, meta: { asOf: today(), current: true },
    };
  }

  // 12) فروق الجرد
  function countDifferences(ctx, q) {
    const f = whAccess.sqlFilter(ctx, 'c.warehouse_id'); const b = ctx.access.sqlFilter('c.branch_id', q.branchId);
    const w = [f.sql, b.sql, "c.status IN ('approved', 'posted')", 'l.final_qty IS NOT NULL', 'dec_cmp(l.final_qty, l.system_qty) <> 0']; const p = [...f.params, ...b.params];
    if (id(q.warehouseId)) { whAccess.assertWarehouse(ctx, id(q.warehouseId)); w.push('c.warehouse_id = ?'); p.push(id(q.warehouseId)); }
    if (id(q.countId)) { w.push('c.id = ?'); p.push(id(q.countId)); }
    const from = dateQ(q.from, 'from'); const to = dateQ(q.to, 'to');
    if (from) { w.push('c.count_date >= ?'); p.push(from); }
    if (to) { w.push('c.count_date <= ?'); p.push(to); }
    const rows = db.prepare(`SELECT c.id count_id, c.number, c.count_date, c.status, w.code wh_code, l.*, i.code item_code, i.name_ar, i.name_en, u.code unit, x.batch_no FROM inv_count_lines l
      JOIN inv_counts c ON c.id = l.count_id JOIN inv_warehouses w ON w.id = c.warehouse_id JOIN inv_items i ON i.id = l.item_id JOIN units u ON u.id = i.base_unit_id LEFT JOIN inv_batches x ON x.id = l.batch_id
      WHERE ${w.join(' AND ')} ORDER BY c.count_date DESC, c.id DESC, i.code`).all(...p);
    const out = rows.map((r) => {
      const diff = D.canonical(D.sub(r.final_qty, r.system_qty));
      return { countId: r.count_id, count: r.number, date: r.count_date, status: r.status, warehouse: r.wh_code, ...itemVals(r), batch: r.batch_no, systemQty: r.system_qty, countedQty: r.final_qty,
        difference: diff, value: r.unit_cost != null ? D.commit(D.mul(diff, r.unit_cost), 'amount', base()) : null };
    });
    return {
      report: 'count-differences',
      columns: [col('count', 'inv.col.count'), col('date', 'inv.col.date', 'date'), col('warehouse', 'inv.col.warehouse'), ...itemCols(), col('batch', 'inv.col.batch'), col('systemQty', 'inv.col.systemQty', 'qty'),
        col('countedQty', 'inv.col.countedQty', 'qty'), col('difference', 'inv.col.difference', 'qty'), col('value', 'inv.col.differenceValue', 'amount')],
      rows: out, totals: { value: D.canonical(D.sum(out.filter((r) => r.value != null).map((r) => r.value))) }, meta: { from, to },
    };
  }

  // 13) التحويلات المرسلة وغير المستلمة
  function transfers(ctx, q) {
    const fb = ctx.access.sqlFilter('t.from_branch_id'); const tb = ctx.access.sqlFilter('t.to_branch_id');
    const ff = whAccess.sqlFilter(ctx, 't.from_warehouse_id'); const tf = whAccess.sqlFilter(ctx, 't.to_warehouse_id');
    const st = q.status === 'all' ? '1 = 1' : "t.status IN ('in_transit', 'partial')";
    const rows = db.prepare(`SELECT t.*, d.number, d.doc_date, fw.code from_code, tw.code to_code, l.id line_id, l.qty_sent, l.value_sent, l.qty_received, l.value_received, l.qty_rejected, l.value_rejected,
      l.qty_short, l.value_short, i.id item_id, i.code item_code, i.name_ar, i.name_en, u.code unit, x.batch_no FROM inv_transfers t JOIN inv_documents d ON d.id = t.dispatch_doc_id
      JOIN inv_warehouses fw ON fw.id = t.from_warehouse_id JOIN inv_warehouses tw ON tw.id = t.to_warehouse_id JOIN inv_transfer_lines l ON l.transfer_id = t.id JOIN inv_items i ON i.id = l.item_id
      JOIN units u ON u.id = i.base_unit_id LEFT JOIN inv_batches x ON x.id = l.batch_id
      WHERE ((${fb.sql} AND ${ff.sql}) OR (${tb.sql} AND ${tf.sql})) AND ${st} ORDER BY d.doc_date, t.id, l.id`).all(...fb.params, ...ff.params, ...tb.params, ...tf.params);
    const out = rows.map((r) => ({ transferId: r.id, docId: r.dispatch_doc_id, document: r.number, date: r.doc_date, from: r.from_code, to: r.to_code, status: r.status, transferLineId: r.line_id, ...itemVals(r), batch: r.batch_no,
      sent: r.qty_sent, received: r.qty_received, rejected: r.qty_rejected, short: r.qty_short,
      remaining: D.canonical(D.sub(D.sub(D.sub(r.qty_sent, r.qty_received), r.qty_rejected), r.qty_short)),
      remainingValue: D.canonical(D.sub(D.sub(D.sub(r.value_sent, r.value_received), r.value_rejected), r.value_short)) }));
    return {
      report: 'transfers',
      columns: [col('document', 'inv.col.document'), col('date', 'inv.col.date', 'date'), col('from', 'inv.col.from'), col('to', 'inv.col.to'), col('status', 'inv.col.status', 'text', { i18n: 'inv.tr.' }), ...itemCols(), col('batch', 'inv.col.batch'),
        col('sent', 'inv.col.sent', 'qty'), col('received', 'inv.col.received', 'qty'), col('rejected', 'inv.col.rejected', 'qty'), col('remaining', 'inv.col.remaining', 'qty'), col('remainingValue', 'inv.col.remainingValue', 'amount')],
      rows: out, totals: { remainingValue: D.canonical(D.sum(out.map((r) => r.remainingValue))) }, meta: { asOf: today(), current: true },
    };
  }

  /**
   * 14) مطابقة المخزون مع الأستاذ كما في تاريخ: لكل (فرع، حساب مخزون) قيمة المخزون من السجل (حسب لقطة حساب كل حركة)
   * مقابل رصيد الحساب في الأستاذ (كل المصادر عدا ترحيل الأرصدة). حساب المخزون بالطريق مقابل قيمة التحويلات المفتوحة.
   * الفرق غير المفسر يمنع اعتماد المطابقة (reconciled = false). الأرصدة الافتتاحية بلا قيد مخزني تظهر منفصلة لأنها
   * يجب أن تقابل القيد الافتتاحي في الأستاذ (المرحلة 3) لا أن تُضاف إليه.
   */
  function glReconciliation(ctx, q) {
    const asOf = dateQ(q.asOf, 'asOf') || today();
    const bf = ctx.access.sqlFilter('m.branch_id', q.branchId);
    const wf = whAccess.sqlFilter(ctx, 'm.warehouse_id');
    const inv = db.prepare(`SELECT m.branch_id, m.inventory_account_id acc, dec_sum(${SIGNED_V}) v, dec_sum(CASE WHEN m.posts_gl = 0 THEN (${SIGNED_V}) ELSE '0' END) nogl
      FROM inv_moves m WHERE ${bf.sql} AND ${wf.sql} AND m.move_date <= ? GROUP BY m.branch_id, m.inventory_account_id`).all(...bf.params, ...wf.params, asOf);
    const s = masters.settingsRow();
    const accIds = new Set([...inv.map((r) => r.acc).filter(Boolean), s.inventory_account_id,
      ...db.prepare('SELECT inventory_account_id a FROM inv_groups WHERE inventory_account_id IS NOT NULL UNION SELECT inventory_account_id FROM inv_items WHERE inventory_account_id IS NOT NULL').all().map((r) => r.a)].filter(Boolean));
    const gb = ctx.access.sqlFilter('g.branch_id', q.branchId);
    const glQ = (accs) => (accs.length ? db.prepare(`SELECT g.branch_id, g.account_id acc, dec_sum(g.debit) d, dec_sum(g.credit) c, dec_sum(CASE WHEN g.source_type = 'inventory' THEN g.debit ELSE '0' END) di,
      dec_sum(CASE WHEN g.source_type = 'inventory' THEN g.credit ELSE '0' END) ci FROM gl_entries g WHERE ${gb.sql} AND g.posting_date <= ? AND g.source_type <> 'carry_forward'
      AND g.account_id IN (${accs.map(() => '?').join(',')}) GROUP BY g.branch_id, g.account_id`).all(...gb.params, asOf, ...accs) : []);
    const gl = glQ([...accIds]);
    const key = (b, a) => `${b}|${a}`;
    const rowsMap = new Map();
    const ensure = (b, a) => { const k = key(b, a); if (!rowsMap.has(k)) rowsMap.set(k, { branchId: b, accountId: a, kind: 'inventory', glBalance: '0', glFromInventory: '0', glOther: '0', inventoryValue: '0', withoutGl: '0' }); return rowsMap.get(k); };
    for (const r of inv) { const x = ensure(r.branch_id, r.acc); x.inventoryValue = D.canonical(D.add(x.inventoryValue, r.v)); x.withoutGl = D.canonical(D.add(x.withoutGl, r.nogl)); }
    for (const r of gl) {
      const x = ensure(r.branch_id, r.acc);
      x.glBalance = D.canonical(D.sub(r.d, r.c)); x.glFromInventory = D.canonical(D.sub(r.di, r.ci)); x.glOther = D.canonical(D.sub(x.glBalance, x.glFromInventory));
    }
    // المخزون بالطريق: قيمة الإرسال − المستلم/المرفوض − العجز حتى التاريخ، مقابل رصيد حساب المخزون بالطريق
    if (s.transit_account_id) {
      const tb = ctx.access.sqlFilter('d.branch_id', q.branchId);
      for (const r of db.prepare(`SELECT d.branch_id, dec_sum(CASE WHEN g.debit <> '0' THEN g.debit ELSE '-' || g.credit END) v FROM inv_gl_lines g JOIN inv_documents d ON d.id = g.doc_id
        WHERE g.role = 'transit' AND d.status = 'posted' AND d.doc_date <= ? AND ${tb.sql} GROUP BY d.branch_id`).all(asOf, ...tb.params)) {
        const x = ensure(r.branch_id, s.transit_account_id); x.kind = 'transit'; x.inventoryValue = r.v || '0';
      }
      for (const r of glQ([s.transit_account_id])) {
        const x = ensure(r.branch_id, r.acc); x.kind = 'transit';
        x.glBalance = D.canonical(D.sub(r.d, r.c)); x.glFromInventory = D.canonical(D.sub(r.di, r.ci)); x.glOther = D.canonical(D.sub(x.glBalance, x.glFromInventory));
      }
    }
    const out = [...rowsMap.values()].map((x) => {
      const br = db.prepare('SELECT code FROM branches WHERE id = ?').get(x.branchId);
      const a = x.accountId ? db.prepare('SELECT code, name_ar, name_en FROM accounts WHERE id = ?').get(x.accountId) : null;
      const difference = D.canonical(D.sub(x.glBalance, x.inventoryValue));
      return { ...x, branch: br ? br.code : '', account: a ? a.code : null, accountName: a ? { ar: a.name_ar, en: a.name_en } : null, difference, status: D.isZero(difference) ? 'matched' : x.accountId ? 'difference' : 'no_account' };
    }).sort((p1, p2) => p1.branch.localeCompare(p2.branch) || String(p1.account).localeCompare(String(p2.account)));
    return {
      report: 'gl-reconciliation',
      columns: [col('branch', 'inv.col.branch'), col('account', 'inv.col.account'), col('accountName', 'inv.col.accountName'), col('kind', 'inv.col.kind', 'text', { i18n: 'inv.recon.' }),
        col('inventoryValue', 'inv.col.inventoryValue', 'amount'), col('withoutGl', 'inv.col.withoutGl', 'amount'), col('glBalance', 'inv.col.glBalance', 'amount'),
        col('glFromInventory', 'inv.col.glFromInventory', 'amount'), col('glOther', 'inv.col.glOther', 'amount'), col('difference', 'inv.col.difference', 'amount'), col('status', 'inv.col.status', 'text', { i18n: 'inv.recon.' })],
      rows: out, totals: { difference: D.canonical(D.sum(out.map((r) => r.difference))) },
      meta: { asOf, reconciled: out.every((r) => r.status === 'matched') },
      reconciled: out.every((r) => r.status === 'matched'),
    };
  }

  const REPORTS = {
    stock: (ctx, q) => stock(ctx, q, false), 'stock-by-warehouse': (ctx, q) => stock(ctx, q, true), 'item-card': itemCard, movements, valuation,
    'slow-moving': slowMoving, reorder, batches, quality: (ctx, q) => quality(ctx, q, false), negative: (ctx, q) => quality(ctx, q, true),
    reservations, 'count-differences': countDifferences, transfers, 'gl-reconciliation': glReconciliation,
  };
  const VALUE_ONLY = ['valuation', 'gl-reconciliation'];
  function run(ctx, name, q = {}) {
    const fn = REPORTS[name];
    if (!fn) fail(404, 'NOT_FOUND', 'تقرير غير موجود');
    const canValue = ctx.access.can('inventory_valuation.view');
    if (VALUE_ONLY.includes(name) && !canValue) fail(403, 'FORBIDDEN', 'تقرير التقييم يتطلب صلاحية عرض التقييم', { permission: 'inventory_valuation.view' });
    const r = fn(ctx, q);
    if (!canValue) {
      const hidden = new Set(r.columns.filter((c) => c.type === 'amount' || c.type === 'cost').map((c) => c.key));
      r.columns = r.columns.filter((c) => !hidden.has(c.key));
      for (const row of r.rows) for (const k of hidden) delete row[k];
      for (const k of hidden) delete r.totals[k];
      r.valuesHidden = true;
    }
    r.baseCurrency = base();
    r.generatedAt = new Date().toISOString();
    const sc = q.branchId && q.branchId !== 'all' ? ctx.access.scope(q.branchId) : ctx.access.scope('all');
    r.scope = { all: sc.all, branches: sc.all ? [] : db.prepare(`SELECT id, code, name_ar nameAr, name_en nameEn FROM branches WHERE id IN (${sc.ids.map(() => '?').join(',') || 'NULL'}) ORDER BY code`).all(...(sc.ids || [])),
      warehouse: id(q.warehouseId) ? db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn FROM inv_warehouses WHERE id = ?').get(id(q.warehouseId)) : null };
    const to = r.meta.to || r.meta.asOf;
    const finality = to && !r.meta.current ? services.fiscal.finality(r.meta.from || to, to) : { final: false, reasons: [{ code: 'CURRENT_BALANCES' }] };
    r.finality = finality;
    return r;
  }

  // ── الطباعة والتصدير (خلايا رقمية حقيقية في Excel) ──
  function table(r, lang) {
    const t = (k, v) => services.i18n.t(lang, k, v);
    const kind = { qty: 'quantity', amount: 'amount', cost: 'unit_cost' };
    const fmt = (c, v) => {
      if (v == null || v === '') return '';
      if (kind[c.type]) return D.format(v, kind[c.type], c.type === 'amount' ? r.baseCurrency : undefined);
      if (c.type === 'int') return String(v);
      if (v && typeof v === 'object' && 'ar' in v) return lang === 'ar' ? v.ar : v.en;
      if (c.i18n) return t(c.i18n + v);
      return String(v);
    };
    const header = r.columns.map((c) => t(c.label));
    const rows = r.rows.map((row) => r.columns.map((c) => fmt(c, row[c.key])));
    const xrows = r.rows.map((row) => r.columns.map((c) => (kind[c.type] && row[c.key] != null ? { num: row[c.key] } : c.type === 'int' && row[c.key] != null ? { num: String(row[c.key]) } : fmt(c, row[c.key]))));
    if (Object.keys(r.totals).length) {
      const tr = r.columns.map((c, i) => (i === 0 ? t('inv.total') : r.totals[c.key] != null ? fmt(c, r.totals[c.key]) : ''));
      rows.push(tr);
      xrows.push(r.columns.map((c, i) => (i === 0 ? t('inv.total') : r.totals[c.key] != null && kind[c.type] ? { num: r.totals[c.key] } : '')));
    }
    const company = services.company.get() || {};
    const nm = (x) => (x ? (lang === 'ar' ? x.nameAr : x.nameEn) || x.nameAr || '' : '');
    const m = r.meta;
    const meta = [
      `${t('fs.company')}: ${lang === 'ar' ? company.nameAr || company.name_ar || '' : company.nameEn || company.name_en || ''}`,
      `${t('fs.branches')}: ${r.scope.all ? t('ledger.allBranches') : r.scope.branches.map((b) => `${b.code} ${nm(b)}`).join(' / ')}`,
      ...(r.scope.warehouse ? [`${t('inv.col.warehouse')}: ${r.scope.warehouse.code} ${nm(r.scope.warehouse)}`] : []),
      ...(m.item ? [`${t('inv.col.itemCode')}: ${m.item.code} ${nm(m.item)}`] : []),
      m.from || m.to ? `${t('fs.period')}: ${m.from || '…'} → ${m.to}` : `${t('fs.asOf')}: ${m.asOf}${m.current ? ' (' + t('inv.current') + ')' : ''}`,
      `${t('fs.currency')}: ${r.baseCurrency}`,
      ...(m.method ? [`${t('inv.valuationMethod')}: ${t('inv.method.' + m.method)}`] : []),
      `${t('fs.issuedAt')}: ${new Date().toISOString().replace('T', ' ').slice(0, 19)} UTC`,
      `${t('fs.status')}: ${r.finality.final ? t('ledger.final') : t('ledger.notFinal')}`,
      ...(r.report === 'gl-reconciliation' ? [r.reconciled ? t('inv.recon.ok') : t('inv.recon.blocked')] : []),
      ...(r.valuesHidden ? [t('inv.valuesHidden')] : []),
    ];
    return { title: t('inv.report.' + r.report), meta, columns: header, rows, xrows };
  }

  return { run, table, REPORTS: Object.keys(REPORTS) };
}

module.exports = { createReports };

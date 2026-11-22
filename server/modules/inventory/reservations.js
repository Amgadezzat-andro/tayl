'use strict';
const { HttpError } = require('../../core/errors');
const { inTransaction } = require('../../core/db');
const { validator } = require('../../core/validate');

/**
 * الحجوزات: كمية مخصصة لمرجع (طلب مستقبلي/داخلي). لا تغيّر الرصيد ولا القيمة ولا الأستاذ.
 * المتاح = الرصيد الفعلي بحالة جودة متاحة غير منتهية (خارج مخازن الحجر) − المحجوز الفعال.
 * الحجز يُفك يدويًا (سبب)، أو يُستهلك بسطر صرف يشير إليه، أو ينتهي بتاريخ انتهائه (لا يعود يحجز شيئًا).
 */
function createReservations(services, { masters, whAccess, engine }) {
  const { db, decimal: D, audit } = services;
  const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };
  const today = () => services.ledger.today();

  /** الحجوزات المنتهية تصبح expired (ضمن معاملة الكتابة). */
  const expireDue = () => db.prepare("UPDATE inv_reservations SET status = 'expired', closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE status = 'active' AND expires_on IS NOT NULL AND expires_on < ?").run(today());

  function availability(ctx, itemId, whId) {
    const wh = whAccess.assertWarehouse(ctx, whId);
    const onHand = db.prepare('SELECT dec_sum(qty) q FROM inv_balances WHERE item_id = ? AND warehouse_id = ?').get(itemId, whId).q || '0';
    const usable = engine.usableOnHand(itemId, wh, today());
    const reserved = engine.reservedRemaining(itemId, whId, null, today());
    return { onHand, unavailable: D.canonical(D.sub(onHand, usable)), reserved, available: D.canonical(D.sub(usable, reserved)) };
  }

  function create(ctx, body) {
    const d = validator(body).id('itemId', { required: true }).id('warehouseId', { required: true }).id('batchId').id('unitId').decimal('qty', { required: true })
      .str('reference', { required: true, min: 1, max: 120 }).str('expiresOn', { pattern: /^\d{4}-\d{2}-\d{2}$/ }).str('notes', { max: 300 }).done();
    return inTransaction(db, () => {
      const prior = engine.replay(ctx, body.idempotencyKey, 'reserve');
      if (prior) return prior;
      expireDue();
      const wh = whAccess.assertWarehouse(ctx, d.warehouseId, { active: true });
      ctx.access.assertBranch(wh.branch_id);
      const item = db.prepare('SELECT * FROM inv_items WHERE id = ?').get(d.itemId);
      if (!item || item.is_active !== 1 || item.is_stock !== 1) fail(409, 'ITEM_NOT_USABLE', 'الصنف غير متاح للحجز');
      const factor = masters.factorOf(item, d.unitId ?? item.base_unit_id);
      const qty = engine.decimalIn(d.qty, 'quantity', 'qty', { positive: true });
      let base;
      try { base = D.toStorage(D.mul(qty, factor), 'quantity'); } catch { fail(409, 'TOO_PRECISE', 'الكمية بوحدة الأساس أدق من دقة التخزين'); }
      if (d.expiresOn && d.expiresOn < today()) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { expiresOn: 'IN_PAST' } });
      if (d.batchId != null) {
        const b = db.prepare('SELECT * FROM inv_batches WHERE id = ?').get(d.batchId);
        if (!b || b.item_id !== item.id) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { batchId: 'NOT_FOR_ITEM' } });
        if (b.status !== 'available' || (b.expiry_date && b.expiry_date < today())) fail(409, 'BATCH_NOT_AVAILABLE', 'الدفعة غير متاحة', { batch: b.batch_no });
        const bq = db.prepare('SELECT dec_sum(qty) q FROM inv_balances WHERE item_id = ? AND warehouse_id = ? AND batch_key = ?').get(item.id, wh.id, b.id).q || '0';
        const br = db.prepare("SELECT qty, consumed_qty FROM inv_reservations WHERE batch_id = ? AND warehouse_id = ? AND status = 'active'").all(b.id, wh.id);
        const free = D.sub(bq, D.sum(br.map((r) => D.sub(r.qty, r.consumed_qty))));
        if (D.gt(base, free)) fail(409, 'OVER_RESERVATION', 'الكمية أكبر من المتاح في الدفعة', { available: D.canonical(D.max(free, '0')), requested: base });
      }
      const av = availability(ctx, item.id, wh.id);
      if (D.gt(base, av.available)) fail(409, 'OVER_RESERVATION', 'لا يمكن حجز كمية أكبر من المتاح', { available: av.available, requested: base, item: item.code });
      const id = Number(db.prepare('INSERT INTO inv_reservations (item_id, warehouse_id, branch_id, batch_id, qty, reference, expires_on, notes, created_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(item.id, wh.id, wh.branch_id, d.batchId ?? null, base, d.reference, d.expiresOn ?? null, d.notes ?? null, ctx.user.id).lastInsertRowid);
      audit.fromCtx(ctx, { action: 'inventory.reserved', source: 'inventory', entityType: 'inv_reservation', entityId: id, details: { item: item.code, warehouse: wh.code, qty: base, reference: d.reference, expiresOn: d.expiresOn ?? null } });
      const result = get(ctx, id);
      engine.remember(ctx, body.idempotencyKey, 'reserve', result);
      return result;
    });
  }
  function release(ctx, id, body) {
    const d = validator(body || {}).str('reason', { required: true, min: 3, max: 300 }).done();
    return inTransaction(db, () => {
      const r = row(ctx, id);
      ctx.access.assertBranch(r.branch_id);
      if (r.status !== 'active') fail(409, 'RESERVATION_NOT_ACTIVE', 'الحجز غير فعال');
      db.prepare("UPDATE inv_reservations SET status = 'released', closed_by = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), close_reason = ? WHERE id = ?").run(ctx.user.id, d.reason, id);
      audit.fromCtx(ctx, { action: 'inventory.reservation_released', source: 'inventory', entityType: 'inv_reservation', entityId: id, details: { reason: d.reason, remaining: D.canonical(D.sub(r.qty, r.consumed_qty)) } });
      return get(ctx, id);
    });
  }
  function row(ctx, id) {
    const r = db.prepare('SELECT * FROM inv_reservations WHERE id = ?').get(id);
    if (!r || !whAccess.allowed(ctx, { id: r.warehouse_id, branch_id: r.branch_id })) fail(404, 'NOT_FOUND', 'الحجز غير موجود');
    return r;
  }
  const effective = (r) => (r.status === 'active' && r.expires_on && r.expires_on < today() ? 'expired' : r.status);
  const api = (r) => ({ id: r.id, itemId: r.item_id, itemCode: r.item_code, itemNameAr: r.name_ar, itemNameEn: r.name_en, warehouseId: r.warehouse_id, warehouseCode: r.wh_code,
    batchId: r.batch_id, batchNo: r.batch_no, qty: r.qty, consumedQty: r.consumed_qty, remaining: D.canonical(D.sub(r.qty, r.consumed_qty)), status: effective(r),
    reference: r.reference, expiresOn: r.expires_on, notes: r.notes, createdAt: r.created_at, closeReason: r.close_reason });
  const SELECT = `SELECT r.*, i.code item_code, i.name_ar, i.name_en, w.code wh_code, b.batch_no FROM inv_reservations r JOIN inv_items i ON i.id = r.item_id
    JOIN inv_warehouses w ON w.id = r.warehouse_id LEFT JOIN inv_batches b ON b.id = r.batch_id`;
  function get(ctx, id) { row(ctx, id); return api(db.prepare(`${SELECT} WHERE r.id = ?`).get(id)); }
  function list(ctx, q = {}) {
    const w = []; const p = [];
    const f = whAccess.sqlFilter(ctx, 'r.warehouse_id'); w.push(f.sql); p.push(...f.params);
    const b = ctx.access.sqlFilter('r.branch_id'); w.push(b.sql); p.push(...b.params);
    if (q.status === 'active') { w.push("r.status = 'active' AND (r.expires_on IS NULL OR r.expires_on >= ?)"); p.push(today()); }
    if (/^\d{1,15}$/.test(q.itemId || '')) { w.push('r.item_id = ?'); p.push(Number(q.itemId)); }
    if (/^\d{1,15}$/.test(q.warehouseId || '')) { w.push('r.warehouse_id = ?'); p.push(Number(q.warehouseId)); }
    return db.prepare(`${SELECT} WHERE ${w.join(' AND ')} ORDER BY r.id DESC LIMIT 1000`).all(...p).map(api);
  }
  return { create, release, get, list, availability, expireDue };
}

module.exports = { createReservations };

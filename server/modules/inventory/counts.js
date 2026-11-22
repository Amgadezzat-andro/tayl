'use strict';
const { HttpError } = require('../../core/errors');
const { inTransaction } = require('../../core/db');
const { validator } = require('../../core/validate');

/**
 * الجرد الفعلي: جلسة لمخزن (ومجموعة أصناف اختيارية) ← لقطة رصيد النظام عند القطع (snapshot_move_id) ← العد على جولات
 * (الجولة الثانية فما بعدها = إعادة عد صريحة؛ لا تكرار صامت) ← المراجعة ← الاعتماد ← الترحيل عبر مستندات تسوية مركزية.
 *
 * سياسة الحركات أثناء الجرد: freeze = 1 يمنع أي حركة على أصناف الجلسة حتى الترحيل/الإلغاء؛ وإلا تُقبل الحركات، والفرق
 * يُحسب مقابل رصيد اللقطة (العد − رصيد القطع)، فيُرحَّل الفرق على الرصيد الحالي دون تجاهل حركات ما بعد القطع ولا تكرارها.
 * العد الأعمى (blind): رصيد النظام لا يظهر للعدّاد قبل المراجعة (إلا لمن يملك صلاحية المراجعة).
 */
function createCounts(services, { masters, whAccess, engine }) {
  const { db, decimal: D, audit } = services;
  const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };
  const need = (ctx, p) => { if (!ctx.access.can(p)) fail(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية', { permission: p }); };
  const today = () => services.ledger.today();
  const countRow = (ctx, id) => {
    const c = db.prepare('SELECT * FROM inv_counts WHERE id = ?').get(id);
    if (!c || !whAccess.allowed(ctx, { id: c.warehouse_id, branch_id: c.branch_id })) fail(404, 'NOT_FOUND', 'جلسة الجرد غير موجودة');
    return c;
  };
  const inGroup = (groupId) => (groupId ? 'i.group_id IN (SELECT id FROM inv_groups WHERE path LIKE (SELECT path FROM inv_groups WHERE id = ?) || \'%\')' : '1 = 1');
  /** رصيد مفتاح (صنف/موقع/دفعة) عند القطع، من السجل حتى آخر حركة في اللقطة. */
  const snapQty = (whId, snap, itemId, locId, batchId) => db.prepare(`SELECT dec_sum(CASE direction WHEN 'in' THEN qty ELSE '-' || qty END) q FROM inv_moves
    WHERE id <= ? AND warehouse_id = ? AND item_id = ? AND location_id IS ? AND batch_id IS ?`).get(snap, whId, itemId, locId, batchId).q || '0';

  function create(ctx, body) {
    need(ctx, 'inventory_counts.create');
    const d = validator(body).id('warehouseId', { required: true }).id('groupId').str('countDate', { required: true, pattern: /^\d{4}-\d{2}-\d{2}$/ })
      .bool('blind').bool('freeze').str('notes', { max: 500, multiline: true }).done();
    return inTransaction(db, () => {
      const wh = whAccess.assertWarehouse(ctx, d.warehouseId, { active: true });
      ctx.access.assertBranch(wh.branch_id);
      if (d.groupId != null && !db.prepare('SELECT 1 FROM inv_groups WHERE id = ?').get(d.groupId)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { groupId: 'NOT_FOUND' } });
      if (db.prepare("SELECT 1 FROM inv_counts WHERE warehouse_id = ? AND status IN ('counting', 'review', 'approved')").get(wh.id)) fail(409, 'COUNT_IN_PROGRESS', 'يوجد جرد مفتوح على المخزن');
      const period = services.fiscal.periodFor(d.countDate);
      if (!period) fail(409, 'NO_FISCAL_PERIOD', 'التاريخ لا يقع في أي فترة مالية معرّفة');
      const snap = db.prepare('SELECT ifnull(max(id), 0) m FROM inv_moves').get().m;
      const series = services.numbering.seriesFor('inv_count');
      const num = services.numbering.issue({ seriesId: series.id, docType: 'inv_count', branchId: wh.branch_id, fiscalYearId: period.fiscalYearId, sourceId: 0, userId: ctx.user.id });
      const id = Number(db.prepare(`INSERT INTO inv_counts (number, branch_id, warehouse_id, group_id, count_date, blind, freeze, cutoff_at, snapshot_move_id, notes, created_by)
        VALUES (?, ?, ?, ?, ?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now'), ?, ?, ?)`).run(num.number, wh.branch_id, wh.id, d.groupId ?? null, d.countDate, d.blind ? 1 : 0, d.freeze ? 1 : 0, snap, d.notes ?? null, ctx.user.id).lastInsertRowid);
      const rows = db.prepare(`SELECT b.item_id, b.loc_key, b.batch_key, b.qty FROM inv_balances b JOIN inv_items i ON i.id = b.item_id
        WHERE b.warehouse_id = ? AND dec_cmp(b.qty, '0') <> 0 AND ${inGroup(d.groupId)} ORDER BY i.code, b.batch_key, b.loc_key`).all(wh.id, ...(d.groupId ? [d.groupId] : []));
      const ins = db.prepare('INSERT INTO inv_count_lines (count_id, item_id, location_id, batch_id, system_qty, unit_cost) VALUES (?, ?, ?, ?, ?, ?)');
      for (const r of rows) {
        const p = db.prepare('SELECT qty, value FROM inv_pools WHERE item_id = ? AND warehouse_id = ? AND batch_key = ?').get(r.item_id, wh.id, r.batch_key);
        const uc = p && D.gt(p.qty, '0') ? D.commit(D.div(p.value, p.qty), 'unit_cost') : null;
        ins.run(id, r.item_id, r.loc_key || null, r.batch_key || null, r.qty, uc);
      }
      audit.fromCtx(ctx, { action: 'inventory.count_started', source: 'inventory', entityType: 'inv_count', entityId: id, details: { number: num.number, warehouse: wh.code, lines: rows.length, blind: !!d.blind, freeze: !!d.freeze, snapshotMoveId: snap } });
      return get(ctx, id);
    });
  }
  function addLine(ctx, id, body) {
    need(ctx, 'inventory_counts.count');
    const d = validator(body).id('itemId', { required: true }).id('locationId').id('batchId').done();
    return inTransaction(db, () => {
      const c = countRow(ctx, id);
      if (c.status !== 'counting') fail(409, 'COUNT_NOT_OPEN', 'الجرد ليس في مرحلة العد');
      const it = db.prepare(`SELECT i.* FROM inv_items i WHERE i.id = ? AND ${inGroup(c.group_id)}`).get(d.itemId, ...(c.group_id ? [c.group_id] : []));
      if (!it || it.is_stock !== 1) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { itemId: 'NOT_IN_COUNT_SCOPE' } });
      if (d.locationId != null && db.prepare('SELECT warehouse_id w FROM inv_locations WHERE id = ?').get(d.locationId)?.w !== c.warehouse_id) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { locationId: 'NOT_IN_WAREHOUSE' } });
      if (it.track_batches === 1 && d.batchId == null) fail(409, 'BATCH_REQUIRED', 'حدد الدفعة');
      if (d.batchId != null && db.prepare('SELECT item_id FROM inv_batches WHERE id = ?').get(d.batchId)?.item_id !== it.id) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { batchId: 'NOT_FOR_ITEM' } });
      const sys = snapQty(c.warehouse_id, c.snapshot_move_id, it.id, d.locationId ?? null, d.batchId ?? null);
      try {
        db.prepare('INSERT INTO inv_count_lines (count_id, item_id, location_id, batch_id, system_qty, added) VALUES (?, ?, ?, ?, ?, 1)').run(id, it.id, d.locationId ?? null, d.batchId ?? null, sys);
      } catch (e) { if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') fail(409, 'DUPLICATE_COUNT_LINE', 'الصنف/الموقع/الدفعة موجود في الجلسة'); throw e; }
      return get(ctx, id);
    });
  }
  function enter(ctx, id, body) {
    need(ctx, 'inventory_counts.count');
    const d = validator(body).id('lineId', { required: true }).decimal('qty', { required: true }).bool('recount').done();
    const qty = engine.decimalIn(d.qty, 'quantity', 'qty');
    return inTransaction(db, () => {
      const c = countRow(ctx, id);
      if (c.status !== 'counting') fail(409, 'COUNT_NOT_OPEN', 'الجرد ليس في مرحلة العد');
      const l = db.prepare('SELECT * FROM inv_count_lines WHERE id = ? AND count_id = ?').get(d.lineId, id);
      if (!l) fail(404, 'NOT_FOUND', 'سطر الجرد غير موجود');
      const n = db.prepare('SELECT count(*) c FROM inv_count_entries WHERE line_id = ?').get(l.id).c;
      if (n > 0 && !d.recount) fail(409, 'ALREADY_COUNTED', 'السطر معدود من قبل؛ إعادة العد تكون صريحة كجولة جديدة', { rounds: n });
      if (n >= 9) fail(409, 'TOO_MANY_ROUNDS', 'تجاوز الحد الأقصى لجولات العد');
      const it = db.prepare('SELECT track_serials FROM inv_items WHERE id = ?').get(l.item_id);
      if (it.track_serials === 1 && !D.eq(qty, D.parse(qty).toDecimalPlaces(0))) fail(409, 'SERIAL_QTY_INTEGER', 'كمية صنف الأرقام المسلسلة عدد صحيح');
      db.prepare('INSERT INTO inv_count_entries (line_id, round, qty, counted_by) VALUES (?, ?, ?, ?)').run(l.id, n + 1, qty, ctx.user.id);
      audit.fromCtx(ctx, { action: 'inventory.count_entered', source: 'inventory', entityType: 'inv_count', entityId: id, details: { line: l.id, round: n + 1, qty } });
      return get(ctx, id);
    });
  }
  function transition(ctx, id, perm, from, to, action, extra = () => {}) {
    need(ctx, perm);
    return inTransaction(db, () => {
      const c = countRow(ctx, id);
      ctx.access.assertBranch(c.branch_id);
      if (!from.includes(c.status)) fail(409, 'COUNT_STATE', 'حالة الجرد لا تسمح بهذا الإجراء', { status: c.status });
      const cols = extra(c) || {};
      const sets = ['status = ?', ...Object.keys(cols).map((k) => `${k} = ?`)];
      db.prepare(`UPDATE inv_counts SET ${sets.join(', ')} WHERE id = ?`).run(to, ...Object.values(cols), id);
      audit.fromCtx(ctx, { action: `inventory.count_${action}`, source: 'inventory', entityType: 'inv_count', entityId: id, details: { number: c.number, from: c.status, to } });
      return get(ctx, id);
    });
  }
  const now = () => new Date().toISOString();
  const submit = (ctx, id) => transition(ctx, id, 'inventory_counts.count', ['counting'], 'review', 'submitted', () => ({ submitted_by: ctx.user.id, submitted_at: now() }));
  const reopen = (ctx, id) => transition(ctx, id, 'inventory_counts.review', ['review'], 'counting', 'reopened');
  function approve(ctx, id, body = {}) {
    const zero = body.uncountedAsZero === true;
    return transition(ctx, id, 'inventory_counts.approve', ['review'], 'approved', 'approved', (c) => {
      const lines = db.prepare('SELECT l.id, (SELECT qty FROM inv_count_entries e WHERE e.line_id = l.id ORDER BY round DESC LIMIT 1) q FROM inv_count_lines l WHERE l.count_id = ?').all(c.id);
      const missing = lines.filter((l) => l.q == null);
      if (missing.length && !zero) fail(409, 'UNCOUNTED_LINES', 'سطور لم تُعدّ بعد', { lines: missing.length });
      for (const l of lines) db.prepare('UPDATE inv_count_lines SET final_qty = ? WHERE id = ?').run(l.q ?? '0', l.id);
      return { approved_by: ctx.user.id, approved_at: now() };
    });
  }
  function cancel(ctx, id, body = {}) {
    const d = validator(body).str('reason', { required: true, min: 3, max: 500 }).done();
    return transition(ctx, id, 'inventory_counts.create', ['counting', 'review', 'approved'], 'cancelled', 'cancelled', () => ({ cancelled_by: ctx.user.id, cancelled_at: now(), cancel_reason: d.reason }));
  }

  /** ترحيل الفروق: تسوية زيادة وتسوية عجز عبر المحرك المركزي (مستندات مصدرها الجرد ومرتبطة به). */
  function post(ctx, id, body = {}) {
    need(ctx, 'inventory_counts.post');
    const d = validator(body).str('date', { pattern: /^\d{4}-\d{2}-\d{2}$/ }).done();
    return inTransaction(db, () => {
      const prior = engine.replay(ctx, body.idempotencyKey, 'count_post');
      if (prior) return prior;
      const c = countRow(ctx, id);
      ctx.access.assertBranch(c.branch_id);
      if (c.status !== 'approved') fail(409, 'COUNT_STATE', 'الجرد غير معتمد', { status: c.status });
      const date = d.date || today();
      const costs = body.costs && typeof body.costs === 'object' ? body.costs : {};
      const ins = []; const outs = [];
      for (const l of db.prepare('SELECT * FROM inv_count_lines WHERE count_id = ? ORDER BY id').all(id)) {
        const diff = D.sub(l.final_qty, l.system_qty);
        if (D.isZero(diff)) continue;
        const item = db.prepare('SELECT * FROM inv_items WHERE id = ?').get(l.item_id);
        const line = { itemId: l.item_id, unitId: item.base_unit_id, qty: D.canonical(D.abs(diff)), locationId: l.location_id ?? undefined, batchId: l.batch_id ?? undefined, notes: `count line ${l.id}` };
        if (D.gt(diff, '0')) {
          const pool = db.prepare('SELECT qty, value, last_move_id FROM inv_pools WHERE item_id = ? AND warehouse_id = ? AND batch_key = ?').get(l.item_id, c.warehouse_id, l.batch_id || 0);
          if (costs[l.id] != null) line.unitCost = String(costs[l.id]);
          else if (!pool && l.unit_cost != null) line.unitCost = l.unit_cost;
          else if (!pool) fail(409, 'COST_REQUIRED', 'لا توجد تكلفة للصنف؛ أدخل تكلفة الوحدة للزيادة', { line: l.id, item: item.code });
          ins.push(line);
        } else outs.push(line);
      }
      const docs = [];
      for (const [type, lines] of [['adjust_out', outs], ['adjust_in', ins]]) {
        if (!lines.length) continue;
        const docId = engine.createDraft(ctx, { docType: type, warehouseId: c.warehouse_id, docDate: date, reason: `فروق الجرد ${c.number}`, lines }, { sourceModule: 'counts', countId: c.id });
        docs.push(engine.post(ctx, docId, {}, { internal: true, countId: c.id }));
      }
      db.prepare("UPDATE inv_counts SET status = 'posted', posted_by = ?, posted_at = ? WHERE id = ?").run(ctx.user.id, now(), id);
      audit.fromCtx(ctx, { action: 'inventory.count_posted', source: 'inventory', entityType: 'inv_count', entityId: id, details: { number: c.number, documents: docs.map((x) => x.number), surplusLines: ins.length, shortageLines: outs.length } });
      const result = { ...get(ctx, id), documents: docs };
      engine.remember(ctx, body.idempotencyKey, 'count_post', result);
      return result;
    });
  }

  function get(ctx, id) {
    const c = countRow(ctx, id);
    const hide = c.blind === 1 && c.status === 'counting' && !ctx.access.can('inventory_counts.review');
    const wh = db.prepare('SELECT code, name_ar, name_en FROM inv_warehouses WHERE id = ?').get(c.warehouse_id);
    const lines = db.prepare(`SELECT l.*, i.code item_code, i.name_ar, i.name_en, b.batch_no, loc.code loc_code FROM inv_count_lines l JOIN inv_items i ON i.id = l.item_id
      LEFT JOIN inv_batches b ON b.id = l.batch_id LEFT JOIN inv_locations loc ON loc.id = l.location_id WHERE l.count_id = ? ORDER BY i.code, l.id`).all(id).map((l) => {
      const entries = db.prepare('SELECT e.round, e.qty, e.counted_at, u.username FROM inv_count_entries e JOIN users u ON u.id = e.counted_by WHERE e.line_id = ? ORDER BY e.round').all(l.id);
      const last = entries.length ? entries[entries.length - 1].qty : null;
      const final = l.final_qty ?? last;
      const diff = final != null && !hide ? D.canonical(D.sub(final, l.system_qty)) : null;
      return { id: l.id, itemId: l.item_id, itemCode: l.item_code, itemNameAr: l.name_ar, itemNameEn: l.name_en, locationId: l.location_id, locationCode: l.loc_code, batchId: l.batch_id, batchNo: l.batch_no,
        systemQty: hide ? null : l.system_qty, unitCost: hide ? null : l.unit_cost, countedQty: last, finalQty: l.final_qty, difference: diff,
        differenceValue: diff != null && l.unit_cost != null ? D.commit(D.mul(diff, l.unit_cost), 'amount', services.ledger.baseCurrency().code) : null,
        added: l.added === 1, entries: entries.map((e) => ({ round: e.round, qty: e.qty, by: e.username, at: e.counted_at })) };
    });
    const docs = db.prepare('SELECT id, number, doc_type docType, total_value totalValue, gl_number glNumber FROM inv_documents WHERE count_id = ? AND status = \'posted\' ORDER BY id').all(id);
    return { id: c.id, number: c.number, branchId: c.branch_id, warehouseId: c.warehouse_id, warehouseCode: wh.code, warehouseNameAr: wh.name_ar, warehouseNameEn: wh.name_en,
      groupId: c.group_id, countDate: c.count_date, status: c.status, blind: c.blind === 1, freeze: c.freeze === 1, cutoffAt: c.cutoff_at, snapshotMoveId: c.snapshot_move_id,
      systemHidden: hide, notes: c.notes, cancelReason: c.cancel_reason, lines, documents: docs };
  }
  function list(ctx, q = {}) {
    const w = []; const p = [];
    const f = whAccess.sqlFilter(ctx, 'c.warehouse_id'); w.push(f.sql); p.push(...f.params);
    const b = ctx.access.sqlFilter('c.branch_id'); w.push(b.sql); p.push(...b.params);
    if (['counting', 'review', 'approved', 'posted', 'cancelled'].includes(q.status)) { w.push('c.status = ?'); p.push(q.status); }
    return db.prepare(`SELECT c.id, c.number, c.count_date countDate, c.status, c.blind, c.freeze, w.code warehouseCode, (SELECT count(*) FROM inv_count_lines l WHERE l.count_id = c.id) lines
      FROM inv_counts c JOIN inv_warehouses w ON w.id = c.warehouse_id WHERE ${w.join(' AND ')} ORDER BY c.id DESC LIMIT 500`).all(...p).map((r) => ({ ...r, blind: r.blind === 1, freeze: r.freeze === 1 }));
  }
  return { create, addLine, enter, submit, reopen, approve, cancel, post, get, list };
}

module.exports = { createCounts };

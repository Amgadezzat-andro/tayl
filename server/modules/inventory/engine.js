'use strict';
const { HttpError, DecimalError } = require('../../core/errors');
const { inTransaction } = require('../../core/db');
const { validator } = require('../../core/validate');

/**
 * محرك المخزون المركزي (المرحلة 6) — النقطة الوحيدة التي تكتب في inv_moves (والملخصات تتبعها بـ trigger)،
 * ومنه وحده يمر الأثر المحاسبي إلى services.ledger.post() (origin = 'subledger'، source_type = 'inventory').
 *
 * دورة المستند: مسودة (بلا أي أثر) ← ترحيل ذري (التحقق، التكلفة، الرقم، الحركات، الدفعات/الأرقام المسلسلة، الحجوزات،
 * التحويلات، القيد) ← عكس كامل مرة واحدة. أي فشل ⇒ لا شيء يُحفظ ولا رقم يُستهلك (معاملة BEGIN IMMEDIATE واحدة).
 *
 * التقييم: المتوسط المرجح المتحرك لكل مجمع تكلفة (صنف، مخزن، دفعة). المجمع = (Q كمية، V قيمة) بالعملة الأساسية:
 *   إضافة q بقيمة v:        Q' = Q + q ، V' = V + v                      (v = commit(كمية المستند × تكلفة وحدة المستند))
 *   صرف q (q < Q):          v = commit(V × q ÷ Q) ، Q' = Q − q ، V' = V − v
 *   صرف كل الرصيد (q = Q):  v = V (لا بواقي تقريب: كمية صفر ⇒ قيمة صفر بالضبط)
 *   تحويل/إرسال:            قيمة الخروج نفسها تدخل الوجهة (لا ربح ولا خسارة ولا تضخيم)
 *   مرتجع بمرجع:            v = commit(قيمة الصرف الأصلي × q ÷ كمية الصرف الأصلي)، والمرتجع الأخير يأخذ الباقي بالضبط
 *   عكس:                    كل حركة بنفس كميتها وقيمتها في الاتجاه المعاكس (لا إعادة تسعير)
 * الثوابت بعد كل حركة: Q ≥ 0 ، V ≥ 0 ، Q = 0 ⇒ V = 0 (إلا مسار الرصيد السالب المصرح به، وتكلفته آخر تكلفة معروفة،
 * وتسوية الفرق عند الإضافة التالية إلى حساب الفروق). لقطة القيمة وتكلفة الوحدة تُحفظ في كل حركة ولا يُعاد تسعيرها.
 *
 * لا ترحيل بتاريخ أقدم من آخر حركة على المجمع نفسه (BACKDATED_MOVEMENT): فيبقى ترتيب التكلفة = ترتيب التاريخ،
 * ويُبنى الرصيد والتقييم في أي تاريخ من السجل بدقة.
 */
const QUALITY = ['available', 'inspection', 'rejected', 'hold', 'quarantine'];
const SERIES = { opening: 'inv_opening', receipt: 'inv_receipt', issue: 'inv_issue', transfer: 'inv_transfer', transfer_out: 'inv_transfer_out', transfer_in: 'inv_transfer_in',
  adjust_in: 'inv_adjust_in', adjust_out: 'inv_adjust_out', return: 'inv_return', quality: 'inv_quality', reversal: 'inv_reversal' };
const MANUAL_TYPES = ['opening', 'receipt', 'issue', 'transfer', 'transfer_out', 'adjust_in', 'adjust_out', 'return', 'quality'];
const INBOUND = ['opening', 'receipt', 'adjust_in', 'return', 'transfer_in'];
const OUTBOUND = ['issue', 'adjust_out', 'transfer_out'];
const RESTRICTED_OUT = ['issue', 'transfer_out'];   // الجودة/الصلاحية/FEFO/الحجوزات تُطبَّق على الصرف والإرسال
const COSTED_IN = ['opening', 'receipt'];           // تكلفة وحدة إلزامية
const KEY_RE = /^[A-Za-z0-9_.:-]{8,100}$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function createInventoryEngine(services, { masters, whAccess }) {
  const { db, decimal: D, audit } = services;
  const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };
  const can = (ctx, p) => ctx.access.can(p);
  const need = (ctx, p) => { if (!can(ctx, p)) fail(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية', { permission: p }); };
  const itemRow = (id) => db.prepare('SELECT * FROM inv_items WHERE id = ?').get(id);
  const batchRow = (id) => db.prepare('SELECT * FROM inv_batches WHERE id = ?').get(id);
  const docRow = (id) => db.prepare('SELECT * FROM inv_documents WHERE id = ?').get(id);
  const linesOf = (docId) => db.prepare('SELECT * FROM inv_document_lines WHERE doc_id = ? ORDER BY line_no').all(docId);
  const base = () => services.ledger.baseCurrency();
  const amt = (x) => D.commit(x, 'amount', base().code);
  const ucost = (v, q) => (D.isZero(q) ? '0' : D.commit(D.div(v, q), 'unit_cost'));
  const today = () => services.ledger.today();

  // ── منع التكرار ──
  function replay(ctx, key, op) {
    if (key == null) return null;
    if (typeof key !== 'string' || !KEY_RE.test(key)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { idempotencyKey: 'INVALID' } });
    const r = db.prepare('SELECT * FROM inv_requests WHERE idempotency_key = ?').get(key);
    if (!r) return null;
    if (r.operation !== op || r.user_id !== ctx.user.id) fail(409, 'IDEMPOTENCY_KEY_REUSED', 'مفتاح الطلب مستخدم لعملية أخرى');
    return { ...JSON.parse(r.result), replayed: true };
  }
  const remember = (ctx, key, op, result) => { if (key != null) db.prepare('INSERT INTO inv_requests (idempotency_key, operation, user_id, result) VALUES (?, ?, ?, ?)').run(key, op, ctx.user.id, JSON.stringify(result)); };

  // ── قراءة/تحقق الإدخال ──
  function decimalIn(v, kind, field, { positive = false, zero = true } = {}) {
    let x;
    try { x = D.toStorage(D.parse(v), kind); } catch (e) {
      if (e instanceof DecimalError || e instanceof Error) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: e.code === 'SCALE_EXCEEDED' ? 'TOO_PRECISE' : 'INVALID' } });
    }
    if (D.isNegative(x)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: 'NEGATIVE' } });
    if ((positive || !zero) && D.isZero(x)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: 'MUST_BE_POSITIVE' } });
    return x;
  }
  function parseLines(lines) {
    if (!Array.isArray(lines) || lines.length < 1 || lines.length > 500) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { lines: 'INVALID' } });
    return lines.map((l, i) => {
      try {
        const d = validator(l).id('itemId', { required: true }).id('unitId').decimal('qty').decimal('unitCost').id('locationId').id('toLocationId').id('batchId')
          .str('batchNo', { max: 60 }).str('productionDate', { pattern: DATE_RE }).str('expiryDate', { pattern: DATE_RE }).oneOf('toStatus', QUALITY)
          .id('reservationId').id('refLineId').bool('overrideFefo').str('notes', { max: 300 }).done();
        if (l.serials != null) {
          if (!Array.isArray(l.serials) || l.serials.length > 5000 || !l.serials.every((s) => typeof s === 'string' && s.trim().length >= 1 && s.trim().length <= 80)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { serials: 'INVALID' } });
          d.serials = l.serials.map((s) => s.trim());
          if (new Set(d.serials).size !== d.serials.length) fail(409, 'SERIAL_DUPLICATE', 'رقم مسلسل مكرر في السطر');
        }
        return d;
      } catch (e) {
        if (e instanceof HttpError) throw new HttpError(e.status, e.code, e.message, { ...(e.details || {}), line: i + 1 });
        throw e;
      }
    });
  }
  function parseDoc(body, { partial }) {
    const d = validator(body, { partial }).oneOf('docType', MANUAL_TYPES, { required: !partial }).id('warehouseId').id('toWarehouseId')
      .str('docDate', { required: !partial, pattern: DATE_RE }).str('externalRef', { max: 60 }).str('reason', { min: 3, max: 500, multiline: true })
      .str('notes', { max: 1000, multiline: true }).id('counterAccountId').id('costCenterId').id('returnOfId')
      .str('overrideReason', { min: 3, max: 500 }).str('negativeReason', { min: 3, max: 500 }).done();
    if (!partial || body.lines !== undefined) d.lines = parseLines(body.lines);
    return d;
  }
  const atLine = (n, fn) => { try { return fn(); } catch (e) { if (e instanceof HttpError) throw new HttpError(e.status, e.code, e.message, { ...(e.details || {}), line: n }); throw e; } };

  /** تحقق السطر عند حفظ المسودة وعند الترحيل (البيانات الحالية): الصنف، الوحدة والعامل، الكمية الأساسية الدقيقة، الموقع، الدفعة. */
  function checkLine(ctx, doc, l, n) {
    return atLine(n, () => {
      const it = itemRow(l.itemId ?? l.item_id);
      if (!it) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { itemId: 'NOT_FOUND' } });
      if (it.is_active !== 1) fail(409, 'ITEM_INACTIVE', 'الصنف موقوف', { item: it.code });
      if (it.is_stock !== 1) fail(409, 'ITEM_NOT_STOCK', 'الصنف غير مخزني ولا يقبل حركات مخزنية', { item: it.code });
      const unitId = l.unitId ?? l.unit_id ?? it.base_unit_id;
      const factor = masters.factorOf(it, unitId);
      const isQuality = doc.doc_type === 'quality';
      const qty = isQuality ? '0' : decimalIn(l.qty ?? '0', 'quantity', 'qty', { zero: doc.doc_type === 'transfer_in' });
      let baseQty;
      try { baseQty = D.toStorage(D.mul(qty, factor), 'quantity'); } catch { fail(409, 'TOO_PRECISE', 'الكمية بوحدة الأساس أدق من دقة التخزين (8 خانات)؛ استخدم وحدة أخرى أو كمية أخرى', { item: it.code }); }
      const unitCost = (l.unitCost ?? l.unit_cost) != null ? decimalIn(l.unitCost ?? l.unit_cost, 'unit_cost', 'unitCost') : null;
      if (COSTED_IN.includes(doc.doc_type) && unitCost == null) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { unitCost: 'REQUIRED' } });
      const locId = l.locationId ?? l.location_id ?? null;
      const toLocId = l.toLocationId ?? l.to_location_id ?? null;
      const locOk = (id, whId, field) => {
        if (id == null) return;
        const loc = db.prepare('SELECT * FROM inv_locations WHERE id = ?').get(id);
        if (!loc || loc.warehouse_id !== whId) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: 'NOT_IN_WAREHOUSE' } });
        if (loc.is_active !== 1) fail(409, 'LOCATION_INACTIVE', 'الموقع موقوف', { location: loc.code });
      };
      locOk(locId, doc.warehouse_id, 'locationId');
      if (doc.doc_type === 'transfer') locOk(toLocId, doc.to_warehouse_id, 'toLocationId');
      else if (toLocId != null) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { toLocationId: 'NOT_ALLOWED' } });
      const batchId = l.batchId ?? l.batch_id ?? null;
      const batchNo = l.batchNo ?? l.batch_no ?? null;
      if (batchId != null) {
        const b = batchRow(batchId);
        if (!b || b.item_id !== it.id) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { batchId: 'NOT_FOR_ITEM' } });
      }
      if ((batchId != null || batchNo != null) && it.track_batches !== 1) fail(409, 'ITEM_NOT_BATCH_TRACKED', 'الصنف لا يتتبع الدفعات', { item: it.code });
      if (batchNo != null && !['opening', 'receipt', 'adjust_in', 'return'].includes(doc.doc_type)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { batchNo: 'NOT_ALLOWED' } });
      if (isQuality && (batchId == null || (l.toStatus ?? l.to_status) == null)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [batchId == null ? 'batchId' : 'toStatus']: 'REQUIRED' } });
      if (it.track_batches === 1 && INBOUND.includes(doc.doc_type) && doc.doc_type !== 'transfer_in' && batchId == null && batchNo == null) fail(409, 'BATCH_REQUIRED', 'الصنف يتتبع الدفعات: حدد الدفعة أو أدخل رقم دفعة جديدة', { item: it.code });
      if (it.track_batches === 1 && ['adjust_out'].includes(doc.doc_type) && batchId == null) fail(409, 'BATCH_REQUIRED', 'حدد الدفعة', { item: it.code });
      const serials = l.serials != null ? (typeof l.serials === 'string' ? JSON.parse(l.serials) : l.serials) : null;
      if (it.track_serials === 1 && !isQuality) {
        if (!D.eq(baseQty, D.canonical(D.parse(baseQty).toDecimalPlaces(0)))) fail(409, 'SERIAL_QTY_INTEGER', 'كمية صنف الأرقام المسلسلة عدد صحيح بوحدة الأساس', { item: it.code });
        if (!serials || String(serials.length) !== D.canonical(baseQty)) fail(409, 'SERIALS_REQUIRED', 'عدد الأرقام المسلسلة يجب أن يساوي الكمية', { item: it.code, qty: baseQty, given: serials ? serials.length : 0 });
      } else if (serials && serials.length) fail(409, 'ITEM_NOT_SERIAL_TRACKED', 'الصنف لا يتتبع الأرقام المسلسلة', { item: it.code });
      const resId = l.reservationId ?? l.reservation_id ?? null;
      if (resId != null) {
        const r = db.prepare('SELECT * FROM inv_reservations WHERE id = ?').get(resId);
        if (!r || r.item_id !== it.id || r.warehouse_id !== doc.warehouse_id || !RESTRICTED_OUT.includes(doc.doc_type)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { reservationId: 'NOT_FOR_LINE' } });
      }
      return { item: it, unitId, factor, qty, baseQty, unitCost, locId, toLocId, batchId, batchNo, serials, resId };
    });
  }

  function assertDocWarehouses(ctx, d) {
    const wh = whAccess.assertWarehouse(ctx, d.warehouse_id ?? d.warehouseId, { active: true });
    ctx.access.assertBranch(wh.branch_id);
    let to = null;
    const toId = d.to_warehouse_id ?? d.toWarehouseId ?? null;
    if (toId != null) {
      to = whAccess.assertWarehouse(ctx, toId, { active: true, field: 'toWarehouseId' });
      if (to.id === wh.id) fail(409, 'SAME_WAREHOUSE', 'لا تحويل إلى المخزن نفسه');
    }
    return { wh, to };
  }

  // ── المسودات ──
  const createPerm = (type) => (['transfer', 'transfer_out'].includes(type) ? 'inventory_transfers.create' : type === 'quality' ? 'inventory_quality.view' : 'inventory_documents.create');
  function writeLines(docId, doc, checked, raw) {
    db.prepare('DELETE FROM inv_document_lines WHERE doc_id = ?').run(docId);
    const ins = db.prepare(`INSERT INTO inv_document_lines (doc_id, line_no, item_id, unit_id, qty, factor, base_qty, unit_cost, location_id, to_location_id, batch_id, batch_no,
      production_date, expiry_date, to_status, reservation_id, ref_line_id, serials, override_fefo, notes) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    checked.forEach((c, i) => {
      const l = raw[i];
      ins.run(docId, i + 1, c.item.id, c.unitId, c.qty, c.factor, c.baseQty, c.unitCost, c.locId, c.toLocId, c.batchId, c.batchNo, l.productionDate ?? null, l.expiryDate ?? null,
        l.toStatus ?? null, c.resId, l.refLineId ?? null, c.serials ? JSON.stringify(c.serials) : null, l.overrideFefo ? 1 : 0, l.notes ?? null);
    });
  }
  function createDraft(ctx, body, { sourceModule = 'inventory', countId = null } = {}) {
    const d = parseDoc(body, { partial: false });
    if (sourceModule === 'inventory') need(ctx, createPerm(d.docType));
    return inTransaction(db, () => {
      if (d.warehouseId == null) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { warehouseId: 'REQUIRED' } });
      if (['transfer', 'transfer_out'].includes(d.docType) && d.toWarehouseId == null) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { toWarehouseId: 'REQUIRED' } });
      if (!['transfer', 'transfer_out'].includes(d.docType)) d.toWarehouseId = null;
      const { wh, to } = assertDocWarehouses(ctx, d);
      if (d.docType === 'transfer' && to.branch_id !== wh.branch_id) fail(409, 'TRANSFER_BRANCH', 'التحويل بين المخازن داخل الفرع نفسه؛ للفروع استخدم التحويل بين الفروع');
      if (d.docType === 'transfer_out' && to.branch_id === wh.branch_id) fail(409, 'TRANSFER_BRANCH', 'التحويل بين الفروع لمخزن في فرع آخر');
      services.ledger.assertDraftable(ctx, wh.branch_id, d.docDate);
      if (d.counterAccountId != null) masters.checkAccount(d.counterAccountId, ['adjust_in', 'adjust_out'].includes(d.docType) ? 'adjustment' : 'counter', 'counterAccountId');
      if (d.returnOfId != null) {
        const o = docRow(d.returnOfId);
        if (d.docType !== 'return' || !o || o.doc_type !== 'issue' || o.status !== 'posted' || !whAccess.allowed(ctx, { id: o.warehouse_id, branch_id: o.branch_id })) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { returnOfId: 'NOT_A_POSTED_ISSUE' } });
      }
      const doc = { doc_type: d.docType, warehouse_id: wh.id, to_warehouse_id: to ? to.id : null };
      const checked = d.lines.map((l, i) => checkLine(ctx, doc, l, i + 1));
      const id = Number(db.prepare(`INSERT INTO inv_documents (doc_type, branch_id, warehouse_id, to_warehouse_id, doc_date, source_module, external_ref, reason, notes,
        counter_account_id, cost_center_id, return_of_id, count_id, override_reason, negative_reason, created_by, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(d.docType, wh.branch_id, wh.id, to ? to.id : null, d.docDate, sourceModule, d.externalRef ?? null, d.reason ?? null, d.notes ?? null,
          d.counterAccountId ?? null, d.costCenterId ?? null, d.returnOfId ?? null, countId, d.overrideReason ?? null, d.negativeReason ?? null, ctx.user.id, ctx.user.id).lastInsertRowid);
      writeLines(id, doc, checked, d.lines);
      audit.fromCtx(ctx, { action: 'inventory.document_created', source: 'inventory', entityType: 'inv_document', entityId: id, details: { type: d.docType, warehouse: wh.code, lines: d.lines.length, sourceModule } });
      return id;
    });
  }
  function updateDraft(ctx, id, body) {
    need(ctx, 'inventory_documents.edit_draft');
    const d = parseDoc(body, { partial: true });
    return inTransaction(db, () => {
      const doc = getVisibleDoc(ctx, id);
      if (doc.status !== 'draft') fail(409, 'NOT_DRAFT', 'المستند ليس مسودة؛ المرحّل لا يُعدَّل (اعكسه)');
      if (doc.source_module !== 'inventory') fail(409, 'SOURCE_LOCKED', 'مستند صادر من وحدة أخرى؛ يُعدَّل من مصدره');
      if (d.docType && d.docType !== doc.doc_type) fail(409, 'TYPE_LOCKED', 'نوع المستند لا يتغير');
      const next = { ...doc };
      const map = { warehouseId: 'warehouse_id', toWarehouseId: 'to_warehouse_id', docDate: 'doc_date', externalRef: 'external_ref', reason: 'reason', notes: 'notes',
        counterAccountId: 'counter_account_id', costCenterId: 'cost_center_id', returnOfId: 'return_of_id', overrideReason: 'override_reason', negativeReason: 'negative_reason' };
      for (const [k, col] of Object.entries(map)) if (k in d) next[col] = d[k];
      const { wh } = assertDocWarehouses(ctx, next);
      services.ledger.assertDraftable(ctx, wh.branch_id, next.doc_date);
      if ('counterAccountId' in d && d.counterAccountId != null) masters.checkAccount(d.counterAccountId, ['adjust_in', 'adjust_out'].includes(doc.doc_type) ? 'adjustment' : 'counter', 'counterAccountId');
      db.prepare(`UPDATE inv_documents SET branch_id = ?, warehouse_id = ?, to_warehouse_id = ?, doc_date = ?, external_ref = ?, reason = ?, notes = ?, counter_account_id = ?, cost_center_id = ?,
        return_of_id = ?, override_reason = ?, negative_reason = ?, approved_by = NULL, approved_at = NULL, updated_by = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
        .run(wh.branch_id, wh.id, next.to_warehouse_id, next.doc_date, next.external_ref, next.reason, next.notes, next.counter_account_id, next.cost_center_id,
          next.return_of_id, next.override_reason, next.negative_reason, ctx.user.id, id);
      if (d.lines) writeLines(id, next, d.lines.map((l, i) => checkLine(ctx, next, l, i + 1)), d.lines);
      audit.fromCtx(ctx, { action: 'inventory.document_updated', source: 'inventory', entityType: 'inv_document', entityId: id, details: { fields: Object.keys(d) } });
      return id;
    });
  }
  function cancelDraft(ctx, id) {
    need(ctx, 'inventory_documents.edit_draft');
    return inTransaction(db, () => {
      const doc = getVisibleDoc(ctx, id);
      if (doc.status !== 'draft') fail(409, 'NOT_DRAFT', 'المستند ليس مسودة');
      if (doc.source_module === 'counts') fail(409, 'SOURCE_LOCKED', 'مستند جرد؛ يُدار من جلسة الجرد');
      db.prepare("UPDATE inv_documents SET status = 'cancelled', cancelled_by = ?, cancelled_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(ctx.user.id, id);
      audit.fromCtx(ctx, { action: 'inventory.document_cancelled', source: 'inventory', entityType: 'inv_document', entityId: id, details: { type: doc.doc_type } });
      return id;
    });
  }
  function approve(ctx, id) {
    need(ctx, 'inventory_documents.approve');
    return inTransaction(db, () => {
      const doc = getVisibleDoc(ctx, id);
      if (doc.status !== 'draft') fail(409, 'NOT_DRAFT', 'المستند ليس مسودة');
      db.prepare("UPDATE inv_documents SET approved_by = ?, approved_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(ctx.user.id, id);
      audit.fromCtx(ctx, { action: 'inventory.document_approved', source: 'inventory', entityType: 'inv_document', entityId: id, details: { type: doc.doc_type } });
      return id;
    });
  }

  // ── الأرصدة والمجمعات أثناء التخطيط ──
  function makeState() {
    const pools = new Map(); const bals = new Map();
    const pkey = (i, w, b) => `${i}|${w}|${b || 0}`;
    function pool(itemId, whId, batchId) {
      const k = pkey(itemId, whId, batchId);
      if (!pools.has(k)) {
        const r = db.prepare('SELECT qty, value, last_move_id FROM inv_pools WHERE item_id = ? AND warehouse_id = ? AND batch_key = ?').get(itemId, whId, batchId || 0);
        const last = r ? db.prepare('SELECT move_date, unit_cost FROM inv_moves WHERE id = ?').get(r.last_move_id) : null;
        pools.set(k, { itemId, whId, batchId: batchId || null, qty: r ? r.qty : '0', value: r ? r.value : '0', lastDate: last ? last.move_date : null, lastCost: last ? last.unit_cost : null });
      }
      return pools.get(k);
    }
    function bal(itemId, whId, locId, batchId) {
      const k = `${itemId}|${whId}|${locId || 0}|${batchId || 0}`;
      if (!bals.has(k)) {
        const r = db.prepare('SELECT qty FROM inv_balances WHERE item_id = ? AND warehouse_id = ? AND loc_key = ? AND batch_key = ?').get(itemId, whId, locId || 0, batchId || 0);
        bals.set(k, { qty: r ? r.qty : '0' });
      }
      return bals.get(k);
    }
    return { pool, bal, pools };
  }
  /** المتاح للصرف على مستوى (صنف، مخزن): الرصيد بحالة جودة متاحة غير منتهية − المحجوز الفعال. */
  function reservedRemaining(itemId, whId, exceptResId, date) {
    const rows = db.prepare(`SELECT id, qty, consumed_qty FROM inv_reservations WHERE item_id = ? AND warehouse_id = ? AND status = 'active' AND (expires_on IS NULL OR expires_on >= ?)`).all(itemId, whId, date);
    return D.sum(rows.filter((r) => r.id !== exceptResId).map((r) => D.sub(r.qty, r.consumed_qty)));
  }
  function usableOnHand(itemId, wh, date) {
    if (wh.wh_type === 'quarantine') return '0';
    const rows = db.prepare(`SELECT b.qty, b.batch_key, x.status, x.expiry_date FROM inv_balances b LEFT JOIN inv_batches x ON x.id = b.batch_key WHERE b.item_id = ? AND b.warehouse_id = ?`).all(itemId, wh.id);
    return D.sum(rows.filter((r) => !r.batch_key || (r.status === 'available' && !(r.expiry_date && r.expiry_date < date))).map((r) => r.qty));
  }
  function frozenBy(whId, itemId, exceptCountId) {
    return db.prepare(`SELECT c.number FROM inv_counts c WHERE c.warehouse_id = ? AND c.freeze = 1 AND c.status IN ('counting', 'review', 'approved') AND c.id IS NOT ?
      AND (c.group_id IS NULL OR (SELECT group_id FROM inv_items WHERE id = ?) IN (SELECT id FROM inv_groups WHERE path LIKE (SELECT path FROM inv_groups WHERE id = c.group_id) || '%'))`).get(whId, exceptCountId ?? null, itemId);
  }

  /**
   * التخطيط: يحسب كل حركة بتكلفتها وكل سطر قيد دون كتابة الحركات (يُستخدم للمعاينة وللترحيل نفسه، فلا يختلفان).
   * قد ينشئ دفعات جديدة (داخل المعاملة؛ تُلغى مع المعاينة أو أي فشل).
   */
  function plan(ctx, doc, opts = {}) {
    const lines = lineOverride && lineOverride.length && lineOverride[0].doc_id === doc.id ? lineOverride : linesOf(doc.id);
    if (!lines.length) fail(409, 'NO_LINES', 'المستند بلا سطور');
    const wh = db.prepare('SELECT * FROM inv_warehouses WHERE id = ?').get(doc.warehouse_id);
    const toWh = doc.to_warehouse_id ? db.prepare('SELECT * FROM inv_warehouses WHERE id = ?').get(doc.to_warehouse_id) : null;
    const st = makeState();
    const moves = []; const gl = []; const lineUpdates = []; const qualityOps = []; const reservationOps = [];
    const date = doc.doc_date;
    const needsOverride = [];
    const negativeUsed = [];
    const plannedOut = new Map();   // صنف|مخزن ⇒ كمية خرجت في هذا المستند (للمتاح غير المحجوز)
    const resUse = new Map();

    const counterFor = (item) => {
      const t = doc.doc_type;
      if (t === 'receipt') { if (!doc.counter_account_id) fail(409, 'COUNTER_ACCOUNT_REQUIRED', 'حدد الحساب المقابل لإذن الإضافة'); return doc.counter_account_id; }
      if (t === 'opening') return doc.counter_account_id || null;
      if (t === 'issue' || t === 'return') {
        const ro = t === 'return' && doc.return_of_id ? docRow(doc.return_of_id) : null;
        return doc.counter_account_id || (ro && ro.counter_account_id) || masters.accountFor(item, 'issue');
      }
      if (t === 'adjust_in' || t === 'adjust_out') return doc.counter_account_id || masters.accountFor(item, 'adjustment');
      if (t === 'transfer_out' || t === 'transfer_in') return masters.transitAccount();
      return null;
    };
    const roleOf = (t) => ({ adjust_in: 'adjustment', adjust_out: 'adjustment', transfer_out: 'transit', transfer_in: 'transit' }[t] || 'counter');
    function requireAccount(id, item, role) {
      if (!id) fail(409, 'ACCOUNTING_SETTINGS_MISSING', 'إعدادات الربط المحاسبي ناقصة لهذه الحركة', { item: item.code, role });
      return id;
    }
    function postsGl() {
      if (doc.doc_type === 'opening') return !!doc.counter_account_id;
      return !['transfer', 'quality'].includes(doc.doc_type);
    }

    function checkPoolDate(p, item) {
      if (p.lastDate && date < p.lastDate) fail(409, 'BACKDATED_MOVEMENT', 'لا ترحيل بتاريخ أقدم من آخر حركة على الصنف في هذا المخزن', { item: item.code, lastMovementDate: p.lastDate, date });
    }
    function invariants(p, item) {
      if (D.isNegative(p.qty) || D.isNegative(p.value) || (D.isZero(p.qty) && !D.isZero(p.value))) {
        fail(409, 'COST_INVARIANT', 'الحركة تنتج كمية سالبة أو تكلفة سالبة أو غير محددة', { item: item.code, qty: p.qty, value: p.value });
      }
    }
    /** خروج من المجمع: القيمة بالمتوسط الحالي (أو آخر تكلفة معروفة في مسار السالب المصرح به). */
    function takeOut(p, q, item, { allowNegative }) {
      let v;
      if (D.gte(p.qty, q) && D.gt(p.qty, '0')) {
        v = D.eq(q, p.qty) ? p.value : amt(D.div(D.mul(p.value, q), p.qty));
      } else {
        if (!allowNegative) fail(409, 'INSUFFICIENT_STOCK', 'الكمية المطلوبة أكبر من الرصيد', { item: item.code, available: p.qty, requested: q });
        const last = D.gt(p.qty, '0') ? D.div(p.value, p.qty) : p.lastCost;
        if (last == null) fail(409, 'NEGATIVE_COST_UNKNOWN', 'لا توجد تكلفة موثوقة للصنف؛ لا يُسمح بالرصيد السالب', { item: item.code });
        v = D.gt(p.qty, '0') ? D.canonical(D.add(p.value, amt(D.mul(D.sub(q, p.qty), last)))) : amt(D.mul(q, last));
        p.lastCost = D.commit(last, 'unit_cost');
      }
      p.qty = D.canonical(D.sub(p.qty, q)); p.value = D.canonical(D.sub(p.value, v));
      if (!allowNegative) invariants(p, item);
      return D.canonical(v);
    }
    /** دخول إلى المجمع. إن كان سالبًا: يُسوّى الفرق بين تكلفة الإضافة وتكلفة ما صُرف بالسالب إلى حساب الفروق. */
    function putIn(p, q, v, item) {
      let moveValue = v; let variance = '0';
      if (D.isNegative(p.qty)) {
        const q2 = D.add(p.qty, q);
        const target = D.gt(q2, '0') ? amt(D.mul(q2, D.div(v, q))) : D.isZero(q2) ? '0' : amt(D.mul(q2, D.div(p.value, p.qty)));
        moveValue = D.canonical(D.sub(target, p.value));
        variance = D.canonical(D.sub(v, moveValue));
      }
      p.qty = D.canonical(D.add(p.qty, q)); p.value = D.canonical(D.add(p.value, moveValue));
      if (!D.isNegative(p.qty)) invariants(p, item);
      if (D.gt(q, '0') && p.lastCost == null) p.lastCost = ucost(moveValue, q);
      return { moveValue, variance };
    }
    function move(m) {
      const p = m.pool;
      moves.push({ ...m, poolQtyAfter: p.qty, poolValueAfter: p.value, unitCost: ucost(m.value, m.qty) });
    }
    function outAllowedChecks(c, item, lineRow, batch, explicit) {
      // الجودة والصلاحية وFEFO: للصرف والإرسال فقط؛ أي تجاوز = صلاحية + سبب
      if (!RESTRICTED_OUT.includes(doc.doc_type)) return;
      const reasons = [];
      if (wh.wh_type === 'quarantine') reasons.push('WAREHOUSE_QUARANTINE');
      if (batch) {
        if (batch.status !== 'available') reasons.push('BATCH_' + batch.status.toUpperCase());
        if (batch.expiry_date && batch.expiry_date < date) reasons.push('BATCH_EXPIRED');
        if (item.track_expiry === 1 && explicit) {
          const first = fefoCandidates(item, wh, c.locId, date, st).find((x) => D.gt(x.free, '0'));
          if (first && first.batch.id !== batch.id && (first.batch.expiry_date || '9999') < (batch.expiry_date || '9999')) reasons.push('FEFO');
        }
      }
      if (reasons.length) needsOverride.push({ line: lineRow.line_no, item: item.code, batch: batch ? batch.batch_no : null, reasons, override: lineRow.override_fefo === 1 });
    }
    function fefoCandidates(item, w, locId, d, state) {
      const rows = db.prepare(`SELECT x.* FROM inv_balances b JOIN inv_batches x ON x.id = b.batch_key WHERE b.item_id = ? AND b.warehouse_id = ? AND b.loc_key = ? AND b.batch_key <> 0
        ORDER BY (x.expiry_date IS NULL), x.expiry_date, x.id`).all(item.id, w.id, locId || 0);
      return rows.filter((x) => x.status === 'available' && !(x.expiry_date && x.expiry_date < d)).map((x) => ({ batch: x, free: state.bal(item.id, w.id, locId, x.id).qty }));
    }
    function reservationCheck(item, w, q, resId, lineNo) {
      if (!RESTRICTED_OUT.includes(doc.doc_type) && doc.doc_type !== 'transfer') return;
      const k = `${item.id}|${w.id}`;
      const out = plannedOut.get(k) || '0';
      const usable = usableOnHand(item.id, w, date);
      const others = reservedRemaining(item.id, w.id, resId, date);
      let own = '0';
      if (resId) {
        const r = db.prepare('SELECT * FROM inv_reservations WHERE id = ?').get(resId);
        if (r.status !== 'active' || (r.expires_on && r.expires_on < date)) fail(409, 'RESERVATION_NOT_ACTIVE', 'الحجز غير فعال', { line: lineNo });
        own = D.canonical(D.sub(D.sub(r.qty, r.consumed_qty), resUse.get(resId) || '0'));
        const use = D.min(q, own);
        resUse.set(resId, D.canonical(D.add(resUse.get(resId) || '0', use)));
        reservationOps.push({ id: resId, qty: D.canonical(use) });
      }
      const free = D.sub(D.sub(usable, others), out);
      // نقص الرصيد الفعلي يُبلَّغ كـ INSUFFICIENT_STOCK من فحص الكمية؛ هنا فقط ما يحجبه حجز لغير هذا السطر
      if (D.gt(q, D.add(D.max(free, '0'), own)) && D.lte(q, D.sub(usable, out)) && !doc.negative_reason) {
        fail(409, 'RESERVED_STOCK', 'الكمية تتجاوز المتاح غير المحجوز', { item: item.code, line: lineNo, availableUnreserved: D.canonical(D.max(free, '0')), reservation: D.canonical(own), requested: q });
      }
      plannedOut.set(k, D.canonical(D.add(out, q)));
    }
    function allowNegativeFor(item, c) {
      if (!['issue', 'adjust_out'].includes(doc.doc_type) || !doc.negative_reason) return false;
      if (item.track_batches === 1 || item.track_serials === 1 || c.locId) return false;
      if (!can(ctx, 'inventory.allow_negative')) fail(403, 'NEGATIVE_FORBIDDEN', 'الرصيد السالب يتطلب صلاحية مستقلة');
      return true;
    }

    // ── السطور ──
    let total = '0';
    for (const l of lines) {
      const c = checkLine(ctx, doc, l, l.line_no);
      const item = c.item;
      atLine(l.line_no, () => {
        if (frozenBy(wh.id, item.id, opts.countId) || (toWh && frozenBy(toWh.id, item.id, opts.countId))) fail(409, 'COUNT_IN_PROGRESS', 'جرد مجمّد على المخزن لهذا الصنف؛ لا حركات حتى ترحيل الجرد أو إلغائه', { item: item.code });
        const invAcc = masters.accountFor(item, 'inventory');
        const glOn = postsGl();
        let lineValue = '0';
        const lineMoves = [];

        if (doc.doc_type === 'quality') {
          const b = batchRow(c.batchId);
          if (b.status === l.to_status) fail(409, 'QUALITY_NO_CHANGE', 'الدفعة بالحالة نفسها', { batch: b.batch_no });
          const perm = l.to_status === 'available' ? 'inventory_quality.release' : l.to_status === 'rejected' ? 'inventory_quality.reject' : 'inventory_quality.quarantine';
          if (!opts.internal) need(ctx, perm);
          qualityOps.push({ batchId: b.id, from: b.status, to: l.to_status, lineId: l.id });
          lineUpdates.push({ id: l.id, factor: c.factor, baseQty: '0', value: null, batchId: b.id, fromStatus: b.status });
          return;
        }

        // ── الدخول ──
        if (INBOUND.includes(doc.doc_type)) {
          let batchId = c.batchId;
          if (batchId == null && c.batchNo != null) batchId = ensureBatch(ctx, item, c.batchNo, l, opts.preview);
          if (doc.doc_type === 'opening') {
            const dup = db.prepare(`SELECT d.number FROM inv_document_lines x JOIN inv_documents d ON d.id = x.doc_id WHERE d.doc_type = 'opening' AND d.status = 'posted'
              AND NOT EXISTS (SELECT 1 FROM inv_documents r WHERE r.reverses_id = d.id) AND d.warehouse_id = ? AND x.item_id = ? AND x.location_id IS ? AND x.batch_id IS ? LIMIT 1`).get(wh.id, item.id, c.locId, batchId);
            if (dup) fail(409, 'OPENING_EXISTS', 'يوجد رصيد افتتاحي فعال لنفس الصنف والمخزن والموقع والدفعة', { item: item.code, document: dup.number });
          }
          const p = st.pool(item.id, wh.id, batchId);
          checkPoolDate(p, item);
          let v;
          if (doc.doc_type === 'transfer_in') v = l.value;   // محسوبة من التحويل (receive)
          else if (c.unitCost != null) v = amt(D.mul(c.qty, c.unitCost));
          else if (doc.doc_type === 'return' && l.ref_line_id) v = returnValue(l, c, batchId, item);
          else {
            const avg = D.gt(p.qty, '0') ? D.div(p.value, p.qty) : p.lastCost;
            if (avg == null) fail(409, 'COST_REQUIRED', 'لا توجد تكلفة حالية للصنف؛ أدخل تكلفة الوحدة', { item: item.code });
            v = amt(D.mul(c.baseQty, avg));
          }
          if (doc.doc_type === 'transfer_in') {
            const acc = D.sub(c.baseQty, '0');
            if (D.gt(acc, '0')) {
              const r = putIn(p, c.baseQty, l.accepted_value, item);
              move({ line: l, pool: p, whId: wh.id, branchId: wh.branch_id, locId: c.locId, batchId, direction: 'in', qty: c.baseQty, value: r.moveValue, invAcc, glOn, item });
              lineMoves.push({ value: r.moveValue, variance: r.variance });
            }
            if (D.gt(l.qty_rejected, '0')) {
              const rw = opts.rejectWarehouse;
              const p2 = st.pool(item.id, rw.id, batchId);
              checkPoolDate(p2, item);
              const r2 = putIn(p2, l.qty_rejected, l.rejected_value, item);
              move({ line: l, pool: p2, whId: rw.id, branchId: rw.branch_id, locId: null, batchId, direction: 'in', qty: l.qty_rejected, value: r2.moveValue, invAcc, glOn, item });
              lineMoves.push({ value: r2.moveValue, variance: r2.variance });
            }
            lineValue = v;
          } else {
            const r = putIn(p, c.baseQty, v, item);
            move({ line: l, pool: p, whId: wh.id, branchId: wh.branch_id, locId: c.locId, batchId, direction: 'in', qty: c.baseQty, value: r.moveValue, invAcc, glOn, item, serials: c.serials });
            lineMoves.push({ value: r.moveValue, variance: r.variance });
            lineValue = v;
          }
          const counter = glOn ? requireAccount(counterFor(item), item, roleOf(doc.doc_type)) : null;
          for (const m of lineMoves) {
            if (!glOn) continue;
            const mv = D.canonical(D.add(m.value, m.variance));
            if (D.gt(mv, '0') || !D.isZero(m.value)) {
              if (!D.isZero(m.value)) gl.push({ role: 'inventory', accountId: requireAccount(invAcc, item, 'inventory'), debit: m.value, credit: '0' });
              if (!D.isZero(mv)) gl.push({ role: roleOf(doc.doc_type), accountId: counter, debit: '0', credit: mv });
            }
            if (!D.isZero(m.variance)) {
              const adj = requireAccount(masters.accountFor(item, 'adjustment'), item, 'adjustment');
              gl.push(D.isNegative(m.variance) ? { role: 'variance', accountId: adj, debit: '0', credit: D.canonical(D.neg(m.variance)) } : { role: 'variance', accountId: adj, debit: m.variance, credit: '0' });
            }
          }
          lineUpdates.push({ id: l.id, factor: c.factor, baseQty: c.baseQty, value: lineValue, batchId });
          total = D.canonical(D.add(total, lineValue));
          return;
        }

        // ── الخروج (صرف، تسوية عجز، إرسال، وطرف المصدر في التحويل) ──
        const allowNeg = allowNegativeFor(item, c);
        if (allowNeg) negativeUsed.push({ line: l.line_no, item: item.code });
        reservationCheck(item, wh, c.baseQty, c.resId, l.line_no);
        // التخصيص: دفعة محددة، أو FEFO آليًا لصنف الدفعات، أو بلا دفعة
        let allocs;
        if (item.track_batches === 1 && c.batchId == null) {
          allocs = []; let rest = c.baseQty;
          for (const x of fefoCandidates(item, wh, c.locId, date, st)) {
            if (!D.gt(rest, '0')) break;
            const take = D.canonical(D.min(rest, x.free));
            if (D.gt(take, '0')) { allocs.push({ batch: x.batch, qty: take }); rest = D.canonical(D.sub(rest, take)); }
          }
          if (D.gt(rest, '0')) fail(409, 'INSUFFICIENT_STOCK', 'لا توجد دفعات متاحة كافية (حسب FEFO والجودة والصلاحية)', { item: item.code, requested: c.baseQty, missing: rest });
        } else {
          allocs = [{ batch: c.batchId ? batchRow(c.batchId) : null, qty: c.baseQty }];
        }
        for (const a of allocs) {
          outAllowedChecks(c, item, l, a.batch, c.batchId != null);
          const b = st.bal(item.id, wh.id, c.locId, a.batch ? a.batch.id : null);
          if (D.lt(b.qty, a.qty) && !allowNeg) fail(409, 'INSUFFICIENT_STOCK', 'الكمية المطلوبة أكبر من الرصيد في المخزن/الموقع/الدفعة', { item: item.code, batch: a.batch ? a.batch.batch_no : null, available: b.qty, requested: a.qty });
          b.qty = D.canonical(D.sub(b.qty, a.qty));
          const p = st.pool(item.id, wh.id, a.batch ? a.batch.id : null);
          checkPoolDate(p, item);
          const v = takeOut(p, a.qty, item, { allowNegative: allowNeg });
          move({ line: l, pool: p, whId: wh.id, branchId: wh.branch_id, locId: c.locId, batchId: a.batch ? a.batch.id : null, direction: 'out', qty: a.qty, value: v, invAcc, glOn, item, serials: c.serials, qualityStatus: a.batch ? a.batch.status : null });
          lineValue = D.canonical(D.add(lineValue, v));
          if (doc.doc_type === 'transfer') {
            const b2 = st.bal(item.id, toWh.id, c.toLocId, a.batch ? a.batch.id : null);
            b2.qty = D.canonical(D.add(b2.qty, a.qty));
            const p2 = st.pool(item.id, toWh.id, a.batch ? a.batch.id : null);
            checkPoolDate(p2, item);
            const r = putIn(p2, a.qty, v, item);
            if (!D.isZero(r.variance)) fail(409, 'NEGATIVE_DESTINATION', 'رصيد الوجهة سالب؛ سوِّه قبل التحويل إليه', { item: item.code });
            move({ line: l, pool: p2, whId: toWh.id, branchId: toWh.branch_id, locId: c.toLocId, batchId: a.batch ? a.batch.id : null, direction: 'in', qty: a.qty, value: v, invAcc, glOn: false, item, serials: c.serials, qualityStatus: a.batch ? a.batch.status : null });
          } else if (glOn && !D.isZero(v)) {
            const counter = requireAccount(counterFor(item), item, roleOf(doc.doc_type));
            gl.push({ role: 'inventory', accountId: requireAccount(invAcc, item, 'inventory'), debit: '0', credit: v });
            gl.push({ role: roleOf(doc.doc_type), accountId: counter, debit: v, credit: '0' });
          }
        }
        lineUpdates.push({ id: l.id, factor: c.factor, baseQty: c.baseQty, value: lineValue, batchId: allocs.length === 1 && allocs[0].batch ? allocs[0].batch.id : c.batchId });
        total = D.canonical(D.add(total, lineValue));
      });
    }
    // التجاوزات: صلاحية + سبب، وإلا يُرفض الترحيل
    const blocked = needsOverride.filter((x) => !x.override);
    if (blocked.length) fail(409, blocked[0].reasons.includes('FEFO') && blocked[0].reasons.length === 1 ? 'FEFO_VIOLATION' : 'BATCH_NOT_AVAILABLE', 'الدفعة غير متاحة للصرف أو مخالفة لـ FEFO؛ يلزم تجاوز مصرح به بسبب', { issues: blocked });
    if (needsOverride.length) {
      if (!can(ctx, 'inventory.override_fefo')) fail(403, 'OVERRIDE_FORBIDDEN', 'تجاوز FEFO/الجودة يتطلب صلاحية خاصة', { issues: needsOverride });
      if (!doc.override_reason) fail(409, 'OVERRIDE_REASON_REQUIRED', 'سبب التجاوز إلزامي', { issues: needsOverride });
    }
    if (doc.negative_reason && !negativeUsed.length && !['issue', 'adjust_out'].includes(doc.doc_type)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { negativeReason: 'NOT_APPLICABLE' } });
    return { moves, gl: netGl(gl, doc), lineUpdates, qualityOps, reservationOps, total, overrides: needsOverride, negative: negativeUsed.filter(() => moves.some((m) => D.isNegative(m.poolQtyAfter))) };
  }

  /** صافي القيد لكل (حساب، مركز تكلفة)؛ مركز التكلفة للحسابات المقابلة فقط وحسب سياسة الحساب. */
  function netGl(entries, doc) {
    const by = new Map();
    for (const e of entries) {
      const acc = db.prepare('SELECT id, cost_center_policy FROM accounts WHERE id = ?').get(e.accountId);
      const cc = acc.cost_center_policy === 'none' ? null : (acc.cost_center_policy === 'required' || ['counter', 'adjustment', 'variance'].includes(e.role)) ? doc.cost_center_id : null;
      const k = `${e.accountId}|${cc || 0}`;
      const cur = by.get(k) || { role: e.role, accountId: e.accountId, costCenterId: cc, net: '0' };
      if (cur.role !== e.role && cur.role !== 'inventory') cur.role = cur.role === 'variance' ? e.role : cur.role;
      cur.net = D.canonical(D.add(cur.net, D.sub(e.debit, e.credit)));
      by.set(k, cur);
    }
    return [...by.values()].filter((x) => !D.isZero(x.net))
      .map((x) => ({ role: x.role, accountId: x.accountId, costCenterId: x.costCenterId, debit: D.gt(x.net, '0') ? x.net : '0', credit: D.isNegative(x.net) ? D.canonical(D.neg(x.net)) : '0' }));
  }

  function ensureBatch(ctx, item, batchNo, l, preview) {
    const ex = db.prepare('SELECT * FROM inv_batches WHERE item_id = ? AND batch_no = ?').get(item.id, batchNo);
    if (ex) {
      if ((l.production_date && l.production_date !== ex.production_date) || (l.expiry_date && l.expiry_date !== ex.expiry_date)) fail(409, 'BATCH_DATES_MISMATCH', 'الدفعة موجودة بتواريخ مختلفة', { item: item.code, batch: batchNo });
      return ex.id;
    }
    if (item.track_expiry === 1 && !l.expiry_date) fail(409, 'EXPIRY_REQUIRED', 'تاريخ انتهاء الصلاحية إلزامي لهذا الصنف', { item: item.code, batch: batchNo });
    if (l.production_date && l.expiry_date && l.expiry_date < l.production_date) fail(409, 'BATCH_DATES_INVALID', 'تاريخ الانتهاء قبل تاريخ الإنتاج', { batch: batchNo });
    const status = l.to_status || 'available';
    const id = Number(db.prepare('INSERT INTO inv_batches (item_id, batch_no, production_date, expiry_date, status, initial_status, created_by) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(item.id, batchNo, l.production_date, l.expiry_date, status, status, ctx.user.id).lastInsertRowid);
    if (!preview) audit.fromCtx(ctx, { action: 'inventory.batch_created', source: 'inventory', entityType: 'inv_batch', entityId: id, details: { item: item.code, batch: batchNo, expiry: l.expiry_date, status } });
    return id;
  }
  /** قيمة المرتجع بمرجع: نصيبه من قيمة الصرف الأصلي، والأخير يأخذ الباقي بالضبط. */
  function returnValue(l, c, batchId, item) {
    const ref = db.prepare('SELECT x.*, d.doc_type, d.status, d.id doc_id FROM inv_document_lines x JOIN inv_documents d ON d.id = x.doc_id WHERE x.id = ?').get(l.ref_line_id);
    const doc = docRow(l.doc_id);
    if (!ref || ref.doc_type !== 'issue' || ref.status !== 'posted' || ref.item_id !== item.id || (doc.return_of_id && ref.doc_id !== doc.return_of_id)) fail(409, 'RETURN_REFERENCE_INVALID', 'مرجع المرتجع ليس سطر صرف مرحّلًا لنفس الصنف');
    if (db.prepare('SELECT 1 FROM inv_documents WHERE reverses_id = ?').get(ref.doc_id)) fail(409, 'RETURN_REFERENCE_INVALID', 'مستند الصرف الأصلي معكوس');
    const o = db.prepare(`SELECT dec_sum(qty) q, dec_sum(value) v FROM inv_moves WHERE line_id = ? AND direction = 'out' AND batch_id IS ?`).get(ref.id, batchId);
    if (!o.q || o.q === '0') fail(409, 'RETURN_REFERENCE_INVALID', 'الدفعة لم تُصرف في السطر الأصلي');
    const r = db.prepare(`SELECT dec_sum(m.qty) q, dec_sum(m.value) v FROM inv_moves m JOIN inv_document_lines x ON x.id = m.line_id JOIN inv_documents d ON d.id = m.doc_id
      WHERE x.ref_line_id = ? AND d.doc_type = 'return' AND m.direction = 'in' AND m.batch_id IS ? AND NOT EXISTS (SELECT 1 FROM inv_documents rv WHERE rv.reverses_id = d.id)`).get(ref.id, batchId);
    const rq = r.q || '0'; const rv = r.v || '0';
    const remaining = D.sub(o.q, rq);
    if (D.gt(c.baseQty, remaining)) fail(409, 'RETURN_EXCEEDS_ISSUE', 'كمية المرتجع أكبر من المتبقي من الصرف الأصلي', { item: item.code, remaining: D.canonical(remaining), requested: c.baseQty });
    return D.eq(c.baseQty, remaining) ? D.canonical(D.sub(o.v, rv)) : amt(D.div(D.mul(o.v, c.baseQty), o.q));
  }

  // ── التطبيق ──
  function postPerm(ctx, doc) {
    const t = doc.doc_type;
    if (t === 'quality') return;   // صلاحيات الجودة لكل سطر حسب الحالة الجديدة
    if (t === 'transfer_out') return need(ctx, 'inventory_transfers.dispatch');
    need(ctx, 'inventory_documents.post');
    if (t === 'adjust_in' || t === 'adjust_out') need(ctx, 'inventory_adjustments.post');
  }
  function insertMoves(ctx, doc, p) {
    const ins = db.prepare(`INSERT INTO inv_moves (doc_id, line_id, move_date, branch_id, warehouse_id, location_id, item_id, batch_id, direction, qty, value, unit_cost,
      pool_qty_after, pool_value_after, inventory_account_id, quality_status, posts_gl, reverses_move_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const ids = [];
    for (const m of p.moves) {
      const qs = m.qualityStatus ?? (m.batchId ? batchRow(m.batchId).status : null);
      const id = Number(ins.run(doc.id, m.line.id, doc.doc_date, m.branchId, m.whId, m.locId, m.item.id, m.batchId, m.direction, m.qty, m.value, m.unitCost,
        m.poolQtyAfter, m.poolValueAfter, m.invAcc, qs, m.glOn ? 1 : 0, m.reversesMoveId ?? null).lastInsertRowid);
      ids.push(id);
      if (m.serials) moveSerials(m, id);
    }
    return ids;
  }
  function moveSerials(m, moveId) {
    for (const sn of m.serials) {
      const s = db.prepare('SELECT * FROM inv_serials WHERE item_id = ? AND serial_no = ?').get(m.item.id, sn);
      if (m.direction === 'in') {
        if (s && s.state === 'in_stock') fail(409, 'SERIAL_IN_STOCK', 'الرقم المسلسل موجود بالمخزون بالفعل', { item: m.item.code, serial: sn });
        if (s) db.prepare("UPDATE inv_serials SET state = 'in_stock', warehouse_id = ?, location_id = ?, last_move_id = ? WHERE id = ?").run(m.whId, m.locId, moveId, s.id);
        else db.prepare("INSERT INTO inv_serials (item_id, serial_no, state, warehouse_id, location_id, last_move_id) VALUES (?, ?, 'in_stock', ?, ?, ?)").run(m.item.id, sn, m.whId, m.locId, moveId);
      } else {
        if (!s || s.state !== 'in_stock' || s.warehouse_id !== m.whId || (m.locId != null && s.location_id !== m.locId)) fail(409, 'SERIAL_NOT_IN_STOCK', 'الرقم المسلسل غير موجود في هذا المخزن/الموقع', { item: m.item.code, serial: sn });
        db.prepare("UPDATE inv_serials SET state = 'out', warehouse_id = NULL, location_id = NULL, last_move_id = ? WHERE id = ?").run(moveId, s.id);
      }
      const sid = db.prepare('SELECT id FROM inv_serials WHERE item_id = ? AND serial_no = ?').get(m.item.id, sn).id;
      db.prepare('INSERT INTO inv_move_serials (move_id, serial_id) VALUES (?, ?)').run(moveId, sid);
    }
  }
  function postGl(ctx, doc, glLines, description) {
    if (!glLines.length) return null;
    const ins = db.prepare('INSERT INTO inv_gl_lines (doc_id, line_no, role, account_id, cost_center_id, debit, credit) VALUES (?, ?, ?, ?, ?, ?, ?)');
    glLines.forEach((g, i) => ins.run(doc.id, i + 1, g.role, g.accountId, g.costCenterId, g.debit, g.credit));
    const b = base();
    const series = services.numbering.seriesFor('inv_gl');
    const rows = db.prepare('SELECT * FROM inv_gl_lines WHERE doc_id = ? ORDER BY line_no').all(doc.id);
    const r = services.ledger.post(ctx, {
      sourceType: 'inventory', sourceId: doc.id, docType: 'inv_gl', seriesId: series.id, entryKind: 'normal', origin: 'subledger',
      branchId: doc.branch_id, date: doc.doc_date, description, futureDateConfirmed: false,
      lines: rows.map((l) => ({ lineNo: l.line_no, lineId: l.id, accountId: l.account_id, costCenterId: l.cost_center_id, currencyId: b.id, rate: '1', rateSource: 'base',
        rateId: null, debitFc: l.debit, creditFc: l.credit, debit: l.debit, credit: l.credit, description })),
      persist: (res) => db.prepare('UPDATE inv_documents SET gl_number = ?, gl_total = ? WHERE id = ?').run(res.number, res.totalBase, doc.id),
    });
    return r.number;
  }
  function stamp(ctx, doc, total, extra = {}) {
    const period = services.fiscal.assertOpen(doc.doc_date);
    const series = services.numbering.seriesFor(SERIES[doc.doc_type]);
    const num = services.numbering.issue({ seriesId: series.id, docType: SERIES[doc.doc_type], branchId: doc.branch_id, fiscalYearId: period.fiscalYearId, sourceId: doc.id, userId: ctx.user.id });
    db.prepare(`UPDATE inv_documents SET status = 'posted', number = ?, series_id = ?, fiscal_year_id = ?, fiscal_period_id = ?, total_value = ?, posted_by = ?,
      posted_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(num.number, series.id, period.fiscalYearId, period.id, total, ctx.user.id, doc.id);
    Object.assign(doc, { number: num.number, status: 'posted', ...extra });
    return num.number;
  }
  function preflight(ctx, doc) {
    if (doc.doc_date > today()) fail(409, 'FUTURE_DATE', 'تاريخ المستند بعد اليوم', { date: doc.doc_date });
    services.fiscal.assertOpen(doc.doc_date);
    services.ledger.assertDraftable(ctx, doc.branch_id, doc.doc_date);
  }

  /** ترحيل مسودة. opts.internal: من وحدة أخرى (الجرد/التحويل) بعد تحققها من صلاحياتها. */
  function post(ctx, id, body = {}, opts = {}) {
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'post');
      if (prior) return prior;
      const doc = getVisibleDoc(ctx, id);
      if (doc.status === 'posted') fail(409, 'ALREADY_POSTED', 'المستند مرحّل من قبل', { number: doc.number });
      if (doc.status !== 'draft') fail(409, 'NOT_DRAFT', 'المستند ليس مسودة');
      if (doc.source_module === 'counts' && !opts.internal) fail(409, 'SOURCE_LOCKED', 'مستند جرد؛ يُرحَّل من جلسة الجرد');
      if (!opts.internal) {
        postPerm(ctx, doc);
        if (masters.settingsRow().require_approval === 1 && !doc.approved_by) fail(409, 'APPROVAL_REQUIRED', 'المستند يتطلب اعتمادًا قبل الترحيل');
      }
      assertDocWarehouses(ctx, doc);
      preflight(ctx, doc);
      const p = plan(ctx, doc, opts);
      for (const u of p.lineUpdates) db.prepare('UPDATE inv_document_lines SET factor = ?, base_qty = ?, value = ?, batch_id = ?, from_status = ? WHERE id = ?').run(u.factor, u.baseQty, u.value, u.batchId ?? null, u.fromStatus ?? null, u.id);
      const number = stamp(ctx, doc, p.total);
      const moveIds = insertMoves(ctx, doc, p);
      for (const r of p.reservationOps) consumeReservation(ctx, r.id, r.qty);
      for (const q of p.qualityOps) db.prepare('UPDATE inv_batches SET status = ? WHERE id = ?').run(q.to, q.batchId);
      if (doc.doc_type === 'transfer_out') createTransfer(doc, moveIds);
      if (opts.afterMoves) opts.afterMoves(doc, moveIds, p);
      const glNumber = postGl(ctx, doc, p.gl, `مستند مخزني ${number}`);
      audit.fromCtx(ctx, { action: 'inventory.document_posted', source: 'inventory', entityType: 'inv_document', entityId: id, details: {
        number, type: doc.doc_type, date: doc.doc_date, total: p.total, glNumber, moves: p.moves.length,
        ...(p.overrides.length ? { overrideReason: doc.override_reason, overrides: p.overrides } : {}),
        ...(p.negative.length ? { negativeReason: doc.negative_reason, negative: p.negative } : {}),
        ...(p.qualityOps.length ? { quality: p.qualityOps } : {}) } });
      const result = { id, number, glNumber, total: p.total };
      remember(ctx, body.idempotencyKey, 'post', result);
      return result;
    });
  }
  /** معاينة الترحيل: نفس التخطيط بالضبط داخل معاملة تُلغى (لا رقم ولا حركة ولا دفعة تبقى). */
  function preview(ctx, id) {
    const doc0 = getVisibleDoc(ctx, id);
    if (doc0.status !== 'draft') fail(409, 'NOT_DRAFT', 'المستند ليس مسودة');
    const marker = {};
    try {
      inTransaction(db, () => {
        const doc = docRow(id);
        assertDocWarehouses(ctx, doc);
        preflight(ctx, doc);
        const p = plan(ctx, doc, { preview: true });
        marker.result = {
          total: p.total, overrides: p.overrides,
          moves: p.moves.map((m) => ({ line: m.line.line_no, itemId: m.item.id, item: m.item.code, warehouseId: m.whId, locationId: m.locId, batchId: m.batchId,
            batchNo: m.batchId ? batchRow(m.batchId).batch_no : null, direction: m.direction, qty: m.qty, value: m.value, unitCost: m.unitCost, poolQtyAfter: m.poolQtyAfter, poolValueAfter: m.poolValueAfter })),
          gl: p.gl.map((g) => ({ ...g, account: db.prepare('SELECT code, name_ar nameAr, name_en nameEn FROM accounts WHERE id = ?').get(g.accountId) })),
        };
        throw marker;
      });
    } catch (e) { if (e !== marker) throw e; }
    return marker.result;
  }

  // ── الحجوزات المستهلكة بالصرف ──
  function consumeReservation(ctx, resId, qty) {
    const r = db.prepare('SELECT * FROM inv_reservations WHERE id = ?').get(resId);
    const consumed = D.canonical(D.add(r.consumed_qty, qty));
    const status = D.gte(consumed, r.qty) ? 'consumed' : 'active';
    db.prepare('UPDATE inv_reservations SET consumed_qty = ?, status = ?, closed_by = CASE WHEN ? = \'consumed\' THEN ? ELSE closed_by END, closed_at = CASE WHEN ? = \'consumed\' THEN strftime(\'%Y-%m-%dT%H:%M:%fZ\',\'now\') ELSE closed_at END WHERE id = ?')
      .run(consumed, status, status, ctx.user.id, status, resId);
    audit.fromCtx(ctx, { action: 'inventory.reservation_consumed', source: 'inventory', entityType: 'inv_reservation', entityId: resId, details: { qty, consumed, status } });
  }

  // ── التحويل بين الفروع ──
  function createTransfer(doc, moveIds) {
    const to = db.prepare('SELECT * FROM inv_warehouses WHERE id = ?').get(doc.to_warehouse_id);
    const tid = Number(db.prepare('INSERT INTO inv_transfers (dispatch_doc_id, from_warehouse_id, to_warehouse_id, from_branch_id, to_branch_id) VALUES (?, ?, ?, ?, ?)')
      .run(doc.id, doc.warehouse_id, to.id, doc.branch_id, to.branch_id).lastInsertRowid);
    for (const mid of moveIds) {
      const m = db.prepare('SELECT * FROM inv_moves WHERE id = ?').get(mid);
      db.prepare('INSERT INTO inv_transfer_lines (transfer_id, dispatch_move_id, item_id, batch_id, qty_sent, value_sent) VALUES (?, ?, ?, ?, ?, ?)').run(tid, mid, m.item_id, m.batch_id, m.qty, m.value);
    }
    return tid;
  }

  // ── العكس ──
  function reverse(ctx, id, body = {}) {
    need(ctx, 'inventory_documents.reverse');
    const d = validator(body).str('reason', { required: true, min: 3, max: 500, multiline: true }).str('date', { pattern: DATE_RE }).done();
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'reverse');
      if (prior) return prior;
      const o = getVisibleDoc(ctx, id);
      if (o.status !== 'posted') fail(409, 'NOT_POSTED', 'المستند غير مرحّل');
      if (o.doc_type === 'reversal') fail(409, 'CANNOT_REVERSE_REVERSAL', 'لا يُعكس مستند عكس');
      const already = db.prepare('SELECT number FROM inv_documents WHERE reverses_id = ?').get(id);
      if (already) fail(409, 'ALREADY_REVERSED', 'المستند معكوس من قبل', { reversal: already.number });
      const date = d.date || (today() > o.doc_date ? today() : o.doc_date);
      if (date < o.doc_date) fail(409, 'REVERSAL_DATE', 'تاريخ العكس لا يسبق تاريخ المستند الأصلي', { original: o.doc_date });
      whAccess.assertWarehouse(ctx, o.warehouse_id);
      if (o.to_warehouse_id) whAccess.assertWarehouse(ctx, o.to_warehouse_id);
      ctx.access.assertBranch(o.branch_id);
      let transfer = null;
      if (o.doc_type === 'transfer_out') {
        transfer = db.prepare('SELECT * FROM inv_transfers WHERE dispatch_doc_id = ?').get(o.id);
        if (transfer.status !== 'in_transit') fail(409, 'TRANSFER_HAS_RECEIPTS', 'للتحويل استلامات أو تسويات؛ اعكسها أولًا');
      }
      if (o.doc_type === 'transfer_in') {
        transfer = db.prepare('SELECT * FROM inv_transfers WHERE id = ?').get(o.transfer_id);
        if (transfer.status === 'closed') fail(409, 'TRANSFER_CLOSED', 'التحويل مُغلق؛ لا يُعكس استلامه');
      }
      const rid = Number(db.prepare(`INSERT INTO inv_documents (doc_type, branch_id, warehouse_id, doc_date, source_module, reason, reverses_id, created_by, updated_by)
        VALUES ('reversal', ?, ?, ?, ?, ?, ?, ?, ?)`).run(o.branch_id, o.warehouse_id, date, o.source_module, d.reason, o.id, ctx.user.id, ctx.user.id).lastInsertRowid);
      const lineMap = new Map();
      for (const l of linesOf(o.id)) {
        const nid = Number(db.prepare(`INSERT INTO inv_document_lines (doc_id, line_no, item_id, unit_id, qty, factor, base_qty, unit_cost, value, location_id, to_location_id, batch_id,
          to_status, from_status, ref_line_id, qty_rejected, serials) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(rid, l.line_no, l.item_id, l.unit_id, l.qty, l.factor, l.base_qty, l.unit_cost, l.value, l.location_id, l.to_location_id, l.batch_id, l.from_status, l.to_status, l.id, l.qty_rejected, l.serials).lastInsertRowid);
        lineMap.set(l.id, nid);
      }
      const rdoc = docRow(rid);
      preflight(ctx, rdoc);
      // الحركات: مرآة كل حركة أصلية بالترتيب العكسي، بنفس الكمية والقيمة
      const st = makeState();
      const moves = [];
      for (const m of db.prepare('SELECT * FROM inv_moves WHERE doc_id = ? ORDER BY id DESC').all(o.id)) {
        const item = itemRow(m.item_id);
        if (frozenBy(m.warehouse_id, m.item_id, null)) fail(409, 'COUNT_IN_PROGRESS', 'جرد مجمّد على المخزن لهذا الصنف', { item: item.code });
        const p = st.pool(m.item_id, m.warehouse_id, m.batch_id);
        if (p.lastDate && date < p.lastDate) fail(409, 'BACKDATED_MOVEMENT', 'لا ترحيل بتاريخ أقدم من آخر حركة على الصنف في هذا المخزن', { item: item.code, lastMovementDate: p.lastDate, date });
        const dir = m.direction === 'in' ? 'out' : 'in';
        if (dir === 'out') {
          const b = st.bal(m.item_id, m.warehouse_id, m.location_id, m.batch_id);
          if (D.lt(b.qty, m.qty)) fail(409, 'INSUFFICIENT_STOCK', 'لا يكفي الرصيد لعكس الإضافة (صُرف جزء منها)؛ اعكس الصرف أولًا', { item: item.code, available: b.qty, requested: m.qty });
          b.qty = D.canonical(D.sub(b.qty, m.qty));
          p.qty = D.canonical(D.sub(p.qty, m.qty)); p.value = D.canonical(D.sub(p.value, m.value));
        } else {
          const b = st.bal(m.item_id, m.warehouse_id, m.location_id, m.batch_id);
          b.qty = D.canonical(D.add(b.qty, m.qty));
          p.qty = D.canonical(D.add(p.qty, m.qty)); p.value = D.canonical(D.add(p.value, m.value));
        }
        if (D.isNegative(p.qty) || D.isNegative(p.value) || (D.isZero(p.qty) && !D.isZero(p.value))) fail(409, 'REVERSAL_COST_CONFLICT', 'العكس يترك تكلفة سالبة أو قيمة بلا كمية؛ اعكس الحركات اللاحقة على الصنف أولًا', { item: item.code, qty: p.qty, value: p.value });
        const serials = db.prepare('SELECT s.serial_no FROM inv_move_serials x JOIN inv_serials s ON s.id = x.serial_id WHERE x.move_id = ?').all(m.id).map((r) => r.serial_no);
        moves.push({ line: { id: lineMap.get(m.line_id) }, pool: p, whId: m.warehouse_id, branchId: m.branch_id, locId: m.location_id, batchId: m.batch_id, direction: dir, qty: m.qty,
          value: m.value, unitCost: m.unit_cost, poolQtyAfter: p.qty, poolValueAfter: p.value, invAcc: m.inventory_account_id, glOn: m.posts_gl === 1, item, reversesMoveId: m.id,
          serials: serials.length ? serials : null, qualityStatus: m.quality_status });
      }
      // الجودة: إعادة الحالة السابقة إن لم تتغير بعدها
      const qualityOps = [];
      if (o.doc_type === 'quality') {
        for (const l of linesOf(o.id)) {
          const b = batchRow(l.batch_id);
          if (b.status !== l.to_status) fail(409, 'QUALITY_CHANGED_SINCE', 'تغيرت حالة الدفعة بعد هذا المستند؛ اعكس اللاحق أولًا', { batch: b.batch_no });
          qualityOps.push({ batchId: b.id, to: l.from_status });
        }
      }
      const number = stamp(ctx, rdoc, o.total_value);
      insertMoves(ctx, rdoc, { moves });
      for (const q of qualityOps) db.prepare('UPDATE inv_batches SET status = ? WHERE id = ?').run(q.to, q.batchId);
      // الحجوزات المستهلكة تعود
      for (const l of linesOf(o.id).filter((x) => x.reservation_id)) {
        const used = db.prepare('SELECT dec_sum(qty) q FROM inv_moves WHERE line_id = ?').get(l.id).q || '0';
        const r = db.prepare('SELECT * FROM inv_reservations WHERE id = ?').get(l.reservation_id);
        const back = D.min(used, r.consumed_qty);
        db.prepare("UPDATE inv_reservations SET consumed_qty = ?, status = CASE WHEN status = 'consumed' THEN 'active' ELSE status END, closed_by = NULL, closed_at = NULL WHERE id = ?")
          .run(D.canonical(D.sub(r.consumed_qty, back)), r.id);
      }
      if (o.doc_type === 'transfer_out') db.prepare("UPDATE inv_transfers SET status = 'cancelled' WHERE id = ?").run(transfer.id);
      if (o.doc_type === 'transfer_in') unreceive(o);
      const glLines = db.prepare('SELECT * FROM inv_gl_lines WHERE doc_id = ? ORDER BY line_no').all(o.id)
        .map((g) => ({ role: g.role, accountId: g.account_id, costCenterId: g.cost_center_id, debit: g.credit, credit: g.debit }));
      const glNumber = postGl(ctx, rdoc, glLines, `عكس مستند مخزني ${o.number}`);
      audit.fromCtx(ctx, { action: 'inventory.document_reversed', source: 'inventory', entityType: 'inv_document', entityId: o.id, details: { original: o.number, reversal: number, reason: d.reason, date, glNumber } });
      const result = { id: rid, number, glNumber, reverses: o.number };
      remember(ctx, body.idempotencyKey, 'reverse', result);
      return result;
    });
  }
  function unreceive(o) {
    for (const l of linesOf(o.id)) {
      if (!l.transfer_line_id) continue;
      const tl = db.prepare('SELECT * FROM inv_transfer_lines WHERE id = ?').get(l.transfer_line_id);
      const accV = db.prepare("SELECT dec_sum(value) v FROM inv_moves WHERE line_id = ? AND warehouse_id = ?").get(l.id, o.warehouse_id).v || '0';
      const rejV = D.canonical(D.sub(db.prepare('SELECT dec_sum(value) v FROM inv_moves WHERE line_id = ?').get(l.id).v || '0', accV));
      db.prepare('UPDATE inv_transfer_lines SET qty_received = ?, value_received = ?, qty_rejected = ?, value_rejected = ? WHERE id = ?')
        .run(D.canonical(D.sub(tl.qty_received, l.base_qty)), D.canonical(D.sub(tl.value_received, accV)), D.canonical(D.sub(tl.qty_rejected, l.qty_rejected)), D.canonical(D.sub(tl.value_rejected, rejV)), tl.id);
    }
    refreshTransfer(o.transfer_id);
  }
  function refreshTransfer(tid) {
    const t = db.prepare('SELECT * FROM inv_transfers WHERE id = ?').get(tid);
    if (t.status === 'closed' || t.status === 'cancelled') return;
    const ls = db.prepare('SELECT * FROM inv_transfer_lines WHERE transfer_id = ?').all(tid);
    const done = ls.every((l) => D.eq(D.add(D.add(l.qty_received, l.qty_rejected), l.qty_short), l.qty_sent));
    const any = ls.some((l) => !D.isZero(l.qty_received) || !D.isZero(l.qty_rejected));
    db.prepare('UPDATE inv_transfers SET status = ? WHERE id = ?').run(done ? 'received' : any ? 'partial' : 'in_transit', tid);
  }

  /** استلام تحويل بين الفروع (كلي أو جزئي، مع المرفوض إلى مخزن حجر في فرع الوجهة). */
  function receive(ctx, transferId, body) {
    need(ctx, 'inventory_transfers.receive');
    const d = validator(body).str('date', { required: true, pattern: DATE_RE }).id('rejectWarehouseId').str('notes', { max: 1000, multiline: true }).done();
    if (!Array.isArray(body.lines) || !body.lines.length || body.lines.length > 500) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { lines: 'INVALID' } });
    const lines = body.lines.map((l, i) => atLine(i + 1, () => validator(l).id('transferLineId', { required: true }).decimal('qty').decimal('qtyRejected').id('locationId').done()));
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'receive');
      if (prior) return prior;
      const t = db.prepare('SELECT * FROM inv_transfers WHERE id = ?').get(transferId);
      if (!t) fail(404, 'NOT_FOUND', 'التحويل غير موجود');
      const to = whAccess.assertWarehouse(ctx, t.to_warehouse_id, { active: true });
      ctx.access.assertBranch(to.branch_id);
      if (!['in_transit', 'partial'].includes(t.status)) fail(409, 'TRANSFER_NOT_OPEN', 'التحويل ليس بالطريق');
      const dispatch = docRow(t.dispatch_doc_id);
      if (d.date < dispatch.doc_date) fail(409, 'RECEIPT_BEFORE_DISPATCH', 'تاريخ الاستلام قبل تاريخ الإرسال', { dispatched: dispatch.doc_date });
      let rejectWh = null;
      const id = Number(db.prepare(`INSERT INTO inv_documents (doc_type, branch_id, warehouse_id, doc_date, notes, transfer_id, external_ref, created_by, updated_by)
        VALUES ('transfer_in', ?, ?, ?, ?, ?, ?, ?, ?)`).run(to.branch_id, to.id, d.date, d.notes ?? null, t.id, dispatch.number, ctx.user.id, ctx.user.id).lastInsertRowid);
      const seen = new Set();
      const values = new Map();
      lines.forEach((l, i) => atLine(i + 1, () => {
        const tl = db.prepare('SELECT * FROM inv_transfer_lines WHERE id = ? AND transfer_id = ?').get(l.transferLineId, t.id);
        if (!tl) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { transferLineId: 'NOT_FOUND' } });
        if (seen.has(tl.id)) fail(409, 'DUPLICATE_LINE', 'سطر التحويل مكرر في الاستلام');
        seen.add(tl.id);
        const qa = l.qty != null ? decimalIn(l.qty, 'quantity', 'qty') : '0';
        const qr = l.qtyRejected != null ? decimalIn(l.qtyRejected, 'quantity', 'qtyRejected') : '0';
        const part = D.canonical(D.add(qa, qr));
        if (D.isZero(part)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { qty: 'MUST_BE_POSITIVE' } });
        const remQ = D.sub(D.sub(D.sub(tl.qty_sent, tl.qty_received), tl.qty_rejected), tl.qty_short);
        const remV = D.sub(D.sub(D.sub(tl.value_sent, tl.value_received), tl.value_rejected), tl.value_short);
        if (D.gt(part, remQ)) fail(409, 'RECEIPT_EXCEEDS_TRANSIT', 'الكمية أكبر من المتبقي بالطريق', { remaining: D.canonical(remQ), requested: part });
        const vp = D.eq(part, remQ) ? D.canonical(remV) : amt(D.div(D.mul(tl.value_sent, part), tl.qty_sent));
        const vr = D.isZero(qr) ? '0' : D.isZero(qa) ? vp : amt(D.div(D.mul(vp, qr), part));
        const va = D.canonical(D.sub(vp, vr));
        if (!D.isZero(qr) && !rejectWh) {
          if (d.rejectWarehouseId == null) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { rejectWarehouseId: 'REQUIRED' } });
          rejectWh = whAccess.assertWarehouse(ctx, d.rejectWarehouseId, { active: true, field: 'rejectWarehouseId' });
          if (rejectWh.branch_id !== to.branch_id || rejectWh.wh_type !== 'quarantine') fail(409, 'REJECT_WAREHOUSE', 'المرفوض يذهب إلى مخزن حجر في فرع الاستلام');
        }
        const item = itemRow(tl.item_id);
        db.prepare(`INSERT INTO inv_document_lines (doc_id, line_no, item_id, unit_id, qty, factor, base_qty, location_id, batch_id, transfer_line_id, qty_rejected, value)
          VALUES (?, ?, ?, ?, ?, '1', ?, ?, ?, ?, ?, ?)`).run(id, i + 1, item.id, item.base_unit_id, qa, qa, l.locationId ?? null, tl.batch_id, tl.id, qr, vp);
        values.set(i + 1, { va, vr, tl, qa, qr, vp });
      }));
      const doc = docRow(id);
      preflight(ctx, doc);
      // سطور الاستلام تحمل قيمها المحسوبة للتخطيط
      const enriched = linesOf(id).map((l) => ({ ...l, value: values.get(l.line_no).vp, accepted_value: values.get(l.line_no).va, rejected_value: values.get(l.line_no).vr }));
      const p = withLines(enriched, () => plan(ctx, doc, { internal: true, rejectWarehouse: rejectWh }));
      const number = stamp(ctx, doc, p.total);
      insertMoves(ctx, doc, p);
      for (const [, v] of values) {
        db.prepare('UPDATE inv_transfer_lines SET qty_received = ?, value_received = ?, qty_rejected = ?, value_rejected = ? WHERE id = ?')
          .run(D.canonical(D.add(v.tl.qty_received, v.qa)), D.canonical(D.add(v.tl.value_received, v.va)), D.canonical(D.add(v.tl.qty_rejected, v.qr)), D.canonical(D.add(v.tl.value_rejected, v.vr)), v.tl.id);
      }
      refreshTransfer(t.id);
      const glNumber = postGl(ctx, doc, p.gl, `استلام تحويل ${dispatch.number}`);
      audit.fromCtx(ctx, { action: 'inventory.transfer_received', source: 'inventory', entityType: 'inv_transfer', entityId: t.id, details: { dispatch: dispatch.number, receipt: number, total: p.total, glNumber } });
      const result = { id, number, glNumber, transferId: t.id, status: db.prepare('SELECT status FROM inv_transfers WHERE id = ?').get(t.id).status };
      remember(ctx, body.idempotencyKey, 'receive', result);
      return result;
    });
  }
  // التخطيط يقرأ السطور من القاعدة؛ للاستلام نمرر سطورًا مثرية بالقيم المحسوبة
  let lineOverride = null;
  function withLines(lines, fn) { lineOverride = lines; try { return fn(); } finally { lineOverride = null; } }

  /** إغلاق تحويل بفرق موثق: المتبقي بالطريق عجز (مدين حساب الفروق، دائن مخزون بالطريق) في فرع الاستلام. */
  function closeTransfer(ctx, transferId, body) {
    need(ctx, 'inventory_transfers.receive');
    const d = validator(body).str('reason', { required: true, min: 3, max: 500, multiline: true }).str('date', { required: true, pattern: DATE_RE }).done();
    return inTransaction(db, () => {
      const prior = replay(ctx, body.idempotencyKey, 'close_transfer');
      if (prior) return prior;
      const t = db.prepare('SELECT * FROM inv_transfers WHERE id = ?').get(transferId);
      if (!t) fail(404, 'NOT_FOUND', 'التحويل غير موجود');
      const to = whAccess.assertWarehouse(ctx, t.to_warehouse_id);
      ctx.access.assertBranch(to.branch_id);
      if (!['in_transit', 'partial'].includes(t.status)) fail(409, 'TRANSFER_NOT_OPEN', 'التحويل ليس بالطريق');
      const dispatch = docRow(t.dispatch_doc_id);
      if (d.date < dispatch.doc_date) fail(409, 'RECEIPT_BEFORE_DISPATCH', 'التاريخ قبل تاريخ الإرسال');
      const id = Number(db.prepare(`INSERT INTO inv_documents (doc_type, branch_id, warehouse_id, doc_date, reason, transfer_id, external_ref, created_by, updated_by)
        VALUES ('transfer_in', ?, ?, ?, ?, ?, ?, ?, ?)`).run(to.branch_id, to.id, d.date, d.reason, t.id, dispatch.number, ctx.user.id, ctx.user.id).lastInsertRowid);
      const gl = []; let total = '0'; let n = 0;
      const short = [];
      for (const tl of db.prepare('SELECT * FROM inv_transfer_lines WHERE transfer_id = ?').all(t.id)) {
        const remQ = D.canonical(D.sub(D.sub(D.sub(tl.qty_sent, tl.qty_received), tl.qty_rejected), tl.qty_short));
        const remV = D.canonical(D.sub(D.sub(D.sub(tl.value_sent, tl.value_received), tl.value_rejected), tl.value_short));
        if (D.isZero(remQ) && D.isZero(remV)) continue;
        const item = itemRow(tl.item_id);
        n += 1;
        db.prepare(`INSERT INTO inv_document_lines (doc_id, line_no, item_id, unit_id, qty, factor, base_qty, batch_id, transfer_line_id, value, notes) VALUES (?, ?, ?, ?, '0', '1', '0', ?, ?, ?, 'shortage')`)
          .run(id, n, item.id, item.base_unit_id, tl.batch_id, tl.id, remV);
        short.push({ tl, remQ, remV });
        if (!D.isZero(remV)) {
          gl.push({ role: 'adjustment', accountId: requireAcc(masters.accountFor(item, 'adjustment'), item, 'adjustment'), debit: remV, credit: '0' });
          gl.push({ role: 'transit', accountId: requireAcc(masters.transitAccount(), item, 'transit'), debit: '0', credit: remV });
        }
        total = D.canonical(D.add(total, remV));
      }
      if (!n) fail(409, 'NOTHING_IN_TRANSIT', 'لا يوجد متبقٍ بالطريق');
      const doc = docRow(id);
      preflight(ctx, doc);
      const number = stamp(ctx, doc, total);
      for (const s of short) db.prepare('UPDATE inv_transfer_lines SET qty_short = ?, value_short = ? WHERE id = ?').run(D.canonical(D.add(s.tl.qty_short, s.remQ)), D.canonical(D.add(s.tl.value_short, s.remV)), s.tl.id);
      db.prepare("UPDATE inv_transfers SET status = 'closed', closed_by = ?, closed_at = strftime('%Y-%m-%dT%H:%M:%fZ','now'), close_reason = ? WHERE id = ?").run(ctx.user.id, d.reason, t.id);
      const glNumber = postGl(ctx, doc, netGl(gl, doc), `إغلاق تحويل ${dispatch.number} بعجز`);
      audit.fromCtx(ctx, { action: 'inventory.transfer_closed', source: 'inventory', entityType: 'inv_transfer', entityId: t.id, details: { dispatch: dispatch.number, document: number, shortValue: total, reason: d.reason, glNumber } });
      const result = { id, number, glNumber, transferId: t.id, shortValue: total };
      remember(ctx, body.idempotencyKey, 'close_transfer', result);
      return result;
    });
  }
  function requireAcc(id, item, role) { if (!id) fail(409, 'ACCOUNTING_SETTINGS_MISSING', 'إعدادات الربط المحاسبي ناقصة لهذه الحركة', { item: item.code, role }); return id; }

  // ── القراءة ──
  function visibleDoc(ctx, d) {
    if (!d || !ctx.access.branchAllowed(d.branch_id)) return false;
    if (d.warehouse_id && !whAccess.allowed(ctx, { id: d.warehouse_id, branch_id: d.branch_id })) {
      return d.to_warehouse_id ? whAccess.allowed(ctx, db.prepare('SELECT id, branch_id FROM inv_warehouses WHERE id = ?').get(d.to_warehouse_id)) : false;
    }
    return true;
  }
  function getVisibleDoc(ctx, id) {
    const d = docRow(id);
    if (!visibleDoc(ctx, d)) fail(404, 'NOT_FOUND', 'المستند غير موجود');
    return d;
  }
  const whBrief = (id) => (id ? db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn, branch_id branchId, wh_type whType FROM inv_warehouses WHERE id = ?').get(id) : null);
  function get(ctx, id) {
    const d = getVisibleDoc(ctx, id);
    const lines = linesOf(id).map((l) => {
      const it = itemRow(l.item_id); const u = db.prepare('SELECT code, name_ar, name_en FROM units WHERE id = ?').get(l.unit_id);
      const b = l.batch_id ? batchRow(l.batch_id) : null;
      return { id: l.id, lineNo: l.line_no, itemId: l.item_id, itemCode: it.code, itemNameAr: it.name_ar, itemNameEn: it.name_en, unitId: l.unit_id, unitCode: u.code,
        qty: l.qty, factor: l.factor, baseQty: l.base_qty, unitCost: l.unit_cost, value: l.value, locationId: l.location_id, toLocationId: l.to_location_id,
        batchId: l.batch_id, batchNo: b ? b.batch_no : l.batch_no, productionDate: b ? b.production_date : l.production_date, expiryDate: b ? b.expiry_date : l.expiry_date,
        toStatus: l.to_status, fromStatus: l.from_status, reservationId: l.reservation_id, refLineId: l.ref_line_id, transferLineId: l.transfer_line_id,
        qtyRejected: l.qty_rejected, serials: l.serials ? JSON.parse(l.serials) : null, overrideFefo: l.override_fefo === 1, notes: l.notes };
    });
    const moves = db.prepare(`SELECT m.*, b.batch_no, w.code wh_code FROM inv_moves m LEFT JOIN inv_batches b ON b.id = m.batch_id JOIN inv_warehouses w ON w.id = m.warehouse_id WHERE m.doc_id = ? ORDER BY m.id`).all(id)
      .map((m) => ({ id: m.id, lineId: m.line_id, warehouseId: m.warehouse_id, warehouseCode: m.wh_code, locationId: m.location_id, itemId: m.item_id, batchId: m.batch_id, batchNo: m.batch_no,
        direction: m.direction, qty: m.qty, value: m.value, unitCost: m.unit_cost, poolQtyAfter: m.pool_qty_after, poolValueAfter: m.pool_value_after }));
    const gl = db.prepare('SELECT g.*, a.code, a.name_ar, a.name_en FROM inv_gl_lines g JOIN accounts a ON a.id = g.account_id WHERE g.doc_id = ? ORDER BY g.line_no').all(id)
      .map((g) => ({ lineNo: g.line_no, role: g.role, accountId: g.account_id, accountCode: g.code, accountNameAr: g.name_ar, accountNameEn: g.name_en, costCenterId: g.cost_center_id, debit: g.debit, credit: g.credit }));
    const reversal = db.prepare('SELECT id, number FROM inv_documents WHERE reverses_id = ?').get(id) || null;
    const user = (uid) => (uid ? db.prepare('SELECT username FROM users WHERE id = ?').get(uid)?.username : null);
    const transfer = d.doc_type === 'transfer_out' ? db.prepare('SELECT id, status FROM inv_transfers WHERE dispatch_doc_id = ?').get(id) : d.transfer_id ? db.prepare('SELECT id, status FROM inv_transfers WHERE id = ?').get(d.transfer_id) : null;
    return {
      id: d.id, docType: d.doc_type, status: d.status, number: d.number, branchId: d.branch_id, warehouse: whBrief(d.warehouse_id), toWarehouse: whBrief(d.to_warehouse_id),
      docDate: d.doc_date, sourceModule: d.source_module, externalRef: d.external_ref, reason: d.reason, notes: d.notes, counterAccountId: d.counter_account_id, costCenterId: d.cost_center_id,
      returnOfId: d.return_of_id, countId: d.count_id, transfer, overrideReason: d.override_reason, negativeReason: d.negative_reason, totalValue: d.total_value,
      glNumber: d.gl_number, glTotal: d.gl_total, reverses: d.reverses_id ? { id: d.reverses_id, number: docRow(d.reverses_id).number } : null, reversedBy: reversal,
      createdBy: user(d.created_by), createdAt: d.created_at, approvedBy: user(d.approved_by), approvedAt: d.approved_at, postedBy: user(d.posted_by), postedAt: d.posted_at,
      lines, moves, gl, baseCurrency: base().code,
    };
  }
  function list(ctx, q = {}) {
    const w = []; const p = [];
    const bf = ctx.access.sqlFilter('d.branch_id'); w.push(bf.sql); p.push(...bf.params);
    const wf = whAccess.sqlFilter(ctx, 'd.warehouse_id'); w.push(`(${wf.sql} OR d.warehouse_id IS NULL)`); p.push(...wf.params);
    if (q.status && ['draft', 'posted', 'cancelled'].includes(q.status)) { w.push('d.status = ?'); p.push(q.status); }
    if (q.docType && [...MANUAL_TYPES, 'transfer_in', 'reversal'].includes(q.docType)) { w.push('d.doc_type = ?'); p.push(q.docType); }
    if (/^\d{1,15}$/.test(q.warehouseId || '')) { w.push('(d.warehouse_id = ? OR d.to_warehouse_id = ?)'); p.push(Number(q.warehouseId), Number(q.warehouseId)); }
    if (DATE_RE.test(q.from || '')) { w.push('d.doc_date >= ?'); p.push(q.from); }
    if (DATE_RE.test(q.to || '')) { w.push('d.doc_date <= ?'); p.push(q.to); }
    if (q.q) { w.push("(d.number LIKE ? ESCAPE '\\' OR d.external_ref LIKE ? ESCAPE '\\' OR d.gl_number LIKE ? ESCAPE '\\')"); const s = '%' + String(q.q).slice(0, 60).replace(/[\\%_]/g, '\\$&') + '%'; p.push(s, s, s); }
    const limit = /^\d{1,4}$/.test(q.limit || '') ? Math.min(Number(q.limit), 500) : 100;
    const offset = /^\d{1,7}$/.test(q.offset || '') ? Number(q.offset) : 0;
    const where = w.join(' AND ');
    const total = db.prepare(`SELECT count(*) c FROM inv_documents d WHERE ${where}`).get(...p).c;
    const rows = db.prepare(`SELECT d.*, w.code wh_code, t.code to_code FROM inv_documents d LEFT JOIN inv_warehouses w ON w.id = d.warehouse_id LEFT JOIN inv_warehouses t ON t.id = d.to_warehouse_id
      WHERE ${where} ORDER BY d.doc_date DESC, d.id DESC LIMIT ? OFFSET ?`).all(...p, limit, offset);
    return { total, limit, offset, items: rows.map((d) => ({ id: d.id, docType: d.doc_type, status: d.status, number: d.number, docDate: d.doc_date, warehouseCode: d.wh_code, toWarehouseCode: d.to_code,
      totalValue: d.total_value, glNumber: d.gl_number, externalRef: d.external_ref, sourceModule: d.source_module, reversed: !!db.prepare('SELECT 1 FROM inv_documents WHERE reverses_id = ?').get(d.id) })) };
  }

  /**
   * التحقق من الملخصات: إعادة حساب كل رصيد ومجمع من سجل الحركات ومقارنته بالمخزن، وتطابق الأستاذ مع سطور قيود المخزون.
   * كشف لا منع؛ rebuild() يعيد البناء من السجل (صيانة مضبوطة بصلاحية وتدقيق).
   */
  function verify() {
    const problems = [];
    // التجميع داخل SQLite (dec_sum دقيق) بدل المرور على كل حركة في JavaScript
    const SQ = "CASE direction WHEN 'in' THEN qty ELSE '-' || qty END";
    const SV = "CASE WHEN direction = 'in' OR value = '0' THEN value ELSE '-' || value END";
    const calcB = new Map(db.prepare(`SELECT item_id, warehouse_id, ifnull(location_id, 0) l, ifnull(batch_id, 0) b, dec_sum(${SQ}) q FROM inv_moves GROUP BY 1, 2, 3, 4`).all()
      .map((r) => [`${r.item_id}|${r.warehouse_id}|${r.l}|${r.b}`, r.q]));
    const calcP = new Map(db.prepare(`SELECT item_id, warehouse_id, ifnull(batch_id, 0) b, dec_sum(${SQ}) q, dec_sum(${SV}) v FROM inv_moves GROUP BY 1, 2, 3`).all()
      .map((r) => [`${r.item_id}|${r.warehouse_id}|${r.b}`, { q: r.q, v: r.v }]));
    const stored = new Map(db.prepare('SELECT * FROM inv_balances').all().map((b) => [`${b.item_id}|${b.warehouse_id}|${b.loc_key}|${b.batch_key}`, b.qty]));
    for (const [k, q] of calcB) if (stored.get(k) !== q) problems.push({ type: 'BALANCE_MISMATCH', key: k, fromMoves: q, stored: stored.get(k) ?? null });
    for (const [k, q] of stored) if (!calcB.has(k)) problems.push({ type: 'BALANCE_WITHOUT_MOVES', key: k, stored: q });
    const storedP = new Map(db.prepare('SELECT * FROM inv_pools').all().map((b) => [`${b.item_id}|${b.warehouse_id}|${b.batch_key}`, b]));
    for (const [k, c] of calcP) { const s = storedP.get(k); if (!s || s.qty !== c.q || s.value !== c.v) problems.push({ type: 'POOL_MISMATCH', key: k, fromMoves: c, stored: s ? { q: s.qty, v: s.value } : null }); }
    for (const [k] of storedP) if (!calcP.has(k)) problems.push({ type: 'POOL_WITHOUT_MOVES', key: k });
    for (const r of db.prepare(`WITH gl AS (SELECT doc_id, count(*) n FROM inv_gl_lines GROUP BY doc_id),
        ge AS (SELECT source_id, count(*) n FROM gl_entries WHERE source_type = 'inventory' GROUP BY source_id)
        SELECT d.number FROM inv_documents d LEFT JOIN gl ON gl.doc_id = d.id LEFT JOIN ge ON ge.source_id = d.id
        WHERE d.status = 'posted' AND (ifnull(gl.n, 0) <> ifnull(ge.n, 0) OR (ifnull(gl.n, 0) > 0) <> (d.gl_number IS NOT NULL))`).all()) problems.push({ type: 'LEDGER_MISMATCH', document: r.number });
    for (const r of db.prepare(`SELECT d.number FROM inv_documents d WHERE d.status = 'posted' AND d.doc_type NOT IN ('quality') AND NOT EXISTS (SELECT 1 FROM inv_moves m WHERE m.doc_id = d.id)
        AND NOT (d.doc_type = 'transfer_in' AND EXISTS (SELECT 1 FROM inv_document_lines l WHERE l.doc_id = d.id AND l.notes = 'shortage'))
        AND NOT (d.doc_type = 'reversal' AND (SELECT doc_type FROM inv_documents o WHERE o.id = d.reverses_id) IN ('quality', 'transfer_in'))`).all()) problems.push({ type: 'POSTED_WITHOUT_MOVES', document: r.number });
    // حالة الجودة الحالية لكل دفعة = آخر حركة جودة مرحّلة (أو عكسها)، وإلا حالتها الأولى
    for (const b of db.prepare(`SELECT b.batch_no, b.status, b.initial_status, q.to_status last FROM inv_batches b LEFT JOIN (
        SELECT l.batch_id, l.to_status, row_number() OVER (PARTITION BY l.batch_id ORDER BY d.posted_at DESC, d.id DESC) rn
        FROM inv_document_lines l JOIN inv_documents d ON d.id = l.doc_id LEFT JOIN inv_documents o ON o.id = d.reverses_id
        WHERE l.batch_id IS NOT NULL AND l.to_status IS NOT NULL AND d.status = 'posted' AND (d.doc_type = 'quality' OR (d.doc_type = 'reversal' AND o.doc_type = 'quality'))) q
        ON q.batch_id = b.id AND q.rn = 1`).all()) {
      if (b.status !== (b.last || b.initial_status)) problems.push({ type: 'BATCH_STATUS_MISMATCH', batch: b.batch_no, status: b.status, expected: b.last || b.initial_status });
    }
    return { ok: problems.length === 0, problems, moves: db.prepare('SELECT count(*) c FROM inv_moves').get().c };
  }
  function rebuild(ctx) {
    return inTransaction(db, () => {
      db.prepare('UPDATE inv_settings SET rebuilding = 1 WHERE id = 1').run();
      db.prepare('DELETE FROM inv_balances').run(); db.prepare('DELETE FROM inv_pools').run();
      db.prepare(`INSERT INTO inv_balances (item_id, warehouse_id, loc_key, batch_key, qty, last_move_id)
        SELECT item_id, warehouse_id, ifnull(location_id, 0), ifnull(batch_id, 0), '0', max(id) FROM inv_moves GROUP BY item_id, warehouse_id, ifnull(location_id, 0), ifnull(batch_id, 0)`).run();
      db.prepare(`INSERT INTO inv_pools (item_id, warehouse_id, batch_key, qty, value, last_move_id) SELECT item_id, warehouse_id, ifnull(batch_id, 0), '0', '0', max(id) FROM inv_moves GROUP BY item_id, warehouse_id, ifnull(batch_id, 0)`).run();
      const SQ = "CASE direction WHEN 'in' THEN qty ELSE '-' || qty END";
      const SV = "CASE WHEN direction = 'in' OR value = '0' THEN value ELSE '-' || value END";
      const acc = new Map(db.prepare(`SELECT item_id, warehouse_id, ifnull(location_id, 0) l, ifnull(batch_id, 0) b, dec_sum(${SQ}) q FROM inv_moves GROUP BY 1, 2, 3, 4`).all()
        .map((r) => [[r.item_id, r.warehouse_id, r.l, r.b].join('|'), r.q]));
      const accP = new Map(db.prepare(`SELECT item_id, warehouse_id, ifnull(batch_id, 0) b, dec_sum(${SQ}) q, dec_sum(${SV}) v FROM inv_moves GROUP BY 1, 2, 3`).all()
        .map((r) => [[r.item_id, r.warehouse_id, r.b].join('|'), { q: r.q, v: r.v }]));
      const ub = db.prepare('UPDATE inv_balances SET qty = ? WHERE item_id = ? AND warehouse_id = ? AND loc_key = ? AND batch_key = ?');
      for (const [k, q] of acc) ub.run(q, ...k.split('|').map(Number));
      const up = db.prepare('UPDATE inv_pools SET qty = ?, value = ? WHERE item_id = ? AND warehouse_id = ? AND batch_key = ?');
      for (const [k, c] of accP) up.run(c.q, c.v, ...k.split('|').map(Number));
      db.prepare('UPDATE inv_settings SET rebuilding = 0 WHERE id = 1').run();
      audit.fromCtx(ctx, { action: 'inventory.summaries_rebuilt', source: 'inventory', entityType: 'inv_settings', entityId: 1, details: { balances: acc.size, pools: accP.size } });
      return verify();
    });
  }

  return { createDraft, updateDraft, cancelDraft, approve, post, preview, reverse, receive, closeTransfer, get, list, verify, rebuild,
    getVisibleDoc, visibleDoc, usableOnHand, reservedRemaining, frozenBy, replay, remember, decimalIn, MANUAL_TYPES, QUALITY };
}

module.exports = { createInventoryEngine, MANUAL_TYPES, QUALITY };

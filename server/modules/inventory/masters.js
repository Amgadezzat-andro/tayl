'use strict';
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { createMasterService } = require('../../core/master');

/**
 * البيانات الرئيسية للمخزون: مجموعات الأصناف (شجرة)، دليل الأصناف، وحدات الصنف البديلة، المخازن والمواقع،
 * نطاق المستخدم على المخازن، وإعدادات التقييم والربط المحاسبي.
 *
 * الحسابات لا تُفترض: يختارها المستخدم من الدليل، ويُتحقق من أنها تفصيلية نشطة ومن تصنيفها حسب الدور.
 * حساب الصنف = حسابه الخاص (بصلاحية الربط المحاسبي) ← أقرب مجموعة أعلى الشجرة ← الإعداد العام. لا حساب ⇒ لا ترحيل.
 */
const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const ITEM_TYPES = ['raw_material', 'packaging', 'wip', 'semi_finished', 'finished_good', 'spare_part', 'supplies', 'other'];
const WH_TYPES = ['raw', 'packaging', 'wip', 'finished', 'spare_parts', 'quarantine', 'general'];
const ACCOUNT_ROLES = {
  inventory: ['asset'], transit: ['asset'],
  issue: ['expense', 'cogs', 'asset'],
  adjustment: ['expense', 'cogs', 'revenue'],
  counter: ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'],
};
const ACC_FIELDS = [['inventoryAccountId', 'inventory_account_id', 'inventory'], ['issueAccountId', 'issue_account_id', 'issue'], ['adjustmentAccountId', 'adjustment_account_id', 'adjustment']];

function createMasters(services, whAccess) {
  const { db, decimal: D, audit } = services;
  const fail = (status, code, message, details) => { throw new HttpError(status, code, message, details); };

  /** حساب صالح لدور محدد: تفصيلي نشط وتصنيفه مسموح للدور. */
  function checkAccount(id, role, field) {
    const a = db.prepare('SELECT id, code, class_code, is_group, is_active FROM accounts WHERE id = ?').get(id);
    if (!a) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: 'NOT_FOUND' } });
    if (a.is_group === 1) fail(409, 'ACCOUNT_NOT_DETAIL', 'الحساب تجميعي؛ اختر حسابًا تفصيليًا', { field, account: a.code });
    if (a.is_active !== 1) fail(409, 'ACCOUNT_INACTIVE', 'الحساب معطّل', { field, account: a.code });
    if (!ACCOUNT_ROLES[role].includes(a.class_code)) fail(409, 'ACCOUNT_CLASS_NOT_ALLOWED', 'تصنيف الحساب لا يناسب هذا الدور', { field, account: a.code, role, allowed: ACCOUNT_ROLES[role] });
    return a;
  }
  /** قيمة كمية غير سالبة بدقة التخزين (لا تقريب صامت). */
  function qtyValue(v, field, { positive = false } = {}) {
    if (v == null) return null;
    let x;
    try { x = D.toStorage(D.parse(v), 'quantity'); } catch { fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: 'INVALID_QUANTITY' } }); }
    if (D.isNegative(x) || (positive && D.isZero(x))) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [field]: positive ? 'MUST_BE_POSITIVE' : 'NEGATIVE' } });
    return x;
  }

  // ── المجموعات ──
  const groups = createMasterService(services, {
    entity: 'inv_group', table: 'inv_groups', source: 'inventory', tree: true, titleKey: 'nav.invGroups',
    columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['parentId', 'parent_id'], ['isGroup', 'is_group'], ['sortOrder', 'sort_order'],
      ['inventoryAccountId', 'inventory_account_id'], ['issueAccountId', 'issue_account_id'], ['adjustmentAccountId', 'adjustment_account_id'],
      ['defaultItemType', 'default_item_type'], ['defaultTrackBatches', 'default_track_batches'], ['defaultTrackExpiry', 'default_track_expiry'], ['description', 'description']],
    validate(body, { partial }) {
      const d = validator(body, { partial })
        .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 }).str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 })
        .id('parentId').bool('isGroup').int('sortOrder', { min: 0, max: 1e9 }).id('inventoryAccountId').id('issueAccountId').id('adjustmentAccountId')
        .oneOf('defaultItemType', ITEM_TYPES).bool('defaultTrackBatches').bool('defaultTrackExpiry').str('description', { max: 500, multiline: true })
        .done();
      for (const k of ['isGroup', 'defaultTrackBatches', 'defaultTrackExpiry']) if (k in d && d[k] != null) d[k] = d[k] ? 1 : 0;
      return d;
    },
    beforeSave(ctx, d, before) {
      if (!before && d.isGroup == null) d.isGroup = 0;
      for (const [api, , role] of ACC_FIELDS) {
        if (!(api in d)) continue;
        if (!ctx.access.can('inventory.accounting_settings')) fail(403, 'ACCOUNTING_SETTINGS_FORBIDDEN', 'ربط الحسابات يتطلب صلاحية إعدادات الربط المحاسبي');
        if (d[api] != null) checkAccount(d[api], role, api);
      }
      const tb = 'defaultTrackBatches' in d ? d.defaultTrackBatches : before ? before.default_track_batches : 0;
      const te = 'defaultTrackExpiry' in d ? d.defaultTrackExpiry : before ? before.default_track_expiry : 0;
      if (te && !tb) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { defaultTrackExpiry: 'NEEDS_BATCHES' } });
      if (before && 'isGroup' in d && d.isGroup === 1 && before.is_group !== 1 && db.prepare('SELECT 1 FROM inv_items WHERE group_id = ? LIMIT 1').get(before.id)) {
        fail(409, 'IN_USE', 'المجموعة بها أصناف؛ لا تتحول إلى مجموعة تجميعية');
      }
    },
    toApi: (r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, parentId: r.parent_id, level: r.level, isGroup: r.is_group === 1, sortOrder: r.sort_order,
      inventoryAccountId: r.inventory_account_id, issueAccountId: r.issue_account_id, adjustmentAccountId: r.adjustment_account_id,
      defaultItemType: r.default_item_type, defaultTrackBatches: r.default_track_batches === 1, defaultTrackExpiry: r.default_track_expiry === 1,
      description: r.description, isActive: r.is_active === 1 }),
    exportColumns: [
      { label: 'inv.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
      { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
    ],
  });

  // ── الأصناف ──
  function parseAttributes(v) {
    if (v == null) return null;
    if (typeof v !== 'object' || Array.isArray(v)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { attributes: 'OBJECT_REQUIRED' } });
    const keys = Object.keys(v);
    if (keys.length > 40 || !keys.every((k) => /^[a-z][a-z0-9_]{0,39}$/.test(k)) || !Object.values(v).every((x) => x === null || ['string', 'boolean'].includes(typeof x) || (typeof x === 'string' && x.length <= 300))) {
      fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { attributes: 'INVALID' } });
    }
    if (Object.values(v).some((x) => typeof x === 'string' && x.length > 300)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { attributes: 'TOO_LONG' } });
    return keys.length ? JSON.stringify(v) : null;
  }
  const items = createMasterService(services, {
    entity: 'inv_item', table: 'inv_items', source: 'inventory', titleKey: 'nav.invItems',
    columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['description', 'description'], ['notes', 'notes'], ['groupId', 'group_id'],
      ['itemType', 'item_type'], ['isStock', 'is_stock'], ['baseUnitId', 'base_unit_id'], ['minQty', 'min_qty'], ['reorderQty', 'reorder_qty'], ['maxQty', 'max_qty'],
      ['barcode', 'barcode'], ['trackBatches', 'track_batches'], ['trackExpiry', 'track_expiry'], ['trackSerials', 'track_serials'],
      ['inventoryAccountId', 'inventory_account_id'], ['issueAccountId', 'issue_account_id'], ['adjustmentAccountId', 'adjustment_account_id'], ['attributes', 'attributes']],
    uniqueFields: { code: 'code', barcode: 'barcode' },
    validate(body, { partial }) {
      const d = validator(body, { partial })
        .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 }).str('nameAr', { required: true, max: 200 }).str('nameEn', { required: true, max: 200 })
        .str('description', { max: 1000, multiline: true }).str('notes', { max: 1000, multiline: true }).id('groupId', { required: true })
        .oneOf('itemType', ITEM_TYPES).bool('isStock').id('baseUnitId', { required: true })
        .decimal('minQty').decimal('reorderQty').decimal('maxQty').str('barcode', { max: 64, pattern: /^[0-9A-Za-z._-]+$/ })
        .bool('trackBatches').bool('trackExpiry').bool('trackSerials').id('inventoryAccountId').id('issueAccountId').id('adjustmentAccountId')
        .done();
      for (const k of ['isStock', 'trackBatches', 'trackExpiry', 'trackSerials']) if (k in d && d[k] != null) d[k] = d[k] ? 1 : 0;
      for (const k of ['minQty', 'reorderQty', 'maxQty']) if (k in d) d[k] = qtyValue(d[k], k);
      if ('attributes' in body) d.attributes = parseAttributes(body.attributes);
      return d;
    },
    beforeSave(ctx, d, before) {
      const grp = d.groupId != null ? groups.assertUsable(d.groupId, ctx) : null;
      if (!before) {   // الافتراضات من المجموعة
        if (d.itemType == null) d.itemType = grp.default_item_type || null;
        if (d.itemType == null) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { itemType: 'REQUIRED' } });
        if (d.isStock == null) d.isStock = 1;
        if (d.trackBatches == null) d.trackBatches = d.isStock ? grp.default_track_batches : 0;
        if (d.trackExpiry == null) d.trackExpiry = d.trackBatches ? grp.default_track_expiry : 0;
        if (d.trackSerials == null) d.trackSerials = 0;
      }
      if (d.baseUnitId != null && (!before || d.baseUnitId !== before.base_unit_id)) {
        const u = db.prepare('SELECT is_active FROM units WHERE id = ?').get(d.baseUnitId);
        if (!u) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { baseUnitId: 'NOT_FOUND' } });
        if (u.is_active !== 1) fail(409, 'NOT_USABLE', 'الوحدة معطّلة', { field: 'baseUnitId' });
      }
      const v = (k, col) => (k in d ? d[k] : before ? before[col] : null);
      const isStock = v('isStock', 'is_stock'); const tb = v('trackBatches', 'track_batches'); const te = v('trackExpiry', 'track_expiry'); const ts = v('trackSerials', 'track_serials');
      if (te && !tb) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { trackExpiry: 'NEEDS_BATCHES' } });
      if (ts && tb) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { trackSerials: 'NOT_WITH_BATCHES' } });
      if (!isStock && (tb || ts)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { isStock: 'NON_STOCK_NO_TRACKING' } });
      const mn = v('minQty', 'min_qty'); const ro = v('reorderQty', 'reorder_qty'); const mx = v('maxQty', 'max_qty');
      if (mx != null && ((mn != null && D.lt(mx, mn)) || (ro != null && D.lt(mx, ro)))) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { maxQty: 'BELOW_MIN' } });
      if (before) {
        const changed = ['baseUnitId', 'isStock', 'trackBatches', 'trackExpiry', 'trackSerials'].some((k) => k in d && d[k] !== before[{ baseUnitId: 'base_unit_id', isStock: 'is_stock', trackBatches: 'track_batches', trackExpiry: 'track_expiry', trackSerials: 'track_serials' }[k]]);
        if (changed && (db.prepare('SELECT 1 FROM inv_document_lines WHERE item_id = ? LIMIT 1').get(before.id) || db.prepare('SELECT 1 FROM inv_batches WHERE item_id = ? LIMIT 1').get(before.id))) {
          fail(409, 'ITEM_POLICY_LOCKED', 'سياسة الصنف (الوحدة الأساسية، الطبيعة، التتبع) ثابتة بعد استخدامه في مستندات؛ التحويل يتطلب إجراء بيانات مضبوطًا');
        }
      }
      for (const [api, , role] of ACC_FIELDS) {
        if (!(api in d)) continue;
        if (before && d[api] === before[api.replace(/[A-Z]/g, (c) => '_' + c.toLowerCase())]) continue;
        if (!ctx.access.can('inventory.accounting_settings')) fail(403, 'ACCOUNTING_SETTINGS_FORBIDDEN', 'تخصيص حسابات الصنف يتطلب صلاحية إعدادات الربط المحاسبي');
        if (d[api] != null) checkAccount(d[api], role, api);
      }
    },
    searchCols: ['code', 'name_ar', 'name_en', 'barcode'],
    toApi: (r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, description: r.description, notes: r.notes, groupId: r.group_id,
      itemType: r.item_type, isStock: r.is_stock === 1, baseUnitId: r.base_unit_id, minQty: r.min_qty, reorderQty: r.reorder_qty, maxQty: r.max_qty,
      barcode: r.barcode, trackBatches: r.track_batches === 1, trackExpiry: r.track_expiry === 1, trackSerials: r.track_serials === 1,
      valuationMethod: r.valuation_method, inventoryAccountId: r.inventory_account_id, issueAccountId: r.issue_account_id, adjustmentAccountId: r.adjustment_account_id,
      attributes: r.attributes ? JSON.parse(r.attributes) : null, isActive: r.is_active === 1 }),
    filters: {
      groupId: (v) => (/^\d{1,15}$/.test(v) ? { sql: 'group_id IN (SELECT id FROM inv_groups WHERE path LIKE (SELECT path FROM inv_groups WHERE id = ?) || \'%\')', params: [Number(v)] } : null),
      itemType: (v) => (ITEM_TYPES.includes(v) ? { sql: 'item_type = ?', params: [v] } : null),
      stock: (v) => (v === '1' || v === '0' ? { sql: 'is_stock = ?', params: [Number(v)] } : null),
    },
    lookupExtra: (r) => ({ baseUnitId: r.base_unit_id, isStock: r.is_stock === 1, trackBatches: r.track_batches === 1, trackExpiry: r.track_expiry === 1, trackSerials: r.track_serials === 1, barcode: r.barcode }),
    exportColumns: [
      { label: 'inv.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
      { label: 'inv.itemType', value: (r, t) => t('inv.type.' + r.itemType) }, { label: 'inv.barcode', value: (r) => r.barcode },
      { label: 'inv.minQty', value: (r) => r.minQty }, { label: 'inv.reorderQty', value: (r) => r.reorderQty },
      { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
    ],
  });

  // ── وحدات الصنف البديلة ──
  const unitApi = (r) => ({ id: r.id, itemId: r.item_id, unitId: r.unit_id, unitCode: r.unit_code, nameAr: r.name_ar, nameEn: r.name_en, factor: r.factor,
    isPurchase: r.is_purchase === 1, isIssue: r.is_issue === 1, isActive: r.is_active === 1 });
  const unitRows = (itemId) => db.prepare(`SELECT iu.*, u.code unit_code, u.name_ar, u.name_en FROM inv_item_units iu JOIN units u ON u.id = iu.unit_id WHERE iu.item_id = ? ORDER BY u.code`).all(itemId);
  function itemUnits(ctx, itemId) {
    const it = items.get(ctx, itemId);
    const base = db.prepare('SELECT id, code, name_ar, name_en FROM units WHERE id = ?').get(it.baseUnitId);
    return { item: { id: it.id, code: it.code }, base: { unitId: base.id, unitCode: base.code, nameAr: base.name_ar, nameEn: base.name_en, factor: '1' }, units: unitRows(itemId).map(unitApi) };
  }
  function setItemUnit(ctx, itemId, body) {
    const d = validator(body).id('unitId', { required: true }).decimal('factor', { required: true }).bool('isPurchase').bool('isIssue').bool('isActive').done();
    const factor = qtyValue(d.factor, 'factor', { positive: true });
    return inTransaction(db, () => {
      const it = items.byId(itemId);
      if (!it) fail(404, 'NOT_FOUND', 'الصنف غير موجود');
      if (d.unitId === it.base_unit_id) fail(409, 'BASE_UNIT_FACTOR', 'وحدة الأساس معاملها 1 دائمًا؛ لا تُعرَّف لها وحدة تحويل');
      const u = db.prepare('SELECT is_active FROM units WHERE id = ?').get(d.unitId);
      if (!u) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { unitId: 'NOT_FOUND' } });
      const cur = db.prepare('SELECT * FROM inv_item_units WHERE item_id = ? AND unit_id = ?').get(itemId, d.unitId);
      if (!cur && u.is_active !== 1) fail(409, 'NOT_USABLE', 'الوحدة معطّلة', { field: 'unitId' });
      const flags = { is_purchase: d.isPurchase == null ? (cur ? cur.is_purchase : 1) : Number(d.isPurchase), is_issue: d.isIssue == null ? (cur ? cur.is_issue : 1) : Number(d.isIssue), is_active: d.isActive == null ? (cur ? cur.is_active : 1) : Number(d.isActive) };
      if (cur) {
        db.prepare(`UPDATE inv_item_units SET factor = ?, is_purchase = ?, is_issue = ?, is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(factor, flags.is_purchase, flags.is_issue, flags.is_active, cur.id);
      } else {
        db.prepare('INSERT INTO inv_item_units (item_id, unit_id, factor, is_purchase, is_issue, is_active) VALUES (?, ?, ?, ?, ?, ?)').run(itemId, d.unitId, factor, flags.is_purchase, flags.is_issue, flags.is_active);
      }
      // المستندات المرحّلة تحتفظ بعامل التحويل المستخدم وقت الحركة؛ التغيير يسري على المسودات عند ترحيلها فقط
      audit.fromCtx(ctx, { action: cur ? 'inventory.unit_conversion_changed' : 'inventory.unit_conversion_added', source: 'inventory', entityType: 'inv_item', entityId: itemId,
        details: { item: it.code, unitId: d.unitId, factor: { from: cur ? cur.factor : null, to: factor }, ...flags } });
      return itemUnits(ctx, itemId);
    });
  }
  /** عامل تحويل وحدة للصنف الآن (وحدة الأساس = 1). */
  function factorOf(item, unitId, { forUse = true } = {}) {
    if (unitId === item.base_unit_id) return '1';
    const r = db.prepare('SELECT factor, is_active FROM inv_item_units WHERE item_id = ? AND unit_id = ?').get(item.id, unitId);
    if (!r) fail(409, 'UNIT_NOT_DEFINED', 'الوحدة غير معرّفة لهذا الصنف', { item: item.code, unitId });
    if (forUse && r.is_active !== 1) fail(409, 'UNIT_INACTIVE', 'وحدة الصنف موقوفة', { item: item.code, unitId });
    return r.factor;
  }

  // ── المخازن ──
  const warehouses = createMasterService(services, {
    entity: 'inv_warehouse', table: 'inv_warehouses', source: 'inventory', titleKey: 'nav.invWarehouses',
    scope: { api: 'branchId', col: 'branch_id', nullable: false },
    columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['branchId', 'branch_id'], ['whType', 'wh_type'], ['keeperUserId', 'keeper_user_id'], ['notes', 'notes']],
    validate(body, { partial }) {
      return validator(body, { partial })
        .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 }).str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 })
        .id('branchId', { required: true }).oneOf('whType', WH_TYPES, { required: true }).id('keeperUserId').str('notes', { max: 500, multiline: true })
        .done();
    },
    beforeSave(ctx, d, before) {
      if (d.keeperUserId != null && !db.prepare('SELECT 1 FROM users WHERE id = ? AND is_active = 1').get(d.keeperUserId)) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { keeperUserId: 'NOT_FOUND' } });
      if (before && (('branchId' in d && d.branchId !== before.branch_id) || ('whType' in d && d.whType !== before.wh_type))
        && db.prepare('SELECT 1 FROM inv_documents WHERE warehouse_id = ? OR to_warehouse_id = ? LIMIT 1').get(before.id, before.id)) {
        fail(409, 'WAREHOUSE_LOCKED', 'فرع المخزن ونوعه ثابتان بعد أول مستند');
      }
    },
    beforeActive(ctx, row, active) {
      if (!active && db.prepare("SELECT 1 FROM inv_counts WHERE warehouse_id = ? AND status IN ('counting', 'review', 'approved')").get(row.id)) fail(409, 'COUNT_IN_PROGRESS', 'يوجد جرد مفتوح على المخزن');
    },
    toApi: (r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, branchId: r.branch_id, whType: r.wh_type, keeperUserId: r.keeper_user_id, notes: r.notes, isActive: r.is_active === 1 }),
    lookupExtra: (r) => ({ branchId: r.branch_id, whType: r.wh_type }),
    filters: { branchId: (v) => (/^\d{1,15}$/.test(v) ? { sql: 'branch_id = ?', params: [Number(v)] } : null), whType: (v) => (WH_TYPES.includes(v) ? { sql: 'wh_type = ?', params: [v] } : null) },
    exportColumns: [
      { label: 'inv.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
      { label: 'inv.whType', value: (r, t) => t('inv.wh.' + r.whType) }, { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
    ],
  });
  /** قائمة المخازن مع نطاق المخازن (فوق نطاق الفروع الذي تطبقه خدمة البيانات الرئيسية). */
  function listWarehouses(ctx, q) {
    const r = warehouses.list(ctx, { ...q, limit: '2000' });
    const items2 = r.items.filter((w) => whAccess.allowed(ctx, { id: w.id, branch_id: w.branchId }));
    return { ...r, items: items2, total: items2.length };
  }
  const getWarehouse = (ctx, id) => { whAccess.assertWarehouse(ctx, id); return warehouses.get(ctx, id); };

  // ── المواقع ──
  const locApi = (r) => ({ id: r.id, warehouseId: r.warehouse_id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, isActive: r.is_active === 1 });
  function locations(ctx, whId) {
    whAccess.assertWarehouse(ctx, whId);
    return db.prepare('SELECT * FROM inv_locations WHERE warehouse_id = ? ORDER BY code').all(whId).map(locApi);
  }
  function saveLocation(ctx, whId, locId, body) {
    const d = validator(body, { partial: !!locId }).str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
      .str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 }).bool('isActive').done();
    return inTransaction(db, () => {
      const wh = whAccess.assertWarehouse(ctx, whId);
      ctx.access.assertBranch(wh.branch_id);
      try {
        if (locId) {
          const cur = db.prepare('SELECT * FROM inv_locations WHERE id = ? AND warehouse_id = ?').get(locId, whId);
          if (!cur) fail(404, 'NOT_FOUND', 'الموقع غير موجود');
          if (d.code && d.code !== cur.code && db.prepare('SELECT 1 FROM inv_moves WHERE location_id = ? LIMIT 1').get(locId)) fail(409, 'CODE_LOCKED', 'لا يتغير كود موقع له حركات');
          db.prepare('UPDATE inv_locations SET code = ?, name_ar = ?, name_en = ?, is_active = ? WHERE id = ?')
            .run(d.code ?? cur.code, d.nameAr ?? cur.name_ar, d.nameEn ?? cur.name_en, d.isActive == null ? cur.is_active : Number(d.isActive), locId);
        } else {
          locId = Number(db.prepare('INSERT INTO inv_locations (warehouse_id, code, name_ar, name_en) VALUES (?, ?, ?, ?)').run(whId, d.code, d.nameAr, d.nameEn).lastInsertRowid);
        }
      } catch (e) {
        if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') fail(409, 'DUPLICATE', 'القيمة مستخدمة من قبل', { fields: { code: 'TAKEN' } });
        throw e;
      }
      audit.fromCtx(ctx, { action: 'inventory.location_saved', source: 'inventory', entityType: 'inv_location', entityId: locId, details: { warehouse: wh.code, ...d } });
      return locApi(db.prepare('SELECT * FROM inv_locations WHERE id = ?').get(locId));
    });
  }

  // ── نطاق المستخدمين على المخزن ──
  function warehouseUsers(ctx, whId) {
    whAccess.assertWarehouse(ctx, whId);
    return db.prepare(`SELECT u.id, u.username, u.display_name displayName FROM inv_user_warehouses x JOIN users u ON u.id = x.user_id WHERE x.warehouse_id = ? ORDER BY u.username`).all(whId);
  }
  function setWarehouseUser(ctx, whId, body) {
    const d = validator(body).id('userId', { required: true }).bool('assigned', { required: true }).done();
    return inTransaction(db, () => {
      const wh = whAccess.assertWarehouse(ctx, whId);
      ctx.access.assertBranch(wh.branch_id);
      const target = db.prepare('SELECT id, username, is_super_admin FROM users WHERE id = ?').get(d.userId);
      if (!target) fail(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { userId: 'NOT_FOUND' } });
      if (!services.guard.canSee(ctx, target)) fail(404, 'NOT_FOUND', 'المستخدم غير موجود');
      if (d.assigned) db.prepare('INSERT OR IGNORE INTO inv_user_warehouses (user_id, warehouse_id) VALUES (?, ?)').run(d.userId, whId);
      else db.prepare('DELETE FROM inv_user_warehouses WHERE user_id = ? AND warehouse_id = ?').run(d.userId, whId);
      audit.fromCtx(ctx, { action: d.assigned ? 'inventory.warehouse_user_added' : 'inventory.warehouse_user_removed', source: 'inventory', entityType: 'inv_warehouse', entityId: whId, details: { warehouse: wh.code, user: target.username } });
      return warehouseUsers(ctx, whId);
    });
  }

  // ── الإعدادات ──
  const settingsRow = () => db.prepare('SELECT * FROM inv_settings WHERE id = 1').get();
  const accBrief = (id) => (id ? db.prepare('SELECT id, code, name_ar nameAr, name_en nameEn FROM accounts WHERE id = ?').get(id) : null);
  function settings() {
    const s = settingsRow();
    return {
      inventoryAccount: accBrief(s.inventory_account_id), issueAccount: accBrief(s.issue_account_id), adjustmentAccount: accBrief(s.adjustment_account_id), transitAccount: accBrief(s.transit_account_id),
      expiryAlertDays: s.expiry_alert_days, slowMovingDays: s.slow_moving_days, staleDraftDays: s.stale_draft_days, requireApproval: s.require_approval === 1,
      valuationMethods: [{ code: 'moving_average', supported: true }, { code: 'fifo', supported: false }],
    };
  }
  function saveSettings(ctx, body) {
    const d = validator(body, { partial: true }).id('inventoryAccountId').id('issueAccountId').id('adjustmentAccountId').id('transitAccountId')
      .int('expiryAlertDays', { min: 1, max: 3650 }).int('slowMovingDays', { min: 1, max: 3650 }).int('staleDraftDays', { min: 1, max: 365 }).bool('requireApproval').done();
    const accs = [['inventoryAccountId', 'inventory_account_id', 'inventory'], ['issueAccountId', 'issue_account_id', 'issue'], ['adjustmentAccountId', 'adjustment_account_id', 'adjustment'], ['transitAccountId', 'transit_account_id', 'transit']];
    const other = [['expiryAlertDays', 'expiry_alert_days'], ['slowMovingDays', 'slow_moving_days'], ['staleDraftDays', 'stale_draft_days'], ['requireApproval', 'require_approval']];
    if (accs.some(([k]) => k in d) && !ctx.access.can('inventory.accounting_settings')) fail(403, 'ACCOUNTING_SETTINGS_FORBIDDEN', 'يتطلب صلاحية إعدادات الربط المحاسبي');
    if (other.some(([k]) => k in d) && !ctx.access.can('inventory_costing.settings')) fail(403, 'FORBIDDEN', 'يتطلب صلاحية إعدادات التقييم');
    return inTransaction(db, () => {
      const before = settingsRow();
      const sets = []; const params = []; const changes = {};
      for (const [k, col, role] of accs) {
        if (!(k in d)) continue;
        if (d[k] != null) checkAccount(d[k], role, k);
        sets.push(`${col} = ?`); params.push(d[k]); changes[k] = { from: before[col], to: d[k] };
      }
      for (const [k, col] of other) {
        if (!(k in d) || d[k] == null) continue;
        const v = typeof d[k] === 'boolean' ? Number(d[k]) : d[k];
        sets.push(`${col} = ?`); params.push(v); changes[k] = { from: before[col], to: v };
      }
      if (sets.length) {
        db.prepare(`UPDATE inv_settings SET ${sets.join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run(...params);
        audit.fromCtx(ctx, { action: 'inventory.settings_changed', source: 'inventory', entityType: 'inv_settings', entityId: 1, details: { changes } });
      }
      return settings();
    });
  }

  /** حساب الصنف لدور: الصنف ← أقرب مجموعة أعلى الشجرة ← الإعداد العام. */
  function accountFor(item, role) {
    const col = { inventory: 'inventory_account_id', issue: 'issue_account_id', adjustment: 'adjustment_account_id' }[role];
    if (item[col]) return item[col];
    const g = db.prepare('SELECT path FROM inv_groups WHERE id = ?').get(item.group_id);
    const ids = g.path.split('/').filter(Boolean).map(Number).reverse();
    for (const id of ids) { const r = db.prepare(`SELECT ${col} a FROM inv_groups WHERE id = ?`).get(id); if (r && r.a) return r.a; }
    return settingsRow()[col] || null;
  }
  const transitAccount = () => settingsRow().transit_account_id || null;

  return { groups, items, warehouses, listWarehouses, getWarehouse, itemUnits, setItemUnit, factorOf, locations, saveLocation, warehouseUsers, setWarehouseUser,
    settings, saveSettings, settingsRow, accountFor, transitAccount, checkAccount, qtyValue, ITEM_TYPES, WH_TYPES };
}

module.exports = { createMasters, ITEM_TYPES, WH_TYPES, CODE_RE };

-- TAYL Phase 6 (v0.7.0) — نواة المخزون: الأصناف والمجموعات والتحويلات والمخازن والمواقع والدفعات والأرقام المسلسلة،
-- المستندات المخزنية ومحركها المركزي، سجل الحركات غير القابل للتعديل، الأرصدة والتقييم (ملخصات مشتقة من السجل)، الحجوزات،
-- الجرد، والربط المحاسبي عبر services.ledger.post() فقط (مصدر أستاذ جديد: inventory).
-- مولَّد مرة واحدة ثم ثابت: لا يُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.
--
-- القيم العشرية نصوص قانونية (لا REAL أبدًا): الكميات quantity (8 خانات)، المبالغ amount (8)، تكلفة الوحدة unit_cost (10).
-- الأرصدة (inv_balances) ومجمعات التكلفة (inv_pools) تُحدَّث فقط من trigger بعد إدراج حركة في inv_moves، ولا تُكتب مباشرة:
-- حراسها يشترطون أن يطابق التحديث آخر حركة بالضبط. خدمة التحقق تعيد حسابها من السجل وتكشف أي اختلاف.

-- ── الإعدادات والربط المحاسبي ──
CREATE TABLE inv_settings (
  id                    INTEGER PRIMARY KEY CHECK (id = 1),
  inventory_account_id  INTEGER REFERENCES accounts (id),   -- حساب المخزون الافتراضي
  issue_account_id      INTEGER REFERENCES accounts (id),   -- تكلفة الصرف/الاستهلاك الافتراضية
  adjustment_account_id INTEGER REFERENCES accounts (id),   -- فروق الجرد والتسويات وفروق التكلفة
  transit_account_id    INTEGER REFERENCES accounts (id),   -- مخزون بالطريق (التحويل بين الفروع)
  expiry_alert_days     INTEGER NOT NULL DEFAULT 30 CHECK (expiry_alert_days BETWEEN 1 AND 3650),
  slow_moving_days      INTEGER NOT NULL DEFAULT 90 CHECK (slow_moving_days BETWEEN 1 AND 3650),
  stale_draft_days      INTEGER NOT NULL DEFAULT 7 CHECK (stale_draft_days BETWEEN 1 AND 365),
  require_approval      INTEGER NOT NULL DEFAULT 0 CHECK (require_approval IN (0, 1)),
  rebuilding            INTEGER NOT NULL DEFAULT 0 CHECK (rebuilding IN (0, 1)),   -- إعادة بناء الملخصات من السجل (صيانة)
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
INSERT INTO inv_settings (id) VALUES (1);
CREATE TRIGGER inv_settings_no_delete BEFORE DELETE ON inv_settings BEGIN SELECT RAISE(ABORT, 'inventory settings row is fixed'); END;

-- ── مجموعات الأصناف (شجرة؛ الأصناف على المجموعات التفصيلية) ──
CREATE TABLE inv_groups (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar               TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en               TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  parent_id             INTEGER REFERENCES inv_groups (id),
  path                  TEXT NOT NULL,
  level                 INTEGER NOT NULL DEFAULT 1 CHECK (level BETWEEN 1 AND 15),
  is_group              INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
  sort_order            INTEGER NOT NULL DEFAULT 0,
  inventory_account_id  INTEGER REFERENCES accounts (id),   -- NULL = يرث من الأب ثم الإعداد العام
  issue_account_id      INTEGER REFERENCES accounts (id),
  adjustment_account_id INTEGER REFERENCES accounts (id),
  default_item_type     TEXT CHECK (default_item_type IS NULL OR default_item_type IN ('raw_material', 'packaging', 'wip', 'semi_finished', 'finished_good', 'spare_part', 'supplies', 'other')),
  default_track_batches INTEGER NOT NULL DEFAULT 0 CHECK (default_track_batches IN (0, 1)),
  default_track_expiry  INTEGER NOT NULL DEFAULT 0 CHECK (default_track_expiry IN (0, 1)),
  description           TEXT CHECK (description IS NULL OR length(description) <= 500),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (default_track_expiry = 0 OR default_track_batches = 1)
) STRICT;
CREATE INDEX inv_groups_parent ON inv_groups (parent_id);

-- ── دليل الأصناف ──
CREATE TABLE inv_items (
  id                    INTEGER PRIMARY KEY,
  code                  TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar               TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 200),
  name_en               TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  description           TEXT CHECK (description IS NULL OR length(description) <= 1000),
  notes                 TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  group_id              INTEGER NOT NULL REFERENCES inv_groups (id),
  item_type             TEXT NOT NULL CHECK (item_type IN ('raw_material', 'packaging', 'wip', 'semi_finished', 'finished_good', 'spare_part', 'supplies', 'other')),
  is_stock              INTEGER NOT NULL DEFAULT 1 CHECK (is_stock IN (0, 1)),
  base_unit_id          INTEGER NOT NULL REFERENCES units (id),
  min_qty               TEXT CHECK (min_qty IS NULL OR (min_qty = '0' OR ((min_qty GLOB '[1-9]*' OR min_qty GLOB '0.[0-9]*') AND min_qty NOT GLOB '*[^0-9.]*' AND min_qty NOT GLOB '*.*.*' AND min_qty NOT GLOB '*.' AND min_qty NOT GLOB '*.*0' AND (instr(min_qty, '.') = 0 OR length(min_qty) - instr(min_qty, '.') <= 8) AND (CASE WHEN instr(min_qty, '.') = 0 THEN length(min_qty) ELSE instr(min_qty, '.') - 1 END) <= 20))),
  reorder_qty           TEXT CHECK (reorder_qty IS NULL OR (reorder_qty = '0' OR ((reorder_qty GLOB '[1-9]*' OR reorder_qty GLOB '0.[0-9]*') AND reorder_qty NOT GLOB '*[^0-9.]*' AND reorder_qty NOT GLOB '*.*.*' AND reorder_qty NOT GLOB '*.' AND reorder_qty NOT GLOB '*.*0' AND (instr(reorder_qty, '.') = 0 OR length(reorder_qty) - instr(reorder_qty, '.') <= 8) AND (CASE WHEN instr(reorder_qty, '.') = 0 THEN length(reorder_qty) ELSE instr(reorder_qty, '.') - 1 END) <= 20))),
  max_qty               TEXT CHECK (max_qty IS NULL OR (max_qty = '0' OR ((max_qty GLOB '[1-9]*' OR max_qty GLOB '0.[0-9]*') AND max_qty NOT GLOB '*[^0-9.]*' AND max_qty NOT GLOB '*.*.*' AND max_qty NOT GLOB '*.' AND max_qty NOT GLOB '*.*0' AND (instr(max_qty, '.') = 0 OR length(max_qty) - instr(max_qty, '.') <= 8) AND (CASE WHEN instr(max_qty, '.') = 0 THEN length(max_qty) ELSE instr(max_qty, '.') - 1 END) <= 20))),
  barcode               TEXT UNIQUE CHECK (barcode IS NULL OR (length(barcode) BETWEEN 1 AND 64 AND barcode NOT GLOB '*[^0-9A-Za-z._-]*')),
  track_batches         INTEGER NOT NULL DEFAULT 0 CHECK (track_batches IN (0, 1)),
  track_expiry          INTEGER NOT NULL DEFAULT 0 CHECK (track_expiry IN (0, 1)),
  track_serials         INTEGER NOT NULL DEFAULT 0 CHECK (track_serials IN (0, 1)),
  valuation_method      TEXT NOT NULL DEFAULT 'moving_average' CHECK (valuation_method IN ('moving_average')),   -- FIFO غير مدعوم في 0.7.0
  inventory_account_id  INTEGER REFERENCES accounts (id),   -- NULL = يرث من المجموعة
  issue_account_id      INTEGER REFERENCES accounts (id),
  adjustment_account_id INTEGER REFERENCES accounts (id),
  attributes            TEXT CHECK (attributes IS NULL OR (json_valid(attributes) AND json_type(attributes) = 'object' AND length(attributes) <= 4000)),
  is_active             INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (track_expiry = 0 OR track_batches = 1),
  CHECK (track_serials = 0 OR track_batches = 0),
  CHECK (is_stock = 1 OR (track_batches = 0 AND track_serials = 0))
) STRICT;
CREATE INDEX inv_items_group ON inv_items (group_id);
CREATE INDEX inv_items_type ON inv_items (item_type);
CREATE TRIGGER inv_items_group_detail BEFORE INSERT ON inv_items
WHEN (SELECT is_group FROM inv_groups WHERE id = NEW.group_id) IS NOT 0
BEGIN SELECT RAISE(ABORT, 'items belong to a detail item group'); END;
CREATE TRIGGER inv_items_group_detail_upd BEFORE UPDATE OF group_id ON inv_items
WHEN (SELECT is_group FROM inv_groups WHERE id = NEW.group_id) IS NOT 0
BEGIN SELECT RAISE(ABORT, 'items belong to a detail item group'); END;
-- سياسة الصنف ثابتة بعد أول حركة أو بند مستند (التحويل يتطلب إجراء بيانات مضبوطًا — مؤجل)
CREATE TRIGGER inv_items_policy_locked BEFORE UPDATE OF base_unit_id, is_stock, track_batches, track_expiry, track_serials, valuation_method ON inv_items
WHEN (NEW.base_unit_id IS NOT OLD.base_unit_id OR NEW.is_stock IS NOT OLD.is_stock OR NEW.track_batches IS NOT OLD.track_batches
      OR NEW.track_expiry IS NOT OLD.track_expiry OR NEW.track_serials IS NOT OLD.track_serials OR NEW.valuation_method IS NOT OLD.valuation_method)
  AND (EXISTS (SELECT 1 FROM inv_document_lines WHERE item_id = OLD.id) OR EXISTS (SELECT 1 FROM inv_batches WHERE item_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'item policy is locked after the item is used in documents'); END;
CREATE TRIGGER inv_items_no_delete_used BEFORE DELETE ON inv_items
WHEN EXISTS (SELECT 1 FROM inv_document_lines WHERE item_id = OLD.id) OR EXISTS (SELECT 1 FROM inv_moves WHERE item_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'an item with documents or movements cannot be deleted; deactivate it'); END;

-- ── وحدات الصنف البديلة: 1 وحدة = factor من وحدة الأساس (نجمة حول وحدة الأساس: لا دوران ولا غموض) ──
CREATE TABLE inv_item_units (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES inv_items (id),
  unit_id     INTEGER NOT NULL REFERENCES units (id),
  factor      TEXT NOT NULL CHECK ((factor <> '0' AND (factor = '0' OR ((factor GLOB '[1-9]*' OR factor GLOB '0.[0-9]*') AND factor NOT GLOB '*[^0-9.]*' AND factor NOT GLOB '*.*.*' AND factor NOT GLOB '*.' AND factor NOT GLOB '*.*0' AND (instr(factor, '.') = 0 OR length(factor) - instr(factor, '.') <= 8) AND (CASE WHEN instr(factor, '.') = 0 THEN length(factor) ELSE instr(factor, '.') - 1 END) <= 20)))),
  is_purchase INTEGER NOT NULL DEFAULT 1 CHECK (is_purchase IN (0, 1)),
  is_issue    INTEGER NOT NULL DEFAULT 1 CHECK (is_issue IN (0, 1)),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (item_id, unit_id)
) STRICT;
CREATE TRIGGER inv_item_units_not_base BEFORE INSERT ON inv_item_units
WHEN NEW.unit_id = (SELECT base_unit_id FROM inv_items WHERE id = NEW.item_id)
BEGIN SELECT RAISE(ABORT, 'the base unit has no conversion factor'); END;
CREATE TRIGGER inv_item_units_fixed BEFORE UPDATE OF item_id, unit_id ON inv_item_units
WHEN NEW.item_id IS NOT OLD.item_id OR NEW.unit_id IS NOT OLD.unit_id
BEGIN SELECT RAISE(ABORT, 'conversion identity is fixed'); END;
CREATE TRIGGER inv_item_units_no_delete BEFORE DELETE ON inv_item_units BEGIN SELECT RAISE(ABORT, 'conversions are kept; deactivate instead'); END;

-- ── المخازن والمواقع ونطاق المستخدم ──
CREATE TABLE inv_warehouses (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar        TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en        TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  branch_id      INTEGER NOT NULL REFERENCES branches (id),
  wh_type        TEXT NOT NULL CHECK (wh_type IN ('raw', 'packaging', 'wip', 'finished', 'spare_parts', 'quarantine', 'general')),
  keeper_user_id INTEGER REFERENCES users (id),
  notes          TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX inv_warehouses_branch ON inv_warehouses (branch_id);
CREATE TRIGGER inv_warehouses_branch_locked BEFORE UPDATE OF branch_id, wh_type ON inv_warehouses
WHEN (NEW.branch_id IS NOT OLD.branch_id OR NEW.wh_type IS NOT OLD.wh_type) AND EXISTS (SELECT 1 FROM inv_documents WHERE warehouse_id = OLD.id OR to_warehouse_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'warehouse branch and type are locked after the first document'); END;
CREATE TRIGGER inv_warehouses_no_delete_used BEFORE DELETE ON inv_warehouses
WHEN EXISTS (SELECT 1 FROM inv_documents WHERE warehouse_id = OLD.id OR to_warehouse_id = OLD.id) OR EXISTS (SELECT 1 FROM inv_moves WHERE warehouse_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'a warehouse with documents or movements cannot be deleted; deactivate it'); END;

CREATE TABLE inv_locations (
  id           INTEGER PRIMARY KEY,
  warehouse_id INTEGER NOT NULL REFERENCES inv_warehouses (id),
  code         TEXT NOT NULL CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar      TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en      TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (warehouse_id, code)
) STRICT;
CREATE TRIGGER inv_locations_fixed BEFORE UPDATE OF warehouse_id ON inv_locations WHEN NEW.warehouse_id IS NOT OLD.warehouse_id
BEGIN SELECT RAISE(ABORT, 'a location belongs to one warehouse'); END;
CREATE TRIGGER inv_locations_no_delete BEFORE DELETE ON inv_locations BEGIN SELECT RAISE(ABORT, 'locations are kept; deactivate instead'); END;

-- مستخدم له صفوف هنا مقيد بهذه المخازن (داخل نطاق فروعه)؛ بلا صفوف = كل مخازن فروعه
CREATE TABLE inv_user_warehouses (
  user_id      INTEGER NOT NULL REFERENCES users (id),
  warehouse_id INTEGER NOT NULL REFERENCES inv_warehouses (id),
  PRIMARY KEY (user_id, warehouse_id)
) STRICT, WITHOUT ROWID;

-- ── الدفعات والأرقام المسلسلة ──
CREATE TABLE inv_batches (
  id              INTEGER PRIMARY KEY,
  item_id         INTEGER NOT NULL REFERENCES inv_items (id),
  batch_no        TEXT NOT NULL CHECK (length(batch_no) BETWEEN 1 AND 60),
  production_date TEXT CHECK (production_date IS NULL OR (date(production_date) IS production_date)),
  expiry_date     TEXT CHECK (expiry_date IS NULL OR (date(expiry_date) IS expiry_date)),
  status          TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available', 'inspection', 'rejected', 'hold', 'quarantine')),
  initial_status  TEXT NOT NULL DEFAULT 'available' CHECK (initial_status IN ('available', 'inspection', 'rejected', 'hold', 'quarantine')),
  source_ref      TEXT CHECK (source_ref IS NULL OR length(source_ref) <= 120),   -- مصدر الدفعة (مورد/أمر إنتاج مستقبلًا)
  notes           TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  created_by      INTEGER NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (item_id, batch_no),
  CHECK (production_date IS NULL OR expiry_date IS NULL OR expiry_date >= production_date)
) STRICT;
CREATE INDEX inv_batches_expiry ON inv_batches (expiry_date);
CREATE TRIGGER inv_batches_rules BEFORE INSERT ON inv_batches
BEGIN
  SELECT RAISE(ABORT, 'item does not track batches') WHERE (SELECT track_batches FROM inv_items WHERE id = NEW.item_id) IS NOT 1;
  SELECT RAISE(ABORT, 'expiry date is required for this item') WHERE NEW.expiry_date IS NULL AND (SELECT track_expiry FROM inv_items WHERE id = NEW.item_id) = 1;
  SELECT RAISE(ABORT, 'a batch starts in its initial status') WHERE NEW.status <> NEW.initial_status;
END;
CREATE TRIGGER inv_batches_fixed BEFORE UPDATE OF item_id, batch_no, production_date, expiry_date, initial_status ON inv_batches
WHEN NEW.item_id IS NOT OLD.item_id OR NEW.batch_no IS NOT OLD.batch_no OR NEW.initial_status IS NOT OLD.initial_status
  OR ((NEW.production_date IS NOT OLD.production_date OR NEW.expiry_date IS NOT OLD.expiry_date) AND EXISTS (SELECT 1 FROM inv_moves WHERE batch_id = OLD.id))
BEGIN SELECT RAISE(ABORT, 'batch identity and dates are fixed after its first movement'); END;
CREATE TRIGGER inv_batches_no_delete BEFORE DELETE ON inv_batches
WHEN EXISTS (SELECT 1 FROM inv_moves WHERE batch_id = OLD.id) OR EXISTS (SELECT 1 FROM inv_document_lines WHERE batch_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'a used batch cannot be deleted'); END;

CREATE TABLE inv_serials (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES inv_items (id),
  serial_no    TEXT NOT NULL CHECK (length(serial_no) BETWEEN 1 AND 80),
  state        TEXT NOT NULL CHECK (state IN ('in_stock', 'out')),
  warehouse_id INTEGER REFERENCES inv_warehouses (id),
  location_id  INTEGER REFERENCES inv_locations (id),
  last_move_id INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (item_id, serial_no),
  CHECK ((state = 'in_stock') = (warehouse_id IS NOT NULL)),
  CHECK (state = 'in_stock' OR location_id IS NULL)
) STRICT;
CREATE INDEX inv_serials_place ON inv_serials (warehouse_id, item_id);
CREATE TRIGGER inv_serials_rules BEFORE INSERT ON inv_serials
BEGIN
  SELECT RAISE(ABORT, 'item does not track serial numbers') WHERE (SELECT track_serials FROM inv_items WHERE id = NEW.item_id) IS NOT 1;
  SELECT RAISE(ABORT, 'serial state follows its last movement') WHERE NOT EXISTS (SELECT 1 FROM inv_moves m WHERE m.id = NEW.last_move_id AND m.item_id = NEW.item_id AND m.direction = 'in' AND NEW.state = 'in_stock' AND m.warehouse_id = NEW.warehouse_id);
END;
CREATE TRIGGER inv_serials_follow_moves BEFORE UPDATE ON inv_serials
BEGIN
  SELECT RAISE(ABORT, 'serial identity is fixed') WHERE NEW.item_id IS NOT OLD.item_id OR NEW.serial_no IS NOT OLD.serial_no;
  SELECT RAISE(ABORT, 'serial state follows its last movement') WHERE NEW.last_move_id <= OLD.last_move_id OR NOT EXISTS
    (SELECT 1 FROM inv_moves m WHERE m.id = NEW.last_move_id AND m.item_id = NEW.item_id
       AND ((m.direction = 'in' AND NEW.state = 'in_stock' AND OLD.state = 'out' AND m.warehouse_id = NEW.warehouse_id AND m.location_id IS NEW.location_id)
         OR (m.direction = 'out' AND NEW.state = 'out' AND OLD.state = 'in_stock' AND m.warehouse_id = OLD.warehouse_id)));
END;
CREATE TRIGGER inv_serials_no_delete BEFORE DELETE ON inv_serials BEGIN SELECT RAISE(ABORT, 'serial history is kept'); END;

-- ── التحويلات بين الفروع (في الطريق) ──
CREATE TABLE inv_transfers (
  id                INTEGER PRIMARY KEY,
  dispatch_doc_id   INTEGER NOT NULL UNIQUE REFERENCES inv_documents (id),
  from_warehouse_id INTEGER NOT NULL REFERENCES inv_warehouses (id),
  to_warehouse_id   INTEGER NOT NULL REFERENCES inv_warehouses (id),
  from_branch_id    INTEGER NOT NULL REFERENCES branches (id),
  to_branch_id      INTEGER NOT NULL REFERENCES branches (id),
  status            TEXT NOT NULL DEFAULT 'in_transit' CHECK (status IN ('in_transit', 'partial', 'received', 'closed', 'cancelled')),
  closed_by         INTEGER,
  closed_at         TEXT,
  close_reason      TEXT CHECK (close_reason IS NULL OR length(trim(close_reason)) BETWEEN 3 AND 500),
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (from_warehouse_id <> to_warehouse_id),
  CHECK ((status = 'closed') = (close_reason IS NOT NULL))
) STRICT;
CREATE INDEX inv_transfers_status ON inv_transfers (status);
CREATE TRIGGER inv_transfers_no_delete BEFORE DELETE ON inv_transfers BEGIN SELECT RAISE(ABORT, 'transfer history is kept'); END;

-- سطر لكل حركة إرسال (صنف/دفعة)؛ المتبقي بالطريق = المرسل − المستلم − المرفوض − العجز (كمية وقيمة)
CREATE TABLE inv_transfer_lines (
  id               INTEGER PRIMARY KEY,
  transfer_id      INTEGER NOT NULL REFERENCES inv_transfers (id),
  dispatch_move_id INTEGER NOT NULL UNIQUE REFERENCES inv_moves (id),
  item_id          INTEGER NOT NULL REFERENCES inv_items (id),
  batch_id         INTEGER REFERENCES inv_batches (id),
  qty_sent         TEXT NOT NULL CHECK ((qty_sent <> '0' AND (qty_sent = '0' OR ((qty_sent GLOB '[1-9]*' OR qty_sent GLOB '0.[0-9]*') AND qty_sent NOT GLOB '*[^0-9.]*' AND qty_sent NOT GLOB '*.*.*' AND qty_sent NOT GLOB '*.' AND qty_sent NOT GLOB '*.*0' AND (instr(qty_sent, '.') = 0 OR length(qty_sent) - instr(qty_sent, '.') <= 8) AND (CASE WHEN instr(qty_sent, '.') = 0 THEN length(qty_sent) ELSE instr(qty_sent, '.') - 1 END) <= 20)))),
  value_sent       TEXT NOT NULL CHECK ((value_sent = '0' OR ((value_sent GLOB '[1-9]*' OR value_sent GLOB '0.[0-9]*') AND value_sent NOT GLOB '*[^0-9.]*' AND value_sent NOT GLOB '*.*.*' AND value_sent NOT GLOB '*.' AND value_sent NOT GLOB '*.*0' AND (instr(value_sent, '.') = 0 OR length(value_sent) - instr(value_sent, '.') <= 8) AND (CASE WHEN instr(value_sent, '.') = 0 THEN length(value_sent) ELSE instr(value_sent, '.') - 1 END) <= 20))),
  qty_received     TEXT NOT NULL DEFAULT '0' CHECK ((qty_received = '0' OR ((qty_received GLOB '[1-9]*' OR qty_received GLOB '0.[0-9]*') AND qty_received NOT GLOB '*[^0-9.]*' AND qty_received NOT GLOB '*.*.*' AND qty_received NOT GLOB '*.' AND qty_received NOT GLOB '*.*0' AND (instr(qty_received, '.') = 0 OR length(qty_received) - instr(qty_received, '.') <= 8) AND (CASE WHEN instr(qty_received, '.') = 0 THEN length(qty_received) ELSE instr(qty_received, '.') - 1 END) <= 20))),
  value_received   TEXT NOT NULL DEFAULT '0' CHECK ((value_received = '0' OR ((value_received GLOB '[1-9]*' OR value_received GLOB '0.[0-9]*') AND value_received NOT GLOB '*[^0-9.]*' AND value_received NOT GLOB '*.*.*' AND value_received NOT GLOB '*.' AND value_received NOT GLOB '*.*0' AND (instr(value_received, '.') = 0 OR length(value_received) - instr(value_received, '.') <= 8) AND (CASE WHEN instr(value_received, '.') = 0 THEN length(value_received) ELSE instr(value_received, '.') - 1 END) <= 20))),
  qty_rejected     TEXT NOT NULL DEFAULT '0' CHECK ((qty_rejected = '0' OR ((qty_rejected GLOB '[1-9]*' OR qty_rejected GLOB '0.[0-9]*') AND qty_rejected NOT GLOB '*[^0-9.]*' AND qty_rejected NOT GLOB '*.*.*' AND qty_rejected NOT GLOB '*.' AND qty_rejected NOT GLOB '*.*0' AND (instr(qty_rejected, '.') = 0 OR length(qty_rejected) - instr(qty_rejected, '.') <= 8) AND (CASE WHEN instr(qty_rejected, '.') = 0 THEN length(qty_rejected) ELSE instr(qty_rejected, '.') - 1 END) <= 20))),
  value_rejected   TEXT NOT NULL DEFAULT '0' CHECK ((value_rejected = '0' OR ((value_rejected GLOB '[1-9]*' OR value_rejected GLOB '0.[0-9]*') AND value_rejected NOT GLOB '*[^0-9.]*' AND value_rejected NOT GLOB '*.*.*' AND value_rejected NOT GLOB '*.' AND value_rejected NOT GLOB '*.*0' AND (instr(value_rejected, '.') = 0 OR length(value_rejected) - instr(value_rejected, '.') <= 8) AND (CASE WHEN instr(value_rejected, '.') = 0 THEN length(value_rejected) ELSE instr(value_rejected, '.') - 1 END) <= 20))),
  qty_short        TEXT NOT NULL DEFAULT '0' CHECK ((qty_short = '0' OR ((qty_short GLOB '[1-9]*' OR qty_short GLOB '0.[0-9]*') AND qty_short NOT GLOB '*[^0-9.]*' AND qty_short NOT GLOB '*.*.*' AND qty_short NOT GLOB '*.' AND qty_short NOT GLOB '*.*0' AND (instr(qty_short, '.') = 0 OR length(qty_short) - instr(qty_short, '.') <= 8) AND (CASE WHEN instr(qty_short, '.') = 0 THEN length(qty_short) ELSE instr(qty_short, '.') - 1 END) <= 20))),
  value_short      TEXT NOT NULL DEFAULT '0' CHECK ((value_short = '0' OR ((value_short GLOB '[1-9]*' OR value_short GLOB '0.[0-9]*') AND value_short NOT GLOB '*[^0-9.]*' AND value_short NOT GLOB '*.*.*' AND value_short NOT GLOB '*.' AND value_short NOT GLOB '*.*0' AND (instr(value_short, '.') = 0 OR length(value_short) - instr(value_short, '.') <= 8) AND (CASE WHEN instr(value_short, '.') = 0 THEN length(value_short) ELSE instr(value_short, '.') - 1 END) <= 20)))
) STRICT;
CREATE INDEX inv_transfer_lines_transfer ON inv_transfer_lines (transfer_id);
CREATE TRIGGER inv_transfer_lines_no_delete BEFORE DELETE ON inv_transfer_lines BEGIN SELECT RAISE(ABORT, 'transfer history is kept'); END;
CREATE TRIGGER inv_transfer_lines_fixed BEFORE UPDATE OF transfer_id, dispatch_move_id, item_id, batch_id, qty_sent, value_sent ON inv_transfer_lines
BEGIN SELECT RAISE(ABORT, 'dispatched quantities are fixed'); END;

-- ── الجرد ──
CREATE TABLE inv_counts (
  id                INTEGER PRIMARY KEY,
  number            TEXT NOT NULL UNIQUE CHECK (length(number) BETWEEN 3 AND 80),
  branch_id         INTEGER NOT NULL REFERENCES branches (id),
  warehouse_id      INTEGER NOT NULL REFERENCES inv_warehouses (id),
  group_id          INTEGER REFERENCES inv_groups (id),
  count_date        TEXT NOT NULL CHECK ((date(count_date) IS count_date)),
  status            TEXT NOT NULL DEFAULT 'counting' CHECK (status IN ('counting', 'review', 'approved', 'posted', 'cancelled')),
  blind             INTEGER NOT NULL DEFAULT 0 CHECK (blind IN (0, 1)),
  freeze            INTEGER NOT NULL DEFAULT 0 CHECK (freeze IN (0, 1)),   -- 1 = منع الحركات على أصناف الجلسة حتى الترحيل/الإلغاء
  cutoff_at         TEXT NOT NULL,                                       -- لحظة لقطة رصيد النظام
  snapshot_move_id  INTEGER NOT NULL CHECK (snapshot_move_id >= 0),      -- آخر حركة داخل اللقطة
  notes             TEXT CHECK (notes IS NULL OR length(notes) <= 500),
  created_by        INTEGER NOT NULL,
  created_at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  submitted_by      INTEGER, submitted_at TEXT,
  approved_by       INTEGER, approved_at TEXT,
  posted_by         INTEGER, posted_at TEXT,
  cancelled_by      INTEGER, cancelled_at TEXT,
  cancel_reason     TEXT CHECK (cancel_reason IS NULL OR length(trim(cancel_reason)) BETWEEN 3 AND 500),
  CHECK ((status = 'cancelled') = (cancel_reason IS NOT NULL)),
  CHECK (status NOT IN ('approved', 'posted') OR approved_by IS NOT NULL),
  CHECK (status <> 'posted' OR posted_by IS NOT NULL)
) STRICT;
CREATE UNIQUE INDEX inv_counts_one_open ON inv_counts (warehouse_id) WHERE status IN ('counting', 'review', 'approved');
CREATE TRIGGER inv_counts_no_delete BEFORE DELETE ON inv_counts BEGIN SELECT RAISE(ABORT, 'count history is kept; cancel instead'); END;
CREATE TRIGGER inv_counts_final BEFORE UPDATE ON inv_counts WHEN OLD.status IN ('posted', 'cancelled')
BEGIN SELECT RAISE(ABORT, 'a posted or cancelled count is final'); END;

CREATE TABLE inv_count_lines (
  id          INTEGER PRIMARY KEY,
  count_id    INTEGER NOT NULL REFERENCES inv_counts (id),
  item_id     INTEGER NOT NULL REFERENCES inv_items (id),
  location_id INTEGER REFERENCES inv_locations (id),
  batch_id    INTEGER REFERENCES inv_batches (id),
  system_qty  TEXT NOT NULL CHECK (((system_qty = '0' OR ((system_qty GLOB '[1-9]*' OR system_qty GLOB '0.[0-9]*') AND system_qty NOT GLOB '*[^0-9.]*' AND system_qty NOT GLOB '*.*.*' AND system_qty NOT GLOB '*.' AND system_qty NOT GLOB '*.*0' AND (instr(system_qty, '.') = 0 OR length(system_qty) - instr(system_qty, '.') <= 8) AND (CASE WHEN instr(system_qty, '.') = 0 THEN length(system_qty) ELSE instr(system_qty, '.') - 1 END) <= 20)) OR (system_qty GLOB '-*' AND (substr(system_qty, 2) <> '0' AND (substr(system_qty, 2) = '0' OR ((substr(system_qty, 2) GLOB '[1-9]*' OR substr(system_qty, 2) GLOB '0.[0-9]*') AND substr(system_qty, 2) NOT GLOB '*[^0-9.]*' AND substr(system_qty, 2) NOT GLOB '*.*.*' AND substr(system_qty, 2) NOT GLOB '*.' AND substr(system_qty, 2) NOT GLOB '*.*0' AND (instr(substr(system_qty, 2), '.') = 0 OR length(substr(system_qty, 2)) - instr(substr(system_qty, 2), '.') <= 8) AND (CASE WHEN instr(substr(system_qty, 2), '.') = 0 THEN length(substr(system_qty, 2)) ELSE instr(substr(system_qty, 2), '.') - 1 END) <= 20)))))),        -- رصيد النظام عند القطع
  unit_cost   TEXT CHECK (unit_cost IS NULL OR (unit_cost = '0' OR ((unit_cost GLOB '[1-9]*' OR unit_cost GLOB '0.[0-9]*') AND unit_cost NOT GLOB '*[^0-9.]*' AND unit_cost NOT GLOB '*.*.*' AND unit_cost NOT GLOB '*.' AND unit_cost NOT GLOB '*.*0' AND (instr(unit_cost, '.') = 0 OR length(unit_cost) - instr(unit_cost, '.') <= 10) AND (CASE WHEN instr(unit_cost, '.') = 0 THEN length(unit_cost) ELSE instr(unit_cost, '.') - 1 END) <= 20))),  -- متوسط التكلفة عند القطع (للتقدير؛ الترحيل بالتكلفة الفعلية)
  final_qty   TEXT CHECK (final_qty IS NULL OR (final_qty = '0' OR ((final_qty GLOB '[1-9]*' OR final_qty GLOB '0.[0-9]*') AND final_qty NOT GLOB '*[^0-9.]*' AND final_qty NOT GLOB '*.*.*' AND final_qty NOT GLOB '*.' AND final_qty NOT GLOB '*.*0' AND (instr(final_qty, '.') = 0 OR length(final_qty) - instr(final_qty, '.') <= 8) AND (CASE WHEN instr(final_qty, '.') = 0 THEN length(final_qty) ELSE instr(final_qty, '.') - 1 END) <= 20))),
  added       INTEGER NOT NULL DEFAULT 0 CHECK (added IN (0, 1)),       -- سطر أضيف أثناء العد (غير موجود في اللقطة)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE UNIQUE INDEX inv_count_lines_scope ON inv_count_lines (count_id, item_id, ifnull(location_id, 0), ifnull(batch_id, 0));
CREATE TRIGGER inv_count_lines_no_delete BEFORE DELETE ON inv_count_lines BEGIN SELECT RAISE(ABORT, 'count lines are kept'); END;
CREATE TRIGGER inv_count_lines_fixed BEFORE UPDATE OF count_id, item_id, location_id, batch_id, system_qty, unit_cost ON inv_count_lines
BEGIN SELECT RAISE(ABORT, 'count snapshot is fixed'); END;

-- كل عدّة في جولة مستقلة (1 = العد الأول، 2+ = إعادة العد)؛ لا تعديل ولا حذف
CREATE TABLE inv_count_entries (
  id         INTEGER PRIMARY KEY,
  line_id    INTEGER NOT NULL REFERENCES inv_count_lines (id),
  round      INTEGER NOT NULL CHECK (round BETWEEN 1 AND 9),
  qty        TEXT NOT NULL CHECK ((qty = '0' OR ((qty GLOB '[1-9]*' OR qty GLOB '0.[0-9]*') AND qty NOT GLOB '*[^0-9.]*' AND qty NOT GLOB '*.*.*' AND qty NOT GLOB '*.' AND qty NOT GLOB '*.*0' AND (instr(qty, '.') = 0 OR length(qty) - instr(qty, '.') <= 8) AND (CASE WHEN instr(qty, '.') = 0 THEN length(qty) ELSE instr(qty, '.') - 1 END) <= 20))),
  counted_by INTEGER NOT NULL,
  counted_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (line_id, round)
) STRICT;
CREATE TRIGGER inv_count_entries_no_update BEFORE UPDATE ON inv_count_entries BEGIN SELECT RAISE(ABORT, 'count entries are append-only'); END;
CREATE TRIGGER inv_count_entries_no_delete BEFORE DELETE ON inv_count_entries BEGIN SELECT RAISE(ABORT, 'count entries are append-only'); END;
CREATE TRIGGER inv_count_entries_open BEFORE INSERT ON inv_count_entries
WHEN (SELECT c.status FROM inv_count_lines l JOIN inv_counts c ON c.id = l.count_id WHERE l.id = NEW.line_id) <> 'counting'
BEGIN SELECT RAISE(ABORT, 'counting is closed for this session'); END;

-- ── المستندات المخزنية ──
CREATE TABLE inv_documents (
  id                 INTEGER PRIMARY KEY,
  doc_type           TEXT NOT NULL CHECK (doc_type IN ('opening', 'receipt', 'issue', 'transfer', 'transfer_out', 'transfer_in', 'adjust_in', 'adjust_out', 'return', 'quality', 'reversal')),
  status             TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted', 'cancelled')),
  branch_id          INTEGER NOT NULL REFERENCES branches (id),
  warehouse_id       INTEGER REFERENCES inv_warehouses (id),
  to_warehouse_id    INTEGER REFERENCES inv_warehouses (id),
  doc_date           TEXT NOT NULL CHECK ((date(doc_date) IS doc_date)),
  source_module      TEXT NOT NULL DEFAULT 'inventory' CHECK (source_module IN ('inventory', 'counts', 'purchases', 'sales', 'manufacturing')),
  external_ref       TEXT CHECK (external_ref IS NULL OR length(external_ref) <= 60),
  reason             TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 3 AND 500),
  notes              TEXT CHECK (notes IS NULL OR length(notes) <= 1000),
  counter_account_id INTEGER REFERENCES accounts (id),
  cost_center_id     INTEGER REFERENCES cost_centers (id),
  reverses_id        INTEGER UNIQUE REFERENCES inv_documents (id),
  return_of_id       INTEGER REFERENCES inv_documents (id),
  transfer_id        INTEGER REFERENCES inv_transfers (id),
  count_id           INTEGER REFERENCES inv_counts (id),
  override_reason    TEXT CHECK (override_reason IS NULL OR length(trim(override_reason)) BETWEEN 3 AND 500),
  negative_reason    TEXT CHECK (negative_reason IS NULL OR length(trim(negative_reason)) BETWEEN 3 AND 500),
  series_id          INTEGER REFERENCES document_series (id),
  number             TEXT UNIQUE CHECK (number IS NULL OR length(number) BETWEEN 3 AND 80),
  fiscal_year_id     INTEGER REFERENCES fiscal_years (id),
  fiscal_period_id   INTEGER REFERENCES fiscal_periods (id),
  total_value        TEXT NOT NULL DEFAULT '0' CHECK ((total_value = '0' OR ((total_value GLOB '[1-9]*' OR total_value GLOB '0.[0-9]*') AND total_value NOT GLOB '*[^0-9.]*' AND total_value NOT GLOB '*.*.*' AND total_value NOT GLOB '*.' AND total_value NOT GLOB '*.*0' AND (instr(total_value, '.') = 0 OR length(total_value) - instr(total_value, '.') <= 8) AND (CASE WHEN instr(total_value, '.') = 0 THEN length(total_value) ELSE instr(total_value, '.') - 1 END) <= 20))),
  gl_number          TEXT UNIQUE CHECK (gl_number IS NULL OR length(gl_number) BETWEEN 3 AND 80),
  gl_total           TEXT CHECK (gl_total IS NULL OR (gl_total = '0' OR ((gl_total GLOB '[1-9]*' OR gl_total GLOB '0.[0-9]*') AND gl_total NOT GLOB '*[^0-9.]*' AND gl_total NOT GLOB '*.*.*' AND gl_total NOT GLOB '*.' AND gl_total NOT GLOB '*.*0' AND (instr(gl_total, '.') = 0 OR length(gl_total) - instr(gl_total, '.') <= 8) AND (CASE WHEN instr(gl_total, '.') = 0 THEN length(gl_total) ELSE instr(gl_total, '.') - 1 END) <= 20))),
  created_by         INTEGER NOT NULL,
  created_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by         INTEGER,
  updated_at         TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  approved_by        INTEGER, approved_at TEXT,
  posted_by          INTEGER, posted_at TEXT,
  cancelled_by       INTEGER, cancelled_at TEXT,
  CHECK ((status = 'posted') = (number IS NOT NULL)),
  CHECK ((status = 'posted') = (posted_by IS NOT NULL AND posted_at IS NOT NULL AND fiscal_period_id IS NOT NULL AND series_id IS NOT NULL)),
  CHECK ((status = 'cancelled') = (cancelled_by IS NOT NULL)),
  CHECK ((doc_type = 'reversal') = (reverses_id IS NOT NULL)),
  CHECK (doc_type <> 'reversal' OR reason IS NOT NULL),
  CHECK ((doc_type IN ('transfer', 'transfer_out')) = (to_warehouse_id IS NOT NULL)),
  CHECK (to_warehouse_id IS NULL OR to_warehouse_id <> warehouse_id),
  CHECK (doc_type IN ('quality', 'reversal') OR warehouse_id IS NOT NULL),
  CHECK (transfer_id IS NULL OR doc_type = 'transfer_in'),
  CHECK (return_of_id IS NULL OR doc_type = 'return'),
  CHECK ((gl_number IS NULL) = (gl_total IS NULL))
) STRICT;
CREATE INDEX inv_documents_list ON inv_documents (status, doc_date);
CREATE INDEX inv_documents_branch ON inv_documents (branch_id, doc_type);
CREATE INDEX inv_documents_warehouse ON inv_documents (warehouse_id);
CREATE INDEX inv_documents_transfer ON inv_documents (transfer_id);
CREATE INDEX inv_documents_count ON inv_documents (count_id);
CREATE INDEX inv_documents_period ON inv_documents (fiscal_period_id);
CREATE TRIGGER inv_documents_insert_rules BEFORE INSERT ON inv_documents
BEGIN
  SELECT RAISE(ABORT, 'inventory documents are created as drafts') WHERE NEW.status <> 'draft' OR NEW.number IS NOT NULL OR NEW.gl_number IS NOT NULL;
  SELECT RAISE(ABORT, 'warehouse belongs to the document branch') WHERE NEW.warehouse_id IS NOT NULL
    AND (SELECT branch_id FROM inv_warehouses WHERE id = NEW.warehouse_id) IS NOT NEW.branch_id;
  SELECT RAISE(ABORT, 'warehouse transfers stay within one branch') WHERE NEW.doc_type = 'transfer'
    AND (SELECT branch_id FROM inv_warehouses WHERE id = NEW.to_warehouse_id) IS NOT NEW.branch_id;
  SELECT RAISE(ABORT, 'branch transfers go to another branch') WHERE NEW.doc_type = 'transfer_out'
    AND (SELECT branch_id FROM inv_warehouses WHERE id = NEW.to_warehouse_id) IS NEW.branch_id;
END;
-- المرحّل والملغى ثابتان؛ الاستثناء الوحيد: ربط القيد المحاسبي مرة واحدة داخل معاملة الترحيل نفسها
CREATE TRIGGER inv_documents_frozen BEFORE UPDATE ON inv_documents WHEN OLD.status IN ('posted', 'cancelled')
BEGIN
  SELECT RAISE(ABORT, 'posted inventory documents cannot be modified; reverse instead') WHERE NOT (
    OLD.status = 'posted' AND OLD.gl_number IS NULL AND NEW.gl_number IS NOT NULL
    AND NEW.status = OLD.status AND NEW.number = OLD.number AND NEW.doc_type = OLD.doc_type AND NEW.doc_date = OLD.doc_date
    AND NEW.branch_id = OLD.branch_id AND NEW.warehouse_id IS OLD.warehouse_id AND NEW.to_warehouse_id IS OLD.to_warehouse_id
    AND NEW.total_value = OLD.total_value AND NEW.counter_account_id IS OLD.counter_account_id AND NEW.cost_center_id IS OLD.cost_center_id
    AND NEW.reverses_id IS OLD.reverses_id AND NEW.fiscal_period_id = OLD.fiscal_period_id AND NEW.posted_at = OLD.posted_at);
END;
CREATE TRIGGER inv_documents_post_rules BEFORE UPDATE OF status ON inv_documents WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'a posted document needs at least one line') WHERE NOT EXISTS (SELECT 1 FROM inv_document_lines WHERE doc_id = NEW.id);
  SELECT RAISE(ABORT, 'inventory posting period must be open and contain the document date') WHERE NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.status = 'open' AND NEW.doc_date BETWEEN p.start_date AND p.end_date);
  SELECT RAISE(ABORT, 'fiscal year is closed for this branch') WHERE EXISTS
    (SELECT 1 FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id
      WHERE c.branch_id = NEW.branch_id AND c.status = 'active' AND NEW.doc_date <= y.end_date);
  SELECT RAISE(ABORT, 'a document is reversed once, after it was posted') WHERE NEW.reverses_id IS NOT NULL
    AND (SELECT status FROM inv_documents WHERE id = NEW.reverses_id) IS NOT 'posted';
  SELECT RAISE(ABORT, 'a reversal cannot be reversed') WHERE NEW.reverses_id IS NOT NULL
    AND (SELECT doc_type FROM inv_documents WHERE id = NEW.reverses_id) = 'reversal';
END;
CREATE TRIGGER inv_documents_no_delete BEFORE DELETE ON inv_documents BEGIN SELECT RAISE(ABORT, 'inventory documents cannot be deleted; cancel the draft instead'); END;

CREATE TABLE inv_document_lines (
  id              INTEGER PRIMARY KEY,
  doc_id          INTEGER NOT NULL REFERENCES inv_documents (id),
  line_no         INTEGER NOT NULL CHECK (line_no BETWEEN 1 AND 9999),
  item_id         INTEGER NOT NULL REFERENCES inv_items (id),
  unit_id         INTEGER NOT NULL REFERENCES units (id),
  qty             TEXT NOT NULL CHECK ((qty = '0' OR ((qty GLOB '[1-9]*' OR qty GLOB '0.[0-9]*') AND qty NOT GLOB '*[^0-9.]*' AND qty NOT GLOB '*.*.*' AND qty NOT GLOB '*.' AND qty NOT GLOB '*.*0' AND (instr(qty, '.') = 0 OR length(qty) - instr(qty, '.') <= 8) AND (CASE WHEN instr(qty, '.') = 0 THEN length(qty) ELSE instr(qty, '.') - 1 END) <= 20))),              -- بوحدة المستند (0 مسموح فقط لسطر الجودة/الاستلام برفض كامل)
  factor          TEXT NOT NULL DEFAULT '1' CHECK ((factor <> '0' AND (factor = '0' OR ((factor GLOB '[1-9]*' OR factor GLOB '0.[0-9]*') AND factor NOT GLOB '*[^0-9.]*' AND factor NOT GLOB '*.*.*' AND factor NOT GLOB '*.' AND factor NOT GLOB '*.*0' AND (instr(factor, '.') = 0 OR length(factor) - instr(factor, '.') <= 8) AND (CASE WHEN instr(factor, '.') = 0 THEN length(factor) ELSE instr(factor, '.') - 1 END) <= 20)))),  -- لقطة عامل التحويل وقت الحفظ/الترحيل
  base_qty        TEXT NOT NULL CHECK ((base_qty = '0' OR ((base_qty GLOB '[1-9]*' OR base_qty GLOB '0.[0-9]*') AND base_qty NOT GLOB '*[^0-9.]*' AND base_qty NOT GLOB '*.*.*' AND base_qty NOT GLOB '*.' AND base_qty NOT GLOB '*.*0' AND (instr(base_qty, '.') = 0 OR length(base_qty) - instr(base_qty, '.') <= 8) AND (CASE WHEN instr(base_qty, '.') = 0 THEN length(base_qty) ELSE instr(base_qty, '.') - 1 END) <= 20))),
  unit_cost       TEXT CHECK (unit_cost IS NULL OR (unit_cost = '0' OR ((unit_cost GLOB '[1-9]*' OR unit_cost GLOB '0.[0-9]*') AND unit_cost NOT GLOB '*[^0-9.]*' AND unit_cost NOT GLOB '*.*.*' AND unit_cost NOT GLOB '*.' AND unit_cost NOT GLOB '*.*0' AND (instr(unit_cost, '.') = 0 OR length(unit_cost) - instr(unit_cost, '.') <= 10) AND (CASE WHEN instr(unit_cost, '.') = 0 THEN length(unit_cost) ELSE instr(unit_cost, '.') - 1 END) <= 20))),   -- تكلفة وحدة المستند (إضافة/افتتاحي/تسوية زيادة)
  value           TEXT CHECK (value IS NULL OR (value = '0' OR ((value GLOB '[1-9]*' OR value GLOB '0.[0-9]*') AND value NOT GLOB '*[^0-9.]*' AND value NOT GLOB '*.*.*' AND value NOT GLOB '*.' AND value NOT GLOB '*.*0' AND (instr(value, '.') = 0 OR length(value) - instr(value, '.') <= 8) AND (CASE WHEN instr(value, '.') = 0 THEN length(value) ELSE instr(value, '.') - 1 END) <= 20))),             -- القيمة الفعلية عند الترحيل
  location_id     INTEGER REFERENCES inv_locations (id),
  to_location_id  INTEGER REFERENCES inv_locations (id),
  batch_id        INTEGER REFERENCES inv_batches (id),
  batch_no        TEXT CHECK (batch_no IS NULL OR length(batch_no) BETWEEN 1 AND 60),   -- دفعة جديدة في مستند إضافة
  production_date TEXT CHECK (production_date IS NULL OR (date(production_date) IS production_date)),
  expiry_date     TEXT CHECK (expiry_date IS NULL OR (date(expiry_date) IS expiry_date)),
  to_status       TEXT CHECK (to_status IS NULL OR to_status IN ('available', 'inspection', 'rejected', 'hold', 'quarantine')),
  from_status     TEXT CHECK (from_status IS NULL OR from_status IN ('available', 'inspection', 'rejected', 'hold', 'quarantine')),
  reservation_id  INTEGER REFERENCES inv_reservations (id),
  ref_line_id     INTEGER REFERENCES inv_document_lines (id),     -- سطر المستند الأصلي (مرتجع / عكس)
  transfer_line_id INTEGER REFERENCES inv_transfer_lines (id),    -- استلام تحويل
  qty_rejected    TEXT NOT NULL DEFAULT '0' CHECK ((qty_rejected = '0' OR ((qty_rejected GLOB '[1-9]*' OR qty_rejected GLOB '0.[0-9]*') AND qty_rejected NOT GLOB '*[^0-9.]*' AND qty_rejected NOT GLOB '*.*.*' AND qty_rejected NOT GLOB '*.' AND qty_rejected NOT GLOB '*.*0' AND (instr(qty_rejected, '.') = 0 OR length(qty_rejected) - instr(qty_rejected, '.') <= 8) AND (CASE WHEN instr(qty_rejected, '.') = 0 THEN length(qty_rejected) ELSE instr(qty_rejected, '.') - 1 END) <= 20))),   -- استلام تحويل: مرفوض إلى مخزن الحجر
  serials         TEXT CHECK (serials IS NULL OR (json_valid(serials) AND json_type(serials) = 'array')),
  override_fefo   INTEGER NOT NULL DEFAULT 0 CHECK (override_fefo IN (0, 1)),
  notes           TEXT CHECK (notes IS NULL OR length(notes) <= 300),
  UNIQUE (doc_id, line_no)
) STRICT;
CREATE INDEX inv_document_lines_doc ON inv_document_lines (doc_id);
CREATE INDEX inv_document_lines_item ON inv_document_lines (item_id);
CREATE INDEX inv_document_lines_ref ON inv_document_lines (ref_line_id);
CREATE INDEX inv_document_lines_batch ON inv_document_lines (batch_id) WHERE batch_id IS NOT NULL;
CREATE TRIGGER inv_document_lines_draft_ins BEFORE INSERT ON inv_document_lines
WHEN (SELECT status FROM inv_documents WHERE id = NEW.doc_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'lines are editable in drafts only'); END;
CREATE TRIGGER inv_document_lines_draft_upd BEFORE UPDATE ON inv_document_lines
WHEN (SELECT status FROM inv_documents WHERE id = OLD.doc_id) IS NOT 'draft' OR NEW.doc_id IS NOT OLD.doc_id
BEGIN SELECT RAISE(ABORT, 'lines are editable in drafts only'); END;
CREATE TRIGGER inv_document_lines_draft_del BEFORE DELETE ON inv_document_lines
WHEN (SELECT status FROM inv_documents WHERE id = OLD.doc_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'lines are editable in drafts only'); END;

-- ── سجل حركات المخزون (غير قابل للتعديل؛ المحرك المركزي وحده يكتب فيه داخل معاملة ترحيل مستند) ──
CREATE TABLE inv_moves (
  id                   INTEGER PRIMARY KEY,
  doc_id               INTEGER NOT NULL REFERENCES inv_documents (id),
  line_id              INTEGER NOT NULL REFERENCES inv_document_lines (id),
  move_date            TEXT NOT NULL CHECK ((date(move_date) IS move_date)),
  branch_id            INTEGER NOT NULL REFERENCES branches (id),
  warehouse_id         INTEGER NOT NULL REFERENCES inv_warehouses (id),
  location_id          INTEGER REFERENCES inv_locations (id),
  item_id              INTEGER NOT NULL REFERENCES inv_items (id),
  batch_id             INTEGER REFERENCES inv_batches (id),
  direction            TEXT NOT NULL CHECK (direction IN ('in', 'out')),
  qty                  TEXT NOT NULL CHECK ((qty <> '0' AND (qty = '0' OR ((qty GLOB '[1-9]*' OR qty GLOB '0.[0-9]*') AND qty NOT GLOB '*[^0-9.]*' AND qty NOT GLOB '*.*.*' AND qty NOT GLOB '*.' AND qty NOT GLOB '*.*0' AND (instr(qty, '.') = 0 OR length(qty) - instr(qty, '.') <= 8) AND (CASE WHEN instr(qty, '.') = 0 THEN length(qty) ELSE instr(qty, '.') - 1 END) <= 20)))),           -- بوحدة الأساس
  value                TEXT NOT NULL CHECK ((value = '0' OR ((value GLOB '[1-9]*' OR value GLOB '0.[0-9]*') AND value NOT GLOB '*[^0-9.]*' AND value NOT GLOB '*.*.*' AND value NOT GLOB '*.' AND value NOT GLOB '*.*0' AND (instr(value, '.') = 0 OR length(value) - instr(value, '.') <= 8) AND (CASE WHEN instr(value, '.') = 0 THEN length(value) ELSE instr(value, '.') - 1 END) <= 20))),          -- بالعملة الأساسية (لقطة وقت الترحيل)
  unit_cost            TEXT NOT NULL CHECK ((unit_cost = '0' OR ((unit_cost GLOB '[1-9]*' OR unit_cost GLOB '0.[0-9]*') AND unit_cost NOT GLOB '*[^0-9.]*' AND unit_cost NOT GLOB '*.*.*' AND unit_cost NOT GLOB '*.' AND unit_cost NOT GLOB '*.*0' AND (instr(unit_cost, '.') = 0 OR length(unit_cost) - instr(unit_cost, '.') <= 10) AND (CASE WHEN instr(unit_cost, '.') = 0 THEN length(unit_cost) ELSE instr(unit_cost, '.') - 1 END) <= 20))),     -- value ÷ qty (للعرض؛ القيمة هي المرجع)
  pool_qty_after       TEXT NOT NULL CHECK (((pool_qty_after = '0' OR ((pool_qty_after GLOB '[1-9]*' OR pool_qty_after GLOB '0.[0-9]*') AND pool_qty_after NOT GLOB '*[^0-9.]*' AND pool_qty_after NOT GLOB '*.*.*' AND pool_qty_after NOT GLOB '*.' AND pool_qty_after NOT GLOB '*.*0' AND (instr(pool_qty_after, '.') = 0 OR length(pool_qty_after) - instr(pool_qty_after, '.') <= 8) AND (CASE WHEN instr(pool_qty_after, '.') = 0 THEN length(pool_qty_after) ELSE instr(pool_qty_after, '.') - 1 END) <= 20)) OR (pool_qty_after GLOB '-*' AND (substr(pool_qty_after, 2) <> '0' AND (substr(pool_qty_after, 2) = '0' OR ((substr(pool_qty_after, 2) GLOB '[1-9]*' OR substr(pool_qty_after, 2) GLOB '0.[0-9]*') AND substr(pool_qty_after, 2) NOT GLOB '*[^0-9.]*' AND substr(pool_qty_after, 2) NOT GLOB '*.*.*' AND substr(pool_qty_after, 2) NOT GLOB '*.' AND substr(pool_qty_after, 2) NOT GLOB '*.*0' AND (instr(substr(pool_qty_after, 2), '.') = 0 OR length(substr(pool_qty_after, 2)) - instr(substr(pool_qty_after, 2), '.') <= 8) AND (CASE WHEN instr(substr(pool_qty_after, 2), '.') = 0 THEN length(substr(pool_qty_after, 2)) ELSE instr(substr(pool_qty_after, 2), '.') - 1 END) <= 20)))))),
  pool_value_after     TEXT NOT NULL CHECK (((pool_value_after = '0' OR ((pool_value_after GLOB '[1-9]*' OR pool_value_after GLOB '0.[0-9]*') AND pool_value_after NOT GLOB '*[^0-9.]*' AND pool_value_after NOT GLOB '*.*.*' AND pool_value_after NOT GLOB '*.' AND pool_value_after NOT GLOB '*.*0' AND (instr(pool_value_after, '.') = 0 OR length(pool_value_after) - instr(pool_value_after, '.') <= 8) AND (CASE WHEN instr(pool_value_after, '.') = 0 THEN length(pool_value_after) ELSE instr(pool_value_after, '.') - 1 END) <= 20)) OR (pool_value_after GLOB '-*' AND (substr(pool_value_after, 2) <> '0' AND (substr(pool_value_after, 2) = '0' OR ((substr(pool_value_after, 2) GLOB '[1-9]*' OR substr(pool_value_after, 2) GLOB '0.[0-9]*') AND substr(pool_value_after, 2) NOT GLOB '*[^0-9.]*' AND substr(pool_value_after, 2) NOT GLOB '*.*.*' AND substr(pool_value_after, 2) NOT GLOB '*.' AND substr(pool_value_after, 2) NOT GLOB '*.*0' AND (instr(substr(pool_value_after, 2), '.') = 0 OR length(substr(pool_value_after, 2)) - instr(substr(pool_value_after, 2), '.') <= 8) AND (CASE WHEN instr(substr(pool_value_after, 2), '.') = 0 THEN length(substr(pool_value_after, 2)) ELSE instr(substr(pool_value_after, 2), '.') - 1 END) <= 20)))))),
  inventory_account_id INTEGER REFERENCES accounts (id),                 -- لقطة حساب المخزون للمطابقة مع الأستاذ
  quality_status       TEXT CHECK (quality_status IS NULL OR quality_status IN ('available', 'inspection', 'rejected', 'hold', 'quarantine')),
  posts_gl             INTEGER NOT NULL CHECK (posts_gl IN (0, 1)),      -- 0 = بلا أثر محاسبي (افتتاحي بلا حساب مقابل / تحويل داخلي)
  reverses_move_id     INTEGER UNIQUE REFERENCES inv_moves (id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE INDEX inv_moves_pool ON inv_moves (item_id, warehouse_id, batch_id, id);
CREATE INDEX inv_moves_item_date ON inv_moves (item_id, move_date, id);
CREATE INDEX inv_moves_wh_date ON inv_moves (warehouse_id, move_date);
CREATE INDEX inv_moves_date ON inv_moves (move_date);
CREATE INDEX inv_moves_doc ON inv_moves (doc_id);
CREATE INDEX inv_moves_line ON inv_moves (line_id);
CREATE INDEX inv_moves_batch ON inv_moves (batch_id);
CREATE INDEX inv_moves_recon ON inv_moves (branch_id, inventory_account_id, move_date);
CREATE TRIGGER inv_moves_insert_rules BEFORE INSERT ON inv_moves
BEGIN
  SELECT RAISE(ABORT, 'stock movements are written by the inventory engine for a posted document only') WHERE NOT EXISTS
    (SELECT 1 FROM inv_documents d JOIN inv_document_lines l ON l.doc_id = d.id
      WHERE d.id = NEW.doc_id AND d.status = 'posted' AND d.gl_number IS NULL AND d.doc_date = NEW.move_date
        AND l.id = NEW.line_id AND l.item_id = NEW.item_id);
  SELECT RAISE(ABORT, 'movement warehouse branch mismatch') WHERE (SELECT branch_id FROM inv_warehouses WHERE id = NEW.warehouse_id) IS NOT NEW.branch_id;
  SELECT RAISE(ABORT, 'location belongs to another warehouse') WHERE NEW.location_id IS NOT NULL
    AND (SELECT warehouse_id FROM inv_locations WHERE id = NEW.location_id) IS NOT NEW.warehouse_id;
  SELECT RAISE(ABORT, 'batch belongs to another item') WHERE NEW.batch_id IS NOT NULL AND (SELECT item_id FROM inv_batches WHERE id = NEW.batch_id) IS NOT NEW.item_id;
  SELECT RAISE(ABORT, 'batch is required for this item') WHERE NEW.batch_id IS NULL AND (SELECT track_batches FROM inv_items WHERE id = NEW.item_id) = 1;
  SELECT RAISE(ABORT, 'non-stock items have no stock movements') WHERE (SELECT is_stock FROM inv_items WHERE id = NEW.item_id) IS NOT 1;
  SELECT RAISE(ABORT, 'a movement is reversed once by its mirror') WHERE NEW.reverses_move_id IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM inv_moves o WHERE o.id = NEW.reverses_move_id AND o.item_id = NEW.item_id AND o.warehouse_id = NEW.warehouse_id
       AND o.batch_id IS NEW.batch_id AND o.qty = NEW.qty AND o.value = NEW.value AND o.direction <> NEW.direction);
END;
CREATE TRIGGER inv_moves_no_update BEFORE UPDATE ON inv_moves BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;
CREATE TRIGGER inv_moves_no_delete BEFORE DELETE ON inv_moves BEGIN SELECT RAISE(ABORT, 'stock movements are immutable'); END;

CREATE TABLE inv_move_serials (
  move_id   INTEGER NOT NULL REFERENCES inv_moves (id),
  serial_id INTEGER NOT NULL REFERENCES inv_serials (id),
  PRIMARY KEY (move_id, serial_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX inv_move_serials_serial ON inv_move_serials (serial_id);
CREATE TRIGGER inv_move_serials_no_update BEFORE UPDATE ON inv_move_serials BEGIN SELECT RAISE(ABORT, 'serial movements are immutable'); END;
CREATE TRIGGER inv_move_serials_no_delete BEFORE DELETE ON inv_move_serials BEGIN SELECT RAISE(ABORT, 'serial movements are immutable'); END;

-- ── الملخصات المشتقة: الرصيد (صنف/مخزن/موقع/دفعة) ومجمع التكلفة (صنف/مخزن/دفعة) ──
CREATE TABLE inv_balances (
  item_id      INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  loc_key      INTEGER NOT NULL,   -- 0 = بلا موقع
  batch_key    INTEGER NOT NULL,   -- 0 = بلا دفعة
  qty          TEXT NOT NULL CHECK (((qty = '0' OR ((qty GLOB '[1-9]*' OR qty GLOB '0.[0-9]*') AND qty NOT GLOB '*[^0-9.]*' AND qty NOT GLOB '*.*.*' AND qty NOT GLOB '*.' AND qty NOT GLOB '*.*0' AND (instr(qty, '.') = 0 OR length(qty) - instr(qty, '.') <= 8) AND (CASE WHEN instr(qty, '.') = 0 THEN length(qty) ELSE instr(qty, '.') - 1 END) <= 20)) OR (qty GLOB '-*' AND (substr(qty, 2) <> '0' AND (substr(qty, 2) = '0' OR ((substr(qty, 2) GLOB '[1-9]*' OR substr(qty, 2) GLOB '0.[0-9]*') AND substr(qty, 2) NOT GLOB '*[^0-9.]*' AND substr(qty, 2) NOT GLOB '*.*.*' AND substr(qty, 2) NOT GLOB '*.' AND substr(qty, 2) NOT GLOB '*.*0' AND (instr(substr(qty, 2), '.') = 0 OR length(substr(qty, 2)) - instr(substr(qty, 2), '.') <= 8) AND (CASE WHEN instr(substr(qty, 2), '.') = 0 THEN length(substr(qty, 2)) ELSE instr(substr(qty, 2), '.') - 1 END) <= 20)))))),
  last_move_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, warehouse_id, loc_key, batch_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX inv_balances_wh ON inv_balances (warehouse_id, item_id);
CREATE TABLE inv_pools (
  item_id      INTEGER NOT NULL,
  warehouse_id INTEGER NOT NULL,
  batch_key    INTEGER NOT NULL,
  qty          TEXT NOT NULL CHECK (((qty = '0' OR ((qty GLOB '[1-9]*' OR qty GLOB '0.[0-9]*') AND qty NOT GLOB '*[^0-9.]*' AND qty NOT GLOB '*.*.*' AND qty NOT GLOB '*.' AND qty NOT GLOB '*.*0' AND (instr(qty, '.') = 0 OR length(qty) - instr(qty, '.') <= 8) AND (CASE WHEN instr(qty, '.') = 0 THEN length(qty) ELSE instr(qty, '.') - 1 END) <= 20)) OR (qty GLOB '-*' AND (substr(qty, 2) <> '0' AND (substr(qty, 2) = '0' OR ((substr(qty, 2) GLOB '[1-9]*' OR substr(qty, 2) GLOB '0.[0-9]*') AND substr(qty, 2) NOT GLOB '*[^0-9.]*' AND substr(qty, 2) NOT GLOB '*.*.*' AND substr(qty, 2) NOT GLOB '*.' AND substr(qty, 2) NOT GLOB '*.*0' AND (instr(substr(qty, 2), '.') = 0 OR length(substr(qty, 2)) - instr(substr(qty, 2), '.') <= 8) AND (CASE WHEN instr(substr(qty, 2), '.') = 0 THEN length(substr(qty, 2)) ELSE instr(substr(qty, 2), '.') - 1 END) <= 20)))))),
  value        TEXT NOT NULL CHECK (((value = '0' OR ((value GLOB '[1-9]*' OR value GLOB '0.[0-9]*') AND value NOT GLOB '*[^0-9.]*' AND value NOT GLOB '*.*.*' AND value NOT GLOB '*.' AND value NOT GLOB '*.*0' AND (instr(value, '.') = 0 OR length(value) - instr(value, '.') <= 8) AND (CASE WHEN instr(value, '.') = 0 THEN length(value) ELSE instr(value, '.') - 1 END) <= 20)) OR (value GLOB '-*' AND (substr(value, 2) <> '0' AND (substr(value, 2) = '0' OR ((substr(value, 2) GLOB '[1-9]*' OR substr(value, 2) GLOB '0.[0-9]*') AND substr(value, 2) NOT GLOB '*[^0-9.]*' AND substr(value, 2) NOT GLOB '*.*.*' AND substr(value, 2) NOT GLOB '*.' AND substr(value, 2) NOT GLOB '*.*0' AND (instr(substr(value, 2), '.') = 0 OR length(substr(value, 2)) - instr(substr(value, 2), '.') <= 8) AND (CASE WHEN instr(substr(value, 2), '.') = 0 THEN length(substr(value, 2)) ELSE instr(substr(value, 2), '.') - 1 END) <= 20)))))),
  last_move_id INTEGER NOT NULL,
  PRIMARY KEY (item_id, warehouse_id, batch_key)
) STRICT, WITHOUT ROWID;
CREATE INDEX inv_pools_wh ON inv_pools (warehouse_id, item_id);

CREATE TRIGGER inv_moves_apply AFTER INSERT ON inv_moves
BEGIN
  INSERT INTO inv_balances (item_id, warehouse_id, loc_key, batch_key, qty, last_move_id)
  VALUES (NEW.item_id, NEW.warehouse_id, ifnull(NEW.location_id, 0), ifnull(NEW.batch_id, 0), CASE NEW.direction WHEN 'in' THEN NEW.qty ELSE '-' || NEW.qty END, NEW.id)
  ON CONFLICT (item_id, warehouse_id, loc_key, batch_key) DO UPDATE SET qty = dec_add(qty, excluded.qty), last_move_id = excluded.last_move_id;
  INSERT INTO inv_pools (item_id, warehouse_id, batch_key, qty, value, last_move_id)
  VALUES (NEW.item_id, NEW.warehouse_id, ifnull(NEW.batch_id, 0), CASE NEW.direction WHEN 'in' THEN NEW.qty ELSE '-' || NEW.qty END,
          CASE WHEN NEW.direction = 'in' OR NEW.value = '0' THEN NEW.value ELSE '-' || NEW.value END, NEW.id)
  ON CONFLICT (item_id, warehouse_id, batch_key) DO UPDATE SET qty = dec_add(qty, excluded.qty), value = dec_add(value, excluded.value), last_move_id = excluded.last_move_id;
  SELECT RAISE(ABORT, 'movement pool snapshot does not match the pool') WHERE NOT EXISTS
    (SELECT 1 FROM inv_pools p WHERE p.item_id = NEW.item_id AND p.warehouse_id = NEW.warehouse_id AND p.batch_key = ifnull(NEW.batch_id, 0)
       AND p.qty = NEW.pool_qty_after AND p.value = NEW.pool_value_after);
END;
-- حراس الكتابة المباشرة: كل إدراج/تحديث يجب أن يطابق آخر حركة بالضبط (إلا أثناء إعادة البناء المضبوطة)
CREATE TRIGGER inv_balances_guard_ins BEFORE INSERT ON inv_balances
WHEN (SELECT rebuilding FROM inv_settings WHERE id = 1) = 0 AND NOT EXISTS
  (SELECT 1 FROM inv_moves m WHERE m.id = NEW.last_move_id AND m.id = (SELECT max(id) FROM inv_moves) AND m.item_id = NEW.item_id AND m.warehouse_id = NEW.warehouse_id
     AND ifnull(m.location_id, 0) = NEW.loc_key AND ifnull(m.batch_id, 0) = NEW.batch_key AND NEW.qty = (CASE m.direction WHEN 'in' THEN m.qty ELSE '-' || m.qty END))
BEGIN SELECT RAISE(ABORT, 'stock balances are derived from movements only'); END;
CREATE TRIGGER inv_balances_guard_upd BEFORE UPDATE ON inv_balances
WHEN (SELECT rebuilding FROM inv_settings WHERE id = 1) = 0 AND NOT EXISTS
  (SELECT 1 FROM inv_moves m WHERE m.id = NEW.last_move_id AND m.id = (SELECT max(id) FROM inv_moves) AND NEW.last_move_id > OLD.last_move_id
     AND m.item_id = OLD.item_id AND m.warehouse_id = OLD.warehouse_id AND ifnull(m.location_id, 0) = OLD.loc_key AND ifnull(m.batch_id, 0) = OLD.batch_key
     AND NEW.item_id = OLD.item_id AND NEW.warehouse_id = OLD.warehouse_id AND NEW.loc_key = OLD.loc_key AND NEW.batch_key = OLD.batch_key
     AND dec_cmp(NEW.qty, dec_add(OLD.qty, CASE m.direction WHEN 'in' THEN m.qty ELSE '-' || m.qty END)) = 0)
BEGIN SELECT RAISE(ABORT, 'stock balances are derived from movements only'); END;
CREATE TRIGGER inv_balances_guard_del BEFORE DELETE ON inv_balances WHEN (SELECT rebuilding FROM inv_settings WHERE id = 1) = 0
BEGIN SELECT RAISE(ABORT, 'stock balances are derived from movements only'); END;
CREATE TRIGGER inv_pools_guard_ins BEFORE INSERT ON inv_pools
WHEN (SELECT rebuilding FROM inv_settings WHERE id = 1) = 0 AND NOT EXISTS
  (SELECT 1 FROM inv_moves m WHERE m.id = NEW.last_move_id AND m.id = (SELECT max(id) FROM inv_moves) AND m.item_id = NEW.item_id AND m.warehouse_id = NEW.warehouse_id
     AND ifnull(m.batch_id, 0) = NEW.batch_key AND NEW.qty = (CASE m.direction WHEN 'in' THEN m.qty ELSE '-' || m.qty END)
     AND NEW.value = (CASE WHEN m.direction = 'in' OR m.value = '0' THEN m.value ELSE '-' || m.value END))
BEGIN SELECT RAISE(ABORT, 'stock valuation is derived from movements only'); END;
CREATE TRIGGER inv_pools_guard_upd BEFORE UPDATE ON inv_pools
WHEN (SELECT rebuilding FROM inv_settings WHERE id = 1) = 0 AND NOT EXISTS
  (SELECT 1 FROM inv_moves m WHERE m.id = NEW.last_move_id AND m.id = (SELECT max(id) FROM inv_moves) AND NEW.last_move_id > OLD.last_move_id
     AND m.item_id = OLD.item_id AND m.warehouse_id = OLD.warehouse_id AND ifnull(m.batch_id, 0) = OLD.batch_key
     AND NEW.item_id = OLD.item_id AND NEW.warehouse_id = OLD.warehouse_id AND NEW.batch_key = OLD.batch_key
     AND dec_cmp(NEW.qty, dec_add(OLD.qty, CASE m.direction WHEN 'in' THEN m.qty ELSE '-' || m.qty END)) = 0
     AND dec_cmp(NEW.value, dec_add(OLD.value, CASE WHEN m.direction = 'in' OR m.value = '0' THEN m.value ELSE '-' || m.value END)) = 0)
BEGIN SELECT RAISE(ABORT, 'stock valuation is derived from movements only'); END;
CREATE TRIGGER inv_pools_guard_del BEFORE DELETE ON inv_pools WHEN (SELECT rebuilding FROM inv_settings WHERE id = 1) = 0
BEGIN SELECT RAISE(ABORT, 'stock valuation is derived from movements only'); END;

-- ── الحجوزات (لا تغيّر الرصيد ولا القيمة ولا الأستاذ) ──
CREATE TABLE inv_reservations (
  id           INTEGER PRIMARY KEY,
  item_id      INTEGER NOT NULL REFERENCES inv_items (id),
  warehouse_id INTEGER NOT NULL REFERENCES inv_warehouses (id),
  branch_id    INTEGER NOT NULL REFERENCES branches (id),
  batch_id     INTEGER REFERENCES inv_batches (id),
  qty          TEXT NOT NULL CHECK ((qty <> '0' AND (qty = '0' OR ((qty GLOB '[1-9]*' OR qty GLOB '0.[0-9]*') AND qty NOT GLOB '*[^0-9.]*' AND qty NOT GLOB '*.*.*' AND qty NOT GLOB '*.' AND qty NOT GLOB '*.*0' AND (instr(qty, '.') = 0 OR length(qty) - instr(qty, '.') <= 8) AND (CASE WHEN instr(qty, '.') = 0 THEN length(qty) ELSE instr(qty, '.') - 1 END) <= 20)))),              -- بوحدة الأساس
  consumed_qty TEXT NOT NULL DEFAULT '0' CHECK ((consumed_qty = '0' OR ((consumed_qty GLOB '[1-9]*' OR consumed_qty GLOB '0.[0-9]*') AND consumed_qty NOT GLOB '*[^0-9.]*' AND consumed_qty NOT GLOB '*.*.*' AND consumed_qty NOT GLOB '*.' AND consumed_qty NOT GLOB '*.*0' AND (instr(consumed_qty, '.') = 0 OR length(consumed_qty) - instr(consumed_qty, '.') <= 8) AND (CASE WHEN instr(consumed_qty, '.') = 0 THEN length(consumed_qty) ELSE instr(consumed_qty, '.') - 1 END) <= 20))),
  status       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'released', 'consumed', 'expired')),
  reference    TEXT NOT NULL CHECK (length(trim(reference)) BETWEEN 1 AND 120),
  expires_on   TEXT CHECK (expires_on IS NULL OR (date(expires_on) IS expires_on)),
  notes        TEXT CHECK (notes IS NULL OR length(notes) <= 300),
  created_by   INTEGER NOT NULL,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  closed_by    INTEGER, closed_at TEXT,
  close_reason TEXT CHECK (close_reason IS NULL OR length(close_reason) <= 300)
) STRICT;
CREATE INDEX inv_reservations_pool ON inv_reservations (item_id, warehouse_id, status);
CREATE TRIGGER inv_reservations_no_delete BEFORE DELETE ON inv_reservations BEGIN SELECT RAISE(ABORT, 'reservation history is kept; release instead'); END;
CREATE TRIGGER inv_reservations_fixed BEFORE UPDATE OF item_id, warehouse_id, branch_id, batch_id, qty, reference ON inv_reservations
BEGIN SELECT RAISE(ABORT, 'reservation scope is fixed'); END;

-- ── الربط المحاسبي: سطور القيد كما أرسلها المحرك إلى services.ledger.post() ──
CREATE TABLE inv_gl_lines (
  id             INTEGER PRIMARY KEY,
  doc_id         INTEGER NOT NULL REFERENCES inv_documents (id),
  line_no        INTEGER NOT NULL CHECK (line_no >= 1),
  role           TEXT NOT NULL CHECK (role IN ('inventory', 'counter', 'adjustment', 'transit', 'variance')),
  account_id     INTEGER NOT NULL REFERENCES accounts (id),
  cost_center_id INTEGER REFERENCES cost_centers (id),
  debit          TEXT NOT NULL DEFAULT '0' CHECK ((debit = '0' OR ((debit GLOB '[1-9]*' OR debit GLOB '0.[0-9]*') AND debit NOT GLOB '*[^0-9.]*' AND debit NOT GLOB '*.*.*' AND debit NOT GLOB '*.' AND debit NOT GLOB '*.*0' AND (instr(debit, '.') = 0 OR length(debit) - instr(debit, '.') <= 8) AND (CASE WHEN instr(debit, '.') = 0 THEN length(debit) ELSE instr(debit, '.') - 1 END) <= 20))),
  credit         TEXT NOT NULL DEFAULT '0' CHECK ((credit = '0' OR ((credit GLOB '[1-9]*' OR credit GLOB '0.[0-9]*') AND credit NOT GLOB '*[^0-9.]*' AND credit NOT GLOB '*.*.*' AND credit NOT GLOB '*.' AND credit NOT GLOB '*.*0' AND (instr(credit, '.') = 0 OR length(credit) - instr(credit, '.') <= 8) AND (CASE WHEN instr(credit, '.') = 0 THEN length(credit) ELSE instr(credit, '.') - 1 END) <= 20))),
  UNIQUE (doc_id, line_no),
  CHECK ((debit = '0') <> (credit = '0'))
) STRICT;
CREATE INDEX inv_gl_lines_doc ON inv_gl_lines (doc_id);
CREATE TRIGGER inv_gl_lines_insert_rules BEFORE INSERT ON inv_gl_lines
WHEN NOT EXISTS (SELECT 1 FROM inv_documents WHERE id = NEW.doc_id AND status = 'posted' AND gl_number IS NULL)
BEGIN SELECT RAISE(ABORT, 'inventory journal lines are written while posting the document only'); END;
CREATE TRIGGER inv_gl_lines_no_update BEFORE UPDATE ON inv_gl_lines BEGIN SELECT RAISE(ABORT, 'inventory journal lines are immutable'); END;
CREATE TRIGGER inv_gl_lines_no_delete BEFORE DELETE ON inv_gl_lines BEGIN SELECT RAISE(ABORT, 'inventory journal lines are immutable'); END;

-- ── منع تكرار الطلبات ──
CREATE TABLE inv_requests (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  operation       TEXT NOT NULL CHECK (length(operation) BETWEEN 1 AND 40),
  user_id         INTEGER NOT NULL,
  result          TEXT NOT NULL CHECK (json_valid(result)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TRIGGER inv_requests_no_update BEFORE UPDATE ON inv_requests BEGIN SELECT RAISE(ABORT, 'requests are append-only'); END;
CREATE TRIGGER inv_requests_no_delete BEFORE DELETE ON inv_requests BEGIN SELECT RAISE(ABORT, 'requests are append-only'); END;

-- ── سلاسل الترقيم: لكل نوع، لكل فرع، لكل سنة مالية ──
INSERT INTO document_series (code, doc_type, name_ar, name_en, prefix, is_default) VALUES
  ('IOB', 'inv_opening',      'أرصدة مخزون افتتاحية',     'Inventory opening balances',  'IOB', 1),
  ('IRC', 'inv_receipt',      'أذون الإضافة المخزنية',     'Stock receipts',              'IRC', 1),
  ('IIS', 'inv_issue',        'أذون الصرف المخزنية',       'Stock issues',                'IIS', 1),
  ('ITR', 'inv_transfer',     'التحويل بين المخازن',       'Warehouse transfers',         'ITR', 1),
  ('ITO', 'inv_transfer_out', 'إرسال تحويل بين الفروع',    'Branch transfer dispatches',  'ITO', 1),
  ('ITI', 'inv_transfer_in',  'استلام تحويل بين الفروع',   'Branch transfer receipts',    'ITI', 1),
  ('IAI', 'inv_adjust_in',    'تسويات الزيادة',            'Stock surplus adjustments',   'IAI', 1),
  ('IAO', 'inv_adjust_out',   'تسويات العجز',              'Stock shortage adjustments',  'IAO', 1),
  ('IRT', 'inv_return',       'المرتجعات إلى المخزن',      'Returns to stock',            'IRT', 1),
  ('IQC', 'inv_quality',      'حركات الجودة والحجر',       'Quality movements',           'IQC', 1),
  ('IRV', 'inv_reversal',     'عكس المستندات المخزنية',    'Inventory reversals',         'IRV', 1),
  ('ICN', 'inv_count',        'جلسات الجرد',               'Stock counts',                'ICN', 1),
  ('IGL', 'inv_gl',           'قيود المخزون',              'Inventory journal entries',   'IGL', 1);

-- ── الأستاذ: مصدر رابع (inventory). يستبدل trigger المرحلة 4 دون تعديل ترحيلها (نفس القواعد حرفيًا + قواعد المصدر الجديد) ──
DROP TRIGGER gl_entries_insert_rules;
CREATE TRIGGER gl_entries_insert_rules BEFORE INSERT ON gl_entries
BEGIN
  SELECT RAISE(ABORT, 'unknown ledger source') WHERE NEW.source_type NOT IN ('journal', 'year_closing', 'carry_forward', 'inventory');
  SELECT RAISE(ABORT, 'closing entries come from the year-end closing only') WHERE NEW.entry_kind = 'closing' AND NEW.source_type <> 'year_closing';
  SELECT RAISE(ABORT, 'group accounts cannot be posted to') WHERE (SELECT is_group FROM accounts WHERE id = NEW.account_id) IS NOT 0;
  -- القيد اليومي وقيد المخزون: فترة مفتوحة، والسنة غير مُقفلة لفرعه
  SELECT RAISE(ABORT, 'posting period must be open and contain the posting date') WHERE NEW.source_type IN ('journal', 'inventory') AND NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.fiscal_year_id = NEW.fiscal_year_id
       AND p.status = 'open' AND NEW.posting_date BETWEEN p.start_date AND p.end_date);
  SELECT RAISE(ABORT, 'fiscal year is closed for this branch') WHERE NEW.source_type IN ('journal', 'inventory') AND EXISTS
    (SELECT 1 FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id
      WHERE c.branch_id = NEW.branch_id AND c.status = 'active' AND NEW.posting_date <= y.end_date);
  SELECT RAISE(ABORT, 'ledger line must match a line of the posted journal entry') WHERE NEW.source_type = 'journal' AND NOT EXISTS
    (SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.id = NEW.source_id AND e.status = 'posted' AND e.number = NEW.doc_number AND e.branch_id = NEW.branch_id
        AND e.entry_date = NEW.posting_date AND e.fiscal_period_id = NEW.fiscal_period_id
        AND (CASE WHEN e.entry_type = 'opening'
                    OR (e.entry_type = 'reversal' AND (SELECT o.entry_type FROM journal_entries o WHERE o.id = e.reverses_id) = 'opening')
                  THEN 'opening' ELSE 'normal' END) = NEW.entry_kind
        AND l.id = NEW.source_line_id AND l.account_id = NEW.account_id AND l.cost_center_id IS NEW.cost_center_id
        AND l.currency_id = NEW.currency_id AND l.rate = NEW.rate AND l.rate_source = NEW.rate_source
        AND l.debit_fc = NEW.debit_fc AND l.credit_fc = NEW.credit_fc AND l.debit = NEW.debit AND l.credit = NEW.credit);
  -- مستندات الإقفال: فترة غير مقفلة نهائيًا، وسطر الأستاذ نسخة حرفية من سطر مستند مرحّل
  SELECT RAISE(ABORT, 'year-end posting period must contain the date and not be locked') WHERE NEW.source_type IN ('year_closing', 'carry_forward') AND NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.fiscal_year_id = NEW.fiscal_year_id
       AND p.status IN ('open', 'closed') AND NEW.posting_date BETWEEN p.start_date AND p.end_date);
  SELECT RAISE(ABORT, 'ledger line must match a line of the posted year-end entry') WHERE NEW.source_type IN ('year_closing', 'carry_forward') AND NOT EXISTS
    (SELECT 1 FROM year_end_entries e JOIN year_end_lines l ON l.entry_id = e.id
      WHERE e.id = NEW.source_id AND e.status = 'posted' AND e.number = NEW.doc_number AND e.branch_id = NEW.branch_id
        AND e.entry_date = NEW.posting_date AND e.fiscal_period_id = NEW.fiscal_period_id AND e.fiscal_year_id = NEW.fiscal_year_id
        AND (CASE e.kind WHEN 'closing' THEN 'year_closing' ELSE 'carry_forward' END) = NEW.source_type
        AND (CASE e.kind WHEN 'closing' THEN 'closing' ELSE 'opening' END) = NEW.entry_kind
        AND l.id = NEW.source_line_id AND l.account_id = NEW.account_id AND l.cost_center_id IS NEW.cost_center_id
        AND l.currency_id = NEW.currency_id AND l.rate = NEW.rate AND l.rate_source = NEW.rate_source
        AND l.debit_fc = NEW.debit_fc AND l.credit_fc = NEW.credit_fc AND l.debit = NEW.debit AND l.credit = NEW.credit);
  -- قيد المخزون: قيد عادي بالعملة الأساسية، وسطر الأستاذ نسخة حرفية من سطر قيد مستند مخزني مرحّل
  SELECT RAISE(ABORT, 'ledger line must match a line of the posted inventory document') WHERE NEW.source_type = 'inventory' AND NOT EXISTS
    (SELECT 1 FROM inv_documents d JOIN inv_gl_lines l ON l.doc_id = d.id
      WHERE d.id = NEW.source_id AND d.status = 'posted' AND d.gl_number = NEW.doc_number AND d.branch_id = NEW.branch_id
        AND d.doc_date = NEW.posting_date AND d.fiscal_period_id = NEW.fiscal_period_id AND NEW.entry_kind = 'normal'
        AND l.id = NEW.source_line_id AND l.account_id = NEW.account_id AND l.cost_center_id IS NEW.cost_center_id
        AND NEW.rate = '1' AND NEW.rate_source = 'base' AND NEW.debit_fc = NEW.debit AND NEW.credit_fc = NEW.credit
        AND l.debit = NEW.debit AND l.credit = NEW.credit);
END;

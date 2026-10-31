-- TAYL Phase 1 — الشركة (صف واحد فقط) والفروع والإعدادات وسياسة الدقة.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

-- شركة واحدة لكل نسخة: المفتاح الأساسي مقيّد بالقيمة 1، فإدخال شركة ثانية مستحيل من القاعدة نفسها.
-- لا يوجد company_id في أي جدول آخر: كل البيانات تخص هذه الشركة، والتقسيم يكون بالفرع.
CREATE TABLE company (
  id                  INTEGER PRIMARY KEY CHECK (id = 1),
  name_ar             TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 200),
  name_en             TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  address_ar          TEXT,
  address_en          TEXT,
  phone               TEXT,
  email               TEXT,
  tax_number          TEXT,
  commercial_register TEXT,
  base_currency       TEXT NOT NULL CHECK (base_currency GLOB '[A-Z][A-Z][A-Z]'),
  default_language    TEXT NOT NULL CHECK (default_language IN ('ar', 'en')),
  -- شعار الشركة الذي يرفعه المستخدم (منفصل تمامًا عن شعار TAYL الرسمي في public/assets).
  logo                BLOB CHECK (logo IS NULL OR length(logo) <= 524288),
  logo_mime           TEXT CHECK (logo_mime IS NULL OR logo_mime IN ('image/png', 'image/jpeg', 'image/webp')),
  logo_sha256         TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((logo IS NULL) = (logo_mime IS NULL))
) STRICT;

CREATE TRIGGER company_no_delete BEFORE DELETE ON company
BEGIN SELECT RAISE(ABORT, 'company cannot be deleted'); END;

-- الفروع: لا تُحذف أبدًا (ستُشير إليها المستندات والحركات)، بل تُعطَّل.
CREATE TABLE branches (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 20 AND code = upper(code)),
  name_ar     TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 200),
  name_en     TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  address_ar  TEXT,
  address_en  TEXT,
  phone       TEXT,
  email       TEXT,
  is_main     INTEGER NOT NULL DEFAULT 0 CHECK (is_main IN (0, 1)),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (NOT (is_main = 1 AND is_active = 0))      -- الفرع الرئيسي لا يُعطَّل
) STRICT;

-- فرع رئيسي واحد على الأكثر.
CREATE UNIQUE INDEX branches_one_main ON branches (is_main) WHERE is_main = 1;

CREATE TRIGGER branches_no_delete BEFORE DELETE ON branches
BEGIN SELECT RAISE(ABORT, 'branches cannot be deleted; deactivate instead'); END;

-- إعدادات النظام (قيم JSON).
CREATE TABLE settings (
  key        TEXT PRIMARY KEY CHECK (length(key) BETWEEN 1 AND 100),
  value      TEXT NOT NULL CHECK (json_valid(value)),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by INTEGER
) STRICT;

-- سياسة الدقة المركزية. currency = '' هو الافتراضي للنوع؛ ويمكن تخصيص صف لعملة معينة.
-- storage scale ثابت (مكرر هنا كقيد دفاعي ويطابق server/core/decimal/policy.js — يتحقق اختبار من التطابق).
CREATE TABLE decimal_policy (
  kind          TEXT NOT NULL CHECK (kind IN ('amount', 'quantity', 'unit_price', 'fx_rate', 'rate', 'unit_cost')),
  currency      TEXT NOT NULL DEFAULT '' CHECK (currency = '' OR currency GLOB '[A-Z][A-Z][A-Z]'),
  commit_scale  INTEGER NOT NULL CHECK (commit_scale >= 0 AND commit_scale <= CASE kind
                  WHEN 'amount' THEN 8 WHEN 'quantity' THEN 8 WHEN 'unit_price' THEN 10
                  WHEN 'fx_rate' THEN 12 WHEN 'rate' THEN 8 WHEN 'unit_cost' THEN 10 END),
  display_scale INTEGER NOT NULL CHECK (display_scale >= 0 AND display_scale <= commit_scale),
  rounding      TEXT NOT NULL CHECK (rounding IN ('HALF_UP', 'HALF_EVEN', 'HALF_DOWN', 'UP', 'DOWN', 'CEIL', 'FLOOR')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by    INTEGER,
  PRIMARY KEY (kind, currency)
) STRICT;

-- السياسة الأولية المعتمدة (قابلة للمراجعة من شاشة الإعدادات).
INSERT INTO decimal_policy (kind, currency, commit_scale, display_scale, rounding) VALUES
  ('amount',     '', 8,  2, 'HALF_UP'),
  ('quantity',   '', 8,  3, 'HALF_UP'),
  ('unit_price', '', 10, 4, 'HALF_UP'),
  ('fx_rate',    '', 12, 6, 'HALF_UP'),
  ('rate',       '', 8,  2, 'HALF_UP'),
  ('unit_cost',  '', 10, 4, 'HALF_UP');

-- الصف الافتراضي لكل نوع لا يُحذف (التخصيص حسب العملة فقط قابل للحذف).
CREATE TRIGGER decimal_policy_keep_default BEFORE DELETE ON decimal_policy
WHEN OLD.currency = ''
BEGIN SELECT RAISE(ABORT, 'default precision policy row cannot be deleted'); END;

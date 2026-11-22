-- TAYL Phase 5 — تصنيف الحسابات لأغراض القوائم المالية. المرجع: docs/PHASE5_REPORT.md (القسم 3).
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد. لا يمس الأستاذ ولا أي جدول سابق (جداول إعداد جديدة فقط).
--
-- is_line: بند قائمة الدخل لحساب من قائمة الدخل:
--   revenue (إيرادات النشاط) | cogs (تكلفة المبيعات) | operating_expense (مصروفات تشغيلية)
--   | other_income (إيرادات أخرى) | other_expense (مصروفات أخرى)
-- cf_activity: نشاط التدفق النقدي لحساب من الميزانية:
--   cash (نقدية وما يعادلها) | operating | investing | financing
-- الحل: إعداد الحساب ← إعداد نوعه ← لا شيء (= غير مصنف؛ القائمة تُعلَّم «غير مكتملة» ولا تُطبع ولا تُصدَّر).
-- تكلفة المبيعات تحدد بندها من التصنيف الأساسي cogs مباشرة (لا تحتاج إعدادًا).

CREATE TABLE fs_type_settings (
  type_id     INTEGER PRIMARY KEY REFERENCES account_types (id),
  is_line     TEXT CHECK (is_line IS NULL OR is_line IN ('revenue', 'cogs', 'operating_expense', 'other_income', 'other_expense')),
  cf_activity TEXT CHECK (cf_activity IS NULL OR cf_activity IN ('cash', 'operating', 'investing', 'financing')),
  updated_by  INTEGER,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE fs_account_settings (
  account_id  INTEGER PRIMARY KEY REFERENCES accounts (id),
  is_line     TEXT CHECK (is_line IS NULL OR is_line IN ('revenue', 'cogs', 'operating_expense', 'other_income', 'other_expense')),
  cf_activity TEXT CHECK (cf_activity IS NULL OR cf_activity IN ('cash', 'operating', 'investing', 'financing')),
  updated_by  INTEGER,
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (is_line IS NOT NULL OR cf_activity IS NOT NULL)
) STRICT;

-- التوافق مع التصنيف الأساسي (دفاع في القاعدة خلف الخادم): بند الدخل لحسابات قائمة الدخل فقط وبما يناسب تصنيفها،
-- ونشاط التدفق لحسابات الميزانية فقط
CREATE TRIGGER fs_type_settings_rules_ins BEFORE INSERT ON fs_type_settings
BEGIN
  SELECT RAISE(ABORT, 'income statement line does not fit the account class') WHERE NEW.is_line IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM account_types t WHERE t.id = NEW.type_id AND (
      (t.class_code = 'revenue' AND NEW.is_line IN ('revenue', 'other_income')) OR (t.class_code = 'cogs' AND NEW.is_line = 'cogs')
      OR (t.class_code = 'expense' AND NEW.is_line IN ('operating_expense', 'other_expense'))));
  SELECT RAISE(ABORT, 'cash flow activity is for balance sheet accounts only') WHERE NEW.cf_activity IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM account_types t WHERE t.id = NEW.type_id AND t.class_code IN ('asset', 'liability', 'equity'));
END;
CREATE TRIGGER fs_type_settings_rules_upd BEFORE UPDATE ON fs_type_settings
BEGIN
  SELECT RAISE(ABORT, 'income statement line does not fit the account class') WHERE NEW.is_line IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM account_types t WHERE t.id = NEW.type_id AND (
      (t.class_code = 'revenue' AND NEW.is_line IN ('revenue', 'other_income')) OR (t.class_code = 'cogs' AND NEW.is_line = 'cogs')
      OR (t.class_code = 'expense' AND NEW.is_line IN ('operating_expense', 'other_expense'))));
  SELECT RAISE(ABORT, 'cash flow activity is for balance sheet accounts only') WHERE NEW.cf_activity IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM account_types t WHERE t.id = NEW.type_id AND t.class_code IN ('asset', 'liability', 'equity'));
END;
CREATE TRIGGER fs_account_settings_rules_ins BEFORE INSERT ON fs_account_settings
BEGIN
  SELECT RAISE(ABORT, 'income statement line does not fit the account class') WHERE NEW.is_line IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM accounts a WHERE a.id = NEW.account_id AND (
      (a.class_code = 'revenue' AND NEW.is_line IN ('revenue', 'other_income')) OR (a.class_code = 'cogs' AND NEW.is_line = 'cogs')
      OR (a.class_code = 'expense' AND NEW.is_line IN ('operating_expense', 'other_expense'))));
  SELECT RAISE(ABORT, 'cash flow activity is for balance sheet accounts only') WHERE NEW.cf_activity IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM accounts a WHERE a.id = NEW.account_id AND a.class_code IN ('asset', 'liability', 'equity'));
END;
CREATE TRIGGER fs_account_settings_rules_upd BEFORE UPDATE ON fs_account_settings
BEGIN
  SELECT RAISE(ABORT, 'income statement line does not fit the account class') WHERE NEW.is_line IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM accounts a WHERE a.id = NEW.account_id AND (
      (a.class_code = 'revenue' AND NEW.is_line IN ('revenue', 'other_income')) OR (a.class_code = 'cogs' AND NEW.is_line = 'cogs')
      OR (a.class_code = 'expense' AND NEW.is_line IN ('operating_expense', 'other_expense'))));
  SELECT RAISE(ABORT, 'cash flow activity is for balance sheet accounts only') WHERE NEW.cf_activity IS NOT NULL AND NOT EXISTS
    (SELECT 1 FROM accounts a WHERE a.id = NEW.account_id AND a.class_code IN ('asset', 'liability', 'equity'));
END;

-- الإعداد الافتراضي للأنواع الأساسية المعرّفة في chart-accounts/0001 (بأكوادها؛ قابل للتعديل من شاشة الإعداد).
-- OTHER_ASSET وOTHER_LIAB بلا نشاط افتراضي عمدًا: قد تكون تشغيلية أو استثمارية/تمويلية، فيحددها المستخدم.
INSERT INTO fs_type_settings (type_id, is_line, cf_activity)
SELECT t.id, m.is_line, m.cf_activity FROM account_types t JOIN (
  SELECT 'CASH' code, NULL is_line, 'cash' cf_activity UNION ALL SELECT 'BANK', NULL, 'cash'
  UNION ALL SELECT 'RECEIVABLE', NULL, 'operating' UNION ALL SELECT 'INVENTORY', NULL, 'operating' UNION ALL SELECT 'PREPAID', NULL, 'operating'
  UNION ALL SELECT 'FIXED_ASSET', NULL, 'investing' UNION ALL SELECT 'ACCUM_DEPR', NULL, 'operating'
  UNION ALL SELECT 'PAYABLE', NULL, 'operating' UNION ALL SELECT 'TAX_PAYABLE', NULL, 'operating' UNION ALL SELECT 'ACCRUED', NULL, 'operating'
  UNION ALL SELECT 'LOAN', NULL, 'financing' UNION ALL SELECT 'CAPITAL', NULL, 'financing' UNION ALL SELECT 'RETAINED', NULL, 'financing' UNION ALL SELECT 'DRAWINGS', NULL, 'financing'
  UNION ALL SELECT 'SALES', 'revenue', NULL UNION ALL SELECT 'SALES_RETURNS', 'revenue', NULL UNION ALL SELECT 'OTHER_REVENUE', 'other_income', NULL
  UNION ALL SELECT 'COGS', 'cogs', NULL
  UNION ALL SELECT 'OPEX', 'operating_expense', NULL UNION ALL SELECT 'ADMIN_EXP', 'operating_expense', NULL UNION ALL SELECT 'SELLING_EXP', 'operating_expense', NULL
  UNION ALL SELECT 'DEPR_EXP', 'operating_expense', NULL UNION ALL SELECT 'FIN_EXP', 'other_expense', NULL
) m ON m.code = t.code;

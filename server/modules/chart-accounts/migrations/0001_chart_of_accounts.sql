-- TAYL Phase 2 — دليل الحسابات. لا قيود يومية ولا ترحيل في هذه المرحلة.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

-- التصنيفات الأساسية الستة (ثابتة): تحدد القائمة المالية والطبيعة الافتراضية.
CREATE TABLE account_classes (
  code           TEXT PRIMARY KEY CHECK (code IN ('asset', 'liability', 'equity', 'revenue', 'cogs', 'expense')),
  name_ar        TEXT NOT NULL,
  name_en        TEXT NOT NULL,
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  statement      TEXT NOT NULL CHECK (statement IN ('balance_sheet', 'income_statement')),
  sort_order     INTEGER NOT NULL
) STRICT;

INSERT INTO account_classes VALUES
  ('asset',     'الأصول',         'Assets',             'debit',  'balance_sheet',    1),
  ('liability', 'الالتزامات',     'Liabilities',        'credit', 'balance_sheet',    2),
  ('equity',    'حقوق الملكية',   'Equity',             'credit', 'balance_sheet',    3),
  ('revenue',   'الإيرادات',      'Revenue',            'credit', 'income_statement', 4),
  ('cogs',      'تكلفة المبيعات', 'Cost of sales',      'debit',  'income_statement', 5),
  ('expense',   'المصروفات',      'Expenses',           'debit',  'income_statement', 6);

CREATE TRIGGER account_classes_fixed_upd BEFORE UPDATE ON account_classes BEGIN SELECT RAISE(ABORT, 'account classes are fixed'); END;
CREATE TRIGGER account_classes_fixed_del BEFORE DELETE ON account_classes BEGIN SELECT RAISE(ABORT, 'account classes are fixed'); END;

-- الأنواع: تصنيفات فرعية قابلة للتوسع تحت كل تصنيف أساسي (مع طبيعة قد تخالف التصنيف للحسابات المقابلة/العكسية).
CREATE TABLE account_types (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  class_code     TEXT NOT NULL REFERENCES account_classes (code),
  name_ar        TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en        TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO account_types (code, class_code, name_ar, name_en, normal_balance) VALUES
  ('CASH',           'asset',     'نقدية وخزائن',           'Cash on hand',                'debit'),
  ('BANK',           'asset',     'بنوك',                   'Bank accounts',               'debit'),
  ('RECEIVABLE',     'asset',     'ذمم مدينة',              'Receivables',                 'debit'),
  ('INVENTORY',      'asset',     'مخزون',                  'Inventory',                   'debit'),
  ('PREPAID',        'asset',     'مصروفات مدفوعة مقدمًا',  'Prepaid expenses',            'debit'),
  ('FIXED_ASSET',    'asset',     'أصول ثابتة',             'Fixed assets',                'debit'),
  ('ACCUM_DEPR',     'asset',     'مجمع الإهلاك',           'Accumulated depreciation',    'credit'),
  ('OTHER_ASSET',    'asset',     'أصول أخرى',              'Other assets',                'debit'),
  ('PAYABLE',        'liability', 'ذمم دائنة',              'Payables',                    'credit'),
  ('TAX_PAYABLE',    'liability', 'ضرائب مستحقة',           'Taxes payable',               'credit'),
  ('ACCRUED',        'liability', 'مصروفات مستحقة',         'Accrued expenses',            'credit'),
  ('LOAN',           'liability', 'قروض',                   'Loans',                       'credit'),
  ('OTHER_LIAB',     'liability', 'التزامات أخرى',          'Other liabilities',           'credit'),
  ('CAPITAL',        'equity',    'رأس المال',              'Capital',                     'credit'),
  ('RETAINED',       'equity',    'أرباح محتجزة',           'Retained earnings',           'credit'),
  ('DRAWINGS',       'equity',    'مسحوبات',                'Drawings',                    'debit'),
  ('SALES',          'revenue',   'مبيعات',                 'Sales',                       'credit'),
  ('SALES_RETURNS',  'revenue',   'مردودات ومسموحات المبيعات', 'Sales returns & allowances', 'debit'),
  ('OTHER_REVENUE',  'revenue',   'إيرادات أخرى',           'Other revenue',               'credit'),
  ('COGS',           'cogs',      'تكلفة البضاعة المباعة',  'Cost of goods sold',          'debit'),
  ('OPEX',           'expense',   'مصروفات تشغيلية',        'Operating expenses',          'debit'),
  ('ADMIN_EXP',      'expense',   'مصروفات إدارية وعمومية', 'General & administrative',    'debit'),
  ('SELLING_EXP',    'expense',   'مصروفات بيع وتسويق',     'Selling & marketing',         'debit'),
  ('FIN_EXP',        'expense',   'مصروفات تمويلية',        'Finance costs',               'debit'),
  ('DEPR_EXP',       'expense',   'مصروف الإهلاك',          'Depreciation expense',        'debit');

-- الحسابات: شجرة بمسار مادي (path = /1/5/9/) للبحث في الفروع ومنع الدورات.
CREATE TABLE accounts (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar        TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 200),
  name_en        TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  parent_id      INTEGER REFERENCES accounts (id),
  path           TEXT NOT NULL,
  level          INTEGER NOT NULL CHECK (level BETWEEN 1 AND 15),
  class_code     TEXT NOT NULL REFERENCES account_classes (code),
  type_id        INTEGER REFERENCES account_types (id),
  normal_balance TEXT NOT NULL CHECK (normal_balance IN ('debit', 'credit')),
  is_group       INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),      -- 1 = تجميعي (لا يقبل حركات)
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order     INTEGER NOT NULL DEFAULT 0,
  description    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE INDEX accounts_parent ON accounts (parent_id, sort_order);
CREATE INDEX accounts_path ON accounts (path);

-- دفاع في القاعدة نفسها: الأب تجميعي، ونفس تصنيف الأب.
CREATE TRIGGER accounts_parent_rules_ins BEFORE INSERT ON accounts WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'parent account must be a group account') WHERE (SELECT is_group FROM accounts WHERE id = NEW.parent_id) IS NOT 1;
  SELECT RAISE(ABORT, 'child account class must match parent') WHERE (SELECT class_code FROM accounts WHERE id = NEW.parent_id) IS NOT NEW.class_code;
END;
CREATE TRIGGER accounts_parent_rules_upd BEFORE UPDATE OF parent_id, class_code ON accounts WHEN NEW.parent_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'parent account must be a group account') WHERE (SELECT is_group FROM accounts WHERE id = NEW.parent_id) IS NOT 1;
  SELECT RAISE(ABORT, 'child account class must match parent') WHERE (SELECT class_code FROM accounts WHERE id = NEW.parent_id) IS NOT NEW.class_code;
END;

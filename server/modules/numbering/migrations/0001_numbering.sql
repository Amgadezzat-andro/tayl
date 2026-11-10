-- TAYL Phase 3 (3.1) — ترقيم المستندات: السلاسل والعدادات وسجل الأرقام الصادرة.
-- الرقم يصدر داخل معاملة ترحيل المستند فقط (BEGIN IMMEDIATE)، فلا فجوات ولا تكرار.
-- لا يُعاد استخدام أي رقم: العداد يزيد بواحد فقط ولا يُحذف، والسجل إضافة فقط، والنص فريد على كل المستندات.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE document_series (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 10 AND code GLOB '[A-Z]*' AND code NOT GLOB '*[^A-Z0-9]*'),
  doc_type     TEXT NOT NULL CHECK (length(doc_type) BETWEEN 1 AND 40 AND doc_type GLOB '[a-z]*' AND doc_type NOT GLOB '*[^a-z_]*'),
  name_ar      TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en      TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  prefix       TEXT NOT NULL UNIQUE CHECK (length(prefix) BETWEEN 1 AND 10 AND prefix GLOB '[A-Z]*' AND prefix NOT GLOB '*[^A-Z0-9]*'),
  per_branch   INTEGER NOT NULL DEFAULT 1 CHECK (per_branch IN (0, 1)),       -- مقطع الفرع + تسلسل لكل فرع
  reset_yearly INTEGER NOT NULL DEFAULT 1 CHECK (reset_yearly IN (0, 1)),     -- مقطع FYyyyy + تسلسل لكل سنة
  padding      INTEGER NOT NULL DEFAULT 6 CHECK (padding BETWEEN 4 AND 10),
  is_default   INTEGER NOT NULL DEFAULT 0 CHECK (is_default IN (0, 1)),
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (is_default = 0 OR is_active = 1)                                    -- الافتراضية نشطة دائمًا
) STRICT;
CREATE UNIQUE INDEX document_series_one_default ON document_series (doc_type) WHERE is_default = 1;

-- العداد: branch_key = branch_id أو 0، year_key = سنة بداية السنة المالية (FYyyyy) أو 0
CREATE TABLE document_counters (
  series_id  INTEGER NOT NULL REFERENCES document_series (id),
  branch_key INTEGER NOT NULL CHECK (branch_key >= 0),
  year_key   INTEGER NOT NULL CHECK (year_key = 0 OR year_key BETWEEN 1900 AND 9999),
  last_value INTEGER NOT NULL CHECK (last_value >= 1),
  PRIMARY KEY (series_id, branch_key, year_key)
) STRICT;
CREATE TRIGGER document_counters_start_at_one BEFORE INSERT ON document_counters WHEN NEW.last_value <> 1
BEGIN SELECT RAISE(ABORT, 'a new document counter starts at 1'); END;
CREATE TRIGGER document_counters_step_one BEFORE UPDATE ON document_counters
WHEN NEW.last_value IS NOT OLD.last_value + 1 OR NEW.series_id IS NOT OLD.series_id OR NEW.branch_key IS NOT OLD.branch_key OR NEW.year_key IS NOT OLD.year_key
BEGIN SELECT RAISE(ABORT, 'document counters only move forward by one'); END;
CREATE TRIGGER document_counters_no_delete BEFORE DELETE ON document_counters
BEGIN SELECT RAISE(ABORT, 'document counters cannot be deleted'); END;

-- سجل الأرقام الصادرة: إضافة فقط
CREATE TABLE issued_numbers (
  id             INTEGER PRIMARY KEY,
  series_id      INTEGER NOT NULL REFERENCES document_series (id),
  branch_key     INTEGER NOT NULL,
  year_key       INTEGER NOT NULL,
  seq            INTEGER NOT NULL CHECK (seq >= 1),
  number         TEXT NOT NULL UNIQUE CHECK (length(number) BETWEEN 3 AND 80),   -- فريد على كل المستندات
  doc_type       TEXT NOT NULL,
  source_id      INTEGER NOT NULL,
  branch_id      INTEGER NOT NULL REFERENCES branches (id),          -- معنى الرقم محفوظ ولو تغيّر كود الفرع
  fiscal_year_id INTEGER NOT NULL REFERENCES fiscal_years (id),
  issued_by      INTEGER NOT NULL,
  issued_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (series_id, branch_key, year_key, seq)
) STRICT;
CREATE INDEX issued_numbers_source ON issued_numbers (doc_type, source_id);

CREATE TRIGGER issued_numbers_rules BEFORE INSERT ON issued_numbers
BEGIN
  SELECT RAISE(ABORT, 'series must be active and match the document type') WHERE NOT EXISTS
    (SELECT 1 FROM document_series s WHERE s.id = NEW.series_id AND s.is_active = 1 AND s.doc_type = NEW.doc_type);
  SELECT RAISE(ABORT, 'number keys do not match the series scope') WHERE NOT EXISTS
    (SELECT 1 FROM document_series s, fiscal_years y WHERE s.id = NEW.series_id AND y.id = NEW.fiscal_year_id
       AND NEW.branch_key = (CASE s.per_branch WHEN 1 THEN NEW.branch_id ELSE 0 END)
       AND NEW.year_key = (CASE s.reset_yearly WHEN 1 THEN CAST(substr(y.start_date, 1, 4) AS INTEGER) ELSE 0 END));
  SELECT RAISE(ABORT, 'sequence must equal the counter value issued in this transaction') WHERE NOT EXISTS
    (SELECT 1 FROM document_counters c WHERE c.series_id = NEW.series_id AND c.branch_key = NEW.branch_key
       AND c.year_key = NEW.year_key AND c.last_value = NEW.seq);
END;
CREATE TRIGGER issued_numbers_no_update BEFORE UPDATE ON issued_numbers
BEGIN SELECT RAISE(ABORT, 'issued numbers are permanent'); END;
CREATE TRIGGER issued_numbers_no_delete BEFORE DELETE ON issued_numbers
BEGIN SELECT RAISE(ABORT, 'issued numbers are permanent'); END;

-- بعد أول رقم صادر: لا يتغير ما يحدد هوية السلسلة أو نطاقها أو نص أرقامها، ولا تُحذف
CREATE TRIGGER document_series_locked_after_use BEFORE UPDATE OF code, doc_type, prefix, per_branch, reset_yearly, padding ON document_series
WHEN EXISTS (SELECT 1 FROM issued_numbers WHERE series_id = OLD.id)
  AND (NEW.code IS NOT OLD.code OR NEW.doc_type IS NOT OLD.doc_type OR NEW.prefix IS NOT OLD.prefix
       OR NEW.per_branch IS NOT OLD.per_branch OR NEW.reset_yearly IS NOT OLD.reset_yearly OR NEW.padding IS NOT OLD.padding)
BEGIN SELECT RAISE(ABORT, 'document series settings are locked after the first issued number'); END;
CREATE TRIGGER document_series_no_delete_used BEFORE DELETE ON document_series
WHEN EXISTS (SELECT 1 FROM issued_numbers WHERE series_id = OLD.id) OR EXISTS (SELECT 1 FROM document_counters WHERE series_id = OLD.id)
BEGIN SELECT RAISE(ABORT, 'a used document series cannot be deleted'); END;

-- بيانات مرجعية (قابلة للتعديل قبل أول استخدام)
INSERT INTO document_series (code, doc_type, name_ar, name_en, prefix, is_default) VALUES
  ('JV', 'journal',          'قيود اليومية',      'Journal vouchers',  'JV', 1),
  ('RV', 'journal_reversal', 'القيود العكسية',    'Reversal vouchers', 'RV', 1),
  ('OB', 'journal_opening',  'الأرصدة الافتتاحية', 'Opening balances',  'OB', 1);

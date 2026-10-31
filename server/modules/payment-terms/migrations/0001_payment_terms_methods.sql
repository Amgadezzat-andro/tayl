-- TAYL Phase 2 — شروط وطرق السداد (بيانات مرجعية). لا دورة تحصيل/سداد في هذه المرحلة.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

-- الشرط يُخزَّن كجدول أقساط: (بعد كم يوم، وبأي نسبة مئوية). مجموع النسب = 100 تمامًا (يُتحقق بالمحرك العشري).
CREATE TABLE payment_terms (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar     TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en     TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  kind        TEXT NOT NULL CHECK (kind IN ('cash', 'net', 'advance', 'installments', 'custom')),
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_usable   INTEGER NOT NULL DEFAULT 1 CHECK (is_usable IN (0, 1)),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

CREATE TABLE payment_term_lines (
  id          INTEGER PRIMARY KEY,
  term_id     INTEGER NOT NULL REFERENCES payment_terms (id) ON DELETE CASCADE,
  seq         INTEGER NOT NULL CHECK (seq >= 1),
  due_days    INTEGER NOT NULL CHECK (due_days BETWEEN 0 AND 3650),
  percent     TEXT NOT NULL CHECK (percent NOT GLOB '*[^0-9.]*' AND length(percent) BETWEEN 1 AND 20),   -- نسبة مئوية (rate)
  description TEXT,
  UNIQUE (term_id, seq)
) STRICT;

CREATE TABLE payment_methods (
  id            INTEGER PRIMARY KEY,
  code          TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar       TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en       TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  kind          TEXT NOT NULL CHECK (kind IN ('cash', 'bank_transfer', 'cheque', 'card', 'other')),
  treasury_kind TEXT CHECK (treasury_kind IS NULL OR treasury_kind IN ('cash', 'bank')),   -- نوع الخزينة المناسب مستقبلًا
  description   TEXT,
  is_active     INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_usable     INTEGER NOT NULL DEFAULT 1 CHECK (is_usable IN (0, 1)),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- بيانات مرجعية أساسية (قابلة للتعديل والتعطيل)
INSERT INTO payment_methods (code, name_ar, name_en, kind, treasury_kind) VALUES
  ('CASH',          'نقدية',      'Cash',          'cash',          'cash'),
  ('BANK_TRANSFER', 'تحويل بنكي', 'Bank transfer', 'bank_transfer', 'bank'),
  ('CHEQUE',        'شيك',        'Cheque',        'cheque',        'bank');
INSERT INTO payment_terms (code, name_ar, name_en, kind) VALUES ('CASH', 'نقدي', 'Cash', 'cash');
INSERT INTO payment_term_lines (term_id, seq, due_days, percent) VALUES ((SELECT id FROM payment_terms WHERE code = 'CASH'), 1, 0, '100');

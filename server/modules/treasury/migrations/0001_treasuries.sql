-- TAYL Phase 2 — تعريف الخزائن والحسابات البنكية فقط (لا سندات قبض/صرف ولا تسويات بنكية في هذه المرحلة).
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE treasuries (
  id             INTEGER PRIMARY KEY,
  code           TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar        TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 200),
  name_en        TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  kind           TEXT NOT NULL CHECK (kind IN ('cash', 'bank')),
  branch_id      INTEGER NOT NULL REFERENCES branches (id),
  currency_id    INTEGER NOT NULL REFERENCES currencies (id),
  bank_name      TEXT,
  account_number TEXT,                                   -- بيانات حساسة: تُعرض مقنّعة لغير المصرح له
  iban           TEXT,                                   -- بيانات حساسة
  account_id     INTEGER REFERENCES accounts (id),      -- الحساب المحاسبي (تفصيلي) المرتبط، اختياري
  is_active      INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_usable      INTEGER NOT NULL DEFAULT 1 CHECK (is_usable IN (0, 1)),   -- متاح للعمليات المستقبلية
  description    TEXT,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (kind = 'bank' OR (bank_name IS NULL AND account_number IS NULL AND iban IS NULL)),
  CHECK (kind = 'cash' OR bank_name IS NOT NULL)
) STRICT;
CREATE INDEX treasuries_branch ON treasuries (branch_id);
CREATE INDEX treasuries_account ON treasuries (account_id);

-- TAYL Phase 2 — العملات وأسعار الصرف. لا فروق عملة ولا تقييم أرصدة في هذه المرحلة.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE currencies (
  id               INTEGER PRIMARY KEY,
  code             TEXT NOT NULL UNIQUE CHECK (code GLOB '[A-Z][A-Z][A-Z]'),
  name_ar          TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en          TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  symbol           TEXT CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 8),
  display_decimals INTEGER NOT NULL DEFAULT 2 CHECK (display_decimals BETWEEN 0 AND 8),
  is_iso           INTEGER NOT NULL DEFAULT 1 CHECK (is_iso IN (0, 1)),
  is_active        INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- السعر = عدد وحدات العملة الأساسية مقابل وحدة واحدة من العملة (مثال: 1 USD = 48.5 EGP).
-- السجل تاريخي ولا يُعدَّل: تصحيح سعر = حذف السعر غير المستخدم ثم إضافة الصحيح، أو سعر بتاريخ لاحق.
CREATE TABLE exchange_rates (
  id             INTEGER PRIMARY KEY,
  currency_id    INTEGER NOT NULL REFERENCES currencies (id),
  rate_type      TEXT NOT NULL CHECK (rate_type IN ('buy', 'sell', 'average')),
  effective_date TEXT NOT NULL CHECK (date(effective_date) IS effective_date),
  rate           TEXT NOT NULL CHECK (rate NOT GLOB '*[^0-9.]*' AND length(rate) BETWEEN 1 AND 40 AND rate <> '0'),
  note           TEXT,
  created_by     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (currency_id, rate_type, effective_date)
) STRICT;
CREATE INDEX exchange_rates_lookup ON exchange_rates (currency_id, rate_type, effective_date);

CREATE TRIGGER exchange_rates_immutable BEFORE UPDATE ON exchange_rates
BEGIN SELECT RAISE(ABORT, 'exchange rates are historical and cannot be modified'); END;

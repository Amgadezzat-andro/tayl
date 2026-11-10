-- TAYL 0.3.1 — تصحيح أسعار الصرف بأثر تدقيقي (قرار مراجعة المرحلة 2 رقم 2).
-- لا حذف لأي سعر بعد اليوم. التصحيح = سطر جديد يشير إلى السطر الذي يحل محله (supersedes_id) مع سبب إلزامي،
-- والإلغاء (سعر أُدخل بتاريخ أو نوع خطأ) = سطر جديد بلا قيمة. السطر السابق يبقى كما هو.
-- لكل (عملة، نوع، تاريخ) سلسلة واحدة خطية: الأصل ← تصحيح ← تصحيح ...؛ السطر الساري هو رأس السلسلة (لا سطر يحل محله)
-- ما لم يكن إلغاءً.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE exchange_rates_v2 (
  id             INTEGER PRIMARY KEY,
  currency_id    INTEGER NOT NULL REFERENCES currencies (id),
  rate_type      TEXT NOT NULL CHECK (rate_type IN ('buy', 'sell', 'average')),
  effective_date TEXT NOT NULL CHECK (date(effective_date) IS effective_date),
  entry_kind     TEXT NOT NULL DEFAULT 'original' CHECK (entry_kind IN ('original', 'correction', 'void')),
  rate           TEXT CHECK (rate IS NULL OR (rate NOT GLOB '*[^0-9.]*' AND length(rate) BETWEEN 1 AND 40 AND rate <> '0')),
  supersedes_id  INTEGER UNIQUE REFERENCES exchange_rates_v2 (id),     -- UNIQUE: كل سطر يُستبدل مرة واحدة فقط ⇒ سلسلة خطية
  reason         TEXT,
  note           TEXT,
  created_by     INTEGER,
  created_at     TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK ((entry_kind = 'original') = (supersedes_id IS NULL)),
  CHECK ((entry_kind = 'void') = (rate IS NULL)),
  CHECK (entry_kind = 'original' OR length(trim(coalesce(reason, ''))) BETWEEN 3 AND 500)
) STRICT;

INSERT INTO exchange_rates_v2 (id, currency_id, rate_type, effective_date, entry_kind, rate, note, created_by, created_at)
  SELECT id, currency_id, rate_type, effective_date, 'original', rate, note, created_by, created_at FROM exchange_rates;

DROP TABLE exchange_rates;
ALTER TABLE exchange_rates_v2 RENAME TO exchange_rates;

-- سلسلة واحدة لكل (عملة، نوع، تاريخ)
CREATE UNIQUE INDEX exchange_rates_one_chain ON exchange_rates (currency_id, rate_type, effective_date) WHERE entry_kind = 'original';
CREATE INDEX exchange_rates_lookup ON exchange_rates (currency_id, rate_type, effective_date);

CREATE TRIGGER exchange_rates_immutable BEFORE UPDATE ON exchange_rates
BEGIN SELECT RAISE(ABORT, 'exchange rates are historical and cannot be modified'); END;
CREATE TRIGGER exchange_rates_no_delete BEFORE DELETE ON exchange_rates
BEGIN SELECT RAISE(ABORT, 'exchange rates are historical and cannot be deleted; record a correction'); END;

-- التصحيح/الإلغاء لنفس (العملة، النوع، التاريخ) فقط، ولا إلغاء لسطر ملغى
CREATE TRIGGER exchange_rates_correction_rules BEFORE INSERT ON exchange_rates WHEN NEW.supersedes_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'correction must keep currency, rate type and effective date') WHERE NOT EXISTS
    (SELECT 1 FROM exchange_rates o WHERE o.id = NEW.supersedes_id AND o.currency_id = NEW.currency_id
       AND o.rate_type = NEW.rate_type AND o.effective_date = NEW.effective_date);
  SELECT RAISE(ABORT, 'rate is already void') WHERE NEW.entry_kind = 'void'
    AND EXISTS (SELECT 1 FROM exchange_rates o WHERE o.id = NEW.supersedes_id AND o.entry_kind = 'void');
END;

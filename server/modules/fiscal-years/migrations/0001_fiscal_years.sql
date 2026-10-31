-- TAYL Phase 2 — السنوات والفترات المالية. لا قيود ولا ترحيل؛ البنية التي ستتحقق منها المستندات القادمة.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE fiscal_years (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar     TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en     TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  start_date  TEXT NOT NULL CHECK (date(start_date) IS start_date),
  end_date    TEXT NOT NULL CHECK (date(end_date) IS end_date),
  period_type TEXT NOT NULL CHECK (period_type IN ('monthly', 'quarterly')),
  created_by  INTEGER,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (end_date > start_date),
  CHECK (julianday(end_date) - julianday(start_date) <= 730)      -- سنة قصيرة/طويلة حتى 24 شهرًا
) STRICT;

-- لا تداخل بين السنوات (تُفرض في القاعدة نفسها)
CREATE TRIGGER fiscal_years_no_overlap_ins BEFORE INSERT ON fiscal_years
WHEN EXISTS (SELECT 1 FROM fiscal_years WHERE NEW.start_date <= end_date AND NEW.end_date >= start_date)
BEGIN SELECT RAISE(ABORT, 'fiscal years overlap'); END;
CREATE TRIGGER fiscal_years_no_overlap_upd BEFORE UPDATE OF start_date, end_date ON fiscal_years
WHEN EXISTS (SELECT 1 FROM fiscal_years WHERE id <> NEW.id AND NEW.start_date <= end_date AND NEW.end_date >= start_date)
BEGIN SELECT RAISE(ABORT, 'fiscal years overlap'); END;

CREATE TABLE fiscal_periods (
  id                INTEGER PRIMARY KEY,
  fiscal_year_id    INTEGER NOT NULL REFERENCES fiscal_years (id) ON DELETE CASCADE,
  seq               INTEGER NOT NULL CHECK (seq >= 1),
  name_ar           TEXT NOT NULL,
  name_en           TEXT NOT NULL,
  start_date        TEXT NOT NULL CHECK (date(start_date) IS start_date),
  end_date          TEXT NOT NULL CHECK (date(end_date) IS end_date),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed', 'locked')),   -- مفتوحة/مغلقة/مقفلة نهائيًا
  status_changed_at TEXT,
  status_changed_by INTEGER,
  status_reason     TEXT,
  UNIQUE (fiscal_year_id, seq),
  CHECK (end_date >= start_date)
) STRICT;
CREATE INDEX fiscal_periods_dates ON fiscal_periods (start_date, end_date);

-- الفترة داخل حدود سنتها، ولا تداخل بين الفترات
CREATE TRIGGER fiscal_periods_rules_ins BEFORE INSERT ON fiscal_periods
BEGIN
  SELECT RAISE(ABORT, 'period outside its fiscal year') WHERE NOT EXISTS
    (SELECT 1 FROM fiscal_years y WHERE y.id = NEW.fiscal_year_id AND NEW.start_date >= y.start_date AND NEW.end_date <= y.end_date);
  SELECT RAISE(ABORT, 'fiscal periods overlap') WHERE EXISTS
    (SELECT 1 FROM fiscal_periods WHERE NEW.start_date <= end_date AND NEW.end_date >= start_date);
END;
-- الفترة المقفلة نهائيًا لا تتغير؛ والتواريخ لا تتغير بعد الإنشاء
CREATE TRIGGER fiscal_periods_locked_final BEFORE UPDATE ON fiscal_periods WHEN OLD.status = 'locked'
BEGIN SELECT RAISE(ABORT, 'locked period is final'); END;
CREATE TRIGGER fiscal_periods_dates_fixed BEFORE UPDATE OF start_date, end_date, fiscal_year_id ON fiscal_periods
BEGIN SELECT RAISE(ABORT, 'period dates are fixed'); END;
CREATE TRIGGER fiscal_periods_delete_open_only BEFORE DELETE ON fiscal_periods WHEN OLD.status <> 'open'
BEGIN SELECT RAISE(ABORT, 'only open periods can be deleted'); END;

-- سجل أحداث الفترات (من أغلق/أعاد الفتح/أقفل، متى، ولماذا) — إضافة فقط
CREATE TABLE fiscal_period_events (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  period_id   INTEGER NOT NULL REFERENCES fiscal_periods (id),
  action      TEXT NOT NULL CHECK (action IN ('closed', 'reopened', 'locked')),
  from_status TEXT NOT NULL,
  to_status   TEXT NOT NULL,
  reason      TEXT NOT NULL CHECK (length(reason) BETWEEN 3 AND 500),
  user_id     INTEGER NOT NULL,
  username    TEXT NOT NULL,
  occurred_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TRIGGER fiscal_period_events_no_update BEFORE UPDATE ON fiscal_period_events BEGIN SELECT RAISE(ABORT, 'period events are append-only'); END;
CREATE TRIGGER fiscal_period_events_no_delete BEFORE DELETE ON fiscal_period_events BEGIN SELECT RAISE(ABORT, 'period events are append-only'); END;

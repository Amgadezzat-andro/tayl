-- TAYL Phase 4 — الإقفال السنوي وترحيل الأرصدة للسنة التالية. المرجع: docs/PHASE4_REPORT.md (القسمان 2 و3).
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد. لا يُعدَّل أي ترحيل سابق: الـ triggers المستبدلة تُحذف وتُنشأ هنا.
--
-- البنية:
--   year_closings   عملية إقفال (سنة × فرع)؛ نشطة واحدة فقط لكل (سنة، فرع)، والإلغاء يغيّر الحالة ولا يحذف السجل.
--   carry_forwards  عملية ترحيل الأرصدة من سنة إلى التالية (سنة × فرع)؛ تتبع إقفالًا نشطًا.
--   year_end_entries / year_end_lines  مستندات النظام: قيد الإقفال (source_type = year_closing، entry_kind = closing)
--                   وقيد ترحيل الأرصدة (source_type = carry_forward، entry_kind = opening) وعكس كل منهما.
--                   لا ينشئها إلا دورة الإقفال: كل مستند يتبع عملية نشطة، وتُرحَّل عبر محرك الترحيل نفسه.
--   year_end_requests  مفاتيح منع التكرار (idempotency) ونتائجها؛ إضافة فقط.
-- الصيغة العشرية لكل مبلغ وسعر كما في journal/0001 (الصفر '0' فقط، لا صيغة أخرى).

-- ── الإعدادات: حساب نتيجة السنة (الأرباح المحتجزة) — لا افتراض لأي كود حساب ──
CREATE TABLE year_end_settings (
  id                           INTEGER PRIMARY KEY CHECK (id = 1),
  retained_earnings_account_id INTEGER REFERENCES accounts (id),
  updated_by                   INTEGER,
  updated_at                   TEXT
) STRICT;
INSERT INTO year_end_settings (id) VALUES (1);
CREATE TRIGGER year_end_settings_no_delete BEFORE DELETE ON year_end_settings BEGIN SELECT RAISE(ABORT, 'year-end settings row is fixed'); END;

-- ── عمليات الإقفال ──
CREATE TABLE year_closings (
  id                           INTEGER PRIMARY KEY,
  fiscal_year_id               INTEGER NOT NULL REFERENCES fiscal_years (id),
  branch_id                    INTEGER NOT NULL REFERENCES branches (id),
  status                       TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reverted')),
  retained_earnings_account_id INTEGER NOT NULL REFERENCES accounts (id),   -- لقطة الإعداد وقت الإقفال
  closing_date                 TEXT NOT NULL CHECK (date(closing_date) IS closing_date),
  result_side                  TEXT NOT NULL CHECK (result_side IN ('profit', 'loss', 'zero')),
  net_result                   TEXT NOT NULL CHECK ((net_result = '0' OR ((net_result GLOB '[1-9]*' OR net_result GLOB '0.[0-9]*') AND net_result NOT GLOB '*[^0-9.]*' AND net_result NOT GLOB '*.*.*' AND net_result NOT GLOB '*.' AND net_result NOT GLOB '*.*0' AND (instr(net_result, '.') = 0 OR length(net_result) - instr(net_result, '.') <= 8) AND (CASE WHEN instr(net_result, '.') = 0 THEN length(net_result) ELSE instr(net_result, '.') - 1 END) <= 20))),
  summary                      TEXT NOT NULL CHECK (json_valid(summary)),     -- إجماليات الإيرادات والمصروفات وعدد السطور
  readiness                    TEXT NOT NULL CHECK (json_valid(readiness)),   -- نتائج فحص الجاهزية وقت التنفيذ
  fingerprint                  TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_by                   INTEGER NOT NULL,
  created_at                   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reverted_by                  INTEGER,
  reverted_at                  TEXT,
  revert_reason                TEXT CHECK (revert_reason IS NULL OR length(trim(revert_reason)) BETWEEN 3 AND 500),
  CHECK ((result_side = 'zero') = (net_result = '0')),
  CHECK ((status = 'reverted') = (reverted_by IS NOT NULL AND reverted_at IS NOT NULL AND revert_reason IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX year_closings_one_active ON year_closings (fiscal_year_id, branch_id) WHERE status = 'active';
CREATE INDEX year_closings_branch ON year_closings (branch_id, fiscal_year_id);

-- ── عمليات ترحيل الأرصدة ──
CREATE TABLE carry_forwards (
  id                  INTEGER PRIMARY KEY,
  from_year_id        INTEGER NOT NULL REFERENCES fiscal_years (id),
  to_year_id          INTEGER NOT NULL REFERENCES fiscal_years (id),
  branch_id           INTEGER NOT NULL REFERENCES branches (id),
  closing_id          INTEGER NOT NULL REFERENCES year_closings (id),
  status              TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'reverted')),
  reconciliation      TEXT NOT NULL CHECK (json_valid(reconciliation)),      -- مطابقة نهاية السنة مع الافتتاح وقت التنفيذ
  reconciliation_hash TEXT NOT NULL CHECK (length(reconciliation_hash) = 64),
  fingerprint         TEXT NOT NULL CHECK (length(fingerprint) = 64),
  created_by          INTEGER NOT NULL,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  reverted_by         INTEGER,
  reverted_at         TEXT,
  revert_reason       TEXT CHECK (revert_reason IS NULL OR length(trim(revert_reason)) BETWEEN 3 AND 500),
  CHECK (to_year_id <> from_year_id),
  CHECK ((status = 'reverted') = (reverted_by IS NOT NULL AND reverted_at IS NOT NULL AND revert_reason IS NOT NULL))
) STRICT;
CREATE UNIQUE INDEX carry_forwards_one_active ON carry_forwards (from_year_id, branch_id) WHERE status = 'active';
CREATE INDEX carry_forwards_closing ON carry_forwards (closing_id);

-- ── مستندات النظام ──
CREATE TABLE year_end_entries (
  id               INTEGER PRIMARY KEY,
  kind             TEXT NOT NULL CHECK (kind IN ('closing', 'carry_forward')),
  closing_id       INTEGER REFERENCES year_closings (id),       -- قيد الإقفال وعكسه
  carry_forward_id INTEGER REFERENCES carry_forwards (id),      -- قيد الترحيل وعكسه
  is_reversal      INTEGER NOT NULL DEFAULT 0 CHECK (is_reversal IN (0, 1)),
  reverses_id      INTEGER REFERENCES year_end_entries (id),
  reason           TEXT CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 3 AND 500),
  status           TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'posted')),
  closing_year_id  INTEGER NOT NULL REFERENCES fiscal_years (id),   -- السنة المُقفلة
  fiscal_year_id   INTEGER NOT NULL REFERENCES fiscal_years (id),   -- سنة تاريخ المستند (التالية لقيد الترحيل)
  branch_id        INTEGER NOT NULL REFERENCES branches (id),
  entry_date       TEXT NOT NULL CHECK (date(entry_date) IS entry_date),
  series_id        INTEGER NOT NULL REFERENCES document_series (id),
  description      TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  total_base       TEXT NOT NULL DEFAULT '0' CHECK ((total_base = '0' OR ((total_base GLOB '[1-9]*' OR total_base GLOB '0.[0-9]*') AND total_base NOT GLOB '*[^0-9.]*' AND total_base NOT GLOB '*.*.*' AND total_base NOT GLOB '*.' AND total_base NOT GLOB '*.*0' AND (instr(total_base, '.') = 0 OR length(total_base) - instr(total_base, '.') <= 8) AND (CASE WHEN instr(total_base, '.') = 0 THEN length(total_base) ELSE instr(total_base, '.') - 1 END) <= 20))),
  created_by       INTEGER NOT NULL,
  created_at       TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  number           TEXT UNIQUE CHECK (number IS NULL OR length(number) BETWEEN 3 AND 80),
  fiscal_period_id INTEGER REFERENCES fiscal_periods (id),
  decimal_snapshot TEXT,
  posted_by        INTEGER,
  posted_at        TEXT,
  CHECK ((kind = 'closing') = (closing_id IS NOT NULL)),
  CHECK ((kind = 'carry_forward') = (carry_forward_id IS NOT NULL)),
  CHECK ((is_reversal = 1) = (reverses_id IS NOT NULL)),
  CHECK ((is_reversal = 1) = (reason IS NOT NULL)),
  CHECK ((status = 'posted') = (number IS NOT NULL)),
  CHECK ((status = 'posted') = (fiscal_period_id IS NOT NULL)),
  CHECK ((status = 'posted') = (decimal_snapshot IS NOT NULL)),
  CHECK ((status = 'posted') = (posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status = 'pending' OR total_base <> '0')
) STRICT;
CREATE UNIQUE INDEX year_end_entries_one_reversal ON year_end_entries (reverses_id);
CREATE INDEX year_end_entries_closing ON year_end_entries (closing_id);
CREATE INDEX year_end_entries_carry_forward ON year_end_entries (carry_forward_id);
CREATE INDEX year_end_entries_year_branch ON year_end_entries (closing_year_id, branch_id);

CREATE TABLE year_end_lines (
  id               INTEGER PRIMARY KEY,
  entry_id         INTEGER NOT NULL REFERENCES year_end_entries (id),
  line_no          INTEGER NOT NULL CHECK (line_no >= 1),
  account_id       INTEGER NOT NULL REFERENCES accounts (id),
  cost_center_id   INTEGER REFERENCES cost_centers (id),
  currency_id      INTEGER NOT NULL REFERENCES currencies (id),
  -- balance: الرصيد كما هو (أصلي + أساسي)؛ split: الجزء الأجنبي بسعر الجدول عند تعذر التمثيل؛ residual: باقي الأساسي بالعملة الأساسية
  basis            TEXT NOT NULL CHECK (basis IN ('balance', 'split', 'residual', 'result')),
  rate             TEXT NOT NULL CHECK (((rate GLOB '[1-9]*' OR rate GLOB '0.[0-9]*') AND rate NOT GLOB '*[^0-9.]*' AND rate NOT GLOB '*.*.*' AND rate NOT GLOB '*.' AND rate NOT GLOB '*.*0' AND (instr(rate, '.') = 0 OR length(rate) - instr(rate, '.') <= 12) AND (CASE WHEN instr(rate, '.') = 0 THEN length(rate) ELSE instr(rate, '.') - 1 END) <= 12)),
  rate_source      TEXT NOT NULL CHECK (rate_source IN ('base', 'manual')),   -- manual = سعر مشتق من الرصيد، ليس من جدول الأسعار
  debit_fc         TEXT NOT NULL DEFAULT '0' CHECK ((debit_fc = '0' OR ((debit_fc GLOB '[1-9]*' OR debit_fc GLOB '0.[0-9]*') AND debit_fc NOT GLOB '*[^0-9.]*' AND debit_fc NOT GLOB '*.*.*' AND debit_fc NOT GLOB '*.' AND debit_fc NOT GLOB '*.*0' AND (instr(debit_fc, '.') = 0 OR length(debit_fc) - instr(debit_fc, '.') <= 8) AND (CASE WHEN instr(debit_fc, '.') = 0 THEN length(debit_fc) ELSE instr(debit_fc, '.') - 1 END) <= 20))),
  credit_fc        TEXT NOT NULL DEFAULT '0' CHECK ((credit_fc = '0' OR ((credit_fc GLOB '[1-9]*' OR credit_fc GLOB '0.[0-9]*') AND credit_fc NOT GLOB '*[^0-9.]*' AND credit_fc NOT GLOB '*.*.*' AND credit_fc NOT GLOB '*.' AND credit_fc NOT GLOB '*.*0' AND (instr(credit_fc, '.') = 0 OR length(credit_fc) - instr(credit_fc, '.') <= 8) AND (CASE WHEN instr(credit_fc, '.') = 0 THEN length(credit_fc) ELSE instr(credit_fc, '.') - 1 END) <= 20))),
  debit            TEXT NOT NULL DEFAULT '0' CHECK ((debit = '0' OR ((debit GLOB '[1-9]*' OR debit GLOB '0.[0-9]*') AND debit NOT GLOB '*[^0-9.]*' AND debit NOT GLOB '*.*.*' AND debit NOT GLOB '*.' AND debit NOT GLOB '*.*0' AND (instr(debit, '.') = 0 OR length(debit) - instr(debit, '.') <= 8) AND (CASE WHEN instr(debit, '.') = 0 THEN length(debit) ELSE instr(debit, '.') - 1 END) <= 20))),
  credit           TEXT NOT NULL DEFAULT '0' CHECK ((credit = '0' OR ((credit GLOB '[1-9]*' OR credit GLOB '0.[0-9]*') AND credit NOT GLOB '*[^0-9.]*' AND credit NOT GLOB '*.*.*' AND credit NOT GLOB '*.' AND credit NOT GLOB '*.*0' AND (instr(credit, '.') = 0 OR length(credit) - instr(credit, '.') <= 8) AND (CASE WHEN instr(credit, '.') = 0 THEN length(credit) ELSE instr(credit, '.') - 1 END) <= 20))),
  description      TEXT CHECK (description IS NULL OR length(description) <= 300),
  reverses_line_id INTEGER REFERENCES year_end_lines (id),
  UNIQUE (entry_id, line_no),
  UNIQUE (entry_id, reverses_line_id),
  CHECK ((debit_fc = '0') <> (credit_fc = '0')),
  CHECK ((debit = '0') <> (credit = '0')),
  CHECK ((debit = '0') = (debit_fc = '0')),
  CHECK (rate_source <> 'base' OR (rate = '1' AND debit = debit_fc AND credit = credit_fc))
) STRICT;
CREATE INDEX year_end_lines_entry ON year_end_lines (entry_id);
CREATE INDEX year_end_lines_account ON year_end_lines (account_id);

-- ── مفاتيح منع التكرار ──
CREATE TABLE year_end_requests (
  idempotency_key TEXT PRIMARY KEY CHECK (length(idempotency_key) BETWEEN 8 AND 100),
  operation       TEXT NOT NULL CHECK (operation IN ('close', 'carry_forward', 'reopen', 'revert_carry_forward')),
  fiscal_year_id  INTEGER NOT NULL REFERENCES fiscal_years (id),
  user_id         INTEGER NOT NULL,
  result          TEXT NOT NULL CHECK (json_valid(result)),
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
CREATE TRIGGER year_end_requests_no_update BEFORE UPDATE ON year_end_requests BEGIN SELECT RAISE(ABORT, 'year-end requests are append-only'); END;
CREATE TRIGGER year_end_requests_no_delete BEFORE DELETE ON year_end_requests BEGIN SELECT RAISE(ABORT, 'year-end requests are append-only'); END;

-- ── قواعد year_closings ──
CREATE TRIGGER year_closings_insert_rules BEFORE INSERT ON year_closings
BEGIN
  SELECT RAISE(ABORT, 'a closing is created active') WHERE NEW.status <> 'active' OR NEW.reverted_by IS NOT NULL;
  SELECT RAISE(ABORT, 'closing date is the last day of the fiscal year') WHERE NEW.closing_date IS NOT (SELECT end_date FROM fiscal_years WHERE id = NEW.fiscal_year_id);
  -- كل فروع السنة تُقفل إلى حساب نتيجة واحد
  SELECT RAISE(ABORT, 'all closings of a fiscal year use the same retained earnings account') WHERE EXISTS
    (SELECT 1 FROM year_closings c WHERE c.fiscal_year_id = NEW.fiscal_year_id AND c.status = 'active' AND c.retained_earnings_account_id <> NEW.retained_earnings_account_id);
  -- التسلسل: السنة السابقة مُقفلة ومُرحّلة لهذا الفرع إن كان له فيها (أو قبلها) حركات
  SELECT RAISE(ABORT, 'the previous fiscal year must be closed and carried forward first') WHERE EXISTS
    (SELECT 1 FROM fiscal_years y JOIN fiscal_years p ON p.end_date = date(y.start_date, '-1 day')
      WHERE y.id = NEW.fiscal_year_id
        AND EXISTS (SELECT 1 FROM gl_entries g WHERE g.branch_id = NEW.branch_id AND g.posting_date < y.start_date)
        AND (NOT EXISTS (SELECT 1 FROM year_closings c WHERE c.fiscal_year_id = p.id AND c.branch_id = NEW.branch_id AND c.status = 'active')
          OR NOT EXISTS (SELECT 1 FROM carry_forwards f WHERE f.from_year_id = p.id AND f.branch_id = NEW.branch_id AND f.status = 'active')));
END;
CREATE TRIGGER year_closings_no_delete BEFORE DELETE ON year_closings BEGIN SELECT RAISE(ABORT, 'closing history is kept; revert instead'); END;
CREATE TRIGGER year_closings_update_rules BEFORE UPDATE ON year_closings
BEGIN
  SELECT RAISE(ABORT, 'a closing record is fixed; only an active closing can be reverted')
    WHERE OLD.status <> 'active' OR NEW.status <> 'reverted'
       OR NEW.id IS NOT OLD.id OR NEW.fiscal_year_id IS NOT OLD.fiscal_year_id OR NEW.branch_id IS NOT OLD.branch_id
       OR NEW.retained_earnings_account_id IS NOT OLD.retained_earnings_account_id OR NEW.closing_date IS NOT OLD.closing_date
       OR NEW.result_side IS NOT OLD.result_side OR NEW.net_result IS NOT OLD.net_result OR NEW.summary IS NOT OLD.summary
       OR NEW.readiness IS NOT OLD.readiness OR NEW.fingerprint IS NOT OLD.fingerprint
       OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'revert the carry-forward of this year first') WHERE EXISTS
    (SELECT 1 FROM carry_forwards f WHERE f.closing_id = OLD.id AND f.status = 'active');
  SELECT RAISE(ABORT, 'the next fiscal year is closed for this branch; reopen it first') WHERE EXISTS
    (SELECT 1 FROM fiscal_years y JOIN fiscal_years n ON n.start_date = date(y.end_date, '+1 day')
       JOIN year_closings c ON c.fiscal_year_id = n.id AND c.branch_id = OLD.branch_id AND c.status = 'active' WHERE y.id = OLD.fiscal_year_id);
  SELECT RAISE(ABORT, 'the closing entry must be reversed before the closing is reverted') WHERE EXISTS
    (SELECT 1 FROM year_end_entries e WHERE e.closing_id = OLD.id AND e.is_reversal = 0 AND e.status = 'posted'
       AND NOT EXISTS (SELECT 1 FROM year_end_entries r WHERE r.reverses_id = e.id AND r.status = 'posted'));
END;

-- ── قواعد carry_forwards ──
CREATE TRIGGER carry_forwards_insert_rules BEFORE INSERT ON carry_forwards
BEGIN
  SELECT RAISE(ABORT, 'a carry-forward is created active') WHERE NEW.status <> 'active' OR NEW.reverted_by IS NOT NULL;
  SELECT RAISE(ABORT, 'carry-forward follows an active closing of the same year and branch') WHERE NOT EXISTS
    (SELECT 1 FROM year_closings c WHERE c.id = NEW.closing_id AND c.status = 'active' AND c.fiscal_year_id = NEW.from_year_id AND c.branch_id = NEW.branch_id);
  SELECT RAISE(ABORT, 'balances are carried to the fiscal year that follows directly') WHERE NOT EXISTS
    (SELECT 1 FROM fiscal_years y JOIN fiscal_years n ON n.start_date = date(y.end_date, '+1 day') WHERE y.id = NEW.from_year_id AND n.id = NEW.to_year_id);
  SELECT RAISE(ABORT, 'the next fiscal year is already closed for this branch') WHERE EXISTS
    (SELECT 1 FROM year_closings c WHERE c.fiscal_year_id = NEW.to_year_id AND c.branch_id = NEW.branch_id AND c.status = 'active');
END;
CREATE TRIGGER carry_forwards_no_delete BEFORE DELETE ON carry_forwards BEGIN SELECT RAISE(ABORT, 'carry-forward history is kept; revert instead'); END;
CREATE TRIGGER carry_forwards_update_rules BEFORE UPDATE ON carry_forwards
BEGIN
  SELECT RAISE(ABORT, 'a carry-forward record is fixed; only an active carry-forward can be reverted')
    WHERE OLD.status <> 'active' OR NEW.status <> 'reverted'
       OR NEW.id IS NOT OLD.id OR NEW.from_year_id IS NOT OLD.from_year_id OR NEW.to_year_id IS NOT OLD.to_year_id OR NEW.branch_id IS NOT OLD.branch_id
       OR NEW.closing_id IS NOT OLD.closing_id OR NEW.reconciliation IS NOT OLD.reconciliation OR NEW.reconciliation_hash IS NOT OLD.reconciliation_hash
       OR NEW.fingerprint IS NOT OLD.fingerprint OR NEW.created_by IS NOT OLD.created_by OR NEW.created_at IS NOT OLD.created_at;
  SELECT RAISE(ABORT, 'the next fiscal year is closed for this branch; reopen it first') WHERE EXISTS
    (SELECT 1 FROM year_closings c WHERE c.fiscal_year_id = OLD.to_year_id AND c.branch_id = OLD.branch_id AND c.status = 'active');
  SELECT RAISE(ABORT, 'the carry-forward entry must be reversed before the carry-forward is reverted') WHERE EXISTS
    (SELECT 1 FROM year_end_entries e WHERE e.carry_forward_id = OLD.id AND e.is_reversal = 0 AND e.status = 'posted'
       AND NOT EXISTS (SELECT 1 FROM year_end_entries r WHERE r.reverses_id = e.id AND r.status = 'posted'));
END;

-- ── قواعد مستندات النظام ──
CREATE TRIGGER year_end_entries_insert_rules BEFORE INSERT ON year_end_entries
BEGIN
  SELECT RAISE(ABORT, 'year-end entries are created pending and posted by the ledger') WHERE NEW.status <> 'pending';
  -- لا مستند خارج عملية نشطة من دورة الإقفال، بالفرع والسنة والتاريخ الصحيحين
  SELECT RAISE(ABORT, 'a closing entry belongs to an active closing of its year and branch, dated on the year end') WHERE NEW.kind = 'closing' AND NOT EXISTS
    (SELECT 1 FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id
      WHERE c.id = NEW.closing_id AND c.status = 'active' AND c.branch_id = NEW.branch_id AND c.fiscal_year_id = NEW.closing_year_id
        AND NEW.fiscal_year_id = y.id AND NEW.entry_date = y.end_date);
  SELECT RAISE(ABORT, 'a carry-forward entry belongs to an active carry-forward, dated on the first day of the next year') WHERE NEW.kind = 'carry_forward' AND NOT EXISTS
    (SELECT 1 FROM carry_forwards f JOIN fiscal_years n ON n.id = f.to_year_id
      WHERE f.id = NEW.carry_forward_id AND f.status = 'active' AND f.branch_id = NEW.branch_id AND f.from_year_id = NEW.closing_year_id
        AND NEW.fiscal_year_id = n.id AND NEW.entry_date = n.start_date);
  -- مستند أصلي واحد لكل عملية
  SELECT RAISE(ABORT, 'an operation has one original entry') WHERE NEW.is_reversal = 0 AND EXISTS
    (SELECT 1 FROM year_end_entries e WHERE e.is_reversal = 0 AND (e.closing_id IS NEW.closing_id AND e.carry_forward_id IS NEW.carry_forward_id));
  -- العكس: لمستند أصلي مرحّل من العملية نفسها وبتاريخه
  SELECT RAISE(ABORT, 'a reversal mirrors a posted original entry of the same operation and date') WHERE NEW.is_reversal = 1 AND NOT EXISTS
    (SELECT 1 FROM year_end_entries o WHERE o.id = NEW.reverses_id AND o.status = 'posted' AND o.is_reversal = 0 AND o.kind = NEW.kind
       AND o.closing_id IS NEW.closing_id AND o.carry_forward_id IS NEW.carry_forward_id AND o.branch_id = NEW.branch_id AND o.entry_date = NEW.entry_date);
END;
CREATE TRIGGER year_end_entries_posted_frozen BEFORE UPDATE ON year_end_entries WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted year-end entries cannot be modified; revert the operation'); END;
CREATE TRIGGER year_end_entries_no_delete BEFORE DELETE ON year_end_entries BEGIN SELECT RAISE(ABORT, 'year-end entries cannot be deleted'); END;
CREATE TRIGGER year_end_entries_fixed BEFORE UPDATE ON year_end_entries
WHEN NEW.kind IS NOT OLD.kind OR NEW.closing_id IS NOT OLD.closing_id OR NEW.carry_forward_id IS NOT OLD.carry_forward_id OR NEW.is_reversal IS NOT OLD.is_reversal
  OR NEW.reverses_id IS NOT OLD.reverses_id OR NEW.branch_id IS NOT OLD.branch_id OR NEW.entry_date IS NOT OLD.entry_date
  OR NEW.closing_year_id IS NOT OLD.closing_year_id OR NEW.fiscal_year_id IS NOT OLD.fiscal_year_id
BEGIN SELECT RAISE(ABORT, 'year-end entry identity is fixed'); END;
CREATE TRIGGER year_end_entries_post_checks BEFORE UPDATE OF status ON year_end_entries
WHEN OLD.status = 'pending' AND NEW.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'a year-end entry needs at least two lines') WHERE (SELECT count(*) FROM year_end_lines WHERE entry_id = NEW.id) < 2;
  SELECT RAISE(ABORT, 'year-end entry is not balanced in base currency')
    WHERE dec_cmp((SELECT dec_sum(debit) FROM year_end_lines WHERE entry_id = NEW.id), (SELECT dec_sum(credit) FROM year_end_lines WHERE entry_id = NEW.id)) <> 0
       OR dec_cmp(NEW.total_base, (SELECT dec_sum(debit) FROM year_end_lines WHERE entry_id = NEW.id)) <> 0;
  SELECT RAISE(ABORT, 'reversal must mirror every line of the original exactly once') WHERE NEW.is_reversal = 1 AND (
      (SELECT count(*) FROM year_end_lines WHERE entry_id = NEW.id) <> (SELECT count(*) FROM year_end_lines WHERE entry_id = NEW.reverses_id)
      OR EXISTS (SELECT 1 FROM year_end_lines o WHERE o.entry_id = NEW.reverses_id
                   AND NOT EXISTS (SELECT 1 FROM year_end_lines r WHERE r.entry_id = NEW.id AND r.reverses_line_id = o.id)));
  SELECT RAISE(ABORT, 'year-end posting period must contain the date and not be locked') WHERE NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.fiscal_year_id = NEW.fiscal_year_id AND p.status IN ('open', 'closed')
       AND NEW.entry_date BETWEEN p.start_date AND p.end_date);
  SELECT RAISE(ABORT, 'group accounts cannot be posted to') WHERE EXISTS
    (SELECT 1 FROM year_end_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = NEW.id AND a.is_group = 1);
END;

CREATE TRIGGER year_end_lines_insert_rules BEFORE INSERT ON year_end_lines
BEGIN
  SELECT RAISE(ABORT, 'lines of a posted year-end entry cannot be changed') WHERE (SELECT status FROM year_end_entries WHERE id = NEW.entry_id) IS NOT 'pending';
  SELECT RAISE(ABORT, 'rate source base is for base-currency lines only')
    WHERE (NEW.rate_source = 'base') <> (NEW.currency_id IS (SELECT c.id FROM currencies c JOIN company co ON co.id = 1 AND c.code = co.base_currency));
  SELECT RAISE(ABORT, 'only reversal lines reference an original line')
    WHERE NEW.reverses_line_id IS NOT NULL AND (SELECT is_reversal FROM year_end_entries WHERE id = NEW.entry_id) IS NOT 1;
  SELECT RAISE(ABORT, 'reversal line must mirror a line of the reversed entry')
    WHERE (SELECT is_reversal FROM year_end_entries WHERE id = NEW.entry_id) = 1 AND NOT EXISTS
      (SELECT 1 FROM year_end_lines o JOIN year_end_entries e ON e.id = NEW.entry_id
        WHERE o.id = NEW.reverses_line_id AND o.entry_id = e.reverses_id
          AND o.account_id = NEW.account_id AND o.cost_center_id IS NEW.cost_center_id AND o.currency_id = NEW.currency_id
          AND o.rate = NEW.rate AND o.rate_source = NEW.rate_source AND o.basis = NEW.basis
          AND o.debit_fc = NEW.credit_fc AND o.credit_fc = NEW.debit_fc AND o.debit = NEW.credit AND o.credit = NEW.debit);
END;
CREATE TRIGGER year_end_lines_no_update BEFORE UPDATE ON year_end_lines BEGIN SELECT RAISE(ABORT, 'year-end lines cannot be changed'); END;
CREATE TRIGGER year_end_lines_no_delete BEFORE DELETE ON year_end_lines BEGIN SELECT RAISE(ABORT, 'year-end lines cannot be changed'); END;

-- ── الأستاذ: مصدران جديدان، وقفل السنة المُقفلة للفرع (يستبدل trigger الترحيل 0002 دون تعديله) ──
DROP TRIGGER gl_entries_insert_rules;
CREATE TRIGGER gl_entries_insert_rules BEFORE INSERT ON gl_entries
BEGIN
  SELECT RAISE(ABORT, 'unknown ledger source') WHERE NEW.source_type NOT IN ('journal', 'year_closing', 'carry_forward');
  SELECT RAISE(ABORT, 'closing entries come from the year-end closing only') WHERE NEW.entry_kind = 'closing' AND NEW.source_type <> 'year_closing';
  SELECT RAISE(ABORT, 'group accounts cannot be posted to') WHERE (SELECT is_group FROM accounts WHERE id = NEW.account_id) IS NOT 0;
  -- القيد اليومي: فترة مفتوحة، والسنة غير مُقفلة لفرعه، وسطر الأستاذ نسخة حرفية من سطر قيد مرحّل (كما في 0002)
  SELECT RAISE(ABORT, 'posting period must be open and contain the posting date') WHERE NEW.source_type = 'journal' AND NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.fiscal_year_id = NEW.fiscal_year_id
       AND p.status = 'open' AND NEW.posting_date BETWEEN p.start_date AND p.end_date);
  -- لا قيد يومي بتاريخ حتى نهاية أي سنة مُقفلة لفرعه (ولا في سنة سابقة لها: يغيّر النتيجة المُقفلة تراكميًا)
  SELECT RAISE(ABORT, 'fiscal year is closed for this branch') WHERE NEW.source_type = 'journal' AND EXISTS
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
  SELECT RAISE(ABORT, 'year-end posting period must contain the date and not be locked') WHERE NEW.source_type <> 'journal' AND NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.fiscal_year_id = NEW.fiscal_year_id
       AND p.status IN ('open', 'closed') AND NEW.posting_date BETWEEN p.start_date AND p.end_date);
  SELECT RAISE(ABORT, 'ledger line must match a line of the posted year-end entry') WHERE NEW.source_type <> 'journal' AND NOT EXISTS
    (SELECT 1 FROM year_end_entries e JOIN year_end_lines l ON l.entry_id = e.id
      WHERE e.id = NEW.source_id AND e.status = 'posted' AND e.number = NEW.doc_number AND e.branch_id = NEW.branch_id
        AND e.entry_date = NEW.posting_date AND e.fiscal_period_id = NEW.fiscal_period_id AND e.fiscal_year_id = NEW.fiscal_year_id
        AND (CASE e.kind WHEN 'closing' THEN 'year_closing' ELSE 'carry_forward' END) = NEW.source_type
        AND (CASE e.kind WHEN 'closing' THEN 'closing' ELSE 'opening' END) = NEW.entry_kind
        AND l.id = NEW.source_line_id AND l.account_id = NEW.account_id AND l.cost_center_id IS NEW.cost_center_id
        AND l.currency_id = NEW.currency_id AND l.rate = NEW.rate AND l.rate_source = NEW.rate_source
        AND l.debit_fc = NEW.debit_fc AND l.credit_fc = NEW.credit_fc AND l.debit = NEW.debit AND l.credit = NEW.credit);
END;

-- القيد اليومي لا يُرحَّل بتاريخ حتى نهاية سنة مُقفلة لفرعه (الدفاع الثاني خلف الخادم والأستاذ)
CREATE TRIGGER journal_entries_year_closed BEFORE UPDATE OF status ON journal_entries
WHEN OLD.status = 'draft' AND NEW.status = 'posted' AND EXISTS
  (SELECT 1 FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id
    WHERE c.branch_id = NEW.branch_id AND c.status = 'active' AND NEW.entry_date <= y.end_date)
BEGIN SELECT RAISE(ABORT, 'fiscal year is closed for this branch'); END;

-- القيد اليومي لا يكون قيد إقفال أبدًا (يستبدل رسالة المرحلة 3)
DROP TRIGGER journal_entries_closing_reserved;
CREATE TRIGGER journal_entries_closing_reserved BEFORE INSERT ON journal_entries WHEN NEW.entry_type = 'closing'
BEGIN SELECT RAISE(ABORT, 'closing entries are created by the year-end closing only'); END;

-- P10: آخر فترة في السنة لا تُقفل نهائيًا قبل إقفال السنة لكل فرع له حركات حتى نهايتها (وإلا تعذّر قيد الإقفال للأبد)
CREATE TRIGGER fiscal_periods_lock_last_needs_closing BEFORE UPDATE OF status ON fiscal_periods
WHEN NEW.status = 'locked' AND OLD.status IS NOT 'locked' AND OLD.end_date = (SELECT end_date FROM fiscal_years WHERE id = OLD.fiscal_year_id)
BEGIN
  SELECT RAISE(ABORT, 'the last period of a year is locked only after every branch has closed the year') WHERE EXISTS
    (SELECT 1 FROM branches b WHERE EXISTS (SELECT 1 FROM gl_entries g WHERE g.branch_id = b.id AND g.posting_date <= OLD.end_date)
       AND NOT EXISTS (SELECT 1 FROM year_closings c WHERE c.fiscal_year_id = OLD.fiscal_year_id AND c.branch_id = b.id AND c.status = 'active'));
END;

-- حساب نتيجة السنة لا يتغير والسنة مُقفلة جزئيًا (بعض الفروع دون بعض)
CREATE TRIGGER year_end_settings_locked_mid_close BEFORE UPDATE OF retained_earnings_account_id ON year_end_settings
WHEN NEW.retained_earnings_account_id IS NOT OLD.retained_earnings_account_id AND EXISTS
  (SELECT 1 FROM year_closings c JOIN fiscal_years y ON y.id = c.fiscal_year_id WHERE c.status = 'active' AND EXISTS
    (SELECT 1 FROM branches b WHERE EXISTS (SELECT 1 FROM gl_entries g WHERE g.branch_id = b.id AND g.posting_date <= y.end_date)
       AND NOT EXISTS (SELECT 1 FROM year_closings c2 WHERE c2.fiscal_year_id = y.id AND c2.branch_id = b.id AND c2.status = 'active')))
BEGIN SELECT RAISE(ABORT, 'retained earnings account cannot change while a fiscal year is partially closed'); END;

-- سلاسل الترقيم (رقم فريد لكل مستند، لكل فرع وسنة؛ لا يُعاد استخدامه)
INSERT INTO document_series (code, doc_type, name_ar, name_en, prefix, is_default) VALUES
  ('YC',  'year_closing',           'قيود الإقفال السنوي',     'Year-end closing entries',   'YC',  1),
  ('YCR', 'year_closing_reversal',  'عكس قيود الإقفال',        'Closing reversals',          'YCR', 1),
  ('CF',  'carry_forward',          'ترحيل الأرصدة',           'Balances carried forward',   'CF',  1),
  ('CFR', 'carry_forward_reversal', 'عكس ترحيل الأرصدة',       'Carry-forward reversals',    'CFR', 1);

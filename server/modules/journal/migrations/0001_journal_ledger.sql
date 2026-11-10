-- TAYL Phase 3 (3.1) — القيود اليومية والأستاذ العام ومحرك الترحيل.
-- المرجع: docs/PHASE3_PROPOSAL.md (الأقسام 5 و6 و9). لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.
--
-- قواعد الصيغة العشرية في كل الجداول هنا:
--   * كل مبلغ إما '0' حرفيًا (الصيغة الوحيدة للصفر) أو نص عشري قانوني موجب: يبدأ بـ [1-9] أو '0.'،
--     أرقام ونقطة واحدة فقط، لا نقطة أخيرة، لا صفر زائد بعد الكسر، كسر <= 8 خانات (السعر 12)، صحيح <= 20 (السعر 12).
--     النمط لا يقبل أي صفر ('0.0' و'00' و'-0' ...)، فـ «غير '0'» تعني «موجب» حتمًا.
--   * كل حقل إلزامي دائمًا NOT NULL؛ الإلزامي حسب الحالة بـ CHECK تكافؤ آمن من NULL + trigger الترحيل.
--   * trigger الترحيل يستخدم dec_sum/dec_cmp (دوال المحرك المسجلة على اتصال البرنامج)؛ خارج البرنامج يفشل الترحيل.

CREATE TABLE journal_entries (
  id                    INTEGER PRIMARY KEY,
  branch_id             INTEGER NOT NULL REFERENCES branches (id),
  entry_type            TEXT NOT NULL CHECK (entry_type IN ('general', 'opening', 'reversal', 'closing')),  -- closing محجوز للمرحلة 4
  status                TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'posted')),
  entry_date            TEXT NOT NULL CHECK (date(entry_date) IS entry_date),
  series_id             INTEGER NOT NULL REFERENCES document_series (id),
  default_currency_id   INTEGER NOT NULL REFERENCES currencies (id),
  description           TEXT NOT NULL CHECK (length(trim(description)) BETWEEN 1 AND 500),
  reference             TEXT CHECK (reference IS NULL OR length(reference) BETWEEN 1 AND 100),
  total_base            TEXT NOT NULL DEFAULT '0' CHECK (total_base = '0' OR ((total_base GLOB '[1-9]*' OR total_base GLOB '0.[0-9]*') AND total_base NOT GLOB '*[^0-9.]*' AND total_base NOT GLOB '*.*.*' AND total_base NOT GLOB '*.' AND total_base NOT GLOB '*.*0' AND (instr(total_base, '.') = 0 OR length(total_base) - instr(total_base, '.') <= 8) AND (CASE WHEN instr(total_base, '.') = 0 THEN length(total_base) ELSE instr(total_base, '.') - 1 END) <= 20)),
  is_multi_currency     INTEGER NOT NULL DEFAULT 0 CHECK (is_multi_currency IN (0, 1)),
  future_date_confirmed INTEGER NOT NULL DEFAULT 0 CHECK (future_date_confirmed IN (0, 1)),
  created_by            INTEGER NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_by            INTEGER NOT NULL,
  updated_at            TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  -- إلزامية حسب الحالة (NULL مقصود في المسودة أو لغير العكسي):
  number                TEXT UNIQUE CHECK (number IS NULL OR length(number) BETWEEN 3 AND 80),
  fiscal_period_id      INTEGER REFERENCES fiscal_periods (id),
  decimal_snapshot      TEXT,
  posted_by             INTEGER,
  posted_at             TEXT,
  reverses_id           INTEGER REFERENCES journal_entries (id),
  reason                TEXT,
  CHECK ((status = 'posted') = (number IS NOT NULL)),
  CHECK ((status = 'posted') = (fiscal_period_id IS NOT NULL)),
  CHECK ((status = 'posted') = (decimal_snapshot IS NOT NULL)),
  CHECK ((status = 'posted') = (posted_by IS NOT NULL AND posted_at IS NOT NULL)),
  CHECK (status = 'draft' OR total_base <> '0'),
  CHECK ((entry_type = 'reversal') = (reverses_id IS NOT NULL)),
  CHECK ((entry_type = 'reversal') = (reason IS NOT NULL)),
  CHECK (reason IS NULL OR length(trim(reason)) BETWEEN 3 AND 500)
) STRICT;
-- القيد يُعكس مرة واحدة بين القيود المرحّلة (مسودة عكسية متروكة لا تحجز العكس الصحيح)
CREATE UNIQUE INDEX journal_entries_one_reversal ON journal_entries (reverses_id) WHERE status = 'posted';
CREATE INDEX journal_entries_status_date ON journal_entries (status, entry_date);
CREATE INDEX journal_entries_branch_date ON journal_entries (branch_id, entry_date);

CREATE TABLE journal_lines (
  id               INTEGER PRIMARY KEY,
  entry_id         INTEGER NOT NULL REFERENCES journal_entries (id) ON DELETE CASCADE,
  line_no          INTEGER NOT NULL CHECK (line_no >= 1),
  account_id       INTEGER NOT NULL REFERENCES accounts (id),
  currency_id      INTEGER NOT NULL REFERENCES currencies (id),
  rate             TEXT NOT NULL CHECK (((rate GLOB '[1-9]*' OR rate GLOB '0.[0-9]*') AND rate NOT GLOB '*[^0-9.]*' AND rate NOT GLOB '*.*.*' AND rate NOT GLOB '*.' AND rate NOT GLOB '*.*0' AND (instr(rate, '.') = 0 OR length(rate) - instr(rate, '.') <= 12) AND (CASE WHEN instr(rate, '.') = 0 THEN length(rate) ELSE instr(rate, '.') - 1 END) <= 12)),          -- لقطة: '1' للعملة الأساسية
  rate_source      TEXT NOT NULL CHECK (rate_source IN ('base', 'table', 'manual')),
  debit_fc         TEXT NOT NULL DEFAULT '0' CHECK (debit_fc = '0' OR ((debit_fc GLOB '[1-9]*' OR debit_fc GLOB '0.[0-9]*') AND debit_fc NOT GLOB '*[^0-9.]*' AND debit_fc NOT GLOB '*.*.*' AND debit_fc NOT GLOB '*.' AND debit_fc NOT GLOB '*.*0' AND (instr(debit_fc, '.') = 0 OR length(debit_fc) - instr(debit_fc, '.') <= 8) AND (CASE WHEN instr(debit_fc, '.') = 0 THEN length(debit_fc) ELSE instr(debit_fc, '.') - 1 END) <= 20)),    -- المبلغ الأصلي
  credit_fc        TEXT NOT NULL DEFAULT '0' CHECK (credit_fc = '0' OR ((credit_fc GLOB '[1-9]*' OR credit_fc GLOB '0.[0-9]*') AND credit_fc NOT GLOB '*[^0-9.]*' AND credit_fc NOT GLOB '*.*.*' AND credit_fc NOT GLOB '*.' AND credit_fc NOT GLOB '*.*0' AND (instr(credit_fc, '.') = 0 OR length(credit_fc) - instr(credit_fc, '.') <= 8) AND (CASE WHEN instr(credit_fc, '.') = 0 THEN length(credit_fc) ELSE instr(credit_fc, '.') - 1 END) <= 20)),
  debit            TEXT NOT NULL DEFAULT '0' CHECK (debit = '0' OR ((debit GLOB '[1-9]*' OR debit GLOB '0.[0-9]*') AND debit NOT GLOB '*[^0-9.]*' AND debit NOT GLOB '*.*.*' AND debit NOT GLOB '*.' AND debit NOT GLOB '*.*0' AND (instr(debit, '.') = 0 OR length(debit) - instr(debit, '.') <= 8) AND (CASE WHEN instr(debit, '.') = 0 THEN length(debit) ELSE instr(debit, '.') - 1 END) <= 20)),       -- بالعملة الأساسية: '0' في المسودة، يُحسب عند الترحيل
  credit           TEXT NOT NULL DEFAULT '0' CHECK (credit = '0' OR ((credit GLOB '[1-9]*' OR credit GLOB '0.[0-9]*') AND credit NOT GLOB '*[^0-9.]*' AND credit NOT GLOB '*.*.*' AND credit NOT GLOB '*.' AND credit NOT GLOB '*.*0' AND (instr(credit, '.') = 0 OR length(credit) - instr(credit, '.') <= 8) AND (CASE WHEN instr(credit, '.') = 0 THEN length(credit) ELSE instr(credit, '.') - 1 END) <= 20)),
  -- اختيارية أو إلزامية حسب الحالة:
  cost_center_id   INTEGER REFERENCES cost_centers (id),
  description      TEXT CHECK (description IS NULL OR length(description) <= 300),
  reverses_line_id INTEGER REFERENCES journal_lines (id),           -- سطور القيد العكسي فقط
  rate_id          INTEGER REFERENCES exchange_rates (id),          -- table
  table_rate       TEXT CHECK (table_rate IS NULL OR ((table_rate GLOB '[1-9]*' OR table_rate GLOB '0.[0-9]*') AND table_rate NOT GLOB '*[^0-9.]*' AND table_rate NOT GLOB '*.*.*' AND table_rate NOT GLOB '*.' AND table_rate NOT GLOB '*.*0' AND (instr(table_rate, '.') = 0 OR length(table_rate) - instr(table_rate, '.') <= 12) AND (CASE WHEN instr(table_rate, '.') = 0 THEN length(table_rate) ELSE instr(table_rate, '.') - 1 END) <= 12)),   -- manual: سعر الجدول وقتها للمقارنة
  rate_reason      TEXT CHECK (rate_reason IS NULL OR length(trim(rate_reason)) BETWEEN 3 AND 500),
  rate_set_by      INTEGER,
  rate_set_at      TEXT,
  UNIQUE (entry_id, line_no),
  UNIQUE (entry_id, reverses_line_id),
  CHECK ((debit_fc = '0') <> (credit_fc = '0')),                                  -- طرف واحد بالضبط
  CHECK ((debit = '0' AND credit = '0') OR ((debit = '0') = (debit_fc = '0') AND (credit = '0') = (credit_fc = '0'))),
  CHECK (rate_source <> 'base' OR (rate = '1' AND rate_id IS NULL AND table_rate IS NULL)),   -- والعكس (base ⇔ عملة الشركة) بـ trigger
  CHECK ((rate_source = 'table') = (rate_id IS NOT NULL)),
  CHECK ((rate_source = 'manual') = (rate_reason IS NOT NULL AND rate_set_by IS NOT NULL AND rate_set_at IS NOT NULL))
) STRICT;
CREATE INDEX journal_lines_account ON journal_lines (account_id);
CREATE INDEX journal_lines_cost_center ON journal_lines (cost_center_id);
CREATE INDEX journal_lines_reverses ON journal_lines (reverses_line_id);

-- الأستاذ العام: إضافة فقط؛ التقارير تقرأ منه وحده
CREATE TABLE gl_entries (
  id               INTEGER PRIMARY KEY,
  source_type      TEXT NOT NULL CHECK (length(source_type) BETWEEN 1 AND 40),
  source_id        INTEGER NOT NULL,
  doc_number       TEXT NOT NULL,
  entry_kind       TEXT NOT NULL CHECK (entry_kind IN ('normal', 'opening', 'closing')),
  posting_date     TEXT NOT NULL CHECK (date(posting_date) IS posting_date),
  fiscal_period_id INTEGER NOT NULL REFERENCES fiscal_periods (id),
  fiscal_year_id   INTEGER NOT NULL REFERENCES fiscal_years (id),
  branch_id        INTEGER NOT NULL REFERENCES branches (id),
  account_id       INTEGER NOT NULL REFERENCES accounts (id),
  currency_id      INTEGER NOT NULL REFERENCES currencies (id),
  rate             TEXT NOT NULL CHECK (((rate GLOB '[1-9]*' OR rate GLOB '0.[0-9]*') AND rate NOT GLOB '*[^0-9.]*' AND rate NOT GLOB '*.*.*' AND rate NOT GLOB '*.' AND rate NOT GLOB '*.*0' AND (instr(rate, '.') = 0 OR length(rate) - instr(rate, '.') <= 12) AND (CASE WHEN instr(rate, '.') = 0 THEN length(rate) ELSE instr(rate, '.') - 1 END) <= 12)),
  rate_source      TEXT NOT NULL CHECK (rate_source IN ('base', 'table', 'manual')),
  debit_fc         TEXT NOT NULL CHECK (debit_fc = '0' OR ((debit_fc GLOB '[1-9]*' OR debit_fc GLOB '0.[0-9]*') AND debit_fc NOT GLOB '*[^0-9.]*' AND debit_fc NOT GLOB '*.*.*' AND debit_fc NOT GLOB '*.' AND debit_fc NOT GLOB '*.*0' AND (instr(debit_fc, '.') = 0 OR length(debit_fc) - instr(debit_fc, '.') <= 8) AND (CASE WHEN instr(debit_fc, '.') = 0 THEN length(debit_fc) ELSE instr(debit_fc, '.') - 1 END) <= 20)),
  credit_fc        TEXT NOT NULL CHECK (credit_fc = '0' OR ((credit_fc GLOB '[1-9]*' OR credit_fc GLOB '0.[0-9]*') AND credit_fc NOT GLOB '*[^0-9.]*' AND credit_fc NOT GLOB '*.*.*' AND credit_fc NOT GLOB '*.' AND credit_fc NOT GLOB '*.*0' AND (instr(credit_fc, '.') = 0 OR length(credit_fc) - instr(credit_fc, '.') <= 8) AND (CASE WHEN instr(credit_fc, '.') = 0 THEN length(credit_fc) ELSE instr(credit_fc, '.') - 1 END) <= 20)),
  debit            TEXT NOT NULL CHECK (debit = '0' OR ((debit GLOB '[1-9]*' OR debit GLOB '0.[0-9]*') AND debit NOT GLOB '*[^0-9.]*' AND debit NOT GLOB '*.*.*' AND debit NOT GLOB '*.' AND debit NOT GLOB '*.*0' AND (instr(debit, '.') = 0 OR length(debit) - instr(debit, '.') <= 8) AND (CASE WHEN instr(debit, '.') = 0 THEN length(debit) ELSE instr(debit, '.') - 1 END) <= 20)),
  credit           TEXT NOT NULL CHECK (credit = '0' OR ((credit GLOB '[1-9]*' OR credit GLOB '0.[0-9]*') AND credit NOT GLOB '*[^0-9.]*' AND credit NOT GLOB '*.*.*' AND credit NOT GLOB '*.' AND credit NOT GLOB '*.*0' AND (instr(credit, '.') = 0 OR length(credit) - instr(credit, '.') <= 8) AND (CASE WHEN instr(credit, '.') = 0 THEN length(credit) ELSE instr(credit, '.') - 1 END) <= 20)),
  posted_by        INTEGER NOT NULL,
  posted_at        TEXT NOT NULL,
  source_line_id   INTEGER,                         -- مستندات قادمة قد تجمع أكثر من سطر
  cost_center_id   INTEGER REFERENCES cost_centers (id),
  description      TEXT,
  CHECK ((debit_fc = '0') <> (credit_fc = '0')),
  CHECK ((debit = '0') <> (credit = '0')),
  CHECK ((debit = '0') = (debit_fc = '0'))
) STRICT;
CREATE UNIQUE INDEX gl_entries_source_line ON gl_entries (source_type, source_id, source_line_id);
CREATE INDEX gl_entries_account_date ON gl_entries (account_id, posting_date);
CREATE INDEX gl_entries_branch_date ON gl_entries (branch_id, posting_date);
CREATE INDEX gl_entries_cost_center_date ON gl_entries (cost_center_id, posting_date);
CREATE INDEX gl_entries_year_kind ON gl_entries (fiscal_year_id, entry_kind);

-- ── journal_entries ──
CREATE TRIGGER journal_entries_born_draft BEFORE INSERT ON journal_entries WHEN NEW.status <> 'draft'
BEGIN SELECT RAISE(ABORT, 'journal entries are created as drafts and posted by the ledger'); END;
CREATE TRIGGER journal_entries_closing_reserved BEFORE INSERT ON journal_entries WHEN NEW.entry_type = 'closing'
BEGIN SELECT RAISE(ABORT, 'closing entries are not available before phase 4'); END;
CREATE TRIGGER journal_entries_posted_frozen BEFORE UPDATE ON journal_entries WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted journal entries cannot be modified; post a reversal'); END;
CREATE TRIGGER journal_entries_posted_no_delete BEFORE DELETE ON journal_entries WHEN OLD.status = 'posted'
BEGIN SELECT RAISE(ABORT, 'posted journal entries cannot be deleted; post a reversal'); END;
CREATE TRIGGER journal_entries_type_fixed BEFORE UPDATE OF entry_type, reverses_id ON journal_entries
WHEN NEW.entry_type IS NOT OLD.entry_type OR NEW.reverses_id IS NOT OLD.reverses_id
BEGIN SELECT RAISE(ABORT, 'entry type and reversal link are fixed'); END;
CREATE TRIGGER journal_entries_reversal_target BEFORE INSERT ON journal_entries WHEN NEW.reverses_id IS NOT NULL
BEGIN
  SELECT RAISE(ABORT, 'only a posted, non-reversal entry can be reversed') WHERE NOT EXISTS
    (SELECT 1 FROM journal_entries o WHERE o.id = NEW.reverses_id AND o.status = 'posted' AND o.entry_type <> 'reversal');
END;

-- الترحيل: draft → posted مرة واحدة، بعد التحقق المستقل من كل القواعد
CREATE TRIGGER journal_entries_post_checks BEFORE UPDATE OF status ON journal_entries
WHEN OLD.status = 'draft' AND NEW.status = 'posted'
BEGIN
  SELECT RAISE(ABORT, 'a journal entry needs at least two lines')
    WHERE (SELECT count(*) FROM journal_lines WHERE entry_id = NEW.id) < 2;
  -- العكسي: تقابل تام واحد لواحد مع سطور الأصل (C3 + C4؛ C1 وC2 عند إضافة السطر)
  SELECT RAISE(ABORT, 'reversal must mirror every line of the original exactly once')
    WHERE NEW.entry_type = 'reversal' AND (
      (SELECT count(*) FROM journal_lines WHERE entry_id = NEW.id) <> (SELECT count(*) FROM journal_lines WHERE entry_id = NEW.reverses_id)
      OR EXISTS (SELECT 1 FROM journal_lines o WHERE o.entry_id = NEW.reverses_id
                   AND NOT EXISTS (SELECT 1 FROM journal_lines r WHERE r.entry_id = NEW.id AND r.reverses_line_id = o.id)));
  SELECT RAISE(ABORT, 'posting period must be open and contain the entry date') WHERE NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.status = 'open' AND NEW.entry_date BETWEEN p.start_date AND p.end_date);
  SELECT RAISE(ABORT, 'every line needs a non-zero base amount on its side') WHERE EXISTS
    (SELECT 1 FROM journal_lines l WHERE l.entry_id = NEW.id AND ((l.debit_fc <> '0') <> (l.debit <> '0') OR (l.credit_fc <> '0') <> (l.credit <> '0')));
  SELECT RAISE(ABORT, 'journal entry is not balanced in base currency')
    WHERE dec_cmp((SELECT dec_sum(debit) FROM journal_lines WHERE entry_id = NEW.id), (SELECT dec_sum(credit) FROM journal_lines WHERE entry_id = NEW.id)) <> 0
       OR dec_cmp(NEW.total_base, (SELECT dec_sum(debit) FROM journal_lines WHERE entry_id = NEW.id)) <> 0;
  SELECT RAISE(ABORT, 'group accounts cannot be posted to') WHERE EXISTS
    (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = NEW.id AND a.is_group = 1);
  -- غير العكسي: الحساب نشط ويقبل القيد اليدوي، وسياسة مركز التكلفة، والمركز نشط وتفصيلي
  SELECT RAISE(ABORT, 'account is inactive or does not accept manual entries') WHERE NEW.entry_type <> 'reversal' AND EXISTS
    (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = NEW.id AND (a.is_active = 0 OR a.allow_manual_entry = 0));
  SELECT RAISE(ABORT, 'cost center does not follow the account policy') WHERE NEW.entry_type <> 'reversal' AND EXISTS
    (SELECT 1 FROM journal_lines l JOIN accounts a ON a.id = l.account_id WHERE l.entry_id = NEW.id
       AND ((a.cost_center_policy = 'required' AND l.cost_center_id IS NULL) OR (a.cost_center_policy = 'none' AND l.cost_center_id IS NOT NULL)));
  SELECT RAISE(ABORT, 'cost center is inactive or a group') WHERE NEW.entry_type <> 'reversal' AND EXISTS
    (SELECT 1 FROM journal_lines l JOIN cost_centers c ON c.id = l.cost_center_id WHERE l.entry_id = NEW.id AND (c.is_active = 0 OR c.is_group = 1));
  -- الافتتاحي: أول يوم من أول سنة مالية فقط
  SELECT RAISE(ABORT, 'opening entries are dated on the first day of the first fiscal year')
    WHERE NEW.entry_type = 'opening' AND NEW.entry_date IS NOT (SELECT min(start_date) FROM fiscal_years);
END;

-- ── journal_lines ──
CREATE TRIGGER journal_lines_frozen_insert BEFORE INSERT ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = NEW.entry_id) IS NOT 'draft'
BEGIN SELECT RAISE(ABORT, 'lines of a posted journal entry cannot be changed'); END;
CREATE TRIGGER journal_lines_frozen_update BEFORE UPDATE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted' OR NEW.entry_id IS NOT OLD.entry_id
BEGIN SELECT RAISE(ABORT, 'lines of a posted journal entry cannot be changed'); END;
CREATE TRIGGER journal_lines_frozen_delete BEFORE DELETE ON journal_lines
WHEN (SELECT status FROM journal_entries WHERE id = OLD.entry_id) = 'posted'
BEGIN SELECT RAISE(ABORT, 'lines of a posted journal entry cannot be changed'); END;
CREATE TRIGGER journal_lines_rate_rules_insert BEFORE INSERT ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'rate source base is for base-currency lines only')
    WHERE (NEW.rate_source = 'base') <> (NEW.currency_id IS (SELECT c.id FROM currencies c JOIN company co ON co.id = 1 AND c.code = co.base_currency));
  SELECT RAISE(ABORT, 'table rate must reference a rate row of the same currency and value')
    WHERE NEW.rate_source = 'table' AND NOT EXISTS
      (SELECT 1 FROM exchange_rates x WHERE x.id = NEW.rate_id AND x.currency_id = NEW.currency_id AND x.rate IS NEW.rate);
END;
CREATE TRIGGER journal_lines_reversal_mirror_insert BEFORE INSERT ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'only reversal lines reference an original line')
    WHERE NEW.reverses_line_id IS NOT NULL AND (SELECT entry_type FROM journal_entries WHERE id = NEW.entry_id) IS NOT 'reversal';
  SELECT RAISE(ABORT, 'reversal line must mirror a line of the reversed entry')
    WHERE (SELECT entry_type FROM journal_entries WHERE id = NEW.entry_id) = 'reversal' AND NOT EXISTS
      (SELECT 1 FROM journal_lines o JOIN journal_entries e ON e.id = NEW.entry_id
        WHERE o.id = NEW.reverses_line_id AND o.entry_id = e.reverses_id
          AND o.account_id = NEW.account_id AND o.cost_center_id IS NEW.cost_center_id AND o.currency_id = NEW.currency_id
          AND o.rate = NEW.rate AND o.rate_source = NEW.rate_source AND o.rate_id IS NEW.rate_id
          AND o.debit_fc = NEW.credit_fc AND o.credit_fc = NEW.debit_fc AND o.debit = NEW.credit AND o.credit = NEW.debit);
END;
CREATE TRIGGER journal_lines_rate_rules_update BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'rate source base is for base-currency lines only')
    WHERE (NEW.rate_source = 'base') <> (NEW.currency_id IS (SELECT c.id FROM currencies c JOIN company co ON co.id = 1 AND c.code = co.base_currency));
  SELECT RAISE(ABORT, 'table rate must reference a rate row of the same currency and value')
    WHERE NEW.rate_source = 'table' AND NOT EXISTS
      (SELECT 1 FROM exchange_rates x WHERE x.id = NEW.rate_id AND x.currency_id = NEW.currency_id AND x.rate IS NEW.rate);
END;
CREATE TRIGGER journal_lines_reversal_mirror_update BEFORE UPDATE ON journal_lines
BEGIN
  SELECT RAISE(ABORT, 'only reversal lines reference an original line')
    WHERE NEW.reverses_line_id IS NOT NULL AND (SELECT entry_type FROM journal_entries WHERE id = NEW.entry_id) IS NOT 'reversal';
  SELECT RAISE(ABORT, 'reversal line must mirror a line of the reversed entry')
    WHERE (SELECT entry_type FROM journal_entries WHERE id = NEW.entry_id) = 'reversal' AND NOT EXISTS
      (SELECT 1 FROM journal_lines o JOIN journal_entries e ON e.id = NEW.entry_id
        WHERE o.id = NEW.reverses_line_id AND o.entry_id = e.reverses_id
          AND o.account_id = NEW.account_id AND o.cost_center_id IS NEW.cost_center_id AND o.currency_id = NEW.currency_id
          AND o.rate = NEW.rate AND o.rate_source = NEW.rate_source AND o.rate_id IS NEW.rate_id
          AND o.debit_fc = NEW.credit_fc AND o.credit_fc = NEW.debit_fc AND o.debit = NEW.credit AND o.credit = NEW.debit);
END;

-- ── gl_entries ──
CREATE TRIGGER gl_entries_no_update BEFORE UPDATE ON gl_entries
BEGIN SELECT RAISE(ABORT, 'the general ledger is append-only'); END;
CREATE TRIGGER gl_entries_no_delete BEFORE DELETE ON gl_entries
BEGIN SELECT RAISE(ABORT, 'the general ledger is append-only'); END;
CREATE TRIGGER gl_entries_insert_rules BEFORE INSERT ON gl_entries
BEGIN
  SELECT RAISE(ABORT, 'closing entries are not available before phase 4') WHERE NEW.entry_kind = 'closing';
  SELECT RAISE(ABORT, 'unknown ledger source') WHERE NEW.source_type <> 'journal';
  SELECT RAISE(ABORT, 'group accounts cannot be posted to') WHERE (SELECT is_group FROM accounts WHERE id = NEW.account_id) IS NOT 0;
  SELECT RAISE(ABORT, 'posting period must be open and contain the posting date') WHERE NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.fiscal_year_id = NEW.fiscal_year_id
       AND p.status = 'open' AND NEW.posting_date BETWEEN p.start_date AND p.end_date);
  -- القيد اليومي: سطر الأستاذ نسخة حرفية من سطر قيد مرحّل
  SELECT RAISE(ABORT, 'ledger line must match a line of the posted journal entry') WHERE NEW.source_type = 'journal' AND NOT EXISTS
    (SELECT 1 FROM journal_entries e JOIN journal_lines l ON l.entry_id = e.id
      WHERE e.id = NEW.source_id AND e.status = 'posted' AND e.number = NEW.doc_number AND e.branch_id = NEW.branch_id
        AND e.entry_date = NEW.posting_date AND e.fiscal_period_id = NEW.fiscal_period_id
        AND (CASE e.entry_type WHEN 'opening' THEN 'opening' ELSE 'normal' END) = NEW.entry_kind
        AND l.id = NEW.source_line_id AND l.account_id = NEW.account_id AND l.cost_center_id IS NEW.cost_center_id
        AND l.currency_id = NEW.currency_id AND l.rate = NEW.rate AND l.rate_source = NEW.rate_source
        AND l.debit_fc = NEW.debit_fc AND l.credit_fc = NEW.credit_fc AND l.debit = NEW.debit AND l.credit = NEW.credit);
END;

-- العملة الأساسية لا تتغير بعد أول سعر صرف (قرار المرحلة 2 رقم 1) أو أول ترحيل — دفاع في القاعدة خلف فحص الخادم
CREATE TRIGGER company_base_currency_frozen BEFORE UPDATE OF base_currency ON company
WHEN NEW.base_currency IS NOT OLD.base_currency AND (EXISTS (SELECT 1 FROM gl_entries) OR EXISTS (SELECT 1 FROM exchange_rates))
BEGIN SELECT RAISE(ABORT, 'base currency is locked by recorded exchange rates or posted entries'); END;

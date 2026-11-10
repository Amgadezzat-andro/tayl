-- TAYL Phase 3 — القيد الافتتاحي والقيد العكسي وضابط P6 (الترحيل 0001 لم يُعدَّل).
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

-- قيد افتتاحي فعّال واحد لكل فرع: لا يُرحَّل افتتاحي ثانٍ لنفس الفرع ما دام الأول مرحّلًا وغير معكوس
-- (التصحيح: عكس الأول ثم ترحيل الصحيح). الأرصدة التفصيلية المستقبلية لا تمر من هنا (حسابات المراقبة allow_manual_entry = 0).
CREATE TRIGGER journal_entries_one_opening_per_branch BEFORE UPDATE OF status ON journal_entries
WHEN OLD.status = 'draft' AND NEW.status = 'posted' AND NEW.entry_type = 'opening'
BEGIN
  SELECT RAISE(ABORT, 'an effective opening entry already exists for this branch') WHERE EXISTS
    (SELECT 1 FROM journal_entries o WHERE o.entry_type = 'opening' AND o.status = 'posted' AND o.branch_id = NEW.branch_id AND o.id <> NEW.id
       AND NOT EXISTS (SELECT 1 FROM journal_entries r WHERE r.reverses_id = o.id AND r.status = 'posted'));
END;

-- P6: بعد أول ترحيل لا تُنشأ سنة قبل أول سنة مالية (تحمي قاعدة «الافتتاحي في أول سنة»)
CREATE TRIGGER fiscal_years_none_before_first_after_posting BEFORE INSERT ON fiscal_years
WHEN EXISTS (SELECT 1 FROM gl_entries) AND NEW.start_date < (SELECT min(start_date) FROM fiscal_years)
BEGIN SELECT RAISE(ABORT, 'no fiscal year can be added before the first one after posting'); END;

-- الأستاذ: عكس القيد الافتتاحي حركة «افتتاحية» أيضًا (يلغي الأرصدة الافتتاحية)؛ ما عدا ذلك القاعدة كما في 0001
DROP TRIGGER gl_entries_insert_rules;
CREATE TRIGGER gl_entries_insert_rules BEFORE INSERT ON gl_entries
BEGIN
  SELECT RAISE(ABORT, 'closing entries are not available before phase 4') WHERE NEW.entry_kind = 'closing';
  SELECT RAISE(ABORT, 'unknown ledger source') WHERE NEW.source_type <> 'journal';
  SELECT RAISE(ABORT, 'group accounts cannot be posted to') WHERE (SELECT is_group FROM accounts WHERE id = NEW.account_id) IS NOT 0;
  SELECT RAISE(ABORT, 'posting period must be open and contain the posting date') WHERE NOT EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.id = NEW.fiscal_period_id AND p.fiscal_year_id = NEW.fiscal_year_id
       AND p.status = 'open' AND NEW.posting_date BETWEEN p.start_date AND p.end_date);
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
END;

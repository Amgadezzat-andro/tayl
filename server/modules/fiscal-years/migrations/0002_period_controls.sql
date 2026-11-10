-- TAYL Phase 3 — ضوابط الفترات والسنوات (المقترح، القسم 7؛ P2 وP5 والقفل من «مغلقة» فقط) — دفاع في القاعدة خلف الخادم.
-- الثابت المحفوظ دائمًا: «كل فترة مقفلة نهائيًا، كل ما قبلها مقفل» — يُفحص داخل جملة التحديث نفسها، فلا يكسره
-- التزامن ولا التحديث الجماعي ولا SQL مباشر. لا تُعدَّل بعد التطبيق.

-- P2 + القفل من «مغلقة» فقط
CREATE TRIGGER fiscal_periods_lock_rules BEFORE UPDATE OF status ON fiscal_periods
WHEN NEW.status = 'locked' AND OLD.status IS NOT 'locked'
BEGIN
  SELECT RAISE(ABORT, 'a period is locked only from closed') WHERE OLD.status <> 'closed';
  SELECT RAISE(ABORT, 'earlier periods must be locked first') WHERE EXISTS
    (SELECT 1 FROM fiscal_periods p WHERE p.start_date < OLD.start_date AND p.status <> 'locked');
END;

-- P5: السنوات متصلة بلا فجوات — السنة الجديدة تلي آخر سنة مباشرة أو تسبق أول سنة مباشرة
CREATE TRIGGER fiscal_years_contiguous BEFORE INSERT ON fiscal_years
WHEN EXISTS (SELECT 1 FROM fiscal_years)
  AND NEW.start_date IS NOT date((SELECT max(end_date) FROM fiscal_years), '+1 day')
  AND NEW.end_date IS NOT date((SELECT min(start_date) FROM fiscal_years), '-1 day')
BEGIN SELECT RAISE(ABORT, 'fiscal years must be contiguous'); END;
-- حذف سنة في الوسط يترك فجوة
CREATE TRIGGER fiscal_years_delete_edge_only BEFORE DELETE ON fiscal_years
WHEN EXISTS (SELECT 1 FROM fiscal_years WHERE start_date < OLD.start_date) AND EXISTS (SELECT 1 FROM fiscal_years WHERE start_date > OLD.start_date)
BEGIN SELECT RAISE(ABORT, 'only the first or the last fiscal year can be deleted'); END;

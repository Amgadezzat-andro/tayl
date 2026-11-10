-- TAYL Phase 3 — مراجعة: لا تُضاف سنة قبل أول سنة إن وُجدت فترة مغلقة أو مقفلة (تحمي ثابت P2:
-- «كل فترة مقفلة، كل ما قبلها مقفل» من سنة جديدة بفترات مفتوحة تسبقها). لا تُعدَّل بعد التطبيق.
CREATE TRIGGER fiscal_years_none_before_closed BEFORE INSERT ON fiscal_years
WHEN NEW.start_date < (SELECT min(start_date) FROM fiscal_years) AND EXISTS (SELECT 1 FROM fiscal_periods WHERE status <> 'open')
BEGIN SELECT RAISE(ABORT, 'no fiscal year can be added before the first one once a period is closed or locked'); END;

-- TAYL Phase 3 (3.1) — سياسة الترحيل لكل حساب (القراران 6 و7 للمرحلة 3).
--  cost_center_policy: none (ممنوع) | optional (اختياري — القيمة لكل الحسابات الحالية) | required (إلزامي)
--  allow_manual_entry: 0 = حساب مراقبة لا يقبل قيدًا يدويًا ولا افتتاحيًا (العكسي الصحيح لقيد سابق مسموح)
-- تغييرهما بعد الاستخدام مسموح ويسري على القيود الجديدة فقط. لا تُعدَّل بعد التطبيق.
ALTER TABLE accounts ADD COLUMN cost_center_policy TEXT NOT NULL DEFAULT 'optional'
  CHECK (cost_center_policy IN ('none', 'optional', 'required'));
ALTER TABLE accounts ADD COLUMN allow_manual_entry INTEGER NOT NULL DEFAULT 1 CHECK (allow_manual_entry IN (0, 1));

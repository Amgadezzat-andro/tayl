'use strict';

/**
 * سجل «النشاط المالي المعتمد». كل وحدة مالية قادمة (القيود، الفواتير، الأرصدة الافتتاحية، الحركات المخزنية...)
 * تسجّل هنا دالة تجيب: هل لديها بيانات معتمدة أو مرحّلة تعتمد على العملة الأساسية؟
 *
 *   services.financialActivity.register('journal', (db) =>
 *     !!db.prepare("SELECT 1 FROM journal_entries WHERE status IN ('approved','posted') LIMIT 1").get());
 *
 * إن أجابت أي وحدة بنعم تُقفل العملة الأساسية (ولا يكفي غياب القيود إذا وُجدت بيانات مالية أخرى معتمدة).
 * الفحص يُستدعى داخل معاملة تعديل الشركة نفسها، فلا يمكن أن تتسلل حركة بين الفحص والتعديل.
 * المسودات غير المعتمدة لا تُقفل العملة (مسؤولية كل وحدة أن تفحص المعتمد/المرحّل فقط).
 */
function createFinancialActivity({ db }) {
  const checks = new Map();
  return {
    register(name, fn) {
      if (!/^[a-z][a-z0-9_-]{1,40}$/.test(name) || typeof fn !== 'function') throw new Error('تسجيل نشاط مالي غير صالح');
      if (checks.has(name)) throw new Error(`نشاط مالي مكرر: ${name}`);
      checks.set(name, fn);
    },
    /** أسماء الوحدات التي لديها بيانات مالية معتمدة. فارغة = لا نشاط بعد. */
    sources: () => [...checks].filter(([, fn]) => fn(db)).map(([name]) => name),
  };
}

module.exports = { createFinancialActivity };

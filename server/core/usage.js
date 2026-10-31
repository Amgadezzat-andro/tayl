'use strict';

/**
 * سجل الارتباطات: كل وحدة تعلن أنها تستخدم كيانًا من وحدة أخرى، فلا يُحذف (ولا يُغيَّر كوده) ما هو مستخدم.
 *   services.usage.register('account', 'treasury', (db, id) => !!db.prepare('SELECT 1 FROM treasuries WHERE account_id = ? LIMIT 1').get(id));
 * الوحدات القادمة (القيود، الفواتير...) تسجّل هنا أيضًا، فيصبح الحساب أو المركز «مستخدمًا» بمجرد ارتباطه بحركة.
 */
function createUsageRegistry(db) {
  const checks = new Map();   // entity -> Map(name -> fn)
  return {
    register(entity, name, fn) {
      if (typeof fn !== 'function') throw new Error('usage.register يتطلب دالة');
      if (!checks.has(entity)) checks.set(entity, new Map());
      if (checks.get(entity).has(name)) throw new Error(`ارتباط مكرر: ${entity}/${name}`);
      checks.get(entity).set(name, fn);
    },
    /** أسماء الوحدات التي تستخدم الكيان. فارغة = غير مستخدم. */
    usedBy(entity, id) {
      const m = checks.get(entity);
      return m ? [...m].filter(([, fn]) => fn(db, id)).map(([n]) => n) : [];
    },
  };
}

module.exports = { createUsageRegistry };

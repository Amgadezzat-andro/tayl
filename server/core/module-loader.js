'use strict';

/**
 * عقد الوحدة (Module Contract):
 *   {
 *     name: 'sales',                    // فريد
 *     version: '1.0.0',
 *     dependsOn: ['system', 'inventory'],
 *     migrationsDir: '<path>',          // اختياري — ترحيلات الوحدة نفسها
 *     register(router, services) {}     // يسجّل مساراتها فقط
 *   }
 * إضافة وحدة جديدة = مجلد جديد + سطر تسجيل واحد. لا يُعدَّل أي كود وحدة أخرى.
 */
function resolveOrder(modules) {
  const byName = new Map();
  for (const m of modules) {
    if (!m || !m.name) throw new Error('وحدة بلا اسم');
    if (byName.has(m.name)) throw new Error(`اسم وحدة مكرر: ${m.name}`);
    byName.set(m.name, m);
  }
  const ordered = []; const state = new Map();
  const visit = (name, chain) => {
    const m = byName.get(name);
    if (!m) throw new Error(`وحدة مطلوبة غير موجودة: ${name} (مطلوبة من ${chain[chain.length - 1]})`);
    if (state.get(name) === 'done') return;
    if (state.get(name) === 'visiting') throw new Error(`اعتماد دائري بين الوحدات: ${[...chain, name].join(' -> ')}`);
    state.set(name, 'visiting');
    for (const d of m.dependsOn || []) visit(d, [...chain, name]);
    state.set(name, 'done');
    ordered.push(m);
  };
  for (const m of modules) visit(m.name, []);
  return ordered;
}
module.exports = { resolveOrder };

'use strict';

/**
 * كتالوج الصلاحيات المركزي. كل وحدة تعلن مواردها والإجراءات المتاحة عليها، فيصبح المفتاح "resource.action".
 * الإجراءات القياسية موحدة لكل البرنامج (الواجهة تعرضها كمصفوفة):
 *   view عرض، create إضافة، update تعديل، delete حذف، disable تفعيل/تعطيل،
 *   approve اعتماد، post ترحيل، print طباعة، export تصدير.
 * أي صلاحية غير موجودة في الكتالوج تُرفض عند حفظ الأدوار.
 */
const ACTIONS = Object.freeze(['view', 'create', 'update', 'delete', 'disable', 'approve', 'post', 'print', 'export']);
const RESOURCE_RE = /^[a-z][a-z_]{1,40}$/;

function createPermissionCatalog() {
  const resources = new Map();

  function register(moduleName, defs) {
    for (const d of defs) {
      if (!RESOURCE_RE.test(d.resource)) throw new Error(`اسم مورد غير صالح: ${d.resource}`);
      if (resources.has(d.resource)) throw new Error(`مورد صلاحيات مكرر: ${d.resource}`);
      if (!d.actions.length || !d.actions.every((a) => ACTIONS.includes(a))) throw new Error(`إجراءات غير صالحة للمورد ${d.resource}`);
      resources.set(d.resource, Object.freeze({ resource: d.resource, module: moduleName, group: d.group || moduleName, actions: Object.freeze([...d.actions]) }));
    }
  }
  const keys = () => [...resources.values()].flatMap((r) => r.actions.map((a) => `${r.resource}.${a}`));
  function has(key) {
    const [res, act, extra] = String(key).split('.');
    const r = resources.get(res);
    return !extra && !!r && r.actions.includes(act);
  }
  return { ACTIONS, register, has, keys, list: () => [...resources.values()] };
}

module.exports = { createPermissionCatalog, ACTIONS };

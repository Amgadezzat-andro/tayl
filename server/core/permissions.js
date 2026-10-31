'use strict';

/**
 * كتالوج الصلاحيات المركزي. كل وحدة تعلن مواردها والإجراءات المتاحة عليها، فيصبح المفتاح "resource.action".
 * الإجراءات القياسية موحدة لكل البرنامج (الواجهة تعرضها كمصفوفة):
 *   view عرض، create إضافة، update تعديل، delete حذف، disable تفعيل/تعطيل،
 *   approve اعتماد، post ترحيل، print طباعة، export تصدير، import استيراد [م2].
 * أي صلاحية غير موجودة في الكتالوج تُرفض عند حفظ الأدوار.
 *
 * special: صلاحيات خاصة خارج المصفوفة القياسية (مثل users.manage_all).
 * superOnlyGrant: صلاحيات لا يمنحها إلا المدير العام (حتى لو كان المانح يملكها).
 */
const ACTIONS = Object.freeze(['view', 'create', 'update', 'delete', 'disable', 'approve', 'post', 'print', 'export', 'import']);
const RESOURCE_RE = /^[a-z][a-z_]{1,40}$/;

function createPermissionCatalog() {
  const resources = new Map();

  function register(moduleName, defs) {
    for (const d of defs) {
      if (!RESOURCE_RE.test(d.resource)) throw new Error(`اسم مورد غير صالح: ${d.resource}`);
      if (resources.has(d.resource)) throw new Error(`مورد صلاحيات مكرر: ${d.resource}`);
      if (!d.actions.length || !d.actions.every((a) => ACTIONS.includes(a))) throw new Error(`إجراءات غير صالحة للمورد ${d.resource}`);
      const special = d.special || [];
      if (!special.every((a) => /^[a-z][a-z_]{1,40}$/.test(a) && !ACTIONS.includes(a))) throw new Error(`صلاحيات خاصة غير صالحة للمورد ${d.resource}`);
      const superOnly = d.superOnlyGrant || [];
      if (!superOnly.every((a) => d.actions.includes(a) || special.includes(a))) throw new Error(`superOnlyGrant يشير لإجراء غير معلن في ${d.resource}`);
      resources.set(d.resource, Object.freeze({
        resource: d.resource, module: moduleName, group: d.group || moduleName,
        actions: Object.freeze([...d.actions]), special: Object.freeze([...special]), superOnlyGrant: Object.freeze([...superOnly]),
      }));
    }
  }
  const keys = () => [...resources.values()].flatMap((r) => [...r.actions, ...r.special].map((a) => `${r.resource}.${a}`));
  const split = (key) => { const [res, act, extra] = String(key).split('.'); return extra === undefined ? [resources.get(res), act] : [null, null]; };
  function has(key) {
    const [r, act] = split(key);
    return !!r && (r.actions.includes(act) || r.special.includes(act));
  }
  /** صلاحية لا يمنحها إلا المدير العام. */
  function superOnly(key) {
    const [r, act] = split(key);
    return !!r && r.superOnlyGrant.includes(act);
  }
  return { ACTIONS, register, has, superOnly, keys, list: () => [...resources.values()] };
}

module.exports = { createPermissionCatalog, ACTIONS };

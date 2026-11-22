'use strict';
const { HttpError } = require('../../core/errors');

/**
 * نطاق المخازن: فوق نطاق الفروع القائم (ctx.access). المستخدم الذي له صفوف في inv_user_warehouses مقيد بهذه المخازن
 * (وكلها داخل فروعه)، ومن لا صفوف له يرى كل مخازن فروعه. كل استعلام وتقرير وكتابة يمر من هنا.
 * المخزن خارج النطاق = 404 (لا نكشف وجوده).
 */
function createWarehouseAccess(db) {
  const restrictedQ = db.prepare('SELECT warehouse_id id FROM inv_user_warehouses WHERE user_id = ?');
  const whQ = db.prepare('SELECT * FROM inv_warehouses WHERE id = ?');

  function restricted(ctx) {
    if (ctx.user.isSuperAdmin) return null;
    if (!ctx._invWh) {
      const ids = restrictedQ.all(ctx.user.id).map((r) => r.id);
      ctx._invWh = { set: ids.length ? new Set(ids) : null };
    }
    return ctx._invWh.set;
  }
  function allowed(ctx, wh) {
    if (!wh || !ctx.access.branchAllowed(wh.branch_id)) return false;
    const r = restricted(ctx);
    return !r || r.has(wh.id);
  }
  /** المخزن المرئي (وإلا 404)؛ active: للحركات الجديدة. */
  function assertWarehouse(ctx, id, { active = false, field = 'warehouseId' } = {}) {
    const wh = Number.isSafeInteger(id) ? whQ.get(id) : null;
    if (!wh || !allowed(ctx, wh)) throw new HttpError(404, 'NOT_FOUND', 'المخزن غير موجود', { field });
    if (active && wh.is_active !== 1) throw new HttpError(409, 'WAREHOUSE_INACTIVE', 'المخزن موقوف؛ لا حركات عليه', { warehouse: wh.code });
    if (active) {
      const br = db.prepare('SELECT is_active FROM branches WHERE id = ?').get(wh.branch_id);
      if (!br || br.is_active !== 1) throw new HttpError(409, 'BRANCH_INACTIVE', 'الفرع معطّل');
    }
    return wh;
  }
  /** معرّفات المخازن المرئية (null = كل المخازن: مدير عام أو جميع الفروع بلا قيود مخازن). */
  function visibleIds(ctx) {
    const r = restricted(ctx);
    if (!r && ctx.access.allBranches) return null;
    return db.prepare('SELECT id, branch_id FROM inv_warehouses').all().filter((w) => allowed(ctx, w)).map((w) => w.id);
  }
  /** شرط SQL على عمود مخزن (اسم عمود آمن ثابت من الكود). */
  function sqlFilter(ctx, col) {
    if (!/^[a-z_][a-z0-9_]*(\.[a-z_][a-z0-9_]*)?$/i.test(col)) throw new Error('اسم عمود غير آمن');
    const ids = visibleIds(ctx);
    if (ids === null) return { sql: '1 = 1', params: [] };
    if (!ids.length) return { sql: '0 = 1', params: [] };
    return { sql: `${col} IN (${ids.map(() => '?').join(', ')})`, params: ids };
  }
  return { allowed, assertWarehouse, visibleIds, sqlFilter, restricted };
}

module.exports = { createWarehouseAccess };

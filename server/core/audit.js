'use strict';

/**
 * سجل التدقيق (Audit Trail) — إضافة فقط (append-only) ويُفرض ذلك داخل قاعدة البيانات نفسها.
 * يُستدعى داخل نفس المعاملة المالية فيُلغى معها إن فشلت.
 */
function createAudit(db) {
  const ins = db.prepare(`INSERT INTO audit_log
    (actor_user_id, actor, action, entity_type, entity_id, source, details, request_id)
    VALUES (@actor_user_id, @actor, @action, @entity_type, @entity_id, @source, @details, @request_id)`);

  function record(e) {
    if (!e || !e.action || !e.source) throw new Error('audit.record يتطلب action و source');
    const info = ins.run({
      actor_user_id: e.userId ?? null,
      actor: e.actor ?? 'system',
      action: e.action,
      entity_type: e.entityType ?? null,
      entity_id: e.entityId == null ? null : String(e.entityId),
      source: e.source,
      details: e.details === undefined ? null : JSON.stringify(e.details),
      request_id: e.requestId ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  function list({ limit = 100, entityType, entityId } = {}) {
    const where = []; const args = [];
    if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
    if (entityId != null) { where.push('entity_id = ?'); args.push(String(entityId)); }
    const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, Math.min(Math.max(1, limit | 0), 1000));
  }
  return { record, list };
}
module.exports = { createAudit };

'use strict';

/**
 * سجل التدقيق (Audit Trail) — إضافة فقط (append-only) ويُفرض ذلك داخل قاعدة البيانات نفسها.
 * يُستدعى داخل نفس المعاملة المالية فيُلغى معها إن فشلت.
 * التفاصيل تُنقّى تلقائيًا من أي مفتاح سري (كلمات المرور، رموز الجلسات...) قبل الحفظ.
 */
// اسم مطابق تمامًا أو ينتهي بكلمة سرية (newPassword, csrf_token, password_hash...) — ولا يطابق passwordMinLength مثلًا.
const SECRET_KEY_RE = /^(pass|pwd|secret|token|csrf|cookie|sid)$|(password|secret|token|hash|cookie)$/i;
const REDACTED = '[REDACTED]';

function sanitize(v, depth = 0) {
  if (depth > 8) return '[DEPTH]';
  if (Array.isArray(v)) return v.map((x) => sanitize(x, depth + 1));
  if (v && typeof v === 'object') {
    if (Buffer.isBuffer(v)) return `[binary ${v.length} bytes]`;
    const out = {};
    // القيم المنطقية (مثل mustChangePassword) ليست أسرارًا فتبقى للتتبع.
    for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY_RE.test(k) && typeof x !== 'boolean' ? REDACTED : sanitize(x, depth + 1);
    return out;
  }
  return v;
}

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
      details: e.details === undefined ? null : JSON.stringify(sanitize(e.details)),
      request_id: e.requestId ?? null,
    });
    return Number(info.lastInsertRowid);
  }

  /** تسجيل حدث من طلب HTTP: يملأ المستخدم ورقم الطلب وعنوان IP تلقائيًا. */
  function fromCtx(ctx, e) {
    return record({
      ...e,
      userId: e.userId ?? (ctx.user ? ctx.user.id : null),
      actor: e.actor ?? (ctx.user ? ctx.user.username : 'anonymous'),
      requestId: ctx.requestId,
      details: { ...(e.details || {}), ip: ctx.ip },
    });
  }

  /** قراءة مع فلاتر اختيارية وترقيم بالصفحات عبر beforeId. */
  function list({ limit = 100, entityType, entityId, action, userId, beforeId } = {}) {
    const where = []; const args = [];
    if (entityType) { where.push('entity_type = ?'); args.push(entityType); }
    if (entityId != null) { where.push('entity_id = ?'); args.push(String(entityId)); }
    if (action) { where.push("action LIKE ? ESCAPE '\\'"); args.push(String(action).replace(/[\\%_]/g, '\\$&') + '%'); }
    if (userId != null) { where.push('actor_user_id = ?'); args.push(userId); }
    if (beforeId != null) { where.push('id < ?'); args.push(beforeId); }
    const sql = `SELECT * FROM audit_log ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`;
    return db.prepare(sql).all(...args, Math.min(Math.max(1, limit | 0), 1000));
  }
  return { record, fromCtx, list };
}
module.exports = { createAudit, sanitize };

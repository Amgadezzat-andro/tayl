'use strict';
const crypto = require('node:crypto');

/**
 * الجلسات على الخادم (لا شيء حساس في المتصفح غير كوكي HttpOnly):
 *  - الرمز 32 بايت عشوائية في كوكي tayl_sid (HttpOnly, SameSite=Strict, Path=/, و Secure عند HTTPS).
 *  - القاعدة تخزّن SHA-256 للرمز فقط.
 *  - انتهاء بالخمول (sessionIdleMinutes) وحد مطلق (sessionAbsoluteHours) من الإعدادات.
 *  - رمز CSRF منفصل لكل جلسة، تعطيه الواجهة في الترويسة X-CSRF-Token (يُحفظ في الذاكرة فقط، لا LocalStorage).
 *  - رمز جديد عند كل دخول (يمنع Session Fixation).
 */
const COOKIE = 'tayl_sid';
const TOUCH_EVERY_MS = 30 * 1000;

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const token = () => crypto.randomBytes(32).toString('base64url');

function parseCookies(header) {
  const out = {};
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i < 1) continue;
    const k = part.slice(0, i).trim();
    if (!(k in out)) out[k] = part.slice(i + 1).trim();
  }
  return out;
}

function createSessionStore({ db, settings, config }) {
  const limits = () => {
    const s = settings.get();
    return { idleMs: s.sessionIdleMinutes * 60000, absoluteMs: s.sessionAbsoluteHours * 3600000 };
  };

  function isSecure(req) {
    if (config.cookieSecure === true) return true;
    if (config.cookieSecure === false) return false;
    return !!req.socket.encrypted;
  }

  function cookie(req, value, clear = false) {
    const attrs = [`${COOKIE}=${value}`, 'Path=/', 'HttpOnly', 'SameSite=Strict'];
    if (isSecure(req)) attrs.push('Secure');
    if (clear) attrs.push('Max-Age=0');
    return attrs.join('; ');
  }

  return {
    COOKIE,
    purgeExpired(now = Date.now()) {
      db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR last_seen_at <= ?').run(now, now - limits().idleMs);
    },

    create({ userId, branchId, ip, userAgent }) {
      const now = Date.now();
      const t = token();
      const csrf = token();
      const expiresAt = now + limits().absoluteMs;
      db.prepare(`INSERT INTO sessions (token_hash, user_id, csrf_token, branch_id, created_at, last_seen_at, expires_at, ip, user_agent)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sha256(t), userId, csrf, branchId, now, now, expiresAt, ip || null, String(userAgent || '').slice(0, 300) || null);
      return { token: t, csrf, expiresAt };
    },

    /** يعيد الجلسة السارية أو null (ويحذف المنتهية). */
    lookup(req) {
      const t = parseCookies(req.headers.cookie)[COOKIE];
      if (!t || t.length > 100) return null;
      const hash = sha256(t);
      const row = db.prepare('SELECT * FROM sessions WHERE token_hash = ?').get(hash);
      if (!row) return null;
      const now = Date.now();
      const { idleMs } = limits();
      if (row.expires_at <= now || row.last_seen_at + idleMs <= now) {
        db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash);
        return null;
      }
      if (now - row.last_seen_at > TOUCH_EVERY_MS) {
        db.prepare('UPDATE sessions SET last_seen_at = ? WHERE token_hash = ?').run(now, hash);
        row.last_seen_at = now;
      }
      return { ...row, idleExpiresAt: row.last_seen_at + idleMs };
    },

    setBranch: (hash, branchId) => db.prepare('UPDATE sessions SET branch_id = ? WHERE token_hash = ?').run(branchId, hash),
    destroy: (hash) => db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hash),
    /** إنهاء كل جلسات المستخدم (عند التعطيل أو تغيير كلمة المرور) مع استثناء الجلسة الحالية اختياريًا. */
    destroyForUser: (userId, exceptHash = '') => db.prepare('DELETE FROM sessions WHERE user_id = ? AND token_hash <> ?').run(userId, exceptHash).changes,

    setCookie: (ctx, value) => ctx.res.setHeader('Set-Cookie', cookie(ctx.req, value)),
    clearCookie: (ctx) => ctx.res.setHeader('Set-Cookie', cookie(ctx.req, '', true)),

    csrfMatches(row, header) {
      if (typeof header !== 'string' || !header) return false;
      const a = Buffer.from(header);
      const b = Buffer.from(row.csrf_token);
      return a.length === b.length && crypto.timingSafeEqual(a, b);
    },
  };
}

module.exports = { createSessionStore, parseCookies, COOKIE };

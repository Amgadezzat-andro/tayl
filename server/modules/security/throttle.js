'use strict';
const { HttpError } = require('../../core/errors');

/**
 * حماية محاولات الدخول المتكررة (محفوظة في القاعدة فتبقى بعد إعادة التشغيل):
 *  - لكل اسم مستخدم: بعد loginMaxFailures فشلًا خلال النافذة يُقفل loginLockMinutes.
 *    يطبَّق على الأسماء غير الموجودة أيضًا، فلا يكشف السلوك وجود الحساب.
 *  - لكل عنوان IP: حد أعلى (4 أضعاف) لمنع تجربة أسماء كثيرة من نفس المصدر.
 */
function createThrottle({ db, settings }) {
  const cfg = () => {
    const s = settings.get();
    return { max: s.loginMaxFailures, lockMs: s.loginLockMinutes * 60000 };
  };
  const keysFor = (username, ip) => [{ key: 'u:' + String(username).toLowerCase(), factor: 1 }, { key: 'ip:' + ip, factor: 4 }];

  return {
    keysFor,
    /** يرمي 429 إن كان أي مفتاح مقفلًا. */
    check(keys, now = Date.now()) {
      for (const { key } of keys) {
        const r = db.prepare('SELECT locked_until FROM login_throttle WHERE key = ?').get(key);
        if (r && r.locked_until && r.locked_until > now) {
          throw new HttpError(429, 'TOO_MANY_ATTEMPTS', 'محاولات دخول كثيرة، حاول لاحقًا', { retryAfterSeconds: Math.ceil((r.locked_until - now) / 1000) });
        }
      }
    },
    fail(keys, now = Date.now()) {
      const { max, lockMs } = cfg();
      let locked = false;
      for (const { key, factor } of keys) {
        const r = db.prepare('SELECT * FROM login_throttle WHERE key = ?').get(key);
        const fresh = !r || r.window_start + lockMs <= now;
        const failures = fresh ? 1 : r.failures + 1;
        const lockedUntil = failures >= max * factor ? now + lockMs : null;
        if (lockedUntil) locked = true;
        db.prepare(`INSERT INTO login_throttle (key, failures, window_start, locked_until) VALUES (?, ?, ?, ?)
          ON CONFLICT (key) DO UPDATE SET failures = excluded.failures, window_start = excluded.window_start, locked_until = excluded.locked_until`)
          .run(key, failures, fresh ? now : r.window_start, lockedUntil);
      }
      return locked;
    },
    reset: (key) => db.prepare('DELETE FROM login_throttle WHERE key = ?').run(key),
  };
}

module.exports = { createThrottle };

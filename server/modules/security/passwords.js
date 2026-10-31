'use strict';
const crypto = require('node:crypto');

/**
 * تجزئة كلمات المرور بـ scrypt (مدمج في Node، لا تبعية خارجية):
 *  - N=2^15, r=8, p=1  ← ذاكرة ≈ 32MB لكل محاولة: يجعل التخمين بالعتاد المتخصص مكلفًا.
 *  - ملح عشوائي 16 بايت لكل كلمة، ومفتاح 64 بايت.
 *  - المعاملات تُخزَّن مع التجزئة (scrypt$N$r$p$salt$hash) فيمكن رفعها مستقبلًا دون كسر الحسابات القديمة.
 *  - المقارنة بزمن ثابت (timingSafeEqual).
 * الحساب غير متزامن (async) فلا يوقف الخادم أثناءه.
 */
const PARAMS = Object.freeze({ N: 1 << 15, r: 8, p: 1, keylen: 64 });
const MAXMEM = 64 * 1024 * 1024;

function scrypt(password, salt, { N, r, p, keylen }) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(password.normalize('NFC'), salt, keylen, { N, r, p, maxmem: MAXMEM }, (err, key) => (err ? reject(err) : resolve(key)));
  });
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, PARAMS);
  return `scrypt$${PARAMS.N}$${PARAMS.r}$${PARAMS.p}$${salt.toString('base64')}$${key.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const parts = String(stored).split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [N, r, p] = parts.slice(1, 4).map((x) => Number.parseInt(x, 10));
  if (!(N >= 1024 && N <= 1 << 20 && r >= 1 && r <= 32 && p >= 1 && p <= 16)) return false;
  const salt = Buffer.from(parts[4], 'base64');
  const expected = Buffer.from(parts[5], 'base64');
  if (!salt.length || !expected.length) return false;
  const key = await scrypt(String(password), salt, { N, r, p, keylen: expected.length });
  return crypto.timingSafeEqual(key, expected);
}

// تجزئة وهمية ثابتة: تُستخدم عند اسم مستخدم غير موجود حتى يستغرق الرد نفس الوقت (لا يكشف وجود الحساب).
let dummy = null;
async function dummyVerify(password) {
  if (!dummy) dummy = await hashPassword(crypto.randomBytes(16).toString('hex'));
  await verifyPassword(password, dummy);
  return false;
}

/** سياسة كلمة المرور. تعيد رمز الخطأ أو null. */
function passwordProblem(password, { username = '', minLength = 8 } = {}) {
  if (typeof password !== 'string') return 'NOT_STRING';
  if (password.length < minLength) return 'TOO_SHORT';
  if (password.length > 128) return 'TOO_LONG';
  if (!/\p{L}/u.test(password) || !/\p{N}/u.test(password)) return 'PASSWORD_WEAK';
  if (username && password.toLowerCase().includes(username.toLowerCase())) return 'PASSWORD_CONTAINS_USERNAME';
  return null;
}

module.exports = { hashPassword, verifyPassword, dummyVerify, passwordProblem, PARAMS };

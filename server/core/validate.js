'use strict';
const { HttpError } = require('./errors');

/**
 * تحقق مركزي من مدخلات الـ API في الخادم.
 * يبني كائنًا جديدًا بالحقول المعروفة فقط (أي حقل غير معلن يُتجاهل)، ويجمع كل الأخطاء
 * ثم يرمي 400 VALIDATION مع رمز خطأ لكل حقل (الواجهة تترجم الرمز).
 *
 *   const v = validator(body, { partial: true });
 *   v.str('nameAr', { required: true, max: 200 });
 *   const data = v.done();
 *
 * partial: في التعديل الجزئي يُتجاهل الحقل الغائب تمامًا (لا يُعتبر مطلوبًا).
 */
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/;
const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,190}\.[^\s@]{2,}$/;
const PHONE_RE = /^\+?[0-9][0-9 ()-]{2,30}$/;

function validator(input, { partial = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'VALIDATION', 'بيانات الطلب غير صالحة', { fields: { _: 'OBJECT_REQUIRED' } });
  }
  const out = {};
  const fields = {};
  const present = (k) => Object.prototype.hasOwnProperty.call(input, k) && input[k] !== undefined;
  const fail = (k, code) => { if (!fields[k]) fields[k] = code; };

  /** يعيد true إن وجب متابعة التحقق من القيمة. */
  function pre(k, required, empty) {
    if (!present(k) || input[k] === null || empty(input[k])) {
      if (partial && !present(k)) return false;
      if (required) fail(k, 'REQUIRED');
      else if (present(k)) out[k] = null;
      return false;
    }
    return true;
  }
  const blank = (x) => typeof x === 'string' && x.trim() === '';

  const api = {
    str(k, { required = false, min = 0, max = 200, pattern = null, upper = false, multiline = false } = {}) {
      if (!pre(k, required, blank)) return api;
      let s = input[k];
      if (typeof s !== 'string') { fail(k, 'NOT_STRING'); return api; }
      s = s.normalize('NFC').trim();
      if (upper) s = s.toUpperCase();
      if (CONTROL_RE.test(s) || (!multiline && /[\r\n]/.test(s))) { fail(k, 'INVALID'); return api; }
      if (s.length < min) { fail(k, 'TOO_SHORT'); return api; }
      if (s.length > max) { fail(k, 'TOO_LONG'); return api; }
      if (pattern && !pattern.test(s)) { fail(k, 'INVALID'); return api; }
      out[k] = s;
      return api;
    },
    email(k, opts = {}) { return api.str(k, { ...opts, max: 254, pattern: EMAIL_RE }); },
    phone(k, opts = {}) { return api.str(k, { ...opts, max: 32, pattern: PHONE_RE }); },
    /** كلمة المرور لا تُقص ولا تُطبَّع: تُحفظ كما كتبها المستخدم. */
    secret(k, { required = true, min = 8, max = 128 } = {}) {
      if (!pre(k, required, (x) => x === '')) return api;
      const s = input[k];
      if (typeof s !== 'string') { fail(k, 'NOT_STRING'); return api; }
      if (s.length < min) { fail(k, 'TOO_SHORT'); return api; }
      if (s.length > max) { fail(k, 'TOO_LONG'); return api; }
      out[k] = s;
      return api;
    },
    bool(k, { required = false } = {}) {
      if (!pre(k, required, () => false)) return api;
      if (typeof input[k] !== 'boolean') { fail(k, 'NOT_BOOLEAN'); return api; }
      out[k] = input[k];
      return api;
    },
    int(k, { required = false, min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
      if (!pre(k, required, () => false)) return api;
      const n = input[k];
      if (!Number.isSafeInteger(n)) { fail(k, 'NOT_INTEGER'); return api; }
      if (n < min || n > max) { fail(k, 'OUT_OF_RANGE'); return api; }
      out[k] = n;
      return api;
    },
    /** مُعرّف كيان: عدد صحيح موجب. */
    id(k, opts = {}) { return api.int(k, { ...opts, min: 1 }); },
    oneOf(k, values, { required = false } = {}) {
      if (!pre(k, required, blank)) return api;
      if (!values.includes(input[k])) { fail(k, 'NOT_ALLOWED'); return api; }
      out[k] = input[k];
      return api;
    },
    /** قائمة معرّفات فريدة. */
    ids(k, { required = false, max = 1000 } = {}) {
      if (!pre(k, required, () => false)) return api;
      const a = input[k];
      if (!Array.isArray(a) || a.length > max || !a.every((x) => Number.isSafeInteger(x) && x > 0)) { fail(k, 'INVALID'); return api; }
      out[k] = [...new Set(a)];
      return api;
    },
    /** قائمة نصوص فريدة (مثل مفاتيح الصلاحيات). */
    strings(k, { required = false, max = 1000, pattern = null } = {}) {
      if (!pre(k, required, () => false)) return api;
      const a = input[k];
      if (!Array.isArray(a) || a.length > max || !a.every((x) => typeof x === 'string' && x.length <= 100 && (!pattern || pattern.test(x)))) { fail(k, 'INVALID'); return api; }
      out[k] = [...new Set(a)];
      return api;
    },
    /** قيمة عشرية: نص فقط (JSON يفقد دقة الأرقام قبل أن نراها). */
    decimal(k, { required = false } = {}) {
      if (!pre(k, required, blank)) return api;
      if (typeof input[k] !== 'string') { fail(k, 'DECIMAL_MUST_BE_STRING'); return api; }
      if (!/^[+-]?\d+(\.\d+)?$/.test(input[k]) || input[k].length > 80) { fail(k, 'INVALID'); return api; }
      out[k] = input[k];
      return api;
    },
    /** خطأ يكتشفه المستدعي (مثل قاعدة عمل) مضاف لنفس الاستجابة. */
    error(k, code) { fail(k, code); return api; },
    done() {
      if (Object.keys(fields).length) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields });
      return out;
    },
  };
  return api;
}

/** معرّف من مسار URL. */
function idParam(v) {
  if (!/^[1-9]\d{0,15}$/.test(String(v))) throw new HttpError(400, 'BAD_ID', 'معرّف غير صالح');
  return Number(v);
}

module.exports = { validator, idParam, EMAIL_RE, PHONE_RE };

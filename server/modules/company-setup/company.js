'use strict';
const crypto = require('node:crypto');
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { CURRENCY_RE } = require('../../core/decimal/policy');

/** حقول بيانات الشركة: [اسم في الـ API، عمود في القاعدة]. */
const FIELDS = [
  ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['addressAr', 'address_ar'], ['addressEn', 'address_en'],
  ['phone', 'phone'], ['email', 'email'], ['taxNumber', 'tax_number'], ['commercialRegister', 'commercial_register'],
  ['baseCurrency', 'base_currency'], ['defaultLanguage', 'default_language'],
];
const MAX_LOGO_BYTES = 512 * 1024;

function toApi(row) {
  if (!row) return null;
  const out = {};
  for (const [api, col] of FIELDS) out[api] = row[col];
  out.hasLogo = row.logo_mime != null;
  out.logoSha256 = row.logo_sha256;
  out.createdAt = row.created_at;
  out.updatedAt = row.updated_at;
  return out;
}

function validateProfile(body, { partial = false } = {}) {
  return validator(body, { partial })
    .str('nameAr', { required: true, max: 200 })
    .str('nameEn', { required: true, max: 200 })
    .str('addressAr', { max: 500, multiline: true })
    .str('addressEn', { max: 500, multiline: true })
    .phone('phone')
    .email('email')
    .str('taxNumber', { max: 50 })
    .str('commercialRegister', { max: 50 })
    .str('baseCurrency', { required: true, upper: true, pattern: CURRENCY_RE })
    .oneOf('defaultLanguage', ['ar', 'en'], { required: true })
    .done();
}

/** فحص نوع الصورة من محتواها الفعلي (لا نثق في النوع الذي يرسله المتصفح). SVG ممنوع لأنه قد يحمل سكربت. */
function sniffImage(buf) {
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** يفك شعارًا مرسلًا كـ base64 ويتحقق منه. يعيد { logo, mime, sha256 }. */
function decodeLogo(data) {
  if (typeof data !== 'string' || data.length > Math.ceil(MAX_LOGO_BYTES / 3) * 4 + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data)) {
    throw new HttpError(400, 'LOGO_INVALID', 'ملف الشعار غير صالح');
  }
  const buf = Buffer.from(data, 'base64');
  if (!buf.length || buf.length > MAX_LOGO_BYTES) throw new HttpError(400, 'LOGO_TOO_LARGE', 'حجم الشعار أكبر من 512KB');
  const mime = sniffImage(buf);
  if (!mime) throw new HttpError(400, 'LOGO_TYPE', 'نوع الشعار يجب أن يكون PNG أو JPEG أو WebP');
  return { logo: buf, mime, sha256: crypto.createHash('sha256').update(buf).digest('hex') };
}

function createCompanyService({ db, audit }) {
  const getRow = () => db.prepare('SELECT * FROM company WHERE id = 1').get();

  return {
    isSetUp: () => !!db.prepare('SELECT 1 FROM company WHERE id = 1').get(),
    get: () => toApi(getRow()),
    validateProfile,
    decodeLogo,

    /** إنشاء صف الشركة الوحيد (يُستدعى داخل معاملة التأسيس). القاعدة ترفض أي صف ثانٍ. */
    insert(data, logo) {
      db.prepare(`INSERT INTO company (id, ${FIELDS.map((f) => f[1]).join(', ')}, logo, logo_mime, logo_sha256)
        VALUES (1, ${FIELDS.map(() => '?').join(', ')}, ?, ?, ?)`)
        .run(...FIELDS.map(([api]) => data[api] ?? null), logo ? logo.logo : null, logo ? logo.mime : null, logo ? logo.sha256 : null);
    },

    update(ctx, body) {
      const data = validateProfile(body, { partial: true });
      const changes = FIELDS.filter(([api]) => api in data);
      if (!changes.length) return toApi(getRow());
      return inTransaction(db, () => {
        const before = getRow();
        if (!before) throw new HttpError(409, 'SETUP_REQUIRED', 'لم يتم تأسيس الشركة بعد');
        db.prepare(`UPDATE company SET ${changes.map(([, col]) => `${col} = ?`).join(', ')},
          updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run(...changes.map(([api]) => data[api]));
        const diff = {};
        for (const [api, col] of changes) if (before[col] !== data[api]) diff[api] = { from: before[col], to: data[api] };
        if (Object.keys(diff).length) audit.fromCtx(ctx, { action: 'company.updated', source: 'company-setup', entityType: 'company', entityId: 1, details: { changes: diff } });
        return toApi(getRow());
      });
    },

    setLogo(ctx, data) {
      const logo = decodeLogo(data);
      inTransaction(db, () => {
        db.prepare(`UPDATE company SET logo = ?, logo_mime = ?, logo_sha256 = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run(logo.logo, logo.mime, logo.sha256);
        audit.fromCtx(ctx, { action: 'company.logo.updated', source: 'company-setup', entityType: 'company', entityId: 1, details: { mime: logo.mime, bytes: logo.logo.length, sha256: logo.sha256 } });
      });
    },

    removeLogo(ctx) {
      inTransaction(db, () => {
        db.prepare(`UPDATE company SET logo = NULL, logo_mime = NULL, logo_sha256 = NULL, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 1`).run();
        audit.fromCtx(ctx, { action: 'company.logo.removed', source: 'company-setup', entityType: 'company', entityId: 1 });
      });
    },

    logo: () => db.prepare('SELECT logo, logo_mime, logo_sha256 FROM company WHERE id = 1 AND logo IS NOT NULL').get(),
  };
}

function registerCompanyRoutes(router, services) {
  const { company } = services;

  router.get('/api/company', { permission: 'company.view' }, () => {
    const c = company.get();
    if (!c) throw new HttpError(409, 'SETUP_REQUIRED', 'لم يتم تأسيس الشركة بعد');
    return c;
  });
  router.put('/api/company', { permission: 'company.update' }, async (ctx) => company.update(ctx, await ctx.body()));
  router.put('/api/company/logo', { permission: 'company.update' }, async (ctx) => {
    const body = await ctx.body();
    company.setLogo(ctx, body && body.data);
    return company.get();
  });
  router.delete('/api/company/logo', { permission: 'company.update' }, (ctx) => { company.removeLogo(ctx); return company.get(); });

  // يظهر في رأس الواجهة لكل مستخدم مسجّل.
  router.get('/api/company/logo', { auth: true }, (ctx) => {
    const row = company.logo();
    if (!row) throw new HttpError(404, 'NOT_FOUND', 'لا يوجد شعار');
    ctx.res.writeHead(200, { 'Content-Type': row.logo_mime, 'Content-Length': row.logo.length, 'Cache-Control': 'private, no-cache', ETag: `"${row.logo_sha256}"` });
    ctx.res.end(row.logo);
  });
}

module.exports = { createCompanyService, registerCompanyRoutes, validateProfile, decodeLogo, sniffImage };

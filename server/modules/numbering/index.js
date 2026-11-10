'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { validator, idParam } = require('../../core/validate');
const { inTransaction } = require('../../core/db');
const { createNumbering } = require('./numbering');

/**
 * ترقيم المستندات (المرحلة 3): سلاسل قابلة للإعداد، وإصدار ذري داخل معاملة المستند.
 * بعد أول رقم صادر تُقفل الهوية والنطاق (الخادم + trigger)، ويُسمح بالتسميات والافتراضية والتعطيل/إعادة التفعيل فقط.
 */
const CODE_RE = /^[A-Z][A-Z0-9]{0,9}$/;
const DOC_TYPE_RE = /^[a-z][a-z_]{0,39}$/;
const LOCKED = ['code', 'docType', 'prefix', 'perBranch', 'resetYearly', 'padding'];
const COLS = { code: 'code', docType: 'doc_type', nameAr: 'name_ar', nameEn: 'name_en', prefix: 'prefix', perBranch: 'per_branch', resetYearly: 'reset_yearly', padding: 'padding', isDefault: 'is_default' };

module.exports = {
  name: 'numbering',
  version: '1.0.0',
  dependsOn: ['company-setup', 'fiscal-years'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db, audit } = services;
    services.permissions.register('numbering', [
      { resource: 'document_series', group: 'accounting', actions: ['view', 'create', 'update', 'disable'] },
    ]);
    const numbering = createNumbering(db);
    services.numbering = numbering;
    // كود فرع ظهر في أرقام صادرة لفرع آخر لا يُعاد استخدامه: كان سيُنتج نص رقم صادر من قبل فيتوقف ترحيل الفرع
    // (تحفظي: أي رقم سلسلة لكل فرع يبدأ بـ PREFIX-CODE- لفرع آخر يكفي للرفض).
    services.branches.registerCodeGuard((branch, code) => {
      const hit = db.prepare(`SELECT n.number FROM issued_numbers n JOIN document_series s ON s.id = n.series_id
        WHERE s.per_branch = 1 AND n.branch_id <> ? AND substr(n.number, 1, length(s.prefix) + length(?) + 2) = s.prefix || '-' || ? || '-' LIMIT 1`).get(branch.id, code, code);
      if (hit) throw new HttpError(409, 'BRANCH_CODE_IN_NUMBERS', 'هذا الكود ظهر في أرقام مستندات فرع آخر؛ اختر كودًا جديدًا', { fields: { code: 'USED_IN_NUMBERS' }, number: hit.number });
    });

    const row = (id) => db.prepare('SELECT * FROM document_series WHERE id = ?').get(id);
    const used = (id) => !!db.prepare('SELECT 1 FROM issued_numbers WHERE series_id = ? LIMIT 1').get(id);
    const toApi = (r) => ({
      id: r.id, code: r.code, docType: r.doc_type, nameAr: r.name_ar, nameEn: r.name_en, prefix: r.prefix,
      perBranch: r.per_branch === 1, resetYearly: r.reset_yearly === 1, padding: r.padding,
      isDefault: r.is_default === 1, isActive: r.is_active === 1, isUsed: used(r.id),
      example: numbering.format(r, 'HQ', new Date().getFullYear(), 1),
    });
    function parse(body, partial) {
      const d = validator(body, { partial })
        .str('code', { required: true, upper: true, pattern: CODE_RE }).str('docType', { required: true, pattern: DOC_TYPE_RE })
        .str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 })
        .str('prefix', { required: true, upper: true, pattern: CODE_RE })
        .bool('perBranch').bool('resetYearly').int('padding', { min: 4, max: 10 }).bool('isDefault')
        .done();
      for (const k of ['perBranch', 'resetYearly', 'isDefault']) if (k in d) d[k] = d[k] ? 1 : 0;
      return d;
    }
    const unique = (e) => {
      if (e.code === 'SQLITE_CONSTRAINT_UNIQUE') throw new HttpError(409, 'DUPLICATE', 'القيمة مستخدمة من قبل', { fields: { [/prefix/.test(e.message) ? 'prefix' : /doc_type/.test(e.message) ? 'isDefault' : 'code']: 'TAKEN' } });
      throw e;
    };
    /** سلسلة افتراضية واحدة لكل نوع: جعل سلسلة افتراضية يلغي افتراضية سابقتها في المعاملة نفسها. */
    const clearDefault = (docType, exceptId) => db.prepare("UPDATE document_series SET is_default = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE doc_type = ? AND is_default = 1 AND id <> ?").run(docType, exceptId);

    function create(ctx, body) {
      const d = parse(body, false);
      return inTransaction(db, () => {
        if (d.isDefault) clearDefault(d.docType, 0);
        let id;
        try {
          id = Number(db.prepare(`INSERT INTO document_series (${Object.keys(d).map((k) => COLS[k]).join(', ')}) VALUES (${Object.keys(d).map(() => '?').join(', ')})`)
            .run(...Object.values(d)).lastInsertRowid);
        } catch (e) { unique(e); }
        audit.fromCtx(ctx, { action: 'document_series.created', source: 'numbering', entityType: 'document_series', entityId: id, details: { ...d } });
        return toApi(row(id));
      });
    }
    function update(ctx, id, body) {
      const d = parse(body, true);
      return inTransaction(db, () => {
        const r = row(id);
        if (!r) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
        const changes = {};
        for (const [k, v] of Object.entries(d)) if (v !== r[COLS[k]]) changes[k] = { from: r[COLS[k]], to: v };
        const lockedChanges = Object.keys(changes).filter((k) => LOCKED.includes(k));
        if (lockedChanges.length && used(id)) throw new HttpError(409, 'SERIES_LOCKED', 'إعدادات السلسلة مقفلة بعد أول رقم صادر', { fields: Object.fromEntries(lockedChanges.map((k) => [k, 'LOCKED'])) });
        if (changes.isDefault && changes.isDefault.to === 0) throw new HttpError(409, 'SERIES_DEFAULT_REQUIRED', 'اجعل سلسلة أخرى افتراضية بدلًا منها');
        if (!Object.keys(changes).length) return toApi(r);
        if (changes.isDefault) {
          if (r.is_active !== 1) throw new HttpError(409, 'SERIES_INACTIVE', 'سلسلة الترقيم معطّلة', { series: r.code });
          clearDefault(d.docType || r.doc_type, id);
        }
        try {
          db.prepare(`UPDATE document_series SET ${Object.keys(changes).map((k) => `${COLS[k]} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
            .run(...Object.keys(changes).map((k) => changes[k].to), id);
        } catch (e) { unique(e); }
        audit.fromCtx(ctx, { action: 'document_series.updated', source: 'numbering', entityType: 'document_series', entityId: id, details: { code: r.code, changes } });
        return toApi(row(id));
      });
    }
    /** التعطيل يوقف الإصدار الجديد فقط؛ إعادة التفعيل تكمل من آخر قيمة للعداد (لا يعود أي رقم). */
    function setActive(ctx, id, body) {
      const { active } = validator(body).bool('active', { required: true }).done();
      return inTransaction(db, () => {
        const r = row(id);
        if (!r) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
        if (!active && r.is_default === 1) throw new HttpError(409, 'SERIES_DEFAULT_REQUIRED', 'اجعل سلسلة أخرى افتراضية قبل تعطيل هذه');
        if ((r.is_active === 1) === active) return toApi(r);
        db.prepare("UPDATE document_series SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?").run(active ? 1 : 0, id);
        audit.fromCtx(ctx, { action: active ? 'document_series.activated' : 'document_series.deactivated', source: 'numbering', entityType: 'document_series', entityId: id, details: { code: r.code } });
        return toApi(row(id));
      });
    }

    const P = (a) => ({ permission: `document_series.${a}` });
    router.get('/api/document-series', P('view'), () => db.prepare('SELECT * FROM document_series ORDER BY doc_type, code').all().map(toApi));
    router.post('/api/document-series', P('create'), async (ctx) => create(ctx, await ctx.body()));
    router.put('/api/document-series/:id', P('update'), async (ctx) => update(ctx, idParam(ctx.params.id), await ctx.body()));
    router.post('/api/document-series/:id/status', P('disable'), async (ctx) => setActive(ctx, idParam(ctx.params.id), await ctx.body()));
  },
};

'use strict';
const path = require('node:path');
const { validator } = require('../../core/validate');
const { normalize } = require('../../core/search');
const { createMasterService, registerMasterRoutes, masterActions } = require('../../core/master');
const { registerImportRoutes, fieldErrors } = require('../../core/import');

/**
 * قاموس وحدات القياس العامة.
 * منع التكرار: الكود فريد، والاسم العربي والإنجليزي فريدان بعد التطبيع، والرمز فريد داخل التصنيف.
 * لا يوجد معامل تحويل عام: التصميم المعتمد للمرحلة القادمة (docs/PHASE2_REPORT.md) — لكل صنف وحدة أساس واحدة
 * ووحدات تعامل غير محدودة بمعامل خاص بالصنف، ويُحفظ (الوحدة، المعامل) في كل سطر مستند، والرصيد بوحدة الأساس.
 */
const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,19}$/;
const CATEGORIES = ['count', 'weight', 'length', 'volume', 'area', 'time', 'other'];
const validate = (body, { partial }) => {
  const d = validator(body, { partial })
    .str('code', { required: true, upper: true, pattern: CODE_RE, max: 20 })
    .str('nameAr', { required: true, max: 60 }).str('nameEn', { required: true, max: 60 })
    .str('symbol', { max: 12 }).oneOf('category', CATEGORIES, { required: true }).str('description', { max: 300, multiline: true })
    .done();
  if (d.nameAr) d.nameArNorm = normalize(d.nameAr);
  if (d.nameEn) d.nameEnNorm = normalize(d.nameEn);
  return d;
};

module.exports = {
  name: 'units',
  version: '1.0.0',
  dependsOn: ['company-setup'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    services.permissions.register('units', [{ resource: 'units', group: 'reference', actions: masterActions(['import']) }]);
    const svc = createMasterService(services, {
      entity: 'unit', table: 'units', source: 'units', titleKey: 'nav.units',
      columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['nameArNorm', 'name_ar_norm'], ['nameEnNorm', 'name_en_norm'],
        ['symbol', 'symbol'], ['category', 'category'], ['description', 'description']],
      uniqueFields: { name_ar_norm: 'nameAr', name_en_norm: 'nameEn', units_symbol_per_category: 'symbol', code: 'code' },
      validate,
      searchCols: ['code', 'name_ar', 'name_en', 'symbol'],
      toApi: (r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, symbol: r.symbol, category: r.category, description: r.description, isActive: r.is_active === 1 }),
      filters: { category: (v) => (CATEGORIES.includes(v) ? { sql: 'category = ?', params: [v] } : null) },
      lookupExtra: (r) => ({ symbol: r.symbol, category: r.category }),
      exportColumns: [
        { label: 'unit.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
        { label: 'unit.symbol', value: (r) => r.symbol }, { label: 'unit.category', value: (r, t) => t('unit.cat.' + r.category) },
        { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
      ],
    });
    services.units = svc;
    registerMasterRoutes(router, svc, { base: '/api/units', resource: 'units', exportFile: 'units' });

    const { db } = services;
    const catOf = (v) => { const n = normalize(v); return CATEGORIES.find((c) => c === n || normalize(services.i18n.t('ar', 'unit.cat.' + c)) === n || normalize(services.i18n.t('en', 'unit.cat.' + c)) === n); };
    registerImportRoutes(router, {
      base: '/api/units', resource: 'units', fileName: 'units',
      columns: [
        { key: 'code', aliases: ['الكود'], required: true }, { key: 'name_ar', aliases: ['الاسم العربي'], required: true },
        { key: 'name_en', aliases: ['الاسم الإنجليزي'], required: true }, { key: 'symbol', aliases: ['الرمز'] },
        { key: 'category', aliases: ['التصنيف'], required: true }, { key: 'description', aliases: ['الوصف'] },
      ],
      validate(ctx, rows) {
        const seen = { code: new Map(), nameAr: new Map(), nameEn: new Map() };
        return rows.map(({ line, values: v }) => {
          const cat = catOf(v.category);
          const p = fieldErrors(() => validate({ code: v.code, nameAr: v.name_ar, nameEn: v.name_en, symbol: v.symbol || undefined, category: cat || v.category, description: v.description || undefined }, { partial: false }));
          const errors = [...p.errors];
          const d = p.value;
          if (d) {
            if (db.prepare('SELECT 1 FROM units WHERE code = ?').get(d.code)) errors.push({ field: 'code', code: 'CODE_EXISTS' });
            if (db.prepare('SELECT 1 FROM units WHERE name_ar_norm = ?').get(d.nameArNorm)) errors.push({ field: 'name_ar', code: 'TAKEN' });
            if (db.prepare('SELECT 1 FROM units WHERE name_en_norm = ?').get(d.nameEnNorm)) errors.push({ field: 'name_en', code: 'TAKEN' });
            for (const [k, val, f] of [['code', d.code, 'code'], ['nameAr', d.nameArNorm, 'name_ar'], ['nameEn', d.nameEnNorm, 'name_en']]) {
              if (seen[k].has(val)) errors.push({ field: f, code: 'DUPLICATE_IN_FILE' }); else seen[k].set(val, line);
            }
          }
          return { line, values: v, data: d, errors };
        });
      },
      commit(ctx, items) {
        for (const it of items) {
          const { nameArNorm, nameEnNorm, ...body } = it.data;   // eslint-disable-line no-unused-vars
          svc.create(ctx, body);
        }
        return items.length;
      },
    });
  },
};

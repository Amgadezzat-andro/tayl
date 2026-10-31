'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { createMasterService, registerMasterRoutes, masterActions } = require('../../core/master');
const { registerImportRoutes, fieldErrors, parseBool, checkTree } = require('../../core/import');

/**
 * مراكز التكلفة: شجرة، نوع، فرع اختياري (NULL = عام)، تفعيل/تعطيل، ولا حذف لمركز مستخدم.
 * للمراحل القادمة: services.costCenters.assertUsable(id, ctx) قبل استخدام مركز في حركة جديدة.
 * التصميم جاهز لتوزيع المصروفات المشتركة لاحقًا (جدول أسس توزيع يشير إلى cost_centers) دون تنفيذ المحرك الآن.
 */
const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;

module.exports = {
  name: 'cost-centers',
  version: '1.0.0',
  dependsOn: ['company-setup'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    const { db } = services;
    services.permissions.register('cost-centers', [{ resource: 'cost_centers', group: 'accounting', actions: masterActions(['import']) }]);

    const typeRow = (id) => db.prepare('SELECT * FROM cost_center_types WHERE id = ?').get(id);
    const branchCode = (id) => (id ? (db.prepare('SELECT code FROM branches WHERE id = ?').get(id) || {}).code : '');
    const centers = createMasterService(services, {
      entity: 'cost_center', table: 'cost_centers', source: 'cost-centers', tree: true, titleKey: 'nav.costCenters',
      scope: { api: 'branchId', col: 'branch_id', nullable: true },
      columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['parentId', 'parent_id'], ['typeId', 'type_id'],
        ['branchId', 'branch_id'], ['isGroup', 'is_group'], ['sortOrder', 'sort_order'], ['description', 'description']],
      validate(body, { partial }) {
        const d = validator(body, { partial })
          .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
          .str('nameAr', { required: true, max: 200 }).str('nameEn', { required: true, max: 200 })
          .id('parentId').id('typeId').id('branchId').bool('isGroup').int('sortOrder', { min: 0, max: 1e9 })
          .str('description', { max: 500, multiline: true })
          .done();
        if ('isGroup' in d) d.isGroup = d.isGroup ? 1 : 0;
        return d;
      },
      /** المركز الفرعي يتبع فرع أبيه إن كان للأب فرع. */
      beforeSave(ctx, d, before, parent) {
        const parentRow = parent || (before && before.parent_id != null ? db.prepare('SELECT * FROM cost_centers WHERE id = ?').get(before.parent_id) : null);
        const branch = 'branchId' in d ? d.branchId : (before ? before.branch_id : null);
        if (parentRow && parentRow.branch_id != null && branch !== parentRow.branch_id) {
          if (!before && !('branchId' in d)) d.branchId = parentRow.branch_id;
          else throw new HttpError(409, 'BRANCH_MISMATCH', 'فرع المركز يجب أن يطابق فرع المركز الأب');
        }
        if (before && 'branchId' in d && d.branchId !== before.branch_id && db.prepare('SELECT 1 FROM cost_centers WHERE parent_id = ? LIMIT 1').get(before.id)) {
          throw new HttpError(409, 'HAS_CHILDREN', 'لا يمكن تغيير فرع مركز له مراكز فرعية');
        }
        if ('typeId' in d && d.typeId != null) {
          const t = typeRow(d.typeId);
          if (!t) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { typeId: 'NOT_FOUND' } });
          if (t.is_active !== 1 && (!before || before.type_id !== d.typeId)) throw new HttpError(409, 'TYPE_INACTIVE', 'النوع معطّل');
        }
        if (!before && d.isGroup == null) d.isGroup = 0;
      },
      toApi: (r) => ({
        id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, parentId: r.parent_id, level: r.level, typeId: r.type_id,
        branchId: r.branch_id, isGroup: r.is_group === 1, isActive: r.is_active === 1, sortOrder: r.sort_order, description: r.description,
        createdAt: r.created_at, updatedAt: r.updated_at,
      }),
      filters: {
        typeId: (v) => (/^\d+$/.test(v) ? { sql: 'type_id = ?', params: [Number(v)] } : null),
        branchId: (v) => (v === 'none' ? { sql: 'branch_id IS NULL', params: [] } : /^\d+$/.test(v) ? { sql: 'branch_id = ?', params: [Number(v)] } : null),
        isGroup: (v) => (v === '1' || v === '0' ? { sql: 'is_group = ?', params: [Number(v)] } : null),
      },
      lookupExtra: (r) => ({ branchId: r.branch_id }),
      exportColumns: [
        { label: 'cc.code', value: (r) => r.code },
        { label: 'common.nameAr', value: (r) => '  '.repeat(r.level - 1) + r.nameAr },
        { label: 'common.nameEn', value: (r) => '  '.repeat(r.level - 1) + r.nameEn },
        { label: 'cc.parentCode', value: (r) => (r.parentId ? db.prepare('SELECT code FROM cost_centers WHERE id = ?').get(r.parentId).code : '') },
        { label: 'cc.type', value: (r) => (r.typeId ? typeRow(r.typeId).code : '') },
        { label: 'cc.branch', value: (r, t) => branchCode(r.branchId) || t('cc.allBranches') },
        { label: 'account.kind', value: (r, t) => t(r.isGroup ? 'account.group' : 'account.detail') },
        { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
      ],
    });
    const types = createMasterService(services, {
      entity: 'cost_center_type', table: 'cost_center_types', source: 'cost-centers', titleKey: 'cc.types',
      columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en']],
      validate: (body, { partial }) => validator(body, { partial }).str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
        .str('nameAr', { required: true, max: 120 }).str('nameEn', { required: true, max: 120 }).done(),
      toApi: (r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, isActive: r.is_active === 1 }),
      exportColumns: [{ label: 'cc.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn }],
    });
    services.costCenters = centers;
    services.usage.register('cost_center_type', 'cost-centers', (d, id) => !!d.prepare('SELECT 1 FROM cost_centers WHERE type_id = ? LIMIT 1').get(id));

    // تقرير أساسي: الأعداد حسب النوع والفرع والحالة (ضمن نطاق المستخدم)
    router.get('/api/cost-centers/summary', { permission: 'cost_centers.view' }, (ctx) => {
      const ids = ctx.access.allBranches ? null : ctx.access.branchIds();
      const scope = ids ? `WHERE (c.branch_id IS NULL${ids.length ? ` OR c.branch_id IN (${ids.map(() => '?').join(',')})` : ''})` : '';
      return {
        byType: db.prepare(`SELECT t.id typeId, t.code, t.name_ar nameAr, t.name_en nameEn, count(c.id) total, sum(c.is_active) active
          FROM cost_centers c LEFT JOIN cost_center_types t ON t.id = c.type_id ${scope} GROUP BY t.id ORDER BY t.code`).all(...(ids || [])),
        byBranch: db.prepare(`SELECT b.id branchId, b.code, b.name_ar nameAr, b.name_en nameEn, count(c.id) total, sum(c.is_active) active
          FROM cost_centers c LEFT JOIN branches b ON b.id = c.branch_id ${scope} GROUP BY b.id ORDER BY b.code`).all(...(ids || [])),
      };
    });
    registerMasterRoutes(router, centers, { base: '/api/cost-centers', resource: 'cost_centers', tree: true, exportFile: 'cost-centers' });
    registerMasterRoutes(router, types, { base: '/api/cost-center-types', resource: 'cost_centers', exportFile: 'cost-center-types' });

    registerImportRoutes(router, {
      base: '/api/cost-centers', resource: 'cost_centers', fileName: 'cost-centers',
      columns: [
        { key: 'code', aliases: ['كود المركز', 'الكود'], required: true },
        { key: 'name_ar', aliases: ['الاسم العربي'], required: true },
        { key: 'name_en', aliases: ['الاسم الإنجليزي'], required: true },
        { key: 'parent_code', aliases: ['كود المركز الأب', 'كود الأب'] },
        { key: 'type', aliases: ['النوع'] },
        { key: 'branch_code', aliases: ['كود الفرع', 'الفرع'] },
        { key: 'is_group', aliases: ['تجميعي'] },
        { key: 'description', aliases: ['الوصف'] },
      ],
      validate(ctx, rows) {
        const items = rows.map(({ line, values: v }) => {
          const errors = [];
          const parsed = fieldErrors(() => validator({ code: v.code, nameAr: v.name_ar, nameEn: v.name_en, description: v.description || undefined })
            .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 }).str('nameAr', { required: true, max: 200 })
            .str('nameEn', { required: true, max: 200 }).str('description', { max: 500 }).done());
          errors.push(...parsed.errors);
          let typeId = null;
          if (v.type) { const t = db.prepare('SELECT id FROM cost_center_types WHERE code = ?').get(v.type.toUpperCase()); if (t) typeId = t.id; else errors.push({ field: 'type', code: 'NOT_FOUND' }); }
          let branchId = null;
          if (v.branch_code) {
            const b = db.prepare('SELECT id FROM branches WHERE code = ?').get(v.branch_code.toUpperCase());
            if (!b) errors.push({ field: 'branch_code', code: 'NOT_FOUND' });
            else if (!ctx.access.branchAllowed(b.id)) errors.push({ field: 'branch_code', code: 'BRANCH_FORBIDDEN' });
            else branchId = b.id;
          } else if (!ctx.access.allBranches) errors.push({ field: 'branch_code', code: 'REQUIRED' });
          const isGroup = parseBool(v.is_group);
          if (isGroup === undefined) errors.push({ field: 'is_group', code: 'INVALID' });
          const data = parsed.value ? { ...parsed.value, typeId, branchId, isGroup: !!isGroup } : null;
          return { line, values: v, data, errors, code: data ? data.code : String(v.code || '').toUpperCase(), parentCode: String(v.parent_code || '').toUpperCase() || null, isGroup };
        });
        return checkTree(db, 'cost_centers', items, (it) => {
          if (!it.data) return;
          const pb = it.parentRow ? it.parentRow.branch_id : (it.parentItem && it.parentItem.data ? it.parentItem.data.branchId : null);
          if (pb != null && it.data.branchId != null && it.data.branchId !== pb) it.errors.push({ field: 'branch_code', code: 'BRANCH_MISMATCH' });
        });
      },
      commit(ctx, items) {
        const ids = new Map();
        for (const it of items) {
          const parentId = it.parentItem ? ids.get(it.parentItem.code) : (it.parentRow ? it.parentRow.id : null);
          const body = { code: it.data.code, nameAr: it.data.nameAr, nameEn: it.data.nameEn, parentId, isGroup: it.data.isGroup };
          if (it.data.typeId) body.typeId = it.data.typeId;
          if (it.data.branchId) body.branchId = it.data.branchId;
          if (it.data.description) body.description = it.data.description;
          ids.set(it.data.code, centers.create(ctx, body).id);
        }
        return items.length;
      },
    });
  },
};

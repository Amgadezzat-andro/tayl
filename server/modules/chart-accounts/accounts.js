'use strict';
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { createMasterService } = require('../../core/master');

const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;
const CLASSES = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];

function createAccountService(services) {
  const { db } = services;
  const classRow = (code) => db.prepare('SELECT * FROM account_classes WHERE code = ?').get(code);
  const typeRow = (id) => db.prepare('SELECT * FROM account_types WHERE id = ?').get(id);

  const svc = createMasterService(services, {
    entity: 'account', table: 'accounts', source: 'chart-accounts', tree: true, titleKey: 'nav.accounts',
    columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['parentId', 'parent_id'], ['classCode', 'class_code'],
      ['typeId', 'type_id'], ['normalBalance', 'normal_balance'], ['isGroup', 'is_group'], ['sortOrder', 'sort_order'], ['description', 'description']],
    validate(body, { partial }) {
      const d = validator(body, { partial })
        .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
        .str('nameAr', { required: true, max: 200 })
        .str('nameEn', { required: true, max: 200 })
        .id('parentId')
        .oneOf('classCode', CLASSES)
        .id('typeId')
        .oneOf('normalBalance', ['debit', 'credit'])
        .bool('isGroup')
        .int('sortOrder', { min: 0, max: 1e9 })
        .str('description', { max: 500, multiline: true })
        .done();
      if ('isGroup' in d) d.isGroup = d.isGroup ? 1 : 0;
      return d;
    },
    /** التصنيف يُورَث من الأب ويجب أن يطابقه؛ النوع من نفس التصنيف؛ الطبيعة افتراضيًا من النوع ثم التصنيف. */
    beforeSave(ctx, d, before, parent) {
      const parentRow = parent || (before && before.parent_id != null ? db.prepare('SELECT * FROM accounts WHERE id = ?').get(before.parent_id) : null);
      const mismatch = () => new HttpError(409, 'CLASS_MISMATCH', 'تصنيف الحساب يجب أن يطابق تصنيف الحساب الأب');
      let cls;
      if (parentRow) {
        // حساب فرعي: تصنيفه هو تصنيف أبيه دائمًا (يُورَث عند الإنشاء، ويُرفض النقل تحت أب بتصنيف آخر)
        if (d.classCode && d.classCode !== parentRow.class_code) throw mismatch();
        if (before && !d.classCode && before.class_code !== parentRow.class_code) throw mismatch();
        cls = parentRow.class_code;
      } else {
        cls = d.classCode ?? (before ? before.class_code : null);
      }
      if (!cls) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { classCode: 'REQUIRED' } });
      if (before && cls !== before.class_code) {
        const kids = db.prepare('SELECT count(*) c FROM accounts WHERE parent_id = ?').get(before.id).c;
        if (kids) throw new HttpError(409, 'HAS_CHILDREN', 'لا يمكن تغيير تصنيف حساب له حسابات فرعية');
        if (services.usage.usedBy('account', before.id).length) throw new HttpError(409, 'IN_USE', 'لا يمكن تغيير تصنيف حساب مستخدم');
      }
      d.classCode = cls;
      const typeId = 'typeId' in d ? d.typeId : (before ? before.type_id : null);
      let type = null;
      if (typeId != null) {
        type = typeRow(typeId);
        if (!type) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { typeId: 'NOT_FOUND' } });
        if (type.class_code !== cls) throw new HttpError(409, 'TYPE_CLASS_MISMATCH', 'نوع الحساب لا يتبع نفس التصنيف');
        if (type.is_active !== 1 && (!before || before.type_id !== typeId)) throw new HttpError(409, 'TYPE_INACTIVE', 'نوع الحساب معطّل');
      }
      if (!before && !d.normalBalance) d.normalBalance = type ? type.normal_balance : classRow(cls).normal_balance;
      if (!before && d.isGroup == null) d.isGroup = 0;
    },
    toApi: (r) => ({
      id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, parentId: r.parent_id, level: r.level, classCode: r.class_code,
      typeId: r.type_id, normalBalance: r.normal_balance, isGroup: r.is_group === 1, isActive: r.is_active === 1, sortOrder: r.sort_order,
      description: r.description, createdAt: r.created_at, updatedAt: r.updated_at,
    }),
    filters: {
      classCode: (v) => (CLASSES.includes(v) ? { sql: 'class_code = ?', params: [v] } : null),
      isGroup: (v) => (v === '1' || v === '0' ? { sql: 'is_group = ?', params: [Number(v)] } : null),
    },
    lookupExtra: (r) => ({ classCode: r.class_code, normalBalance: r.normal_balance }),
    exportColumns: [
      { label: 'account.code', value: (r) => r.code },
      { label: 'account.nameAr', value: (r) => '  '.repeat(r.level - 1) + r.nameAr },
      { label: 'account.nameEn', value: (r) => '  '.repeat(r.level - 1) + r.nameEn },
      { label: 'account.parentCode', value: (r) => (r.parentId ? db.prepare('SELECT code FROM accounts WHERE id = ?').get(r.parentId).code : '') },
      { label: 'account.level', value: (r) => String(r.level) },
      { label: 'account.class', value: (r, t) => t('accClass.' + r.classCode) },
      { label: 'account.type', value: (r) => (r.typeId ? typeRow(r.typeId).code : '') },
      { label: 'account.nature', value: (r, t) => t('nature.' + r.normalBalance) },
      { label: 'account.kind', value: (r, t) => t(r.isGroup ? 'account.group' : 'account.detail') },
      { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
    ],
  });

  return {
    ...svc,
    classes: () => db.prepare('SELECT * FROM account_classes ORDER BY sort_order').all()
      .map((c) => ({ code: c.code, nameAr: c.name_ar, nameEn: c.name_en, normalBalance: c.normal_balance, statement: c.statement })),
    /** للوحدات القادمة: حساب تفصيلي نشط فقط (التجميعي لا يقبل حركات). */
    assertPostable: (id, ctx) => svc.assertUsable(id, ctx),
    CODE_RE, CLASSES,
  };
}

function createAccountTypeService(services) {
  return createMasterService(services, {
    entity: 'account_type', table: 'account_types', source: 'chart-accounts', titleKey: 'account.types',
    columns: [['code', 'code'], ['classCode', 'class_code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['normalBalance', 'normal_balance']],
    validate(body, { partial }) {
      return validator(body, { partial })
        .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
        .oneOf('classCode', CLASSES, { required: true })
        .str('nameAr', { required: true, max: 120 })
        .str('nameEn', { required: true, max: 120 })
        .oneOf('normalBalance', ['debit', 'credit'], { required: true })
        .done();
    },
    beforeSave(ctx, d, before) {
      if (before && 'classCode' in d && d.classCode !== before.class_code
        && services.db.prepare('SELECT 1 FROM accounts WHERE type_id = ? LIMIT 1').get(before.id)) {
        throw new HttpError(409, 'IN_USE', 'النوع مستخدم في حسابات؛ لا يمكن تغيير تصنيفه');
      }
    },
    toApi: (r) => ({ id: r.id, code: r.code, classCode: r.class_code, nameAr: r.name_ar, nameEn: r.name_en, normalBalance: r.normal_balance, isActive: r.is_active === 1 }),
    filters: { classCode: (v) => (CLASSES.includes(v) ? { sql: 'class_code = ?', params: [v] } : null) },
    orderBy: 'class_code, code',
    lookupExtra: (r) => ({ classCode: r.class_code, normalBalance: r.normal_balance }),
    exportColumns: [
      { label: 'account.code', value: (r) => r.code }, { label: 'account.class', value: (r, t) => t('accClass.' + r.classCode) },
      { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
      { label: 'account.nature', value: (r, t) => t('nature.' + r.normalBalance) },
    ],
  });
}

module.exports = { createAccountService, createAccountTypeService, CODE_RE, CLASSES };

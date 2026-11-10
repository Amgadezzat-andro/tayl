'use strict';
const path = require('node:path');
const { registerMasterRoutes, masterActions } = require('../../core/master');
const { registerImportRoutes, fieldErrors, parseBool, checkTree } = require('../../core/import');
const { normalize } = require('../../core/search');
const { validator } = require('../../core/validate');
const { createAccountService, createAccountTypeService, CLASSES } = require('./accounts');

/**
 * وحدة دليل الحسابات: شجرة الحسابات، التصنيفات الستة، الأنواع القابلة للتوسع، الاستيراد والتصدير والطباعة.
 * لا قيود ولا ترحيل في هذه المرحلة؛ الوحدات القادمة تستخدم services.accounts.assertPostable(id).
 */
const IMPORT_COLUMNS = [
  { key: 'code', aliases: ['كود الحساب', 'الكود', 'account code'], required: true },
  { key: 'name_ar', aliases: ['الاسم العربي', 'اسم الحساب بالعربية', 'arabic name'], required: true },
  { key: 'name_en', aliases: ['الاسم الإنجليزي', 'اسم الحساب بالإنجليزية', 'english name'], required: true },
  { key: 'parent_code', aliases: ['كود الحساب الأب', 'كود الأب', 'parent'] },
  { key: 'class', aliases: ['التصنيف', 'classification'] },
  { key: 'type', aliases: ['النوع', 'account type'] },
  { key: 'is_group', aliases: ['تجميعي', 'group'] },
  { key: 'normal_balance', aliases: ['الطبيعة', 'nature'] },
  { key: 'description', aliases: ['الوصف'] },
];

module.exports = {
  name: 'chart-accounts',
  version: '1.0.0',
  dependsOn: ['company-setup'],
  migrationsDir: path.join(__dirname, 'migrations'),

  register(router, services) {
    services.permissions.register('chart-accounts', [
      { resource: 'accounts', group: 'accounting', actions: masterActions(['import']) },
    ]);
    const accounts = createAccountService(services);
    const types = createAccountTypeService(services);
    services.accounts = accounts;
    services.accountTypes = types;
    // نوع الحساب مستخدم إذا ارتبط به حساب
    services.usage.register('account_type', 'accounts', (db, id) => !!db.prepare('SELECT 1 FROM accounts WHERE type_id = ? LIMIT 1').get(id));

    router.get('/api/accounts/classes', { permission: 'accounts.view' }, () => accounts.classes());
    registerMasterRoutes(router, accounts, {
      base: '/api/accounts', resource: 'accounts', tree: true, exportFile: 'chart-of-accounts',
      lookupPerms: ['treasury.create', 'treasury.update', 'journal.create', 'journal.update', 'ledger.view', 'year_end.settings'],   // [م3] سطور القيود والتقارير؛ [م4] حساب نتيجة السنة
    });
    registerMasterRoutes(router, types, { base: '/api/account-types', resource: 'accounts', exportFile: 'account-types' });

    const { db } = services;
    const classByName = (v) => {
      const n = normalize(v);
      if (!n) return null;
      const r = db.prepare('SELECT code FROM account_classes WHERE tayl_norm(code) = ? OR tayl_norm(name_ar) = ? OR tayl_norm(name_en) = ?').get(n, n, n);
      return r ? r.code : undefined;
    };
    const natureOf = (v) => ({ debit: 'debit', credit: 'credit', مدين: 'debit', داين: 'credit', دائن: 'credit' })[normalize(v)];

    registerImportRoutes(router, {
      base: '/api/accounts', resource: 'accounts', columns: IMPORT_COLUMNS, fileName: 'chart-of-accounts',
      validate(ctx, rows) {
        const items = rows.map(({ line, values: v }) => {
          const errors = [];
          const cls = classByName(v.class);
          if (cls === undefined) errors.push({ field: 'class', code: 'NOT_ALLOWED' });
          let typeId = null; let typeRow = null;
          if (v.type) {
            typeRow = db.prepare('SELECT * FROM account_types WHERE code = ?').get(v.type.toUpperCase());
            if (!typeRow) errors.push({ field: 'type', code: 'NOT_FOUND' }); else typeId = typeRow.id;
          }
          const isGroup = parseBool(v.is_group);
          if (isGroup === undefined) errors.push({ field: 'is_group', code: 'INVALID' });
          const nb = v.normal_balance ? natureOf(v.normal_balance) : null;
          if (v.normal_balance && !nb) errors.push({ field: 'normal_balance', code: 'NOT_ALLOWED' });
          const parsed = fieldErrors(() => validator({ code: v.code, nameAr: v.name_ar, nameEn: v.name_en, description: v.description || undefined })
            .str('code', { required: true, upper: true, pattern: accounts.CODE_RE, max: 30 })
            .str('nameAr', { required: true, max: 200 }).str('nameEn', { required: true, max: 200 })
            .str('description', { max: 500 }).done());
          errors.push(...parsed.errors);
          const data = parsed.value ? { ...parsed.value, classCode: cls || null, typeId, isGroup: !!isGroup, normalBalance: nb } : null;
          return { line, values: v, data, errors, code: data ? data.code : String(v.code || '').toUpperCase(), parentCode: String(v.parent_code || '').toUpperCase() || null, isGroup, typeRow };
        });
        return checkTree(db, 'accounts', items, (it) => {
          // التصنيف: يُورَث من الأب إن لم يُذكر، ويجب أن يطابقه إن ذُكر؛ والجذر يتطلب تصنيفًا
          let p = it;
          const seen = new Set([it]);   // الدورات في الملف مُبلّغ عنها في checkTree؛ هنا نمنع الحلقة اللانهائية فقط
          while (p.parentItem && !seen.has(p.parentItem)) { p = p.parentItem; seen.add(p); }
          const parentClass = it.parentRow ? it.parentRow.class_code : (it.parentItem ? (p.parentRow ? p.parentRow.class_code : (p.data && p.data.classCode)) : null);
          if (!it.data) return;
          if (!it.parentCode && !it.data.classCode) it.errors.push({ field: 'class', code: 'REQUIRED' });
          if (parentClass && it.data.classCode && it.data.classCode !== parentClass) it.errors.push({ field: 'class', code: 'CLASS_MISMATCH' });
          const cls = it.data.classCode || parentClass;
          if (it.typeRow && cls && it.typeRow.class_code !== cls) it.errors.push({ field: 'type', code: 'TYPE_CLASS_MISMATCH' });
        });
      },
      commit(ctx, items) {
        const ids = new Map();
        for (const it of items) {
          const parentId = it.parentItem ? ids.get(it.parentItem.code) : (it.parentRow ? it.parentRow.id : null);
          const body = { code: it.data.code, nameAr: it.data.nameAr, nameEn: it.data.nameEn, parentId, isGroup: it.data.isGroup };
          if (it.data.classCode) body.classCode = it.data.classCode;
          if (it.data.typeId) body.typeId = it.data.typeId;
          if (it.data.normalBalance) body.normalBalance = it.data.normalBalance;
          if (it.data.description) body.description = it.data.description;
          ids.set(it.data.code, accounts.create(ctx, body).id);
        }
        return items.length;
      },
    });
    services.accountClasses = CLASSES;
  },
};

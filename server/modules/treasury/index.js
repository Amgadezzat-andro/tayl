'use strict';
const path = require('node:path');
const { HttpError } = require('../../core/errors');
const { validator } = require('../../core/validate');
const { createMasterService, registerMasterRoutes, masterActions } = require('../../core/master');

/**
 * الخزائن والحسابات البنكية (تعريف فقط).
 *  - كل خزينة تتبع فرعًا (نطاق الفروع يُفرض على القراءة والكتابة).
 *  - رقم الحساب و IBAN بيانات حساسة: مقنّعة لمن لا يملك treasury.view_sensitive (في العرض والتصدير والتدقيق).
 *  - الحساب المحاسبي المرتبط يجب أن يكون تفصيليًا نشطًا من الأصول.
 *  - للمراحل القادمة: services.treasuries.assertUsable(id, ctx).
 */
const CODE_RE = /^[A-Z0-9][A-Z0-9._-]{0,29}$/;

/** IBAN: الشكل + رقم التحقق mod-97 (ISO 13616). */
function validIban(s) {
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(s)) return false;
  const re = (s.slice(4) + s.slice(0, 4)).replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));
  let r = 0;
  for (const ch of re) r = (r * 10 + (ch.charCodeAt(0) - 48)) % 97;
  return r === 1;
}

module.exports = {
  name: 'treasury',
  version: '1.0.0',
  dependsOn: ['company-setup', 'chart-accounts', 'currencies'],
  migrationsDir: path.join(__dirname, 'migrations'),
  validIban,

  register(router, services) {
    const { db } = services;
    services.permissions.register('treasury', [
      { resource: 'treasury', group: 'accounting', actions: masterActions(), special: ['view_sensitive'] },
    ]);
    const cur = (id) => db.prepare('SELECT * FROM currencies WHERE id = ?').get(id);
    const acc = (id) => db.prepare('SELECT * FROM accounts WHERE id = ?').get(id);

    const svc = createMasterService(services, {
      entity: 'treasury', table: 'treasuries', source: 'treasury', titleKey: 'nav.treasury',
      scope: { api: 'branchId', col: 'branch_id', nullable: false },
      sensitive: { perm: 'treasury.view_sensitive', fields: ['accountNumber', 'iban'] },
      usableCol: 'is_usable',
      columns: [['code', 'code'], ['nameAr', 'name_ar'], ['nameEn', 'name_en'], ['kind', 'kind'], ['branchId', 'branch_id'], ['currencyId', 'currency_id'],
        ['bankName', 'bank_name'], ['accountNumber', 'account_number'], ['iban', 'iban'], ['accountId', 'account_id'], ['isUsable', 'is_usable'], ['description', 'description']],
      validate(body, { partial }) {
        const d = validator(body, { partial })
          .str('code', { required: true, upper: true, pattern: CODE_RE, max: 30 })
          .str('nameAr', { required: true, max: 200 }).str('nameEn', { required: true, max: 200 })
          .oneOf('kind', ['cash', 'bank'], { required: true })
          .id('branchId', { required: true }).id('currencyId', { required: true })
          .str('bankName', { max: 120 })
          .str('accountNumber', { max: 34, pattern: /^[0-9A-Za-z -]{4,34}$/ })
          .str('iban', { max: 42 })
          .id('accountId').bool('isUsable').str('description', { max: 500, multiline: true })
          .done();
        if (d.iban) {
          d.iban = d.iban.replace(/\s+/g, '').toUpperCase();
          if (!validIban(d.iban)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { iban: 'INVALID_IBAN' } });
        }
        if ('isUsable' in d) d.isUsable = d.isUsable ? 1 : 0;
        return d;
      },
      beforeSave(ctx, d, before) {
        const kind = d.kind ?? before?.kind;
        if (kind === 'cash') {
          for (const f of ['bankName', 'accountNumber', 'iban']) {
            if (d[f]) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [f]: 'CASH_NO_BANK_DATA' } });
            if (before && before.kind === 'bank') d[f] = null;   // التحويل من بنك إلى خزينة يمسح بيانات البنك
          }
        } else if (!(d.bankName ?? before?.bank_name)) {
          throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { bankName: 'REQUIRED' } });
        }
        if (before && 'kind' in d && d.kind !== before.kind && services.usage.usedBy('treasury', before.id).length) {
          throw new HttpError(409, 'IN_USE', 'لا يمكن تغيير نوع خزينة مستخدمة');
        }
        if ('currencyId' in d && (!before || d.currencyId !== before.currency_id)) {
          const c = cur(d.currencyId);
          if (!c) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { currencyId: 'NOT_FOUND' } });
          if (c.is_active !== 1) throw new HttpError(409, 'CURRENCY_INACTIVE', 'العملة معطّلة');
          if (before && services.usage.usedBy('treasury', before.id).length) throw new HttpError(409, 'IN_USE', 'لا يمكن تغيير عملة خزينة مستخدمة');
        }
        if ('branchId' in d && (!before || d.branchId !== before.branch_id)) {
          if (!services.branches.isActive(d.branchId)) throw new HttpError(409, 'BRANCH_INACTIVE', 'الفرع معطّل');
        }
        if ('accountId' in d && d.accountId != null && (!before || d.accountId !== before.account_id)) {
          // لا يُربط إلا حساب تفصيلي نشط (التجميعي لا يقبل حركات) من الأصول
          services.accounts.assertPostable(d.accountId);
          if (acc(d.accountId).class_code !== 'asset') throw new HttpError(409, 'ACCOUNT_NOT_ASSET', 'حساب الخزينة يجب أن يكون من الأصول');
        }
      },
      toApi: (r) => ({
        id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, kind: r.kind, branchId: r.branch_id, currencyId: r.currency_id,
        currencyCode: (cur(r.currency_id) || {}).code, bankName: r.bank_name, accountNumber: r.account_number, iban: r.iban,
        accountId: r.account_id, accountCode: r.account_id ? (acc(r.account_id) || {}).code : null,
        isActive: r.is_active === 1, isUsable: r.is_usable === 1, description: r.description, createdAt: r.created_at, updatedAt: r.updated_at,
      }),
      filters: {
        kind: (v) => (['cash', 'bank'].includes(v) ? { sql: 'kind = ?', params: [v] } : null),
        branchId: (v) => (/^\d+$/.test(v) ? { sql: 'branch_id = ?', params: [Number(v)] } : null),
        currencyId: (v) => (/^\d+$/.test(v) ? { sql: 'currency_id = ?', params: [Number(v)] } : null),
      },
      lookupExtra: (r) => ({ kind: r.kind, branchId: r.branch_id, currencyCode: (cur(r.currency_id) || {}).code }),
      extraUsable(r) {
        const c = cur(r.currency_id);
        if (!c || c.is_active !== 1) throw new HttpError(409, 'NOT_USABLE', 'عملة الخزينة معطّلة', { reason: 'CURRENCY_INACTIVE' });
        if (!services.branches.isActive(r.branch_id)) throw new HttpError(409, 'NOT_USABLE', 'فرع الخزينة معطّل', { reason: 'BRANCH_INACTIVE' });
      },
      exportColumns: [
        { label: 'treasury.code', value: (r) => r.code }, { label: 'common.nameAr', value: (r) => r.nameAr }, { label: 'common.nameEn', value: (r) => r.nameEn },
        { label: 'treasury.kind', value: (r, t) => t('treasury.kind.' + r.kind) },
        { label: 'treasury.branch', value: (r) => (db.prepare('SELECT code FROM branches WHERE id = ?').get(r.branchId) || {}).code },
        { label: 'treasury.currency', value: (r) => r.currencyCode }, { label: 'treasury.bankName', value: (r) => r.bankName },
        { label: 'treasury.accountNumber', value: (r) => r.accountNumber }, { label: 'treasury.iban', value: (r) => r.iban },
        { label: 'treasury.account', value: (r) => r.accountCode },
        { label: 'treasury.usable', value: (r, t) => t(r.isUsable ? 'common.yes' : 'common.no') },
        { label: 'common.status', value: (r, t) => t(r.isActive ? 'common.active' : 'common.inactive') },
      ],
    });
    services.treasuries = svc;
    services.usage.register('account', 'treasury', (d, id) => !!d.prepare('SELECT 1 FROM treasuries WHERE account_id = ? LIMIT 1').get(id));
    services.usage.register('currency', 'treasury', (d, id) => !!d.prepare('SELECT 1 FROM treasuries WHERE currency_id = ? LIMIT 1').get(id));
    registerMasterRoutes(router, svc, { base: '/api/treasuries', resource: 'treasury', exportFile: 'treasuries' });
  },
};

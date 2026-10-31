'use strict';
/* الخزائن والحسابات البنكية (تعريف فقط). البيانات البنكية تظهر مقنّعة لمن لا يملك صلاحيتها. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.treasury = (() => {
  const { el, t, badge, name } = TAYL.ui;
  return TAYL.masterView({
    key: 'nav.treasury', resource: 'treasury', base: '/api/treasuries', exportName: 'treasuries',
    addKey: 'treasury.add', editKey: 'treasury.edit', intro: 'treasury.intro',
    columns: [
      { label: 'treasury.code', render: (r) => el('code', { dir: 'ltr', text: r.code }), sortValue: (r) => r.code },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'treasury.kind', render: (r) => t('treasury.kind.' + r.kind) },
      { label: 'treasury.branch', render: (r) => TAYL.fields.branchName(TAYL.app, r.branchId) },
      { label: 'treasury.currency', render: (r) => el('span', { dir: 'ltr', text: r.currencyCode }) },
      { label: 'treasury.iban', render: (r) => el('span', { dir: 'ltr', text: r.iban || r.accountNumber || '' }) },
      { label: 'treasury.account', render: (r) => el('span', { dir: 'ltr', text: r.accountCode || '' }) },
      { label: 'treasury.usable', render: (r) => badge(r.isUsable ? 'common.yes' : 'common.no', r.isUsable ? 'ok' : 'muted') },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    filters: [
      { name: 'kind', label: 'treasury.kind', options: () => ['cash', 'bank'].map((k) => ({ value: k, label: t('treasury.kind.' + k) })) },
      { name: 'branchId', label: 'treasury.branch', options: () => TAYL.app.session.branches.map((b) => ({ value: String(b.id), label: b.code })) },
    ],
    fields(row, app) {
      const sens = !row || row.sensitiveVisible !== false;
      const isBank = (v) => v.kind === 'bank';
      return [
        TAYL.fields.code(row), ...TAYL.fields.names(row),
        { name: 'kind', label: 'treasury.kind', type: 'select', required: true, value: row ? row.kind : 'cash', options: ['cash', 'bank'].map((k) => ({ value: k, label: t('treasury.kind.' + k) })) },
        { name: 'branchId', label: 'treasury.branch', type: 'select', numeric: true, required: true, value: row ? String(row.branchId) : String((app.session.branch || {}).id || ''),
          options: app.session.branches.map((b) => ({ value: String(b.id), label: `${b.code} — ${name(b)}` })) },
        { name: 'currencyId', label: 'treasury.currency', type: 'combobox', required: true, source: TAYL.combobox.lookupSource('/api/currencies', 'usable=1'),
          value: row ? { id: row.currencyId, label: row.currencyCode } : null },
        { name: 'bankName', label: 'treasury.bankName', showIf: isBank, value: row && row.bankName, maxlength: 120 },
        { name: 'accountNumber', label: 'treasury.accountNumber', showIf: isBank, dir: 'ltr', value: row && row.accountNumber, disabled: !sens, skip: !sens, hint: sens ? null : 'treasury.sensitiveHidden', maxlength: 34 },
        { name: 'iban', label: 'treasury.iban', showIf: isBank, dir: 'ltr', value: row && row.iban, disabled: !sens, skip: !sens, hint: sens ? 'treasury.ibanHint' : 'treasury.sensitiveHidden', maxlength: 42 },
        { name: 'accountId', label: 'treasury.account', type: 'combobox', source: TAYL.combobox.lookupSource('/api/accounts', 'usable=1&classCode=asset'),
          value: row && row.accountId ? { id: row.accountId, label: row.accountCode } : null, hint: 'treasury.accountHint' },
        { name: 'isUsable', label: 'treasury.usable', type: 'checkbox', value: row ? row.isUsable : true, hint: 'treasury.usableHint' },
        TAYL.fields.description(row),
      ];
    },
    toBody(v) {
      const b = { ...v };
      if (b.kind === 'cash') { delete b.bankName; delete b.accountNumber; delete b.iban; }
      for (const k of ['bankName', 'accountNumber', 'iban']) if (b[k] === '') b[k] = null;
      return b;
    },
  });
})();

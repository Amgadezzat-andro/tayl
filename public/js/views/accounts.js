'use strict';
/* دليل الحسابات: شجرة هرمية بالتصنيفات الستة والأنواع، استيراد/تصدير/طباعة. لا قيود في هذه المرحلة. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, badge, name } = TAYL.ui;
  const CLASSES = ['asset', 'liability', 'equity', 'revenue', 'cogs', 'expense'];
  let types = [];
  const loadTypes = async () => { try { types = (await TAYL.api.get('/api/account-types?limit=500')).items; } catch { types = []; } };
  const typeCode = (id) => (types.find((x) => x.id === id) || {}).code || '';

  const view = TAYL.masterView({
    key: 'nav.accounts', resource: 'accounts', base: '/api/accounts', tree: true, importable: true, exportName: 'chart-of-accounts',
    addKey: 'account.add', editKey: 'account.edit', importKey: 'account.import', intro: 'account.intro',
    columns: [
      { label: 'account.code', render: (r) => el('code', { dir: 'ltr', text: r.code }) },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'account.class', render: (r) => t('accClass.' + r.classCode), sortValue: (r) => r.classCode },
      { label: 'account.type', render: (r) => el('span', { dir: 'ltr', text: typeCode(r.typeId) }) },
      { label: 'account.kind', render: (r) => badge(r.isGroup ? 'account.group' : 'account.detail', r.isGroup ? 'gold' : '') },
      { label: 'account.nature', render: (r) => t('nature.' + r.normalBalance) },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    filters: [
      { name: 'classCode', label: 'account.class', options: () => CLASSES.map((c) => ({ value: c, label: t('accClass.' + c) })) },
      { name: 'isGroup', label: 'account.kind', options: () => [{ value: '1', label: t('account.group') }, { value: '0', label: t('account.detail') }] },
    ],
    treeFilter: (r, f) => (!f.classCode || r.classCode === f.classCode) && (!f.isGroup || String(Number(r.isGroup)) === f.isGroup),
    fields(row, app, rows) {
      const parent = row && row.parentId ? rows.get(row.parentId) : null;
      return [
        TAYL.fields.code(row),
        ...TAYL.fields.names(row),
        { name: 'parentId', label: 'account.parent', type: 'combobox', source: TAYL.combobox.lookupSource('/api/accounts', 'groups=1&active=1'),
          value: parent ? { id: parent.id, label: `${parent.code} — ${name(parent)}` } : (row && row.parentId ? { id: row.parentId, label: '#' + row.parentId } : null), hint: 'account.parentHint' },
        { name: 'classCode', label: 'account.class', type: 'select', value: row ? row.classCode : 'asset', showIf: (v) => !v.parentId,
          options: CLASSES.map((c) => ({ value: c, label: t('accClass.' + c) })), hint: 'account.classHint' },
        { name: 'typeId', label: 'account.type', type: 'select', numeric: true, value: row && row.typeId != null ? String(row.typeId) : '',
          options: [{ value: '', label: t('common.none') }, ...types.filter((x) => x.isActive || (row && x.id === row.typeId)).map((x) => ({ value: String(x.id), label: `${x.code} — ${name(x)} (${t('accClass.' + x.classCode)})` }))] },
        { name: 'isGroup', label: 'account.isGroup', type: 'checkbox', value: row ? row.isGroup : false, hint: 'account.isGroupHint' },
        { name: 'normalBalance', label: 'account.nature', type: 'select', value: row ? row.normalBalance : '',
          options: [{ value: '', label: t('account.natureAuto') }, { value: 'debit', label: t('nature.debit') }, { value: 'credit', label: t('nature.credit') }] },
        TAYL.fields.description(row),
      ];
    },
    toBody(v, row) {
      const b = { ...v };
      if (b.parentId) delete b.classCode;
      if (!b.normalBalance) delete b.normalBalance;
      if (!row && b.typeId == null) delete b.typeId;
      return b;
    },
    top: (app, reload) => el('div', { class: 'page-actions' },
      TAYL.ui.button('account.types', () => TAYL.typesDialog({
        base: '/api/account-types', titleKey: 'account.types', resource: 'accounts', app, onChange: async () => { await loadTypes(); reload(); },
        columns: [
          { label: 'common.code', render: (r) => el('code', { dir: 'ltr', text: r.code }) }, { label: 'common.name', render: (r) => name(r) },
          { label: 'account.class', render: (r) => t('accClass.' + r.classCode) }, { label: 'account.nature', render: (r) => t('nature.' + r.normalBalance) },
        ],
        fields: (row) => [TAYL.fields.code(row), ...TAYL.fields.names(row, 120),
          { name: 'classCode', label: 'account.class', type: 'select', value: row ? row.classCode : 'asset', options: CLASSES.map((c) => ({ value: c, label: t('accClass.' + c) })) },
          { name: 'normalBalance', label: 'account.nature', type: 'select', value: row ? row.normalBalance : 'debit', options: [{ value: 'debit', label: t('nature.debit') }, { value: 'credit', label: t('nature.credit') }] }],
      }), 'btn small')),
  });
  TAYL.views.accounts = { ...view, render: async (root, app) => { await loadTypes(); return view.render(root, app); } };
})();

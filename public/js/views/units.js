'use strict';
/* قاموس وحدات القياس العامة — بلا معاملات تحويل (خاصة بكل صنف في مرحلة الأصناف). */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.units = (() => {
  const { el, t, badge, name } = TAYL.ui;
  const CATS = ['count', 'weight', 'length', 'volume', 'area', 'time', 'other'];
  return TAYL.masterView({
    key: 'nav.units', resource: 'units', base: '/api/units', importable: true, exportName: 'units',
    addKey: 'unit.add', editKey: 'unit.edit', importKey: 'unit.import', intro: 'unit.intro',
    columns: [
      { label: 'unit.code', render: (r) => el('code', { dir: 'ltr', text: r.code }), sortValue: (r) => r.code },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'unit.symbol', render: (r) => el('span', { dir: 'ltr', text: r.symbol || '' }) },
      { label: 'unit.category', render: (r) => t('unit.cat.' + r.category) },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    filters: [{ name: 'category', label: 'unit.category', options: () => CATS.map((c) => ({ value: c, label: t('unit.cat.' + c) })) }],
    fields: (row) => [
      TAYL.fields.code(row, 20), ...TAYL.fields.names(row, 60),
      { name: 'symbol', label: 'unit.symbol', dir: 'ltr', value: row && row.symbol, maxlength: 12 },
      { name: 'category', label: 'unit.category', type: 'select', required: true, value: row ? row.category : 'count', options: CATS.map((c) => ({ value: c, label: t('unit.cat.' + c) })) },
      TAYL.fields.description(row),
    ],
    toBody(v) { const b = { ...v }; if (b.symbol === '') b.symbol = null; return b; },
  });
})();

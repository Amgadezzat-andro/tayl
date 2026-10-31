'use strict';
/* العملات وأسعار الصرف التاريخية. الأسعار نصوص عشرية تُحسب وتُخزَّن بالمحرك المركزي على الخادم فقط. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.currencies = (() => {
  const { el, t, badge, name, modal, form, toast, button, errorText, fill, confirm, dateTime } = TAYL.ui;
  let iso = null;

  async function ratesDialog(cur, app) {
    const can = app.can('currencies.manage_rates');
    const list = el('div');
    async function load() {
      const rows = await TAYL.api.get(`/api/currencies/${cur.id}/rates`);
      fill(list, TAYL.grid.create({
        rows, emptyKey: 'currency.noRates',
        columns: [
          { label: 'currency.effectiveDate', render: (r) => el('span', { dir: 'ltr', text: r.effectiveDate }), sortValue: (r) => r.effectiveDate },
          { label: 'currency.rateType', render: (r) => t('currency.rate.' + r.rateType) },
          { label: 'currency.rate', render: (r) => el('span', { dir: 'ltr', class: 'num', text: r.rate }) },
          { label: 'currency.note', render: (r) => r.note || '' },
          { label: 'common.created', render: (r) => dateTime(r.createdAt) },
          { label: 'common.actions', cls: 'actions', sortable: false, render: (r) => (can ? button('common.delete', async () => {
            if (!(await confirm(t('currency.confirmDeleteRate', { date: r.effectiveDate }), { danger: true, okKey: 'common.delete' }))) return;
            try { await TAYL.api.del('/api/currencies/rates/' + r.id); toast(t('common.deleted')); load(); } catch (e) { toast(errorText(e), 'bad'); }
          }, 'btn small danger') : null) },
        ],
      }).node);
    }
    const f = can ? form({
      submitKey: 'currency.addRate',
      fields: [
        { name: 'rateType', label: 'currency.rateType', type: 'select', value: 'average', options: ['average', 'buy', 'sell'].map((x) => ({ value: x, label: t('currency.rate.' + x) })) },
        { name: 'effectiveDate', label: 'currency.effectiveDate', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
        { name: 'rate', label: 'currency.rate', required: true, dir: 'ltr', inputmode: 'decimal', hint: 'currency.rateHint', maxlength: 40 },
        { name: 'note', label: 'currency.note', maxlength: 300 },
      ],
      async onSubmit(v) { await TAYL.api.post(`/api/currencies/${cur.id}/rates`, { ...v, rate: v.rate.trim(), note: v.note || undefined }); toast(t('common.saved')); f.inputs.rate.input.value = ''; load(); },
    }) : null;
    modal({ title: `${t('currency.rates')} — ${cur.code}`, wide: true,
      body: el('div', null, el('p', { class: 'muted', text: t('currency.ratesIntro') }), list, f ? el('div', null, el('h3', { class: 'form-section', text: t('currency.addRate') }), f.node) : null) });
    await load();
  }

  return TAYL.masterView({
    key: 'nav.currencies', resource: 'currencies', base: '/api/currencies', exportName: 'currencies',
    addKey: 'currency.add', editKey: 'currency.edit', intro: 'currency.intro',
    protect: (r) => r.isBase,
    columns: [
      { label: 'currency.code', render: (r) => el('code', { dir: 'ltr', text: r.code }), sortValue: (r) => r.code },
      { label: 'common.name', render: (r) => [name(r), r.isBase ? badge('currency.isBase', 'gold') : null] },
      { label: 'currency.symbol', render: (r) => r.symbol || '' },
      { label: 'currency.displayDecimals', render: (r) => String(r.displayDecimals), sortValue: (r) => r.displayDecimals },
      { label: 'currency.rate.average', render: (r) => (r.latestRates.average ? el('span', { dir: 'ltr', text: `${r.latestRates.average.rate} (${r.latestRates.average.effectiveDate})` }) : (r.isBase ? '1' : '—')) },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    rowActions: (r, app) => (!r.isBase ? button('currency.rates', () => ratesDialog(r, app), 'btn small') : null),
    fields(row) {
      const fields = [
        { ...TAYL.fields.code(row, 3), hint: 'currency.codeHint', disabled: row && row.isBase,
          onChange: async (input) => {
            if (row) return;
            if (!iso) { try { iso = await TAYL.api.get('/api/currencies/iso'); } catch { iso = []; } }
            const hit = iso.find((x) => x.code === input.value.trim().toUpperCase());
            const fm = input.closest('form');
            if (!hit || !fm) return;
            const set = (n, v) => { const i = fm.querySelector(`[name="${n}"]`); if (i && !i.value) i.value = v; };
            set('nameAr', hit.nameAr); set('nameEn', hit.nameEn); set('symbol', hit.symbol);
            const d = fm.querySelector('[name="displayDecimals"]'); if (d) d.value = String(Math.min(hit.minor, 8));
          } },
        ...TAYL.fields.names(row, 120),
        { name: 'symbol', label: 'currency.symbol', value: row && row.symbol, maxlength: 8 },
        { name: 'displayDecimals', label: 'currency.displayDecimals', type: 'number', required: true, min: 0, max: 8, value: row ? row.displayDecimals : 2, hint: 'currency.decimalsHint' },
      ];
      return fields;
    },
    toBody(v, row) { const b = { ...v }; if (row && row.isBase) delete b.code; if (b.symbol === '') b.symbol = null; return b; },
  });
})();

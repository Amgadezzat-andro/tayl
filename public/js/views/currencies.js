'use strict';
/* العملات وأسعار الصرف التاريخية. الأسعار نصوص عشرية تُحسب وتُخزَّن بالمحرك المركزي على الخادم فقط. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.currencies = (() => {
  const { el, t, badge, name, modal, form, toast, button, fill, dateTime } = TAYL.ui;
  let iso = null;

  // تصحيح سعر أو إلغاؤه: سطر جديد بسبب إلزامي، والسطر السابق يبقى في السجل (لا حذف)
  function reviseDialog(cur, r, op, reload) {
    const fields = op === 'correct'
      ? [{ name: 'rate', label: 'currency.newRate', required: true, dir: 'ltr', inputmode: 'decimal', hint: 'currency.rateHint', maxlength: 40 },
        { name: 'reason', label: 'currency.reason', type: 'textarea', required: true, full: true, hint: 'currency.reasonHint' }]
      : [{ name: 'reason', label: 'currency.reason', type: 'textarea', required: true, full: true, hint: 'currency.voidHint' }];
    const f = form({
      submitKey: 'currency.op.' + op, fields,
      async onSubmit(v) {
        await TAYL.api.post(`/api/currencies/rates/${r.id}/${op}`, op === 'correct' ? { rate: v.rate.trim(), reason: v.reason } : { reason: v.reason });
        toast(t('common.saved')); reload();
      },
    });
    modal({ title: `${t('currency.op.' + op)} — ${cur.code} ${r.effectiveDate} (${t('currency.rate.' + r.rateType)})`,
      body: el('div', null, r.rate ? el('p', { class: 'muted', text: t('currency.currentRate', { rate: r.rate }) }) : null, f.node) });
  }

  async function historyDialog(cur, r, back) {
    const rows = await TAYL.api.get(`/api/currencies/rates/${r.id}/history`);
    modal({ title: `${t('currency.history')} — ${cur.code} ${r.effectiveDate} (${t('currency.rate.' + r.rateType)})`, wide: true,
      body: el('div', null, TAYL.grid.create({
        rows, emptyKey: 'currency.noRates',
        columns: [
          { label: 'common.created', render: (x) => dateTime(x.createdAt) },
          { label: 'currency.entryKind', render: (x) => t('currency.kind.' + x.kind) },
          { label: 'currency.rate', render: (x) => el('span', { dir: 'ltr', class: 'num', text: x.rate || '—' }) },
          { label: 'currency.reason', render: (x) => x.reason || '' },
          { label: 'common.status', render: (x) => statusBadge(x) },
        ],
      }).node, el('p', null, button('currency.backToRates', back, 'btn'))) });
  }

  const statusBadge = (r) => badge('currency.status.' + r.status, { current: 'ok', void: 'bad', superseded: 'muted' }[r.status]);

  async function ratesDialog(cur, app) {
    const can = app.can('currencies.manage_rates');
    const list = el('div');
    const reopen = () => ratesDialog(cur, app);
    async function load() {
      const rows = await TAYL.api.get(`/api/currencies/${cur.id}/rates`);
      fill(list, TAYL.grid.create({
        rows, emptyKey: 'currency.noRates',
        columns: [
          { label: 'currency.effectiveDate', render: (r) => el('span', { dir: 'ltr', text: r.effectiveDate }), sortValue: (r) => r.effectiveDate },
          { label: 'currency.rateType', render: (r) => t('currency.rate.' + r.rateType) },
          { label: 'currency.rate', render: (r) => el('span', { dir: 'ltr', class: 'num', text: r.rate || '—' }) },
          { label: 'common.status', render: (r) => [statusBadge(r), r.hasHistory ? ' ' : null, r.hasHistory ? badge('currency.corrected', 'gold') : null] },
          { label: 'currency.note', render: (r) => r.reason || r.note || '' },
          { label: 'common.created', render: (r) => dateTime(r.createdAt) },
          { label: 'common.actions', cls: 'actions', sortable: false, render: (r) => [
            can ? button('currency.op.correct', () => reviseDialog(cur, r, 'correct', reopen), 'btn small') : null,
            can && r.status === 'current' ? button('currency.op.void', () => reviseDialog(cur, r, 'void', reopen), 'btn small danger') : null,
            r.hasHistory ? button('currency.history', () => historyDialog(cur, r, reopen), 'btn small') : null,
          ].filter(Boolean) },
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

'use strict';
/* شروط السداد (جدول أقساط بنسب مجموعها 100%) وطرق السداد. لا دورة تحصيل/سداد في هذه المرحلة. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, badge, name, modal, form, button, fill } = TAYL.ui;
  const KINDS = ['cash', 'net', 'advance', 'installments', 'custom'];

  /** محرر الأقساط: صفوف (بعد كم يوم، النسبة %، وصف). النسب نصوص؛ التحقق من المجموع = 100 يتم على الخادم. */
  function linesEditor(initial) {
    const body = el('tbody');
    const addRow = (l = {}) => {
      const tr = el('tr', null,
        el('td', null, el('input', { type: 'number', min: 0, max: 3650, value: l.dueDays ?? '', 'aria-label': t('pt.dueDays'), class: 'days', dir: 'ltr' })),
        el('td', null, el('input', { type: 'text', inputmode: 'decimal', value: l.percent ?? '', 'aria-label': t('pt.percent'), class: 'pct', dir: 'ltr', maxlength: 20 })),
        el('td', null, el('input', { type: 'text', value: l.description ?? '', 'aria-label': t('common.description'), class: 'desc', maxlength: 200 })),
        el('td', { class: 'actions' }, el('button', { type: 'button', class: 'btn small danger', text: t('common.remove'), on: { click: () => tr.remove() } })));
      body.append(tr);
    };
    (initial && initial.length ? initial : [{ dueDays: 0 }, { dueDays: 30 }]).forEach(addRow);
    const node = el('div', { class: 'lines-editor' },
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, el('thead', null, el('tr', null, ['pt.dueDays', 'pt.percent', 'common.description', 'common.actions'].map((k) => el('th', { text: t(k) })))), body)),
      el('button', { type: 'button', class: 'btn small', text: t('pt.addLine'), on: { click: () => addRow({}) } }));
    return {
      node,
      value: () => [...body.querySelectorAll('tr')].map((tr) => ({
        dueDays: tr.querySelector('.days').value === '' ? null : Number.parseInt(tr.querySelector('.days').value, 10),
        percent: tr.querySelector('.pct').value.trim(),
        description: tr.querySelector('.desc').value.trim() || undefined,
      })),
    };
  }

  function schedulePreview(term) {
    const out = el('div');
    const f = form({
      submitKey: 'pt.calc',
      fields: [
        { name: 'amount', label: 'pt.amount', required: true, dir: 'ltr', inputmode: 'decimal', maxlength: 40 },
        { name: 'docDate', label: 'pt.docDate', type: 'date', required: true, value: new Date().toISOString().slice(0, 10) },
      ],
      async onSubmit(v) {
        const rows = await TAYL.api.post(`/api/payment-terms/${term.id}/schedule-preview`, { amount: v.amount.trim(), docDate: v.docDate });
        fill(out, TAYL.grid.create({ rows: rows.map((r) => ({ ...r, id: r.seq })), columns: [
          { label: 'pt.seq', render: (r) => String(r.seq) }, { label: 'pt.dueDate', render: (r) => el('span', { dir: 'ltr', text: r.dueDate }) },
          { label: 'pt.percent', render: (r) => el('span', { dir: 'ltr', text: r.percent + '%' }) }, { label: 'pt.amount', render: (r) => el('span', { dir: 'ltr', class: 'num', text: r.amount }) }] }).node);
      },
    });
    modal({ title: `${t('pt.preview')} — ${term.code}`, wide: true, body: el('div', null, el('p', { class: 'muted', text: t('pt.previewIntro') }), f.node, out) });
  }

  TAYL.views.paymentTerms = TAYL.masterView({
    key: 'nav.paymentTerms', resource: 'payment_terms', base: '/api/payment-terms', exportName: 'payment-terms',
    addKey: 'pt.add', editKey: 'pt.edit', intro: 'pt.intro',
    columns: [
      { label: 'common.code', render: (r) => el('code', { dir: 'ltr', text: r.code }), sortValue: (r) => r.code },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'pt.kind', render: (r) => t('pt.kind.' + r.kind) },
      { label: 'pt.schedule', render: (r) => el('span', { dir: 'ltr', text: r.lines.map((l) => `${l.dueDays}d: ${l.percent}%`).join(' · ') }) },
      { label: 'treasury.usable', render: (r) => badge(r.isUsable ? 'common.yes' : 'common.no', r.isUsable ? 'ok' : 'muted') },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    filters: [{ name: 'kind', label: 'pt.kind', options: () => KINDS.map((k) => ({ value: k, label: t('pt.kind.' + k) })) }],
    rowActions: (r) => button('pt.preview', () => schedulePreview(r), 'btn small'),
    fields(row) {
      const net = row && ['net', 'advance'].includes(row.kind) ? row.lines[row.lines.length - 1].dueDays : 30;
      return [
        TAYL.fields.code(row), ...TAYL.fields.names(row, 120),
        { name: 'kind', label: 'pt.kind', type: 'select', required: true, value: row ? row.kind : 'net', options: KINDS.map((k) => ({ value: k, label: t('pt.kind.' + k) })) },
        { name: 'netDays', label: 'pt.netDays', type: 'number', min: 0, max: 3650, value: net, showIf: (v) => v.kind === 'net' || v.kind === 'advance' },
        { name: 'advancePercent', label: 'pt.advancePercent', dir: 'ltr', inputmode: 'decimal', value: row && row.kind === 'advance' ? row.lines[0].percent : '', showIf: (v) => v.kind === 'advance', hint: 'pt.percentHint', maxlength: 20 },
        { name: 'lines', label: 'pt.lines', type: 'custom', showIf: (v) => v.kind === 'installments' || v.kind === 'custom', hint: 'pt.linesHint',
          render: () => linesEditor(row && ['installments', 'custom'].includes(row.kind) ? row.lines : null) },
        { name: 'isUsable', label: 'treasury.usable', type: 'checkbox', value: row ? row.isUsable : true },
        TAYL.fields.description(row),
      ];
    },
  });

  TAYL.views.paymentMethods = TAYL.masterView({
    key: 'nav.paymentMethods', resource: 'payment_methods', base: '/api/payment-methods', exportName: 'payment-methods',
    addKey: 'pm.add', editKey: 'pm.edit', intro: 'pm.intro',
    columns: [
      { label: 'common.code', render: (r) => el('code', { dir: 'ltr', text: r.code }), sortValue: (r) => r.code },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'pm.kind', render: (r) => t('pm.kind.' + r.kind) },
      { label: 'pm.treasuryKind', render: (r) => (r.treasuryKind ? t('treasury.kind.' + r.treasuryKind) : '') },
      { label: 'treasury.usable', render: (r) => badge(r.isUsable ? 'common.yes' : 'common.no', r.isUsable ? 'ok' : 'muted') },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    fields: (row) => [
      TAYL.fields.code(row), ...TAYL.fields.names(row, 120),
      { name: 'kind', label: 'pm.kind', type: 'select', required: true, value: row ? row.kind : 'other', options: ['cash', 'bank_transfer', 'cheque', 'card', 'other'].map((k) => ({ value: k, label: t('pm.kind.' + k) })) },
      { name: 'treasuryKind', label: 'pm.treasuryKind', type: 'select', value: row ? row.treasuryKind || '' : '', options: [{ value: '', label: t('common.none') }, ...['cash', 'bank'].map((k) => ({ value: k, label: t('treasury.kind.' + k) }))] },
      { name: 'isUsable', label: 'treasury.usable', type: 'checkbox', value: row ? row.isUsable : true },
      TAYL.fields.description(row),
    ],
    toBody(v) { const b = { ...v }; if (b.treasuryKind === '') b.treasuryKind = null; return b; },
  });
})();

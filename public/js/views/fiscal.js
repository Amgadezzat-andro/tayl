'use strict';
/* السنوات والفترات المالية: إنشاء بفترات شهرية/ربع سنوية، إغلاق/إعادة فتح/قفل نهائي بسبب إلزامي وسجل. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.fiscalYears = (() => {
  const { el, t, badge, name, modal, form, toast, button, errorText, fill, confirm, pageHead, panel, dateTime } = TAYL.ui;
  const api = TAYL.api;
  const STATUS_CLS = { open: 'ok', closed: 'warn', locked: 'bad', partial: 'gold' };
  let selected = null;

  function yearDialog(reload) {
    const preview = el('div', { class: 'preview-periods' });
    const f = form({
      submitKey: 'fiscal.create',
      fields: [
        { name: 'code', label: 'fiscal.code', required: true, dir: 'ltr', maxlength: 30, hint: 'common.codeHint' },
        ...TAYL.fields.names(null, 120),
        { name: 'startDate', label: 'fiscal.startDate', type: 'date', required: true, onChange: () => showPreview() },
        { name: 'endDate', label: 'fiscal.endDate', type: 'date', required: true, onChange: () => showPreview() },
        { name: 'periodType', label: 'fiscal.periodType', type: 'select', value: 'monthly', options: ['monthly', 'quarterly'].map((x) => ({ value: x, label: t('fiscal.type.' + x) })), onChange: () => showPreview() },
      ],
      async onSubmit(v) { const y = await api.post('/api/fiscal-years', v); close(); toast(t('common.saved')); selected = y.id; reload(); },
    });
    async function showPreview() {
      const v = f.values();
      if (!v.startDate || !v.endDate) return;
      try {
        const ps = await api.get(`/api/fiscal-years/preview?start=${v.startDate}&end=${v.endDate}&type=${v.periodType}`);
        fill(preview, el('p', { class: 'hint', text: t('fiscal.previewCount', { n: ps.length }) }),
          el('ol', { class: 'period-preview', dir: 'ltr' }, ps.map((p) => el('li', { text: `${p.start} → ${p.end}` }))));
      } catch { fill(preview, el('p', { class: 'field-error', text: t('fiscal.previewInvalid') })); }
    }
    const close = modal({ title: t('fiscal.add'), wide: true, body: el('div', null, el('p', { class: 'muted', text: t('fiscal.addIntro') }), f.node, preview) });
  }

  function statusDialog(period, op, reload) {
    const f = form({
      submitKey: 'fiscal.op.' + op,
      fields: [{ name: 'reason', label: 'fiscal.reason', type: 'textarea', required: true, full: true, hint: op === 'lock' ? 'fiscal.lockWarning' : 'fiscal.reasonHint' }],
      async onSubmit(v) { await api.post(`/api/fiscal-periods/${period.id}/${op}`, v); close(); toast(t('common.saved')); reload(); },
    });
    const close = modal({ title: `${t('fiscal.op.' + op)} — ${name(period)}`, body: f.node });
  }

  async function history(period) {
    const ev = await api.get(`/api/fiscal-periods/${period.id}/events`);
    modal({ title: `${t('fiscal.history')} — ${name(period)}`, wide: true, body: TAYL.grid.create({
      rows: ev, emptyKey: 'fiscal.noHistory',
      columns: [
        { label: 'audit.time', render: (e) => dateTime(e.occurredAt) }, { label: 'audit.actor', render: (e) => el('span', { dir: 'ltr', text: e.username }) },
        { label: 'fiscal.action', render: (e) => t('fiscal.event.' + e.action) }, { label: 'fiscal.reason', render: (e) => e.reason },
      ] }).node });
  }

  async function render(root, app) {
    const can = (a) => app.can('fiscal_years.' + a);
    const years = await api.get('/api/fiscal-years');
    if (!years.some((y) => y.id === selected)) selected = years.length ? years[0].id : null;
    const reload = () => app.rerender();   // إعادة رسم الشاشة عبر الموجّه (الحاوية المؤقتة لا تبقى في الصفحة)
    const yearGrid = TAYL.grid.create({
      rows: years, caption: t('nav.fiscalYears'), emptyKey: 'fiscal.none',
      columns: [
        { label: 'fiscal.code', render: (y) => el('code', { dir: 'ltr', text: y.code }), sortValue: (y) => y.code },
        { label: 'common.name', render: (y) => name(y) },
        { label: 'fiscal.startDate', render: (y) => el('span', { dir: 'ltr', text: y.startDate }), sortValue: (y) => y.startDate },
        { label: 'fiscal.endDate', render: (y) => el('span', { dir: 'ltr', text: y.endDate }) },
        { label: 'fiscal.periodType', render: (y) => t('fiscal.type.' + y.periodType) },
        { label: 'fiscal.periods', render: (y) => `${y.periodCount} (${t('period.status.closed')}: ${y.closedCount + y.lockedCount})` },
        { label: 'common.status', render: (y) => badge('fiscal.yearStatus.' + y.status, STATUS_CLS[y.status]) },
        { label: 'common.actions', cls: 'actions', sortable: false, render: (y) => [
          button('fiscal.showPeriods', () => { selected = y.id; reload(); }, 'btn small'),
          can('delete') && y.status === 'open' ? button('common.delete', async () => {
            if (!(await confirm(t('fiscal.confirmDelete', { code: y.code }), { danger: true, okKey: 'common.delete' }))) return;
            try { await api.del('/api/fiscal-years/' + y.id); toast(t('common.deleted')); reload(); } catch (e) { toast(errorText(e), 'bad'); }
          }, 'btn small danger') : null] },
      ],
      onOpen: (y) => { selected = y.id; reload(); },
    });
    let periodsBox = null;
    if (selected) {
      const y = await api.get('/api/fiscal-years/' + selected);
      periodsBox = panel(null, el('h2', { text: `${t('fiscal.periodsOf')} ${name(y)} (${y.startDate} → ${y.endDate})` }), TAYL.grid.create({
        rows: y.periods, caption: t('fiscal.periods'),
        columns: [
          { label: 'fiscal.seq', render: (p) => String(p.seq), sortValue: (p) => p.seq },
          { label: 'fiscal.period', render: (p) => name(p) },
          { label: 'fiscal.startDate', render: (p) => el('span', { dir: 'ltr', text: p.startDate }) },
          { label: 'fiscal.endDate', render: (p) => el('span', { dir: 'ltr', text: p.endDate }) },
          { label: 'common.status', render: (p) => badge('period.status.' + p.status, STATUS_CLS[p.status]) },
          { label: 'fiscal.reason', render: (p) => p.statusReason || '' },
          { label: 'common.actions', cls: 'actions', sortable: false, render: (p) => [
            can('close') && p.status === 'open' ? button('fiscal.op.close', () => statusDialog(p, 'close', reload), 'btn small') : null,
            can('reopen') && p.status === 'closed' ? button('fiscal.op.reopen', () => statusDialog(p, 'reopen', reload), 'btn small') : null,
            can('lock') && p.status === 'closed' ? button('fiscal.op.lock', () => statusDialog(p, 'lock', reload), 'btn small danger') : null,
            button('fiscal.history', () => history(p), 'btn small')] },
        ],
        onOpen: (p) => history(p),
      }).node);
    }
    TAYL.keys.setPage([can('create') ? { combo: 'Ctrl+N', alt: 'Alt+N', labelKey: 'keys.new', run: () => yearDialog(reload) } : null]);
    fill(root,
      pageHead('nav.fiscalYears', can('create') ? button('fiscal.add', () => yearDialog(reload), 'btn primary') : null,
        can('export') ? button('common.export', () => TAYL.ui.download(`/api/fiscal-years/export.xlsx?lang=${window.I18N.lang}`, 'fiscal-periods.xlsx'), 'btn small') : null,
        can('print') ? button('common.print', () => TAYL.ui.printFrom(`/api/fiscal-years/print?lang=${window.I18N.lang}`), 'btn small') : null,
        button('keys.button', () => TAYL.keys.help(), 'btn small')),
      el('p', { class: 'muted', text: t('fiscal.intro') }),
      panel(null, yearGrid.node),
      periodsBox);
  }

  return { key: 'nav.fiscalYears', perm: 'fiscal_years.view', render };
})();

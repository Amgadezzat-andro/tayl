'use strict';
/* عرض سجل التدقيق (قراءة فقط — السجل نفسه لا يقبل التعديل أو الحذف من القاعدة). */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.audit = (() => {
  const { el, t, table, pageHead, panel, dateTime, button } = TAYL.ui;
  const api = TAYL.api;
  const FILTERS = ['', 'auth.', 'user.', 'role.', 'branch.', 'company.', 'settings.', 'precision.', 'setup.'];
  let filter = '';

  const actionLabel = (a) => (window.I18N.has('audit.action.' + a) ? t('audit.action.' + a) : a);

  async function render(root) {
    const rows = [];
    const holder = el('div');
    const more = button('audit.loadMore', () => load(), 'btn');
    async function load() {
      const before = rows.length ? `&before=${rows[rows.length - 1].id}` : '';
      const page = await api.get(`/api/audit?limit=50${filter ? '&action=' + encodeURIComponent(filter) : ''}${before}`);
      rows.push(...page);
      more.hidden = page.length < 50;
      TAYL.ui.fill(holder, table({
        columns: [
          { label: 'audit.time', render: (r) => dateTime(r.occurred_at) },
          { label: 'audit.actor', render: (r) => el('span', { dir: 'ltr', text: r.actor }) },
          { label: 'audit.action', render: (r) => el('span', { class: 'badge ' + (/failure|blocked|failed/.test(r.action) ? 'bad' : ''), title: r.action, text: actionLabel(r.action) }) },
          { label: 'audit.entity', render: (r) => (r.entity_type ? `${r.entity_type} #${r.entity_id ?? ''}` : '—') },
          { label: 'audit.details', render: (r) => el('code', { class: 'details', dir: 'ltr', text: r.details ? JSON.stringify(r.details) : '' }) },
        ],
        rows,
      }));
    }
    const sel = el('select', { 'aria-label': t('audit.filter') }, FILTERS.map((f) => el('option', { value: f, text: t('audit.filter.' + (f.replace('.', '') || 'all')) })));
    sel.value = filter;
    sel.addEventListener('change', () => { filter = sel.value; rows.length = 0; load(); });
    TAYL.ui.fill(root, pageHead('nav.audit', sel), el('p', { class: 'muted', text: t('audit.intro') }), panel(null, holder, el('div', { class: 'form-actions' }, more)));
    await load();
  }

  return { key: 'nav.audit', perm: 'audit.view', render };
})();

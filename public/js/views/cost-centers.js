'use strict';
/* مراكز التكلفة: شجرة، نوع، فرع اختياري، تقرير ملخص. محرك التوزيع ليس ضمن هذه المرحلة. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, badge, name, modal } = TAYL.ui;
  let types = [];
  const loadTypes = async () => { try { types = (await TAYL.api.get('/api/cost-center-types?limit=500')).items; } catch { types = []; } };
  const typeName = (id) => { const x = types.find((y) => y.id === id); return x ? name(x) : ''; };

  async function summary() {
    const s = await TAYL.api.get('/api/cost-centers/summary');
    const tbl = (rows, labelKey) => TAYL.grid.create({
      rows: rows.map((r, i) => ({ ...r, id: i + 1 })),
      columns: [{ label: labelKey, render: (r) => (r.code ? `${r.code} — ${name(r)}` : t(labelKey === 'cc.type' ? 'common.none' : 'cc.allBranches')) },
        { label: 'cc.total', render: (r) => String(r.total) }, { label: 'common.active', render: (r) => String(r.active || 0) }],
    }).node;
    modal({ title: t('cc.summary'), wide: true, body: el('div', null, el('h3', { class: 'form-section', text: t('cc.byType') }), tbl(s.byType, 'cc.type'), el('h3', { class: 'form-section', text: t('cc.byBranch') }), tbl(s.byBranch, 'cc.branch')) });
  }

  const view = TAYL.masterView({
    key: 'nav.costCenters', resource: 'cost_centers', base: '/api/cost-centers', tree: true, importable: true, exportName: 'cost-centers',
    addKey: 'cc.add', editKey: 'cc.edit', importKey: 'cc.import', intro: 'cc.intro',
    columns: [
      { label: 'cc.code', render: (r) => el('code', { dir: 'ltr', text: r.code }) },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'cc.type', render: (r) => typeName(r.typeId) },
      { label: 'cc.branch', render: (r) => (r.branchId ? TAYL.fields.branchName(TAYL.app, r.branchId) : t('cc.allBranches')) },
      { label: 'account.kind', render: (r) => badge(r.isGroup ? 'account.group' : 'account.detail', r.isGroup ? 'gold' : '') },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    filters: [
      { name: 'typeId', label: 'cc.type', options: () => types.map((x) => ({ value: String(x.id), label: name(x) })) },
      { name: 'branchId', label: 'cc.branch', options: () => [{ value: 'none', label: t('cc.allBranches') }, ...TAYL.app.session.branches.map((b) => ({ value: String(b.id), label: b.code }))] },
    ],
    treeFilter: (r, f) => (!f.typeId || String(r.typeId) === f.typeId) && (!f.branchId || (f.branchId === 'none' ? r.branchId == null : String(r.branchId) === f.branchId)),
    fields(row, app, rows) {
      const parent = row && row.parentId ? rows.get(row.parentId) : null;
      return [
        TAYL.fields.code(row), ...TAYL.fields.names(row),
        { name: 'parentId', label: 'cc.parent', type: 'combobox', source: TAYL.combobox.lookupSource('/api/cost-centers', 'groups=1&active=1'),
          value: parent ? { id: parent.id, label: `${parent.code} — ${name(parent)}` } : null },
        { name: 'typeId', label: 'cc.type', type: 'select', numeric: true, value: row && row.typeId != null ? String(row.typeId) : '',
          options: [{ value: '', label: t('common.none') }, ...types.filter((x) => x.isActive || (row && row.typeId === x.id)).map((x) => ({ value: String(x.id), label: name(x) }))] },
        { name: 'branchId', label: 'cc.branch', type: 'select', numeric: true, value: row && row.branchId != null ? String(row.branchId) : '', hint: 'cc.branchHint',
          options: [...(app.session.user.allBranches ? [{ value: '', label: t('cc.allBranches') }] : []), ...app.session.branches.map((b) => ({ value: String(b.id), label: `${b.code} — ${name(b)}` }))] },
        { name: 'isGroup', label: 'cc.isGroup', type: 'checkbox', value: row ? row.isGroup : false },
        TAYL.fields.description(row),
      ];
    },
    toBody(v, row) { const b = { ...v }; if (!row && b.typeId == null) delete b.typeId; return b; },
    top: (app, reload) => el('div', { class: 'page-actions' },
      TAYL.ui.button('cc.summary', summary, 'btn small'),
      TAYL.ui.button('cc.types', () => TAYL.typesDialog({
        base: '/api/cost-center-types', titleKey: 'cc.types', resource: 'cost_centers', app, onChange: async () => { await loadTypes(); reload(); },
        columns: [{ label: 'common.code', render: (r) => el('code', { dir: 'ltr', text: r.code }) }, { label: 'common.name', render: (r) => name(r) }],
        fields: (row) => [TAYL.fields.code(row), ...TAYL.fields.names(row, 120)],
      }), 'btn small')),
  });
  TAYL.views.costCenters = { ...view, render: async (root, app) => { await loadTypes(); return view.render(root, app); } };
})();

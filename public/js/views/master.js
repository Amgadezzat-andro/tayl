'use strict';
/*
 * شاشة بيانات رئيسية موحدة (قائمة أو شجرة): بحث، تصفية، فرز، إضافة/تعديل/تفعيل/تعطيل/حذف، نقل لأعلى/أسفل،
 * استيراد/تصدير/طباعة، واختصارات لوحة المفاتيح. كل زر واختصار يظهر حسب الصلاحية، والخادم يتحقق مجددًا في كل طلب.
 */
window.TAYL = window.TAYL || {};
TAYL.masterView = (cfg) => {
  const { el, t, form, pageHead, panel, modal, toast, confirm, button, errorText, fill, name } = TAYL.ui;
  const api = TAYL.api;
  const R = cfg.resource;
  const state = { q: '', filters: {}, active: '' };
  let rowsById = new Map();   // آخر صفوف محمّلة (لأسماء الأب في النماذج دون طلب إضافي)
  const collapsed = new Set(); // حالة طي الشجرة تبقى بعد الحفظ وإعادة التحميل

  function editor(app, row, reload, readOnly = false) {
    const f = form({
      readOnly,
      fields: cfg.fields(row || null, app, rowsById),
      onCancel: () => close(),
      async onSubmit(v) {
        const body = cfg.toBody ? cfg.toBody(v, row) : v;
        const saved = row ? await api.put(`${cfg.base}/${row.id}`, body) : await api.post(cfg.base, body);
        close(); toast(t('common.saved')); reload(saved && saved.id);
      },
    });
    const close = modal({ title: t(readOnly ? cfg.viewKey || 'common.view' : row ? cfg.editKey : cfg.addKey) + (row ? ` — ${row.code}` : ''), wide: true,
      body: el('div', null, cfg.extraView && row ? cfg.extraView(row, app) : null, f.node) });
  }

  async function render(root, app) {
    const can = (a) => app.can(`${R}.${a}`);
    const canEdit = can('update');
    const search = el('input', { type: 'search', class: 'search', id: 'page-search', placeholder: t('common.searchHint'), 'aria-label': t('common.search'), value: state.q });
    const filterEls = (cfg.filters || []).map((fl) => {
      const s = el('select', { 'aria-label': t(fl.label) }, [el('option', { value: '', text: t(fl.label) + ': ' + t('common.all') }), ...fl.options().map((o) => el('option', { value: o.value, text: o.label }))]);
      s.value = state.filters[fl.name] || '';
      s.addEventListener('change', () => { state.filters[fl.name] = s.value; load(); });
      return s;
    });
    const status = el('select', { 'aria-label': t('common.status') }, ['', '1', '0'].map((v) => el('option', { value: v, text: t(v === '' ? 'common.allStatuses' : v === '1' ? 'common.active' : 'common.inactive') })));
    status.value = state.active;
    status.addEventListener('change', () => { state.active = status.value; load(); });
    let timer = null;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); load(); }, 250); });
    search.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && grid) { e.preventDefault(); grid.focus(); } });

    const holder = el('div');
    const count = el('span', { class: 'muted count' });
    let grid = null;

    const doNew = () => editor(app, null, load);
    const doEdit = (r) => editor(app, r, load);
    const act = async (fn, okKey = 'common.saved') => { try { await fn(); toast(t(okKey)); load(); } catch (e) { toast(errorText(e) + (e.details && e.details.usedBy ? ` (${e.details.usedBy.join(', ')})` : ''), 'bad'); } };

    const actionCol = {
      label: 'common.actions', cls: 'actions', sortable: false,
      render: (r) => [
        canEdit ? button('common.edit', () => doEdit(r), 'btn small') : null,
        cfg.tree && canEdit ? [el('button', { type: 'button', class: 'btn small icon', title: t('grid.moveUp'), 'aria-label': t('grid.moveUp'), text: '↑', on: { click: () => act(() => api.post(`${cfg.base}/${r.id}/reorder`, { direction: 'up' })) } }),
          el('button', { type: 'button', class: 'btn small icon', title: t('grid.moveDown'), 'aria-label': t('grid.moveDown'), text: '↓', on: { click: () => act(() => api.post(`${cfg.base}/${r.id}/reorder`, { direction: 'down' })) } })] : null,
        can('disable') && !(cfg.protect && cfg.protect(r)) ? button(r.isActive ? 'common.disable' : 'common.enable', async () => {
          if (await confirm(t(r.isActive ? 'master.confirmDisable' : 'master.confirmEnable', { code: r.code }), { danger: r.isActive })) act(() => api.post(`${cfg.base}/${r.id}/status`, { active: !r.isActive }));
        }, r.isActive ? 'btn small danger' : 'btn small') : null,
        can('delete') && !(cfg.protect && cfg.protect(r)) ? button('common.delete', async () => {
          if (await confirm(t('master.confirmDelete', { code: r.code }), { danger: true, okKey: 'common.delete' })) act(() => api.del(`${cfg.base}/${r.id}`), 'common.deleted');
        }, 'btn small danger') : null,
        cfg.rowActions ? cfg.rowActions(r, app, load) : null,
      ],
    };

    async function load(focusId) {
      const qs = new URLSearchParams({ q: state.q, active: state.active, ...state.filters });
      let rows;
      try {
        if (cfg.tree) rows = await api.get(`${cfg.base}/tree?${qs}`);
        else rows = (await api.get(`${cfg.base}?${qs}`)).items;
      } catch (e) { fill(holder, el('p', { class: 'form-alert', text: errorText(e) })); return; }
      if (cfg.tree && (state.active || Object.values(state.filters).some(Boolean))) {
        rows = rows.filter((r) => (state.active === '' || String(Number(r.isActive)) === state.active) && (cfg.treeFilter ? cfg.treeFilter(r, state.filters) : true));
      }
      count.textContent = t('master.count', { n: rows.length });
      rowsById = new Map(rows.map((r) => [r.id, r]));
      const prevSel = grid && grid.selected() ? grid.selected().id : null;
      grid = TAYL.grid.create({
        columns: [...cfg.columns, actionCol], rows, tree: !!cfg.tree, expandAll: !!state.q, canEdit, caption: t(cfg.key),
        collapsedState: state.q ? null : collapsed, initialSelected: typeof focusId === 'number' ? focusId : prevSel,
        onOpen: (r) => (canEdit ? doEdit(r) : editor(app, r, load, true)), onEdit: doEdit,
      });
      fill(holder, grid.node);
      if (typeof focusId === 'number') grid.select(focusId);
    }

    const io = [
      cfg.importable && can('import') ? button('common.import', () => TAYL.ui.importDialog({ base: cfg.base, titleKey: cfg.importKey || 'import.title', onDone: load }), 'btn small') : null,
      can('export') ? button('common.export', () => TAYL.ui.download(`${cfg.base}/export.xlsx?lang=${window.I18N.lang}`, `${cfg.exportName || R}.xlsx`), 'btn small') : null,
      can('print') ? button('common.print', () => TAYL.ui.printFrom(`${cfg.base}/print?lang=${window.I18N.lang}`), 'btn small') : null,
    ];

    TAYL.keys.setPage([
      can('create') ? { combo: 'Ctrl+N', alt: 'Alt+N', labelKey: 'keys.new', run: doNew } : null,
      { combo: 'Ctrl+F', labelKey: 'keys.search', run: () => { search.focus(); search.select(); } },
      canEdit ? { combo: 'F2', labelKey: 'keys.edit', run: () => { const r = grid && grid.selected(); if (r) doEdit(r); } } : null,
    ]);

    fill(root,
      pageHead(cfg.key, can('create') ? button(cfg.addKey, doNew, 'btn primary') : null, io, TAYL.ui.button('keys.button', () => TAYL.keys.help(), 'btn small')),
      cfg.intro ? el('p', { class: 'muted', text: t(cfg.intro) }) : null,
      cfg.top ? cfg.top(app, () => load()) : null,
      el('div', { class: 'filters' }, search, filterEls, status, count),
      panel(null, holder),
    );
    await load();
  }

  return { key: cfg.key, perm: `${R}.view`, render };
};

/** خيارات نعم/لا وحقول شائعة */
TAYL.fields = {
  code: (row, maxlength = 30) => ({ name: 'code', label: 'common.code', required: true, dir: 'ltr', value: row && row.code, maxlength, hint: 'common.codeHint' }),
  names: (row, max = 200) => [
    { name: 'nameAr', label: 'common.nameAr', required: true, dir: 'rtl', value: row && row.nameAr, maxlength: max },
    { name: 'nameEn', label: 'common.nameEn', required: true, dir: 'ltr', value: row && row.nameEn, maxlength: max },
  ],
  description: (row) => ({ name: 'description', label: 'common.description', type: 'textarea', value: row && row.description, full: true }),
  branchName: (app, id) => { const b = (app.session.branches || []).find((x) => x.id === id); return b ? b.code : (id ? '#' + id : ''); },
};

/**
 * نافذة قائمة مرجعية بسيطة (أنواع الحسابات، أنواع مراكز التكلفة): عرض + إضافة + تعديل الاسم + تفعيل/تعطيل.
 * fields(row) و columns كما في masterView.
 */
TAYL.typesDialog = async ({ base, titleKey, resource, app, fields, columns, onChange }) => {
  const { el, t, form, modal, toast, button, errorText, fill } = TAYL.ui;
  const can = (a) => app.can(`${resource}.${a}`);
  const listBox = el('div');
  const formBox = el('div');
  async function load() {
    const rows = (await TAYL.api.get(base + '?limit=500')).items;
    fill(listBox, TAYL.grid.create({
      columns: [...columns, { label: 'common.actions', cls: 'actions', sortable: false, render: (r) => [
        can('update') ? button('common.edit', () => edit(r), 'btn small') : null,
        can('disable') ? button(r.isActive ? 'common.disable' : 'common.enable', async () => {
          try { await TAYL.api.post(`${base}/${r.id}/status`, { active: !r.isActive }); load(); if (onChange) onChange(); } catch (e) { toast(errorText(e), 'bad'); }
        }, 'btn small') : null] }],
      rows, canEdit: can('update'), onOpen: (r) => can('update') && edit(r), onEdit: edit,
    }).node);
  }
  function edit(row) {
    if (!(row ? can('update') : can('create'))) { formBox.replaceChildren(); return; }
    const f = form({
      fields: fields(row), submitKey: row ? 'common.save' : 'common.add', onCancel: row ? () => edit(null) : null,
      async onSubmit(v) { if (row) await TAYL.api.put(`${base}/${row.id}`, v); else await TAYL.api.post(base, v); toast(t('common.saved')); edit(null); load(); if (onChange) onChange(); },
    });
    fill(formBox, el('h3', { class: 'form-section', text: t(row ? 'common.edit' : 'common.add') }), f.node);
  }
  modal({ title: t(titleKey), wide: true, body: el('div', null, listBox, formBox) });
  await load();
  edit(null);
};

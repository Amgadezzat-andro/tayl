'use strict';
/* الأدوار والصلاحيات: مصفوفة موارد × إجراءات قياسية (عرض/إضافة/تعديل/حذف/تعطيل/اعتماد/ترحيل/طباعة/تصدير). */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.roles = (() => {
  const { el, t, form, table, pageHead, panel, modal, toast, confirm, button, name, errorText } = TAYL.ui;
  const api = TAYL.api;

  function matrix(catalog, selected, mine, isSuper) {
    const boxes = [];
    const groups = [...new Set(catalog.resources.map((r) => r.group))];
    const node = el('div', { class: 'table-wrap' }, el('table', { class: 'data matrix' },
      el('thead', null, el('tr', null, el('th', { text: t('perm.resource') }), catalog.actions.map((a) => el('th', { class: 'c', text: t('perm.act.' + a) })))),
      el('tbody', null, groups.map((g) => [
        el('tr', { class: 'group-row' }, el('th', { colspan: String(catalog.actions.length + 1), text: t('perm.group.' + g) })),
        catalog.resources.filter((r) => r.group === g).map((r) => el('tr', null,
          el('td', { text: t('perm.res.' + r.resource) }),
          catalog.actions.map((a) => {
            if (!r.actions.includes(a)) return el('td', { class: 'c na', text: '·' });
            const key = `${r.resource}.${a}`;
            // لا يمكن منح ما لا تملكه (الخادم يرفضه أيضًا)
            const cb = el('input', { type: 'checkbox', value: key, checked: selected.includes(key), disabled: !isSuper && !mine.includes(key), 'aria-label': `${t('perm.res.' + r.resource)} — ${t('perm.act.' + a)}` });
            boxes.push(cb);
            return el('td', { class: 'c' }, cb);
          }))),
      ])),
    ));
    return { node, values: () => boxes.filter((b) => b.checked).map((b) => b.value) };
  }

  function editor(app, catalog, r) {
    const m = matrix(catalog, r ? r.permissions : [], app.session.user.permissions, app.session.user.isSuperAdmin);
    const f = form({
      fields: [
        { name: 'nameAr', label: 'role.nameAr', required: true, dir: 'rtl', value: r && r.nameAr, maxlength: 100 },
        { name: 'nameEn', label: 'role.nameEn', required: true, dir: 'ltr', value: r && r.nameEn, maxlength: 100 },
        { name: 'description', label: 'role.description', type: 'textarea', value: r && r.description },
      ],
      extra: el('div', { class: 'matrix-wrap' }, el('h3', { class: 'form-section', text: t('role.permissions') }), m.node),
      onCancel: () => close(),
      async onSubmit(v) {
        const body = { ...v, permissions: m.values() };
        if (r) await api.put('/api/roles/' + r.id, body); else await api.post('/api/roles', body);
        close(); toast(t('common.saved')); await app.refreshSession(); app.rerender();
      },
    });
    const close = modal({ title: t(r ? 'role.edit' : 'role.add'), body: f.node, wide: true });
  }

  async function render(root, app) {
    const [roles, catalog] = await Promise.all([api.get('/api/roles'), api.get('/api/permissions')]);
    TAYL.ui.fill(root,
      pageHead('nav.roles', app.can('roles.create') ? button('role.add', () => editor(app, catalog, null), 'btn primary') : null),
      el('p', { class: 'muted', text: t('role.intro') }),
      panel(null, table({
        columns: [
          { label: 'role.name', render: (r) => name(r) },
          { label: 'role.description', render: (r) => r.description || '—' },
          { label: 'role.permissionCount', render: (r) => String(r.permissions.length) },
          { label: 'role.userCount', render: (r) => String(r.userCount) },
          { label: 'common.actions', cls: 'actions', render: (r) => [
            app.can('roles.update') ? button('common.edit', () => editor(app, catalog, r), 'btn small') : null,
            app.can('roles.delete') ? button('common.delete', async () => {
              if (!(await confirm(t('role.confirmDelete', { name: name(r) }), { danger: true, okKey: 'common.delete' }))) return;
              try { await api.del('/api/roles/' + r.id); toast(t('common.deleted')); app.rerender(); } catch (e) { toast(errorText(e), 'bad'); }
            }, 'btn small danger') : null,
          ] },
        ],
        rows: roles,
        emptyKey: 'role.none',
      })),
    );
  }

  return { key: 'nav.roles', perm: 'roles.view', render };
})();

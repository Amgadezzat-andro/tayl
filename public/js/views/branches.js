'use strict';
/* إدارة الفروع. القائمة القادمة من الخادم مقيّدة أصلًا بنطاق المستخدم. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.branches = (() => {
  const { el, t, form, table, badge, pageHead, panel, modal, toast, confirm, button, name, errorText } = TAYL.ui;
  const api = TAYL.api;

  function editor(app, b) {
    const close = modal({
      title: t(b ? 'branch.edit' : 'branch.add'),
      wide: true,
      body: form({
        fields: [
          { name: 'code', label: 'branch.code', required: true, dir: 'ltr', value: b && b.code, hint: 'branch.codeHint', maxlength: 20 },
          { name: 'nameAr', label: 'branch.nameAr', required: true, dir: 'rtl', value: b && b.nameAr },
          { name: 'nameEn', label: 'branch.nameEn', required: true, dir: 'ltr', value: b && b.nameEn },
          { name: 'phone', label: 'branch.phone', type: 'tel', dir: 'ltr', value: b && b.phone },
          { name: 'email', label: 'branch.email', type: 'email', dir: 'ltr', value: b && b.email },
          { name: 'addressAr', label: 'branch.addressAr', type: 'textarea', dir: 'rtl', value: b && b.addressAr },
          { name: 'addressEn', label: 'branch.addressEn', type: 'textarea', dir: 'ltr', value: b && b.addressEn },
        ],
        onCancel: () => close(),
        async onSubmit(v) {
          if (b) await api.put('/api/branches/' + b.id, v); else await api.post('/api/branches', v);
          close(); toast(t('common.saved')); await app.refreshSession(); app.rerender();
        },
      }).node,
    });
  }

  async function render(root, app) {
    const list = await api.get('/api/branches');
    const canEdit = app.can('branches.update');
    const canToggle = app.can('branches.disable');
    const canCreate = app.can('branches.create') && app.session.user.allBranches;

    const act = async (fn) => { try { await fn(); toast(t('common.saved')); await app.refreshSession(); app.rerender(); } catch (e) { toast(errorText(e), 'bad'); } };

    TAYL.ui.fill(root,
      pageHead('nav.branches', canCreate ? button('branch.add', () => editor(app, null), 'btn primary') : null),
      app.session.user.allBranches ? null : el('p', { class: 'notice', text: t('branch.scopeNote') }),
      panel(null, table({
        columns: [
          { label: 'branch.code', render: (b) => el('code', { dir: 'ltr', text: b.code }) },
          { label: 'branch.name', render: (b) => name(b) },
          { label: 'branch.phone', render: (b) => el('span', { dir: 'ltr', text: b.phone || '—' }) },
          { label: 'branch.type', render: (b) => (b.isMain ? badge('branch.main', 'gold') : '—') },
          { label: 'common.status', render: (b) => badge(b.isActive ? 'common.active' : 'common.inactive', b.isActive ? 'ok' : 'muted') },
          { label: 'common.actions', cls: 'actions', render: (b) => [
            canEdit ? button('common.edit', () => editor(app, b), 'btn small') : null,
            canEdit && !b.isMain && b.isActive && app.session.user.allBranches ? button('branch.makeMain', async () => {
              if (await confirm(t('branch.confirmMain', { code: b.code }))) act(() => api.put('/api/branches/' + b.id, { isMain: true }));
            }, 'btn small') : null,
            canToggle && !b.isMain ? button(b.isActive ? 'common.disable' : 'common.enable', async () => {
              if (await confirm(t(b.isActive ? 'branch.confirmDisable' : 'branch.confirmEnable', { code: b.code }), { danger: b.isActive })) {
                act(() => api.post(`/api/branches/${b.id}/status`, { active: !b.isActive }));
              }
            }, b.isActive ? 'btn small danger' : 'btn small') : null,
          ] },
        ],
        rows: list,
      })),
    );
  }

  return { key: 'nav.branches', perm: 'branches.view', render };
})();

'use strict';
/* إدارة المستخدمين: الأدوار، نطاق الفروع، التفعيل/التعطيل، إعادة تعيين كلمة المرور. */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.users = (() => {
  const { el, t, form, table, badge, pageHead, panel, modal, toast, confirm, button, name, dateTime, errorText } = TAYL.ui;
  const api = TAYL.api;

  function editor(app, ctx, u) {
    const me = app.session.user;
    const self = u && u.id === me.id;
    const branchOpts = ctx.branches.map((b) => ({ value: String(b.id), label: `${b.code} — ${name(b)}`, disabled: !b.isActive }));
    const fields = [
      u ? null : { name: 'username', label: 'user.username', required: true, dir: 'ltr', hint: 'user.usernameHint', maxlength: 64 },
      { name: 'displayName', label: 'user.displayName', required: true, value: u && u.displayName },
      u ? null : { name: 'password', label: 'user.initialPassword', type: 'password', required: true, dir: 'ltr', autocomplete: 'new-password', hint: 'user.initialPasswordHint', maxlength: 128 },
      me.isSuperAdmin ? { name: 'isSuperAdmin', label: 'user.superAdmin', type: 'checkbox', value: u && u.isSuperAdmin, hint: 'user.superAdminHint', disabled: self } : null,
      { name: 'roleIds', label: 'user.roles', type: 'checks', numeric: true, disabled: self, value: (u ? u.roleIds : []).map(String), options: ctx.roles.map((r) => ({ value: String(r.id), label: name(r) })) },
      { name: 'allBranches', label: 'user.allBranches', type: 'checkbox', value: u && u.allBranches, hint: 'user.allBranchesHint', disabled: self || !me.allBranches },
      { name: 'branchIds', label: 'user.branches', type: 'checks', numeric: true, disabled: self, value: (u ? u.branchIds : []).map(String), options: branchOpts },
      { name: 'defaultBranchId', label: 'user.defaultBranch', type: 'select', numeric: true, value: u && u.defaultBranchId != null ? String(u.defaultBranchId) : '',
        options: [{ value: '', label: t('user.noDefaultBranch') }, ...ctx.branches.filter((b) => b.isActive).map((b) => ({ value: String(b.id), label: `${b.code} — ${name(b)}` }))] },
    ].filter(Boolean);
    const close = modal({
      title: t(u ? 'user.edit' : 'user.add'),
      wide: true,
      body: el('div', null,
        self ? el('p', { class: 'notice', text: t('user.selfNote') }) : null,
        form({
          fields,
          onCancel: () => close(),
          async onSubmit(v) {
            if (self) { delete v.roleIds; delete v.branchIds; delete v.allBranches; delete v.isSuperAdmin; }
            if (u) await api.put('/api/users/' + u.id, v); else await api.post('/api/users', v);
            close(); toast(t('common.saved')); app.rerender();
          },
        }).node),
    });
  }

  function resetPassword(app, u) {
    const close = modal({
      title: t('user.resetPassword') + ' — ' + u.username,
      body: form({
        fields: [{ name: 'password', label: 'user.newPassword', type: 'password', required: true, dir: 'ltr', autocomplete: 'new-password', hint: 'user.resetHint', full: true, maxlength: 128 }],
        onCancel: () => close(),
        async onSubmit(v) { await api.post(`/api/users/${u.id}/password`, v); close(); toast(t('user.passwordResetDone')); app.rerender(); },
      }).node,
    });
  }

  async function render(root, app) {
    const [users, roles, branches] = await Promise.all([
      api.get('/api/users'),
      app.can('roles.view') ? api.get('/api/roles') : Promise.resolve([]),
      app.can('branches.view') ? api.get('/api/branches') : Promise.resolve(app.session.branches),
    ]);
    const ctx = { roles, branches };
    const roleName = (id) => { const r = roles.find((x) => x.id === id); return r ? name(r) : '#' + id; };
    const branchCode = (id) => { const b = branches.find((x) => x.id === id); return b ? b.code : '#' + id; };
    const canEdit = app.can('users.update');
    const canToggle = app.can('users.disable');
    const me = app.session.user;
    const act = async (fn) => { try { await fn(); toast(t('common.saved')); app.rerender(); } catch (e) { toast(errorText(e), 'bad'); } };

    TAYL.ui.fill(root,
      pageHead('nav.users', app.can('users.create') ? button('user.add', () => editor(app, ctx, null), 'btn primary') : null),
      panel(null, table({
        columns: [
          { label: 'user.username', render: (u) => el('span', { dir: 'ltr', text: u.username }) },
          { label: 'user.displayName', render: (u) => u.displayName },
          { label: 'user.roles', render: (u) => (u.isSuperAdmin ? badge('user.superAdmin', 'gold') : (u.roleIds.map(roleName).join(t('common.listSep')) || '—')) },
          { label: 'user.branches', render: (u) => (u.allBranches ? t('user.allBranches') : el('span', { dir: 'ltr', text: u.branchIds.map(branchCode).join(', ') || '—' })) },
          { label: 'user.lastLogin', render: (u) => dateTime(u.lastLoginAt) },
          { label: 'common.status', render: (u) => [badge(u.isActive ? 'common.active' : 'common.inactive', u.isActive ? 'ok' : 'muted'), u.mustChangePassword ? badge('user.mustChange', 'warn') : null] },
          { label: 'common.actions', cls: 'actions', render: (u) => [
            canEdit ? button('common.edit', () => editor(app, ctx, u), 'btn small') : null,
            canEdit && u.id !== me.id ? button('user.resetPassword', () => resetPassword(app, u), 'btn small') : null,
            canToggle && u.id !== me.id ? button(u.isActive ? 'common.disable' : 'common.enable', async () => {
              if (await confirm(t(u.isActive ? 'user.confirmDisable' : 'user.confirmEnable', { name: u.username }), { danger: u.isActive })) {
                act(() => api.post(`/api/users/${u.id}/status`, { active: !u.isActive }));
              }
            }, u.isActive ? 'btn small danger' : 'btn small') : null,
          ] },
        ],
        rows: users,
      })),
    );
  }

  return { key: 'nav.users', perm: 'users.view', render };
})();

'use strict';
/* حساب المستخدم: بياناته وتغيير كلمة المرور (إجباري عند أول دخول بكلمة وضعها المدير). */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.account = (() => {
  const { el, t, form, pageHead, panel, toast } = TAYL.ui;
  const api = TAYL.api;

  function render(root, app) {
    const u = app.session.user;
    const f = form({
      submitKey: 'account.changePassword',
      fields: [
        { name: 'currentPassword', label: 'account.currentPassword', type: 'password', required: true, dir: 'ltr', autocomplete: 'current-password', full: true, maxlength: 128 },
        { name: 'newPassword', label: 'user.newPassword', type: 'password', required: true, dir: 'ltr', autocomplete: 'new-password', hint: 'user.passwordHint', full: true, maxlength: 128 },
        { name: 'confirm', label: 'user.passwordConfirm', type: 'password', required: true, dir: 'ltr', autocomplete: 'new-password', full: true, skip: true, maxlength: 128 },
      ],
      async onSubmit(v) {
        if (v.newPassword !== f.inputs.confirm.input.value) { f.setErrors({ confirm: 'PASSWORD_MISMATCH' }); return; }
        await api.post('/api/auth/password', v);
        toast(t('account.passwordChanged'));
        await app.refreshSession();
        app.navigate('dashboard');
      },
    });
    TAYL.ui.fill(root,
      pageHead('nav.account'),
      u.mustChangePassword ? el('p', { class: 'notice warn', role: 'alert', text: t('account.mustChange') }) : null,
      panel('account.info', el('dl', { class: 'facts' },
        el('div', null, el('dt', { text: t('user.username') }), el('dd', { dir: 'ltr', text: u.username })),
        el('div', null, el('dt', { text: t('user.displayName') }), el('dd', { text: u.displayName })),
        el('div', null, el('dt', { text: t('dash.access') }), el('dd', { text: u.isSuperAdmin ? t('user.superAdmin') : (u.allBranches ? t('user.allBranches') : t('dash.branchCount', { n: app.session.branches.length })) })),
      )),
      panel('account.changePassword', el('p', { class: 'muted', text: t('account.changeNote') }), f.node),
    );
  }

  return { key: 'nav.account', perm: null, render };
})();

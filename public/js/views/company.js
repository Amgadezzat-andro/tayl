'use strict';
/* بيانات الشركة وشعارها (شعار الشركة منفصل عن شعار TAYL الرسمي). */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.company = (() => {
  const { el, t, form, panel, pageHead, toast, readFileBase64, errorText, confirm } = TAYL.ui;
  const api = TAYL.api;

  async function render(root, app) {
    const c = await api.get('/api/company');
    const canEdit = app.can('company.update');

    const f = form({
      readOnly: !canEdit,
      fields: [
        { name: 'nameAr', label: 'company.nameAr', required: true, dir: 'rtl', value: c.nameAr },
        { name: 'nameEn', label: 'company.nameEn', required: true, dir: 'ltr', value: c.nameEn },
        { name: 'addressAr', label: 'company.addressAr', type: 'textarea', dir: 'rtl', value: c.addressAr },
        { name: 'addressEn', label: 'company.addressEn', type: 'textarea', dir: 'ltr', value: c.addressEn },
        { name: 'phone', label: 'company.phone', type: 'tel', dir: 'ltr', value: c.phone },
        { name: 'email', label: 'company.email', type: 'email', dir: 'ltr', value: c.email },
        { name: 'taxNumber', label: 'company.taxNumber', dir: 'ltr', value: c.taxNumber },
        { name: 'commercialRegister', label: 'company.commercialRegister', dir: 'ltr', value: c.commercialRegister },
        { name: 'baseCurrency', label: 'company.baseCurrency', type: 'select', options: TAYL.currencyOptions(c.baseCurrency), value: c.baseCurrency, hint: 'company.baseCurrencyWarn' },
        { name: 'defaultLanguage', label: 'company.defaultLanguage', type: 'select', value: c.defaultLanguage, options: [{ value: 'ar', label: t('lang.ar') }, { value: 'en', label: t('lang.en') }] },
      ],
      async onSubmit(v) {
        if (v.baseCurrency !== c.baseCurrency && !(await confirm(t('company.confirmCurrency', { from: c.baseCurrency, to: v.baseCurrency }), { danger: true }))) return;
        await api.put('/api/company', v);
        toast(t('common.saved'));
        app.rerender();
      },
    });

    const logoBox = el('div', { class: 'logo-box' });
    const logoErr = el('p', { class: 'field-error', hidden: true });
    if (c.hasLogo) logoBox.append(el('img', { src: '/api/company/logo?v=' + c.logoSha256, alt: t('company.logo'), class: 'company-logo' }));
    else logoBox.append(el('p', { class: 'muted', text: t('company.noLogo') }));
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', hidden: true });
    file.addEventListener('change', async () => {
      const fl = file.files[0];
      if (!fl) return;
      logoErr.hidden = true;
      try {
        await api.put('/api/company/logo', { data: await readFileBase64(fl) });
        toast(t('common.saved'));
        app.rerender();
      } catch (e) { logoErr.textContent = errorText(e); logoErr.hidden = false; }
    });

    TAYL.ui.fill(root,
      pageHead('nav.company'),
      panel('company.profile', canEdit ? null : el('p', { class: 'notice', text: t('common.readOnly') }), f.node),
      panel('company.logo',
        logoBox,
        el('p', { class: 'hint', text: t('company.logoHint') }),
        logoErr,
        canEdit ? el('div', { class: 'form-actions' },
          file,
          TAYL.ui.button('company.uploadLogo', () => file.click(), 'btn primary'),
          c.hasLogo ? TAYL.ui.button('company.removeLogo', async () => {
            if (!(await confirm(t('company.confirmRemoveLogo'), { danger: true }))) return;
            await api.del('/api/company/logo'); toast(t('common.saved')); app.rerender();
          }, 'btn danger') : null) : null,
        el('p', { class: 'hint', text: t('company.taylLogoNote') }),
      ),
    );
  }

  return { key: 'nav.company', perm: 'company.view', render };
})();

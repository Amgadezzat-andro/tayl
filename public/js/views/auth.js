'use strict';
/* شاشتا التأسيس الأول وتسجيل الدخول (خارج الإطار الرئيسي، بشعار TAYL الرسمي). */
window.TAYL = window.TAYL || {};
TAYL.CURRENCIES = ['EGP', 'SAR', 'AED', 'KWD', 'QAR', 'BHD', 'OMR', 'JOD', 'USD', 'EUR', 'GBP'];
TAYL.currencyOptions = (current) => {
  const t = window.I18N.t;
  const codes = TAYL.CURRENCIES.includes(current) || !current ? TAYL.CURRENCIES : [current, ...TAYL.CURRENCIES];
  return codes.map((c) => ({ value: c, label: window.I18N.has('currency.' + c) ? `${c} — ${t('currency.' + c)}` : c }));
};

TAYL.auth = (() => {
  const { el, t, form, readFileBase64, errorText } = TAYL.ui;
  const api = TAYL.api;
  const MAX_LOGO = 512 * 1024;

  function setup(root, app) {
    let logo = null;
    const preview = el('img', { class: 'logo-preview', alt: '', hidden: true });
    const logoErr = el('p', { class: 'field-error', hidden: true });
    const file = el('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp', id: 'setup-logo' });
    file.addEventListener('change', async () => {
      logoErr.hidden = true; logo = null; preview.hidden = true;
      const f = file.files[0];
      if (!f) return;
      if (f.size > MAX_LOGO) { logoErr.textContent = t('err.LOGO_TOO_LARGE'); logoErr.hidden = false; file.value = ''; return; }
      logo = await readFileBase64(f);
      preview.src = 'data:' + f.type + ';base64,' + logo;
      preview.hidden = false;
    });

    const section = (key) => ({ name: '_h_' + key, type: 'heading', label: key });
    const fields = [
      section('setup.sectionCompany'),
      { name: 'company.nameAr', label: 'company.nameAr', required: true, dir: 'rtl' },
      { name: 'company.nameEn', label: 'company.nameEn', required: true, dir: 'ltr' },
      { name: 'company.addressAr', label: 'company.addressAr', type: 'textarea', dir: 'rtl' },
      { name: 'company.addressEn', label: 'company.addressEn', type: 'textarea', dir: 'ltr' },
      { name: 'company.phone', label: 'company.phone', type: 'tel', dir: 'ltr' },
      { name: 'company.email', label: 'company.email', type: 'email', dir: 'ltr' },
      { name: 'company.taxNumber', label: 'company.taxNumber', dir: 'ltr' },
      { name: 'company.commercialRegister', label: 'company.commercialRegister', dir: 'ltr' },
      { name: 'company.baseCurrency', label: 'company.baseCurrency', type: 'select', required: true, options: TAYL.currencyOptions('EGP'), value: 'EGP', hint: 'company.baseCurrencyHint' },
      { name: 'company.defaultLanguage', label: 'company.defaultLanguage', type: 'select', required: true, value: window.I18N.lang,
        options: [{ value: 'ar', label: t('lang.ar') }, { value: 'en', label: t('lang.en') }] },
      section('setup.sectionBranch'),
      { name: 'branch.code', label: 'branch.code', required: true, dir: 'ltr', value: 'HQ', hint: 'branch.codeHint', maxlength: 20, full: true },
      { name: 'branch.nameAr', label: 'branch.nameAr', required: true, dir: 'rtl' },
      { name: 'branch.nameEn', label: 'branch.nameEn', required: true, dir: 'ltr' },
      { name: 'branch.addressAr', label: 'branch.addressAr', type: 'textarea', dir: 'rtl' },
      { name: 'branch.addressEn', label: 'branch.addressEn', type: 'textarea', dir: 'ltr' },
      { name: 'branch.phone', label: 'branch.phone', type: 'tel', dir: 'ltr' },
      { name: 'branch.email', label: 'branch.email', type: 'email', dir: 'ltr' },
      section('setup.sectionAdmin'),
      { name: 'admin.username', label: 'user.username', required: true, dir: 'ltr', autocomplete: 'username', hint: 'user.usernameHint', maxlength: 64 },
      { name: 'admin.displayName', label: 'user.displayName', required: true },
      { name: 'admin.password', label: 'user.password', type: 'password', required: true, dir: 'ltr', autocomplete: 'new-password', hint: 'user.passwordHint', maxlength: 128 },
      { name: 'admin.confirm', label: 'user.passwordConfirm', type: 'password', required: true, dir: 'ltr', autocomplete: 'new-password', skip: true, maxlength: 128 },
    ];

    // العناوين الفرعية ليست حقولًا: نبني النموذج ثم نستبدلها بعناوين.
    const real = fields.filter((f) => f.type !== 'heading');
    const f = form({
      fields: real,
      submitKey: 'setup.submit',
      extra: el('div', { class: 'logo-field' },
        el('h3', { class: 'form-section', text: t('setup.sectionLogo') }),
        el('label', { for: 'setup-logo', text: t('company.logo') }), file, el('p', { class: 'hint', text: t('company.logoHint') }), logoErr, preview),
      async onSubmit(v) {
        if (v['admin.password'] !== f.inputs['admin.confirm'].input.value) { f.setErrors({ 'admin.confirm': 'PASSWORD_MISMATCH' }); return; }
        const pick = (p) => Object.fromEntries(Object.entries(v).filter(([k]) => k.startsWith(p + '.')).map(([k, x]) => [k.slice(p.length + 1), x]));
        const body = { company: pick('company'), branch: pick('branch'), admin: pick('admin') };
        if (logo) body.logo = { data: logo };
        await api.post('/api/setup', body);
        await window.I18N.set(body.company.defaultLanguage);
        app.afterSetup(body.admin.username);
      },
    });
    const grid = f.node.querySelector('.grid');
    for (const h of fields.filter((x) => x.type === 'heading')) {
      const next = fields[fields.indexOf(h) + 1];
      grid.insertBefore(el('h3', { class: 'form-section full', text: t(h.label) }), f.inputs[next.name].input.closest('.field'));
    }
    TAYL.ui.fill(root,
      el('h1', { class: 'auth-title', text: t('setup.title') }),
      el('p', { class: 'muted', text: t('setup.intro') }),
      f.node,
    );
  }

  function login(root, app, { message = null, username = '' } = {}) {
    const f = form({
      fields: [
        { name: 'username', label: 'user.username', required: true, dir: 'ltr', autocomplete: 'username', value: username, full: true, maxlength: 64 },
        { name: 'password', label: 'user.password', type: 'password', required: true, dir: 'ltr', autocomplete: 'current-password', full: true, maxlength: 128 },
      ],
      submitKey: 'auth.login',
      enterSubmits: true,   // في شاشة الدخول Enter يرسل (السلوك المتوقع)
      async onSubmit(v) {
        try {
          const s = await api.post('/api/auth/login', v, { quiet401: true });
          app.start(s);
        } catch (e) {
          f.setErrors({}, errorText(e));
          f.inputs.password.input.value = '';
        }
      },
    });
    TAYL.ui.fill(root,
      el('h1', { class: 'auth-title', text: t('auth.title') }),
      el('p', { class: 'muted', text: t('auth.intro') }),
      message ? el('p', { class: 'notice', role: 'status', text: t(message) }) : null,
      f.node,
    );
    (username ? f.inputs.password : f.inputs.username).input.focus();
  }

  return { setup, login };
})();

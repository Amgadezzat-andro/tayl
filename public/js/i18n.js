'use strict';
/* ترجمة + اتجاه الصفحة. لغة الواجهة فقط تُحفظ محليًا (ليست بيانات حساسة). */
window.I18N = (() => {
  const KEY = 'tayl.lang';
  const cache = {};
  let lang = 'ar';
  let stored = false;
  try { const s = localStorage.getItem(KEY); if (s === 'ar' || s === 'en') { lang = s; stored = true; } } catch { /* التخزين غير متاح */ }

  async function load(l) {
    if (!cache[l]) {
      const r = await fetch(`/locales/${l}.json`);
      if (!r.ok) throw new Error('locale load failed');
      cache[l] = await r.json();
    }
    return cache[l];
  }
  /** t('key', { n: 3 }) — يستبدل {n} في النص. المفتاح الناقص يظهر كما هو (يكشفه الاختبار). */
  const t = (k, vars) => {
    let s = (cache[lang] && cache[lang][k]) || k;
    if (vars) for (const [n, v] of Object.entries(vars)) s = s.split(`{${n}}`).join(String(v));
    return s;
  };
  const has = (k) => !!(cache[lang] && cache[lang][k]);

  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('app.title');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  }
  async function set(l, { remember = true } = {}) {
    await load(l);
    lang = l;
    if (remember) { try { localStorage.setItem(KEY, l); stored = true; } catch { /* تجاهل */ } }
    apply();
  }
  return {
    /** إن لم يختر المستخدم لغة من قبل تُستخدم اللغة الافتراضية للشركة. */
    init: (companyDefault) => set(!stored && (companyDefault === 'ar' || companyDefault === 'en') ? companyDefault : lang, { remember: stored }),
    set, t, has,
    get lang() { return lang; },
  };
})();

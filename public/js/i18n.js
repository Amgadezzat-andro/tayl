'use strict';
/* ترجمة + اتجاه الصفحة. لغة الواجهة فقط تُحفظ محليًا (ليست بيانات حساسة). */
window.I18N = (() => {
  const KEY = 'tayl.lang';
  const cache = {};
  let lang = 'ar';
  try { const s = localStorage.getItem(KEY); if (s === 'ar' || s === 'en') lang = s; } catch { /* التخزين غير متاح */ }

  async function load(l) {
    if (!cache[l]) {
      const r = await fetch(`/locales/${l}.json`);
      if (!r.ok) throw new Error('locale load failed');
      cache[l] = await r.json();
    }
    return cache[l];
  }
  const t = (k) => (cache[lang] && cache[lang][k]) || k;

  function apply() {
    document.documentElement.lang = lang;
    document.documentElement.dir = lang === 'ar' ? 'rtl' : 'ltr';
    document.title = t('app.title');
    document.querySelectorAll('[data-i18n]').forEach((el) => { el.textContent = t(el.dataset.i18n); });
  }
  async function set(l) {
    await load(l);
    lang = l;
    try { localStorage.setItem(KEY, l); } catch { /* تجاهل */ }
    apply();
  }
  return { init: () => set(lang), set, t, get lang() { return lang; } };
})();

'use strict';
/*
 * اختصارات لوحة المفاتيح — سجل واحد، فشاشة المساعدة تعرض ما هو منفذ فعلًا فقط.
 *  - اختصارات الشاشة تُسجَّل عند رسمها (setPage) ولا تُسجَّل إلا إذا كانت الصلاحية متاحة.
 *  - Ctrl+S: يحفظ النموذج المفتوح (النافذة أولًا، ثم نموذج الصفحة) — لا يتجاوز الصلاحيات لأنه يضغط زر الحفظ نفسه.
 *  - Ctrl+N / Alt+N: سجل جديد. (بعض المتصفحات تحجز Ctrl+N لنافذة جديدة؛ Alt+N يعمل دائمًا.)
 *  - Ctrl+F: البحث في الشاشة (بدل بحث المتصفح). Shift+? أو F1: دليل الاختصارات.
 *  - Enter في حقول النموذج ينقل للحقل التالي ولا يحفظ (ui.form)، و Esc يغلق القوائم ثم النوافذ.
 */
window.TAYL = window.TAYL || {};
TAYL.keys = (() => {
  let page = [];
  const t = (k) => window.I18N.t(k);
  const isMac = /Mac/.test(navigator.platform || '');

  // الاختصارات العامة (تعمل في كل الشاشات)
  const GLOBAL = [
    { combo: 'Ctrl+S', labelKey: 'keys.save', run: () => save() },
    { combo: 'Escape', labelKey: 'keys.close', run: null },
    { combo: 'Shift+?', alt: 'F1', labelKey: 'keys.help', run: () => help() },
    { combo: 'Tab', labelKey: 'keys.tab', run: null },
    { combo: '↑ ↓ Home End', labelKey: 'keys.arrows', run: null },
    { combo: 'Enter', labelKey: 'keys.enter', run: null },
  ];

  function save() {
    const dlg = document.getElementById('dialog');
    const scope = dlg && dlg.open ? dlg : document.getElementById('page');
    const btn = scope && [...scope.querySelectorAll('form button[type="submit"]')].find((b) => !b.hidden && !b.disabled && b.offsetParent !== null);
    if (btn) { btn.click(); return true; }
    return false;
  }

  /** pageShortcuts: [{ combo: 'Ctrl+N', alt: 'Alt+N', labelKey, run }] */
  function setPage(list) { page = (list || []).filter(Boolean); }

  function matches(e, combo) {
    if (!combo) return false;
    if (combo === 'Shift+?') return e.key === '?';
    if (combo === 'F1' || combo === 'F2') return e.key === combo && !e.ctrlKey && !e.altKey;
    const [mod, k] = combo.split('+');
    if (!k) return false;
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    // e.code يحافظ على المفتاح الفعلي مع لوحة المفاتيح العربية (Ctrl+S = Ctrl+س)
    const code = e.code && e.code.startsWith('Key') ? e.code.slice(3).toLowerCase() : key;
    const want = k.toLowerCase();
    if (mod === 'Ctrl') return (e.ctrlKey || (isMac && e.metaKey)) && !e.altKey && (key === want || code === want);
    if (mod === 'Alt') return e.altKey && !e.ctrlKey && !e.metaKey && (key === want || code === want);
    return false;
  }

  const typing = (el) => el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName));

  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented) return;
    if (!document.getElementById('view-app') || document.getElementById('view-app').hidden) return;
    // ? يُكتب داخل الحقول عاديًا؛ يفتح المساعدة خارجها فقط
    if ((e.key === '?' && !typing(e.target)) || (e.key === 'F1' && !e.ctrlKey)) { e.preventDefault(); help(); return; }
    if (matches(e, 'Ctrl+S')) { e.preventDefault(); save(); return; }
    const dlgOpen = document.getElementById('dialog').open;
    for (const s of page) {
      if (dlgOpen) break;                                     // اختصارات الصفحة لا تعمل خلف نافذة مفتوحة
      if (matches(e, s.combo) || matches(e, s.alt)) {
        if (s.combo === 'F2' && typing(e.target)) continue;   // F2 داخل حقل لا يغيّر السلوك الطبيعي
        e.preventDefault(); s.run(); return;
      }
    }
  });

  function help() {
    const { el, modal } = TAYL.ui;
    const row = (s) => el('tr', null, el('td', null, el('kbd', { dir: 'ltr', text: s.combo }), s.alt ? [' ', t('keys.or'), ' ', el('kbd', { dir: 'ltr', text: s.alt })] : null), el('td', { text: t(s.labelKey) }));
    modal({
      title: t('keys.title'),
      body: el('div', { class: 'keys-help' },
        page.length ? [el('h3', { class: 'form-section', text: t('keys.page') }), el('table', { class: 'data' }, el('tbody', null, page.map(row)))] : null,
        el('h3', { class: 'form-section', text: t('keys.global') }),
        el('table', { class: 'data' }, el('tbody', null, GLOBAL.map(row))),
        el('p', { class: 'hint', text: t('keys.ctrlNNote') })),
    });
  }

  return { setPage, help, save, list: () => [...page, ...GLOBAL] };
})();

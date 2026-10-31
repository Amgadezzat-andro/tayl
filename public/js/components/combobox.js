'use strict';
/*
 * القائمة الذكية القابلة للبحث (Combobox) — مكوّن موحد لكل الشاشات.
 *  - التركيز/الفتح يعرض النتائج، والكتابة تبحث (بالكود والاسم العربي والإنجليزي، جزئيًا) من الخادم مع ترقيم.
 *  - الأسهم للتنقل، Enter للاختيار (دون إرسال النموذج)، Esc للإغلاق (دون إغلاق النافذة)، Home/End.
 *  - الماوس واللمس، ورسالة عند عدم وجود نتائج، وتحميل المزيد عند الوصول لنهاية القائمة.
 *  - ARIA: role=combobox / listbox / option مع aria-activedescendant.
 * للخيارات القليلة الثابتة استخدم <select> العادي بدلًا منه.
 */
window.TAYL = window.TAYL || {};
TAYL.combobox = (() => {
  let seq = 0;
  const t = (k, v) => window.I18N.t(k, v);

  /** مصدر بيانات من مسار lookup قياسي: (q, offset) => { items, hasMore } */
  function lookupSource(base, extra = '') {
    return async (q, offset) => {
      const r = await TAYL.api.get(`${base}/lookup?limit=20&offset=${offset}&q=${encodeURIComponent(q)}${extra ? '&' + extra : ''}`);
      return { items: r.items.map((x) => ({ ...x, label: `${x.code} — ${TAYL.ui.name(x)}` })), hasMore: r.hasMore };
    };
  }

  function create({ source, value = null, placeholderKey = 'combo.placeholder', onChange, id, required, disabled, label }) {
    const { el } = TAYL.ui;
    const uid = 'cb' + (++seq);
    let current = value;            // { id, label }
    let items = []; let active = -1; let hasMore = false; let query = ''; let timer = null; let reqNo = 0; let open = false;

    const input = el('input', {
      id: id || uid + '-i', type: 'text', role: 'combobox', autocomplete: 'off', 'aria-autocomplete': 'list', 'aria-expanded': 'false',
      'aria-controls': uid + '-l', 'aria-label': label, placeholder: t(placeholderKey), required, disabled, class: 'cb-input',
    });
    const list = el('ul', { id: uid + '-l', role: 'listbox', class: 'cb-list', hidden: true });
    const status = el('span', { class: 'sr-only', 'aria-live': 'polite' });
    const clear = el('button', { type: 'button', class: 'cb-clear', tabindex: '-1', 'aria-label': t('combo.clear'), text: '×', hidden: !current || disabled || required });
    const node = el('div', { class: 'cb' }, input, clear, list, status);
    const showValue = () => { input.value = current ? current.label : ''; clear.hidden = !current || disabled || required; };
    showValue();

    function render(loading) {
      list.replaceChildren();
      if (loading && !items.length) list.append(el('li', { class: 'cb-msg', text: t('common.loading') }));
      else if (!items.length) list.append(el('li', { class: 'cb-msg', text: t('combo.noResults') }));
      items.forEach((it, i) => {
        const li = el('li', { id: `${uid}-o${i}`, role: 'option', class: 'cb-opt' + (i === active ? ' active' : '') + (it.disabled ? ' disabled' : ''),
          'aria-selected': String(i === active), 'aria-disabled': it.disabled ? 'true' : null },
        el('span', { class: 'cb-code', dir: 'ltr', text: it.code || '' }), el('span', { text: TAYL.ui.name(it) || it.label }));
        // pointerdown يسبق blur، فالاختيار بالماوس واللمس لا يُفقد
        li.addEventListener('pointerdown', (e) => { e.preventDefault(); choose(i); });
        list.append(li);
      });
      if (hasMore) list.append(el('li', { class: 'cb-msg', text: t('combo.more') }));
      input.setAttribute('aria-activedescendant', active >= 0 ? `${uid}-o${active}` : '');
      const a = list.querySelector('.active');
      if (a) a.scrollIntoView({ block: 'nearest' });
      status.textContent = items.length ? t('combo.count', { n: items.length }) : t('combo.noResults');
    }
    async function load(append = false) {
      const my = ++reqNo;
      if (!append) { items = []; active = -1; render(true); }
      try {
        const r = await source(query, append ? items.length : 0);
        if (my !== reqNo) return;          // نتيجة قديمة تجاوزها بحث أحدث
        items = append ? items.concat(r.items) : r.items;
        hasMore = !!r.hasMore;
        if (!append) active = items.length ? 0 : -1;
        render(false);
      } catch { if (my === reqNo) { items = []; hasMore = false; render(false); } }
    }
    function openList() {
      if (open || disabled) return;
      open = true; list.hidden = false; input.setAttribute('aria-expanded', 'true');
      query = ''; load();
    }
    function closeList(revert = true) {
      if (!open) return;
      open = false; list.hidden = true; input.setAttribute('aria-expanded', 'false'); input.removeAttribute('aria-activedescendant');
      if (revert) showValue();
    }
    function choose(i) {
      const it = items[i];
      if (!it || it.disabled) return;
      current = { ...it };
      closeList(false); showValue();
      if (onChange) onChange(current);
    }
    function move(d) {
      if (!items.length) return;
      active = Math.max(0, Math.min(items.length - 1, active + d));
      render(false);
      if (active >= items.length - 2 && hasMore) load(true);
    }

    input.addEventListener('focus', () => { input.select(); });
    input.addEventListener('click', openList);
    input.addEventListener('input', () => {
      if (!open) { open = true; list.hidden = false; input.setAttribute('aria-expanded', 'true'); }
      query = input.value.trim();
      clearTimeout(timer); timer = setTimeout(() => load(), 150);
    });
    input.addEventListener('keydown', (e) => {
      if (e.isComposing) return;
      switch (e.key) {
        case 'ArrowDown': e.preventDefault(); if (!open) openList(); else move(1); break;
        case 'ArrowUp': e.preventDefault(); if (open) move(-1); break;
        case 'PageDown': if (open) { e.preventDefault(); move(8); } break;
        case 'PageUp': if (open) { e.preventDefault(); move(-8); } break;
        case 'Home': if (open && items.length) { e.preventDefault(); active = 0; render(false); } break;
        case 'End': if (open && items.length) { e.preventDefault(); active = items.length - 1; render(false); } break;
        case 'Enter':
          // Enter داخل القائمة = اختيار فقط، لا يرسل النموذج ولا ينتقل
          if (open) { e.preventDefault(); e.stopPropagation(); if (active >= 0) choose(active); }
          break;
        case 'Escape':
          if (open) { e.preventDefault(); e.stopPropagation(); closeList(); }
          break;
        case 'Tab': closeList(); break;
        default:
      }
    });
    input.addEventListener('blur', () => closeList());
    list.addEventListener('scroll', () => { if (hasMore && list.scrollTop + list.clientHeight >= list.scrollHeight - 24) load(true); });
    clear.addEventListener('click', () => { current = null; showValue(); input.focus(); if (onChange) onChange(null); });

    return {
      node, input,
      get value() { return current; },
      set(v) { current = v; showValue(); },
      focus: () => input.focus(),
      setDisabled(v) { disabled = v; input.disabled = v; showValue(); },
    };
  }

  return { create, lookupSource };
})();

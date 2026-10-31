'use strict';
/*
 * أدوات الواجهة: بناء العناصر بـ textContent فقط (لا innerHTML ⇒ لا حقن HTML)، النماذج، الجداول، النوافذ، والتنبيهات.
 * لا نصوص ثابتة هنا: كل نص يأتي من مفاتيح الترجمة.
 */
window.TAYL = window.TAYL || {};
TAYL.ui = (() => {
  const t = (k, v) => window.I18N.t(k, v);

  function el(tag, attrs, ...children) {
    const n = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v === null || v === undefined || v === false) continue;
      if (k === 'class') n.className = v;
      else if (k === 'text') n.textContent = v;
      else if (k === 'on') for (const [ev, fn] of Object.entries(v)) n.addEventListener(ev, fn);
      else if (['value', 'checked', 'selected', 'disabled', 'hidden', 'required', 'multiple'].includes(k)) n[k] = v;
      else n.setAttribute(k, v === true ? '' : String(v));
    }
    for (const c of children.flat(Infinity)) {
      if (c === null || c === undefined || c === false) continue;
      n.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return n;
  }

  /** رسالة خطأ مترجمة من رمز الخادم. */
  function errorText(e) {
    const code = e && e.code ? e.code : 'INTERNAL';
    if (code === 'TOO_MANY_ATTEMPTS' && e.details && e.details.retryAfterSeconds) {
      return t('err.TOO_MANY_ATTEMPTS_WAIT', { min: Math.ceil(e.details.retryAfterSeconds / 60) });
    }
    return window.I18N.has('err.' + code) ? t('err.' + code) : t('err.generic', { code });
  }
  const fieldErrorText = (code) => (window.I18N.has('val.' + code) ? t('val.' + code) : t('val.INVALID'));

  // ── التنبيهات ──
  let toastTimer = null;
  function toast(msg, kind = 'ok') {
    const box = document.getElementById('toast');
    box.textContent = msg;
    box.className = 'toast ' + kind;
    box.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { box.hidden = true; }, 4000);
  }

  // ── النوافذ ──
  function modal({ title, body, actions = [], wide = false }) {
    const dlg = document.getElementById('dialog');
    dlg.className = wide ? 'dialog wide' : 'dialog';
    const close = () => { if (dlg.open) dlg.close(); };
    // replaceChildren يحوّل null إلى النص "null"، فنمرر العناصر الموجودة فقط.
    dlg.replaceChildren(...[
      el('div', { class: 'dialog-head' }, el('h2', { text: title }), el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), text: '×', on: { click: close } })),
      el('div', { class: 'dialog-body' }, body),
      actions.length ? el('div', { class: 'dialog-actions' }, actions) : null,
    ].filter(Boolean));
    if (!dlg.open) dlg.showModal();
    return close;
  }
  function confirm(message, { okKey = 'common.confirm', danger = false } = {}) {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v) => { if (!done) { done = true; close(); resolve(v); } };
      const close = modal({
        title: t('common.confirmTitle'),
        body: el('p', { text: message }),
        actions: [
          el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => finish(false) } }),
          el('button', { class: danger ? 'btn danger' : 'btn primary', type: 'button', text: t(okKey), on: { click: () => finish(true) } }),
        ],
      });
      document.getElementById('dialog').addEventListener('close', () => finish(false), { once: true });
    });
  }

  // ── النماذج ──
  /**
   * fields: [{ name, label, type, required, options, value, dir, hint, min, max, autocomplete, disabled, full }]
   * type: text | email | tel | password | textarea | select | checkbox | number | checks (قائمة اختيارات متعددة)
   * الاسم = مفتاح الـ API نفسه، فأخطاء الخادم تُعرض تحت الحقل الصحيح تلقائيًا.
   */
  function form({ fields, submitKey = 'common.save', onSubmit, onCancel, readOnly = false, extra = null }) {
    const inputs = {};
    const errs = {};
    const alert = el('p', { class: 'form-alert', role: 'alert', hidden: true });

    function control(f) {
      const id = 'f-' + f.name.replace(/[^a-zA-Z0-9]/g, '-') + '-' + Math.random().toString(36).slice(2, 7);
      const common = { id, name: f.name, disabled: readOnly || f.disabled, required: f.required, dir: f.dir, autocomplete: f.autocomplete || 'off' };
      let input;
      if (f.type === 'textarea') input = el('textarea', { ...common, rows: 2, maxlength: f.maxlength || 500 });
      else if (f.type === 'select') {
        input = el('select', common, (f.options || []).map((o) => el('option', { value: o.value, text: o.label })));
      } else if (f.type === 'checkbox') input = el('input', { ...common, type: 'checkbox', checked: !!f.value });
      else if (f.type === 'checks') {
        input = el('div', { class: 'checks', id, role: 'group' }, (f.options || []).map((o) => el('label', { class: 'check' },
          el('input', { type: 'checkbox', value: o.value, checked: (f.value || []).includes(o.value), disabled: readOnly || f.disabled || o.disabled }), el('span', { text: o.label }))));
      } else input = el('input', { ...common, type: f.type || 'text', min: f.min, max: f.max, maxlength: f.maxlength || 200, inputmode: f.inputmode });
      if (f.type !== 'checkbox' && f.type !== 'checks' && f.value !== undefined && f.value !== null) input.value = String(f.value);
      inputs[f.name] = { f, input };
      errs[f.name] = el('p', { class: 'field-error', hidden: true });
      if (f.onChange) input.addEventListener('change', () => f.onChange(input));
      const label = el('label', { for: f.type === 'checks' ? null : id, class: f.required ? 'req' : null, text: t(f.label) });
      if (f.type === 'checkbox') {
        return el('div', { class: 'field field-check' + (f.full ? ' full' : '') }, el('label', { class: 'check' }, input, el('span', { text: t(f.label) })), f.hint ? el('p', { class: 'hint', text: t(f.hint) }) : null, errs[f.name]);
      }
      return el('div', { class: 'field' + (f.full || f.type === 'textarea' || f.type === 'checks' ? ' full' : '') }, label, input, f.hint ? el('p', { class: 'hint', text: t(f.hint) }) : null, errs[f.name]);
    }

    function values() {
      const out = {};
      for (const [name, { f, input }] of Object.entries(inputs)) {
        if (f.skip) continue;
        if (f.type === 'checkbox') out[name] = input.checked;
        else if (f.type === 'checks') out[name] = [...input.querySelectorAll('input:checked')].map((x) => (f.numeric ? Number.parseInt(x.value, 10) : x.value));
        else if (f.type === 'number') out[name] = input.value === '' ? null : Number.parseInt(input.value, 10);
        else if (f.numeric) out[name] = input.value === '' ? null : Number.parseInt(input.value, 10);
        else out[name] = input.value;
      }
      return out;
    }

    function setErrors(fieldErrors = {}, general = null) {
      for (const [name, p] of Object.entries(errs)) {
        const code = fieldErrors[name];
        p.hidden = !code;
        p.textContent = code ? fieldErrorText(code) : '';
        const i = inputs[name].input;
        if (code) i.setAttribute('aria-invalid', 'true'); else i.removeAttribute('aria-invalid');
      }
      const unknown = Object.keys(fieldErrors).filter((k) => !errs[k]);
      const msg = general || (unknown.length ? unknown.map((k) => `${k}: ${fieldErrorText(fieldErrors[k])}`).join(' — ') : null);
      alert.hidden = !msg;
      alert.textContent = msg || '';
      const first = Object.keys(fieldErrors).find((k) => inputs[k]);
      if (first) inputs[first].input.focus();
    }

    const submit = el('button', { class: 'btn primary', type: 'submit', text: t(submitKey), hidden: readOnly });
    const node = el('form', { class: 'form', novalidate: true },
      el('div', { class: 'grid' }, fields.map(control)),
      extra,
      alert,
      el('div', { class: 'form-actions' }, onCancel ? el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: onCancel } }) : null, submit),
    );
    node.addEventListener('submit', async (ev) => {
      ev.preventDefault();
      setErrors({});
      submit.disabled = true;
      try { await onSubmit(values(), api); } catch (e) {
        if (e && e.code === 'VALIDATION') setErrors(e.fields, Object.keys(e.fields).some((k) => inputs[k]) ? null : errorText(e));
        else if (e && e.fields && Object.keys(e.fields).length) setErrors(e.fields, errorText(e));
        else if (e && e.code) setErrors({}, errorText(e));
        else throw e;
      } finally { submit.disabled = false; }
    });
    const api = { node, values, setErrors, inputs };
    return api;
  }

  /** columns: [{ label, render(row) => نص أو عنصر, cls }] */
  function table({ columns, rows, emptyKey = 'common.empty' }) {
    if (!rows.length) return el('p', { class: 'muted empty', text: t(emptyKey) });
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', null, el('tr', null, columns.map((c) => el('th', { class: c.cls, text: t(c.label) })))),
      el('tbody', null, rows.map((r) => el('tr', { class: r.isActive === false ? 'inactive' : null }, columns.map((c) => el('td', { class: c.cls }, c.render(r))))))));
  }

  const badge = (key, kind = '') => el('span', { class: 'badge ' + kind, text: t(key) });
  const locale = () => (window.I18N.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');   // أرقام لاتينية للمحاسبين
  function dateTime(iso) {
    if (!iso) return '—';
    const d = new Date(typeof iso === 'number' ? iso : String(iso).replace(' ', 'T'));
    return Number.isNaN(d.getTime()) ? String(iso) : d.toLocaleString(locale(), { dateStyle: 'medium', timeStyle: 'short' });
  }
  /** اسم الكيان بلغة الواجهة. */
  const name = (o) => (o ? (window.I18N.lang === 'ar' ? o.nameAr : o.nameEn) || o.nameAr || o.nameEn : '—');

  function panel(titleKey, ...children) {
    return el('section', { class: 'panel' }, titleKey ? el('h2', { text: t(titleKey) }) : null, children);
  }
  function pageHead(titleKey, ...actions) {
    return el('div', { class: 'page-head' }, el('h2', { class: 'page-title', text: t(titleKey) }), el('div', { class: 'page-actions' }, actions));
  }
  const button = (key, onClick, cls = 'btn') => el('button', { class: cls, type: 'button', text: t(key), on: { click: onClick } });

  /** يستبدل محتوى العنصر متجاهلًا الأجزاء الشرطية الفارغة (replaceChildren وحده يكتب null كنص). */
  function fill(node, ...children) {
    node.replaceChildren(...children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false));
    return node;
  }

  /** قراءة ملف صورة كـ base64 (بلا بادئة data:). */
  function readFileBase64(file) {
    return new Promise((resolve, reject) => {
      const r = new FileReader();
      r.onload = () => resolve(String(r.result).replace(/^data:[^,]*,/, ''));
      r.onerror = () => reject(r.error);
      r.readAsDataURL(file);
    });
  }

  return { el, t, fill, errorText, fieldErrorText, toast, modal, confirm, form, table, badge, dateTime, name, panel, pageHead, button, readFileBase64, locale };
})();

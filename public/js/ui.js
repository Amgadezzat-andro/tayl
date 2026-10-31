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
    // يعود التركيز لما كان عليه قبل فتح النافذة (زر، صف في الجدول...)
    const prev = dlg.open ? null : document.activeElement;
    dlg.addEventListener('close', () => { if (prev && prev.isConnected && typeof prev.focus === 'function') prev.focus(); }, { once: true });
    const close = () => { if (dlg.open) dlg.close(); };
    // replaceChildren يحوّل null إلى النص "null"، فنمرر العناصر الموجودة فقط.
    dlg.replaceChildren(...[
      el('div', { class: 'dialog-head' }, el('h2', { text: title }), el('button', { class: 'icon-btn', type: 'button', 'aria-label': t('common.close'), text: '×', on: { click: close } })),
      el('div', { class: 'dialog-body' }, body),
      actions.length ? el('div', { class: 'dialog-actions' }, actions) : null,
    ].filter(Boolean));
    if (!dlg.open) dlg.showModal();
    const first = dlg.querySelector('.dialog-body input:not([disabled]):not([type="hidden"]), .dialog-body select:not([disabled]), .dialog-body textarea:not([disabled])');
    if (first) first.focus();
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
  function form({ fields, submitKey = 'common.save', onSubmit, onCancel, readOnly = false, extra = null, enterSubmits = false }) {
    const inputs = {};
    const wrappers = {};
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
      else if (f.type === 'combobox') {
        const cb = TAYL.combobox.create({ source: f.source, value: f.value || null, id, required: f.required, disabled: readOnly || f.disabled, label: t(f.label),
          onChange: (v) => { if (f.onChange) f.onChange(v); refresh(); } });
        inputs[f.name] = { f, input: cb.input, cb };
        errs[f.name] = el('p', { class: 'field-error', hidden: true });
        wrappers[f.name] = el('div', { class: 'field' + (f.full ? ' full' : '') }, el('label', { for: id, class: f.required ? 'req' : null, text: t(f.label) }), cb.node, f.hint ? el('p', { class: 'hint', text: t(f.hint) }) : null, errs[f.name]);
        return wrappers[f.name];
      } else if (f.type === 'custom') {
        const c = f.render({ readOnly });
        inputs[f.name] = { f, input: c.focusEl || c.node, custom: c };
        errs[f.name] = el('p', { class: 'field-error', hidden: true });
        wrappers[f.name] = el('div', { class: 'field full' }, el('span', { class: 'label', text: t(f.label) }), c.node, f.hint ? el('p', { class: 'hint', text: t(f.hint) }) : null, errs[f.name]);
        return wrappers[f.name];
      } else if (f.type === 'checks') {
        input = el('div', { class: 'checks', id, role: 'group' }, (f.options || []).map((o) => el('label', { class: 'check' },
          el('input', { type: 'checkbox', value: o.value, checked: (f.value || []).includes(o.value), disabled: readOnly || f.disabled || o.disabled }), el('span', { text: o.label }))));
      } else input = el('input', { ...common, type: f.type || 'text', min: f.min, max: f.max, maxlength: f.maxlength || 200, inputmode: f.inputmode });
      if (f.type !== 'checkbox' && f.type !== 'checks' && f.value !== undefined && f.value !== null) input.value = String(f.value);
      inputs[f.name] = { f, input };
      errs[f.name] = el('p', { class: 'field-error', hidden: true });
      input.addEventListener('change', () => { if (f.onChange) f.onChange(input); refresh(); });
      const label = el('label', { for: f.type === 'checks' ? null : id, class: f.required ? 'req' : null, text: t(f.label) });
      if (f.type === 'checkbox') {
        wrappers[f.name] = el('div', { class: 'field field-check' + (f.full ? ' full' : '') }, el('label', { class: 'check' }, input, el('span', { text: t(f.label) })), f.hint ? el('p', { class: 'hint', text: t(f.hint) }) : null, errs[f.name]);
        return wrappers[f.name];
      }
      wrappers[f.name] = el('div', { class: 'field' + (f.full || f.type === 'textarea' || f.type === 'checks' ? ' full' : '') }, label, input, f.hint ? el('p', { class: 'hint', text: t(f.hint) }) : null, errs[f.name]);
      return wrappers[f.name];
    }
    /** الحقول الشرطية (showIf) تُخفى ولا تُرسل قيمتها. */
    function refresh() {
      const v = rawValues();
      for (const [name, { f }] of Object.entries(inputs)) if (f.showIf && wrappers[name]) wrappers[name].hidden = !f.showIf(v);
    }

    function rawValues() {
      const out = {};
      for (const [name, { f, input, cb, custom }] of Object.entries(inputs)) {
        if (cb) out[name] = cb.value ? cb.value.id : null;
        else if (custom) out[name] = custom.value();
        else if (f.type === 'checkbox') out[name] = input.checked;
        else if (f.type === 'checks') out[name] = [...input.querySelectorAll('input:checked')].map((x) => (f.numeric ? Number.parseInt(x.value, 10) : x.value));
        else if (f.type === 'number' || f.numeric) out[name] = input.value === '' ? null : Number.parseInt(input.value, 10);
        else out[name] = input.value;
      }
      return out;
    }
    function values() {
      const out = {};
      for (const [name, { f, input, cb, custom }] of Object.entries(inputs)) {
        if (f.skip || (wrappers[name] && wrappers[name].hidden)) continue;
        if (cb) out[name] = cb.value ? cb.value.id : null;
        else if (custom) out[name] = custom.value();
        else if (f.type === 'checkbox') out[name] = input.checked;
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
    // Enter في حقل نص ينقل للحقل التالي ولا يحفظ (الحفظ بالزر أو Ctrl+S) — يمنع الحفظ غير المقصود
    node.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter' || ev.isComposing || enterSubmits || ev.defaultPrevented) return;
      const tg = ev.target;
      if (tg.tagName !== 'INPUT' || ['checkbox', 'radio', 'file', 'submit', 'button'].includes(tg.type)) return;
      ev.preventDefault();
      const focusables = [...node.querySelectorAll('input, select, textarea, button')].filter((x) => !x.disabled && x.offsetParent !== null && x.tabIndex >= 0 && x.type !== 'hidden');
      const i = focusables.indexOf(tg);
      if (i >= 0 && focusables[i + 1]) focusables[i + 1].focus();
    });
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
    const api = { node, values, setErrors, inputs, refresh };
    refresh();
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

  /** تنزيل ملف من الخادم (Excel) مع رسالة خطأ مترجمة عند الرفض. */
  async function download(url, filename) {
    try {
      const r = await fetch(url, { credentials: 'same-origin' });
      if (!r.ok) { let e = null; try { e = (await r.json()).error; } catch { /* */ } throw new TAYL.api.ApiError(r.status, e); }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob); a.download = filename;
      document.body.append(a); a.click(); a.remove();
      setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    } catch (e) { toast(errorText(e), 'bad'); }
  }

  /** طباعة جدول بيانات من الخادم (بصلاحية print) في صفحة طباعة نظيفة باتجاه اللغة. */
  async function printFrom(url) {
    let d;
    try { d = await TAYL.api.get(url); } catch (e) { toast(errorText(e), 'bad'); return; }
    const area = document.getElementById('print-area');
    fill(area,
      el('h1', { text: d.title }),
      el('p', { class: 'muted', text: dateTime(Date.now()) }),
      el('table', { class: 'data' }, el('thead', null, el('tr', null, d.columns.map((c) => el('th', { text: c })))),
        el('tbody', null, d.rows.map((r) => el('tr', null, r.map((c) => el('td', { text: c })))))));
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); area.replaceChildren(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }

  /**
   * استيراد Excel بخطوتين: اختيار الملف ⇒ معاينة كل الصفوف وأخطائها ⇒ الحفظ متاح فقط إن لم يوجد أي خطأ.
   * base: مسار الوحدة (مثل /api/accounts) ؛ onDone بعد الحفظ.
   */
  function importDialog({ base, titleKey, onDone }) {
    let data = null;
    const out = el('div', { class: 'import-out' });
    const file = el('input', { type: 'file', accept: '.xlsx,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', id: 'imp-file' });
    const commit = el('button', { class: 'btn primary', type: 'button', text: t('import.commit'), disabled: true });
    const tpl = button('import.template', () => download(`${base}/import/template.xlsx?lang=${window.I18N.lang}`, 'template.xlsx'), 'btn small');
    file.addEventListener('change', async () => {
      const f = file.files[0];
      commit.disabled = true; out.replaceChildren();
      if (!f) return;
      data = await readFileBase64(f);
      try {
        const r = await TAYL.api.post(`${base}/import/preview`, { data });
        renderPreview(r);
        commit.disabled = r.summary.invalid > 0 || r.summary.total === 0;
      } catch (e) { out.replaceChildren(el('p', { class: 'form-alert', text: errorText(e) + (e.details && e.details.missing ? ': ' + e.details.missing.join(', ') : '') })); }
    });
    function renderPreview(r) {
      const errText = (es) => es.map((x) => `${x.field}: ${window.I18N.has('val.' + x.code) ? t('val.' + x.code) : t('err.generic', { code: x.code })}`).join(' — ');
      const keys = r.rows.length ? Object.keys(r.rows[0].values) : [];
      fill(out,
        el('p', { class: r.summary.invalid ? 'form-alert' : 'notice', text: t('import.summary', r.summary) }),
        el('div', { class: 'table-wrap import-table' }, el('table', { class: 'data' },
          el('thead', null, el('tr', null, el('th', { text: t('import.line') }), keys.map((k) => el('th', { dir: 'ltr', text: k })), el('th', { text: t('import.errors') }))),
          el('tbody', null, r.rows.map((row) => el('tr', { class: row.errors.length ? 'row-error' : null },
            el('td', { text: String(row.line) }), keys.map((k) => el('td', { text: row.values[k] })), el('td', { class: 'err-cell', text: errText(row.errors) })))))));
    }
    commit.addEventListener('click', async () => {
      commit.disabled = true;
      try {
        const r = await TAYL.api.post(`${base}/import/commit`, { data });
        close(); toast(t('import.done', { n: r.created })); if (onDone) onDone();
      } catch (e) {
        if (e.code === 'IMPORT_HAS_ERRORS') renderPreview({ summary: e.details.summary, rows: e.details.rows });
        else toast(errorText(e), 'bad');
      }
    });
    const close = modal({
      title: t(titleKey), wide: true,
      body: el('div', { class: 'import' }, el('p', { class: 'muted', text: t('import.intro') }), el('div', { class: 'inline-form' }, el('label', { for: 'imp-file', text: t('import.file') }), file, tpl), out),
      actions: [button('common.cancel', () => close()), commit],
    });
  }

  return { el, t, fill, errorText, download, printFrom, importDialog, fieldErrorText, toast, modal, confirm, form, table, badge, dateTime, name, panel, pageHead, button, readFileBase64, locale };
})();

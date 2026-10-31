'use strict';
/*
 * إعدادات النظام: الجلسات والدخول، وسياسة الدقة الحسابية.
 * كل حساب للمعاينة يتم على الخادم بالمحرك المركزي؛ الواجهة لا تجري أي عملية حسابية على المبالغ.
 */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.settings = (() => {
  const { el, t, form, pageHead, panel, toast, button, errorText } = TAYL.ui;
  const api = TAYL.api;
  const range = (a, b) => Array.from({ length: b - a + 1 }, (_, i) => a + i);

  function securityPanel(app, s) {
    const canEdit = app.can('settings.update');
    const f = form({
      readOnly: !canEdit,
      fields: Object.keys(s.values).map((k) => ({
        name: k, label: 'settings.' + k, type: 'number', required: true, value: s.values[k], min: s.limits[k].min, max: s.limits[k].max, inputmode: 'numeric', dir: 'ltr',
        hint: null,
      })),
      async onSubmit(v) { await api.put('/api/settings', v); toast(t('common.saved')); app.rerender(); },
    });
    for (const k of Object.keys(s.values)) {
      const p = el('p', { class: 'hint', text: t('settings.range', { min: s.limits[k].min, max: s.limits[k].max, def: s.limits[k].default }) });
      f.inputs[k].input.after(p);
    }
    return panel('settings.security', f.node);
  }

  function precisionPanel(app, p) {
    const canEdit = app.can('precision.update');
    const storage = Object.fromEntries(p.kinds.map((k) => [k.kind, k.storageScale]));
    let rows = p.rows.map((r) => ({ ...r }));
    const body = el('tbody');
    const alert = el('p', { class: 'form-alert', role: 'alert', hidden: true });

    const sel = (values, current, onChange, label) => {
      const s = el('select', { disabled: !canEdit, 'aria-label': label }, values.map((v) => el('option', { value: String(v.value ?? v), text: v.label ?? String(v) })));
      s.value = String(current);
      s.addEventListener('change', () => onChange(s.value));
      return s;
    };

    function draw() {
      TAYL.ui.fill(body, ...rows.map((r, i) => el('tr', { class: r.currency ? 'override' : null },
        el('td', { text: t('kind.' + r.kind) }),
        el('td', { dir: 'ltr', text: r.currency || t('precision.allCurrencies') }),
        el('td', { class: 'c', dir: 'ltr', text: String(storage[r.kind]) }),
        el('td', { class: 'c' }, sel(range(0, storage[r.kind]), r.commitScale, (v) => { r.commitScale = Number.parseInt(v, 10); if (r.displayScale > r.commitScale) r.displayScale = r.commitScale; draw(); }, t('precision.commitScale'))),
        el('td', { class: 'c' }, sel(range(0, r.commitScale), r.displayScale, (v) => { r.displayScale = Number.parseInt(v, 10); }, t('precision.displayScale'))),
        el('td', null, sel(p.roundingModes.map((m) => ({ value: m, label: t('rounding.' + m) })), r.rounding, (v) => { r.rounding = v; }, t('precision.rounding'))),
        el('td', { class: 'actions' }, canEdit && r.currency ? button('common.remove', () => { rows.splice(i, 1); draw(); }, 'btn small danger') : null),
      )));
    }
    draw();

    // إضافة تخصيص لعملة معينة
    const kindSel = el('select', { 'aria-label': t('precision.kind') }, p.kinds.map((k) => el('option', { value: k.kind, text: t('kind.' + k.kind) })));
    const curSel = el('select', { 'aria-label': t('precision.currency') }, TAYL.CURRENCIES.map((c) => el('option', { value: c, text: c })));
    const addRow = el('div', { class: 'inline-form' }, kindSel, curSel, button('precision.addOverride', () => {
      if (rows.some((r) => r.kind === kindSel.value && r.currency === curSel.value)) { alert.textContent = t('precision.duplicate'); alert.hidden = false; return; }
      const base = rows.find((r) => r.kind === kindSel.value && !r.currency);
      rows.push({ ...base, currency: curSel.value });
      alert.hidden = true; draw();
    }, 'btn small'));

    const save = button('common.save', async () => {
      alert.hidden = true;
      try {
        await api.put('/api/precision', { rows });
        toast(t('common.saved')); app.rerender();
      } catch (e) {
        alert.textContent = e.code === 'VALIDATION'
          ? Object.entries(e.fields).map(([k, c]) => { const r = rows[Number.parseInt(k.split('.')[1], 10)]; return `${r ? t('kind.' + r.kind) + ' ' + (r.currency || '') : k}: ${TAYL.ui.fieldErrorText(c)}`; }).join(' — ')
          : errorText(e);
        alert.hidden = false;
      }
    }, 'btn primary');

    return panel('precision.title',
      el('p', { class: 'muted', text: t('precision.intro') }),
      el('ul', { class: 'levels' },
        el('li', null, el('strong', { text: t('precision.level.storage') }), ' — ', t('precision.level.storageDesc')),
        el('li', null, el('strong', { text: t('precision.level.intermediate') }), ' — ', t('precision.level.intermediateDesc', { n: p.intermediatePrecision })),
        el('li', null, el('strong', { text: t('precision.level.commit') }), ' — ', t('precision.level.commitDesc')),
        el('li', null, el('strong', { text: t('precision.level.display') }), ' — ', t('precision.level.displayDesc'))),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
        el('thead', null, el('tr', null, ['precision.kind', 'precision.currency', 'precision.storageScale', 'precision.commitScale', 'precision.displayScale', 'precision.rounding', 'common.actions']
          .map((k) => el('th', { text: t(k) })))),
        body)),
      canEdit ? el('div', { class: 'precision-tools' }, addRow, el('p', { class: 'hint', text: t('precision.changeNote') }), alert, el('div', { class: 'form-actions' }, save)) : el('p', { class: 'notice', text: t('common.readOnly') }),
      previewTool(p),
    );
  }

  function previewTool(p) {
    const out = el('dl', { class: 'facts preview-out', hidden: true });
    const f = form({
      submitKey: 'precision.previewRun',
      fields: [
        { name: 'kind', label: 'precision.kind', type: 'select', options: p.kinds.map((k) => ({ value: k.kind, label: t('kind.' + k.kind) })) },
        { name: 'currency', label: 'precision.currency', type: 'select', options: [{ value: '', label: t('precision.allCurrencies') }, ...TAYL.CURRENCIES.map((c) => ({ value: c, label: c }))] },
        { name: 'value', label: 'precision.previewValue', required: true, dir: 'ltr', inputmode: 'decimal', hint: 'precision.previewHint', maxlength: 80 },
      ],
      async onSubmit(v) {
        const r = await api.post('/api/precision/preview', { kind: v.kind, value: v.value.trim(), ...(v.currency ? { currency: v.currency } : {}) });
        const fact = (k, val) => el('div', null, el('dt', { text: t(k) }), el('dd', { dir: 'ltr', text: val }));
        TAYL.ui.fill(out,
          fact('precision.previewInput', r.input), fact('precision.previewCommitted', r.committed),
          fact('precision.previewStored', r.stored), fact('precision.previewDisplay', r.display),
          fact('precision.rounding', t('rounding.' + r.policy.rounding)),
        );
        out.hidden = false;
      },
    });
    return el('div', { class: 'preview' }, el('h3', { class: 'form-section', text: t('precision.preview') }), f.node, out);
  }

  async function render(root, app) {
    const [s, p] = await Promise.all([
      app.can('settings.view') ? api.get('/api/settings') : Promise.resolve(null),
      app.can('precision.view') ? api.get('/api/precision') : Promise.resolve(null),
    ]);
    TAYL.ui.fill(root, pageHead('nav.settings'), s ? securityPanel(app, s) : null, p ? precisionPanel(app, p) : null);
  }

  return { key: 'nav.settings', perm: ['settings.view', 'precision.view'], render };
})();

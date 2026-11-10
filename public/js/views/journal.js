'use strict';
/*
 * القيود اليومية (المرحلة 3): القائمة، القيود الافتتاحية، محرر المسودة، تفاصيل القيد (ترحيل/عكس/طباعة)، وسلاسل الترقيم.
 *  - الواجهة لا تحسب أي مبلغ: المجاميع والمبالغ الأساسية والفرق من الخادم (/api/journal/preview) بنفس دالة محرك الترحيل.
 *  - الأزرار تظهر حسب الصلاحية للراحة فقط؛ الخادم يتحقق من كل طلب.
 *  - زر الترحيل/العكس يُعطَّل أثناء الطلب (لا ضغط مكرر)، والخادم يرفض الترحيل الثاني أصلًا (NOT_DRAFT / ALREADY_REVERSED).
 */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, fill, panel, pageHead, button, badge, modal, form, toast, confirm, errorText, name, dateTime, fieldErrorText } = TAYL.ui;
  const api = TAYL.api;
  const params = () => new URLSearchParams((location.hash.split('?')[1]) || '');
  const go = (hash) => { location.hash = hash; };
  const lineName = (l) => `${l.accountCode} — ${window.I18N.lang === 'ar' ? l.accountNameAr : l.accountNameEn}`;
  const ccName = (l) => (l.costCenterCode ? `${l.costCenterCode} — ${window.I18N.lang === 'ar' ? l.costCenterNameAr : l.costCenterNameEn}` : '');
  const num = (text) => el('span', { class: 'num', dir: 'ltr', text });

  /** شارة الحالة: مسودة / مرحّل / معكوس / عكسي / افتتاحي. */
  function statusBadges(e) {
    return [
      e.status === 'draft' ? badge('journal.status.draft', 'muted') : badge('journal.status.posted', 'ok'),
      e.reversedBy ? badge('journal.status.reversed', 'bad') : null,
      e.entryType === 'reversal' ? badge('journal.type.reversal', 'warn') : null,
      e.entryType === 'opening' ? badge('journal.type.opening', 'gold') : null,
    ];
  }
  /** زر لا يُضغط مرتين: يُعطَّل حتى ينتهي الطلب. */
  function once(key, run, cls) {
    const b = button(key, async () => {
      if (b.disabled) return;
      b.disabled = true;
      try { await run(); } finally { if (b.isConnected) b.disabled = false; }
    }, cls);
    return b;
  }
  async function ledgerStatus() { try { return await api.get('/api/ledger/status'); } catch { return { today: new Date().toISOString().slice(0, 10), firstYearStart: null }; } }

  // ── القائمة ──
  function listView({ key, fixedType = null, intro }) {
    const state = { status: '', type: fixedType || '', from: '', to: '', q: '', branch: '' };
    async function render(root, app) {
      const can = (a) => app.can('journal.' + a);
      const holder = el('div');
      const more = el('div');
      let offset = 0;
      const sel = (k, opts) => {
        const s = el('select', { 'aria-label': t('journal.filter.' + k) }, opts.map(([v, l]) => el('option', { value: v, text: l })));
        s.value = state[k]; s.addEventListener('change', () => { state[k] = s.value; reload(); });
        return s;
      };
      const date = (k) => {
        const i = el('input', { type: 'date', value: state[k], 'aria-label': t('journal.filter.' + k), dir: 'ltr' });
        i.addEventListener('change', () => { state[k] = i.value; reload(); });
        return i;
      };
      const search = el('input', { type: 'search', class: 'search', id: 'page-search', value: state.q, placeholder: t('journal.searchHint'), 'aria-label': t('common.search') });
      let timer = null;
      search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { state.q = search.value.trim(); reload(); }, 250); });
      const branches = app.session.branches;
      const filters = el('div', { class: 'filters' }, search,
        sel('status', [['', t('common.allStatuses')], ['draft', t('journal.status.draft')], ['posted', t('journal.status.posted')], ['reversed', t('journal.status.reversed')]]),
        fixedType ? null : sel('type', [['', t('journal.filter.allTypes')], ['general', t('journal.type.general')], ['opening', t('journal.type.opening')], ['reversal', t('journal.type.reversal')]]),
        branches.length > 1 ? sel('branch', [['', t('ledger.allBranches')], ...branches.map((b) => [String(b.id), b.code])]) : null,
        el('label', { class: 'inline-label', text: t('journal.filter.from') }), date('from'), el('label', { class: 'inline-label', text: t('journal.filter.to') }), date('to'));
      const open = (r) => go('#/journalEntry?id=' + r.id);
      let rows = [];
      async function load(append) {
        const qs = new URLSearchParams({ ...Object.fromEntries(Object.entries(state).filter(([, v]) => v)), limit: '50', offset: String(offset) });
        const r = await api.get('/api/journal?' + qs);
        rows = append ? rows.concat(r.items) : r.items;
        fill(holder, TAYL.grid.create({
          rows, caption: t(key), emptyKey: 'journal.none', onOpen: open,
          columns: [
            { label: 'ledger.date', render: (e) => el('span', { dir: 'ltr', text: e.entryDate }), sortValue: (e) => e.entryDate },
            { label: 'ledger.number', render: (e) => (e.number ? el('code', { dir: 'ltr', text: e.number }) : el('span', { class: 'muted', text: t('journal.noNumber') })), sortValue: (e) => e.number || '' },
            { label: 'journal.type', render: (e) => t('journal.type.' + e.entryType) },
            { label: 'ledger.description', render: (e) => e.description },
            { label: 'branch.code', render: (e) => el('code', { dir: 'ltr', text: e.branchCode }) },
            { label: 'journal.total', cls: 'num-col', render: (e) => (e.totalText ? num(e.totalText) : '—') },
            { label: 'common.status', render: (e) => statusBadges(e) },
            { label: 'journal.relation', render: (e) => (e.reverses ? t('journal.reversesShort', { number: e.reverses.number }) : e.reversedBy ? t('journal.reversedByShort', { number: e.reversedBy.number }) : '') },
            { label: 'common.actions', cls: 'actions', sortable: false, render: (e) => button('common.view', () => open(e), 'btn small') },
          ],
        }).node);
        fill(more, r.hasMore ? button('journal.loadMore', () => { offset += 50; load(true); }, 'btn small') : null);
      }
      const reload = () => { offset = 0; load(false).catch((e) => toast(errorText(e), 'bad')); };
      const newEntry = () => go('#/journalEntry?new=' + (fixedType || 'general'));
      const canNew = can('create') && (fixedType !== 'opening' || can('opening'));
      TAYL.keys.setPage([canNew ? { combo: 'Ctrl+N', alt: 'Alt+N', labelKey: 'keys.new', run: newEntry } : null,
        { combo: 'Ctrl+F', labelKey: 'keys.search', run: () => search.focus() }]);
      await load(false);
      fill(root,
        pageHead(key, canNew ? button(fixedType === 'opening' ? 'journal.newOpening' : 'journal.new', newEntry, 'btn primary') : null,
          !fixedType && can('create') && can('opening') ? button('journal.newOpening', () => go('#/journalEntry?new=opening'), 'btn') : null,
          button('keys.button', () => TAYL.keys.help(), 'btn small')),
        intro ? el('p', { class: 'muted', text: t(intro) }) : null,
        panel(null, filters, holder, more));
    }
    return render;
  }

  TAYL.views.journal = { key: 'nav.journal', perm: 'journal.view', render: listView({ key: 'nav.journal', intro: 'journal.intro' }) };
  TAYL.views.openingEntries = { key: 'nav.openingEntries', perm: 'journal.view', render: listView({ key: 'nav.openingEntries', fixedType: 'opening', intro: 'journal.openingIntro' }) };

  // ── المحرر (إنشاء/تعديل مسودة) ──
  async function editor(root, app, entry, type) {
    const status = await ledgerStatus();
    const curList = (await api.get('/api/currencies/lookup?limit=50')).items.filter((c) => c.isActive !== false);
    const base = curList.find((c) => c.isBase) || curList[0];
    const canRate = app.can('journal.override_rate');
    const isOpening = (entry ? entry.entryType : type) === 'opening';
    const alert = el('p', { class: 'form-alert', role: 'alert', hidden: true });
    const showAlert = (msg) => { alert.hidden = !msg; alert.textContent = msg || ''; };

    // الرأس
    const hdr = {
      entryDate: el('input', { type: 'date', id: 'je-date', required: true, dir: 'ltr', value: entry ? entry.entryDate : (isOpening ? status.firstYearStart || '' : status.today), disabled: isOpening }),
      branchId: el('select', { id: 'je-branch' }, app.session.branches.map((b) => el('option', { value: String(b.id), text: `${b.code} — ${name(b)}` }))),
      defaultCurrencyId: el('select', { id: 'je-currency' }, curList.map((c) => el('option', { value: String(c.id), text: c.code }))),
      description: el('input', { type: 'text', id: 'je-desc', required: true, maxlength: 500, value: entry ? entry.description : '' }),
      reference: el('input', { type: 'text', id: 'je-ref', maxlength: 100, value: entry && entry.reference ? entry.reference : '' }),
      futureDateConfirmed: el('input', { type: 'checkbox', id: 'je-future', checked: entry ? entry.futureDateConfirmed : false }),
    };
    hdr.branchId.value = String(entry ? entry.branchId : (app.session.branch ? app.session.branch.id : app.session.branches[0] && app.session.branches[0].id));
    hdr.defaultCurrencyId.value = String(entry ? entry.defaultCurrencyId : base.id);
    const futureWrap = el('label', { class: 'check', hidden: true }, hdr.futureDateConfirmed, el('span', { text: t('journal.confirmFuture') }));
    const field = (id, key, input, req) => el('div', { class: 'field' }, el('label', { for: id, class: req ? 'req' : null, text: t(key) }), input);

    // السطور
    const body = el('tbody');
    const rows = [];
    const accSource = TAYL.combobox.lookupSource('/api/accounts', 'usable=1');
    const ccSource = TAYL.combobox.lookupSource('/api/cost-centers', 'usable=1');
    function addRow(l = {}, after = null) {
      const r = { manual: !!(l.rateSource === 'manual') };
      r.account = TAYL.combobox.create({ source: accSource, value: l.accountId ? { id: l.accountId, label: lineName(l) } : null, label: t('ledger.account'), onChange: schedule });
      r.cc = TAYL.combobox.create({ source: ccSource, value: l.costCenterId ? { id: l.costCenterId, label: ccName(l) } : null, label: t('ledger.costCenter'), onChange: schedule });
      // «—» = عملة القيد الافتراضية (التلميح يوضحها)
      r.currency = el('select', { 'aria-label': t('ledger.currency'), title: t('journal.headerCurrency'), class: 'cur' }, [el('option', { value: '', text: '—' }), ...curList.map((c) => el('option', { value: String(c.id), text: c.code }))]);
      r.currency.value = l.currencyId && String(l.currencyId) !== hdr.defaultCurrencyId.value ? String(l.currencyId) : '';
      const amt = (k, v) => el('input', { type: 'text', inputmode: 'decimal', dir: 'ltr', class: 'amt ' + k, maxlength: 40, value: v && v !== '0' ? v : '', 'aria-label': t('ledger.' + k) });
      r.debit = amt('debit', l.debitFc); r.credit = amt('credit', l.creditFc);
      r.desc = el('input', { type: 'text', class: 'desc', maxlength: 300, value: l.description || '', 'aria-label': t('ledger.description') });
      r.rate = el('input', { type: 'text', inputmode: 'decimal', dir: 'ltr', class: 'rate', maxlength: 30, value: r.manual ? l.rate : '', readOnly: !r.manual, 'aria-label': t('ledger.rate'), placeholder: '—' });
      r.reason = el('input', { type: 'text', class: 'reason', maxlength: 500, value: r.manual ? l.rateReason || '' : '', placeholder: t('journal.rateReason'), 'aria-label': t('journal.rateReason'), hidden: !r.manual });
      r.manualBtn = canRate ? el('button', { type: 'button', class: 'btn small icon', title: t('journal.manualRate'), 'aria-label': t('journal.manualRate'), text: '✎', on: { click: () => setManual(r, !r.manual) } }) : null;
      r.baseCell = el('td', { class: 'num-col base' });
      r.tr = el('tr', null,
        el('td', { class: 'ln' }), el('td', { class: 'acc' }, r.account.node), el('td', { class: 'cc' }, r.cc.node), el('td', null, r.desc), el('td', null, r.currency),
        el('td', { class: 'rate-cell' }, el('div', { class: 'rate-wrap' }, r.rate, r.manualBtn), r.reason), el('td', null, r.debit), el('td', null, r.credit), r.baseCell,
        el('td', { class: 'actions' }, el('button', { type: 'button', class: 'btn small danger icon', title: t('journal.removeLine'), 'aria-label': t('journal.removeLine'), text: '×', on: { click: () => removeRow(r) } })));
      for (const i of [r.currency, r.debit, r.credit, r.rate, r.reason, r.desc]) i.addEventListener('input', schedule);
      r.currency.addEventListener('change', () => { if (r.manual) setManual(r, false); schedule(); });
      // كتابة مدين تمسح الدائن والعكس (طرف واحد)
      r.debit.addEventListener('input', () => { if (r.debit.value.trim()) r.credit.value = ''; });
      r.credit.addEventListener('input', () => { if (r.credit.value.trim()) r.debit.value = ''; });
      const i = after ? rows.indexOf(after) + 1 : rows.length;
      rows.splice(i, 0, r);
      if (after) after.tr.after(r.tr); else body.append(r.tr);
      number();
      return r;
    }
    function setManual(r, on) {
      r.manual = on; r.rate.readOnly = !on; r.reason.hidden = !on;
      if (!on) { r.rate.value = ''; r.reason.value = ''; } else r.rate.focus();
      schedule();
    }
    function removeRow(r) {
      if (rows.length <= 2) { r.account.set(null); r.cc.set(null); r.debit.value = ''; r.credit.value = ''; r.desc.value = ''; schedule(); return; }
      rows.splice(rows.indexOf(r), 1); r.tr.remove(); number(); schedule();
    }
    const number = () => rows.forEach((r, i) => { r.tr.firstChild.textContent = String(i + 1); });
    const lineBody = (r) => ({
      accountId: r.account.value ? r.account.value.id : null, costCenterId: r.cc.value ? r.cc.value.id : null,
      currencyId: r.currency.value ? Number.parseInt(r.currency.value, 10) : undefined,
      debit: r.debit.value.trim() || undefined, credit: r.credit.value.trim() || undefined, description: r.desc.value.trim() || undefined,
      ...(r.manual ? { rate: r.rate.value.trim() || undefined, rateReason: r.reason.value.trim() || undefined } : {}),
    });
    const isEmpty = (r) => !r.account.value && !r.debit.value.trim() && !r.credit.value.trim();
    const header = () => ({
      entryDate: hdr.entryDate.value, branchId: Number.parseInt(hdr.branchId.value, 10), defaultCurrencyId: Number.parseInt(hdr.defaultCurrencyId.value, 10),
      description: hdr.description.value.trim(), reference: hdr.reference.value.trim() || undefined, futureDateConfirmed: hdr.futureDateConfirmed.checked,
      ...(entry ? {} : { entryType: isOpening ? 'opening' : 'general' }),
    });

    // المعاينة من الخادم
    const totals = el('div', { class: 'je-totals', 'aria-live': 'polite' });
    let pvTimer = null; let pvSeq = 0;
    function schedule() { clearTimeout(pvTimer); pvTimer = setTimeout(previewNow, 300); }
    async function previewNow() {
      const my = ++pvSeq;
      futureWrap.hidden = !(hdr.entryDate.value && hdr.entryDate.value > status.today);
      if (!hdr.entryDate.value) return;
      const lines = rows.map((r) => (isEmpty(r) ? { } : lineBody(r)));
      let p;
      try { p = await api.post('/api/journal/preview', { entryDate: hdr.entryDate.value, defaultCurrencyId: Number.parseInt(hdr.defaultCurrencyId.value, 10), lines }); } catch (e) {
        if (my === pvSeq) fill(totals, el('span', { class: 'form-alert', text: errorText(e) })); return;
      }
      if (my !== pvSeq) return;
      const byIdx = new Map(p.lines.map((l) => [l.index, l]));
      const errIdx = new Map(p.errors.map((x) => [x.index, x]));
      rows.forEach((r, i) => {
        const l = byIdx.get(i); const er = errIdx.get(i);
        if (!r.manual) r.rate.value = l && l.rateSource !== 'base' ? l.rate : '';
        fill(r.baseCell, l ? [num(l.baseText), l.baseZero ? el('span', { class: 'badge bad', text: t('err.BASE_AMOUNT_ZERO') }) : null] : er ? el('span', { class: 'field-error', text: errLine(er) }) : '');
      });
      fill(totals,
        el('span', null, t('ledger.totalDebit'), ' ', num(p.totalDebitText)),
        el('span', null, t('ledger.totalCredit'), ' ', num(p.totalCreditText)),
        el('span', { class: p.balanced ? 'ok' : 'bad' }, t('ledger.difference'), ' ', num(p.differenceText), ' ', p.baseCurrency),
        p.foreign ? el('span', { class: p.foreign.balanced ? 'ok' : 'bad' }, `${p.foreign.currency}: `, num(p.foreign.totalDebitText), ' / ', num(p.foreign.totalCreditText)) : null,
        badge(p.balanced ? 'journal.balanced' : 'journal.unbalanced', p.balanced ? 'ok' : 'bad'));
    }
    const errLine = (er) => (er.fields ? Object.values(er.fields).map(fieldErrorText).join(t('common.listSep')) : errorText(er));

    // لوحة المفاتيح: Enter ينقل للخلية التالية ويضيف سطرًا في النهاية؛ Insert يضيف بعد السطر؛ Ctrl+Delete يحذف السطر
    body.addEventListener('keydown', (e) => {
      if (e.defaultPrevented || e.isComposing) return;
      const tr = e.target.closest('tr'); const r = rows.find((x) => x.tr === tr);
      if (!r) return;
      if (e.key === 'Insert' || (e.altKey && (e.key === 'l' || e.code === 'KeyL'))) { e.preventDefault(); addRow({}, r).account.focus(); return; }
      if (e.key === 'Delete' && e.ctrlKey) { e.preventDefault(); const i = rows.indexOf(r); removeRow(r); (rows[Math.min(i, rows.length - 1)] || rows[0]).account.focus(); return; }
      if (e.key !== 'Enter' || e.target.tagName === 'BUTTON') return;
      e.preventDefault();
      const cells = [...tr.querySelectorAll('input:not([readonly]):not([hidden]), select')].filter((x) => !x.disabled && x.offsetParent !== null);
      const i = cells.indexOf(e.target);
      if (i >= 0 && cells[i + 1]) { cells[i + 1].focus(); return; }
      const ri = rows.indexOf(r);
      if (rows[ri + 1]) rows[ri + 1].account.focus();
      else if (!isEmpty(r)) addRow().account.focus();
    });

    (entry ? entry.lines : [{}, {}]).forEach((l) => addRow(l));
    for (const i of Object.values(hdr)) i.addEventListener('change', schedule);
    hdr.defaultCurrencyId.addEventListener('change', () => rows.forEach((r) => { if (r.manual && !r.currency.value) setManual(r, false); }));
    hdr.entryDate.addEventListener('change', () => rows.forEach((r) => r.manual && setManual(r, false)));   // تغيير التاريخ يُسقط السعر اليدوي

    async function save(thenPost) {
      showAlert(null);
      body.querySelectorAll('[aria-invalid]').forEach((x) => x.removeAttribute('aria-invalid'));
      const kept = rows.filter((r) => !isEmpty(r));
      const payload = { ...header(), lines: kept.map(lineBody) };
      // الواجهة تُسقط السعر اليدوي عند تغيير التاريخ أو العملة؛ أي سعر يدوي باقٍ هنا أكّده المستخدم صراحة
      if (kept.some((r) => r.manual)) payload.reconfirmManualRates = true;
      try {
        const saved = entry ? await api.put('/api/journal/' + entry.id, payload) : await api.post('/api/journal', payload);
        if (thenPost) {
          try { await api.post(`/api/journal/${saved.id}/post`, {}); toast(t('journal.posted')); } catch (e) { toast(t('common.saved') + ' — ' + errorText(e), 'bad'); }
        } else toast(t('common.saved'));
        go('#/journalEntry?id=' + saved.id);
      } catch (e) {
        const f = e.fields || {};
        const msgs = [];
        for (const [k, code] of Object.entries(f)) {
          const m = /^lines\.(\d+)\.(\w+)$/.exec(k);
          if (m && kept[Number(m[1])]) {
            const r = kept[Number(m[1])];
            const target = { accountId: r.account.input, costCenterId: r.cc.input, debit: r.debit, credit: r.credit, rate: r.rate, rateReason: r.reason, currencyId: r.currency, description: r.desc }[m[2]];
            if (target) target.setAttribute('aria-invalid', 'true');
            msgs.push(`${t('journal.line')} ${rows.indexOf(r) + 1}: ${fieldErrorText(code)}`);
          } else if (hdr[k]) { hdr[k].setAttribute('aria-invalid', 'true'); msgs.push(`${t('journal.field.' + k)}: ${fieldErrorText(code)}`); } else msgs.push(fieldErrorText(code));
        }
        const lineNo = e.details && e.details.line ? ` (${t('journal.line')} ${e.details.line})` : '';
        showAlert(msgs.length ? msgs.join(' — ') : errorText(e) + lineNo);
      }
    }
    const f = el('form', { class: 'form je-form', novalidate: true },
      el('div', { class: 'grid' },
        field('je-date', 'ledger.date', hdr.entryDate, true), field('je-branch', 'journal.branch', hdr.branchId, true),
        field('je-currency', 'journal.defaultCurrency', hdr.defaultCurrencyId, true), field('je-ref', 'ledger.reference', hdr.reference),
        el('div', { class: 'field full' }, el('label', { for: 'je-desc', class: 'req', text: t('ledger.description') }), hdr.description), futureWrap),
      isOpening ? el('p', { class: 'notice', text: t('journal.openingHint', { date: status.firstYearStart || '—' }) }) : null,
      el('div', { class: 'table-wrap je-lines' }, el('table', { class: 'data' },
        el('thead', null, el('tr', null, ['#', 'ledger.account', 'ledger.costCenter', 'ledger.description', 'ledger.currency', 'ledger.rate', 'ledger.debit', 'ledger.credit', 'journal.baseAmount', '']
          .map((k) => el('th', { text: k === '#' ? '#' : k === '' ? '' : k === 'journal.baseAmount' ? `${t(k)} (${base.code})` : t(k) })))), body)),
      el('div', { class: 'je-bar' }, button('journal.addLine', () => addRow().account.focus(), 'btn small'), el('span', { class: 'hint', text: t('journal.keysHint') })),
      totals, alert,
      el('div', { class: 'form-actions' },
        button('common.cancel', () => go(entry ? '#/journalEntry?id=' + entry.id : (isOpening ? '#/openingEntries' : '#/journal')), 'btn'),
        app.can('journal.post') ? once('journal.saveAndPost', async () => {
          if (await confirm(t('journal.confirmPost'))) await save(true);
        }, 'btn') : null,
        el('button', { type: 'submit', class: 'btn primary', text: t('journal.saveDraft') })));
    let saving = false;
    f.addEventListener('submit', async (ev) => { ev.preventDefault(); if (saving) return; saving = true; try { await save(false); } finally { saving = false; } });
    // Enter في حقول الرأس ينقل للحقل التالي ولا يحفظ
    f.querySelector('.grid').addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || e.target.tagName !== 'INPUT' || e.target.type === 'checkbox') return;
      e.preventDefault();
      const all = [...f.querySelectorAll('.grid input:not([disabled]), .grid select')].filter((x) => x.offsetParent !== null);
      const i = all.indexOf(e.target);
      if (all[i + 1]) all[i + 1].focus(); else rows[0].account.focus();
    });
    TAYL.keys.setPage([
      { combo: 'Alt+L', alt: 'Insert', labelKey: 'journal.addLine', run: () => addRow().account.focus() },
      { combo: 'Ctrl+Delete', labelKey: 'journal.removeLine', run: () => {} },
    ]);
    fill(root,
      pageHead(entry ? 'journal.editDraft' : (isOpening ? 'journal.newOpening' : 'journal.new'), button('keys.button', () => TAYL.keys.help(), 'btn small')),
      el('p', { class: 'muted', text: t(isOpening ? 'journal.openingIntro' : 'journal.editorIntro') }),
      panel(null, f));
    previewNow();
    setTimeout(() => (entry ? rows[0].account.focus() : hdr.description.focus()), 0);
  }

  // ── التفاصيل ──
  async function detail(root, app, id) {
    const e = await api.get('/api/journal/' + id);
    const can = (a) => app.can('journal.' + a);
    const reload = () => app.rerender();
    const L = (k, v) => el('div', null, el('dt', { text: t(k) }), el('dd', null, v));
    const totalsRow = e.totals ? el('tr', { class: 'total-row' }, el('td', { colspan: '7', text: t('ledger.total') }), el('td', { class: 'num-col' }, num(e.totals.debitText)), el('td', { class: 'num-col' }, num(e.totals.creditText))) : null;
    const lines = el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
      el('thead', null, el('tr', null, ['#', 'ledger.account', 'ledger.costCenter', 'ledger.description', 'ledger.currency', 'ledger.rate', 'ledger.amountFc', 'ledger.debit', 'ledger.credit'].map((k) => el('th', { text: k === '#' ? '#' : t(k) })))),
      el('tbody', null, e.lines.map((l) => el('tr', null,
        el('td', { text: String(l.lineNo) }), el('td', { text: lineName(l) }), el('td', { text: ccName(l) }), el('td', { text: l.description || '' }),
        el('td', null, el('code', { dir: 'ltr', text: l.currencyCode })),
        el('td', null, num(l.rate), l.rateSource === 'manual' ? el('span', { class: 'badge warn', title: l.rateReason, text: t('journal.rateManual') }) : null),
        el('td', { class: 'num-col' }, num(l.debitFc !== '0' ? l.display.debitFc : l.display.creditFc)),
        el('td', { class: 'num-col' }, e.status === 'posted' ? num(l.display.debit) : '—'), el('td', { class: 'num-col' }, e.status === 'posted' ? num(l.display.credit) : '—')))),
      totalsRow ? el('tfoot', null, totalsRow) : null));
    const draftTotals = el('div', { class: 'je-totals' });
    if (e.status === 'draft') {
      api.post('/api/journal/preview', { entryDate: e.entryDate, defaultCurrencyId: e.defaultCurrencyId, lines: e.lines.map((l) => ({ currencyId: l.currencyId, debit: l.debitFc !== '0' ? l.debitFc : undefined, credit: l.creditFc !== '0' ? l.creditFc : undefined, ...(l.rateSource === 'manual' ? { rate: l.rate, rateReason: l.rateReason } : {}) })) })
        .then((p) => fill(draftTotals, el('span', null, t('ledger.totalDebit'), ' ', num(p.totalDebitText)), el('span', null, t('ledger.totalCredit'), ' ', num(p.totalCreditText)),
          el('span', { class: p.balanced ? 'ok' : 'bad' }, t('ledger.difference'), ' ', num(p.differenceText), ' ', p.baseCurrency), badge(p.balanced ? 'journal.balanced' : 'journal.unbalanced', p.balanced ? 'ok' : 'bad')))
        .catch(() => {});
    }
    const act = async (fn) => { try { await fn(); } catch (x) { toast(errorText(x) + (x.details && x.details.line ? ` (${t('journal.line')} ${x.details.line})` : ''), 'bad'); } };
    const actions = [
      e.status === 'draft' && e.entryType !== 'reversal' && can('update') ? button('common.edit', () => go(`#/journalEntry?id=${e.id}&edit=1`), 'btn') : null,
      e.status === 'draft' && can('post') ? once('journal.post', () => act(async () => {
        if (!(await confirm(t('journal.confirmPost')))) return;
        await api.post(`/api/journal/${e.id}/post`, {}); toast(t('journal.posted')); reload();
      }), 'btn primary') : null,
      e.status === 'draft' && can('delete') ? once('common.delete', () => act(async () => {
        if (!(await confirm(t('journal.confirmDelete'), { danger: true, okKey: 'common.delete' }))) return;
        await api.del('/api/journal/' + e.id); toast(t('common.deleted')); go(e.entryType === 'opening' ? '#/openingEntries' : '#/journal');
      }), 'btn danger') : null,
      e.status === 'posted' && e.entryType !== 'reversal' && !e.reversedBy && app.can('journal.reverse') ? button('journal.reverse', () => reverseDialog(e), 'btn danger') : null,
      can('print') ? button('common.print', () => act(async () => printVoucher(await api.get(`/api/journal/${e.id}/print`))), 'btn small') : null,
    ];
    TAYL.keys.setPage([
      e.status === 'draft' && can('update') && e.entryType !== 'reversal' ? { combo: 'F2', labelKey: 'common.edit', run: () => go(`#/journalEntry?id=${e.id}&edit=1`) } : null,
    ]);
    fill(root,
      pageHead('journal.entry', ...actions, button('journal.backToList', () => go(e.entryType === 'opening' ? '#/openingEntries' : '#/journal'), 'btn small')),
      panel(null,
        el('div', { class: 'je-head' }, el('h2', { class: 'je-number', dir: 'ltr', text: e.number || t('journal.noNumber') }), statusBadges(e)),
        el('dl', { class: 'facts' },
          L('ledger.date', el('span', { dir: 'ltr', text: e.entryDate })), L('journal.type', t('journal.type.' + e.entryType)),
          L('journal.branch', `${e.branch.code} — ${name(e.branch)}`), L('ledger.description', e.description), L('ledger.reference', e.reference || '—'),
          L('journal.createdBy', `${e.createdByName || '—'} · ${dateTime(e.createdAt)}`),
          e.postedAt ? L('journal.postedBy', `${e.postedByName || '—'} · ${dateTime(e.postedAt)}`) : null,
          e.reverses ? L('journal.reverses', el('a', { href: '#/journalEntry?id=' + e.reverses.id, dir: 'ltr', text: e.reverses.number })) : null,
          e.reason ? L('journal.reverseReason', e.reason) : null,
          e.reversedBy ? L('journal.reversedBy', el('a', { href: '#/journalEntry?id=' + e.reversedBy.id, dir: 'ltr', text: e.reversedBy.number })) : null)),
      panel(null, lines, e.status === 'draft' ? draftTotals : null));
  }

  function reverseDialog(e) {
    const f = form({
      submitKey: 'journal.reverse',
      fields: [
        { name: 'date', label: 'journal.reverseDate', type: 'date', value: '', hint: 'journal.reverseDateHint' },
        { name: 'reason', label: 'journal.reverseReason', type: 'textarea', required: true, full: true },
        { name: 'confirmFutureDate', label: 'journal.confirmFuture', type: 'checkbox', value: false },
      ],
      async onSubmit(v) {
        const r = await api.post(`/api/journal/${e.id}/reverse`, { reason: v.reason, ...(v.date ? { date: v.date } : {}), confirmFutureDate: v.confirmFutureDate });
        close(); toast(t('journal.reversed', { number: r.number })); go('#/journalEntry?id=' + r.id);
      },
    });
    const close = modal({ title: `${t('journal.reverse')} — ${e.number}`, body: el('div', null, el('p', { class: 'notice warn', text: t('journal.reverseIntro') }), f.node) });
  }

  /** طباعة سند القيد من بياناته المعروضة (نفس منطقة الطباعة المشتركة). */
  function printVoucher(e) {
    const area = document.getElementById('print-area');
    fill(area,
      el('h1', { text: `${t('journal.voucher')} ${e.number || t('journal.noNumber')}` }),
      el('p', { text: `${t('ledger.date')}: ${e.entryDate} — ${t('journal.branch')}: ${e.branch.code} — ${t('journal.type.' + e.entryType)}${e.status === 'draft' ? ' — ' + t('journal.status.draft') : ''}` }),
      el('p', { text: e.description }),
      el('table', { class: 'data' }, el('thead', null, el('tr', null, ['ledger.account', 'ledger.costCenter', 'ledger.currency', 'ledger.rate', 'ledger.amountFc', 'ledger.debit', 'ledger.credit'].map((k) => el('th', { text: t(k) })))),
        el('tbody', null, e.lines.map((l) => el('tr', null, el('td', { text: lineName(l) }), el('td', { text: ccName(l) }), el('td', { text: l.currencyCode }), el('td', { text: l.rate }),
          el('td', { text: l.debitFc !== '0' ? l.display.debitFc : l.display.creditFc }), el('td', { text: l.display.debit }), el('td', { text: l.display.credit })))),
        e.totals ? el('tfoot', null, el('tr', null, el('td', { colspan: '5', text: t('ledger.total') }), el('td', { text: e.totals.debitText }), el('td', { text: e.totals.creditText }))) : null),
      el('p', { class: 'muted', text: `${t('journal.createdBy')}: ${e.createdByName || '—'}${e.postedByName ? ' — ' + t('journal.postedBy') + ': ' + e.postedByName : ''} — ${dateTime(Date.now())}` }));
    document.body.classList.add('printing');
    const done = () => { document.body.classList.remove('printing'); area.replaceChildren(); window.removeEventListener('afterprint', done); };
    window.addEventListener('afterprint', done);
    window.print();
    setTimeout(done, 1000);
  }

  TAYL.views.journalEntry = {
    key: 'journal.entry', perm: 'journal.view',
    async render(root, app) {
      const p = params();
      if (p.get('new')) {
        if (!app.can('journal.create')) return go('#/journal');
        return editor(root, app, null, p.get('new') === 'opening' ? 'opening' : 'general');
      }
      const id = Number.parseInt(p.get('id'), 10);
      if (!Number.isSafeInteger(id)) return go('#/journal');
      if (p.get('edit') === '1' && app.can('journal.update')) {
        const e = await api.get('/api/journal/' + id);
        if (e.status === 'draft' && e.entryType !== 'reversal') return editor(root, app, e);
      }
      return detail(root, app, id);
    },
  };

  // ── سلاسل الترقيم ──
  TAYL.views.documentSeries = {
    key: 'nav.documentSeries', perm: 'document_series.view',
    async render(root, app) {
      const list = await api.get('/api/document-series');
      const can = (a) => app.can('document_series.' + a);
      const reload = () => app.rerender();
      const DOC_TYPES = ['journal', 'journal_opening', 'journal_reversal'];
      function edit(s) {
        const locked = s && s.isUsed;
        const f = form({
          fields: [
            { name: 'code', label: 'series.code', value: s && s.code, required: true, dir: 'ltr', maxlength: 10, disabled: locked },
            { name: 'docType', label: 'series.docType', type: 'select', value: s ? s.docType : 'journal', options: DOC_TYPES.map((d) => ({ value: d, label: t('series.doc.' + d) })), disabled: locked },
            { name: 'nameAr', label: 'common.nameAr', value: s && s.nameAr, required: true, maxlength: 120 },
            { name: 'nameEn', label: 'common.nameEn', value: s && s.nameEn, required: true, maxlength: 120 },
            { name: 'prefix', label: 'series.prefix', value: s && s.prefix, required: true, dir: 'ltr', maxlength: 10, disabled: locked, hint: 'series.prefixHint' },
            { name: 'perBranch', label: 'series.perBranch', type: 'checkbox', value: s ? s.perBranch : true, disabled: locked },
            { name: 'resetYearly', label: 'series.resetYearly', type: 'checkbox', value: s ? s.resetYearly : true, disabled: locked },
            { name: 'padding', label: 'series.padding', type: 'number', min: 4, max: 10, value: s ? s.padding : 6, disabled: locked },
            { name: 'isDefault', label: 'series.isDefault', type: 'checkbox', value: s ? s.isDefault : false, disabled: s && s.isDefault },
          ],
          onCancel: () => close(),
          async onSubmit(v) {
            const b = { ...v };
            if (locked) for (const k of ['code', 'docType', 'prefix', 'perBranch', 'resetYearly', 'padding']) delete b[k];
            if (s && s.isDefault) delete b.isDefault;
            if (s) await api.put('/api/document-series/' + s.id, b); else await api.post('/api/document-series', b);
            close(); toast(t('common.saved')); reload();
          },
        });
        const close = modal({ title: t(s ? 'series.edit' : 'series.add') + (s ? ` — ${s.code}` : ''), wide: true,
          body: el('div', null, locked ? el('p', { class: 'notice warn', text: t('series.lockedHint') }) : null, f.node) });
      }
      const grid = TAYL.grid.create({
        rows: list, caption: t('nav.documentSeries'),
        columns: [
          { label: 'series.code', render: (s) => el('code', { dir: 'ltr', text: s.code }) },
          { label: 'common.name', render: (s) => name(s) },
          { label: 'series.docType', render: (s) => t('series.doc.' + s.docType) },
          { label: 'series.example', render: (s) => el('code', { dir: 'ltr', text: s.example }) },
          { label: 'series.scope', render: (s) => [s.perBranch ? t('series.perBranch') : t('series.company'), ' · ', s.resetYearly ? t('series.resetYearly') : t('series.continuous')] },
          { label: 'common.status', render: (s) => [badge(s.isActive ? 'common.active' : 'common.inactive', s.isActive ? 'ok' : 'muted'), s.isDefault ? badge('series.isDefault', 'gold') : null, s.isUsed ? badge('series.used', 'warn') : null] },
          { label: 'common.actions', cls: 'actions', sortable: false, render: (s) => [
            can('update') ? button('common.edit', () => edit(s), 'btn small') : null,
            can('disable') && !s.isDefault ? button(s.isActive ? 'common.disable' : 'common.enable', async () => {
              try { await api.post(`/api/document-series/${s.id}/status`, { active: !s.isActive }); toast(t('common.saved')); reload(); } catch (e) { toast(errorText(e), 'bad'); }
            }, 'btn small') : null] },
        ],
        onOpen: (s) => can('update') && edit(s),
      });
      TAYL.keys.setPage([can('create') ? { combo: 'Ctrl+N', alt: 'Alt+N', labelKey: 'keys.new', run: () => edit(null) } : null]);
      fill(root, pageHead('nav.documentSeries', can('create') ? button('series.add', () => edit(null), 'btn primary') : null),
        el('p', { class: 'muted', text: t('series.intro') }), panel(null, grid.node));
    },
  };
})();

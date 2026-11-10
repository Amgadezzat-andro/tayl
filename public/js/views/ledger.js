'use strict';
/*
 * تقارير الأستاذ العام (المرحلة 3): دفتر اليومية، كشف الحساب، ميزان المراجعة.
 * كل الأرقام والأرصدة والإجماليات من الخادم (gl_entries + المحرك العشري) ونصوص العرض منسقة هناك؛ الواجهة لا تحسب شيئًا.
 * شريط «غير نهائي» يظهر بأسبابه، والطباعة والتصدير يحملان الختم نفسه من الخادم.
 */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, fill, panel, pageHead, button, badge, toast, errorText, name } = TAYL.ui;
  const api = TAYL.api;
  const num = (text) => el('span', { class: 'num', dir: 'ltr', text });
  const params = () => new URLSearchParams((location.hash.split('?')[1]) || '');

  /** شريط النهائية (المقترح 7.3). */
  function finalityBar(f) {
    if (!f) return null;
    if (f.final) return el('p', { class: 'notice', text: t('ledger.final') });
    return el('div', { class: 'notice warn finality', role: 'status' }, el('strong', { text: t('ledger.notFinal') }),
      el('ul', null, f.reasons.map((r) => el('li', { text: t('ledger.reason.' + r.code) + (r.years ? ` (${r.years.join(t('common.listSep'))})` : '') }))));
  }

  /** مرشحات مشتركة: السنة المالية أو من/إلى، والفرع، (ومركز التكلفة اختياريًا). */
  async function filterBar(app, state, { costCenter = false, extra = [] } = {}) {
    const years = await api.get('/api/fiscal-years').catch(() => []);
    if (!state.from || !state.to) {
      const today = new Date().toISOString().slice(0, 10);
      const y = years.find((x) => x.startDate <= today && x.endDate >= today) || years[0];
      state.from = state.from || (y ? y.startDate : today.slice(0, 4) + '-01-01');
      state.to = state.to || (y ? y.endDate : today.slice(0, 4) + '-12-31');
    }
    const from = el('input', { type: 'date', dir: 'ltr', value: state.from, id: 'r-from', 'aria-label': t('journal.filter.from') });
    const to = el('input', { type: 'date', dir: 'ltr', value: state.to, id: 'r-to', 'aria-label': t('journal.filter.to') });
    const year = el('select', { 'aria-label': t('ledger.fiscalYear') }, [el('option', { value: '', text: t('ledger.fiscalYear') }), ...years.map((y) => el('option', { value: y.id, text: `${y.code} (${y.startDate} → ${y.endDate})` }))]);
    year.addEventListener('change', () => { const y = years.find((x) => String(x.id) === year.value); if (y) { from.value = y.startDate; to.value = y.endDate; } });
    const branches = app.session.branches;
    const branch = el('select', { 'aria-label': t('journal.branch') }, [el('option', { value: 'all', text: t('ledger.allBranches') }), ...branches.map((b) => el('option', { value: String(b.id), text: `${b.code} — ${name(b)}` }))]);
    branch.value = state.branch || 'all';
    let cc = null;
    if (costCenter) cc = TAYL.combobox.create({ source: TAYL.combobox.lookupSource('/api/cost-centers'), value: state.cc || null, label: t('ledger.costCenter'), placeholderKey: 'ledger.anyCostCenter' });
    const read = () => {
      state.from = from.value; state.to = to.value; state.branch = branch.value; state.cc = cc && cc.value ? cc.value : null;
      const q = new URLSearchParams({ from: state.from, to: state.to, branch: state.branch, lang: window.I18N.lang });
      if (state.cc) q.set('costCenterId', String(state.cc.id));
      return q;
    };
    const node = el('div', { class: 'filters report-filters' },
      el('label', { class: 'inline-label', for: 'r-from', text: t('journal.filter.from') }), from,
      el('label', { class: 'inline-label', for: 'r-to', text: t('journal.filter.to') }), to, year, branch, cc ? el('div', { class: 'cb-inline' }, cc.node) : null, ...extra);
    return { node, read };
  }

  function reportShell(app, key, perm, { url, file, filters, run, intro, onReset }) {
    const out = el('div', { class: 'report-out' });
    // reset = عرض جديد من زر «عرض» (يبدأ من الصفحة الأولى)؛ false = تحميل المزيد
    const show = async (reset = true) => {
      if (reset && onReset) onReset();
      const q = filters.read();
      try { fill(out, await run(q)); } catch (e) { fill(out, el('p', { class: 'form-alert', text: errorText(e) + (e.fields ? ' — ' + Object.entries(e.fields).map(([k, c]) => `${k}: ${TAYL.ui.fieldErrorText(c)}`).join(t('common.listSep')) : '') })); }
    };
    const actions = [
      button('ledger.show', () => show(true), 'btn primary'),
      app.can('ledger.print') ? button('common.print', () => TAYL.ui.printFrom(`${url}/print?${filters.read()}`), 'btn small') : null,
      app.can('ledger.export') ? button('common.export', () => TAYL.ui.download(`${url}/export.xlsx?${filters.read()}`, file + '.xlsx'), 'btn small') : null,
    ];
    filters.node.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !e.defaultPrevented) { e.preventDefault(); show(true); } });
    return { node: [pageHead(key, button('keys.button', () => TAYL.keys.help(), 'btn small')), intro ? el('p', { class: 'muted', text: t(intro) }) : null,
      panel(null, filters.node, el('div', { class: 'form-actions start' }, actions)), out], show };
  }
  const openEntry = (app, r, label) => (r.sourceType === 'journal' && app.can('journal.view')
    ? el('a', { href: '#/journalEntry?id=' + r.sourceId, dir: 'ltr', text: label }) : el('span', { dir: 'ltr', text: label }));

  // ── دفتر اليومية ──
  const jrState = {};
  TAYL.views.journalRegister = {
    key: 'nav.journalRegister', perm: 'ledger.view',
    async render(root, app) {
      const number = el('input', { type: 'search', class: 'search', placeholder: t('ledger.numberSearch'), 'aria-label': t('ledger.number'), value: jrState.number || '' });
      const filters = await filterBar(app, jrState, { extra: [number] });
      const baseRead = filters.read;
      filters.read = () => { const q = baseRead(); jrState.number = number.value.trim(); if (jrState.number) q.set('number', jrState.number); return q; };
      let offset = 0; let docs = [];
      const shell = reportShell(app, 'nav.journalRegister', 'ledger.view', {
        url: '/api/ledger/journal', file: 'journal-register', filters, intro: 'ledger.journalIntro', onReset: () => { offset = 0; },
        async run(q) {
          q.set('offset', String(offset)); q.set('limit', '50');
          const r = await api.get('/api/ledger/journal?' + q);
          docs = offset ? docs.concat(r.items) : r.items;
          const more = r.hasMore ? button('journal.loadMore', () => { offset += 50; shell.show(false); }, 'btn small') : null;
          return [finalityBar(r.finality),
            el('p', { class: 'muted', text: t('ledger.documents', { n: r.documents }) }),
            docs.length ? docs.map((d) => el('section', { class: 'jr-doc' },
              el('div', { class: 'jr-head' }, el('span', { dir: 'ltr', text: d.date }), openEntry(app, d, d.number),
                d.entryType ? badge('journal.type.' + d.entryType, d.entryType === 'reversal' ? 'warn' : d.entryType === 'opening' ? 'gold' : '') : null,
                d.reversedBy ? badge('journal.status.reversed', 'bad') : null,
                el('span', { class: 'jr-desc', text: d.description || '' }), d.reference ? el('span', { class: 'muted', text: `${t('ledger.reference')}: ${d.reference}` }) : null,
                d.reverses ? el('span', { class: 'muted', text: t('journal.reversesShort', { number: d.reverses.number }) }) : null,
                d.reversedBy ? el('span', { class: 'muted', text: t('journal.reversedByShort', { number: d.reversedBy.number }) }) : null),
              el('div', { class: 'table-wrap' }, el('table', { class: 'data compact' },
                el('thead', null, el('tr', null, ['ledger.account', 'ledger.costCenter', 'ledger.amountFc', 'ledger.debit', 'ledger.credit'].map((k) => el('th', { text: t(k) })))),
                el('tbody', null, d.lines.map((l) => el('tr', null, el('td', { text: `${l.accountCode} — ${window.I18N.lang === 'ar' ? l.accountNameAr : l.accountNameEn}` }),
                  el('td', { text: l.costCenterCode || '' }), el('td', null, l.currency !== r.baseCurrency ? [num(l.debitFc !== '0' ? l.debitFcText : l.creditFcText), ` ${l.currency} @ ${l.rate}`] : ''),
                  el('td', { class: 'num-col' }, num(l.debitText)), el('td', { class: 'num-col' }, num(l.creditText))))),
                el('tfoot', null, el('tr', { class: 'total-row' }, el('td', { colspan: '3' }), el('td', { class: 'num-col' }, num(d.totalDebitText)), el('td', { class: 'num-col' }, num(d.totalCreditText)))))))) : el('p', { class: 'muted empty', text: t('ledger.noData') }),
            more,
            el('div', { class: 'je-totals' }, el('span', null, t('ledger.totalDebit'), ' ', num(r.totals.debitText)), el('span', null, t('ledger.totalCredit'), ' ', num(r.totals.creditText)),
              badge(r.totals.balanced ? 'journal.balanced' : 'journal.unbalanced', r.totals.balanced ? 'ok' : 'bad'))];
        },
      });
      fill(root, shell.node);
      await shell.show(true);
    },
  };

  // ── كشف الحساب ──
  const stState = {};
  const balText = (b) => (b.side ? [num(b.side === 'debit' ? b.debitText : b.creditText), ' ', t('ledger.side.' + b.side)] : num('0'));
  TAYL.views.accountStatement = {
    key: 'nav.accountStatement', perm: 'ledger.view',
    async render(root, app) {
      const p = params();
      if (p.get('accountId')) { stState.account = { id: Number(p.get('accountId')), label: p.get('label') || p.get('accountId') }; stState.from = p.get('from') || stState.from; stState.to = p.get('to') || stState.to; stState.branch = p.get('branch') || stState.branch; }
      const account = TAYL.combobox.create({ source: TAYL.combobox.lookupSource('/api/accounts'), value: stState.account || null, label: t('ledger.account'), required: true });
      const curList = (await api.get('/api/currencies/lookup?limit=50').catch(() => ({ items: [] }))).items;
      const currency = el('select', { 'aria-label': t('ledger.currency') }, [el('option', { value: '', text: t('ledger.allCurrencies') }), ...curList.map((c) => el('option', { value: String(c.id), text: c.code }))]);
      currency.value = stState.currency || '';
      const filters = await filterBar(app, stState, { costCenter: true, extra: [el('div', { class: 'cb-inline wide' }, account.node), currency] });
      const baseRead = filters.read;
      filters.read = () => { const q = baseRead(); stState.account = account.value; stState.currency = currency.value; if (account.value) q.set('accountId', String(account.value.id)); if (currency.value) q.set('currencyId', currency.value); return q; };
      const shell = reportShell(app, 'nav.accountStatement', 'ledger.view', {
        url: '/api/ledger/statement', file: 'account-statement', filters, intro: 'ledger.statementIntro',
        async run(q) {
          if (!q.get('accountId')) return el('p', { class: 'muted', text: t('ledger.pickAccount') });
          const r = await api.get('/api/ledger/statement?' + q);
          const fcCol = !!r.currency;
          const head = ['ledger.date', 'ledger.number', 'ledger.description', 'ledger.reference', 'ledger.costCenter', fcCol ? 'ledger.amountFc' : null, 'ledger.debit', 'ledger.credit', 'ledger.balance'].filter(Boolean);
          const row = (cells, cls) => el('tr', { class: cls }, cells);
          return [finalityBar(r.finality),
            el('h3', { class: 'form-section', text: `${r.account.code} — ${name(r.account)}${r.account.isGroup ? ' (' + t('account.group') + ')' : ''} · ${r.from} → ${r.to}${r.currency ? ' · ' + r.currency : ''}` }),
            el('div', { class: 'table-wrap' }, el('table', { class: 'data statement' },
              el('thead', null, el('tr', null, head.map((k) => el('th', { text: t(k) })))),
              el('tbody', null,
                row([el('td', { colspan: String(head.length - 3), text: t('ledger.openingBalance') }), el('td', { class: 'num-col' }, num(r.opening.debitText)), el('td', { class: 'num-col' }, num(r.opening.creditText)), el('td', { class: 'num-col' }, balText(r.opening))], 'total-row'),
                r.rows.map((x) => row([el('td', { dir: 'ltr', text: x.date }), el('td', null, openEntry(app, x, x.number)), el('td', { text: x.description || '' }), el('td', { text: x.reference || '' }),
                  el('td', { text: x.costCenterCode || '' }), fcCol ? el('td', { class: 'num-col' }, num(x.debitFc !== '0' ? x.debitFcText : '-' + x.creditFcText), ` @ ${x.rate}`) : null,
                  el('td', { class: 'num-col' }, num(x.debitText)), el('td', { class: 'num-col' }, num(x.creditText)), el('td', { class: 'num-col' }, balText(x.balance))].filter(Boolean)))),
              el('tfoot', null,
                row([el('td', { colspan: String(head.length - 3), text: t('ledger.total') }), el('td', { class: 'num-col' }, num(r.totals.debitText)), el('td', { class: 'num-col' }, num(r.totals.creditText)), el('td')], 'total-row'),
                row([el('td', { colspan: String(head.length - 1), text: t('ledger.closingBalance') + (r.closingFc ? ` (${r.currency}: ${r.closingFc.side ? (r.closingFc.side === 'debit' ? r.closingFc.debitText : r.closingFc.creditText) + ' ' + t('ledger.side.' + r.closingFc.side) : '0'})` : '') }), el('td', { class: 'num-col' }, balText(r.closing))], 'total-row')))),
            r.rows.length ? null : el('p', { class: 'muted empty', text: t('ledger.noMovements') })];
        },
      });
      fill(root, shell.node);
      if (stState.account) await shell.show(); else account.focus();
    },
  };

  // ── ميزان المراجعة ──
  const tbState = { level: '15', zero: false };
  // إزاحة المستوى عبر CSSOM (السمة style ممنوعة بسياسة CSP الصارمة)
  const indent = (td, level) => { td.style.paddingInlineStart = `${(level - 1) * 14 + 8}px`; return td; };
  TAYL.views.trialBalance = {
    key: 'nav.trialBalance', perm: 'ledger.view',
    async render(root, app) {
      const level = el('select', { 'aria-label': t('ledger.level') }, [el('option', { value: '15', text: t('ledger.allLevels') }), ...[1, 2, 3, 4, 5, 6].map((n) => el('option', { value: String(n), text: t('ledger.levelN', { n }) }))]);
      level.value = tbState.level;
      const zero = el('label', { class: 'check' }, el('input', { type: 'checkbox', checked: tbState.zero }), el('span', { text: t('ledger.includeZero') }));
      const filters = await filterBar(app, tbState, { costCenter: true, extra: [level, zero] });
      const baseRead = filters.read;
      filters.read = () => { const q = baseRead(); tbState.level = level.value; tbState.zero = zero.querySelector('input').checked; q.set('level', tbState.level); if (tbState.zero) q.set('includeZero', '1'); return q; };
      const shell = reportShell(app, 'nav.trialBalance', 'ledger.view', {
        url: '/api/ledger/trial-balance', file: 'trial-balance', filters, intro: 'ledger.tbIntro',
        async run(q) {
          const r = await api.get('/api/ledger/trial-balance?' + q);
          const T = r.totals.texts;
          const stmt = (x) => `#/accountStatement?accountId=${x.accountId}&from=${r.from}&to=${r.to}&branch=${q.get('branch')}&label=${encodeURIComponent(x.code + ' — ' + name(x))}`;
          const pair = (b) => [el('td', { class: 'num-col' }, num(b.debitText)), el('td', { class: 'num-col' }, num(b.creditText))];
          return [finalityBar(r.finality),
            el('div', { class: 'table-wrap' }, el('table', { class: 'data tb' },
              el('thead', null,
                el('tr', null, el('th', { rowspan: '2', text: t('ledger.accountCode') }), el('th', { rowspan: '2', text: t('ledger.accountName') }),
                  el('th', { colspan: '2', text: t('ledger.openingBalance') }), el('th', { colspan: '2', text: t('ledger.movement') }), el('th', { colspan: '2', text: t('ledger.closingBalance') })),
                el('tr', null, ['ledger.debit', 'ledger.credit', 'ledger.debit', 'ledger.credit', 'ledger.debit', 'ledger.credit'].map((k) => el('th', { text: t(k) })))),
              el('tbody', null, r.rows.map((x) => el('tr', { class: x.isGroup ? 'group-row' : null },
                indent(el('td', null, x.isGroup ? el('code', { dir: 'ltr', text: x.code }) : el('a', { href: stmt(x), dir: 'ltr', text: x.code })), x.level),
                el('td', { text: name(x) }), pair(x.opening), el('td', { class: 'num-col' }, num(x.movementDebitText)), el('td', { class: 'num-col' }, num(x.movementCreditText)), pair(x.closing)))),
              el('tfoot', null, el('tr', { class: 'total-row' }, el('td', { colspan: '2', text: t('ledger.total') }),
                [T.od, T.oc, T.md, T.mc, T.cd, T.cc].map((v) => el('td', { class: 'num-col' }, num(v))))))),
            el('div', { class: 'je-totals' }, badge(r.totals.balanced.all ? 'ledger.tbBalanced' : 'ledger.tbUnbalanced', r.totals.balanced.all ? 'ok' : 'bad'),
              r.rows.length ? null : el('span', { class: 'muted', text: t('ledger.noData') }))];
        },
      });
      fill(root, shell.node);
      await shell.show();
    },
  };
})();

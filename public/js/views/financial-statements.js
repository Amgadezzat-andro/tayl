'use strict';
/*
 * مركز القوائم المالية (المرحلة 5): قائمة الدخل، المركز المالي، التدفقات النقدية — اختيار السنة/الفترة أو تاريخ، الفروع
 * (فرع/مجموعة/الكل ضمن الصلاحيات)، المقارنة، مراكز التكلفة والتوزيع لقائمة الدخل. كل رقم من الخادم؛ كل حساب يفتح كشفه
 * بالنطاق نفسه ومنه القيد. الطباعة والتصدير متاحان فقط لقائمة مكتملة ومتطابقة مع ميزان المراجعة.
 * وشاشة إعداد التصنيف (بند قائمة الدخل ونشاط التدفق لكل نوع حساب أو حساب).
 */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, fill, panel, pageHead, button, badge, toast, errorText, name } = TAYL.ui;
  const api = TAYL.api;
  const num = (text) => el('span', { class: 'num', dir: 'ltr', text });
  const state = { report: 'income-statement', yearId: null, periodId: '', from: '', to: '', asOf: '', branches: [], compare: 'none', cc: null, breakdown: '' };
  const STATEMENT = { 'income-statement': 'income_statement', 'balance-sheet': 'balance_sheet', 'cash-flow': 'cash_flow' };

  /** صفوف العرض من بيانات القائمة (نفس ترتيب الطباعة في الخادم) مع روابط الكشف. */
  function rowsOf(r) {
    const out = [];
    const push = (label, v, { indent = 0, kind = '', account = null } = {}) => out.push({ label, v, indent, kind, account });
    const acc = (a, indent) => push(`${a.code} — ${name(a)}`, a, { indent, account: a });
    if (r.statement === 'income_statement') {
      for (const l of r.lines) {
        if (l.rows) { push(t('fs.line.' + l.key), null, { kind: 'head' }); l.rows.forEach((a) => acc(a, 1)); push(t('fs.totalOf', { item: t('fs.line.' + l.key) }), l, { kind: 'total' }); }
        else push(t('fs.line.' + l.key), l, { kind: l.key === 'net_profit' ? 'grand' : 'subtotal' });
      }
    } else if (r.statement === 'balance_sheet') {
      for (const s of r.sections) {
        push(t('fs.class.' + s.key), null, { kind: 'head' });
        for (const g of s.groups) {
          const gl = g.typeCode ? name({ nameAr: g.typeNameAr, nameEn: g.typeNameEn }) : t('fs.noType');
          push(gl, null, { indent: 1, kind: 'subhead' }); g.rows.forEach((a) => acc(a, 2)); push(t('fs.totalOf', { item: gl }), g, { indent: 1, kind: 'total' });
        }
        if (s.key === 'equity') push(t('fs.unclosedResult'), s.unclosedResult, { indent: 1 });
        push(t('fs.totalOf', { item: t('fs.class.' + s.key) }), s, { kind: 'subtotal' });
      }
      push(t('fs.totalLiabilitiesAndEquity'), r.totalLiabilitiesAndEquity, { kind: 'grand' });
      push(t('fs.difference'), r.difference, { kind: 'total' });
    } else {
      for (const s of r.sections) {
        push(t('fs.activity.' + s.key), null, { kind: 'head' });
        if (s.key === 'operating') push(t('fs.netIncome'), r.netIncome, { indent: 1 });
        s.rows.forEach((a) => acc(a, 1));
        push(t('fs.totalOf', { item: t('fs.activity.' + s.key) }), s, { kind: 'subtotal' });
      }
      push(t('fs.netChange'), r.netChange, { kind: 'grand' }); push(t('fs.openingCash'), r.openingCash); push(t('fs.closingCash'), r.closingCash, { kind: 'total' });
    }
    return out;
  }
  /** رابط الكشف: قائمة الدخل قبل الإقفال بالنطاق نفسه؛ المركز المالي من بداية السنة حتى التاريخ. */
  function statementLink(r, a, app) {
    if (!app.can('ledger.view')) return el('span', { text: `${a.code} — ${name(a)}` });
    const from = r.statement === 'balance_sheet' ? (r.fiscalYearStart || r.asOf) : r.from;
    const to = r.statement === 'balance_sheet' ? r.asOf : r.to;
    const q = new URLSearchParams({ accountId: String(a.accountId), from, to, branch: r.scope.branchParam, label: `${a.code} — ${name(a)}` });
    if (r.statement === 'income_statement') q.set('excludeClosing', '1');
    return el('a', { href: '#/accountStatement?' + q, text: `${a.code} — ${name(a)}` });
  }
  function renderStatement(r, app) {
    const cmp = !!r.comparison;
    const colLabel = (c) => (c.label && c.label.code ? c.label.code : c.key === 'total' ? t('fs.total') : c.asOf ? c.asOf : `${c.from} → ${c.to}`);
    const head = [t('fs.item'), ...r.columns.map(colLabel), ...(cmp ? [t('fs.difference'), t('fs.percent')] : [])];
    const trend = (v) => (v.trend === 'up' ? '▲ ' : v.trend === 'down' ? '▼ ' : '');
    const body = rowsOf(r).map((x) => el('tr', { class: 'fs-' + (x.kind || 'row') },
      el('td', { class: 'fs-indent-' + x.indent }, x.account ? statementLink(r, x.account, app) : x.label),   // CSP: لا أنماط مضمّنة
      ...(x.v ? x.v.values.map((c) => el('td', { class: 'num-col' }, num(c.text))) : r.columns.map(() => el('td'))),
      ...(cmp ? (x.v ? [el('td', { class: 'num-col fs-trend-' + x.v.trend }, trend(x.v), num(x.v.difference.text)), el('td', { class: 'num-col' }, num(x.v.percent ? x.v.percent.text : '—'))] : [el('td'), el('td')]) : [])));
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data compact fs-table' }, el('thead', null, el('tr', null, head.map((h) => el('th', { text: h })))), el('tbody', null, body)));
  }
  function metaBox(r) {
    const scope = r.scope.all ? t('ledger.allBranches') : r.scope.branches.map((b) => b.code).join(t('common.listSep'));
    return el('div', { class: 'fs-meta' },
      el('span', null, `${t('fs.branches')}: ${scope}`),
      r.scope.analytical ? el('span', null, `${t('fs.costCenters')}: ${r.scope.costCenters.map((c) => c.code).join(t('common.listSep'))} — ${t('fs.analytical')}`) : null,
      el('span', null, r.asOf ? `${t('fs.asOf')}: ` : `${t('fs.period')}: `, el('bdi', { dir: 'ltr', text: r.asOf || `${r.from} → ${r.to}` })),
      r.comparativePeriod ? el('span', null, `${t('fs.comparative')}: ${r.comparativePeriod.from} → ${r.comparativePeriod.to}`) : null,
      r.comparativeDate ? el('span', null, `${t('fs.comparative')}: ${r.comparativeDate.asOf}`) : null,
      r.method ? el('span', null, t('fs.method.' + r.method)) : null,
      el('span', null, `${t('fs.currency')}: ${r.baseCurrency}`));
  }
  function statusBox(r, app) {
    return el('div', { class: 'fs-status' },
      TAYL.ledgerFinality ? TAYL.ledgerFinality(r.finality) : null,
      el('div', { class: 'ye-overall' },
        badge(r.complete ? 'fs.complete' : 'fs.incomplete', r.complete ? 'ok' : 'bad'),
        badge(r.reconciliation.ok ? 'fs.reconciled' : 'fs.notReconciled', r.reconciliation.ok ? 'ok' : 'bad'),
        r.balanced !== undefined ? badge(r.balanced ? 'fs.balanced' : 'fs.unbalanced', r.balanced ? 'ok' : 'bad') : null,
        r.resultSide ? el('strong', null, t('ye.result.' + r.resultSide), ' ', num(r.netProfit.text), ' ', r.baseCurrency) : null),
      (r.issues || []).map((i) => el('div', { class: 'ye-issues bad', role: 'alert' }, el('strong', { text: t('fs.issue.' + i.code) }),
        i.accounts ? el('ul', null, i.accounts.map((a) => el('li', { text: `${a.code} — ${name(a)}` }))) : null,
        app.can('financial_statements.settings') ? el('a', { href: '#/fsSettings', text: t('fs.openSettings') }) : null)),
      (r.warnings || []).map((w) => el('p', { class: 'notice warn', text: t('fs.warn.' + w.code) })),
      !r.reconciliation.ok ? el('div', { class: 'ye-issues bad' }, el('strong', { text: t('fs.notReconciled') }),
        el('ul', null, r.reconciliation.differences.slice(0, 20).map((d) => el('li', { dir: 'ltr', text: `${d.code || ''} ${d.trialBalance || ''} ≠ ${d.statement || ''}` })))) : null);
  }

  TAYL.views.financialStatements = {
    key: 'nav.financialStatements', perm: 'financial_statements.view',
    async render(root, app) {
      const years = await api.get('/api/financial-statements/periods');
      if (!years.length) { fill(root, pageHead('nav.financialStatements'), el('p', { class: 'muted empty', text: t('fiscal.none') })); return; }
      const today = new Date().toISOString().slice(0, 10);
      if (!years.some((y) => y.id === state.yearId)) state.yearId = (years.find((y) => y.startDate <= today && y.endDate >= today) || years[0]).id;
      const rep = el('select', { id: 'fs-report', 'aria-label': t('fs.report') }, Object.keys(STATEMENT).map((k) => el('option', { value: k, text: t('fs.report.' + STATEMENT[k]) })));
      rep.value = state.report;
      const year = el('select', { id: 'fs-year', 'aria-label': t('ledger.fiscalYear') }, years.map((y) => el('option', { value: String(y.id), text: `${y.code} (${y.startDate} → ${y.endDate})` })));
      year.value = String(state.yearId);
      const period = el('select', { id: 'fs-period', 'aria-label': t('fiscal.period') });
      const fillPeriods = () => {
        const y = years.find((x) => String(x.id) === year.value);
        fill(period, el('option', { value: '', text: t('fs.wholeYear') }), el('option', { value: 'custom', text: t('fs.customRange') }),
          y.periods.map((p) => el('option', { value: String(p.id), text: name(p) })));
        period.value = state.periodId && [...period.options].some((o) => o.value === state.periodId) ? state.periodId : '';
      };
      fillPeriods();
      const from = el('input', { type: 'date', dir: 'ltr', id: 'fs-from', value: state.from, 'aria-label': t('journal.filter.from') });
      const to = el('input', { type: 'date', dir: 'ltr', id: 'fs-to', value: state.to, 'aria-label': t('journal.filter.to') });
      const custom = el('span', { class: 'fs-custom' }, from, to);
      const showCustom = () => { custom.hidden = period.value !== 'custom'; };
      year.addEventListener('change', () => { state.yearId = Number(year.value); fillPeriods(); showCustom(); });
      period.addEventListener('change', showCustom); showCustom();
      const branches = el('select', { id: 'fs-branches', multiple: true, size: '3', 'aria-label': t('fs.branches') },
        app.session.branches.map((b) => el('option', { value: String(b.id), text: `${b.code} — ${name(b)}`, selected: state.branches.includes(String(b.id)) })));
      const compare = el('select', { id: 'fs-compare', 'aria-label': t('fs.compare') }, ['none', 'previous_period', 'same_period_last_year', 'previous_year'].map((c) => el('option', { value: c, text: t('fs.compare.' + c) })));
      compare.value = state.compare;
      const breakdown = el('select', { id: 'fs-breakdown', 'aria-label': t('fs.breakdown') }, ['', 'branch', 'cost_center'].map((c) => el('option', { value: c, text: t('fs.breakdown.' + (c || 'none')) })));
      breakdown.value = state.breakdown;
      const cc = TAYL.combobox.create({ source: TAYL.combobox.lookupSource('/api/cost-centers'), value: state.cc, label: t('ledger.costCenter'), placeholderKey: 'ledger.anyCostCenter' });
      const isOnly = el('span', { class: 'fs-is-only' }, breakdown, el('div', { class: 'cb-inline' }, cc.node));
      const syncReport = () => { isOnly.hidden = rep.value !== 'income-statement'; };
      rep.addEventListener('change', syncReport); syncReport();
      const out = el('div', { class: 'report-out', 'aria-live': 'polite' });
      const query = () => {
        Object.assign(state, { report: rep.value, periodId: period.value, from: from.value, to: to.value, compare: compare.value, breakdown: breakdown.value, cc: cc.value,
          branches: [...branches.selectedOptions].map((o) => o.value) });
        const q = new URLSearchParams({ lang: window.I18N.lang, branch: state.branches.length ? state.branches.join(',') : 'all', compare: state.compare });
        const y = years.find((x) => x.id === state.yearId);
        if (state.periodId === 'custom') {
          if (state.report === 'balance-sheet') q.set('asOf', state.to || state.from); else { q.set('from', state.from); q.set('to', state.to); }
        } else if (state.periodId) q.set('periodId', state.periodId);
        else q.set('fiscalYearId', String(y.id));
        if (state.report === 'income-statement') {
          if (state.breakdown) { q.set('breakdown', state.breakdown); q.set('compare', 'none'); }
          if (state.cc) q.set('costCenterIds', String(state.cc.id));
        }
        return q;
      };
      let last = null;
      const show = async () => {
        const q = query();
        try {
          last = await api.get(`/api/financial-statements/${state.report}?${q}`);
          fill(out, el('h2', { text: t('fs.report.' + last.statement) }), metaBox(last), statusBox(last, app), renderStatement(last, app));
          printBtn.disabled = !last.issuable; exportBtn.disabled = !last.issuable;
        } catch (e) { last = null; printBtn.disabled = true; exportBtn.disabled = true; fill(out, el('p', { class: 'form-alert', role: 'alert', text: errorText(e) })); }
      };
      const printBtn = el('button', { class: 'btn small', type: 'button', text: t('common.print'), disabled: true, hidden: !app.can('financial_statements.print'),
        on: { click: () => TAYL.ui.printFrom(`/api/financial-statements/${state.report}/print?${query()}`) } });
      const exportBtn = el('button', { class: 'btn small', type: 'button', text: t('common.export'), disabled: true, hidden: !app.can('financial_statements.export'),
        on: { click: () => TAYL.ui.download(`/api/financial-statements/${state.report}/export.xlsx?${query()}`, state.report + '.xlsx') } });
      const filters = el('div', { class: 'filters report-filters' }, rep, year, period, custom, branches, compare, isOnly);
      filters.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !e.defaultPrevented) { e.preventDefault(); show(); } });
      TAYL.keys.setPage([]);
      fill(root,
        pageHead('nav.financialStatements', app.can('financial_statements.settings') ? el('a', { class: 'btn small', href: '#/fsSettings', text: t('nav.fsSettings') }) : null,
          button('keys.button', () => TAYL.keys.help(), 'btn small')),
        el('p', { class: 'muted', text: t('fs.intro') }),
        panel(null, filters, el('p', { class: 'hint', text: t('fs.branchesHint') }), el('div', { class: 'form-actions start' }, button('ledger.show', show, 'btn primary'), printBtn, exportBtn)),
        out);
      await show();
    },
  };

  // ── إعداد التصنيف ──
  TAYL.views.fsSettings = {
    key: 'nav.fsSettings', perm: 'financial_statements.view',
    async render(root, app) {
      const s = await api.get('/api/financial-statements/settings');
      const canEdit = app.can('financial_statements.settings');
      const lineOpts = (cls) => [''].concat(cls === 'revenue' ? ['revenue', 'other_income'] : cls === 'cogs' ? ['cogs'] : ['operating_expense', 'other_expense']);
      const sel = (opts, value, prefix, onChange, label) => {
        const x = el('select', { 'aria-label': label, disabled: !canEdit }, opts.map((o) => el('option', { value: o, text: o ? t(prefix + o) : t('fs.unset') })));
        x.value = value || '';
        x.addEventListener('change', () => onChange(x.value || null));
        return x;
      };
      const save = async (url, body) => { try { await api.put(url, body); toast(t('common.saved')); app.rerender(); } catch (e) { toast(errorText(e), 'bad'); } };
      const typeRow = (ty) => el('tr', null,
        el('td', { dir: 'ltr', text: ty.code }), el('td', { text: name(ty) }), el('td', { text: t('accClass.' + ty.classCode) }),
        el('td', null, ty.statement === 'income_statement' && ty.classCode !== 'cogs'
          ? sel(lineOpts(ty.classCode), ty.isLine, 'fs.line.', (v) => save('/api/financial-statements/settings/types/' + ty.typeId, { isLine: v }), t('fs.isLine'))
          : ty.classCode === 'cogs' ? t('fs.line.cogs') : '—'),
        el('td', null, ty.statement === 'balance_sheet'
          ? sel(['', 'cash', 'operating', 'investing', 'financing'], ty.cfActivity, 'fs.activity.', (v) => save('/api/financial-statements/settings/types/' + ty.typeId, { cfActivity: v }), t('fs.cfActivity'))
          : t('fs.viaNetIncome')));
      const accRow = (a, current) => el('tr', null,
        el('td', { dir: 'ltr', text: a.code }), el('td', { text: name(a) }), el('td', { text: t('accClass.' + a.classCode) }),
        el('td', null, a.statement === 'income_statement' || ['revenue', 'cogs', 'expense'].includes(a.classCode)
          ? sel(lineOpts(a.classCode), current && current.isLine, 'fs.line.', (v) => save('/api/financial-statements/settings/accounts/' + a.accountId, { isLine: v }), t('fs.isLine'))
          : sel(['', 'cash', 'operating', 'investing', 'financing'], current && current.cfActivity, 'fs.activity.', (v) => save('/api/financial-statements/settings/accounts/' + a.accountId, { cfActivity: v }), t('fs.cfActivity'))),
        el('td', null, a.hasActivity ? badge('fs.hasActivity', 'warn') : ''));
      const T = (cols, rows, emptyKey) => (rows.length ? el('div', { class: 'table-wrap' }, el('table', { class: 'data compact' }, el('thead', null, el('tr', null, cols.map((c) => el('th', { text: t(c) })))), el('tbody', null, rows)))
        : el('p', { class: 'muted', text: t(emptyKey) }));
      TAYL.keys.setPage([]);
      fill(root,
        pageHead('nav.fsSettings', el('a', { class: 'btn small', href: '#/financialStatements', text: t('nav.financialStatements') })),
        el('p', { class: 'muted', text: t('fs.settingsIntro') }),
        panel('fs.unclassifiedAccounts', T(['account.code', 'common.name', 'fs.class', 'fs.classification', 'fs.activityCol'], s.unclassified.map((a) => accRow(a, null)), 'fs.allClassified')),
        panel('fs.byType', T(['account.code', 'common.name', 'fs.class', 'fs.isLine', 'fs.cfActivity'], s.types.map(typeRow), 'common.empty')),
        panel('fs.accountOverrides', T(['account.code', 'common.name', 'fs.class', 'fs.classification', 'fs.activityCol'],
          s.overrides.map((o) => accRow({ ...o, statement: ['revenue', 'cogs', 'expense'].includes(o.classCode) ? 'income_statement' : 'balance_sheet' }, o)), 'fs.noOverrides')));
    },
  };
})();

'use strict';
/*
 * مركز الإقفال السنوي (المرحلة 4): الحالة، فحص الجاهزية، المعاينة، التنفيذ بتأكيد صريح، السجل، إعادة الفتح، الإعداد.
 * كل حساب وفحص في الخادم؛ الواجهة تعرض فقط. لا تنفيذ مع أخطاء مانعة، ولا تنفيذ دون معاينة (بصمتها تُرسل مع الطلب)،
 * والتحذيرات تتطلب إقرارًا. مفتاح الطلب (idempotency) يُنشأ مرة لكل محاولة فلا تتكرر العملية عند إعادة الإرسال.
 */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, fill, panel, pageHead, button, badge, toast, errorText, name, modal, confirm, dateTime } = TAYL.ui;
  const api = TAYL.api;
  const num = (text) => el('span', { class: 'num', dir: 'ltr', text });
  const STATE_CLS = { open: 'warn', closed: 'gold', closed_no_next_year: 'gold', carried: 'ok', not_required: '' };
  const newKey = () => 'ye-' + (crypto.randomUUID ? crypto.randomUUID() : String(Date.now()) + Math.random().toString(16).slice(2));
  const state = { yearId: null, branch: 'all', carry: true };

  /** نص مسألة فحص: الترجمة + أهم التفاصيل (بلا رموز داخلية). */
  function issueText(i) {
    const extra = [];
    if (i.year) extra.push(i.year);
    if (i.account) extra.push(i.account);
    if (i.accounts) extra.push(i.accounts.join(t('common.listSep')));
    if (i.currency) extra.push(i.currency);
    if (i.count != null) extra.push(String(i.count));
    if (i.periods) extra.push(i.periods.map((p) => name(p)).join(t('common.listSep')));
    if (i.reason) extra.push(t('ye.reReason.' + i.reason));
    if (i.problems != null) extra.push(String(i.problems));
    return t('ye.issue.' + i.code) + (extra.length ? ` (${extra.join(' — ')})` : '');
  }
  /** روابط تساعد على المعالجة. */
  function issueLink(i) {
    const to = { PERIODS_OPEN: 'fiscalYears', LAST_PERIOD_LOCKED: 'fiscalYears', DRAFTS_EXIST: 'journal', RE_ACCOUNT_NOT_SET: null, SPLIT_RATE_MISSING: 'currencies',
      NEXT_YEAR_MISSING: 'fiscalYears', NEXT_YEAR_NOT_INITIALIZED: 'fiscalYears', LEDGER_INTEGRITY: 'trialBalance', BRANCH_INACTIVE: 'branches' }[i.code];
    return to && TAYL.views[to] ? el('a', { href: '#/' + to, text: t('ye.fixLink') }) : null;
  }
  function issueList(all, cls, titleKey) {
    const list = (all || []).filter((i) => i.code !== 'RESULT' && i.code !== 'CARRY_SUMMARY');   // الملخص يُعرض في صندوقه
    if (!list.length) return null;
    return el('div', { class: 'ye-issues ' + cls, role: cls === 'bad' ? 'alert' : 'status' }, el('strong', { text: t(titleKey) + ` (${list.length})` }),
      el('ul', null, list.map((i) => el('li', null, issueText(i), ' ', issueLink(i),
        i.drafts ? el('ul', null, i.drafts.slice(0, 10).map((d) => el('li', null, el('a', { href: '#/journalEntry?id=' + d.id, dir: 'ltr', text: d.date }), ' ', d.description))) : null))));
  }
  function summaryBox(s, carry) {
    if (!s) return null;
    if (carry) return el('p', { class: 'muted' }, t('ye.carrySummary', { n: s.lines, total: s.totalBaseText, cur: s.baseCurrency }));
    return el('div', { class: 'je-totals' },
      el('span', null, t('ye.totalRevenue'), ' ', num(s.totalRevenueText)), el('span', null, t('ye.totalExpense'), ' ', num(s.totalExpenseText)),
      el('span', null, t('ye.result.' + s.resultSide), ' ', num(s.netResultText), ' ', s.baseCurrency));
  }
  function linesTable(lines) {
    if (!lines || !lines.length) return el('p', { class: 'muted', text: t('ye.noLines') });
    return el('div', { class: 'table-wrap' }, el('table', { class: 'data compact' },
      el('thead', null, el('tr', null, ['ledger.account', 'ledger.costCenter', 'ledger.amountFc', 'ye.basisLabel', 'ledger.debit', 'ledger.credit'].map((k) => el('th', { text: t(k) })))),
      el('tbody', null, lines.map((l) => el('tr', null,
        el('td', { text: `${l.accountCode} — ${window.I18N.lang === 'ar' ? l.accountNameAr : l.accountNameEn}` }), el('td', { text: l.costCenterCode || '' }),
        el('td', null, num(l.debitFc !== '0' ? l.debitFcText : l.creditFcText), ` ${l.currency} @ ${l.rate}`), el('td', { text: t('ye.basis.' + l.basis) }),
        el('td', { class: 'num-col' }, num(l.debitText)), el('td', { class: 'num-col' }, num(l.creditText)))))));
  }

  async function showEntry(id) {
    let e;
    try { e = await api.get('/api/year-end/entries/' + id); } catch (err) { toast(errorText(err), 'bad'); return; }
    modal({ title: `${t('ye.kind.' + e.kind + (e.isReversal ? '_reversal' : ''))} — ${e.number}`, wide: true, body: el('div', null,
      el('p', null, `${e.date} | ${e.branch.code} | ${e.closingYear.code} | ${e.description}`),
      e.reason ? el('p', { class: 'muted', text: `${t('ye.reason')}: ${e.reason}` }) : null,
      e.reverses ? el('p', { class: 'muted', text: t('journal.reversesShort', { number: e.reverses.number }) }) : null,
      e.reversedBy ? el('p', { class: 'muted', text: t('journal.reversedByShort', { number: e.reversedBy.number }) }) : null,
      linesTable(e.lines),
      el('div', { class: 'je-totals' }, el('span', null, t('ledger.totalDebit'), ' ', num(e.totals.debitText)), el('span', null, t('ledger.totalCredit'), ' ', num(e.totals.creditText))),
      el('p', { class: 'muted', text: `${t('ye.postedBy')}: ${e.postedBy || ''} — ${dateTime(e.postedAt)}` })) });
  }
  const entryLink = (ref) => (ref ? el('a', { href: '#', dir: 'ltr', text: ref.number, on: { click: (ev) => { ev.preventDefault(); showEntry(ref.id); } } }) : '—');

  // ── حساب نتيجة السنة ──
  async function settingsPanel(app) {
    const s = await api.get('/api/year-end/settings');
    const canEdit = app.can('year_end.settings');
    const cb = canEdit ? TAYL.combobox.create({ source: TAYL.combobox.lookupSource('/api/accounts', 'usable=1&classCode=equity'),
      value: s.retainedEarningsAccount ? { id: s.retainedEarningsAccount.id, label: `${s.retainedEarningsAccount.code} — ${name(s.retainedEarningsAccount)}` } : null,
      label: t('ye.reAccount'), placeholderKey: 'ye.reAccountPick' }) : null;
    const save = canEdit ? button('common.save', async () => {
      if (!cb.value) { toast(t('ye.reAccountPick'), 'warn'); return; }
      try { await api.put('/api/year-end/settings', { retainedEarningsAccountId: cb.value.id }); toast(t('common.saved')); app.rerender(); } catch (e) { toast(errorText(e), 'bad'); }
    }, 'btn small primary') : null;
    return panel('ye.settings',
      el('p', { class: 'muted', text: t('ye.reIntro') }),
      canEdit ? el('div', { class: 'filters' }, el('div', { class: 'cb-inline' }, cb.node), save)
        : el('p', null, s.retainedEarningsAccount ? `${s.retainedEarningsAccount.code} — ${name(s.retainedEarningsAccount)}` : t('ye.issue.RE_ACCOUNT_NOT_SET')),
      s.lockedBy.length ? el('p', { class: 'notice warn', text: t('ye.reLocked', { years: s.lockedBy.join(t('common.listSep')) }) }) : null,
      issueList(s.issues, 'bad', 'ye.errors'), issueList(s.warnings, 'warn', 'ye.warnings'));
  }

  // ── التنفيذ بعد المعاينة ──
  async function execute(app, pv, out) {
    const op = pv.operation;
    const ack = pv.hasWarnings ? el('input', { type: 'checkbox', id: 'ye-ack' }) : null;
    const branches = pv.branches.map((b) => b.branch.code).join(t('common.listSep'));
    const impact = op === 'close' ? t(pv.carryForward ? 'ye.confirmCloseCarry' : 'ye.confirmClose', { year: pv.fiscalYear.code, branches })
      : t('ye.confirmCarry', { year: pv.fiscalYear.code, branches });
    const body = el('div', null, el('p', { text: impact }), el('p', { class: 'muted', text: t('ye.confirmIrreversible') }),
      ack ? el('label', { class: 'check' }, ack, ' ', t('ye.ackWarnings')) : null);
    const key = newKey();   // ثابت لهذه المحاولة: إعادة الإرسال لا تكرر العملية
    const run = async () => {
      if (ack && !ack.checked) { toast(t('ye.ackRequired'), 'warn'); return; }
      try {
        const r = await api.post(op === 'close' ? '/api/year-end/close' : '/api/year-end/carry-forward', {
          fiscalYearId: pv.fiscalYear.id, branchIds: pv.branches.map((b) => b.branchId), carryForward: pv.carryForward,
          fingerprint: pv.fingerprint, idempotencyKey: key, acknowledgeWarnings: !!(ack && ack.checked), confirm: true });
        close();
        toast(t(op === 'close' ? 'ye.closedOk' : 'ye.carriedOk', { n: r.branches.length }));
        app.rerender();
      } catch (e) {
        close();
        fill(out, el('p', { class: 'form-alert', role: 'alert', text: errorText(e) }),
          e.details && e.details.branches ? e.details.branches.map((b) => issueList(b.errors, 'bad', 'ye.errors')) : null);
      }
    };
    const close = modal({ title: t(op === 'close' ? 'ye.executeClose' : 'ye.executeCarry'), body, actions: [
      el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close() } }),
      el('button', { class: 'btn danger', type: 'button', text: t(op === 'close' ? 'ye.executeClose' : 'ye.executeCarry'), on: { click: run } })] });
  }

  async function runPlan(app, out, op, withLines) {
    const body = { fiscalYearId: state.yearId, branchIds: state.branch === 'all' ? 'all' : [Number(state.branch)], operation: op, carryForward: op === 'close' && state.carry };
    let pv;
    try { pv = await api.post(withLines ? '/api/year-end/preview' : '/api/year-end/check', body); } catch (e) { fill(out, el('p', { class: 'form-alert', role: 'alert', text: errorText(e) })); return; }
    const canRun = withLines && pv.ready && pv.canExecute;
    fill(out,
      el('div', { class: 'ye-overall' }, badge(pv.ready ? 'ye.ready' : 'ye.notReady', pv.ready ? 'ok' : 'bad'), ' ', t('ye.op.' + op)),
      pv.branches.map((b) => el('section', { class: 'jr-doc' },
        el('div', { class: 'jr-head' }, el('strong', { text: `${b.branch.code} — ${name(b.branch)}` }), badge(b.ready ? 'ye.ready' : 'ye.notReady', b.ready ? 'ok' : 'bad')),
        issueList(b.errors, 'bad', 'ye.errors'), issueList(b.warnings, 'warn', 'ye.warnings'), issueList(b.info, 'info', 'ye.info'),
        withLines ? [summaryBox(b.summary, op === 'carry_forward'), el('h3', { text: t(op === 'close' ? 'ye.closingLines' : 'ye.carryLines') }), linesTable(b.lines)] : null,
        b.carryForward ? [el('h3', { text: t('ye.carryLines') }), issueList(b.carryForward.errors, 'bad', 'ye.errors'), issueList(b.carryForward.warnings, 'warn', 'ye.warnings'),
          withLines ? [summaryBox(b.carryForwardSummary, true), linesTable(b.carryForwardLines)] : null] : null)),
      withLines ? el('div', { class: 'form-actions start' },
        el('button', { class: 'btn danger', type: 'button', disabled: canRun ? null : 'disabled', text: t(op === 'close' ? 'ye.executeClose' : 'ye.executeCarry'),
          on: { click: () => execute(app, pv, out) } }),
        !pv.canExecute ? el('span', { class: 'muted', text: t('ye.noPermission') }) : !pv.ready ? el('span', { class: 'muted', text: t('ye.fixFirst') }) : null) : null);
  }

  // ── إعادة الفتح وإلغاء الترحيل ──
  function revertDialog(app, b, kind) {
    const reason = el('textarea', { id: 'ye-reason', rows: '3', maxlength: '500', 'aria-label': t('ye.reason') });
    const withCarry = kind === 'reopen' && b.carryForward ? el('input', { type: 'checkbox', id: 'ye-with-cf', checked: 'checked' }) : null;
    const out = el('div');
    const key = newKey();
    const send = async (extra = {}) => {
      const url = kind === 'reopen' ? '/api/year-end/reopen' : '/api/year-end/revert-carry-forward';
      return api.post(url, { fiscalYearId: state.yearId, branchId: b.branch.id, reason: reason.value, includeCarryForward: !!(withCarry && withCarry.checked),
        idempotencyKey: key, confirm: true, ...extra });
    };
    const run = async () => {
      try { await send(); } catch (e) {
        if (e.code !== 'NEXT_YEAR_HAS_ACTIVITY') { fill(out, el('p', { class: 'form-alert', role: 'alert', text: errorText(e) })); return; }
        if (!(await confirm(t('ye.nextYearActivityConfirm', { n: e.details.entries, year: e.details.year }), { danger: true, okKey: 'ye.' + kind }))) return;
        try { await send({ confirmNextYearActivity: true }); } catch (e2) { toast(errorText(e2), 'bad'); return; }
      }
      close(); toast(t('common.saved')); app.rerender();
    };
    const close = modal({ title: `${t('ye.' + kind)} — ${b.branch.code}`, body: el('div', null,
      el('p', { class: 'notice warn', text: t(kind === 'reopen' ? 'ye.reopenWarning' : 'ye.revertCarryWarning') }),
      el('label', { for: 'ye-reason', text: t('ye.reason') }), reason,
      withCarry ? el('label', { class: 'check' }, withCarry, ' ', t('ye.includeCarry')) : null, out),
    actions: [el('button', { class: 'btn', type: 'button', text: t('common.cancel'), on: { click: () => close() } }),
      el('button', { class: 'btn danger', type: 'button', text: t('ye.' + kind), on: { click: run } })] });
  }

  TAYL.views.yearEnd = {
    key: 'nav.yearEnd', perm: 'year_end.view',
    async render(root, app) {
      const years = await api.get('/api/year-end/years');
      if (!years.length) { fill(root, pageHead('nav.yearEnd'), el('p', { class: 'muted empty', text: t('fiscal.none') })); return; }
      const today = new Date().toISOString().slice(0, 10);
      if (!years.some((y) => y.id === state.yearId)) state.yearId = (years.filter((y) => y.endDate < today).sort((a, b) => (a.endDate < b.endDate ? 1 : -1))[0] || years[0]).id;
      const st = await api.get('/api/year-end/status?fiscalYearId=' + state.yearId);
      const yearSel = el('select', { 'aria-label': t('ledger.fiscalYear'), id: 'ye-year' }, years.map((y) => el('option', { value: String(y.id), text: `${y.code} (${y.startDate} → ${y.endDate})` })));
      yearSel.value = String(state.yearId);
      yearSel.addEventListener('change', () => { state.yearId = Number(yearSel.value); app.rerender(); });
      const brSel = el('select', { 'aria-label': t('journal.branch'), id: 'ye-branch' }, [el('option', { value: 'all', text: t('ye.allRequired') }),
        ...st.branches.map((b) => el('option', { value: String(b.branch.id), text: `${b.branch.code} — ${name(b.branch)}` }))]);
      brSel.value = st.branches.some((b) => String(b.branch.id) === state.branch) ? state.branch : 'all';
      brSel.addEventListener('change', () => { state.branch = brSel.value; });
      const carry = el('input', { type: 'checkbox', id: 'ye-carry' }); carry.checked = state.carry;
      carry.addEventListener('change', () => { state.carry = carry.checked; });
      const out = el('div', { class: 'report-out', 'aria-live': 'polite' });
      const y = st.fiscalYear;
      const pc = (s) => st.periods.filter((p) => p.status === s).length;
      const statusGrid = TAYL.grid.create({
        rows: st.branches, caption: t('ye.branchStatus'), emptyKey: 'ye.noBranches',
        columns: [
          { label: 'journal.branch', render: (b) => `${b.branch.code} — ${name(b.branch)}` },
          { label: 'ye.stateLabel', render: (b) => badge('ye.state.' + b.state, STATE_CLS[b.state]) },
          { label: 'ye.closingEntry', render: (b) => (b.closing ? entryLink(b.closing.entry) : '—') },
          { label: 'ye.resultLabel', render: (b) => (b.closing ? [t('ye.result.' + b.closing.resultSide), ' ', num(b.closing.summary.netResultText)] : '—') },
          { label: 'ye.carryEntry', render: (b) => (b.carryForward ? entryLink(b.carryForward.entry) : '—') },
          { label: 'common.actions', cls: 'actions', sortable: false, render: (b) => [
            b.closing && app.can('year_end.reopen') ? button('ye.reopen', () => revertDialog(app, b, 'reopen'), 'btn small danger') : null,
            b.carryForward && app.can('year_end.revert_carry_forward') ? button('ye.revertCarry', () => revertDialog(app, b, 'revertCarry'), 'btn small danger') : null] },
        ],
      });
      const hist = await api.get('/api/year-end/history?fiscalYearId=' + state.yearId);
      const histGrid = TAYL.grid.create({
        rows: hist, caption: t('ye.history'), emptyKey: 'ye.noHistory',
        columns: [
          { label: 'audit.time', render: (h) => dateTime(h.createdAt) },
          { label: 'journal.branch', render: (h) => h.branch.code },
          { label: 'ye.operation', render: (h) => t('ye.op.' + h.type) },
          { label: 'common.status', render: (h) => badge('ye.opStatus.' + h.status, h.status === 'active' ? 'ok' : 'bad') },
          { label: 'ye.entry', render: (h) => entryLink(h.entry) },
          { label: 'ye.reversalEntry', render: (h) => entryLink(h.reversal) },
          { label: 'audit.actor', render: (h) => el('span', { dir: 'ltr', text: h.createdBy || '' }) },
          { label: 'ye.reason', render: (h) => (h.revertReason ? `${h.revertReason} (${h.revertedBy}, ${dateTime(h.revertedAt)})` : '') },
        ],
      });
      const acts = [
        app.can('year_end.check') ? button('ye.runCheck', () => runPlan(app, out, 'close', false), 'btn') : null,
        app.can('year_end.preview') ? button('ye.previewClose', () => runPlan(app, out, 'close', true), 'btn primary') : null,
        app.can('year_end.preview') ? button('ye.previewCarry', () => runPlan(app, out, 'carry_forward', true), 'btn') : null,
        app.can('year_end.check') ? button('ye.checkCarry', () => runPlan(app, out, 'carry_forward', false), 'btn small') : null,
      ];
      TAYL.keys.setPage([]);
      fill(root,
        pageHead('nav.yearEnd', app.can('year_end.view') ? el('a', { class: 'btn small', href: '#/yearEndReports', text: t('nav.yearEndReports') }) : null,
          button('keys.button', () => TAYL.keys.help(), 'btn small')),
        el('p', { class: 'muted', text: t('ye.intro') }),
        panel(null, el('div', { class: 'filters' }, yearSel, brSel, app.can('year_end.preview') ? el('label', { class: 'check', for: 'ye-carry' }, carry, ' ', t('ye.withCarry')) : null),
          el('div', { class: 'ye-year' },
            el('span', null, `${y.startDate} → ${y.endDate}`), ' ',
            badge(st.companyClosed ? 'ye.companyClosed' : 'ye.companyOpen', st.companyClosed ? 'ok' : 'warn'), ' ',
            !y.ended ? badge('ye.yearNotEnded', 'warn') : null, ' ',
            el('span', { class: 'muted', text: t('ye.periodCounts', { open: pc('open'), closed: pc('closed'), locked: pc('locked') }) }), ' ',
            el('span', { class: 'muted', text: st.nextYear ? t('ye.nextYear', { code: st.nextYear.code }) : t('ye.issue.NEXT_YEAR_MISSING') })),
          el('div', { class: 'form-actions start' }, acts)),
        out,
        panel(null, statusGrid.node),
        panel(null, histGrid.node),
        await settingsPanel(app));
    },
  };

  // ── تقارير الإقفال ──
  const rState = { report: 'result' };
  const REPORTS = ['result', 'entries', 'carried', 'reconciliation', 'branches', 'readiness'];
  function renderReport(name_, r) {
    const T = (cols, rows) => el('div', { class: 'table-wrap' }, el('table', { class: 'data compact' }, el('thead', null, el('tr', null, cols.map((k) => el('th', { text: t(k) })))),
      el('tbody', null, rows)));
    const sideText = (s, text) => (s ? [num(text), ' ', t('ledger.side.' + s)] : num('0'));
    const lang = window.I18N.lang;
    switch (name_) {
      case 'result': return [T(['ledger.accountCode', 'ledger.accountName', 'ye.class', 'ye.beforeClosing', 'ye.afterClosing'], r.rows.map((x) => el('tr', null,
        el('td', { dir: 'ltr', text: x.code }), el('td', { text: lang === 'ar' ? x.nameAr : x.nameEn }), el('td', { text: t('ye.class.' + x.classCode) }),
        el('td', { class: 'num-col' }, sideText(x.beforeSide, x.beforeText)), el('td', { class: 'num-col' }, sideText(x.afterSide, x.afterText))))),
      summaryBox({ totalRevenueText: r.totals.revenueText, totalExpenseText: r.totals.expenseText, netResultText: r.totals.netText, resultSide: r.totals.resultSide, baseCurrency: r.baseCurrency }),
      el('p', { class: 'muted', text: t('ye.closedOf', { n: r.closedBranches, total: r.branches }) }), badge(r.allZeroAfter ? 'ye.allZeroAfter' : 'ye.notZeroAfter', r.allZeroAfter ? 'ok' : 'warn')];
      case 'entries': return T(['ledger.number', 'ye.docKind', 'ledger.date', 'journal.branch', 'ledger.description', 'ye.total'], r.items.map((e) => el('tr', null,
        el('td', null, entryLink(e)), el('td', { text: t('ye.kind.' + e.kind + (e.isReversal ? '_reversal' : '')) + (e.reversed ? ` (${t('ye.reversed')})` : '') }),
        el('td', { dir: 'ltr', text: e.date }), el('td', { text: e.branchCode }), el('td', { text: e.description }), el('td', { class: 'num-col' }, num(e.totalText)))));
      case 'carried': return [T(['journal.branch', 'ledger.number', 'ledger.account', 'ledger.costCenter', 'ledger.amountFc', 'ye.basisLabel', 'ledger.debit', 'ledger.credit'], r.rows.map((x) => el('tr', null,
        el('td', { text: x.branchCode }), el('td', { dir: 'ltr', text: x.number }), el('td', { text: `${x.accountCode} — ${lang === 'ar' ? x.accountNameAr : x.accountNameEn}` }),
        el('td', { text: x.costCenterCode || '' }), el('td', null, num(x.debitFc !== '0' ? x.debitFcText : x.creditFcText), ` ${x.currency} @ ${x.rate}`), el('td', { text: t('ye.basis.' + x.basis) }),
        el('td', { class: 'num-col' }, num(x.debitText)), el('td', { class: 'num-col' }, num(x.creditText))))),
      el('div', { class: 'je-totals' }, el('span', null, t('ledger.totalDebit'), ' ', num(r.totals.debitText)), el('span', null, t('ledger.totalCredit'), ' ', num(r.totals.creditText)),
        badge(r.totals.balanced ? 'journal.balanced' : 'journal.unbalanced', r.totals.balanced ? 'ok' : 'bad'))];
      case 'reconciliation': return [badge(r.ok ? 'ye.match' : 'ye.mismatch', r.ok ? 'ok' : 'bad'), r.branches.map((b) => el('section', { class: 'jr-doc' },
        el('div', { class: 'jr-head' }, el('strong', { text: b.branch.code }), b.carried ? badge(b.ok ? 'ye.match' : 'ye.mismatch', b.ok ? 'ok' : 'bad') : badge('ye.notCarried', 'warn')),
        b.carried ? T(['ledger.account', 'ledger.currency', 'ye.endFc', 'ye.carriedFc', 'ye.endBase', 'ye.carriedBase', 'ye.matchLabel'], b.rows.map((x) => el('tr', null,
          el('td', { text: `${x.accountCode} — ${lang === 'ar' ? x.accountNameAr : x.accountNameEn}` }), el('td', { text: x.currency }),
          el('td', { class: 'num-col' }, num(x.endFcText)), el('td', { class: 'num-col' }, num(x.carriedFcText)), el('td', { class: 'num-col' }, num(x.endBaseText)), el('td', { class: 'num-col' }, num(x.carriedBaseText)),
          el('td', null, badge(x.fcMatch && x.baseMatch ? 'ye.match' : 'ye.mismatch', x.fcMatch && x.baseMatch ? 'ok' : 'bad'), x.residualMoved ? ' ' + t('ye.residualMoved') : '')))) : null))];
      case 'branches': return T(['journal.branch', 'ye.stateLabel', 'ye.closingEntry', 'ye.resultLabel', 'ye.carryEntry'], r.branches.map((b) => el('tr', null,
        el('td', { text: `${b.branch.code} — ${name(b.branch)}` }), el('td', null, badge('ye.state.' + b.state, STATE_CLS[b.state])),
        el('td', null, b.closing ? entryLink(b.closing.entry) : '—'), el('td', null, b.closing ? [t('ye.result.' + b.closing.resultSide), ' ', num(b.closing.summary.netResultText)] : '—'),
        el('td', null, b.carryForward ? entryLink(b.carryForward.entry) : '—'))));
      default: return [badge(r.ready ? 'ye.ready' : 'ye.notReady', r.ready ? 'ok' : 'bad'), T(['journal.branch', 'ye.operation', 'ye.level', 'ye.issue'], r.rows.map((x) => el('tr', null,
        el('td', { text: x.branchCode }), el('td', { text: t('ye.op.' + x.operation) }), el('td', null, badge('ye.level.' + x.level, { error: 'bad', warning: 'warn', info: '' }[x.level])),
        el('td', { text: issueText(x) }))))];
    }
  }
  TAYL.views.yearEndReports = {
    key: 'nav.yearEndReports', perm: 'year_end.view',
    async render(root, app) {
      const years = await api.get('/api/year-end/years');
      if (!state.yearId && years.length) state.yearId = years[years.length - 1].id;
      const yearSel = el('select', { 'aria-label': t('ledger.fiscalYear') }, years.map((y) => el('option', { value: String(y.id), text: `${y.code} (${y.startDate} → ${y.endDate})` })));
      if (state.yearId) yearSel.value = String(state.yearId);
      const brSel = el('select', { 'aria-label': t('journal.branch') }, [el('option', { value: 'all', text: t('ledger.allBranches') }),
        ...app.session.branches.map((b) => el('option', { value: String(b.id), text: `${b.code} — ${name(b)}` }))]);
      brSel.value = state.branch;
      const repSel = el('select', { 'aria-label': t('ye.reportLabel') }, REPORTS.filter((r) => r !== 'readiness' || app.can('year_end.check')).map((r) => el('option', { value: r, text: t('ye.report.' + r) })));
      repSel.value = rState.report;
      const out = el('div', { class: 'report-out', 'aria-live': 'polite' });
      const q = () => { state.yearId = Number(yearSel.value); state.branch = brSel.value; rState.report = repSel.value;
        return new URLSearchParams({ fiscalYearId: String(state.yearId), branch: state.branch, lang: window.I18N.lang }); };
      const show = async () => {
        const qs = q();
        try {
          const r = await api.get(`/api/year-end/reports/${rState.report}?${qs}`);
          fill(out, TAYL.ledgerFinality ? TAYL.ledgerFinality(r.finality) : null, renderReport(rState.report, r));
        } catch (e) { fill(out, el('p', { class: 'form-alert', role: 'alert', text: errorText(e) })); }
      };
      const base = () => `/api/year-end/reports/${repSel.value}`;
      fill(root,
        pageHead('nav.yearEndReports', el('a', { class: 'btn small', href: '#/yearEnd', text: t('nav.yearEnd') }), button('keys.button', () => TAYL.keys.help(), 'btn small')),
        el('p', { class: 'muted', text: t('ye.reportsIntro') }),
        panel(null, el('div', { class: 'filters report-filters' }, repSel, yearSel, brSel), el('div', { class: 'form-actions start' },
          button('ledger.show', show, 'btn primary'),
          app.can('year_end.print') ? button('common.print', () => TAYL.ui.printFrom(`${base()}/print?${q()}`), 'btn small') : null,
          app.can('year_end.export') ? button('common.export', () => TAYL.ui.download(`${base()}/export.xlsx?${q()}`, `year-end-${repSel.value}.xlsx`), 'btn small') : null)),
        out);
      TAYL.keys.setPage([]);
      if (state.yearId) await show();
    },
  };
})();

'use strict';
/* لوحة المعلومات: الشركة والفرع والمستخدم والجلسة، حالة النظام، وخريطة الوحدات (من المرحلة 0). */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
TAYL.views.dashboard = (() => {
  const { el, t, panel, name, dateTime, badge } = TAYL.ui;
  const api = TAYL.api;
  const GROUP_ORDER = ['foundation', 'finance', 'trade', 'inventory', 'production', 'assets', 'reports', 'operations'];

  function fact(label, value, cls) {
    return el('div', null, el('dt', { text: label }), el('dd', { class: cls, text: value }));
  }

  async function render(root, app) {
    const [dash, health, info, modules, ledger] = await Promise.all([
      api.get('/api/dashboard'),
      app.can(['ledger.view', 'journal.view']) ? api.get('/api/ledger/status').catch(() => null) : null,
      api.get('/api/system/health').catch(() => null),
      api.get('/api/system/info').catch(() => null),
      api.get('/api/system/modules').catch(() => null),
    ]).then(([d, l, h, i, m]) => [d, h, i, m, l]);
    const s = app.session;
    const ok = health && health.status === 'ok';

    const counts = [['dash.activeBranches', dash.counts.branches], ['dash.activeUsers', dash.counts.users], ['dash.roles', dash.counts.roles]]
      .filter(([, v]) => v !== null)
      .map(([k, v]) => el('div', { class: 'stat' }, el('span', { class: 'stat-value', text: String(v) }), el('span', { class: 'stat-label', text: t(k) })));

    const roadmap = modules ? GROUP_ORDER.map((g) => {
      const items = modules.roadmap.filter((r) => r.group === g);
      if (!items.length) return null;
      return el('div', { class: 'rm-group' }, el('h3', { text: t('group.' + g) }),
        el('ul', { class: 'rm-list' }, items.map((it) => el('li', { class: it.status === 'active' ? 'active' : '' },
          el('span', { text: window.I18N.lang === 'ar' ? it.ar : it.en }),
          badge(it.status === 'active' ? 'dash.moduleActive' : 'dash.modulePlanned', it.status === 'active' ? 'ok' : 'muted')))));
    }) : null;

    // P9: سنة مالية انتهت ولم تُقفل (لا إقفال قبل المرحلة 4) ⇒ نتائج ما بعدها غير نهائية
    const yearWarnings = ledger && ledger.warnings.length ? el('div', { class: 'notice warn', role: 'status' },
      ledger.warnings.map((w) => el('p', { text: t('ledger.yearEndedNotClosed', { year: w.year.code, end: w.year.endDate }) }))) : null;

    TAYL.ui.fill(root,
      yearWarnings,
      el('div', { class: 'cards' },
        panel('dash.company',
          el('dl', { class: 'facts' },
            fact(t('dash.companyName'), dash.company ? name(dash.company) : '—'),
            fact(t('dash.currentBranch'), s.branch ? `${s.branch.code} — ${name(s.branch)}` : t('dash.noBranch')),
            fact(t('company.baseCurrency'), dash.company ? dash.company.baseCurrency : '—'),
            fact(t('dash.user'), `${s.user.displayName} (${s.user.username})`),
            fact(t('dash.access'), s.user.isSuperAdmin ? t('user.superAdmin') : (s.user.allBranches ? t('user.allBranches') : t('dash.branchCount', { n: s.branches.length }))),
            fact(t('dash.sessionEnds'), dateTime(s.session.expiresAt)),
          )),
        counts.length ? panel('dash.overview', el('div', { class: 'stats' }, counts)) : null,
      ),
      panel('status.title',
        el('dl', { class: 'facts' },
          fact(t('status.server'), ok ? t('status.ok') : t('status.fail'), ok ? 'ok' : 'bad'),
          fact(t('status.database'), health && health.db === 'ok' ? t('status.ok') : t('status.fail'), health && health.db === 'ok' ? 'ok' : 'bad'),
          fact(t('status.version'), info ? info.version : '—'),
          fact(t('status.migrations'), info ? String(info.migrations.length) : '—'),
          fact(t('status.modules'), modules ? `${modules.roadmap.filter((r) => r.status === 'active').length} / ${modules.roadmap.length}` : '—'),
        )),
      dash.lastLogins ? panel('dash.lastLogins', TAYL.ui.table({
        columns: [
          { label: 'audit.time', render: (r) => dateTime(r.occurred_at) },
          { label: 'audit.actor', render: (r) => el('span', { dir: 'ltr', text: r.actor }) },
          { label: 'audit.action', render: (r) => badge('audit.action.' + r.action, r.action.endsWith('success') ? 'ok' : 'bad') },
        ],
        rows: dash.lastLogins,
      })) : null,
      roadmap ? panel('dash.roadmap', el('div', { class: 'rm-grid' }, roadmap)) : null,
    );
  }

  return { key: 'nav.dashboard', perm: null, render };
})();

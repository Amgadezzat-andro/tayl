'use strict';
/*
 * هيكل الواجهة: التشغيل ← (تأسيس | دخول | البرنامج)، التوجيه بالـ hash، القائمة حسب الصلاحيات،
 * والرأس (المستخدم، الفرع الحالي، حالة الجلسة والخادم، الساعة، اللغة).
 * إخفاء عناصر القائمة هنا للراحة فقط؛ الحماية الفعلية في الخادم.
 */
(() => {
  const { el, t, toast, errorText, panel } = TAYL.ui;
  const api = TAYL.api;
  const $ = (id) => document.getElementById(id);
  // القائمة مجمّعة: الرئيسية، الإعداد المحاسبي (م2)، البيانات المرجعية (م2)، الأستاذ العام (م3)، الإدارة، الحساب
  const NAV = [
    { group: null, items: ['dashboard'] },
    { group: 'nav.group.accounting', items: ['accounts', 'costCenters', 'treasury', 'currencies', 'fiscalYears'] },
    { group: 'nav.group.reference', items: ['paymentTerms', 'paymentMethods', 'units'] },
    // المرحلة 3: القيود والأستاذ العام وتقاريره
    { group: 'nav.group.ledger', items: ['journal', 'openingEntries', 'journalRegister', 'accountStatement', 'trialBalance', 'documentSeries'] },
    { group: 'nav.group.admin', items: ['company', 'branches', 'users', 'roles', 'settings', 'audit'] },
    { group: null, items: ['account'] },
  ];
  const WARN_MS = 2 * 60000;
  let authView = null;      // آخر شاشة دخول/تأسيس معروضة (لإعادة رسمها عند تبديل اللغة)
  let serverDown = false;

  const app = {
    session: null,
    can(p) {
      const u = this.session && this.session.user;
      if (!u) return false;
      if (Array.isArray(p)) return p.some((x) => this.can(x));
      return !p || u.isSuperAdmin || u.permissions.includes(p);
    },
    async refreshSession() { this.session = await api.get('/api/auth/session'); renderChrome(); },
    start(s) { this.session = s; showApp(); },
    afterSetup(username) { showAuth('login', { message: 'setup.done', username }); },
    navigate(name) { if (location.hash === '#/' + name) route(); else location.hash = '#/' + name; },
    rerender() { route(); },
  };

  // ── الدخول والتأسيس ──
  function showAuth(kind, opts = {}) {
    app.session = null;
    authView = { kind, opts };
    $('view-app').hidden = true;
    $('view-auth').hidden = false;
    $('boot').hidden = true;
    $('auth-lang').textContent = t('lang.switch');
    if (kind === 'setup') TAYL.auth.setup($('auth-body'), app);
    else if (kind === 'error') $('auth-body').replaceChildren(el('p', { class: 'form-alert', text: t('status.unreachable') }), TAYL.ui.button('common.retry', () => location.reload(), 'btn primary'));
    else TAYL.auth.login($('auth-body'), app, opts);
  }

  // ── البرنامج ──
  function showApp() {
    authView = null;
    $('auth-body').replaceChildren();   // لا تبقى كلمة مرور مكتوبة في عناصر مخفية
    $('view-auth').hidden = true;
    $('boot').hidden = true;
    $('view-app').hidden = false;
    renderChrome();
    if (!location.hash.startsWith('#/')) location.hash = '#/dashboard'; else route();
  }

  function allowed(name) {
    const v = TAYL.views[name];
    return v && app.can(v.perm);
  }

  function renderChrome() {
    const s = app.session;
    if (!s) return;
    const forced = s.user.mustChangePassword;
    const current = currentRoute();
    $('nav').replaceChildren(...NAV.map((g) => {
      const items = g.items.filter((n) => allowed(n) && (!forced || n === 'account'));
      if (!items.length) return null;
      return el('div', { class: 'nav-group' }, g.group ? el('h3', { text: t(g.group) }) : null, items.map((n) => el('a', {
        class: 'nav-item' + (n === current ? ' current' : ''), href: '#/' + n, 'aria-current': n === current ? 'page' : null, text: t(TAYL.views[n].key),
      })));
    }).filter(Boolean));

    $('user-name').textContent = s.user.displayName;
    const sel = $('branch-select');
    sel.replaceChildren(...(s.branches.length ? s.branches : [null]).map((b) => el('option', { value: b ? String(b.id) : '', text: b ? `${b.code} — ${TAYL.ui.name(b)}` : t('dash.noBranch') })));
    sel.value = s.branch ? String(s.branch.id) : '';
    sel.disabled = s.branches.length < 2;
    $('lang-toggle').textContent = t('lang.switch');
    $('logout').textContent = t('auth.logout');
    $('keys-help').textContent = t('keys.button');
    tick();
  }

  function currentRoute() {
    const n = (location.hash.match(/^#\/([a-zA-Z]+)/) || [])[1];
    return n || 'dashboard';
  }

  let routeSeq = 0;
  async function route() {
    if (!app.session) return;
    let name = currentRoute();
    if (app.session.user.mustChangePassword) name = 'account';
    if (!allowed(name)) name = 'dashboard';
    if (name !== currentRoute()) history.replaceState(null, '', '#/' + name);   // العنوان يطابق الشاشة المعروضة فعلًا
    renderChrome();
    TAYL.keys.setPage([]);           // اختصارات الشاشة السابقة لا تبقى فعّالة
    const page = $('page');
    const seq = ++routeSeq;
    page.setAttribute('aria-busy', 'true');
    try {
      const holder = el('div');
      await TAYL.views[name].render(holder, app);
      if (seq !== routeSeq) return;
      TAYL.ui.fill(page, ...holder.childNodes);
    } catch (e) {
      if (seq !== routeSeq || (e && e.status === 401)) return;
      TAYL.ui.fill(page, panel(null, el('p', { class: 'form-alert', text: errorText(e) })));
    } finally {
      page.removeAttribute('aria-busy');
    }
    $('page').focus({ preventScroll: true });
  }

  // ── الساعة والجلسة والخادم ──
  function tick() {
    const now = new Date();
    const h = now.getHours();
    if (app.session) {
      $('greeting').textContent = t('greeting.withName', { greeting: t(h < 12 ? 'greeting.morning' : h < 18 ? 'greeting.afternoon' : 'greeting.evening'), name: app.session.user.displayName });
      $('date').textContent = now.toLocaleDateString(TAYL.ui.locale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
      const idleMs = app.session.session.idleMinutes * 60000;
      const left = Math.min(idleMs - (Date.now() - api.lastActivity), app.session.session.expiresAt - Date.now());
      $('session-state').textContent = t('session.left', { min: Math.max(0, Math.ceil(left / 60000)) });
      $('session-state').className = 'chip' + (left < WARN_MS ? ' warn' : '');
      const banner = $('banner');
      if (serverDown) { banner.hidden = false; banner.replaceChildren(el('span', { text: t('status.unreachable') })); }
      else if (left <= 0) { window.dispatchEvent(new CustomEvent('tayl:unauthenticated')); }
      else if (left < WARN_MS) {
        banner.hidden = false;
        banner.replaceChildren(el('span', { text: t('session.expiring') }), TAYL.ui.button('session.extend', () => app.refreshSession().catch(() => {}), 'btn small'));
      } else banner.hidden = true;
    }
    $('clock').textContent = now.toLocaleTimeString('en-GB');
  }

  async function pollHealth() {
    let down = false;
    try { const h = await fetch('/api/system/health', { headers: { Accept: 'application/json' } }); down = !h.ok; } catch { down = true; }
    serverDown = down;
    const dot = $('server-state');
    dot.className = 'dot ' + (down ? 'bad' : 'ok');
    dot.title = t(down ? 'status.fail' : 'status.ok');
    dot.setAttribute('aria-label', t('status.server') + ': ' + dot.title);
  }

  // ── الأحداث ──
  window.addEventListener('hashchange', route);
  window.addEventListener('tayl:unauthenticated', () => {
    if (!app.session) return;
    api.clear();
    showAuth('login', { message: 'auth.sessionExpired', username: app.session.user.username });
  });

  async function toggleLang() {
    await window.I18N.set(window.I18N.lang === 'ar' ? 'en' : 'ar');
    if (authView) showAuth(authView.kind, authView.opts); else { renderChrome(); route(); }
  }

  async function boot() {
    let status = null;
    try { status = await (await fetch('/api/setup/status')).json(); } catch { /* الخادم غير متاح */ }
    await window.I18N.init(status && status.defaultLanguage);
    $('lang-toggle').addEventListener('click', toggleLang);
    $('keys-help').addEventListener('click', () => TAYL.keys.help());
    $('auth-lang').addEventListener('click', toggleLang);
    $('logout').addEventListener('click', async () => {
      try { await api.post('/api/auth/logout'); } catch { /* الجلسة منتهية أصلًا */ }
      api.clear();
      showAuth('login', { message: 'auth.loggedOut' });
    });
    $('branch-select').addEventListener('change', async (ev) => {
      try {
        app.session = await api.post('/api/auth/branch', { branchId: Number.parseInt(ev.target.value, 10) });
        toast(t('session.branchSwitched', { code: app.session.branch.code }));
        route();
      } catch (e) { toast(errorText(e), 'bad'); renderChrome(); }
    });
    setInterval(tick, 1000);
    setInterval(pollHealth, 30000);
    tick();

    if (!status) return showAuth('error');
    if (!status.setupCompleted) return showAuth('setup');
    try { app.start(await api.get('/api/auth/session', { quiet401: true })); } catch { showAuth('login'); }
    pollHealth();
  }
  TAYL.app = app;
  boot();
})();

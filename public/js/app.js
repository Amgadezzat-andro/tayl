'use strict';
(() => {
  const $ = (id) => document.getElementById(id);
  const t = (k) => window.I18N.t(k);
  const GROUP_ORDER = ['foundation', 'finance', 'trade', 'inventory', 'production', 'assets', 'reports', 'operations'];
  let data = { info: null, modules: null, health: null, unreachable: false };

  const locale = () => (window.I18N.lang === 'ar' ? 'ar-EG-u-nu-latn' : 'en-GB');   // أرقام لاتينية للمحاسبين

  function tick() {
    const now = new Date();
    const h = now.getHours();
    $('greeting').textContent = t(h < 12 ? 'greeting.morning' : h < 18 ? 'greeting.afternoon' : 'greeting.evening');
    $('date').textContent = now.toLocaleDateString(locale(), { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    $('clock').textContent = now.toLocaleTimeString('en-GB');
  }

  function fact(label, value, cls) {
    const wrap = document.createElement('div');
    const dt = document.createElement('dt'); dt.textContent = label;
    const dd = document.createElement('dd'); dd.textContent = value; if (cls) dd.className = cls;
    wrap.append(dt, dd);
    return wrap;
  }

  function renderStatus() {
    const box = $('status'); box.replaceChildren();
    $('status-error').hidden = !data.unreachable;
    if (data.unreachable) { $('status-error').textContent = t('status.unreachable'); box.append(fact(t('status.server'), t('status.fail'), 'bad')); return; }
    if (!data.health) return;
    const ok = data.health.status === 'ok';
    box.append(
      fact(t('status.server'), ok ? t('status.ok') : t('status.fail'), ok ? 'ok' : 'bad'),
      fact(t('status.database'), data.health.db === 'ok' ? t('status.ok') : t('status.fail'), data.health.db === 'ok' ? 'ok' : 'bad'),
      fact(t('status.version'), data.info.version),
      fact(t('status.migrations'), String(data.info.migrations.length)),
      fact(t('status.modules'), data.modules ? `${data.modules.roadmap.filter((r) => r.status === 'active').length} / ${data.modules.roadmap.length}` : '—'),
    );
  }

  function renderModules() {
    if (!data.modules) return;
    const items = data.modules.roadmap;
    const lang = window.I18N.lang;
    const nav = $('nav'); nav.replaceChildren();
    $('side').scrollTop = 0;

    for (const g of GROUP_ORDER) {
      const list = items.filter((i) => i.group === g);
      if (!list.length) continue;

      const ng = document.createElement('div'); ng.className = 'nav-group';
      const nh = document.createElement('h3'); nh.textContent = t('group.' + g); ng.append(nh);

      for (const it of list) {
        const name = lang === 'ar' ? it.ar : it.en;
        const active = it.status === 'active';
        const a = document.createElement('a'); a.className = 'nav-item'; a.href = '#' + it.id;
        if (!active) a.setAttribute('aria-disabled', 'true');
        a.append(document.createTextNode(name));
        ng.append(a);

      }
      nav.append(ng);
    }
  }

  function renderAll() {
    $('lang-toggle').textContent = t('lang.switch');
    tick(); renderStatus(); renderModules();
  }

  async function getJson(url) {
    const r = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!r.ok) throw new Error(url + ' ' + r.status);
    return r.json();
  }

  async function boot() {
    await window.I18N.init();
    $('lang-toggle').addEventListener('click', async () => {
      await window.I18N.set(window.I18N.lang === 'ar' ? 'en' : 'ar');
      renderAll();
    });
    renderAll();
    setInterval(tick, 1000);
    try {
      const [health, info, modules] = await Promise.all([getJson('/api/system/health'), getJson('/api/system/info'), getJson('/api/system/modules')]);
      data = { health, info, modules, unreachable: false };
    } catch { data.unreachable = true; }
    renderAll();
  }
  boot();
})();

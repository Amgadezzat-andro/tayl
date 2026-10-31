'use strict';
/*
 * اختبار المرحلة 2 بمتصفح حقيقي (Chrome headless): لوحة المفاتيح، القوائم الذكية، الشجرة، الاستيراد، العربية/الإنجليزية.
 * بيانات اختبارية فقط على قاعدة مؤقتة. التشغيل:
 *   npm install --no-save puppeteer-core@23.11.1
 *   CHROME_PATH=/usr/bin/google-chrome node tests/e2e/phase2-e2e.js . ./e2e-shots
 */
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');
const PROJECT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const OUT = path.resolve(process.argv[3] || 'e2e-shots');
const { startReady, makeUser, ADMIN } = require(path.join(PROJECT, 'tests/helpers'));
const { writeSheet } = require(path.join(PROJECT, 'server/core/xlsx'));

const results = [];
const check = (n, ok, extra = '') => { results.push({ n, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = await startReady();
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/40[0-9]|429/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  const go = async (r) => { await page.evaluate((x) => { location.hash = '#/' + x; }, r); await sleep(700); };
  const dlgOpen = () => page.evaluate(() => document.getElementById('dialog').open);
  const active = () => page.evaluate(() => { const a = document.activeElement; return a ? (a.name || a.id || a.tagName) : ''; });
  const visibleUi = () => page.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('code, .print-area').forEach((x) => x.remove()); return c.innerText; });
  const untranslated = async () => { const v = await visibleUi(); return (v.match(/\b(nav|common|account|accClass|nature|cc|treasury|currency|fiscal|period|pt|pm|unit|combo|grid|keys|import|master|err|val)\.[a-zA-Z_.]+\b/g) || []).concat(v.match(/\b(null|undefined|NaN)\b/g) || []); };

  await page.goto(s.base, { waitUntil: 'load' });
  await page.waitForSelector('input[name="username"]', { visible: true });
  await page.type('input[name="username"]', ADMIN.username);
  await page.type('input[name="password"]', ADMIN.password);
  await page.keyboard.press('Enter');                                        // Enter في شاشة الدخول يرسل
  await page.waitForSelector('.stat', { visible: true });
  check('login with Enter', true);
  const navGroups = await page.$$eval('#nav h3', (h) => h.map((x) => x.textContent));
  check('grouped navigation (AR)', navGroups.includes('الإعداد المحاسبي') && navGroups.includes('البيانات المرجعية'), navGroups.join('|'));

  // ── دليل الحسابات بلوحة المفاتيح ──
  await go('accounts');
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt');
  await page.waitForSelector('dialog[open] input[name="code"]');
  check('Alt+N opens new-record form with focus on first field', await dlgOpen() && (await active()) === 'code');
  await page.keyboard.type('1');
  await page.keyboard.press('Enter');                                        // ينقل ولا يحفظ
  check('Enter in a field moves to next field, does not save', await dlgOpen() && (await active()) === 'nameAr');
  await page.keyboard.type('الأصول'); await page.keyboard.press('Tab'); await page.keyboard.type('Assets');
  await page.click('dialog input[name="isGroup"]');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control');
  await sleep(800);
  check('Ctrl+S saves the open form', !(await dlgOpen()) && (await page.$$eval('table.data-grid tbody tr', (r) => r.length)) === 1);

  // حساب فرعي: اختيار الأب من القائمة الذكية بالأسهم و Enter، و Esc يغلق القائمة فقط
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt');
  await page.waitForSelector('dialog[open] input[name="code"]');
  await page.keyboard.type('11'); await page.keyboard.press('Tab'); await page.keyboard.type('الأصول المتداولة'); await page.keyboard.press('Tab'); await page.keyboard.type('Current assets');
  await page.keyboard.press('Tab');                                          // إلى القائمة الذكية للأب
  await page.keyboard.press('ArrowDown');
  await page.waitForSelector('.cb-list:not([hidden]) .cb-opt');
  await page.keyboard.type('اصو');                                           // بحث عربي جزئي متسامح (أ/ا)
  await sleep(500);
  const opts = await page.$$eval('.cb-list:not([hidden]) .cb-opt', (o) => o.map((x) => x.textContent));
  check('combobox searches Arabic partial text from server', opts.length === 1 && opts[0].includes('الأصول'), opts.join('|'));
  await page.keyboard.press('Escape');
  check('Esc closes the list but not the dialog', await dlgOpen() && await page.$eval('.cb-list', (l) => l.hidden));
  await page.keyboard.press('ArrowDown'); await sleep(400);
  await page.keyboard.press('Enter');
  const picked = await page.$eval('dialog input[role="combobox"]', (i) => i.value);
  check('arrows + Enter pick the option (no submit)', picked.startsWith('1 —') && await dlgOpen(), picked);
  await page.click('dialog input[name="isGroup"]');
  await page.click('dialog button[type="submit"]'); await sleep(800);
  for (const [code, ar, en] of [['1101', 'الصندوق', 'Cash'], ['1102', 'البنك', 'Bank']]) {
    await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt');
    await page.waitForSelector('dialog[open] input[name="code"]');
    await page.keyboard.type(code); await page.keyboard.press('Tab'); await page.keyboard.type(ar); await page.keyboard.press('Tab'); await page.keyboard.type(en);
    await page.keyboard.press('Tab'); await page.keyboard.type('11'); await sleep(500); await page.keyboard.press('Enter');
    await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(700);
  }
  const codes = await page.$$eval('table.data-grid tbody tr td:first-child code', (c) => c.map((x) => x.textContent));
  check('tree built hierarchically', JSON.stringify(codes) === JSON.stringify(['1', '11', '1101', '1102']), codes.join(','));
  check('table layout: header and rows share the same width (no CSS collision)', await page.evaluate(() => {
    const h = document.querySelector('table.data-grid thead').getBoundingClientRect(); const b = document.querySelector('table.data-grid tbody').getBoundingClientRect();
    return Math.abs(h.left - b.left) < 2 && Math.abs(h.right - b.right) < 2;
  }));
  await shot('p2-01-accounts-tree-ar');

  // التنقل في الشجرة بالأسهم، F2 للتعديل، Esc يعيد التركيز للسطر
  await page.focus('table.data-grid tbody tr[tabindex="0"]');
  await page.keyboard.press('Home');                                         // التحديد يبقى بعد الحفظ؛ نبدأ من الأول
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  const sel = await page.$eval('table.data-grid tbody tr[aria-selected="true"] code', (c) => c.textContent);
  check('arrow keys move row selection', sel === '1101', sel);
  await page.keyboard.press('F2');
  await page.waitForSelector('dialog[open] input[name="code"]');
  check('F2 opens edit for selected row', (await page.$eval('dialog input[name="code"]', (i) => i.value)) === '1101');
  await page.keyboard.press('Escape'); await sleep(300);
  check('Esc closes dialog and focus returns to the row', !(await dlgOpen()) && await page.evaluate(() => document.activeElement && document.activeElement.getAttribute('aria-selected') === 'true'));
  await page.keyboard.press('ArrowUp');                                      // إلى 11
  await page.keyboard.press('ArrowLeft');                                    // RTL: يسار = فتح، يمين = طي
  await page.keyboard.press('ArrowRight'); await sleep(200);
  const afterCollapse = await page.$$eval('table.data-grid tbody tr', (r) => r.length);
  check('Right arrow collapses branch in RTL', afterCollapse === 2, String(afterCollapse));
  await page.keyboard.press('ArrowLeft'); await sleep(200);
  check('Left arrow expands branch in RTL', (await page.$$eval('table.data-grid tbody tr', (r) => r.length)) === 4);

  // Ctrl+F للبحث، والبحث يُظهر المطابقة مع أسلافها
  await page.keyboard.down('Control'); await page.keyboard.press('KeyF'); await page.keyboard.up('Control');
  check('Ctrl+F focuses screen search', (await active()) === 'page-search');
  await page.keyboard.type('بنك'); await sleep(700);
  const found = await page.$$eval('table.data-grid tbody tr td:first-child code', (c) => c.map((x) => x.textContent));
  check('search shows match with its ancestors', JSON.stringify(found) === JSON.stringify(['1', '11', '1102']), found.join(','));
  await page.$eval('#page-search', (i) => { i.value = ''; i.dispatchEvent(new Event('input')); }); await sleep(600);

  // دليل الاختصارات: ما هو منفذ فقط
  await page.click('table.data-grid tbody tr');
  await page.keyboard.press('?'); await sleep(300);
  const keys = await page.$$eval('dialog[open] kbd', (k) => k.map((x) => x.textContent));
  check('? opens shortcuts help listing page shortcuts', await dlgOpen() && keys.includes('Ctrl+N') && keys.includes('F2') && keys.includes('Ctrl+F'), keys.join(' '));
  await shot('p2-02-shortcuts-help');
  await page.keyboard.press('Escape');

  // الاستيراد من Excel عبر المتصفح: معاينة بأخطاء ثم ملف سليم
  const bad = path.join(OUT, 'bad.xlsx'); const good = path.join(OUT, 'good.xlsx');
  fs.writeFileSync(bad, writeSheet({ header: ['كود الحساب', 'الاسم العربي', 'الاسم الإنجليزي', 'كود الأب', 'التصنيف', 'تجميعي'], rows: [['2', 'الالتزامات', 'Liabilities', '', 'الالتزامات', 'نعم'], ['1101', 'مكرر', 'Dup', '11', '', 'لا']] }));
  fs.writeFileSync(good, writeSheet({ header: ['كود الحساب', 'الاسم العربي', 'الاسم الإنجليزي', 'كود الأب', 'التصنيف', 'تجميعي'], rows: [['21', 'موردون', 'Suppliers', '2', '', 'لا'], ['2', 'الالتزامات', 'Liabilities', '', 'الالتزامات', 'نعم']] }));
  const importBtn = await page.evaluateHandle(() => [...document.querySelectorAll('.page-actions button')].find((b) => /Excel/.test(b.textContent) && /استيراد/.test(b.textContent)));
  await importBtn.click();
  await page.waitForSelector('dialog[open] #imp-file');
  await (await page.$('#imp-file')).uploadFile(bad); await sleep(900);
  check('import preview shows row errors and blocks saving', await page.$$eval('tr.row-error', (r) => r.length) === 1 && await page.$eval('dialog .dialog-actions .btn.primary', (b) => b.disabled));
  await shot('p2-03-import-errors');
  await (await page.$('#imp-file')).uploadFile(good); await sleep(900);
  check('valid file enables saving', !(await page.$eval('dialog .dialog-actions .btn.primary', (b) => b.disabled)));
  await page.click('dialog .dialog-actions .btn.primary'); await sleep(900);
  check('import saved all rows', (await page.$$eval('table.data-grid tbody tr td:first-child code', (c) => c.map((x) => x.textContent))).includes('21'));

  // ── السنوات المالية: إنشاء وإغلاق بسبب ──
  await go('fiscalYears');
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt');
  await page.waitForSelector('dialog[open] input[name="code"]');
  await page.type('dialog input[name="code"]', 'FY26');
  await page.type('dialog input[name="nameAr"]', 'السنة 2026/2027'); await page.type('dialog input[name="nameEn"]', 'FY 2026/27');
  await page.$eval('dialog input[name="startDate"]', (i) => { i.value = '2026-07-01'; i.dispatchEvent(new Event('change')); });
  await page.$eval('dialog input[name="endDate"]', (i) => { i.value = '2027-06-30'; i.dispatchEvent(new Event('change')); });
  await sleep(700);
  check('period preview shows 12 periods', (await page.$$eval('.period-preview li', (l) => l.length)) === 12);
  await page.click('dialog button[type="submit"]'); await sleep(900);
  await shot('p2-04a-fiscal-created');
  const closeBtn = await page.evaluateHandle(() => [...document.querySelectorAll('#page button')].find((b) => b.textContent === 'إغلاق الفترة'));
  await closeBtn.click(); await page.waitForSelector('dialog[open] textarea[name="reason"]');
  await page.type('dialog textarea[name="reason"]', 'إغلاق شهر يوليو بعد المراجعة');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control'); await sleep(900);
  check('period closed with reason', (await visibleUi()).includes('إغلاق شهر يوليو بعد المراجعة'));
  await shot('p2-04-fiscal-ar');

  // ── العملات: سعر صرف ──
  await go('currencies');
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt');
  await page.waitForSelector('dialog[open] input[name="code"]');
  await page.type('dialog input[name="code"]', 'USD'); await page.keyboard.press('Tab'); await sleep(600);   // يملأ الأسماء من ISO
  check('ISO code prefills names', (await page.$eval('dialog input[name="nameEn"]', (i) => i.value)) === 'US dollar');
  await page.click('dialog button[type="submit"]'); await sleep(800);
  const ratesBtn = await page.evaluateHandle(() => [...document.querySelectorAll('#page button')].find((b) => b.textContent === 'أسعار الصرف'));
  await ratesBtn.click(); await page.waitForSelector('dialog[open] input[name="rate"]');
  await page.type('dialog input[name="rate"]', '48.123456789012');
  await page.click('dialog button[type="submit"]'); await sleep(800);
  check('exchange rate stored with full precision', (await page.$$eval('dialog .num', (n) => n.map((x) => x.textContent))).includes('48.123456789012'));
  await page.keyboard.press('Escape');

  // ── كل الشاشات الجديدة بالعربية ثم الإنجليزية بلا مفاتيح غير مترجمة ──
  for (const r of ['accounts', 'costCenters', 'treasury', 'currencies', 'fiscalYears', 'paymentTerms', 'paymentMethods', 'units']) {
    await go(r);
    const u = await untranslated();
    if (u.length) check(`no untranslated text AR ${r}`, false, u.join(','));
  }
  check('all Phase 2 screens translated (AR)', !results.some((x) => !x.ok && x.n.startsWith('no untranslated text AR')));
  await page.click('#lang-toggle'); await sleep(800);
  check('English switches to LTR', (await page.evaluate(() => document.documentElement.dir)) === 'ltr');
  for (const r of ['accounts', 'costCenters', 'treasury', 'currencies', 'fiscalYears', 'paymentTerms', 'paymentMethods', 'units']) {
    await go(r);
    const u = await untranslated();
    if (u.length) check(`no untranslated text EN ${r}`, false, u.join(','));
    if (r === 'accounts') await shot('p2-05-accounts-en');
    if (r === 'paymentTerms') await shot('p2-06-payment-terms-en');
  }
  check('all Phase 2 screens translated (EN)', !results.some((x) => !x.ok && x.n.startsWith('no untranslated text EN')));
  await go('accounts');
  await page.focus('table.data-grid tbody tr[tabindex="0"]');
  await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowRight'); await sleep(200);   // LTR: يمين = فتح
  check('Right arrow expands in LTR', (await page.$$eval('table.data-grid tbody tr', (r) => r.length)) >= 4);
  await page.click('#lang-toggle'); await sleep(600);

  // ── مستخدم محدود: البيانات البنكية مقنّعة وأزرار غير المسموح مخفية والخادم يرفض ──
  const egp = (await s.admin.get('/api/currencies/lookup?q=EGP')).body.items[0].id;
  const hq = s.app.db.prepare("SELECT id FROM branches WHERE code='HQ'").get().id;
  await s.admin.post('/api/treasuries', { code: 'BNK', nameAr: 'حساب جاري', nameEn: 'Current', kind: 'bank', bankName: 'بنك', accountNumber: '9988776655', iban: 'GB82WEST12345698765432', branchId: hq, currencyId: egp });
  const u = await makeUser(s, { username: 'clerk2', permissions: ['treasury.view', 'accounts.view'], branchIds: [hq] });
  await page.click('#logout'); await page.waitForSelector('input[name="username"]');
  await page.type('input[name="username"]', 'clerk2'); await page.type('input[name="password"]', u.password); await page.keyboard.press('Enter');
  await page.waitForSelector('#page .panel', { visible: true });   // بلا صلاحيات العدّ لا تظهر بطاقات الأرقام
  await go('treasury');
  const txt = await visibleUi();
  check('limited user sees masked bank data', txt.includes('••••5432') && !txt.includes('GB82WEST12345698765432'));
  check('no add/export buttons without permission', !(await page.$('.page-actions .btn.primary')) && !txt.includes('تصدير'));
  const direct = await page.evaluate(async () => (await fetch('/api/treasuries/export.xlsx')).status);
  check('server rejects direct export request', direct === 403);
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt'); await sleep(300);
  check('Alt+N does nothing without create permission', !(await dlgOpen()));

  await page.setViewport({ width: 390, height: 844 });
  await go('accounts');
  check('mobile: no horizontal page scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  check('no console errors / CSP violations', errors.length === 0, errors.join(' || '));

  await browser.close(); await s.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nPhase 2 E2E: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

'use strict';
/*
 * اختبار المرحلة 3 بمتصفح حقيقي (Chrome headless): القيود (لوحة المفاتيح، المعاينة من الخادم، الحفظ، الترحيل، العكس)،
 * الافتتاحي، دفتر اليومية، كشف الحساب، ميزان المراجعة، سلاسل الترقيم، تحذير P9، العربية/الإنجليزية، الصلاحيات، الهاتف.
 * بيانات اختبارية فقط على قاعدة مؤقتة. التشغيل:
 *   npm install --no-save puppeteer-core@23.11.1
 *   CHROME_PATH=/usr/bin/google-chrome node tests/e2e/phase3-e2e.js . ./e2e-shots
 */
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');
const PROJECT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const OUT = path.resolve(process.argv[3] || 'e2e-shots');
const { startReady, makeUser, ADMIN } = require(path.join(PROJECT, 'tests/helpers'));
const { seedLedger, postNew } = require(path.join(PROJECT, 'tests/ledger-helpers'));

const results = [];
const check = (n, ok, extra = '') => { results.push({ n, ok: !!ok }); console.log((ok ? 'PASS ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = await startReady();
  // سنة 2025 منتهية (تحذير P9) ثم بيانات 2026
  await s.admin.post('/api/fiscal-years', { code: 'FY25', nameAr: '2025', nameEn: '2025', startDate: '2025-01-01', endDate: '2025-12-31', periodType: 'monthly' });
  const seed = await seedLedger(s);
  const limited = await makeUser(s, { username: 'reader', permissions: ['journal.view', 'ledger.view'], allBranches: true });
  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/40[0-9]|429|503/.test(m.text())) errors.push(m.text()); });
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  const go = async (r) => { await page.evaluate((x) => { location.hash = '#/' + x; }, r); await sleep(900); };
  const visibleUi = () => page.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('code, .print-area').forEach((x) => x.remove()); return c.innerText; });
  const untranslated = async () => { const v = await visibleUi(); return (v.match(/\b(nav|common|journal|ledger|series|fiscal|err|val|account)\.[a-zA-Z_.]+\b/g) || []).concat(v.match(/\b(null|undefined|NaN)\b/g) || []); };
  const clickText = async (txt, scope = '') => { const h = await page.evaluateHandle((x, sc) => [...document.querySelectorAll(sc + ' button')].find((b) => b.textContent.trim() === x && b.offsetParent !== null), txt, scope); if (!h.asElement()) throw new Error('no button ' + txt); await h.asElement().click(); };
  const type = async (sel, text) => { await page.focus(sel); await page.keyboard.type(text); };

  await page.goto(s.base, { waitUntil: 'load' });
  await page.waitForSelector('input[name="username"]', { visible: true });
  await page.type('input[name="username"]', ADMIN.username);
  await page.type('input[name="password"]', ADMIN.password);
  await page.keyboard.press('Enter');
  await page.waitForSelector('#nav .nav-item', { visible: true });

  // ── P9 على لوحة المعلومات ──
  check('dashboard shows ended-year warning (P9)', (await visibleUi()).includes('انتهت السنة المالية FY25'));
  check('ledger navigation group (AR)', (await page.$$eval('#nav h3', (h) => h.map((x) => x.textContent))).includes('الأستاذ العام'));

  // ── قيد جديد بلوحة المفاتيح فقط ──
  await go('journal');
  await page.keyboard.down('Alt'); await page.keyboard.press('KeyN'); await page.keyboard.up('Alt');
  await page.waitForSelector('#je-desc'); await sleep(500);
  check('Alt+N opens entry editor with focus on description', await page.evaluate(() => document.activeElement && document.activeElement.id === 'je-desc'));
  await page.keyboard.type('بيع نقدي');
  await page.keyboard.press('Enter');                                  // Enter ينتقل ولا يحفظ
  check('Enter in header moves to next field, no save', (await page.evaluate(() => location.hash)).startsWith('#/journalEntry?new'));
  const rowInput = (i, sel) => `.je-lines tbody tr:nth-child(${i}) ${sel}`;
  const pickAccount = async (i, code) => {
    await page.click(rowInput(i, 'td.acc input')); await page.keyboard.type(code); await sleep(500);
    await page.keyboard.press('Enter'); await sleep(150);               // Enter يختار من القائمة
  };
  await pickAccount(1, '1101');
  check('combobox picks account with Enter', (await page.$eval(rowInput(1, 'td.acc input'), (i) => i.value)).startsWith('1101'));
  await page.click(rowInput(1, 'input.debit')); await page.keyboard.type('100.25');
  await page.keyboard.press('Enter');                                  // ← خلية الدائن
  check('Enter moves to next cell in the line', await page.evaluate(() => document.activeElement.classList.contains('credit')));
  await pickAccount(2, '4101');
  await page.click(rowInput(2, 'input.credit')); await page.keyboard.type('100');
  await sleep(900);
  let totals = await page.$eval('.je-totals', (n) => n.innerText);
  check('server preview shows real difference', /0[.,]25/.test(totals) && totals.includes('غير متزن'), totals.replace(/\s+/g, ' '));
  await page.click(rowInput(2, 'input.credit'), { clickCount: 3 }); await page.keyboard.type('100.25'); await sleep(900);
  totals = await page.$eval('.je-totals', (n) => n.innerText);
  check('balanced after correction (server-calculated)', totals.includes('متزن') && !totals.includes('غير متزن'));
  // سطر ثالث بالإدراج والحذف بالاختصار
  await page.focus(rowInput(2, 'input.credit'));
  await page.keyboard.press('Insert'); await sleep(200);
  check('Insert adds a line', (await page.$$('.je-lines tbody tr')).length === 3);
  await page.keyboard.down('Control'); await page.keyboard.press('Delete'); await page.keyboard.up('Control'); await sleep(300);
  check('Ctrl+Delete removes the line', (await page.$$('.je-lines tbody tr')).length === 2);
  await shot('p3-01-editor-ar');
  await page.keyboard.down('Control'); await page.keyboard.press('KeyS'); await page.keyboard.up('Control');
  await page.waitForFunction(() => location.hash.startsWith('#/journalEntry?id='), { timeout: 5000 }); await sleep(700);
  check('Ctrl+S saves draft without a number', (await visibleUi()).includes('مسودة — بلا رقم'));

  // ── الترحيل (تأكيد، ثم رقم) ──
  await clickText('ترحيل', '.page-head'); await sleep(300);
  await clickText('تأكيد', 'dialog'); await sleep(900);
  let ui = await visibleUi();
  check('post assigns number JV-HQ-FY2026-000001', (await page.$eval('.je-number', (n) => n.textContent)) === 'JV-HQ-FY2026-000001');
  check('posted entry: no edit/delete/post buttons', !/(تعديل|حذف|ترحيل)\n/.test((await page.$eval('.page-head', (n) => n.innerText)).replace('قيد عكسي', '')));
  check('posted entry shows base totals', ui.includes('100.25'));

  // ── العكس ──
  await clickText('قيد عكسي', '.page-head'); await page.waitForSelector('dialog[open] textarea[name="reason"]');
  await page.type('dialog textarea[name="reason"]', 'خطأ في التسجيل');
  await page.click('dialog button[type="submit"]'); await sleep(1100);
  check('reversal posted with RV number and link', (await page.$eval('.je-number', (n) => n.textContent)) === 'RV-HQ-FY2026-000001' && (await visibleUi()).includes('JV-HQ-FY2026-000001'));
  await shot('p3-02-reversal-ar');
  await page.click('a[href^="#/journalEntry?id="]'); await sleep(900);
  ui = await visibleUi();
  check('original shows reversed status and no reverse button', ui.includes('معكوس') && !(await page.$eval('.page-head', (n) => n.innerText)).includes('قيد عكسي'));

  // ── قيد بعملة أجنبية: المبلغ الأساسي من الخادم ──
  await postNew(s, seed, [{ accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '33.33' }, { accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '33.34' }, { accountId: seed.acc.bankUsd.id, currencyId: seed.usd.id, debit: '33.33' }, { accountId: seed.acc.sales.id, currencyId: seed.usd.id, credit: '100' }]);
  await go('journal'); await sleep(300);
  const listText = await page.$eval('#page', (n) => n.innerText);          // الأرقام داخل <code> فلا تُستبعد هنا
  check('journal list shows posted, reversed and reversal', listText.includes('RV-HQ-FY2026-000001') && listText.includes('JV-HQ-FY2026-000002') && listText.includes('معكوس') && listText.includes('عكسي'));

  // ── الافتتاحي ──
  await go('openingEntries');
  await clickText('قيد افتتاحي جديد', '.page-head'); await page.waitForSelector('#je-date');
  check('opening editor: date fixed to first fiscal year start', await page.$eval('#je-date', (i) => i.disabled && i.value === '2025-01-01'));
  await go('journal');

  // ── التقارير ──
  await go('journalRegister'); await sleep(600);
  ui = await visibleUi();
  check('journal register lists documents with reversal relation', ui.includes('JV-HQ-FY2026-000002') && ui.includes('يعكس JV-HQ-FY2026-000001'));
  check('report shows "not final" banner', ui.includes('نتائج غير نهائية'));
  await go('accountStatement'); await sleep(400);
  await page.click('.report-filters .cb-inline.wide input'); await page.keyboard.type('1102'); await sleep(500); await page.keyboard.press('Enter');
  await clickText('عرض'); await sleep(900);
  ui = await visibleUi();
  check('statement shows opening, movements and running balance', ui.includes('رصيد أول المدة') && ui.includes('4,812.35') && ui.includes('مدين'));
  await shot('p3-03-statement-ar');
  await go('trialBalance'); await sleep(900);
  ui = await visibleUi();
  check('trial balance balanced with group roll-up', ui.includes('الميزان متزن') && ui.includes('الأصول'));
  const tbCode = await page.$('table.tb a[href^="#/accountStatement"]');
  await tbCode.click(); await sleep(1200);
  check('trial balance row opens the account statement', (await page.evaluate(() => location.hash)).startsWith('#/accountStatement') && (await visibleUi()).includes('رصيد آخر المدة'));
  await go('trialBalance'); await sleep(800);
  await shot('p3-04-trial-balance-ar');

  // ── سلاسل الترقيم ──
  await go('documentSeries'); await sleep(500);
  ui = await visibleUi();
  check('numbering series listed with example', ui.includes('JV-HQ-FY'));
  // [م4] سلاسل الإقفال الجديدة تظهر في القائمة أيضًا: زر تعديل صف JV المستخدم تحديدًا
  const editBtn = await page.evaluateHandle(() => [...document.querySelectorAll('#page tr')].find((r) => /^JV\b/.test(r.innerText.trim()) || r.innerText.includes('JV-HQ-FY')).querySelector('button'));
  await editBtn.click(); await page.waitForSelector('dialog[open]');
  check('used series: locked fields disabled with notice', await page.$eval('dialog input[name="prefix"]', (i) => i.disabled) && (await visibleUi()).includes('مقفلة'));
  await page.keyboard.press('Escape');

  // ── كل الشاشات الجديدة بلا مفاتيح غير مترجمة بالعربية ثم الإنجليزية ──
  const screens = ['journal', 'openingEntries', 'journalRegister', 'accountStatement', 'trialBalance', 'documentSeries'];
  for (const r of screens) { await go(r); const u = await untranslated(); if (u.length) check(`AR untranslated ${r}`, false, u.join(',')); }
  check('all Phase 3 screens translated (AR)', !results.some((x) => !x.ok && x.n.startsWith('AR untranslated')));
  await page.click('#lang-toggle'); await sleep(800);
  check('English switches to LTR', (await page.evaluate(() => document.documentElement.dir)) === 'ltr');
  for (const r of screens) { await go(r); const u = await untranslated(); if (u.length) check(`EN untranslated ${r}`, false, u.join(',')); }
  await go('journalEntry?id=1'); { const u = await untranslated(); if (u.length) check('EN untranslated detail', false, u.join(',')); }
  check('all Phase 3 screens translated (EN)', !results.some((x) => !x.ok && x.n.startsWith('EN untranslated')));
  await go('trialBalance'); await sleep(800);
  await shot('p3-05-trial-balance-en');
  await page.click('#lang-toggle'); await sleep(800);

  // ── الهاتف ──
  await page.setViewport({ width: 390, height: 844 });
  for (const r of ['journalEntry?new=general', 'trialBalance', 'journalRegister']) {
    await go(r); await sleep(500);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
    if (over > 1) check('mobile overflow ' + r, false, String(over));
  }
  check('mobile: no horizontal page scroll on Phase 3 screens', !results.some((x) => !x.ok && x.n.startsWith('mobile overflow')));
  await shot('p3-06-mobile-editor');
  await page.setViewport({ width: 1440, height: 950 });

  // ── مستخدم محدود: عرض فقط ──
  await clickText('خروج'); await page.waitForSelector('input[name="username"]', { visible: true });
  await page.type('input[name="username"]', 'reader'); await page.type('input[name="password"]', limited.password); await page.keyboard.press('Enter');
  await page.waitForSelector('#nav .nav-item', { visible: true });
  await go('journal');
  const headBtns = await page.$eval('.page-head', (n) => n.innerText);
  check('view-only user: no new-entry buttons', !headBtns.includes('قيد جديد'));
  await go('journalEntry?id=2'); await sleep(400);
  const detailBtns = await page.$eval('.page-head', (n) => n.innerText);
  check('view-only user: no reverse/print buttons', !detailBtns.includes('قيد عكسي') && !detailBtns.includes('طباعة'));
  const direct = await page.evaluate(async () => { try { await TAYL.api.post('/api/journal/2/reverse', { reason: 'محاولة مباشرة' }); return 'allowed'; } catch (e) { return e.status; } });
  check('server rejects direct reverse by view-only user', direct === 403);
  await go('trialBalance'); await sleep(600);
  check('view-only user: no print/export buttons on reports', !(await page.$eval('#page', (n) => n.innerText)).includes('تصدير'));

  check('no console errors / CSP violations', errors.length === 0, errors.slice(0, 3).join(' | '));
  await browser.close();
  await s.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\nPhase 3 E2E: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

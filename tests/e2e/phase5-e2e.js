'use strict';
/*
 * اختبار المرحلة 5 بمتصفح حقيقي (Chrome headless): مركز القوائم المالية (الدخل، المركز المالي، التدفقات)، المقارنة،
 * التتبع من البند إلى كشف الحساب، القائمة غير المكتملة وإعداد التصنيف، العربية RTL/الإنجليزية LTR، الصلاحيات، الهاتف.
 * بيانات اختبارية فقط على قاعدة مؤقتة. التشغيل:
 *   npm install --no-save puppeteer-core@23.11.1
 *   CHROME_PATH=/usr/bin/google-chrome node tests/e2e/phase5-e2e.js . ./e2e-shots
 */
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');
const PROJECT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const OUT = path.resolve(process.argv[3] || 'e2e-shots');
const { startReady, makeUser, ADMIN } = require(path.join(PROJECT, 'tests/helpers'));
const { ok } = require(path.join(PROJECT, 'tests/ledger-helpers'));
const { post } = require(path.join(PROJECT, 'tests/year-end-helpers'));
const { seedFs, profit2024 } = require(path.join(PROJECT, 'tests/fs-helpers'));

const results = [];
const check = (n, pass, extra = '') => { results.push({ n, ok: !!pass }); console.log((pass ? 'PASS ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = await startReady();
  const seed = await seedFs(s);
  await profit2024(s, seed);
  await post(s, seed, '2024-04-04', [{ accountId: seed.acc.cash.id, debit: '900' }, { accountId: seed.acc.sales.id, credit: '900' }], { branch: seed.alx });
  await makeUser(s, { username: 'fsalx', permissions: ['financial_statements.view', 'ledger.view'], branchIds: [seed.alx.id] });

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  const errors = [];
  const watch = (p) => {
    p.on('console', (m) => { if (m.type() === 'error' && !/40[0-9]|429|503/.test(m.text())) errors.push(m.text()); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  };
  watch(page);
  const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  const go = async (p, r) => { await p.evaluate((x) => { location.hash = '#/' + x; }, r); await sleep(1100); };
  const visibleUi = (p = page) => p.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('code, .print-area').forEach((x) => x.remove()); return c.innerText; });
  const untranslated = async (p = page) => { const v = await visibleUi(p); return (v.match(/\b(nav|common|journal|ledger|ye|fs|fiscal|err|val|accClass)\.[a-zA-Z_.]+\b/g) || []).concat(v.match(/\b(null|undefined|NaN)\b/g) || []); };
  const clickText = async (txt, scope = '', p = page) => {
    const h = await p.evaluateHandle((x, sc) => [...document.querySelectorAll(sc + ' button')].find((b) => b.textContent.trim() === x && b.offsetParent !== null), txt, scope);
    if (!h.asElement()) throw new Error('no button ' + txt);
    await h.asElement().click();
  };
  const login = async (p, u, pw) => {
    await p.goto(s.base, { waitUntil: 'load' });
    await p.waitForSelector('input[name="username"]', { visible: true });
    await p.type('input[name="username"]', u); await p.type('input[name="password"]', pw);
    await p.keyboard.press('Enter');
    await p.waitForSelector('#nav .nav-item', { visible: true });
  };
  const showFor = async (p, report, extra = async () => {}) => {
    await p.select('#fs-report', report); await p.select('#fs-year', String(seed.fy[2024].id)); await sleep(150);
    await extra();
    await clickText('عرض', '', p).catch(() => clickText('Show', '', p)); await sleep(1100);
  };
  const disabled = (txt) => page.evaluate((x) => { const b = [...document.querySelectorAll('button')].find((y) => y.textContent.trim().startsWith(x)); return !b || b.disabled || b.hidden; }, txt);

  await login(page, ADMIN.username, ADMIN.password);
  const groups = await page.$$eval('#nav h3', (h) => h.map((x) => x.textContent));
  check('nav: financial reports group (AR)', groups.includes('التقارير المالية'));

  // ── قائمة الدخل ──
  await go(page, 'financialStatements');
  await showFor(page, 'income-statement');
  let ui = await visibleUi();
  check('income statement RTL with sections and subtotals', await page.evaluate(() => document.documentElement.dir === 'rtl') && ui.includes('مجمل الربح') && ui.includes('الربح (الخسارة) التشغيلي') && ui.includes('صافي الربح (الخسارة)'));
  check('net profit 2,500.00 for all branches (HQ 1,600 + ALX 900)', ui.includes('2,500.00'));
  check('status badges: classified, reconciled, not final', ui.includes('مكتملة التصنيف') && ui.includes('مطابقة لميزان المراجعة') && ui.includes('نتائج غير نهائية'));
  check('print and export enabled for an issuable statement', !(await disabled('طباعة')) && !(await disabled('تصدير')));
  await shot(page, 'p5-01-income-ar');

  // ── مجموعة فروع + مقارنة ──
  await showFor(page, 'income-statement', async () => {
    await page.evaluate((id) => { const sel = document.getElementById('fs-branches'); [...sel.options].forEach((o) => { o.selected = o.value === String(id); }); }, seed.hq.id);
    await page.select('#fs-compare', 'previous_year');
  });
  ui = await visibleUi();
  check('branch scope + comparison columns (difference, %)', ui.includes('الفروع: HQ') && ui.includes('الفرق') && ui.includes('النسبة') && ui.includes('1,600.00'));
  await page.evaluate(() => { document.querySelectorAll('#fs-branches option').forEach((o) => { o.selected = false; }); });
  await page.select('#fs-compare', 'none');

  // ── التتبع: البند ← كشف الحساب (قبل الإقفال وبالنطاق نفسه) ──
  await showFor(page, 'income-statement');
  const link = await page.evaluateHandle(() => [...document.querySelectorAll('.fs-table a')].find((a) => a.textContent.startsWith('4101')));
  await link.asElement().click(); await sleep(1500);
  ui = await visibleUi();
  check('drill-down opens account statement with same range, pre-closing', (await page.evaluate(() => location.hash)).includes('excludeClosing=1') && ui.includes('5,900.00') && await page.$eval('#st-pre-close', (c) => c.checked));
  await shot(page, 'p5-02-drilldown');

  // ── المركز المالي والتدفقات ──
  await go(page, 'financialStatements');
  await showFor(page, 'balance-sheet');
  ui = await visibleUi();
  check('balance sheet balanced with unclosed result line', ui.includes('متزنة') && ui.includes('نتائج فترات غير مُقفلة') && ui.includes('إجمالي الالتزامات وحقوق الملكية') && ui.includes('18,000.00'));
  await shot(page, 'p5-03-balance-ar');
  await showFor(page, 'cash-flow');
  ui = await visibleUi();
  check('cash flow: three activities, opening/closing cash', ui.includes('الأنشطة الاستثمارية') && ui.includes('-3,000.00') && ui.includes('النقدية آخر المدة') && ui.includes('الطريقة غير المباشرة'));

  // ── قائمة غير مكتملة ⇒ لا طباعة، ورابط الإعداد يصلحها ──
  const odd = ok(await s.admin.post('/api/accounts', { code: '4199', nameAr: 'إيراد متنوع', nameEn: 'Misc income', parentId: seed.groups.revenue.id }));
  await post(s, seed, '2024-08-01', [{ accountId: seed.acc.cash.id, debit: '50' }, { accountId: odd.id, credit: '50' }]);
  await showFor(page, 'income-statement');
  ui = await visibleUi();
  check('unclassified account ⇒ incomplete, print/export disabled', ui.includes('غير مكتملة') && ui.includes('4199') && await disabled('طباعة') && await disabled('تصدير'));
  await shot(page, 'p5-04-incomplete');
  await page.click('a[href="#/fsSettings"]'); await sleep(1200);
  const sel = await page.evaluateHandle(() => [...document.querySelectorAll('tr')].find((r) => r.innerText.includes('4199')).querySelector('select'));
  await sel.asElement().select('other_income'); await sleep(1300);
  check('settings: account classified, no longer listed as needing classification', !(await page.evaluate(() => [...document.querySelectorAll('section, .panel')][0].innerText.includes('4199 '))) || (await visibleUi()).includes('كل الحسابات مصنفة'));
  await go(page, 'financialStatements'); await showFor(page, 'income-statement');
  check('statement complete again and issuable', (await visibleUi()).includes('مكتملة التصنيف') && !(await disabled('طباعة')));

  // ── الإنجليزية ──
  await page.click('#lang-toggle'); await sleep(900);
  await go(page, 'financialStatements');
  await page.select('#fs-year', String(seed.fy[2024].id)); await clickText('Show'); await sleep(1100);
  ui = await visibleUi();
  check('English LTR income statement', await page.evaluate(() => document.documentElement.dir === 'ltr') && ui.includes('Gross profit') && ui.includes('Net profit (loss)'));
  const missEn = await untranslated();
  check('no untranslated keys (EN)', missEn.length === 0, missEn.join(', '));
  await go(page, 'fsSettings');
  const missEn2 = await untranslated();
  check('no untranslated keys on settings (EN)', missEn2.length === 0, missEn2.join(', '));
  await shot(page, 'p5-05-settings-en');
  await page.click('#lang-toggle'); await sleep(900);
  const missAr = await untranslated();
  check('no untranslated keys (AR)', missAr.length === 0, missAr.join(', '));

  // ── مستخدم فرع بالعرض فقط ──
  const ctx2 = await browser.createBrowserContext();
  const p2 = await ctx2.newPage(); watch(p2);
  await p2.setViewport({ width: 1440, height: 950 });
  await login(p2, 'fsalx', 'Real-Pass-456');
  await go(p2, 'financialStatements');
  await p2.select('#fs-year', String(seed.fy[2024].id)); await clickText('عرض', '', p2); await sleep(1100);
  const ui2 = await visibleUi(p2);
  const opts = await p2.$$eval('#fs-branches option', (o) => o.map((x) => x.textContent));
  check('branch viewer: only own branch, own figures', opts.length === 1 && opts[0].startsWith('ALX') && ui2.includes('900.00') && !ui2.includes('2,500.00'));
  check('viewer: no print/export buttons, no settings link', await p2.evaluate(() => [...document.querySelectorAll('button')].filter((b) => /طباعة|تصدير/.test(b.textContent) && !b.hidden).length === 0) && !(await p2.$('a[href="#/fsSettings"].btn')));

  // ── الهاتف ──
  await page.setViewport({ width: 390, height: 844 });
  for (const r of ['financialStatements', 'fsSettings']) {
    await go(page, r); await sleep(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) check('mobile overflow ' + r, false, String(over));
  }
  check('mobile: no horizontal page scroll on Phase 5 screens', !results.some((x) => !x.ok && x.n.startsWith('mobile overflow')));
  await shot(page, 'p5-06-mobile');

  check('no console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  await s.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

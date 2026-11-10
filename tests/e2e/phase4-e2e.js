'use strict';
/*
 * اختبار المرحلة 4 بمتصفح حقيقي (Chrome headless): مركز الإقفال السنوي (الحالة، فحص الجاهزية بأخطاء مانعة، المعاينة،
 * التنفيذ بتأكيد، عرض المستند، السجل، إعادة الفتح)، تقارير الإقفال، العربية RTL/الإنجليزية LTR، الصلاحيات ونطاق الفروع، الهاتف.
 * بيانات اختبارية فقط على قاعدة مؤقتة. التشغيل:
 *   npm install --no-save puppeteer-core@23.11.1
 *   CHROME_PATH=/usr/bin/google-chrome node tests/e2e/phase4-e2e.js . ./e2e-shots
 */
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');
const PROJECT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const OUT = path.resolve(process.argv[3] || 'e2e-shots');
const { startReady, makeUser, ADMIN } = require(path.join(PROJECT, 'tests/helpers'));
const { ok } = require(path.join(PROJECT, 'tests/ledger-helpers'));
const { seedYears, setRetained, post, closePeriods } = require(path.join(PROJECT, 'tests/year-end-helpers'));

const results = [];
const check = (n, pass, extra = '') => { results.push({ n, ok: !!pass }); console.log((pass ? 'PASS ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = await startReady();
  const seed = await seedYears(s);
  await setRetained(s, seed);
  const A = seed.acc;
  await post(s, seed, '2024-01-05', [{ accountId: A.cash.id, debit: '10000' }, { accountId: A.capital.id, credit: '10000' }]);
  await post(s, seed, '2024-03-10', [{ accountId: A.cash.id, debit: '5000' }, { accountId: A.sales.id, credit: '5000' }]);
  await post(s, seed, '2024-06-30', [{ accountId: A.rent.id, debit: '1200', costCenterId: seed.cc1.id }, { accountId: A.cash.id, credit: '1200' }]);
  await post(s, seed, '2024-04-01', [{ accountId: A.cash.id, debit: '900' }, { accountId: A.sales.id, credit: '900' }], { branch: seed.alx });
  const draft = ok(await s.admin.post('/api/journal', { branchId: seed.hq.id, entryDate: '2024-12-20', description: 'مسودة متروكة', lines: [{ accountId: A.cash.id, debit: '1' }, { accountId: A.sales.id, credit: '1' }] }));
  await closePeriods(s, seed.fy[2024].id);
  await makeUser(s, { username: 'alxview', permissions: ['year_end.view', 'year_end.print', 'ledger.view'], branchIds: [seed.alx.id] });

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
  const go = async (p, r) => { await p.evaluate((x) => { location.hash = '#/' + x; }, r); await sleep(1000); };
  const visibleUi = (p = page) => p.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('code, .print-area').forEach((x) => x.remove()); return c.innerText; });
  const untranslated = async (p = page) => { const v = await visibleUi(p); return (v.match(/\b(nav|common|journal|ledger|ye|fiscal|err|val|perm)\.[a-zA-Z_.]+\b/g) || []).concat(v.match(/\b(null|undefined|NaN)\b/g) || []); };
  const clickText = async (txt, scope = '', p = page) => {
    const h = await p.evaluateHandle((x, sc) => [...document.querySelectorAll(sc + ' button, ' + sc + ' a.btn')].find((b) => b.textContent.trim() === x && b.offsetParent !== null), txt, scope);
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

  await login(page, ADMIN.username, ADMIN.password);
  const navTexts = await page.$$eval('#nav .nav-item', (n) => n.map((x) => x.textContent));
  check('nav: year-end center and reports in Arabic', navTexts.includes('مركز الإقفال السنوي') && navTexts.includes('تقارير الإقفال السنوي'));
  check('dashboard warns about ended years not closed (P9)', (await visibleUi()).includes('FY2024'));

  // ── المركز: الحالة ──
  await go(page, 'yearEnd');
  await page.select('#ye-year', String(seed.fy[2024].id)); await sleep(1100);
  let ui = await visibleUi();
  check('center RTL Arabic by default', await page.evaluate(() => document.documentElement.dir === 'rtl'));
  check('status lists branches as not closed, company not closed', ui.includes('غير مُقفلة لكل الفروع') && (ui.match(/غير مُقفلة/g) || []).length >= 3);
  check('periods summary shown', ui.includes('مفتوحة 0') && ui.includes('مغلقة 12'));

  // ── فحص الجاهزية: خطأ مانع (مسودة) منفصل، والتنفيذ معطّل ──
  await clickText('معاينة الإقفال'); await sleep(1200);
  ui = await visibleUi();
  check('blocking errors shown separately with fix link', ui.includes('أخطاء مانعة') && ui.includes('مسودات قيود') && ui.includes('غير جاهز') && ui.includes('معالجة'));
  check('execute disabled while blocking errors exist', await page.evaluate(() => { const b = [...document.querySelectorAll('button')].find((x) => x.textContent.trim() === 'تنفيذ الإقفال'); return !!b && b.disabled; }));
  await shot(page, 'p4-01-not-ready-ar');
  ok(await s.admin.del('/api/journal/' + draft.id));

  // ── المعاينة ثم التنفيذ بتأكيد صريح (مع ترحيل الأرصدة) ──
  await clickText('معاينة الإقفال'); await sleep(1200);
  ui = await visibleUi();
  check('preview: ready, closing lines and carry-forward lines from server', ui.includes('جاهز') && ui.includes('سطور قيد الإقفال') && ui.includes('سطور ترحيل الأرصدة') && ui.includes('3201') && ui.includes('صافي ربح'));
  check('preview shows profit 3,800.00 for HQ', ui.includes('3,800.00'));
  await shot(page, 'p4-02-preview-ar');
  await clickText('تنفيذ الإقفال', '.report-out'); await page.waitForSelector('dialog[open]');
  const dlg = await page.$eval('dialog[open]', (d) => d.innerText);
  check('confirmation states year, branches and impact', dlg.includes('FY2024') && dlg.includes('HQ') && dlg.includes('ALX') && dlg.includes('لا يُحذف شيء'));
  await clickText('تنفيذ الإقفال', 'dialog'); await sleep(1600);
  ui = await visibleUi();
  check('after execute: both branches closed and carried, company closed', (ui.match(/مُقفلة ومُرحّلة/g) || []).length === 2 && ui.includes('مُقفلة للشركة'));
  check('closing and carry-forward numbers shown', ui.includes('YC-HQ-FY2024-000001') && ui.includes('CF-ALX-FY2025-000001'));
  check('history lists the operations', (ui.match(/نافذة/g) || []).length === 4);
  await shot(page, 'p4-03-closed-ar');
  const link = await page.evaluateHandle(() => [...document.querySelectorAll('a')].find((a) => a.textContent === 'YC-HQ-FY2024-000001'));
  await link.asElement().click(); await page.waitForSelector('dialog[open]'); await sleep(300);
  const ent = await page.$eval('dialog[open]', (d) => d.innerText);
  check('entry dialog shows closing lines balanced', ent.includes('4101') && ent.includes('3201') && ent.includes('5,000.00'));
  await page.keyboard.press('Escape'); await sleep(300);

  // ── التقارير ──
  await go(page, 'yearEndReports');
  await page.select('.report-filters select:nth-of-type(2)', String(seed.fy[2024].id));
  await clickText('عرض'); await sleep(1000);
  ui = await visibleUi();
  check('result report: revenue, expenses, net profit, zero after closing', ui.includes('5,900.00') && ui.includes('1,200.00') && ui.includes('4,700.00') && ui.includes('كل حسابات قائمة الدخل صفر بعد الإقفال'));
  await page.select('.report-filters select:nth-of-type(1)', 'reconciliation'); await clickText('عرض'); await sleep(1000);
  ui = await visibleUi();
  check('reconciliation report matched', (ui.match(/مطابق/g) || []).length >= 4 && !ui.includes('غير مطابق'));
  await page.select('.report-filters select:nth-of-type(1)', 'carried'); await clickText('عرض'); await sleep(1000);
  check('carried balances report lists CF lines balanced', (await visibleUi()).includes('CF-HQ-FY2025-000001') && (await visibleUi()).includes('متزن'));
  check('print and export buttons for permitted user', (await visibleUi()).includes('طباعة') && (await visibleUi()).includes('تصدير'));
  await shot(page, 'p4-04-reports-ar');

  // ── الإنجليزية LTR ──
  await page.click('#lang-toggle'); await sleep(900);
  await go(page, 'yearEnd'); await page.select('#ye-year', String(seed.fy[2024].id)); await sleep(1000);
  ui = await visibleUi();
  check('English LTR center', await page.evaluate(() => document.documentElement.dir === 'ltr') && ui.includes('Year-end closing') && ui.includes('Closed and carried'));
  const missEn = await untranslated();
  check('no untranslated keys (EN)', missEn.length === 0, missEn.join(', '));
  await shot(page, 'p4-05-center-en');
  await page.click('#lang-toggle'); await sleep(900);

  // ── إعادة الفتح بسبب وتأكيد ──
  await go(page, 'yearEnd'); await page.select('#ye-year', String(seed.fy[2024].id)); await sleep(1000);
  const reopenBtns = await page.$$eval('button', (b) => b.filter((x) => x.textContent.trim() === 'إعادة فتح السنة').length);
  check('reopen buttons per closed branch', reopenBtns === 2);
  await clickText('إعادة فتح السنة', 'table'); await page.waitForSelector('dialog[open] #ye-reason');
  await page.type('#ye-reason', 'تصحيح بعد المراجعة');
  await clickText('إعادة فتح السنة', 'dialog'); await sleep(1500);
  ui = await visibleUi();
  check('reopened: branch back to not closed, history keeps reverted ops', ui.includes('ملغاة') && (ui.match(/مُقفلة ومُرحّلة/g) || []).length === 1);
  const missAr = await untranslated();
  check('no untranslated keys (AR)', missAr.length === 0, missAr.join(', '));

  // ── مستخدم فرع بصلاحية العرض فقط ──
  const ctx2 = await browser.createBrowserContext();
  const p2 = await ctx2.newPage(); watch(p2);
  await p2.setViewport({ width: 1440, height: 950 });
  await login(p2, 'alxview', 'Real-Pass-456');
  await go(p2, 'yearEnd'); await p2.select('#ye-year', String(seed.fy[2024].id)); await sleep(1000);
  const ui2 = await visibleUi(p2);
  check('branch viewer sees only own branch', ui2.includes('ALX') && !ui2.includes('HQ —'));
  const btns2 = await p2.$$eval('button', (b) => b.map((x) => x.textContent.trim()).join('|'));
  check('viewer has no check/preview/execute/reopen actions', !/معاينة|فحص الجاهزية|تنفيذ|إعادة فتح السنة|إلغاء الترحيل/.test(btns2) && !(await p2.$('#ye-carry')), btns2);
  check('viewer cannot edit the result account', !(await p2.$('.cb-inline input')));
  await shot(p2, 'p4-06-branch-viewer');

  // ── الهاتف ──
  await page.setViewport({ width: 390, height: 844 });
  for (const r of ['yearEnd', 'yearEndReports']) {
    await go(page, r); await sleep(400);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) check('mobile overflow ' + r, false, String(over));
  }
  check('mobile: no horizontal page scroll on Phase 4 screens', !results.some((x) => !x.ok && x.n.startsWith('mobile overflow')));
  await shot(page, 'p4-07-mobile');

  check('no console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  await s.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

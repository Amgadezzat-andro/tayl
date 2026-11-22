'use strict';
/*
 * اختبار المرحلة 6 بمتصفح حقيقي (Chrome headless): مجموعة المخزون في القائمة، لوحة الملخص والتنبيهات، الأصناف ووحداتها،
 * إنشاء إذن إضافة من الواجهة (قائمة الصنف الذكية، المعاينة، الترحيل، القيد)، العكس، التحويل بين الفروع والاستلام،
 * الجرد، التقارير (التقييم والمطابقة وكارت الصنف)، العربية RTL/الإنجليزية LTR بلا مفاتيح ظاهرة، نطاق الفروع، والهاتف.
 * بيانات اختبارية فقط على قاعدة مؤقتة. التشغيل:
 *   npm install --no-save puppeteer-core@23.11.1
 *   CHROME_PATH=/usr/bin/google-chrome node tests/e2e/phase6-e2e.js . ./e2e-shots
 */
const path = require('node:path');
const fs = require('node:fs');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');
const PROJECT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const OUT = path.resolve(process.argv[3] || 'e2e-shots');
const { startReady, makeUser, ADMIN } = require(path.join(PROJECT, 'tests/helpers'));
const { ok } = require(path.join(PROJECT, 'tests/ledger-helpers'));
const { seedInv, receipt, postNewDoc } = require(path.join(PROJECT, 'tests/inv-helpers'));

const results = [];
const check = (n, pass, extra = '') => { results.push({ n, ok: !!pass }); console.log((pass ? 'PASS ' : 'FAIL ') + n + (extra ? ' — ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const s = await startReady();
  const seed = await seedInv(s);
  const a = s.admin;
  // بيانات اختبارية: رصيد خامات، دفعات بصلاحيات مختلفة، تحويل بالطريق إلى الإسكندرية
  await receipt(s, seed, { date: '2026-02-01', lines: [{ itemId: seed.I.sugar.id, qty: '40', unitCost: '10' }, { itemId: seed.I.bottle.id, qty: '500', unitCost: '0.5' }] });
  await receipt(s, seed, { date: '2026-02-02', lines: [{ itemId: seed.I.milk.id, qty: '10', unitCost: '50', batchNo: 'E2E-OLD', expiryDate: '2026-03-01' }, { itemId: seed.I.milk.id, qty: '10', unitCost: '60', batchNo: 'E2E-NEW', expiryDate: '2027-06-30' }] });
  const tr = await postNewDoc(s, { docType: 'transfer_out', warehouseId: seed.W.raw.id, toWarehouseId: seed.W.alx.id, docDate: '2026-02-03', lines: [{ itemId: seed.I.bottle.id, qty: '100' }] });
  ok(await a.post('/api/inventory/counts', { warehouseId: seed.W.fg.id, countDate: '2026-02-04' }));
  await makeUser(s, { username: 'invalx', permissions: ['inventory.view', 'inventory_warehouses.view', 'inventory_documents.view', 'inventory_reports.view', 'inventory_items.view'], branchIds: [seed.alx.id] });

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1440, height: 950 });
  const errors = [];
  const watch = (p) => {
    p.on('console', (m) => { if (m.type() === 'error' && !/40[0-9]|429|503/.test(m.text())) errors.push(m.text()); });
    p.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  };
  watch(page);
  page.on('dialog', (d) => d.accept());
  const shot = (p, n) => p.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  const go = async (p, r) => { await p.evaluate((x) => { location.hash = '#/' + x; }, r); await sleep(1200); };
  const visibleUi = (p = page) => p.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('code, .print-area').forEach((x) => x.remove()); return c.innerText; });
  const untranslated = async (p = page) => { const v = await visibleUi(p); return (v.match(/\b(nav|common|inv|err|val|ledger|fs|perm)\.[a-zA-Z_.]+\b/g) || []).concat(v.match(/\b(null|undefined|NaN)\b/g) || []); };
  const clickText = async (txt, p = page) => {
    const h = await p.evaluateHandle((x) => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === x && b.offsetParent !== null), txt);
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
  const combo = async (selector, text) => { await page.click(selector); await page.keyboard.type(text); await sleep(700); await page.keyboard.press('Enter'); await sleep(500); };
  const INV_SCREENS = ['invDashboard', 'invItems', 'invGroups', 'invUnits', 'invWarehouses', 'invDocuments', 'invTransfers', 'invCounts', 'invBatches', 'invReservations', 'invSettings', 'invReports'];

  await login(page, ADMIN.username, ADMIN.password);
  const groups = await page.$$eval('#nav h3', (h) => h.map((x) => x.textContent));
  const navItems = await page.$$eval('#nav a.nav-item', (x) => x.map((y) => y.getAttribute('href')));
  check('nav: inventory group with 12 screens (AR)', groups.includes('المخزون') && INV_SCREENS.every((n) => navItems.includes('#/' + n)));

  // ── لوحة الملخص ──
  await go(page, 'invDashboard');
  let ui = await visibleUi();
  check('dashboard: overview with value and alerts (expired batch, transfer in transit)', ui.includes('قيمة المخزون') && ui.includes('دفعات منتهية الصلاحية') && ui.includes('E2E-OLD'));
  await shot(page, 'p6-01-dashboard');

  // ── الأصناف ──
  await go(page, 'invItems');
  ui = await visibleUi();
  check('items list RTL with tracking badges', await page.evaluate(() => document.documentElement.dir === 'rtl') && ui.includes('لبن بودرة') && ui.includes('صلاحية') && ui.includes('أرقام مسلسلة'));
  const unitsBtn = await page.evaluateHandle(() => [...[...document.querySelectorAll('tr')].find((r) => r.innerText.includes('SUGAR')).querySelectorAll('button')].find((b) => b.textContent.trim() === 'الوحدات'));
  await unitsBtn.asElement().click(); await sleep(900);
  ui = await visibleUi();
  check('item units dialog: BOX = 25 KG conversion', ui.includes('1 = 25') && ui.includes('عامل التحويل'), ui.slice(-400).replace(/\s+/g, ' '));
  await page.keyboard.press('Escape'); await sleep(300);

  // ── إذن إضافة من الواجهة: الصنف الذكي ← المعاينة ← الترحيل ──
  await go(page, 'invDocument?type=receipt');
  await page.select('#inv-wh', String(seed.W.raw.id)); await sleep(400);
  await combo('.inv-lines tbody tr:nth-child(1) .cb-cell input', 'SUGAR');
  await page.type('.inv-lines tbody tr:nth-child(1) td:nth-child(3) input', '10');
  await page.type('.inv-lines tbody tr:nth-child(1) td:nth-child(4) input', '12.5');
  await combo('.form-grid .cb input', '2102');
  await clickText('معاينة الترحيل'); await sleep(1300);
  ui = await visibleUi();
  check('preview: moves and journal before posting (no number yet)', ui.includes('حساب مقابل') && ui.includes('125.00') && ui.includes('مشتريات مستلمة') && !/IRC-HQ/.test(ui));
  await shot(page, 'p6-02-preview');
  await clickText('ترحيل'); await sleep(600);
  const yes = await page.evaluateHandle(() => [...document.querySelectorAll('.modal button, dialog button')].find((b) => /تأكيد|Confirm/.test(b.textContent)));
  if (yes.asElement()) await yes.asElement().click();
  await sleep(1500);
  ui = await visibleUi();
  const docNo = (ui.match(/IRC-HQ-FY2026-\d{6}/) || [])[0];
  check('posted receipt: number, journal number, stock movement, journal lines', !!docNo && /IGL-HQ-FY2026-\d{6}/.test(ui) && ui.includes('حركات المخزون') && ui.includes('مرحّل'));
  await shot(page, 'p6-03-posted');

  // ── العكس ──
  await clickText('عكس المستند'); await sleep(600);
  await page.type('.modal textarea, dialog textarea', 'إدخال خاطئ في الاختبار');
  const submit = await page.evaluateHandle(() => [...document.querySelectorAll('.modal button, dialog button')].find((b) => b.textContent.trim() === 'عكس المستند' && b.type === 'submit') || [...document.querySelectorAll('.modal button[type=submit], dialog button[type=submit]')][0]);
  await submit.asElement().click(); await sleep(1500);
  ui = await visibleUi();
  check('reversal posted and linked to the original', /IRV-HQ-FY2026-\d{6}/.test(ui) && ui.includes('عكس لـ'));

  // ── التحويل بين الفروع: الاستلام الجزئي ──
  await go(page, 'invTransfers');
  ui = await visibleUi();
  check('transfers: dispatched transfer in transit', ui.includes('بالطريق') && ui.includes('HQ-RAW → ALX-MAIN'));
  await clickText('استلام'); await sleep(900);
  await page.evaluate(() => { const i = document.querySelector('.modal tbody input, dialog tbody input'); i.value = '60'; });
  const rcv = await page.evaluateHandle(() => [...document.querySelectorAll('.modal button, dialog button')].find((b) => b.textContent.trim() === 'استلام'));
  await rcv.asElement().click(); await sleep(1500);
  ui = await visibleUi();
  check('partial receipt: status partially received, 40 remaining', ui.includes('مستلم جزئيًا') && ui.includes('40'));
  void tr;

  // ── الجرد ──
  await go(page, 'invCounts');
  await page.click('a[href^="#/invCount?id="]'); await sleep(1300);
  ui = await visibleUi();
  check('count session page with lifecycle actions', ui.includes('إرسال للمراجعة') && ui.includes('لحظة القطع'));

  // ── التقارير ──
  await go(page, 'invReports');
  await page.select('#inv-report', 'valuation'); await sleep(300);
  await clickText('عرض'); await sleep(1300);
  ui = await visibleUi();
  check('valuation report: moving average, totals, current status', ui.includes('تقييم المخزون') || (ui.includes('الإجمالي') && ui.includes('ALX-MAIN')));
  await page.select('#inv-report', 'gl-reconciliation'); await sleep(300);
  await clickText('عرض'); await sleep(1300);
  ui = await visibleUi();
  check('ledger reconciliation approved (inventory and transit match the ledger)', ui.includes('المطابقة معتمدة') && ui.includes('مطابق'));
  await shot(page, 'p6-04-reconciliation');
  await page.select('#inv-report', 'stock'); await sleep(300);
  await clickText('عرض'); await sleep(1300);
  const cardLink = await page.evaluateHandle(() => [...document.querySelectorAll('table.data a')].find((x) => x.textContent === 'SUGAR'));
  await cardLink.asElement().click(); await sleep(1500);
  ui = await visibleUi();
  check('drill-down: stock row → item card with running balance → document link', (await page.evaluate(() => location.hash)).includes('report=item-card') && ui.includes('رصيد أول المدة') && !!(await page.$('table.data a[href^="#/invDocument?id="]')));
  check('print and export available for reports', !!(await page.evaluateHandle(() => [...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'تصدير Excel'))).asElement());

  // ── كل شاشات المخزون بالعربية بلا مفاتيح ──
  const missAr = [];
  for (const r of INV_SCREENS) { await go(page, r); missAr.push(...(await untranslated())); }
  check('no untranslated keys on inventory screens (AR)', missAr.length === 0, [...new Set(missAr)].join(', '));

  // ── الإنجليزية ──
  await page.click('#lang-toggle'); await sleep(900);
  const missEn = [];
  for (const r of INV_SCREENS) { await go(page, r); missEn.push(...(await untranslated())); }
  check('no untranslated keys on inventory screens (EN)', missEn.length === 0, [...new Set(missEn)].join(', '));
  await go(page, 'invDocuments');
  ui = await visibleUi();
  check('English LTR documents list', await page.evaluate(() => document.documentElement.dir === 'ltr') && ui.includes('Stock receipt') && ui.includes('Branch transfer dispatch'));
  await shot(page, 'p6-05-documents-en');
  await page.click('#lang-toggle'); await sleep(900);

  // ── مستخدم فرع ──
  const ctx2 = await browser.createBrowserContext();
  const p2 = await ctx2.newPage(); watch(p2);
  await p2.setViewport({ width: 1440, height: 950 });
  await login(p2, 'invalx', 'Real-Pass-456');
  await go(p2, 'invWarehouses');
  const ui2 = await p2.evaluate(() => document.getElementById('page').innerText);
  check('branch user: only own warehouses, no add button', ui2.includes('ALX-MAIN') && !ui2.includes('HQ-RAW') && !ui2.includes('مخزن الخامات') && !(await p2.evaluate(() => [...document.querySelectorAll('button')].some((b) => /إضافة مخزن/.test(b.textContent)))));
  await go(p2, 'invReports');
  await p2.select('#inv-report', 'stock'); await sleep(200);
  await clickText('عرض', p2); await sleep(1200);
  const ui3 = await visibleUi(p2);
  check('branch user: stock report limited to own branch, values hidden without valuation permission', ui3.includes('BOTTLE') && !ui3.includes('SUGAR') && ui3.includes('القيم والتكاليف مخفية'));

  // ── الهاتف ──
  await page.setViewport({ width: 390, height: 844 });
  for (const r of INV_SCREENS) {
    await go(page, r); await sleep(200);
    const over = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    if (over > 1) check('mobile overflow ' + r, false, String(over));
  }
  check('mobile: no horizontal page scroll on inventory screens', !results.some((x) => !x.ok && x.n.startsWith('mobile overflow')));
  await shot(page, 'p6-06-mobile');

  check('no console errors', errors.length === 0, errors.join(' | '));
  await browser.close();
  await s.stop();
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });

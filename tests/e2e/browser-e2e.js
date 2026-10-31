'use strict';
/*
 * اختبار طرف-لطرف بمتصفح حقيقي (Chrome headless) على خادم TAYL حقيقي بقاعدة مؤقتة (بيانات اختبارية فقط).
 * ليس ضمن npm test لأنه يحتاج Chrome و puppeteer-core (ليست تبعيات للبرنامج). التشغيل:
 *   npm install --no-save puppeteer-core@23.11.1      (أو ثبّتها في أي مجلد ومرّر PUPPETEER_PATH)
 *   CHROME_PATH=/usr/bin/google-chrome node tests/e2e/browser-e2e.js . ./e2e-shots
 * ويندوز: CHROME_PATH="C:\Program Files\Google\Chrome\Application\chrome.exe" (أو msedge.exe)
 */
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const puppeteer = require(process.env.PUPPETEER_PATH || 'puppeteer-core');
const PROJECT = path.resolve(process.argv[2] || path.join(__dirname, '..', '..'));
const OUT = path.resolve(process.argv[3] || 'e2e-shots');
const { loadConfig } = require(path.join(PROJECT, 'server/core/config'));
const { createLogger } = require(path.join(PROJECT, 'server/core/logger'));
const { createApp } = require(path.join(PROJECT, 'server/app'));

const results = [];
const check = (name, ok, extra = '') => { results.push({ name, ok: !!ok, extra }); console.log((ok ? 'PASS ' : 'FAIL ') + name + (extra ? ' — ' + extra : '')); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tayl-e2e-'));
  const config = loadConfig({ dataDir, port: 0 });
  let app = await createApp({ config, logger: createLogger({}) });
  let addr = await app.listen();
  let base = `http://127.0.0.1:${addr.port}`;

  const browser = await puppeteer.launch({ executablePath: process.env.CHROME_PATH || '/usr/bin/google-chrome', headless: true, args: ['--no-sandbox', '--lang=ar'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1366, height: 900 });
  const consoleErrors = [];
  page.on('console', (m) => { if (m.type() === 'error' && !/401|403|409|400|429/.test(m.text())) consoleErrors.push(m.text()); });
  page.on('pageerror', (e) => consoleErrors.push('pageerror: ' + e.message));

  const shot = (n) => page.screenshot({ path: path.join(OUT, n + '.png'), fullPage: true });
  const type = async (sel, v) => { await page.waitForSelector(sel, { visible: true }); await page.click(sel, { clickCount: 3 }); await page.type(sel, v); };
  const text = () => page.evaluate(() => document.body.innerText);
  const visibleUi = () => page.evaluate(() => { const c = document.body.cloneNode(true); c.querySelectorAll('code').forEach((x) => x.remove()); return c.innerText; });   // بيانات JSON في سجل التدقيق مستثناة
  const untranslated = async () => { const v = await visibleUi(); return (v.match(/(nav|common|dash|company|branch|user|role|perm|settings|precision|kind|rounding|audit|account|err|val|auth|setup|session|status|currency)\.[a-zA-Z_]+/g) || []).concat(v.match(/(null|undefined|NaN)/g) || []); };
  const go = async (r) => { await page.evaluate((x) => { location.hash = '#/' + x; }, r); await sleep(500); };

  // 1) أول تشغيل: شاشة التأسيس
  await page.goto(base, { waitUntil: 'networkidle0' });
  check('first run shows setup screen', await page.$('input[name="company.nameAr"]'));
  check('page is RTL Arabic by default', (await page.evaluate(() => document.documentElement.dir)) === 'rtl');
  check('official TAYL logo visible on setup', await page.$eval('#view-auth .logo-plate img', (i) => i.complete && i.naturalWidth === 1408));
  await shot('01-setup-ar');

  // محاولة إرسال ناقصة: أخطاء الحقول من الخادم
  await page.click('form button[type="submit"]');
  await sleep(600);
  check('setup validation errors shown per field', (await page.$$eval('.field-error:not([hidden])', (e) => e.length)) >= 4);
  await shot('02-setup-errors');

  await type('input[name="company.nameAr"]', 'شركة تجربة');
  await type('input[name="company.nameEn"]', 'Demo Test Co');
  await type('input[name="company.taxNumber"]', '000-000-000');
  await type('input[name="branch.nameAr"]', 'الفرع الرئيسي');
  await type('input[name="branch.nameEn"]', 'Head Office');
  await type('input[name="admin.username"]', 'owner');
  await type('input[name="admin.displayName"]', 'مالك تجريبي');
  await type('input[name="admin.password"]', 'Strong-Pass-123');
  await type('input[name="admin.confirm"]', 'Strong-Pass-123');
  await page.click('form button[type="submit"]');
  try { await page.waitForSelector('.notice', { visible: true, timeout: 5000 }); } catch (e) { await shot('debug-setup'); console.log(await page.$$eval('.field-error:not([hidden]), .form-alert:not([hidden])', (x) => x.map((n) => (n.previousElementSibling ? n.previousElementSibling.name || '' : '') + ': ' + n.textContent))); throw e; }
  check('setup completes and shows login with notice', (await text()).includes('تم تأسيس النظام'));

  // 2) إعادة التأسيس ممنوعة (من المتصفح نفسه)
  const reSetup = await page.evaluate(async () => (await fetch('/api/setup', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status);
  check('re-setup rejected (409)', reSetup === 409, String(reSetup));

  // 3) دخول خاطئ ثم صحيح
  await type('input[name="password"]', 'wrong-pass-1');
  await page.click('form button[type="submit"]');
  await page.waitForSelector('.form-alert:not([hidden])');
  check('wrong password shows translated error', (await text()).includes('غير صحيحة'));
  await shot('03-login-error');
  await type('input[name="password"]', 'Strong-Pass-123');
  await page.click('form button[type="submit"]');
  await page.waitForSelector('#view-app:not([hidden]) .stat', { visible: true });
  check('login lands on dashboard', (await page.evaluate(() => location.hash)) === '#/dashboard');
  check('session cookie is HttpOnly (invisible to JS)', !(await page.evaluate(() => document.cookie)).includes('tayl_sid'));
  check('no session token in localStorage', !(await page.evaluate(() => JSON.stringify(localStorage))).match(/sid|csrf|token/i));
  check('header shows user and branch', (await text()).includes('مالك تجريبي') && (await page.$eval('#branch-select', (s) => s.selectedOptions[0].textContent)).includes('HQ'));
  await sleep(300);
  await shot('04-dashboard-ar');

  // 4) الشركة
  await go('company');
  check('company screen loads', (await page.$eval('input[name="nameEn"]', (i) => i.value)) === 'Demo Test Co');
  await shot('05-company-ar');

  // 5) الفروع: إضافة فرع
  await go('branches');
  await page.click('.page-actions .btn.primary');
  await page.waitForSelector('dialog[open] input[name="code"]');
  await type('dialog input[name="code"]', 'alx');
  await type('dialog input[name="nameAr"]', 'فرع الإسكندرية');
  await type('dialog input[name="nameEn"]', 'Alexandria');
  await page.click('dialog button[type="submit"]');
  await sleep(800);
  check('branch added (code uppercased)', (await text()).includes('ALX'));
  await shot('06-branches-ar');

  // 6) الأدوار: إضافة دور بمصفوفة الصلاحيات
  await go('roles');
  await page.click('.page-actions .btn.primary');
  await page.waitForSelector('dialog[open] table.matrix');
  await type('dialog input[name="nameAr"]', 'مشاهد الفروع');
  await type('dialog input[name="nameEn"]', 'Branch viewer');
  await page.click('dialog input[value="branches.view"]');
  await page.click('dialog input[value="company.view"]');
  await shot('07-role-matrix-ar');
  await page.click('dialog button[type="submit"]');
  await sleep(800);
  check('role created', (await text()).includes('مشاهد الفروع'));

  // 7) المستخدمون: إضافة مستخدم محدود بفرع ALX
  await go('users');
  await page.click('.page-actions .btn.primary');
  await page.waitForSelector('dialog[open] input[name="username"]');
  await type('dialog input[name="username"]', 'clerk1');
  await type('dialog input[name="displayName"]', 'موظف تجريبي');
  await type('dialog input[name="password"]', 'Temp-Pass-123');
  const labels = await page.$$('dialog .checks label');
  for (const l of labels) { const tx = await l.evaluate((e) => e.textContent); if (tx.includes('مشاهد الفروع') || tx.includes('ALX')) await l.click(); }
  await page.click('dialog button[type="submit"]');
  await sleep(1200);
  check('user created', (await text()).includes('clerk1'));
  await shot('08-users-ar');

  // 8) الإعدادات والدقة + المعاينة
  await go('settings');
  await page.waitForSelector('input[name="value"]');
  await type('input[name="value"]', '1234567.123456789');
  await page.click('.preview button[type="submit"]');
  await page.waitForSelector('.preview-out:not([hidden])');
  const prev = await page.$eval('.preview-out', (e) => e.innerText);
  check('precision preview computed on server', prev.includes('1234567.12345679') && prev.includes('1,234,567.12'), prev.replace(/\n/g, ' | '));
  await shot('09-settings-precision-ar');

  // 9) سجل التدقيق
  await go('audit');
  await sleep(500);
  check('audit log shows events', (await text()).includes('تأسيس النظام') && (await text()).includes('إنشاء مستخدم'));
  await shot('10-audit-ar');
  check('no untranslated keys (AR)', (await untranslated()).length === 0, (await untranslated()).join(','));

  // 10) الإنجليزية LTR
  await page.click('#lang-toggle');
  await sleep(700);
  check('English switches to LTR', (await page.evaluate(() => document.documentElement.dir)) === 'ltr' && (await text()).includes('Audit log'));
  await go('dashboard'); await sleep(500);
  await shot('11-dashboard-en');
  await go('settings'); await sleep(500);
  await shot('12-settings-en');
  check('no untranslated keys (EN)', (await untranslated()).length === 0, (await untranslated()).join(','));

  // 11) الخروج
  await page.click('#logout');
  await page.waitForSelector('input[name="username"]', { visible: true });
  check('logout returns to login', (await text()).includes('signed out'));
  const after = await page.evaluate(async () => (await fetch('/api/auth/session')).status);
  check('session invalid after logout', after === 401);

  // 12) دخول الموظف: تغيير كلمة المرور إجباري، ونطاق فرعه فقط
  await type('input[name="username"]', 'clerk1');
  await type('input[name="password"]', 'Temp-Pass-123');
  await page.click('form button[type="submit"]');
  await page.waitForSelector('input[name="currentPassword"]', { visible: true });
  check('forced password change screen', (await page.evaluate(() => location.hash)) === '#/account' && (await page.$$eval('#nav a', (a) => a.length)) === 1);
  await shot('13-forced-password-en');
  await type('input[name="currentPassword"]', 'Temp-Pass-123');
  await type('input[name="newPassword"]', 'Clerk-Pass-456');
  await type('input[name="confirm"]', 'Clerk-Pass-456');
  await page.click('#page form button[type="submit"]');
  await page.waitForSelector('.stat', { visible: true });
  const nav = await page.$$eval('#nav a', (a) => a.map((x) => x.getAttribute('href')));
  check('limited user sees only permitted screens', JSON.stringify(nav) === JSON.stringify(['#/dashboard', '#/company', '#/branches', '#/account']), nav.join(' '));
  await go('branches'); await sleep(500);
  check('limited user sees only own branch', (await text()).includes('ALX') && !(await text()).match(/\bHQ\b/));
  await go('users'); await sleep(500);
  check('forbidden screen falls back to dashboard', (await page.$('.stat')) !== null);
  const forced = await page.evaluate(async () => (await fetch('/api/users')).status);
  check('backend denies forbidden API even if called directly', forced === 403);
  check('no untranslated keys / null text (limited user)', (await untranslated()).length === 0, (await untranslated()).join(','));
  await shot('14-limited-user-en');

  // 13) شاشة الهاتف
  await page.setViewport({ width: 390, height: 844 });
  await go('dashboard'); await sleep(400);
  check('mobile: no horizontal scroll', await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1));
  await shot('15-mobile-en');

  // 14) إعادة تشغيل الخادم: البيانات والجلسة باقية
  await page.setViewport({ width: 1366, height: 900 });
  const port = addr.port;
  await app.close();
  app = await createApp({ config: loadConfig({ dataDir, port }), logger: createLogger({}) });
  addr = await app.listen();
  await page.goto(base + '/', { waitUntil: 'load', timeout: 15000 }); await page.waitForSelector('.stat', { visible: true, timeout: 15000 }).catch(() => {});
  await sleep(500);
  check('after server restart: still signed in, data kept', (await page.$('.stat')) !== null && (await text()).includes('Demo Test Co'));

  check('no console errors / CSP violations', consoleErrors.length === 0, consoleErrors.join(' || '));

  await browser.close();
  await app.close();
  fs.rmSync(dataDir, { recursive: true, force: true });
  const failed = results.filter((r) => !r.ok);
  fs.writeFileSync(path.join(OUT, 'e2e-results.json'), JSON.stringify(results, null, 2));
  console.log(`\nE2E: ${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(2); });

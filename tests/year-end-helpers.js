'use strict';
/* بيانات اختبارية مشتركة لاختبارات المرحلة 4 (الإقفال السنوي). ليست بيانات حقيقية. */
const crypto = require('node:crypto');
const { ok } = require('./ledger-helpers');

/**
 * ثلاث سنوات شهرية متصلة (2024، 2025 منتهيتان؛ 2026 الحالية)، فرعان، دليل حسابات بكل التصنيفات وحساب أرباح محتجزة،
 * USD وEUR بأسعار من 2024، ومركزا تكلفة. لا يضبط حساب النتيجة (اختبار الإعداد جزء من الاختبارات).
 */
async function seedYears(s, { years = [2024, 2025, 2026], usdRate = '48.5', eurRate = '53.9' } = {}) {
  const a = s.admin;
  const fy = {};
  for (const y of years) fy[y] = ok(await a.post('/api/fiscal-years', { code: 'FY' + y, nameAr: 'FY' + y, nameEn: 'FY' + y, startDate: `${y}-01-01`, endDate: `${y}-12-31`, periodType: 'monthly' }));
  const acc = (b) => a.post('/api/accounts', b).then(ok);
  const g = {
    assets: await acc({ code: '1', nameAr: 'الأصول', nameEn: 'Assets', classCode: 'asset', isGroup: true }),
    liab: await acc({ code: '2', nameAr: 'الالتزامات', nameEn: 'Liabilities', classCode: 'liability', isGroup: true }),
    equity: await acc({ code: '3', nameAr: 'حقوق الملكية', nameEn: 'Equity', classCode: 'equity', isGroup: true }),
    revenue: await acc({ code: '4', nameAr: 'الإيرادات', nameEn: 'Revenue', classCode: 'revenue', isGroup: true }),
    cogs: await acc({ code: '5', nameAr: 'تكلفة المبيعات', nameEn: 'COGS', classCode: 'cogs', isGroup: true }),
    expenses: await acc({ code: '6', nameAr: 'المصروفات', nameEn: 'Expenses', classCode: 'expense', isGroup: true }),
  };
  const types = Object.fromEntries(s.app.db.prepare('SELECT code, id FROM account_types').all().map((r) => [r.code, r.id]));
  const A = {
    cash: await acc({ code: '1101', nameAr: 'الصندوق', nameEn: 'Cash', parentId: g.assets.id }),
    bankUsd: await acc({ code: '1102', nameAr: 'بنك دولار', nameEn: 'USD bank', parentId: g.assets.id }),
    bankEur: await acc({ code: '1103', nameAr: 'بنك يورو', nameEn: 'EUR bank', parentId: g.assets.id }),
    payable: await acc({ code: '2101', nameAr: 'دائنون', nameEn: 'Payables', parentId: g.liab.id }),
    capital: await acc({ code: '3101', nameAr: 'رأس المال', nameEn: 'Capital', parentId: g.equity.id, typeId: types.CAPITAL }),
    retained: await acc({ code: '3201', nameAr: 'أرباح محتجزة', nameEn: 'Retained earnings', parentId: g.equity.id, typeId: types.RETAINED }),
    sales: await acc({ code: '4101', nameAr: 'المبيعات', nameEn: 'Sales', parentId: g.revenue.id }),
    otherRev: await acc({ code: '4102', nameAr: 'إيرادات أخرى', nameEn: 'Other revenue', parentId: g.revenue.id }),
    cogs: await acc({ code: '5101', nameAr: 'تكلفة البضاعة', nameEn: 'Cost of goods', parentId: g.cogs.id }),
    rent: await acc({ code: '6101', nameAr: 'إيجار', nameEn: 'Rent', parentId: g.expenses.id }),
    salaries: await acc({ code: '6102', nameAr: 'رواتب', nameEn: 'Salaries', parentId: g.expenses.id }),
  };
  const usd = ok(await a.post('/api/currencies', { code: 'USD', nameAr: 'دولار', nameEn: 'US dollar', displayDecimals: 2 }));
  const eur = ok(await a.post('/api/currencies', { code: 'EUR', nameAr: 'يورو', nameEn: 'Euro', displayDecimals: 2 }));
  ok(await a.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: `${years[0]}-01-01`, rate: usdRate }));
  ok(await a.post(`/api/currencies/${eur.id}/rates`, { rateType: 'average', effectiveDate: `${years[0]}-01-01`, rate: eurRate }));
  const egp = (await a.get('/api/currencies')).body.items.find((c) => c.isBase);
  const branches = ok(await a.get('/api/branches'));
  const hq = (Array.isArray(branches) ? branches : branches.items).find((b) => b.code === 'HQ');
  const alx = ok(await a.post('/api/branches', { code: 'ALX', nameAr: 'الإسكندرية', nameEn: 'Alexandria' }));
  const typeId = s.app.db.prepare('SELECT id FROM cost_center_types ORDER BY id LIMIT 1').get().id;
  const cc1 = ok(await a.post('/api/cost-centers', { code: 'CC1', nameAr: 'الإدارة', nameEn: 'Admin', typeId }));
  const cc2 = ok(await a.post('/api/cost-centers', { code: 'CC2', nameAr: 'المبيعات', nameEn: 'Sales dept', typeId }));
  return { fy, acc: A, groups: g, usd, eur, egp, hq, alx, cc1, cc2 };
}

const setRetained = async (s, seed, client = s.admin) => ok(await client.put('/api/year-end/settings', { retainedEarningsAccountId: seed.acc.retained.id }));

/** قيد مرحّل في فرع وتاريخ. */
async function post(s, seed, date, lines, { branch = seed.hq, client = s.admin, description = 'قيد اختبار' } = {}) {
  const d = ok(await client.post('/api/journal', { branchId: branch.id, entryDate: date, description, lines }));
  return ok(await client.post(`/api/journal/${d.id}/post`, {}));
}

/** يغلق كل فترات السنة المفتوحة (شرط الإقفال). */
async function closePeriods(s, yearId, client = s.admin) {
  const y = ok(await client.get('/api/fiscal-years/' + yearId));
  for (const p of y.periods) if (p.status === 'open') ok(await client.post(`/api/fiscal-periods/${p.id}/close`, { reason: 'إغلاق للإقفال' }));
  return y.periods;
}

const key = () => 'test-' + crypto.randomUUID();
/** معاينة ثم تنفيذ (يعيد الاستجابة الخام للتنفيذ). */
async function closeYear(s, yearId, { branchIds = 'all', carryForward = false, client = s.admin, acknowledgeWarnings = true, idempotencyKey = key() } = {}) {
  const pv = ok(await client.post('/api/year-end/preview', { fiscalYearId: yearId, branchIds, operation: 'close', carryForward }));
  return client.post('/api/year-end/close', { fiscalYearId: yearId, branchIds, carryForward, fingerprint: pv.fingerprint, idempotencyKey, acknowledgeWarnings, confirm: true });
}
async function carryYear(s, yearId, { branchIds = 'all', client = s.admin, acknowledgeWarnings = true, idempotencyKey = key() } = {}) {
  const pv = ok(await client.post('/api/year-end/preview', { fiscalYearId: yearId, branchIds, operation: 'carry_forward' }));
  return client.post('/api/year-end/carry-forward', { fiscalYearId: yearId, branchIds, fingerprint: pv.fingerprint, idempotencyKey, acknowledgeWarnings, confirm: true });
}

module.exports = { seedYears, setRetained, post, closePeriods, closeYear, carryYear, key };

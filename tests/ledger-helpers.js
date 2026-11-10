'use strict';
/* بيانات اختبارية مشتركة لاختبارات المرحلة 3 (القيود والأستاذ). ليست بيانات حقيقية. */

const ok = (r) => { if (r.status !== 200) throw new Error(`${r.status} ${r.text}`); return r.body; };

/** سنة 2026 شهرية، دليل حسابات صغير، USD/EUR بأسعار، مركز تكلفة. التاريخ الافتراضي للقيود قبل «اليوم». */
async function seedLedger(s, { fy = { code: 'FY26', startDate: '2026-01-01', endDate: '2026-12-31' }, usdRate = '48.123456789012', eurRate = '53.9' } = {}) {
  const a = s.admin;
  ok(await a.post('/api/fiscal-years', { code: fy.code, nameAr: fy.code, nameEn: fy.code, startDate: fy.startDate, endDate: fy.endDate, periodType: 'monthly' }));
  const acc = (b) => a.post('/api/accounts', b).then(ok);
  const assets = await acc({ code: '1', nameAr: 'الأصول', nameEn: 'Assets', classCode: 'asset', isGroup: true });
  const cash = await acc({ code: '1101', nameAr: 'الصندوق', nameEn: 'Cash', parentId: assets.id });
  const bankUsd = await acc({ code: '1102', nameAr: 'بنك دولار', nameEn: 'USD bank', parentId: assets.id });
  const bankEur = await acc({ code: '1103', nameAr: 'بنك يورو', nameEn: 'EUR bank', parentId: assets.id });
  const revenue = await acc({ code: '4', nameAr: 'الإيرادات', nameEn: 'Revenue', classCode: 'revenue', isGroup: true });
  const sales = await acc({ code: '4101', nameAr: 'المبيعات', nameEn: 'Sales', parentId: revenue.id });
  const fxDiff = await acc({ code: '4102', nameAr: 'فروق عملة', nameEn: 'FX differences', parentId: revenue.id });
  const expenses = await acc({ code: '5', nameAr: 'المصروفات', nameEn: 'Expenses', classCode: 'expense', isGroup: true });
  const rent = await acc({ code: '5101', nameAr: 'إيجار', nameEn: 'Rent', parentId: expenses.id });
  const usd = ok(await a.post('/api/currencies', { code: 'USD', nameAr: 'دولار', nameEn: 'US dollar', displayDecimals: 2 }));
  const eur = ok(await a.post('/api/currencies', { code: 'EUR', nameAr: 'يورو', nameEn: 'Euro', displayDecimals: 2 }));
  const usdRateRow = ok(await a.post(`/api/currencies/${usd.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: usdRate }));
  ok(await a.post(`/api/currencies/${eur.id}/rates`, { rateType: 'average', effectiveDate: '2026-01-01', rate: eurRate }));
  const egp = (await a.get('/api/currencies')).body.items.find((c) => c.isBase);
  const branches = ok(await a.get('/api/branches'));
  const hq = (Array.isArray(branches) ? branches : branches.items).find((b) => b.code === 'HQ');
  const typeId = s.app.db.prepare('SELECT id FROM cost_center_types ORDER BY id LIMIT 1').get().id;
  const cc = ok(await a.post('/api/cost-centers', { code: 'CC1', nameAr: 'الإدارة', nameEn: 'Admin', typeId }));
  return { acc: { assets, cash, bankUsd, bankEur, revenue, sales, fxDiff, expenses, rent }, usd, eur, egp, usdRateRow, hq, cc };
}

/** ينشئ مسودة (الفرع HQ افتراضيًا، تاريخ 2026-03-15). */
function draft(s, seed, lines, extra = {}, client = s.admin) {
  return client.post('/api/journal', { branchId: seed.hq.id, entryDate: '2026-03-15', description: 'قيد اختبار', lines, ...extra });
}
const postEntry = (s, id, client = s.admin) => client.post(`/api/journal/${id}/post`, {});
/** مسودة + ترحيل؛ يعيد القيد المرحّل أو يرمي. */
async function postNew(s, seed, lines, extra = {}) {
  const d = ok(await draft(s, seed, lines, extra));
  return ok(await postEntry(s, d.id));
}

module.exports = { ok, seedLedger, draft, postEntry, postNew };

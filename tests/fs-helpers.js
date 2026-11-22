'use strict';
/* بيانات اختبارية مشتركة لاختبارات المرحلة 5 (القوائم المالية). ليست بيانات حقيقية. */
const { ok } = require('./ledger-helpers');
const { seedYears, setRetained, post } = require('./year-end-helpers');

/** بيانات 2024–2026 بحسابات مصنفة بأنواعها (التصنيف من هيكل الحسابات، لا من الأكواد). */
async function seedFs(s) {
  const seed = await seedYears(s);
  await setRetained(s, seed);
  const types = Object.fromEntries(s.app.db.prepare('SELECT code, id FROM account_types').all().map((r) => [r.code, r.id]));
  const A = seed.acc;
  const setType = (a, code) => s.admin.put('/api/accounts/' + a.id, { typeId: types[code] }).then(ok);
  await setType(A.cash, 'CASH'); await setType(A.bankUsd, 'BANK'); await setType(A.bankEur, 'BANK'); await setType(A.payable, 'PAYABLE');
  await setType(A.sales, 'SALES'); await setType(A.otherRev, 'OTHER_REVENUE'); await setType(A.rent, 'OPEX'); await setType(A.salaries, 'ADMIN_EXP');
  const mk = (b) => s.admin.post('/api/accounts', b).then(ok);
  A.receivable = await mk({ code: '1201', nameAr: 'عملاء', nameEn: 'Customers', parentId: seed.groups.assets.id, typeId: types.RECEIVABLE });
  A.fixed = await mk({ code: '1301', nameAr: 'معدات', nameEn: 'Equipment', parentId: seed.groups.assets.id, typeId: types.FIXED_ASSET });
  A.loan = await mk({ code: '2201', nameAr: 'قرض', nameEn: 'Loan', parentId: seed.groups.liab.id, typeId: types.LOAN });
  A.finExp = await mk({ code: '6201', nameAr: 'فوائد', nameEn: 'Interest', parentId: seed.groups.expenses.id, typeId: types.FIN_EXP });
  return seed;
}
/** سنة 2024 رابحة: إيراد 5000 + إيراد آخر 200، تكلفة 1500، تشغيلي 2000، تمويلي 100 ⇒ مجمل 3500، تشغيلي 1500، صافي 1600. */
async function profit2024(s, seed) {
  const A = seed.acc;
  await post(s, seed, '2024-01-05', [{ accountId: A.cash.id, debit: '10000' }, { accountId: A.capital.id, credit: '10000' }]);
  await post(s, seed, '2024-02-01', [{ accountId: A.cash.id, debit: '5000' }, { accountId: A.loan.id, credit: '5000' }]);
  await post(s, seed, '2024-02-10', [{ accountId: A.fixed.id, debit: '3000' }, { accountId: A.cash.id, credit: '3000' }]);
  await post(s, seed, '2024-03-10', [{ accountId: A.cash.id, debit: '4000' }, { accountId: A.receivable.id, debit: '1000' }, { accountId: A.sales.id, credit: '5000' }]);
  await post(s, seed, '2024-03-20', [{ accountId: A.cash.id, debit: '200' }, { accountId: A.otherRev.id, credit: '200' }]);
  await post(s, seed, '2024-04-01', [{ accountId: A.cogs.id, debit: '1500' }, { accountId: A.payable.id, credit: '500' }, { accountId: A.cash.id, credit: '1000' }]);
  await post(s, seed, '2024-05-01', [{ accountId: A.rent.id, debit: '1200', costCenterId: seed.cc1.id }, { accountId: A.salaries.id, debit: '800', costCenterId: seed.cc2.id }, { accountId: A.cash.id, credit: '2000' }]);
  await post(s, seed, '2024-06-01', [{ accountId: A.finExp.id, debit: '100' }, { accountId: A.cash.id, credit: '100' }]);
}
module.exports = { seedFs, profit2024 };

'use strict';
/* بيانات اختبارية مشتركة لاختبارات المرحلة 6 (المخزون). ليست بيانات حقيقية. */
const crypto = require('node:crypto');
const { ok } = require('./ledger-helpers');
const { seedYears } = require('./year-end-helpers');

const key = () => 'inv-' + crypto.randomUUID();

/**
 * سنتان (2025، 2026)، فرعان (HQ، ALX)، دليل حسابات + حسابات المخزون (مخزون، بالطريق، مستلم غير مفوتر، فروق)،
 * إعداد الربط المحاسبي، مجموعات وأصناف بكل أنواع التتبع، ومخازن (خامات، تام، حجر في HQ؛ عام وحجر في ALX) ومواقع.
 */
async function seedInv(s) {
  const seed = await seedYears(s, { years: [2025, 2026] });
  const a = s.admin;
  const acc = (b) => a.post('/api/accounts', b).then(ok);
  const A = {
    inventory: await acc({ code: '1201', nameAr: 'المخزون', nameEn: 'Inventory', parentId: seed.groups.assets.id }),
    transit: await acc({ code: '1202', nameAr: 'مخزون بالطريق', nameEn: 'Goods in transit', parentId: seed.groups.assets.id }),
    grni: await acc({ code: '2102', nameAr: 'مشتريات مستلمة', nameEn: 'Goods received not invoiced', parentId: seed.groups.liab.id }),
    adjustment: await acc({ code: '6201', nameAr: 'فروق المخزون', nameEn: 'Inventory differences', parentId: seed.groups.expenses.id }),
    consumables: await acc({ code: '6202', nameAr: 'مستلزمات مستهلكة', nameEn: 'Consumables', parentId: seed.groups.expenses.id }),
  };
  ok(await a.put('/api/inventory/settings', { inventoryAccountId: A.inventory.id, issueAccountId: seed.acc.cogs.id, adjustmentAccountId: A.adjustment.id, transitAccountId: A.transit.id }));
  const U = Object.fromEntries(s.app.db.prepare('SELECT code, id FROM units').all().map((r) => [r.code, r.id]));
  const grp = (b) => a.post('/api/inventory/groups', b).then(ok);
  const G = { raw: await grp({ code: 'RAW', nameAr: 'خامات', nameEn: 'Raw materials', isGroup: true }) };
  G.food = await grp({ code: 'RAW-FOOD', nameAr: 'خامات غذائية', nameEn: 'Food raw', parentId: G.raw.id, defaultItemType: 'raw_material' });
  G.pack = await grp({ code: 'PACK', nameAr: 'تعبئة', nameEn: 'Packaging', defaultItemType: 'packaging' });
  G.spare = await grp({ code: 'SPARE', nameAr: 'قطع غيار', nameEn: 'Spare parts', defaultItemType: 'spare_part' });
  const item = (b) => a.post('/api/inventory/items', b).then(ok);
  const I = {
    sugar: await item({ code: 'SUGAR', nameAr: 'سكر', nameEn: 'Sugar', groupId: G.food.id, baseUnitId: U.KG, minQty: '50', reorderQty: '100', barcode: '6221000000017' }),
    milk: await item({ code: 'MILK', nameAr: 'لبن بودرة', nameEn: 'Milk powder', groupId: G.food.id, baseUnitId: U.KG, trackBatches: true, trackExpiry: true }),
    bottle: await item({ code: 'BOTTLE', nameAr: 'زجاجة', nameEn: 'Bottle', groupId: G.pack.id, baseUnitId: U.PCS }),
    pump: await item({ code: 'PUMP', nameAr: 'مضخة', nameEn: 'Pump', groupId: G.spare.id, baseUnitId: U.PCS, trackSerials: true }),
    service: await item({ code: 'SERVICE', nameAr: 'خدمة صيانة', nameEn: 'Maintenance service', groupId: G.spare.id, baseUnitId: U.PCS, isStock: false, itemType: 'other' }),
  };
  ok(await a.put(`/api/inventory/items/${I.sugar.id}/units`, { unitId: U.BOX, factor: '25' }));   // كيس 25 كجم
  ok(await a.put(`/api/inventory/items/${I.bottle.id}/units`, { unitId: U.CTN, factor: '24' }));
  const wh = (b) => a.post('/api/inventory/warehouses', b).then(ok);
  const W = {
    raw: await wh({ code: 'HQ-RAW', nameAr: 'مخزن الخامات', nameEn: 'Raw store', branchId: seed.hq.id, whType: 'raw' }),
    fg: await wh({ code: 'HQ-FG', nameAr: 'مخزن التام', nameEn: 'Finished goods', branchId: seed.hq.id, whType: 'finished' }),
    qrn: await wh({ code: 'HQ-QRN', nameAr: 'مخزن الحجر', nameEn: 'Quarantine', branchId: seed.hq.id, whType: 'quarantine' }),
    alx: await wh({ code: 'ALX-MAIN', nameAr: 'مخزن الإسكندرية', nameEn: 'Alexandria store', branchId: seed.alx.id, whType: 'general' }),
    alxQrn: await wh({ code: 'ALX-QRN', nameAr: 'حجر الإسكندرية', nameEn: 'Alexandria quarantine', branchId: seed.alx.id, whType: 'quarantine' }),
  };
  const L = { a1: ok(await a.post(`/api/inventory/warehouses/${W.raw.id}/locations`, { code: 'A1', nameAr: 'رف A1', nameEn: 'Rack A1' })) };
  return { ...seed, A, U, G, I, W, L };
}

/** مسودة ثم ترحيل؛ يعيد نتيجة الترحيل أو يرمي. */
async function postNewDoc(s, body, { client = s.admin, idempotencyKey } = {}) {
  const d = ok(await client.post('/api/inventory/documents', body));
  return ok(await client.post(`/api/inventory/documents/${d.id}/post`, idempotencyKey ? { idempotencyKey } : {}));
}
const receipt = (s, seed, { wh = seed.W.raw, date = '2026-02-01', lines, counter = seed.A.grni }, opts) =>
  postNewDoc(s, { docType: 'receipt', warehouseId: wh.id, docDate: date, counterAccountId: counter.id, lines }, opts);
const issue = (s, seed, { wh = seed.W.raw, date = '2026-02-10', lines, extra = {} }, opts) =>
  postNewDoc(s, { docType: 'issue', warehouseId: wh.id, docDate: date, lines, ...extra }, opts);
const pool = (s, itemId, whId, batchId = 0) => s.app.db.prepare('SELECT qty, value FROM inv_pools WHERE item_id = ? AND warehouse_id = ? AND batch_key = ?').get(itemId, whId, batchId) || { qty: '0', value: '0' };
/** رصيد حساب في الأستاذ (مدين − دائن) لفرع أو للكل. */
const glBalance = (s, accountId, branchId) => {
  const r = s.app.db.prepare(`SELECT dec_sum(debit) d, dec_sum(credit) c FROM gl_entries WHERE account_id = ? AND source_type <> 'carry_forward'${branchId ? ' AND branch_id = ?' : ''}`).get(accountId, ...(branchId ? [branchId] : []));
  return s.app.services.decimal.canonical(s.app.services.decimal.sub(r.d || '0', r.c || '0'));
};

module.exports = { seedInv, postNewDoc, receipt, issue, pool, glBalance, key };

'use strict';
const { HttpError } = require('./errors');
const { inTransaction } = require('./db');
const { readSheet, writeSheet, sendXlsx, ZipError } = require('./xlsx');
const { normalize } = require('./search');
const { MAX_DEPTH } = require('./master');

/**
 * استيراد Excel بخطوتين، موحد لكل الشاشات:
 *  1) preview: يقرأ الملف ويتحقق من كل صف (بنفس قواعد الإدخال اليدوي) ويعيد النتيجة دون حفظ أي شيء.
 *  2) commit: يعيد التحقق من نفس الملف؛ إن وُجد خطأ واحد يُرفض الكل (409)، وإلا تُحفظ كل الصفوف في معاملة واحدة.
 * لا حفظ جزئي أبدًا. الاستيراد يضيف سجلات جديدة فقط (لا يعدّل الموجود).
 */
const IMPORT_BODY_LIMIT = 16 * 1024 * 1024;

/** columns: [{ key, aliases: [...], required }] — يطابق العناوين بعد التطبيع (عربي/إنجليزي). */
function readTable(base64, columns) {
  if (typeof base64 !== 'string' || !base64 || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new HttpError(400, 'BAD_XLSX', 'ملف Excel غير صالح');
  let sheet;
  try { sheet = readSheet(Buffer.from(base64, 'base64')); } catch (e) {
    if (e instanceof ZipError) throw new HttpError(400, 'BAD_XLSX', e.message);
    throw e;
  }
  const hi = sheet.findIndex((r) => r.some((c) => c));
  if (hi < 0) throw new HttpError(400, 'IMPORT_EMPTY', 'الملف فارغ');
  const map = new Map();
  sheet[hi].forEach((h, i) => {
    const n = normalize(h).replace(/[\s_*]+/g, ' ').trim();
    const col = columns.find((c) => [c.key, ...c.aliases].some((a) => normalize(a).replace(/[\s_*]+/g, ' ').trim() === n));
    if (col && !map.has(col.key)) map.set(col.key, i);
  });
  const missing = columns.filter((c) => c.required && !map.has(c.key)).map((c) => c.key);
  if (missing.length) throw new HttpError(400, 'IMPORT_BAD_HEADER', 'أعمدة إلزامية مفقودة', { missing });
  const rows = [];
  for (let r = hi + 1; r < sheet.length; r++) {
    const raw = sheet[r] || [];
    if (!raw.some((c) => c)) continue;
    const values = {};
    for (const [k, i] of map) values[k] = raw[i] ?? '';
    rows.push({ line: r + 1, values });
  }
  if (!rows.length) throw new HttpError(400, 'IMPORT_EMPTY', 'لا توجد صفوف بيانات');
  return rows;
}

/** يحوّل خطأ تحقق (HttpError VALIDATION) إلى قائمة أخطاء حقول للصف. */
function fieldErrors(fn) {
  try { return { value: fn(), errors: [] }; } catch (e) {
    if (e instanceof HttpError && e.details && e.details.fields) return { value: null, errors: Object.entries(e.details.fields).map(([field, code]) => ({ field, code })) };
    if (e instanceof HttpError) return { value: null, errors: [{ field: '_', code: e.code }] };
    throw e;
  }
}

const truthy = (v) => ['1', 'true', 'yes', 'y', 'نعم', 'تجميعي', 'group'].includes(normalize(v));
const falsy = (v) => ['', '0', 'false', 'no', 'n', 'لا', 'تفصيلي', 'detail'].includes(normalize(v));
function parseBool(v) {
  if (truthy(v)) return true;
  if (falsy(v)) return false;
  return undefined;
}

/**
 * تحقق شجرة مستوردة: أكواد مكررة في الملف أو موجودة مسبقًا، أب غير موجود، أب غير تجميعي أو معطّل، دورات، العمق.
 * items: [{ line, code, parentCode, isGroup, data, errors }] — يعيد نفس العناصر مرتبة (الآباء أولًا) مع level.
 */
function checkTree(db, table, items, extra) {
  const byCode = new Map();
  for (const it of items) {
    if (!it.code) continue;
    if (byCode.has(it.code)) { it.errors.push({ field: 'code', code: 'DUPLICATE_IN_FILE' }); byCode.get(it.code).errors.push({ field: 'code', code: 'DUPLICATE_IN_FILE' }); } else byCode.set(it.code, it);
  }
  const dbRow = db.prepare(`SELECT * FROM ${table} WHERE code = ?`);
  for (const it of items) if (it.code && dbRow.get(it.code)) it.errors.push({ field: 'code', code: 'CODE_EXISTS' });

  const levelOf = new Map();
  const resolving = new Set();
  function resolve(it) {
    if (levelOf.has(it)) return levelOf.get(it);
    if (resolving.has(it)) { it.errors.push({ field: 'parentCode', code: 'TREE_CYCLE' }); levelOf.set(it, null); return null; }
    resolving.add(it);
    let level = 1;
    it.parentRow = null; it.parentItem = null;
    if (it.parentCode) {
      const p = byCode.get(it.parentCode);
      const pr = p ? null : dbRow.get(it.parentCode);
      if (p) {
        if (p === it) it.errors.push({ field: 'parentCode', code: 'TREE_CYCLE' });
        else {
          if (p.isGroup !== true) it.errors.push({ field: 'parentCode', code: 'PARENT_NOT_GROUP' });
          const pl = resolve(p);
          level = pl == null ? null : pl + 1;
          it.parentItem = p;
        }
      } else if (pr) {
        if (pr.is_group !== 1) it.errors.push({ field: 'parentCode', code: 'PARENT_NOT_GROUP' });
        if (pr.is_active !== 1) it.errors.push({ field: 'parentCode', code: 'PARENT_INACTIVE' });
        level = pr.level + 1;
        it.parentRow = pr;
      } else it.errors.push({ field: 'parentCode', code: 'PARENT_NOT_FOUND' });
    }
    if (level != null && level > MAX_DEPTH) it.errors.push({ field: 'parentCode', code: 'TREE_TOO_DEEP' });
    resolving.delete(it);
    levelOf.set(it, level);
    return level;
  }
  for (const it of items) resolve(it);
  if (extra) for (const it of items) extra(it);
  const order = [...items].sort((a, b) => (levelOf.get(a) ?? 99) - (levelOf.get(b) ?? 99) || a.line - b.line);
  return order.map((it) => ({ ...it, level: levelOf.get(it) }));
}

/**
 * مسارات الاستيراد: base/import/template.xlsx و base/import/preview و base/import/commit (صلاحية resource.import).
 * def: { columns, templateRows?, validate(ctx, rows) => items[{line, values, data, errors}], commit(ctx, items) }
 */
function registerImportRoutes(router, { base, resource, columns, validate, commit, fileName }) {
  const perm = { permission: `${resource}.import` };
  router.get(base + '/import/template.xlsx', perm, (ctx) => {
    const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
    const header = columns.map((c) => (lang === 'ar' ? c.aliases[0] : c.key) + (c.required ? ' *' : ''));
    sendXlsx(ctx.res, `${fileName || resource}-template.xlsx`, writeSheet({ sheetName: 'import', header, rows: [], rtl: lang === 'ar' }));
  });
  const run = (ctx, body) => {
    const rows = readTable(body && body.data, columns);
    const items = validate(ctx, rows);
    const bad = items.filter((i) => i.errors.length);
    return { items, summary: { total: items.length, valid: items.length - bad.length, invalid: bad.length } };
  };
  const view = (it) => ({ line: it.line, values: it.values, errors: it.errors });
  router.post(base + '/import/preview', { ...perm, bodyLimit: IMPORT_BODY_LIMIT }, async (ctx) => {
    const r = run(ctx, await ctx.body());
    return { summary: r.summary, rows: r.items.sort((a, b) => a.line - b.line).map(view) };
  });
  router.post(base + '/import/commit', { ...perm, bodyLimit: IMPORT_BODY_LIMIT }, async (ctx) => {
    const r = run(ctx, await ctx.body());
    if (r.summary.invalid) throw new HttpError(409, 'IMPORT_HAS_ERRORS', 'الملف يحتوي أخطاء؛ لم يُحفظ أي صف', { summary: r.summary, rows: r.items.filter((i) => i.errors.length).map(view) });
    const created = inTransaction(ctx.services.db, () => {
      const n = commit(ctx, r.items);
      ctx.services.audit.fromCtx(ctx, { action: `${resource}.imported`, source: resource, entityType: resource, details: { rows: n } });
      return n;
    });
    return { created };
  });
}

module.exports = { readTable, fieldErrors, parseBool, checkTree, registerImportRoutes, IMPORT_BODY_LIMIT };

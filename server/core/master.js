'use strict';
const { HttpError } = require('./errors');
const { inTransaction } = require('./db');
const { searchWhere } = require('./search');
const { idParam } = require('./validate');
const { writeSheet, sendXlsx } = require('./xlsx');

/**
 * خدمة موحدة للبيانات الرئيسية (Master Data) تستخدمها كل وحدات المرحلة 2:
 * إضافة/تعديل/تفعيل/تعطيل/حذف (عند عدم الارتباط فقط)، بحث موحد، نطاق الفروع، الحقول الحساسة،
 * التدقيق، التصدير والطباعة، والشجرة (أب/أبناء، منع الدورات، حد العمق، النقل، إعادة الترتيب).
 *
 * قواعد عامة لكل الكيانات:
 *  - الحذف الفعلي فقط إذا لم يكن الكيان مستخدمًا (services.usage) ولا له أبناء؛ وإلا يُعطَّل.
 *  - تغيير الكود ممنوع بعد ارتباط الكيان ببيانات أخرى (الارتباطات تستخدم المعرّف، والكود هوية يراها المستخدم).
 *  - كل تغيير يُسجَّل في التدقيق مع الفروق (والحقول الحساسة تُسجَّل كـ «تغيّر» دون قيم).
 */
const MAX_DEPTH = 15;
const SENSITIVE_MARK = '[MASKED]';
const mask = (v) => (v == null || v === '' ? v : '••••' + String(v).slice(-4));

function createMasterService(services, def) {
  const { db, audit, usage } = services;
  const T = def.table;
  const E = def.entity;
  const tree = !!def.tree;
  const cols = def.columns;                                   // [[api, col], ...] القابلة للكتابة
  const colOf = Object.fromEntries(cols);
  const byId = (id) => db.prepare(`SELECT * FROM ${T} WHERE id = ?`).get(id);
  const sensitive = def.sensitive || null;                    // { perm, fields: [api...] }
  const scope = def.scope || null;                            // { api, col, nullable }

  // ── النطاق ──
  function scopeFilter(ctx) {
    if (!scope || ctx.access.allBranches) return { sql: '1 = 1', params: [] };
    const ids = ctx.access.branchIds();
    const inList = ids.length ? `${scope.col} IN (${ids.map(() => '?').join(',')})` : '0 = 1';
    return { sql: scope.nullable ? `(${inList} OR ${scope.col} IS NULL)` : inList, params: ids };
  }
  function visible(ctx, row) {
    if (!scope || ctx.access.allBranches) return true;
    const b = row[scope.col];
    return b == null ? !!scope.nullable : ctx.access.branchAllowed(b);
  }
  /** الكتابة على سجل مرتبط بفرع تتطلب الفرع ضمن النطاق؛ والسجل العام (بلا فرع) يتطلب «جميع الفروع». */
  function assertWritableBranch(ctx, branchId) {
    if (!scope) return;
    if (branchId == null) {
      if (!ctx.access.allBranches) throw new HttpError(403, 'BRANCH_SCOPE_EXCEEDED', 'السجل العام لكل الفروع يتطلب صلاحية جميع الفروع');
      return;
    }
    ctx.access.assertBranch(branchId);
    if (!services.branches.exists(branchId)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [scope.api]: 'NOT_FOUND' } });
  }
  function getVisible(ctx, id) {
    const r = byId(id);
    if (!r || !visible(ctx, r)) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
    return r;
  }

  // ── العرض ──
  const canSensitive = (ctx) => !sensitive || ctx.access.can(sensitive.perm);
  function present(ctx, row) {
    if (!row) return null;
    const o = def.toApi(row);
    if (sensitive) {
      const ok = canSensitive(ctx);
      for (const f of sensitive.fields) if (!ok) o[f] = mask(o[f]);
      o.sensitiveVisible = ok;
    }
    return o;
  }
  const auditValue = (api, v) => (sensitive && sensitive.fields.includes(api) && v != null ? SENSITIVE_MARK : v);

  function uniqueError(e) {
    if (!e || e.code !== 'SQLITE_CONSTRAINT_UNIQUE') return null;
    const m = /UNIQUE constraint failed: (?:index '(\w+)'|([\w.]+))/.exec(e.message || '');
    const col = m ? (m[1] || m[2].split(',')[0].split('.').pop()) : '';
    const field = (def.uniqueFields && def.uniqueFields[col]) || 'code';
    return new HttpError(409, 'DUPLICATE', 'القيمة مستخدمة من قبل', { fields: { [field]: 'TAKEN' } });
  }

  // ── الشجرة ──
  const childrenCount = (id, activeOnly = false) => db.prepare(`SELECT count(*) c FROM ${T} WHERE parent_id = ?${activeOnly ? ' AND is_active = 1' : ''}`).get(id).c;
  function checkParent(ctx, parentId, selfRow) {
    if (parentId == null) return null;
    const p = byId(parentId);
    if (!p || !visible(ctx, p)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { parentId: 'NOT_FOUND' } });
    if (p.is_group !== 1) throw new HttpError(409, 'PARENT_NOT_GROUP', 'الأب يجب أن يكون تجميعيًا');
    if (p.is_active !== 1) throw new HttpError(409, 'PARENT_INACTIVE', 'الأب معطّل');
    if (selfRow && (p.id === selfRow.id || p.path.startsWith(selfRow.path))) throw new HttpError(409, 'TREE_CYCLE', 'لا يمكن نقل العنصر تحت نفسه أو أحد فروعه');
    const subtreeDepth = selfRow ? db.prepare(`SELECT max(level) m FROM ${T} WHERE path LIKE ?`).get(selfRow.path + '%').m - selfRow.level : 0;
    if (p.level + 1 + subtreeDepth > MAX_DEPTH) throw new HttpError(409, 'TREE_TOO_DEEP', `أقصى عمق للشجرة ${MAX_DEPTH} مستوى`);
    return p;
  }
  function setPath(id, parent) {
    const path = (parent ? parent.path : '/') + id + '/';
    db.prepare(`UPDATE ${T} SET path = ?, level = ? WHERE id = ?`).run(path, parent ? parent.level + 1 : 1, id);
  }
  function moveSubtree(row, parent) {
    const newPath = (parent ? parent.path : '/') + row.id + '/';
    const delta = (parent ? parent.level + 1 : 1) - row.level;
    db.prepare(`UPDATE ${T} SET path = ? || substr(path, ?), level = level + ? WHERE path LIKE ?`).run(newPath, row.path.length + 1, delta, row.path + '%');
  }
  const nextSort = (parentId) => (db.prepare(`SELECT max(sort_order) m FROM ${T} WHERE parent_id IS ?`).get(parentId).m || 0) + 10;

  // ── العمليات ──
  function create(ctx, body) {
    const data = def.validate(body, { partial: false, ctx });
    if (sensitive && !canSensitive(ctx) && sensitive.fields.some((f) => data[f] != null && data[f] !== '')) throw new HttpError(403, 'SENSITIVE_FORBIDDEN', 'لا تملك صلاحية البيانات الحساسة');
    return inTransaction(db, () => {
      let parent = null;
      if (tree) {
        parent = checkParent(ctx, data.parentId ?? null, null);
        if (data.sortOrder == null) data.sortOrder = nextSort(data.parentId ?? null);
      }
      if (def.beforeSave) def.beforeSave(ctx, data, null, parent);
      // بعد beforeSave: قد يرث العنصر فرع أبيه
      if (scope) assertWritableBranch(ctx, data[scope.api] ?? null);
      const use = cols.filter(([api]) => api in data);
      let id;
      try {
        id = Number(db.prepare(`INSERT INTO ${T} (${use.map(([, c]) => c).join(', ')}${tree ? ', path, level' : ''})
          VALUES (${use.map(() => '?').join(', ')}${tree ? ", '', 1" : ''})`).run(...use.map(([api]) => data[api])).lastInsertRowid);
      } catch (e) { throw uniqueError(e) || e; }
      if (tree) setPath(id, parent);
      if (def.afterSave) def.afterSave(ctx, id, data);
      audit.fromCtx(ctx, { action: `${E}.created`, source: def.source, entityType: E, entityId: id,
        details: { [E]: Object.fromEntries(use.map(([api]) => [api, auditValue(api, data[api])])) } });
      return present(ctx, byId(id));
    });
  }

  function update(ctx, id, body) {
    const data = def.validate(body, { partial: true, ctx });
    return inTransaction(db, () => {
      const row = getVisible(ctx, id);
      if (scope) assertWritableBranch(ctx, row[scope.col]);
      if (sensitive && !canSensitive(ctx) && sensitive.fields.some((f) => f in data)) throw new HttpError(403, 'SENSITIVE_FORBIDDEN', 'لا تملك صلاحية البيانات الحساسة');
      if (scope && scope.api in data && data[scope.api] !== row[scope.col]) assertWritableBranch(ctx, data[scope.api]);
      const used = () => usage.usedBy(E, id);
      if ('code' in data && data.code !== row.code && used().length) throw new HttpError(409, 'CODE_LOCKED', 'لا يمكن تغيير كود مستخدم في بيانات أخرى', { usedBy: used() });
      let parent = null;
      if (tree) {
        const newParent = 'parentId' in data ? data.parentId : row.parent_id;
        parent = newParent == null ? null : byId(newParent);
        if ('parentId' in data && data.parentId !== row.parent_id) parent = checkParent(ctx, data.parentId, row);
        if ('isGroup' in data && data.isGroup !== (row.is_group === 1)) {
          if (!data.isGroup && childrenCount(id)) throw new HttpError(409, 'HAS_CHILDREN', 'لا يمكن تحويل عنصر له فروع إلى تفصيلي');
          if (data.isGroup && used().length) throw new HttpError(409, 'IN_USE', 'لا يمكن تحويل عنصر مستخدم إلى تجميعي', { usedBy: used() });
        }
      }
      if (def.beforeSave) def.beforeSave(ctx, data, row, parent);
      const use = cols.filter(([api]) => api in data);
      const before = def.toApi(row);
      if (use.length) {
        try {
          db.prepare(`UPDATE ${T} SET ${use.map(([, c]) => `${c} = ?`).join(', ')}, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`)
            .run(...use.map(([api]) => data[api]), id);
        } catch (e) { throw uniqueError(e) || e; }
      }
      if (tree && 'parentId' in data && data.parentId !== row.parent_id) moveSubtree(row, parent);
      if (def.afterSave) def.afterSave(ctx, id, data);
      const after = def.toApi(byId(id));
      const changes = {};
      for (const [api] of use) {
        if (JSON.stringify(before[api]) !== JSON.stringify(after[api])) changes[api] = { from: auditValue(api, before[api]), to: auditValue(api, after[api]) };
      }
      if (Object.keys(changes).length) audit.fromCtx(ctx, { action: `${E}.updated`, source: def.source, entityType: E, entityId: id, details: { code: row.code, changes } });
      return present(ctx, byId(id));
    });
  }

  function setActive(ctx, id, active) {
    return inTransaction(db, () => {
      const row = getVisible(ctx, id);
      if (scope) assertWritableBranch(ctx, row[scope.col]);
      if ((row.is_active === 1) === active) return present(ctx, row);
      if (tree && !active && childrenCount(id, true)) throw new HttpError(409, 'HAS_ACTIVE_CHILDREN', 'عطّل الفروع النشطة أولًا');
      if (tree && active && row.parent_id != null && byId(row.parent_id).is_active !== 1) throw new HttpError(409, 'PARENT_INACTIVE', 'الأب معطّل');
      if (def.beforeActive) def.beforeActive(ctx, row, active);
      db.prepare(`UPDATE ${T} SET is_active = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?`).run(active ? 1 : 0, id);
      audit.fromCtx(ctx, { action: `${E}.${active ? 'activated' : 'deactivated'}`, source: def.source, entityType: E, entityId: id, details: { code: row.code } });
      return present(ctx, byId(id));
    });
  }

  function remove(ctx, id) {
    return inTransaction(db, () => {
      const row = getVisible(ctx, id);
      if (scope) assertWritableBranch(ctx, row[scope.col]);
      if (tree && childrenCount(id)) throw new HttpError(409, 'HAS_CHILDREN', 'لا يمكن حذف عنصر له فروع');
      const used = usage.usedBy(E, id);
      if (used.length) throw new HttpError(409, 'IN_USE', 'العنصر مستخدم؛ عطّله بدل حذفه', { usedBy: used });
      if (def.beforeDelete) def.beforeDelete(ctx, row);
      try { db.prepare(`DELETE FROM ${T} WHERE id = ?`).run(id); } catch (e) {
        if (/FOREIGN KEY|cannot be deleted/.test(e.message || '')) throw new HttpError(409, 'IN_USE', 'العنصر مستخدم؛ عطّله بدل حذفه');
        throw e;
      }
      const snap = def.toApi(row);
      if (sensitive) for (const f of sensitive.fields) if (snap[f] != null) snap[f] = SENSITIVE_MARK;
      audit.fromCtx(ctx, { action: `${E}.deleted`, source: def.source, entityType: E, entityId: id, details: { [E]: snap } });
      return { ok: true };
    });
  }

  /** نقل عنصر لأعلى/لأسفل بين إخوته (الهوية والكود والارتباطات لا تتغير). */
  function reorder(ctx, id, direction) {
    return inTransaction(db, () => {
      const row = getVisible(ctx, id);
      if (scope) assertWritableBranch(ctx, row[scope.col]);
      const sibs = db.prepare(`SELECT id, sort_order FROM ${T} WHERE parent_id IS ? ORDER BY sort_order, code`).all(row.parent_id);
      const i = sibs.findIndex((s) => s.id === id);
      const j = direction === 'up' ? i - 1 : i + 1;
      if (j < 0 || j >= sibs.length) return present(ctx, row);
      [sibs[i], sibs[j]] = [sibs[j], sibs[i]];
      const upd = db.prepare(`UPDATE ${T} SET sort_order = ? WHERE id = ?`);
      sibs.forEach((s, k) => upd.run((k + 1) * 10, s.id));
      audit.fromCtx(ctx, { action: `${E}.reordered`, source: def.source, entityType: E, entityId: id, details: { code: row.code, direction } });
      return present(ctx, byId(id));
    });
  }

  // ── القراءة ──
  function where(ctx, q = {}) {
    const parts = []; const params = [];
    const sc = scopeFilter(ctx); parts.push(sc.sql); params.push(...sc.params);
    const s = searchWhere(def.searchCols || ['code', 'name_ar', 'name_en'], q.q || '');
    parts.push(s.sql); params.push(...s.params);
    if (q.active === '1' || q.active === '0') { parts.push('is_active = ?'); params.push(Number(q.active)); }
    for (const [key, f] of Object.entries(def.filters || {})) {
      if (q[key] !== undefined && q[key] !== '') { const r = f(q[key]); if (r) { parts.push(r.sql); params.push(...r.params); } }
    }
    return { sql: parts.join(' AND '), params, rank: s.rank };
  }
  const intQ = (v, d, max) => (/^\d{1,6}$/.test(String(v ?? '')) ? Math.min(Number(v), max) : d);

  function list(ctx, q = {}) {
    const w = where(ctx, q);
    const limit = intQ(q.limit, 500, 2000); const offset = intQ(q.offset, 0, 1e6);
    const total = db.prepare(`SELECT count(*) c FROM ${T} WHERE ${w.sql}`).get(...w.params).c;
    const rows = db.prepare(`SELECT * FROM ${T} WHERE ${w.sql} ORDER BY ${w.rank.sql}, ${def.orderBy || 'code'} LIMIT ? OFFSET ?`).all(...w.params, ...w.rank.params, limit, offset);
    return { items: rows.map((r) => present(ctx, r)), total, limit, offset };
  }

  /** للقوائم القابلة للبحث: حقول قليلة، ترقيم، و usable=1 للمتاح للعمليات الجديدة فقط. */
  function lookup(ctx, q = {}) {
    const w = where(ctx, { ...q, active: q.usable === '1' ? '1' : q.active });
    let extra = '';
    if (q.usable === '1') extra = (tree ? ' AND is_group = 0' : '') + (def.usableCol ? ` AND ${def.usableCol} = 1` : '');
    if (q.groups === '1' && tree) extra += ' AND is_group = 1';
    const limit = intQ(q.limit, 20, 50); const offset = intQ(q.offset, 0, 1e6);
    const rows = db.prepare(`SELECT * FROM ${T} WHERE ${w.sql}${extra} ORDER BY ${w.rank.sql}, ${def.orderBy || 'code'} LIMIT ? OFFSET ?`).all(...w.params, ...w.rank.params, limit + 1, offset);
    return {
      items: rows.slice(0, limit).map((r) => ({ id: r.id, code: r.code, nameAr: r.name_ar, nameEn: r.name_en, isActive: r.is_active === 1, ...(tree ? { level: r.level, isGroup: r.is_group === 1 } : {}), ...(def.lookupExtra ? def.lookupExtra(r) : {}) })),
      hasMore: rows.length > limit,
    };
  }

  /** الشجرة مرتبة هرميًا (الإخوة حسب sort_order ثم الكود). مع q: المطابقات وأسلافها فقط. */
  function treeList(ctx, q = {}) {
    const sc = scopeFilter(ctx);
    const all = db.prepare(`SELECT * FROM ${T} WHERE ${sc.sql}`).all(...sc.params);
    let keep = null;
    let matches = null;
    if (q.q) {
      const w = where(ctx, { q: q.q });
      const hits = db.prepare(`SELECT id, path FROM ${T} WHERE ${w.sql}`).all(...w.params);
      keep = new Set();
      for (const h of hits) for (const a of h.path.split('/').filter(Boolean)) keep.add(Number(a));
      matches = new Set(hits.map((h) => h.id));
    }
    const kids = new Map();
    for (const r of all) { if (keep && !keep.has(r.id)) continue; const k = r.parent_id ?? 0; if (!kids.has(k)) kids.set(k, []); kids.get(k).push(r); }
    for (const arr of kids.values()) arr.sort((a, b) => a.sort_order - b.sort_order || a.code.localeCompare(b.code));
    const out = [];
    const ids = new Set(all.map((r) => r.id));
    const walk = (pid) => { for (const r of kids.get(pid) || []) { out.push({ ...present(ctx, r), hasChildren: (kids.get(r.id) || []).length > 0, match: keep ? matches.has(r.id) : undefined }); walk(r.id); } };
    walk(0);
    // عناصر أبوها خارج النطاق المرئي تظهر كجذور
    for (const [pid] of kids) if (pid !== 0 && !ids.has(pid)) walk(pid);
    return out;
  }

  /** للمراحل القادمة: هل يُستخدم هذا العنصر في عملية جديدة؟ */
  function assertUsable(id, ctx) {
    const r = byId(id);
    if (!r || (ctx && !visible(ctx, r))) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { [E + 'Id']: 'NOT_FOUND' } });
    if (r.is_active !== 1) throw new HttpError(409, 'NOT_USABLE', 'العنصر معطّل', { reason: 'INACTIVE' });
    if (tree && r.is_group === 1) throw new HttpError(409, 'NOT_USABLE', 'لا يُستخدم الحساب/المركز التجميعي في الحركات', { reason: 'GROUP' });
    if (def.usableCol && r[def.usableCol] !== 1) throw new HttpError(409, 'NOT_USABLE', 'غير متاح للعمليات', { reason: 'NOT_AVAILABLE' });
    if (def.extraUsable) def.extraUsable(r);
    return r;
  }

  function exportData(ctx, lang) {
    const t = (k) => services.i18n.t(lang, k);
    const rows = tree ? treeList(ctx) : list(ctx, { limit: 2000 }).items;
    return {
      title: t(def.titleKey),
      columns: def.exportColumns.map((c) => t(c.label)),
      rows: rows.map((r) => def.exportColumns.map((c) => { const v = c.value(r, t); return v == null ? '' : String(v); })),
    };
  }

  return { create, update, setActive, remove, reorder, list, lookup, treeList, get: (ctx, id) => present(ctx, getVisible(ctx, id)), byId, assertUsable, exportData, present, visible };
}

/** مسارات قياسية: resource.view/create/update/disable/delete/print/export + lookup لمن يحتاج القائمة في نموذج آخر. */
function registerMasterRoutes(router, svc, { base, resource, tree = false, lookupPerms = [], exportFile, extra }) {
  const p = (a) => ({ permission: `${resource}.${a}` });
  router.get(base, p('view'), (ctx) => svc.list(ctx, ctx.query));
  if (tree) router.get(base + '/tree', p('view'), (ctx) => svc.treeList(ctx, ctx.query));
  router.get(base + '/lookup', { auth: true }, (ctx) => {
    if (![`${resource}.view`, ...lookupPerms].some((x) => ctx.access.can(x))) throw new HttpError(403, 'FORBIDDEN', 'لا تملك صلاحية تنفيذ هذه العملية');
    return svc.lookup(ctx, ctx.query);
  });
  router.get(base + '/export.xlsx', p('export'), (ctx) => {
    const lang = ctx.query.lang === 'en' ? 'en' : 'ar';
    const d = svc.exportData(ctx, lang);
    ctx.services.audit.fromCtx(ctx, { action: `${resource}.exported`, source: resource, entityType: resource, details: { rows: d.rows.length } });
    sendXlsx(ctx.res, `${exportFile || resource}.xlsx`, writeSheet({ sheetName: d.title, header: d.columns, rows: d.rows, rtl: lang === 'ar' }));
  });
  router.get(base + '/print', p('print'), (ctx) => svc.exportData(ctx, ctx.query.lang === 'en' ? 'en' : 'ar'));
  if (extra) extra(router, p);
  router.get(base + '/:id', p('view'), (ctx) => svc.get(ctx, idParam(ctx.params.id)));
  router.post(base, p('create'), async (ctx) => svc.create(ctx, await ctx.body()));
  router.put(base + '/:id', p('update'), async (ctx) => svc.update(ctx, idParam(ctx.params.id), await ctx.body()));
  router.post(base + '/:id/status', p('disable'), async (ctx) => {
    const b = await ctx.body();
    if (!b || typeof b.active !== 'boolean') throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { active: 'NOT_BOOLEAN' } });
    return svc.setActive(ctx, idParam(ctx.params.id), b.active);
  });
  router.delete(base + '/:id', p('delete'), (ctx) => svc.remove(ctx, idParam(ctx.params.id)));
  if (tree) {
    router.post(base + '/:id/reorder', p('update'), async (ctx) => {
      const b = await ctx.body();
      if (!b || !['up', 'down'].includes(b.direction)) throw new HttpError(400, 'VALIDATION', 'بيانات غير صالحة', { fields: { direction: 'NOT_ALLOWED' } });
      return svc.reorder(ctx, idParam(ctx.params.id), b.direction);
    });
  }
}

/** صلاحيات قياسية لوحدة بيانات رئيسية. */
const masterActions = (extraActions = []) => ['view', 'create', 'update', 'disable', 'delete', 'print', 'export', ...extraActions];

module.exports = { createMasterService, registerMasterRoutes, masterActions, MAX_DEPTH, mask };

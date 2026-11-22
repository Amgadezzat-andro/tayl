'use strict';
/*
 * المخزون (المرحلة 6): لوحة الملخص، الأصناف، المجموعات، الوحدات والتحويلات، المخازن والمواقع، المستندات المخزنية (مسودة ←
 * معاينة ← ترحيل ← عكس)، التحويلات بين الفروع (الاستلام الجزئي والإغلاق)، الجرد، الدفعات والجودة، الحجوزات، الإعدادات،
 * ومركز التقارير. كل رقم من الخادم ويُعرض كنص عشري (لا Number في القيم)، وكل تحقق نهائي في الخادم.
 */
window.TAYL = window.TAYL || {};
TAYL.views = TAYL.views || {};
(() => {
  const { el, t, fill, panel, pageHead, button, badge, toast, errorText, name, modal, confirm, form, table } = TAYL.ui;
  const api = TAYL.api;
  const B = '/api/inventory';
  const params = () => new URLSearchParams((location.hash.split('?')[1]) || '');
  // الرابط نفسه (بعد حفظ المسودة) لا يطلق hashchange؛ نطلقه يدويًا ليُعاد العرض
  const go = (h) => { if (location.hash === h) window.dispatchEvent(new HashChangeEvent('hashchange')); else location.hash = h; };
  const ikey = () => 'ui-' + crypto.randomUUID();
  let metaCache = null;
  const meta = async () => { if (!metaCache) metaCache = await api.get(`${B}/meta`); return metaCache; };

  /** عرض نص عشري بفواصل الآلاف وتقريب نصي للعرض فقط (dp خانات) — بلا Number. */
  function dec(s, dp = null) {
    if (s === null || s === undefined || s === '') return '';
    const neg = String(s).startsWith('-');
    let [i, f = ''] = String(neg ? String(s).slice(1) : s).split('.');
    if (dp !== null) {
      if (f.length > dp) {
        const up = f.charCodeAt(dp) >= 53;   // '5'
        const digits = (i + f.slice(0, dp)).split('');
        if (up) {
          let k = digits.length - 1;
          for (; k >= 0; k--) { if (digits[k] === '9') digits[k] = '0'; else { digits[k] = String.fromCharCode(digits[k].charCodeAt(0) + 1); break; } }
          if (k < 0) digits.unshift('1');
        }
        const all = digits.join('');
        i = all.slice(0, all.length - dp) || '0'; f = all.slice(all.length - dp);
      } else f = f.padEnd(dp, '0');
    }
    i = i.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
    const out = f ? `${i}.${f}` : i;
    return (neg && /[1-9]/.test(out) ? '-' : '') + out;
  }
  const num = (s, dp = null) => el('span', { class: 'num', dir: 'ltr', text: dec(s, dp) });
  const AMT = 2; const COST = 4;
  const wrap = (fn) => async (...a) => { try { await fn(...a); } catch (e) { toast(errorText(e), 'bad'); } };
  const select = (opts, value, attrs = {}) => { const s = el('select', attrs, opts.map((o) => el('option', { value: o.value, text: o.label }))); if (value !== undefined && value !== null) s.value = String(value); return s; };
  const field = (key, input, req = false) => el('div', { class: 'field' }, el('label', { class: req ? 'req' : null, text: t(key) }), input);
  async function warehouses(usable = true) { return (await api.get(`${B}/warehouses/lookup?limit=50${usable ? '&usable=1' : ''}`)).items; }
  const whLabel = (w) => `${w.code} — ${name(w)}`;
  const statusBadge = (st) => badge('inv.status.' + st, st === 'posted' ? 'ok' : st === 'draft' ? 'warn' : 'muted');

  // ── لوحة المخزون ──
  TAYL.views.invDashboard = {
    key: 'nav.invDashboard', perm: 'inventory.view',
    async render(root, app) {
      const s = await api.get(`${B}/summary`);
      const stat = (v, k) => el('div', { class: 'stat' }, el('span', { class: 'stat-value', dir: 'ltr', text: v }), el('span', { class: 'stat-label', text: t(k) }));
      const link = (x) => {
        if (x.docId) return el('a', { href: '#/invDocument?id=' + x.docId, text: t('inv.doc.' + x.docType) + ' ' + x.docDate });
        if (x.countId) return el('a', { href: '#/invCount?id=' + x.countId, dir: 'ltr', text: `${x.count} (${x.lines})` });
        const label = `${x.itemCode} — ${name({ nameAr: x.itemName.ar, nameEn: x.itemName.en })}`;
        return app.can('inventory_reports.view') ? el('a', { href: `#/invReports?report=item-card&itemId=${x.itemId}`, text: label }) : el('span', { text: label });
      };
      const alerts = s.alerts.map((a) => el('div', { class: 'inv-alert ' + a.severity },
        el('h3', null, t('inv.alert.' + a.type), ' ', badge('inv.count', a.severity === 'high' ? 'bad' : 'warn'), el('span', { class: 'num', dir: 'ltr', text: ' ' + a.count })),
        el('ul', null, a.items.map((x) => el('li', null, link(x),
          x.qty !== undefined && x.qty !== null ? el('span', { class: 'muted' }, ' — ', num(x.qty)) : null,
          x.batch ? el('span', { class: 'muted', dir: 'ltr', text: ` [${x.batch}]` }) : null,
          x.expiryDate ? el('span', { class: 'muted', dir: 'ltr', text: ` ${x.expiryDate}` }) : null)))));
      const quick = ['receipt', 'issue', 'transfer', 'transfer_out', 'adjust_in', 'adjust_out'].filter(() => app.can(['inventory_documents.create', 'inventory_transfers.create']))
        .map((ty) => button('inv.new.' + ty, () => go('#/invDocument?type=' + ty), 'btn small'));
      fill(root,
        pageHead('nav.invDashboard', button('keys.button', () => TAYL.keys.help(), 'btn small')),
        panel('inv.overview', el('div', { class: 'stats' }, stat(String(s.items), 'inv.activeItems'), stat(String(s.warehouses), 'inv.activeWarehouses'),
          stat(String(s.drafts), 'inv.draftDocs'), stat(String(s.openTransfers), 'inv.openTransfers'), stat(String(s.openCounts), 'inv.openCounts'),
          s.value !== null ? stat(`${dec(s.value, AMT)} ${s.baseCurrency}`, 'inv.totalValue') : null)),
        quick.length ? panel('inv.quick', el('div', { class: 'form-actions start' }, quick)) : null,
        panel('inv.alerts', alerts.length ? alerts : el('p', { class: 'muted', text: t('inv.noAlerts') })));
    },
  };

  // ── الأصناف ──
  const ITEM_TYPES = ['raw_material', 'packaging', 'wip', 'semi_finished', 'finished_good', 'spare_part', 'supplies', 'other'];
  const accSource = TAYL.combobox.lookupSource(`${B}/ref/accounts`, 'usable=1');
  const unitSource = TAYL.combobox.lookupSource(`${B}/ref/units`, 'usable=1');
  const itemSource = TAYL.combobox.lookupSource(`${B}/items`, 'usable=1');
  const accVal = (id) => (id ? { id, label: '#' + id } : null);
  async function unitsDialog(item, app) {
    const box = el('div');
    async function load() {
      const u = await api.get(`${B}/items/${item.id}/units`);
      const canManage = app.can('inventory_units.manage');
      fill(box,
        el('p', { class: 'muted', text: t('inv.unitsIntro', { unit: u.base.unitCode }) }),
        table({ columns: [
          { label: 'inv.col.unit', render: (r) => el('code', { dir: 'ltr', text: r.unitCode }) },
          { label: 'common.name', render: (r) => name(r) },
          { label: 'inv.factor', cls: 'num-col', render: (r) => el('span', { dir: 'ltr' }, '1 = ', num(r.factor), ' ' + u.base.unitCode) },
          { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
          { label: 'common.actions', render: (r) => (canManage ? button(r.isActive ? 'common.disable' : 'common.enable', wrap(async () => { await api.put(`${B}/items/${item.id}/units`, { unitId: r.unitId, factor: r.factor, isActive: !r.isActive }); load(); }), 'btn small') : null) },
        ], rows: [{ ...u.base, isActive: true, base: true }, ...u.units].filter((r) => !r.base) }),
        canManage ? form({ submitKey: 'inv.saveConversion', fields: [
          { name: 'unitId', label: 'inv.col.unit', type: 'combobox', required: true, source: unitSource },
          { name: 'factor', label: 'inv.factor', required: true, dir: 'ltr', inputmode: 'decimal', hint: 'inv.factorHint' },
        ], async onSubmit(v) { await api.put(`${B}/items/${item.id}/units`, { unitId: v.unitId, factor: v.factor }); toast(t('common.saved')); load(); } }).node : null);
    }
    modal({ title: `${t('inv.unitsOf')} — ${item.code}`, wide: true, body: box });
    await load();
  }
  async function stockDialog(item) {
    const rows = await api.get(`${B}/items/${item.id}/stock`);
    modal({ title: `${t('inv.stockOf')} — ${item.code}`, wide: true, body: table({ columns: [
      { label: 'inv.col.warehouse', render: (r) => whLabel(r.warehouse) },
      { label: 'inv.col.onHand', cls: 'num-col', render: (r) => num(r.onHand) }, { label: 'inv.col.reserved', cls: 'num-col', render: (r) => num(r.reserved) },
      { label: 'inv.col.unavailable', cls: 'num-col', render: (r) => num(r.unavailable) }, { label: 'inv.col.available', cls: 'num-col', render: (r) => num(r.available) },
    ], rows }) });
  }
  TAYL.views.invItems = TAYL.masterView({
    key: 'nav.invItems', resource: 'inventory_items', base: `${B}/items`, exportName: 'items', addKey: 'inv.addItem', editKey: 'inv.editItem', intro: 'inv.itemsIntro',
    columns: [
      { label: 'inv.code', render: (r) => el('code', { dir: 'ltr', text: r.code }), sortValue: (r) => r.code },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'inv.itemType', render: (r) => t('inv.type.' + r.itemType) },
      { label: 'inv.tracking', render: (r) => [r.isStock ? null : badge('inv.nonStock', 'muted'), r.trackBatches ? badge('inv.batches', '') : null, r.trackExpiry ? badge('inv.expiry', '') : null, r.trackSerials ? badge('inv.serials', '') : null] },
      { label: 'inv.barcode', render: (r) => el('span', { dir: 'ltr', text: r.barcode || '' }) },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    filters: [{ name: 'itemType', label: 'inv.itemType', options: () => ITEM_TYPES.map((c) => ({ value: c, label: t('inv.type.' + c) })) }],
    rowActions: (r, app) => [button('inv.units', wrap(() => unitsDialog(r, app)), 'btn small'), app.can(['inventory_items.view']) ? button('inv.stock', wrap(() => stockDialog(r)), 'btn small') : null],
    fields: (row, app) => [
      TAYL.fields.code(row, 30), ...TAYL.fields.names(row, 200),
      { name: 'groupId', label: 'inv.group', type: 'combobox', required: true, source: TAYL.combobox.lookupSource(`${B}/groups`, 'usable=1'), value: row && row.groupId ? { id: row.groupId, label: '#' + row.groupId } : null },
      { name: 'itemType', label: 'inv.itemType', type: 'select', value: row ? row.itemType : '', options: [{ value: '', label: t('inv.fromGroup') }, ...ITEM_TYPES.map((c) => ({ value: c, label: t('inv.type.' + c) }))] },
      { name: 'baseUnitId', label: 'inv.baseUnit', type: 'combobox', required: true, source: unitSource, value: row ? { id: row.baseUnitId, label: '#' + row.baseUnitId } : null, hint: 'inv.policyHint' },
      { name: 'isStock', label: 'inv.isStock', type: 'checkbox', value: row ? row.isStock : true },
      { name: 'trackBatches', label: 'inv.trackBatches', type: 'checkbox', value: row && row.trackBatches },
      { name: 'trackExpiry', label: 'inv.trackExpiry', type: 'checkbox', value: row && row.trackExpiry },
      { name: 'trackSerials', label: 'inv.trackSerials', type: 'checkbox', value: row && row.trackSerials },
      { name: 'minQty', label: 'inv.minQty', dir: 'ltr', inputmode: 'decimal', value: row && row.minQty },
      { name: 'reorderQty', label: 'inv.reorderQty', dir: 'ltr', inputmode: 'decimal', value: row && row.reorderQty },
      { name: 'maxQty', label: 'inv.maxQty', dir: 'ltr', inputmode: 'decimal', value: row && row.maxQty },
      { name: 'barcode', label: 'inv.barcode', dir: 'ltr', value: row && row.barcode, maxlength: 64 },
      ...(app.can('inventory.accounting_settings') ? [
        { name: 'inventoryAccountId', label: 'inv.inventoryAccount', type: 'combobox', source: accSource, value: accVal(row && row.inventoryAccountId), hint: 'inv.inheritHint' },
        { name: 'issueAccountId', label: 'inv.issueAccount', type: 'combobox', source: accSource, value: accVal(row && row.issueAccountId) },
        { name: 'adjustmentAccountId', label: 'inv.adjustmentAccount', type: 'combobox', source: accSource, value: accVal(row && row.adjustmentAccountId) },
      ] : []),
      TAYL.fields.description(row),
      { name: 'notes', label: 'inv.notes', type: 'textarea', value: row && row.notes, full: true },
    ],
    toBody(v, row) {
      const b = { ...v };
      for (const k of ['groupId', 'baseUnitId', 'inventoryAccountId', 'issueAccountId', 'adjustmentAccountId']) if (k in b) b[k] = b[k] ? b[k].id : null;
      for (const k of ['minQty', 'reorderQty', 'maxQty', 'barcode', 'itemType']) if (b[k] === '') b[k] = null;
      if (!row && b.itemType === null) delete b.itemType;
      if (row) for (const k of ['isStock', 'trackBatches', 'trackExpiry', 'trackSerials']) if (b[k] === row[k]) delete b[k];
      return b;
    },
  });

  // ── المجموعات ──
  TAYL.views.invGroups = TAYL.masterView({
    key: 'nav.invGroups', resource: 'inventory_categories', base: `${B}/groups`, tree: true, addKey: 'inv.addGroup', editKey: 'inv.editGroup', intro: 'inv.groupsIntro',
    perms: { create: 'inventory_categories.manage', update: 'inventory_categories.manage', disable: 'inventory_categories.manage', delete: 'inventory_categories.manage', print: false, export: false, import: false },
    columns: [
      { label: 'inv.code', render: (r) => el('code', { dir: 'ltr', text: r.code }) },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'inv.groupKind', render: (r) => t(r.isGroup ? 'inv.groupParent' : 'inv.groupDetail') },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    fields: (row, app, rows) => [
      TAYL.fields.code(row, 30), ...TAYL.fields.names(row, 120),
      { name: 'parentId', label: 'inv.parentGroup', type: 'combobox', source: TAYL.combobox.lookupSource(`${B}/groups`, 'groups=1&active=1'),
        value: row && row.parentId ? { id: row.parentId, label: rows.get(row.parentId) ? `${rows.get(row.parentId).code} — ${name(rows.get(row.parentId))}` : '#' + row.parentId } : null },
      { name: 'isGroup', label: 'inv.isParentGroup', type: 'checkbox', value: row && row.isGroup },
      { name: 'defaultItemType', label: 'inv.defaultItemType', type: 'select', value: row ? row.defaultItemType || '' : '', options: [{ value: '', label: '—' }, ...ITEM_TYPES.map((c) => ({ value: c, label: t('inv.type.' + c) }))] },
      { name: 'defaultTrackBatches', label: 'inv.trackBatches', type: 'checkbox', value: row && row.defaultTrackBatches },
      { name: 'defaultTrackExpiry', label: 'inv.trackExpiry', type: 'checkbox', value: row && row.defaultTrackExpiry },
      ...(app.can('inventory.accounting_settings') ? [
        { name: 'inventoryAccountId', label: 'inv.inventoryAccount', type: 'combobox', source: accSource, value: accVal(row && row.inventoryAccountId), hint: 'inv.inheritHint' },
        { name: 'issueAccountId', label: 'inv.issueAccount', type: 'combobox', source: accSource, value: accVal(row && row.issueAccountId) },
        { name: 'adjustmentAccountId', label: 'inv.adjustmentAccount', type: 'combobox', source: accSource, value: accVal(row && row.adjustmentAccountId) },
      ] : []),
      TAYL.fields.description(row),
    ],
    toBody(v) {
      const b = { ...v };
      for (const k of ['parentId', 'inventoryAccountId', 'issueAccountId', 'adjustmentAccountId']) if (k in b) b[k] = b[k] ? b[k].id : null;
      if (b.defaultItemType === '') b.defaultItemType = null;
      return b;
    },
  });

  // ── وحدات الصنف والتحويلات ──
  TAYL.views.invUnits = {
    key: 'nav.invUnits', perm: 'inventory_items.view',
    async render(root, app) {
      const holder = el('div');
      const cb = TAYL.combobox.create({ source: itemSource, label: t('inv.col.itemCode'), onChange: (v) => { if (v) show(v); } });
      async function show(v) {
        const u = await api.get(`${B}/items/${v.id}/units`);
        fill(holder, el('p', { class: 'muted', text: t('inv.unitsIntro', { unit: u.base.unitCode }) }),
          table({ columns: [
            { label: 'inv.col.unit', render: (r) => el('code', { dir: 'ltr', text: r.unitCode }) }, { label: 'common.name', render: (r) => name(r) },
            { label: 'inv.factor', cls: 'num-col', render: (r) => el('span', { dir: 'ltr' }, '1 = ', num(r.factor), ' ' + u.base.unitCode) },
            { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
          ], rows: u.units }),
          app.can('inventory_units.manage') ? button('inv.manageUnits', wrap(() => unitsDialog({ id: v.id, code: u.item.code }, app).then(() => show(v))), 'btn small') : null);
      }
      fill(root, pageHead('nav.invUnits', app.can('units.view') ? el('a', { class: 'btn small', href: '#/units', text: t('nav.units') }) : null),
        el('p', { class: 'muted', text: t('inv.unitsScreenIntro') }), panel(null, el('div', { class: 'filters' }, el('div', { class: 'cb-inline wide' }, cb.node)), holder));
    },
  };

  // ── المخازن والمواقع ──
  const WH_TYPES = ['raw', 'packaging', 'wip', 'finished', 'spare_parts', 'quarantine', 'general'];
  async function locationsDialog(w, app) {
    const box = el('div');
    const canManage = app.can('inventory_warehouses.manage');
    async function load() {
      const rows = await api.get(`${B}/warehouses/${w.id}/locations`);
      fill(box, table({ columns: [
        { label: 'inv.code', render: (r) => el('code', { dir: 'ltr', text: r.code }) }, { label: 'common.name', render: (r) => name(r) },
        { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
        { label: 'common.actions', render: (r) => (canManage ? button(r.isActive ? 'common.disable' : 'common.enable', wrap(async () => { await api.put(`${B}/warehouses/${w.id}/locations/${r.id}`, { isActive: !r.isActive }); load(); }), 'btn small') : null) },
      ], rows }),
      canManage ? form({ submitKey: 'inv.addLocation', fields: [TAYL.fields.code(null, 30), ...TAYL.fields.names(null, 120)],
        async onSubmit(v) { await api.post(`${B}/warehouses/${w.id}/locations`, v); toast(t('common.saved')); load(); } }).node : null);
    }
    modal({ title: `${t('inv.locations')} — ${w.code}`, wide: true, body: box });
    await load();
  }
  async function usersDialog(w) {
    const box = el('div');
    async function load() {
      const rows = await api.get(`${B}/warehouses/${w.id}/users`);
      const cb = TAYL.combobox.create({ source: TAYL.combobox.lookupSource(`${B}/ref/users`), label: t('inv.user') });
      fill(box, el('p', { class: 'muted', text: t('inv.whUsersIntro') }),
        table({ columns: [{ label: 'inv.user', render: (r) => `${r.username} — ${r.displayName}` },
          { label: 'common.actions', render: (r) => button('common.delete', wrap(async () => { await api.put(`${B}/warehouses/${w.id}/users`, { userId: r.id, assigned: false }); load(); }), 'btn small danger') }], rows }),
        el('div', { class: 'filters' }, el('div', { class: 'cb-inline wide' }, cb.node), button('inv.assignUser', wrap(async () => { if (!cb.value) return; await api.put(`${B}/warehouses/${w.id}/users`, { userId: cb.value.id, assigned: true }); load(); }), 'btn')));
    }
    modal({ title: `${t('inv.whUsers')} — ${w.code}`, wide: true, body: box });
    await load();
  }
  TAYL.views.invWarehouses = TAYL.masterView({
    key: 'nav.invWarehouses', resource: 'inventory_warehouses', base: `${B}/warehouses`, addKey: 'inv.addWarehouse', editKey: 'inv.editWarehouse', intro: 'inv.warehousesIntro',
    perms: { create: 'inventory_warehouses.manage', update: 'inventory_warehouses.manage', disable: 'inventory_warehouses.manage', delete: 'inventory_warehouses.manage', print: false, export: false, import: false },
    columns: [
      { label: 'inv.code', render: (r) => el('code', { dir: 'ltr', text: r.code }), sortValue: (r) => r.code },
      { label: 'common.name', render: (r) => name(r) },
      { label: 'inv.col.branch', render: (r) => TAYL.fields.branchName(TAYL.app, r.branchId) },
      { label: 'inv.whType', render: (r) => [t('inv.wh.' + r.whType), r.whType === 'quarantine' ? badge('inv.notAvailable', 'warn') : null] },
      { label: 'common.status', render: (r) => badge(r.isActive ? 'common.active' : 'common.inactive', r.isActive ? 'ok' : 'muted') },
    ],
    filters: [{ name: 'whType', label: 'inv.whType', options: () => WH_TYPES.map((c) => ({ value: c, label: t('inv.wh.' + c) })) }],
    rowActions: (r, app) => [button('inv.locations', wrap(() => locationsDialog(r, app)), 'btn small'), app.can('inventory_warehouses.manage') ? button('inv.whUsers', wrap(() => usersDialog(r)), 'btn small') : null],
    fields: (row, app) => [
      TAYL.fields.code(row, 30), ...TAYL.fields.names(row, 120),
      { name: 'branchId', label: 'inv.col.branch', type: 'select', required: true, value: row ? row.branchId : (app.session.branch && app.session.branch.id),
        options: (app.session.branches || []).map((b) => ({ value: String(b.id), label: `${b.code} — ${name(b)}` })), numeric: true },
      { name: 'whType', label: 'inv.whType', type: 'select', required: true, value: row ? row.whType : 'general', options: WH_TYPES.map((c) => ({ value: c, label: t('inv.wh.' + c) })), hint: 'inv.whLockedHint' },
      { name: 'notes', label: 'inv.notes', type: 'textarea', value: row && row.notes, full: true },
    ],
    toBody(v) { const b = { ...v }; b.branchId = Number.parseInt(b.branchId, 10); return b; },
  });

  // ── المستندات ──
  const TYPES = ['opening', 'receipt', 'issue', 'transfer', 'transfer_out', 'adjust_in', 'adjust_out', 'return', 'quality'];
  const INBOUND = ['opening', 'receipt', 'adjust_in', 'return'];
  const COSTED = ['opening', 'receipt', 'adjust_in', 'return'];
  TAYL.views.invDocuments = {
    key: 'nav.invDocuments', perm: 'inventory_documents.view',
    async render(root, app) {
      const st = { status: '', docType: '', warehouseId: '', from: '', to: '', q: '' };
      const whs = await warehouses(false);
      const f = {
        q: el('input', { type: 'search', id: 'page-search', placeholder: t('inv.searchDocs'), 'aria-label': t('common.search') }),
        status: select([{ value: '', label: t('common.allStatuses') }, ...['draft', 'posted', 'cancelled'].map((s) => ({ value: s, label: t('inv.status.' + s) }))], '', { 'aria-label': t('common.status') }),
        docType: select([{ value: '', label: t('inv.allTypes') }, ...[...TYPES, 'transfer_in', 'reversal'].map((s) => ({ value: s, label: t('inv.doc.' + s) }))], '', { 'aria-label': t('inv.col.docType') }),
        warehouseId: select([{ value: '', label: t('inv.allWarehouses') }, ...whs.map((w) => ({ value: String(w.id), label: whLabel(w) }))], '', { 'aria-label': t('inv.col.warehouse') }),
        from: el('input', { type: 'date', 'aria-label': t('inv.from') }), to: el('input', { type: 'date', 'aria-label': t('inv.to') }),
      };
      const holder = el('div');
      async function load() {
        for (const k of Object.keys(st)) st[k] = f[k].value;
        const r = await api.get(`${B}/documents?${new URLSearchParams(Object.fromEntries(Object.entries(st).filter(([, v]) => v)))}`);
        fill(holder, table({ columns: [
          { label: 'inv.col.document', render: (d) => el('a', { href: '#/invDocument?id=' + d.id, dir: 'ltr', text: d.number || t('inv.status.draft') + ' #' + d.id }) },
          { label: 'inv.col.date', render: (d) => el('span', { dir: 'ltr', text: d.docDate }) },
          { label: 'inv.col.docType', render: (d) => t('inv.doc.' + d.docType) },
          { label: 'inv.col.warehouse', render: (d) => el('span', { dir: 'ltr', text: d.warehouseCode + (d.toWarehouseCode ? ' → ' + d.toWarehouseCode : '') }) },
          { label: 'inv.col.value', cls: 'num-col', render: (d) => num(d.totalValue, AMT) },
          { label: 'common.status', render: (d) => [statusBadge(d.status), d.reversed ? badge('inv.reversed', 'muted') : null] },
          { label: 'inv.glNumber', render: (d) => el('span', { dir: 'ltr', text: d.glNumber || '' }) },
        ], rows: r.items }));
      }
      for (const k of ['status', 'docType', 'warehouseId', 'from', 'to']) f[k].addEventListener('change', wrap(load));
      f.q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wrap(load)(); } });
      const canNew = app.can(['inventory_documents.create', 'inventory_transfers.create']);
      const newSel = select([{ value: '', label: t('inv.newDocument') }, ...TYPES.filter((ty) => app.can(['transfer', 'transfer_out'].includes(ty) ? 'inventory_transfers.create' : ty === 'quality' ? 'inventory_quality.view' : 'inventory_documents.create'))
        .map((ty) => ({ value: ty, label: t('inv.doc.' + ty) }))], '', { 'aria-label': t('inv.newDocument'), id: 'inv-new-type' });
      newSel.addEventListener('change', () => { if (newSel.value) go('#/invDocument?type=' + newSel.value); });
      TAYL.keys.setPage([canNew ? { combo: 'Ctrl+N', alt: 'Alt+N', labelKey: 'keys.new', run: () => newSel.focus() } : null, { combo: 'Ctrl+F', labelKey: 'keys.search', run: () => f.q.focus() }]);
      fill(root, pageHead('nav.invDocuments', canNew ? newSel : null, button('keys.button', () => TAYL.keys.help(), 'btn small')),
        el('p', { class: 'muted', text: t('inv.documentsIntro') }),
        panel(null, el('div', { class: 'filters' }, f.q, f.status, f.docType, f.warehouseId, f.from, f.to), holder));
      await load();
    },
  };

  /** محرر/عارض المستند: المسودة قابلة للتعديل؛ المرحّل للعرض مع الحركات والقيد والعكس. */
  TAYL.views.invDocument = {
    key: 'nav.invDocuments', perm: 'inventory_documents.view',
    async render(root, app) {
      const p = params();
      const m = await meta();
      const d = p.get('id') ? await api.get(`${B}/documents/${p.get('id')}`) : null;
      if (d && d.status !== 'draft') return renderPosted(root, app, d);
      return renderEditor(root, app, d, d ? d.docType : p.get('type'), m);
    },
  };

  function renderPosted(root, app, d) {
    const cur = d.baseCurrency;
    const canValue = app.can('inventory_valuation.view') || d.lines.some((l) => l.value !== null);
    const lineCols = [
      { label: 'inv.col.line', render: (l) => String(l.lineNo) },
      { label: 'inv.col.itemCode', render: (l) => el('code', { dir: 'ltr', text: l.itemCode }) },
      { label: 'inv.col.itemName', render: (l) => name({ nameAr: l.itemNameAr, nameEn: l.itemNameEn }) },
      { label: 'inv.col.qty', cls: 'num-col', render: (l) => [num(l.qty), el('span', { class: 'muted', dir: 'ltr', text: ' ' + l.unitCode })] },
      { label: 'inv.col.baseQty', cls: 'num-col', render: (l) => num(l.baseQty) },
      { label: 'inv.col.batch', render: (l) => el('span', { dir: 'ltr', text: [l.batchNo, l.expiryDate].filter(Boolean).join(' · ') }) },
      ...(d.docType === 'quality' ? [{ label: 'inv.col.quality', render: (l) => `${t('inv.q.' + l.fromStatus)} → ${t('inv.q.' + l.toStatus)}` }] : []),
      ...(canValue ? [{ label: 'inv.col.value', cls: 'num-col', render: (l) => num(l.value, AMT) }] : []),
    ];
    const moveCols = [
      { label: 'inv.col.warehouse', render: (x) => el('span', { dir: 'ltr', text: x.warehouseCode }) },
      { label: 'inv.col.direction', render: (x) => t(x.direction === 'in' ? 'inv.col.in' : 'inv.col.out') },
      { label: 'inv.col.batch', render: (x) => el('span', { dir: 'ltr', text: x.batchNo || '' }) },
      { label: 'inv.col.qty', cls: 'num-col', render: (x) => num(x.qty) },
      ...(canValue ? [{ label: 'inv.col.unitCost', cls: 'num-col', render: (x) => num(x.unitCost, COST) }, { label: 'inv.col.value', cls: 'num-col', render: (x) => num(x.value, AMT) },
        { label: 'inv.col.balanceQty', cls: 'num-col', render: (x) => num(x.poolQtyAfter) }, { label: 'inv.col.balanceValue', cls: 'num-col', render: (x) => num(x.poolValueAfter, AMT) }] : []),
    ];
    const glCols = [
      { label: 'inv.col.account', render: (g) => el('span', null, el('code', { dir: 'ltr', text: g.accountCode }), ' ' + name({ nameAr: g.accountNameAr, nameEn: g.accountNameEn })) },
      { label: 'inv.col.role', render: (g) => t('inv.role.' + g.role) },
      { label: 'inv.debit', cls: 'num-col', render: (g) => num(g.debit, AMT) }, { label: 'inv.credit', cls: 'num-col', render: (g) => num(g.credit, AMT) },
    ];
    const reverse = wrap(async () => {
      const box = el('div');
      const f = form({ submitKey: 'inv.reverse', fields: [
        { name: 'reason', label: 'inv.reason', type: 'textarea', required: true, full: true },
        { name: 'date', label: 'inv.reverseDate', type: 'date', hint: 'inv.reverseDateHint' },
      ], async onSubmit(v) {
        const r = await api.post(`${B}/documents/${d.id}/reverse`, { reason: v.reason, ...(v.date ? { date: v.date } : {}), idempotencyKey: ikey() });
        close(); toast(t('inv.reversedOk', { number: r.number })); go('#/invDocument?id=' + r.id);
      }, onCancel: () => close() });
      box.append(el('p', { class: 'notice warn', text: t('inv.reverseWarn') }), f.node);
      const close = modal({ title: `${t('inv.reverse')} — ${d.number}`, body: box });
    });
    const links = [
      d.reverses ? el('a', { href: '#/invDocument?id=' + d.reverses.id, dir: 'ltr', text: t('inv.reverses') + ' ' + d.reverses.number }) : null,
      d.reversedBy ? el('a', { href: '#/invDocument?id=' + d.reversedBy.id, dir: 'ltr', text: t('inv.reversedBy') + ' ' + d.reversedBy.number }) : null,
      d.countId ? el('a', { href: '#/invCount?id=' + d.countId, text: t('inv.fromCount') }) : null,
      d.transfer ? el('a', { href: '#/invTransfers', text: `${t('inv.transfer')}: ${t('inv.tr.' + d.transfer.status)}` }) : null,
    ].filter(Boolean);
    fill(root,
      pageHead('nav.invDocuments',
        app.can('inventory_documents.print') ? button('common.print', () => TAYL.ui.printFrom(`${B}/documents/${d.id}/print?lang=${window.I18N.lang}`), 'btn small') : null,
        d.status === 'posted' && !d.reversedBy && d.docType !== 'reversal' && app.can('inventory_documents.reverse') ? button('inv.reverse', reverse, 'btn small danger') : null,
        el('a', { class: 'btn small', href: '#/invDocuments', text: t('inv.backToList') })),
      panel(null, el('dl', { class: 'facts inv-facts' },
        el('div', null, el('dt', { text: t('inv.col.document') }), el('dd', { dir: 'ltr', text: d.number || '—' })),
        el('div', null, el('dt', { text: t('inv.col.docType') }), el('dd', { text: t('inv.doc.' + d.docType) })),
        el('div', null, el('dt', { text: t('common.status') }), el('dd', null, statusBadge(d.status))),
        el('div', null, el('dt', { text: t('inv.col.date') }), el('dd', { dir: 'ltr', text: d.docDate })),
        el('div', null, el('dt', { text: t('inv.col.warehouse') }), el('dd', { dir: 'ltr', text: (d.warehouse ? d.warehouse.code : '') + (d.toWarehouse ? ' → ' + d.toWarehouse.code : '') })),
        el('div', null, el('dt', { text: t('inv.glNumber') }), el('dd', { dir: 'ltr', text: d.glNumber || t('inv.noGl') })),
        canValue ? el('div', null, el('dt', { text: t('inv.col.value') }), el('dd', null, num(d.totalValue, AMT), ' ' + cur)) : null,
        el('div', null, el('dt', { text: t('inv.postedBy') }), el('dd', { text: [d.postedBy, d.postedAt && d.postedAt.slice(0, 16).replace('T', ' ')].filter(Boolean).join(' · ') })),
        d.reason ? el('div', null, el('dt', { text: t('inv.reason') }), el('dd', { text: d.reason })) : null,
        d.overrideReason ? el('div', null, el('dt', { text: t('inv.overrideReason') }), el('dd', { text: d.overrideReason })) : null),
      links.length ? el('p', { class: 'inv-links' }, links.flatMap((x, i) => (i ? [' · ', x] : [x]))) : null),
      panel('inv.lines', table({ columns: lineCols, rows: d.lines })),
      d.moves.length ? panel('inv.moves', table({ columns: moveCols, rows: d.moves })) : null,
      d.gl.length ? panel('inv.glLines', table({ columns: glCols, rows: d.gl })) : null);
  }

  async function renderEditor(root, app, d, type, m) {
    if (!TYPES.includes(type)) { fill(root, el('p', { class: 'form-alert', text: t('err.NOT_FOUND') })); return; }
    // مخازن الفرع الحالي أولًا
    const cur = app.session.branch ? app.session.branch.id : null;
    const whs = (await warehouses(true)).sort((x, y) => (x.branchId === cur ? 0 : 1) - (y.branchId === cur ? 0 : 1) || x.code.localeCompare(y.code));
    const h = {
      warehouseId: select(whs.map((w) => ({ value: String(w.id), label: whLabel(w) })), d && d.warehouse ? d.warehouse.id : (whs[0] && whs[0].id), { id: 'inv-wh' }),
      toWarehouseId: select([{ value: '', label: '—' }, ...whs.map((w) => ({ value: String(w.id), label: whLabel(w) }))], d && d.toWarehouse ? d.toWarehouse.id : '', { id: 'inv-to-wh' }),
      docDate: el('input', { type: 'date', id: 'inv-date', value: d ? d.docDate : m.today }),
      externalRef: el('input', { id: 'inv-ref', dir: 'ltr', maxlength: 60, value: d ? d.externalRef || '' : '' }),
      reason: el('input', { id: 'inv-reason', maxlength: 500, value: d ? d.reason || '' : '' }),
      notes: el('textarea', { id: 'inv-notes', rows: 2, maxlength: 1000 }),
      overrideReason: el('input', { id: 'inv-override', maxlength: 500, value: d ? d.overrideReason || '' : '' }),
      negativeReason: el('input', { id: 'inv-negative', maxlength: 500, value: d ? d.negativeReason || '' : '' }),
    };
    if (d && d.notes) h.notes.value = d.notes;
    const counter = TAYL.combobox.create({ source: accSource, value: d && d.counterAccountId ? { id: d.counterAccountId, label: '#' + d.counterAccountId } : null, label: t('inv.counterAccount') });
    const cc = TAYL.combobox.create({ source: TAYL.combobox.lookupSource(`${B}/ref/cost-centers`, 'usable=1'), value: d && d.costCenterId ? { id: d.costCenterId, label: '#' + d.costCenterId } : null, label: t('inv.costCenter') });
    let returnOf = null;
    if (type === 'return') {
      const issues = (await api.get(`${B}/documents?docType=issue&status=posted&limit=200`)).items;
      returnOf = select([{ value: '', label: t('inv.noReference') }, ...issues.map((x) => ({ value: String(x.id), label: `${x.number} — ${x.docDate}` }))], d && d.returnOfId ? d.returnOfId : '', { id: 'inv-return-of' });
    }
    const isTransfer = ['transfer', 'transfer_out'].includes(type);
    const inbound = INBOUND.includes(type);
    const body = el('tbody');
    const rows = [];
    const locCache = new Map();
    const locs = async (whId) => { if (!locCache.has(whId)) locCache.set(whId, await api.get(`${B}/warehouses/${whId}/locations`).catch(() => [])); return locCache.get(whId); };
    async function addRow(l = {}) {
      const r = { el: {} };
      r.item = TAYL.combobox.create({ source: itemSource, value: l.itemId ? { id: l.itemId, label: `${l.itemCode} — ${name({ nameAr: l.itemNameAr, nameEn: l.itemNameEn })}` } : null, label: t('inv.col.itemCode'), onChange: () => refreshItem() });
      r.unit = el('select', { 'aria-label': t('inv.col.unit') });
      r.qty = el('input', { dir: 'ltr', inputmode: 'decimal', class: 'num', 'aria-label': t('inv.col.qty'), value: l.qty && l.qty !== '0' ? l.qty : '' });
      r.cost = el('input', { dir: 'ltr', inputmode: 'decimal', class: 'num', 'aria-label': t('inv.col.unitCost'), value: l.unitCost || '' });
      r.batch = el('select', { 'aria-label': t('inv.col.batch') });
      r.batchNo = el('input', { dir: 'ltr', maxlength: 60, placeholder: t('inv.newBatchNo'), 'aria-label': t('inv.newBatchNo'), value: l.batchId ? '' : l.batchNo || '' });
      r.prod = el('input', { type: 'date', 'aria-label': t('inv.col.productionDate'), value: l.productionDate || '' });
      r.exp = el('input', { type: 'date', 'aria-label': t('inv.col.expiryDate'), value: l.expiryDate || '' });
      r.loc = el('select', { 'aria-label': t('inv.col.location') });
      r.toLoc = el('select', { 'aria-label': t('inv.toLocation') });
      r.status = select([{ value: '', label: '—' }, ...m.qualityStatuses.map((q) => ({ value: q, label: t('inv.q.' + q) }))], l.toStatus || '', { 'aria-label': t('inv.col.quality') });
      r.serials = el('input', { dir: 'ltr', placeholder: t('inv.serialsHint'), 'aria-label': t('inv.serials'), value: l.serials ? l.serials.join(', ') : '' });
      r.override = el('input', { type: 'checkbox', 'aria-label': t('inv.overrideFefo') }); r.override.checked = !!l.overrideFefo;
      const remove = el('button', { type: 'button', class: 'btn small icon danger', title: t('journal.removeLine'), 'aria-label': t('journal.removeLine'), text: '×', on: { click: () => { rows.splice(rows.indexOf(r), 1); tr.remove(); } } });
      async function refreshItem() {
        const it = r.item.value;
        r.unit.replaceChildren(); r.batch.replaceChildren(el('option', { value: '', text: t(inbound ? 'inv.newOrNone' : 'inv.fefoAuto') }));
        r.batchBox.hidden = true; r.serialBox.hidden = true;
        if (!it) return;
        const [u, info] = await Promise.all([api.get(`${B}/items/${it.id}/units`), api.get(`${B}/items/${it.id}`)]);
        r.info = info;
        r.unit.append(el('option', { value: String(u.base.unitId), text: u.base.unitCode }), ...u.units.filter((x) => x.isActive).map((x) => el('option', { value: String(x.unitId), text: `${x.unitCode} (${dec(x.factor)})` })));
        if (l.unitId) r.unit.value = String(l.unitId);
        if (info.trackBatches) {
          r.batchBox.hidden = false;
          const bs = await api.get(`${B}/batches?itemId=${it.id}&warehouseId=${h.warehouseId.value}${inbound ? '' : '&inStock=1'}`);
          r.batch.append(...bs.map((b) => el('option', { value: String(b.id), text: `${b.batchNo}${b.expiryDate ? ' · ' + b.expiryDate : ''} · ${t('inv.q.' + (b.expired ? 'expired' : b.status))}${b.qty !== '0' ? ' · ' + dec(b.qty) : ''}` })));
          if (l.batchId) r.batch.value = String(l.batchId);
          r.newBatch.hidden = !inbound || type === 'quality';
        }
        r.serialBox.hidden = !info.trackSerials;
      }
      r.batchBox = el('div', { class: 'inv-batch', hidden: true }, r.batch); r.newBatch = el('div', { class: 'inv-newbatch', hidden: true }, r.batchNo, r.prod, r.exp); r.batchBox.append(r.newBatch);
      r.serialBox = el('div', { hidden: true }, r.serials);
      const fillLocs = async () => {
        const ls = await locs(h.warehouseId.value);
        r.loc.replaceChildren(el('option', { value: '', text: '—' }), ...ls.filter((x) => x.isActive).map((x) => el('option', { value: String(x.id), text: x.code })));
        if (l.locationId) r.loc.value = String(l.locationId);
        if (type === 'transfer' && h.toWarehouseId.value) {
          const tl = await locs(h.toWarehouseId.value);
          r.toLoc.replaceChildren(el('option', { value: '', text: '—' }), ...tl.filter((x) => x.isActive).map((x) => el('option', { value: String(x.id), text: x.code })));
          if (l.toLocationId) r.toLoc.value = String(l.toLocationId);
        }
      };
      r.refreshLocs = fillLocs;
      const tr = el('tr', null,
        el('td', { class: 'cb-cell' }, r.item.node),
        el('td', null, r.unit), el('td', null, type === 'quality' ? null : r.qty),
        COSTED.includes(type) ? el('td', null, r.cost) : null,
        el('td', null, r.batchBox, r.serialBox),
        el('td', null, r.loc), type === 'transfer' ? el('td', null, r.toLoc) : null,
        ['quality', 'receipt', 'opening'].includes(type) ? el('td', null, r.status) : null,
        ['issue', 'transfer_out'].includes(type) ? el('td', null, r.override) : null,
        el('td', null, remove));
      rows.push(r); body.append(tr);
      r.read = () => {
        const it = r.item.value;
        if (!it) return null;
        const o = { itemId: it.id, unitId: Number.parseInt(r.unit.value, 10) || undefined };
        if (type !== 'quality') o.qty = r.qty.value.trim();
        if (COSTED.includes(type) && r.cost.value.trim()) o.unitCost = r.cost.value.trim();
        if (r.batch.value) o.batchId = Number.parseInt(r.batch.value, 10);
        else if (r.batchNo.value.trim()) { o.batchNo = r.batchNo.value.trim(); if (r.prod.value) o.productionDate = r.prod.value; if (r.exp.value) o.expiryDate = r.exp.value; }
        if (r.loc.value) o.locationId = Number.parseInt(r.loc.value, 10);
        if (r.toLoc.value) o.toLocationId = Number.parseInt(r.toLoc.value, 10);
        if (r.status.value) o.toStatus = r.status.value;
        if (r.serials.value.trim()) o.serials = r.serials.value.split(/[\s,;]+/).filter(Boolean);
        if (r.override.checked) o.overrideFefo = true;
        return o;
      };
      await fillLocs();
      if (l.itemId) await refreshItem();
      return r;
    }
    h.warehouseId.addEventListener('change', () => { locCache.clear(); rows.forEach((r) => r.refreshLocs()); });
    h.toWarehouseId.addEventListener('change', () => rows.forEach((r) => r.refreshLocs()));
    const out = el('div');
    const alert = el('p', { class: 'form-alert', role: 'alert', hidden: true });
    const showErr = (e) => { alert.hidden = false; alert.textContent = errorText(e) + (e.details && e.details.line ? ` (${t('inv.col.line')} ${e.details.line})` : '') + (e.details && e.details.item ? ` — ${e.details.item}` : ''); };
    function readDoc() {
      const b = { docType: type, warehouseId: Number.parseInt(h.warehouseId.value, 10), docDate: h.docDate.value, lines: rows.map((r) => r.read()).filter(Boolean) };
      if (isTransfer) b.toWarehouseId = Number.parseInt(h.toWarehouseId.value, 10) || null;
      for (const k of ['externalRef', 'reason', 'notes', 'overrideReason', 'negativeReason']) b[k] = h[k].value.trim() || null;
      b.counterAccountId = counter.value ? counter.value.id : null;
      b.costCenterId = cc.value ? cc.value.id : null;
      if (returnOf) b.returnOfId = Number.parseInt(returnOf.value, 10) || null;
      return b;
    }
    let current = d;
    async function save() {
      alert.hidden = true;
      const b = readDoc();
      if (current) { const { docType, ...rest } = b; current = await api.put(`${B}/documents/${current.id}`, rest); void docType; }   // eslint-disable-line no-unused-vars
      else current = await api.post(`${B}/documents`, { ...b, idempotencyKey: ikey() });
      history.replaceState(null, '', '#/invDocument?id=' + current.id);
      return current;
    }
    const act = (fn) => async () => { try { await fn(); } catch (e) { showErr(e); } };
    const doSave = act(async () => { await save(); toast(t('common.saved')); });
    const doPreview = act(async () => {
      const doc = await save();
      const pv = await api.post(`${B}/documents/${doc.id}/preview`, {});
      const canValue = pv.moves.length === 0 || pv.moves[0].value !== undefined;
      fill(out, panel('inv.preview',
        pv.overrides.length ? el('p', { class: 'notice warn', text: t('inv.overridesNeeded', { n: pv.overrides.length }) }) : null,
        table({ columns: [
          { label: 'inv.col.line', render: (x) => String(x.line) }, { label: 'inv.col.itemCode', render: (x) => el('code', { dir: 'ltr', text: x.item }) },
          { label: 'inv.col.direction', render: (x) => t(x.direction === 'in' ? 'inv.col.in' : 'inv.col.out') },
          { label: 'inv.col.batch', render: (x) => el('span', { dir: 'ltr', text: x.batchNo || '' }) },
          { label: 'inv.col.qty', cls: 'num-col', render: (x) => num(x.qty) },
          ...(canValue ? [{ label: 'inv.col.unitCost', cls: 'num-col', render: (x) => num(x.unitCost, COST) }, { label: 'inv.col.value', cls: 'num-col', render: (x) => num(x.value, AMT) }] : []),
          { label: 'inv.col.balanceQty', cls: 'num-col', render: (x) => num(x.poolQtyAfter) },
        ], rows: pv.moves }),
        pv.gl.length ? table({ columns: [
          { label: 'inv.col.account', render: (g) => el('span', null, el('code', { dir: 'ltr', text: g.account.code }), ' ' + name(g.account)) },
          { label: 'inv.col.role', render: (g) => t('inv.role.' + g.role) },
          { label: 'inv.debit', cls: 'num-col', render: (g) => num(g.debit, AMT) }, { label: 'inv.credit', cls: 'num-col', render: (g) => num(g.credit, AMT) },
        ], rows: pv.gl }) : el('p', { class: 'muted', text: t('inv.noGl') })));
    });
    const doPost = act(async () => {
      const doc = await save();
      if (!(await confirm(t('inv.confirmPost')))) return;
      const r = await api.post(`${B}/documents/${doc.id}/post`, { idempotencyKey: ikey() });
      toast(t('inv.postedOk', { number: r.number })); go('#/invDocument?id=' + r.id);
    });
    const doApprove = act(async () => { const doc = await save(); await api.post(`${B}/documents/${doc.id}/approve`, {}); toast(t('inv.approvedOk')); });
    const doCancel = act(async () => {
      if (!current) { go('#/invDocuments'); return; }
      if (!(await confirm(t('inv.confirmCancel'), { danger: true }))) return;
      await api.post(`${B}/documents/${current.id}/cancel`, {}); go('#/invDocuments');
    });
    const postPerm = type === 'transfer_out' ? 'inventory_transfers.dispatch' : type === 'quality' ? ['inventory_quality.release', 'inventory_quality.quarantine', 'inventory_quality.reject'] : 'inventory_documents.post';
    const head = el('thead', null, el('tr', null,
      el('th', { text: t('inv.col.itemCode') }), el('th', { text: t('inv.col.unit') }), el('th', { text: type === 'quality' ? '' : t('inv.col.qty') }),
      COSTED.includes(type) ? el('th', { text: t('inv.col.unitCost') }) : null,
      el('th', { text: t('inv.col.batch') }), el('th', { text: t('inv.col.location') }), type === 'transfer' ? el('th', { text: t('inv.toLocation') }) : null,
      ['quality', 'receipt', 'opening'].includes(type) ? el('th', { text: t(type === 'quality' ? 'inv.newStatus' : 'inv.initialStatus') }) : null,
      ['issue', 'transfer_out'].includes(type) ? el('th', { text: t('inv.overrideFefo') }) : null, el('th', null)));
    TAYL.keys.setPage([
      { combo: 'Alt+L', alt: 'Insert', labelKey: 'journal.addLine', run: async () => (await addRow()).item.input.focus() },
      { combo: 'Ctrl+S', labelKey: 'keys.save', run: doSave },
    ]);
    const needCounter = ['receipt', 'opening', 'issue', 'return', 'adjust_in', 'adjust_out'].includes(type);
    fill(root,
      pageHead(d ? 'inv.editDraft' : 'inv.new.' + type, button('keys.button', () => TAYL.keys.help(), 'btn small'), el('a', { class: 'btn small', href: '#/invDocuments', text: t('inv.backToList') })),
      el('p', { class: 'muted', text: t('inv.help.' + type) }),
      panel(null,
        el('div', { class: 'form-grid' },
          field('inv.col.warehouse', h.warehouseId, true),
          isTransfer ? field('inv.toWarehouse', h.toWarehouseId, true) : null,
          field('inv.col.date', h.docDate, true),
          needCounter ? el('div', { class: 'field' }, el('label', { class: type === 'receipt' ? 'req' : null, text: t(type === 'opening' ? 'inv.openingOffset' : ['adjust_in', 'adjust_out'].includes(type) ? 'inv.adjustmentAccount' : 'inv.counterAccount') }), counter.node,
            el('p', { class: 'hint', text: t(type === 'opening' ? 'inv.openingOffsetHint' : type === 'receipt' ? 'inv.counterHint' : 'inv.counterDefaultHint') })) : null,
          needCounter ? el('div', { class: 'field' }, el('label', { text: t('inv.costCenter') }), cc.node) : null,
          returnOf ? field('inv.returnOf', returnOf) : null,
          field('inv.externalRef', h.externalRef),
          field('inv.reason', h.reason, ['adjust_in', 'adjust_out', 'quality'].includes(type)),
          ['issue', 'transfer_out'].includes(type) ? field('inv.overrideReason', h.overrideReason) : null,
          ['issue', 'adjust_out'].includes(type) && app.can('inventory.allow_negative') ? field('inv.negativeReason', h.negativeReason) : null,
          el('div', { class: 'field full' }, el('label', { text: t('inv.notes') }), h.notes)),
        el('div', { class: 'table-wrap' }, el('table', { class: 'data inv-lines' }, head, body)),
        el('div', { class: 'form-actions start' }, button('journal.addLine', async () => (await addRow()).item.input.focus(), 'btn small')),
        alert,
        el('div', { class: 'form-actions' },
          button('inv.saveDraft', doSave, 'btn'), button('inv.preview', doPreview, 'btn'),
          app.can('inventory_documents.approve') ? button('inv.approve', doApprove, 'btn') : null,
          app.can(postPerm) ? button('inv.post', doPost, 'btn primary') : null,
          button(d ? 'inv.cancelDraft' : 'common.cancel', doCancel, d ? 'btn danger' : 'btn'))),
      out);
    if (d) for (const l of d.lines) await addRow(l); else await addRow();
  }

  // ── التحويلات بين الفروع ──
  TAYL.views.invTransfers = {
    key: 'nav.invTransfers', perm: 'inventory_transfers.view',
    async render(root, app) {
      const holder = el('div');
      const all = el('input', { type: 'checkbox', id: 'tr-all' });
      async function load() {
        const r = await api.get(`${B}/transfers${all.checked ? '?status=all' : ''}`);
        const byT = new Map();
        for (const x of r.rows) { if (!byT.has(x.transferId)) byT.set(x.transferId, []); byT.get(x.transferId).push(x); }
        fill(holder, byT.size ? [...byT.values()].map((ls) => {
          const x0 = ls[0];
          const open = ['in_transit', 'partial'].includes(x0.status);
          return panel(null, el('h3', null, el('a', { href: '#/invDocument?id=' + x0.docId, dir: 'ltr', text: x0.document }), ` · ${x0.date} · `, el('span', { dir: 'ltr', text: `${x0.from} → ${x0.to}` }), ' ', badge('inv.tr.' + x0.status, open ? 'warn' : 'ok')),
            table({ columns: [
              { label: 'inv.col.itemCode', render: (l) => el('code', { dir: 'ltr', text: l.itemCode }) }, { label: 'inv.col.batch', render: (l) => el('span', { dir: 'ltr', text: l.batch || '' }) },
              { label: 'inv.col.sent', cls: 'num-col', render: (l) => num(l.sent) }, { label: 'inv.col.received', cls: 'num-col', render: (l) => num(l.received) },
              { label: 'inv.col.rejected', cls: 'num-col', render: (l) => num(l.rejected) }, { label: 'inv.col.remaining', cls: 'num-col', render: (l) => num(l.remaining) },
            ], rows: ls }),
            open && app.can('inventory_transfers.receive') ? el('div', { class: 'form-actions start' }, button('inv.receive', wrap(() => receiveDialog(ls, load)), 'btn primary small'), button('inv.closeTransfer', wrap(() => closeDialog(x0, load)), 'btn small danger')) : null);
        }) : el('p', { class: 'muted', text: t('inv.noTransfers') }));
      }
      all.addEventListener('change', wrap(load));
      fill(root, pageHead('nav.invTransfers', app.can('inventory_transfers.create') ? button('inv.new.transfer_out', () => go('#/invDocument?type=transfer_out'), 'btn primary') : null),
        el('p', { class: 'muted', text: t('inv.transfersIntro') }), el('label', { class: 'check', for: 'tr-all' }, all, ' ', t('inv.showClosed')), holder);
      await load();
    },
  };
  async function receiveDialog(ls, reload) {
    const m = await meta();
    const qrn = (await warehouses(true)).filter((w) => w.whType === 'quarantine');
    const date = el('input', { type: 'date', value: m.today, id: 'rcv-date' });
    const rej = select([{ value: '', label: '—' }, ...qrn.map((w) => ({ value: String(w.id), label: whLabel(w) }))], '', { id: 'rcv-reject' });
    const inputs = ls.filter((l) => l.remaining !== '0').map((l) => ({ l, qty: el('input', { dir: 'ltr', class: 'num', inputmode: 'decimal', value: l.remaining, 'aria-label': t('inv.col.received') }), rej: el('input', { dir: 'ltr', class: 'num', inputmode: 'decimal', 'aria-label': t('inv.col.rejected') }) }));
    const alert = el('p', { class: 'form-alert', hidden: true });
    const close = modal({ title: `${t('inv.receive')} — ${ls[0].document}`, wide: true, body: el('div', null,
      el('div', { class: 'form-grid' }, field('inv.col.date', date, true), field('inv.rejectWarehouse', rej)),
      el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, el('thead', null, el('tr', null, ['inv.col.itemCode', 'inv.col.batch', 'inv.col.remaining', 'inv.col.received', 'inv.col.rejected'].map((k) => el('th', { text: t(k) })))),
        el('tbody', null, inputs.map((x) => el('tr', null, el('td', { dir: 'ltr', text: x.l.itemCode }), el('td', { dir: 'ltr', text: x.l.batch || '' }), el('td', null, num(x.l.remaining)), el('td', null, x.qty), el('td', null, x.rej)))))),
      alert,
      el('div', { class: 'form-actions' }, button('inv.receive', async () => {
        try {
          const lines = inputs.map((x) => ({ transferLineId: x.l.transferLineId, qty: x.qty.value.trim() || '0', ...(x.rej.value.trim() ? { qtyRejected: x.rej.value.trim() } : {}) })).filter((x) => x.qty !== '0' || x.qtyRejected);
          const r = await api.post(`${B}/transfers/${ls[0].transferId}/receive`, { date: date.value, rejectWarehouseId: rej.value ? Number.parseInt(rej.value, 10) : null, lines, idempotencyKey: ikey() });
          close(); toast(t('inv.receivedOk', { number: r.number })); reload();
        } catch (e) { alert.hidden = false; alert.textContent = errorText(e); }
      }, 'btn primary'))) });
  }
  async function closeDialog(x0, reload) {
    const m = await meta();
    const f = form({ submitKey: 'inv.closeTransfer', fields: [
      { name: 'date', label: 'inv.col.date', type: 'date', required: true, value: m.today },
      { name: 'reason', label: 'inv.closeReason', type: 'textarea', required: true, full: true },
    ], async onSubmit(v) { const r = await api.post(`${B}/transfers/${x0.transferId}/close`, { ...v, idempotencyKey: ikey() }); close(); toast(t('inv.closedOk', { number: r.number })); reload(); }, onCancel: () => close() });
    const close = modal({ title: `${t('inv.closeTransfer')} — ${x0.document}`, body: el('div', null, el('p', { class: 'notice warn', text: t('inv.closeWarn') }), f.node) });
  }

  // ── الجرد ──
  TAYL.views.invCounts = {
    key: 'nav.invCounts', perm: 'inventory_counts.view',
    async render(root, app) {
      const rows = await api.get(`${B}/counts`);
      const startCount = wrap(async () => {
        const m = await meta();
        const whs = await warehouses(true);
        const f = form({ submitKey: 'inv.startCount', fields: [
          { name: 'warehouseId', label: 'inv.col.warehouse', type: 'select', required: true, options: whs.map((w) => ({ value: String(w.id), label: whLabel(w) })), numeric: true },
          { name: 'groupId', label: 'inv.group', type: 'combobox', source: TAYL.combobox.lookupSource(`${B}/groups`), hint: 'inv.countGroupHint' },
          { name: 'countDate', label: 'inv.col.date', type: 'date', required: true, value: m.today },
          { name: 'blind', label: 'inv.blindCount', type: 'checkbox', hint: 'inv.blindHint' },
          { name: 'freeze', label: 'inv.freezeMoves', type: 'checkbox', hint: 'inv.freezeHint' },
          { name: 'notes', label: 'inv.notes', type: 'textarea', full: true },
        ], async onSubmit(v) {
          const c = await api.post(`${B}/counts`, { ...v, warehouseId: Number.parseInt(v.warehouseId, 10), groupId: v.groupId ? v.groupId.id : null, notes: v.notes || null });
          close(); go('#/invCount?id=' + c.id);
        }, onCancel: () => close() });
        const close = modal({ title: t('inv.startCount'), body: el('div', null, el('p', { class: 'muted', text: t('inv.countIntro') }), f.node) });
      });
      fill(root, pageHead('nav.invCounts', app.can('inventory_counts.create') ? button('inv.startCount', startCount, 'btn primary') : null),
        el('p', { class: 'muted', text: t('inv.countsIntro') }),
        panel(null, table({ columns: [
          { label: 'inv.col.count', render: (c) => el('a', { href: '#/invCount?id=' + c.id, dir: 'ltr', text: c.number }) },
          { label: 'inv.col.date', render: (c) => el('span', { dir: 'ltr', text: c.countDate }) },
          { label: 'inv.col.warehouse', render: (c) => el('span', { dir: 'ltr', text: c.warehouseCode }) },
          { label: 'inv.lines', cls: 'num-col', render: (c) => String(c.lines) },
          { label: 'common.status', render: (c) => [badge('inv.cs.' + c.status, c.status === 'posted' ? 'ok' : c.status === 'cancelled' ? 'muted' : 'warn'), c.blind ? badge('inv.blindCount', '') : null, c.freeze ? badge('inv.freezeMoves', '') : null] },
        ], rows })));
    },
  };
  TAYL.views.invCount = {
    key: 'nav.invCounts', perm: ['inventory_counts.view', 'inventory_counts.count'],
    async render(root, app) {
      const id = params().get('id');
      const c = await api.get(`${B}/counts/${id}`);
      const counting = c.status === 'counting';
      const canCount = counting && app.can('inventory_counts.count');
      const step = (fn, msg) => wrap(async (...a) => { await fn(...a); if (msg) toast(t(msg)); TAYL.views.invCount.render(root, app); });
      const entry = (l) => {
        if (!canCount) return null;
        const inp = el('input', { dir: 'ltr', class: 'num', inputmode: 'decimal', 'aria-label': t('inv.col.countedQty'), size: 8 });
        const save = step(() => api.post(`${B}/counts/${c.id}/entries`, { lineId: l.id, qty: inp.value.trim(), ...(l.entries.length ? { recount: true } : {}) }));
        inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); save(); } });
        return el('span', { class: 'inv-entry' }, inp, button(l.entries.length ? 'inv.recount' : 'inv.saveCount', save, 'btn small'));
      };
      const addLine = canCount ? (() => {
        const cb = TAYL.combobox.create({ source: itemSource, label: t('inv.col.itemCode') });
        return el('div', { class: 'filters' }, el('span', { class: 'muted', text: t('inv.foundItem') }), el('div', { class: 'cb-inline wide' }, cb.node),
          button('inv.addCountLine', step(() => cb.value && api.post(`${B}/counts/${c.id}/lines`, { itemId: cb.value.id })), 'btn small'));
      })() : null;
      const post = step(async () => {
        if (!(await confirm(t('inv.confirmPostCount')))) return;
        await api.post(`${B}/counts/${c.id}/post`, { idempotencyKey: ikey() });
      }, 'inv.countPostedOk');
      const cancel = wrap(async () => {
        const f = form({ submitKey: 'inv.cancelCount', fields: [{ name: 'reason', label: 'inv.reason', type: 'textarea', required: true, full: true }],
          async onSubmit(v) { await api.post(`${B}/counts/${c.id}/cancel`, v); close(); TAYL.views.invCount.render(root, app); }, onCancel: () => close() });
        const close = modal({ title: t('inv.cancelCount'), body: f.node });
      });
      fill(root,
        pageHead('nav.invCounts', el('a', { class: 'btn small', href: '#/invCounts', text: t('inv.backToList') })),
        panel(null, el('dl', { class: 'facts inv-facts' },
          el('div', null, el('dt', { text: t('inv.col.count') }), el('dd', { dir: 'ltr', text: c.number })),
          el('div', null, el('dt', { text: t('inv.col.warehouse') }), el('dd', { dir: 'ltr', text: c.warehouseCode })),
          el('div', null, el('dt', { text: t('inv.col.date') }), el('dd', { dir: 'ltr', text: c.countDate })),
          el('div', null, el('dt', { text: t('inv.cutoff') }), el('dd', { dir: 'ltr', text: c.cutoffAt.slice(0, 19).replace('T', ' ') })),
          el('div', null, el('dt', { text: t('common.status') }), el('dd', null, badge('inv.cs.' + c.status, c.status === 'posted' ? 'ok' : 'warn'), c.blind ? badge('inv.blindCount', '') : null, c.freeze ? badge('inv.freezeMoves', '') : null))),
          c.systemHidden ? el('p', { class: 'notice', text: t('inv.blindNotice') }) : null,
          c.cancelReason ? el('p', { class: 'notice warn', text: c.cancelReason }) : null,
          el('div', { class: 'form-actions start' },
            counting && app.can('inventory_counts.count') ? button('inv.submitCount', step(() => api.post(`${B}/counts/${c.id}/submit`, {}), 'common.saved'), 'btn') : null,
            c.status === 'review' && app.can('inventory_counts.review') ? button('inv.reopenCount', step(() => api.post(`${B}/counts/${c.id}/reopen`, {})), 'btn') : null,
            c.status === 'review' && app.can('inventory_counts.approve') ? button('inv.approveCount', step(() => api.post(`${B}/counts/${c.id}/approve`, {}), 'inv.approvedOk'), 'btn primary') : null,
            c.status === 'approved' && app.can('inventory_counts.post') ? button('inv.postCount', post, 'btn primary') : null,
            ['counting', 'review', 'approved'].includes(c.status) && app.can('inventory_counts.create') ? button('inv.cancelCount', cancel, 'btn danger') : null),
          c.documents.length ? el('p', null, c.documents.flatMap((x, i) => [i ? ' · ' : '', el('a', { href: '#/invDocument?id=' + x.id, dir: 'ltr', text: `${x.number} (${t('inv.doc.' + x.docType)})` })])) : null),
        addLine,
        panel('inv.lines', table({ columns: [
          { label: 'inv.col.itemCode', render: (l) => el('span', null, el('code', { dir: 'ltr', text: l.itemCode }), ' ' + name({ nameAr: l.itemNameAr, nameEn: l.itemNameEn })) },
          { label: 'inv.col.batch', render: (l) => el('span', { dir: 'ltr', text: [l.batchNo, l.locationCode].filter(Boolean).join(' · ') }) },
          { label: 'inv.col.systemQty', cls: 'num-col', render: (l) => (l.systemQty === null ? el('span', { class: 'muted', text: '•••' }) : num(l.systemQty)) },
          { label: 'inv.col.countedQty', cls: 'num-col', render: (l) => [num(l.countedQty), l.entries.length > 1 ? el('span', { class: 'muted', text: ' ' + t('inv.rounds', { n: l.entries.length }) }) : null] },
          { label: 'inv.col.difference', cls: 'num-col', render: (l) => (l.difference === null ? '' : num(l.difference)) },
          { label: 'inv.col.differenceValue', cls: 'num-col', render: (l) => (l.differenceValue === null ? '' : num(l.differenceValue, AMT)) },
          { label: 'inv.enterCount', render: entry },
        ], rows: c.lines })));
    },
  };

  // ── الدفعات والجودة ──
  TAYL.views.invBatches = {
    key: 'nav.invBatches', perm: ['inventory_batches.view', 'inventory_quality.view'],
    async render(root, app) {
      const m = await meta();
      const st = select([{ value: '', label: t('common.allStatuses') }, ...m.qualityStatuses.map((q) => ({ value: q, label: t('inv.q.' + q) }))], '', { 'aria-label': t('inv.col.quality') });
      const q = el('input', { type: 'search', id: 'page-search', placeholder: t('inv.searchBatches'), 'aria-label': t('common.search') });
      const inStock = el('input', { type: 'checkbox', id: 'b-stock' }); inStock.checked = true;
      const holder = el('div');
      const canQ = app.can(['inventory_quality.release', 'inventory_quality.quarantine', 'inventory_quality.reject']);
      const quality = (b) => wrap(async () => {
        const whs = await warehouses(true);
        const f = form({ submitKey: 'inv.changeStatus', fields: [
          { name: 'toStatus', label: 'inv.newStatus', type: 'select', required: true, options: m.qualityStatuses.filter((x) => x !== b.status).map((x) => ({ value: x, label: t('inv.q.' + x) })) },
          { name: 'warehouseId', label: 'inv.col.warehouse', type: 'select', required: true, options: whs.map((w) => ({ value: String(w.id), label: whLabel(w) })), hint: 'inv.qualityWhHint' },
          { name: 'reason', label: 'inv.reason', type: 'textarea', required: true, full: true },
        ], async onSubmit(v) {
          const doc = await api.post(`${B}/documents`, { docType: 'quality', warehouseId: Number.parseInt(v.warehouseId, 10), docDate: m.today, reason: v.reason, lines: [{ itemId: b.itemId, batchId: b.id, toStatus: v.toStatus }], idempotencyKey: ikey() });
          await api.post(`${B}/documents/${doc.id}/post`, { idempotencyKey: ikey() });
          close(); toast(t('common.saved')); load();
        }, onCancel: () => close() });
        const close = modal({ title: `${t('inv.changeStatus')} — ${b.batchNo}`, body: f.node });
      });
      async function load() {
        const rows = await api.get(`${B}/batches?${new URLSearchParams({ status: st.value, q: q.value, inStock: inStock.checked ? '1' : '' })}`);
        fill(holder, table({ columns: [
          { label: 'inv.col.batch', render: (b) => el('code', { dir: 'ltr', text: b.batchNo }) },
          { label: 'inv.col.itemCode', render: (b) => el('span', null, el('code', { dir: 'ltr', text: b.itemCode }), ' ' + name({ nameAr: b.itemNameAr, nameEn: b.itemNameEn })) },
          { label: 'inv.col.productionDate', render: (b) => el('span', { dir: 'ltr', text: b.productionDate || '' }) },
          { label: 'inv.col.expiryDate', render: (b) => el('span', { dir: 'ltr', text: b.expiryDate || '' }) },
          { label: 'inv.col.quality', render: (b) => [badge('inv.q.' + b.status, b.status === 'available' ? 'ok' : 'warn'), b.expired ? badge('inv.q.expired', 'bad') : null] },
          { label: 'inv.col.qty', cls: 'num-col', render: (b) => num(b.qty) },
          { label: 'common.actions', render: (b) => (canQ ? button('inv.changeStatus', quality(b), 'btn small') : null) },
        ], rows }));
      }
      st.addEventListener('change', wrap(load)); inStock.addEventListener('change', wrap(load));
      q.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); wrap(load)(); } });
      fill(root, pageHead('nav.invBatches'), el('p', { class: 'muted', text: t('inv.batchesIntro') }),
        panel(null, el('div', { class: 'filters' }, q, st, el('label', { class: 'check', for: 'b-stock' }, inStock, ' ', t('inv.inStockOnly'))), holder));
      await load();
    },
  };

  // ── الحجوزات ──
  TAYL.views.invReservations = {
    key: 'nav.invReservations', perm: 'inventory_reservations.view',
    async render(root, app) {
      const holder = el('div');
      const can = app.can('inventory_reservations.manage');
      async function load() {
        const rows = await api.get(`${B}/reservations`);
        fill(holder, table({ columns: [
          { label: 'inv.col.reference', render: (r) => r.reference },
          { label: 'inv.col.itemCode', render: (r) => el('code', { dir: 'ltr', text: r.itemCode }) },
          { label: 'inv.col.warehouse', render: (r) => el('span', { dir: 'ltr', text: r.warehouseCode + (r.batchNo ? ' · ' + r.batchNo : '') }) },
          { label: 'inv.col.reserved', cls: 'num-col', render: (r) => num(r.qty) }, { label: 'inv.col.consumed', cls: 'num-col', render: (r) => num(r.consumedQty) },
          { label: 'inv.col.remaining', cls: 'num-col', render: (r) => num(r.remaining) },
          { label: 'inv.col.expiresOn', render: (r) => el('span', { dir: 'ltr', text: r.expiresOn || '' }) },
          { label: 'common.status', render: (r) => badge('inv.rs.' + r.status, r.status === 'active' ? 'ok' : 'muted') },
          { label: 'common.actions', render: (r) => (can && r.status === 'active' ? button('inv.release', wrap(async () => {
            const f = form({ submitKey: 'inv.release', fields: [{ name: 'reason', label: 'inv.reason', type: 'textarea', required: true, full: true }],
              async onSubmit(v) { await api.post(`${B}/reservations/${r.id}/release`, v); close(); load(); }, onCancel: () => close() });
            const close = modal({ title: t('inv.release'), body: f.node });
          }), 'btn small') : null) },
        ], rows }));
      }
      const create = wrap(async () => {
        const whs = await warehouses(true);
        const f = form({ submitKey: 'inv.reserve', fields: [
          { name: 'itemId', label: 'inv.col.itemCode', type: 'combobox', required: true, source: itemSource },
          { name: 'warehouseId', label: 'inv.col.warehouse', type: 'select', required: true, options: whs.map((w) => ({ value: String(w.id), label: whLabel(w) })) },
          { name: 'qty', label: 'inv.col.qty', required: true, dir: 'ltr', inputmode: 'decimal', hint: 'inv.baseUnitHint' },
          { name: 'reference', label: 'inv.col.reference', required: true, maxlength: 120 },
          { name: 'expiresOn', label: 'inv.col.expiresOn', type: 'date' },
        ], async onSubmit(v) {
          await api.post(`${B}/reservations`, { itemId: v.itemId.id, warehouseId: Number.parseInt(v.warehouseId, 10), qty: v.qty, reference: v.reference, expiresOn: v.expiresOn || null, idempotencyKey: ikey() });
          close(); toast(t('common.saved')); load();
        }, onCancel: () => close() });
        const close = modal({ title: t('inv.reserve'), body: el('div', null, el('p', { class: 'muted', text: t('inv.reserveIntro') }), f.node) });
      });
      fill(root, pageHead('nav.invReservations', can ? button('inv.reserve', create, 'btn primary') : null), el('p', { class: 'muted', text: t('inv.reservationsIntro') }), panel(null, holder));
      await load();
    },
  };

  // ── الإعدادات: التقييم والربط المحاسبي ──
  TAYL.views.invSettings = {
    key: 'nav.invSettings', perm: ['inventory_costing.view', 'inventory_costing.settings', 'inventory.accounting_settings'],
    async render(root, app) {
      const s = await api.get(`${B}/settings`);
      const lab = (a) => (a ? { id: a.id, label: `${a.code} — ${name(a)}` } : null);
      const canAcc = app.can('inventory.accounting_settings'); const canCost = app.can('inventory_costing.settings');
      const f = form({ readOnly: !canAcc && !canCost, fields: [
        { name: 'inventoryAccountId', label: 'inv.inventoryAccount', type: 'combobox', source: accSource, value: lab(s.inventoryAccount), disabled: !canAcc, hint: 'inv.inventoryAccountHint' },
        { name: 'issueAccountId', label: 'inv.issueAccount', type: 'combobox', source: accSource, value: lab(s.issueAccount), disabled: !canAcc, hint: 'inv.issueAccountHint' },
        { name: 'adjustmentAccountId', label: 'inv.adjustmentAccount', type: 'combobox', source: accSource, value: lab(s.adjustmentAccount), disabled: !canAcc, hint: 'inv.adjustmentAccountHint' },
        { name: 'transitAccountId', label: 'inv.transitAccount', type: 'combobox', source: accSource, value: lab(s.transitAccount), disabled: !canAcc, hint: 'inv.transitAccountHint' },
        { name: 'expiryAlertDays', label: 'inv.expiryAlertDays', type: 'number', min: 1, max: 3650, value: s.expiryAlertDays, disabled: !canCost },
        { name: 'slowMovingDays', label: 'inv.slowMovingDays', type: 'number', min: 1, max: 3650, value: s.slowMovingDays, disabled: !canCost },
        { name: 'staleDraftDays', label: 'inv.staleDraftDays', type: 'number', min: 1, max: 365, value: s.staleDraftDays, disabled: !canCost },
        { name: 'requireApproval', label: 'inv.requireApproval', type: 'checkbox', value: s.requireApproval, disabled: !canCost },
      ], async onSubmit(v) {
        const b = {};
        if (canAcc) for (const k of ['inventoryAccountId', 'issueAccountId', 'adjustmentAccountId', 'transitAccountId']) b[k] = v[k] ? v[k].id : null;
        if (canCost) for (const k of ['expiryAlertDays', 'slowMovingDays', 'staleDraftDays', 'requireApproval']) b[k] = v[k];
        await api.put(`${B}/settings`, b); toast(t('common.saved'));
      } });
      fill(root, pageHead('nav.invSettings'), el('p', { class: 'muted', text: t('inv.settingsIntro') }),
        panel('inv.valuationMethod', el('ul', null, s.valuationMethods.map((x) => el('li', null, t('inv.method.' + x.code), ' ', badge(x.supported ? 'inv.supported' : 'inv.notSupported', x.supported ? 'ok' : 'muted')))),
          el('p', { class: 'muted', text: t('inv.methodNote') })),
        panel('inv.accountingSettings', f.node));
    },
  };

  // ── مركز التقارير ──
  const REPORTS = ['stock', 'stock-by-warehouse', 'item-card', 'movements', 'valuation', 'slow-moving', 'reorder', 'batches', 'quality', 'negative', 'reservations', 'count-differences', 'transfers', 'gl-reconciliation'];
  const FILTERS = {
    stock: ['branch', 'warehouse', 'group', 'item'], 'stock-by-warehouse': ['branch', 'warehouse', 'group', 'item'], 'item-card': ['item', 'branch', 'warehouse', 'from', 'to'],
    movements: ['branch', 'warehouse', 'group', 'item', 'docType', 'from', 'to'], valuation: ['branch', 'warehouse', 'group', 'item', 'asOf'], 'slow-moving': ['branch', 'warehouse', 'group', 'days'],
    reorder: ['branch', 'warehouse', 'group'], batches: ['branch', 'warehouse', 'item', 'expiry', 'status', 'days'], quality: ['branch', 'warehouse', 'item'], negative: ['branch', 'warehouse', 'item'],
    reservations: ['branch', 'warehouse', 'item'], 'count-differences': ['branch', 'warehouse', 'from', 'to'], transfers: [], 'gl-reconciliation': ['branch', 'asOf'],
  };
  const repState = { report: 'stock', q: {} };
  TAYL.views.invReports = {
    key: 'nav.invReports', perm: 'inventory_reports.view',
    async render(root, app) {
      const p = params();
      if (p.get('report')) { repState.report = p.get('report'); repState.q = Object.fromEntries([...p.entries()].filter(([k]) => k !== 'report')); }
      const m = await meta();
      const whs = await warehouses(false);
      const canValue = app.can('inventory_valuation.view');
      const reportSel = select(REPORTS.filter((r) => canValue || !['valuation', 'gl-reconciliation'].includes(r)).map((r) => ({ value: r, label: t('inv.report.' + r) })), repState.report, { id: 'inv-report', 'aria-label': t('inv.report') });
      const ctl = {
        branch: select([{ value: '', label: t('ledger.allBranches') }, ...(app.session.branches || []).map((b) => ({ value: String(b.id), label: `${b.code} — ${name(b)}` }))], repState.q.branchId || '', { 'aria-label': t('inv.col.branch'), id: 'inv-r-branch' }),
        warehouse: select([{ value: '', label: t('inv.allWarehouses') }, ...whs.map((w) => ({ value: String(w.id), label: whLabel(w) }))], repState.q.warehouseId || '', { 'aria-label': t('inv.col.warehouse'), id: 'inv-r-wh' }),
        group: TAYL.combobox.create({ source: TAYL.combobox.lookupSource(`${B}/groups`), value: repState.q.groupId ? { id: Number(repState.q.groupId), label: '#' + repState.q.groupId } : null, label: t('inv.group'), placeholderKey: 'inv.anyGroup' }),
        item: TAYL.combobox.create({ source: itemSource, value: repState.q.itemId ? { id: Number(repState.q.itemId), label: '#' + repState.q.itemId } : null, label: t('inv.col.itemCode'), placeholderKey: 'inv.anyItem' }),
        docType: select([{ value: '', label: t('inv.allTypes') }, ...[...TYPES.filter((x) => x !== 'quality'), 'transfer_in', 'reversal'].map((x) => ({ value: x, label: t('inv.doc.' + x) }))], repState.q.docType || '', { 'aria-label': t('inv.col.docType') }),
        from: el('input', { type: 'date', 'aria-label': t('inv.from'), value: repState.q.from || '' }), to: el('input', { type: 'date', 'aria-label': t('inv.to'), value: repState.q.to || '' }),
        asOf: el('input', { type: 'date', 'aria-label': t('fs.asOf'), title: t('inv.asOfHint'), value: repState.q.asOf || '' }),
        days: el('input', { type: 'number', min: 1, max: 3650, 'aria-label': t('inv.days'), placeholder: t('inv.days'), value: repState.q.days || '' }),
        expiry: select([{ value: '', label: t('inv.allExpiry') }, { value: 'near', label: t('inv.alert.near_expiry') }, { value: 'expired', label: t('inv.alert.expired') }], repState.q.expiry || '', { 'aria-label': t('inv.col.expiryDate') }),
        status: select([{ value: '', label: t('common.allStatuses') }, ...m.qualityStatuses.map((x) => ({ value: x, label: t('inv.q.' + x) }))], repState.q.status || '', { 'aria-label': t('inv.col.quality') }),
      };
      const label = (k, node) => el('label', { class: 'inv-filter' }, el('span', { class: 'muted', text: t({ branch: 'inv.col.branch', warehouse: 'inv.col.warehouse', group: 'inv.group', item: 'inv.col.itemCode', docType: 'inv.col.docType', from: 'inv.from', to: 'inv.to', asOf: 'fs.asOf', days: 'inv.days', expiry: 'inv.col.expiryDate', status: 'inv.col.quality' }[k]) }), node);
      const filterBox = el('div', { class: 'filters' });
      const out = el('div');
      function drawFilters() { fill(filterBox, reportSel, FILTERS[reportSel.value].map((k) => label(k, ctl[k].node || ctl[k]))); }
      reportSel.addEventListener('change', () => { drawFilters(); fill(out); });
      function query() {
        const q = new URLSearchParams();
        const f = FILTERS[reportSel.value];
        if (f.includes('branch') && ctl.branch.value) q.set('branchId', ctl.branch.value);
        if (f.includes('warehouse') && ctl.warehouse.value) q.set('warehouseId', ctl.warehouse.value);
        if (f.includes('group') && ctl.group.value) q.set('groupId', String(ctl.group.value.id));
        if (f.includes('item') && ctl.item.value) q.set('itemId', String(ctl.item.value.id));
        for (const k of ['docType', 'from', 'to', 'asOf', 'days', 'expiry', 'status']) if (f.includes(k) && ctl[k].value) q.set(k, ctl[k].value);
        return q;
      }
      const cell = (c, row) => {
        const v = row[c.key];
        if (c.type === 'qty') return num(v);
        if (c.type === 'amount') return num(v, AMT);
        if (c.type === 'cost') return num(v, COST);
        if (c.type === 'date') return el('span', { dir: 'ltr', text: v || '' });
        if (c.type === 'int') return el('span', { class: 'num', dir: 'ltr', text: v === null || v === undefined ? '' : String(v) });
        if (v && typeof v === 'object' && 'ar' in v) return name({ nameAr: v.ar, nameEn: v.en });
        if (c.key === 'document' && row.docId && app.can('inventory_documents.view')) return el('a', { href: '#/invDocument?id=' + row.docId, dir: 'ltr', text: v || '' });
        if (c.key === 'itemCode' && row.itemId && reportSel.value !== 'item-card') return el('a', { href: `#/invReports?report=item-card&itemId=${row.itemId}`, dir: 'ltr', text: v });
        if (c.key === 'count' && row.countId) return el('a', { href: '#/invCount?id=' + row.countId, dir: 'ltr', text: v });
        if (c.i18n) return v ? t(c.i18n + v) : '';
        return el('span', { dir: /^[\x20-\x7E]*$/.test(String(v || '')) ? 'ltr' : null, text: v === null || v === undefined ? '' : String(v) });
      };
      const show = wrap(async () => {
        const q = query();
        repState.report = reportSel.value; repState.q = Object.fromEntries(q.entries());
        const r = await api.get(`${B}/reports/${reportSel.value}?${q}`);
        const numeric = (c) => ['qty', 'amount', 'cost', 'int'].includes(c.type);
        fill(out,
          el('div', { class: 'fs-badges' },
            badge(r.finality.final ? 'ledger.final' : 'ledger.notFinal', r.finality.final ? 'ok' : 'warn'),
            r.report === 'gl-reconciliation' ? badge(r.reconciled ? 'inv.recon.ok' : 'inv.recon.blocked', r.reconciled ? 'ok' : 'bad') : null,
            r.valuesHidden ? badge('inv.valuesHidden', 'muted') : null,
            el('span', { class: 'muted', dir: 'ltr', text: ` ${r.meta.from || r.meta.to ? `${r.meta.from || '…'} → ${r.meta.to}` : r.meta.asOf} · ${r.baseCurrency}` })),
          r.meta.item ? el('h3', null, el('code', { dir: 'ltr', text: r.meta.item.code }), ' ' + name(r.meta.item)) : null,
          el('div', { class: 'table-wrap' }, el('table', { class: 'data' },
            el('thead', null, el('tr', null, r.columns.map((c) => el('th', { class: numeric(c) ? 'num-col' : null, text: t(c.label) })))),
            el('tbody', null, r.rows.map((row) => el('tr', { class: row.docType === 'opening_balance' ? 'fs-subtotal' : null }, r.columns.map((c) => el('td', { class: numeric(c) ? 'num-col' : null },
              row.docType === 'opening_balance' && c.key === 'docType' ? t('inv.openingBalance') : cell(c, row)))))),
            Object.keys(r.totals).length ? el('tfoot', null, el('tr', { class: 'fs-total' }, r.columns.map((c, i) => el('td', { class: numeric(c) ? 'num-col' : null }, i === 0 ? t('inv.total') : r.totals[c.key] !== undefined ? cell(c, r.totals) : '')))) : null)),
          r.rows.length ? null : el('p', { class: 'muted', text: t('common.empty') }));
      });
      const io = [
        app.can('inventory_reports.print') ? button('common.print', () => TAYL.ui.printFrom(`${B}/reports/${reportSel.value}/print?${query()}&lang=${window.I18N.lang}`), 'btn small') : null,
        app.can('inventory_reports.export') ? button('inv.exportExcel', () => TAYL.ui.download(`${B}/reports/${reportSel.value}/export.xlsx?${query()}&lang=${window.I18N.lang}`, `${reportSel.value}.xlsx`), 'btn small') : null,
      ];
      drawFilters();
      fill(root, pageHead('nav.invReports', button('keys.button', () => TAYL.keys.help(), 'btn small')), el('p', { class: 'muted', text: t('inv.reportsIntro') }),
        panel(null, filterBox, el('div', { class: 'form-actions start' }, button('inv.show', show, 'btn primary'), io)), out);
      filterBox.addEventListener('keydown', (e) => { if (e.key === 'Enter' && e.target.tagName !== 'BUTTON' && !e.defaultPrevented) { e.preventDefault(); show(); } });
      if (p.get('report')) await show();
    },
  };
})();

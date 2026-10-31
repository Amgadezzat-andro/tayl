'use strict';
/*
 * جدول بيانات موحد (قائمة أو شجرة) يعمل بلوحة المفاتيح:
 *  - الأسهم أعلى/أسفل، Home/End، PageUp/PageDown للتنقل بين الصفوف (صف واحد قابل للتركيز: roving tabindex).
 *  - Enter يفتح الصف (عرض/تعديل حسب الصلاحية)، F2 للتعديل عند وجود الصلاحية فقط.
 *  - في الشجرة: يمين/يسار (حسب اتجاه اللغة) لفتح/طي الفرع.
 *  - الفرز بالنقر على العنوان أو Enter عليه (aria-sort)، للقوائم (الشجرة بترتيبها الهرمي).
 */
window.TAYL = window.TAYL || {};
TAYL.grid = (() => {
  const t = (k, v) => window.I18N.t(k, v);

  /**
   * columns: [{ label, render(row), sortValue?(row), cls }]
   * rows: للشجرة: { id, parentId, level, hasChildren }
   */
  /**
   * collapsedState: مجموعة مشتركة يحتفظ بها مالك الجدول فتبقى حالة الفتح/الطي بعد إعادة التحميل.
   * الشجرة تُفتح كاملة افتراضيًا إن كانت صغيرة (≤ 300 صف)، وإلا تُطوى من المستوى الثاني.
   */
  function create({ columns, rows, tree = false, onOpen, onEdit, canEdit = false, emptyKey = 'common.empty', expandAll = false, caption, collapsedState, initialSelected }) {
    const { el } = TAYL.ui;
    let sort = null;                        // { i, dir }
    let selectedId = initialSelected ?? null;
    const collapsed = collapsedState || new Set();
    if (tree && !collapsedState?.initialized) {
      if (!expandAll && rows.length > 300) for (const r of rows) if (r.hasChildren && r.level >= 2) collapsed.add(r.id);
      if (collapsedState) collapsedState.initialized = true;
    }
    if (expandAll) collapsed.clear();

    const tbody = el('tbody');
    const table = el('table', { class: 'data data-grid', role: tree ? 'treegrid' : 'grid', 'aria-label': caption });
    const wrap = el('div', { class: 'table-wrap' }, table);

    function visibleRows() {
      if (!tree) {
        if (!sort) return rows;
        const c = columns[sort.i];
        const val = (r) => (c.sortValue ? c.sortValue(r) : String(c.render(r) ?? ''));
        return [...rows].sort((a, b) => { const x = val(a); const y = val(b); return (x < y ? -1 : x > y ? 1 : 0) * sort.dir; });
      }
      const hidden = new Set();
      const out = [];
      for (const r of rows) {
        if (r.parentId != null && (hidden.has(r.parentId) || collapsed.has(r.parentId))) { hidden.add(r.id); continue; }
        out.push(r);
      }
      return out;
    }

    const head = el('thead', null, el('tr', null, columns.map((c, i) => {
      const th = el('th', { class: c.cls, scope: 'col' });
      if (!tree && c.sortable !== false) {
        const b = el('button', { type: 'button', class: 'th-sort', text: t(c.label) });
        b.addEventListener('click', () => { sort = sort && sort.i === i ? { i, dir: -sort.dir } : { i, dir: 1 }; draw(); });
        th.append(b);
      } else th.textContent = t(c.label);
      return th;
    })));
    table.append(head, tbody);

    function draw(focus = false) {
      head.querySelectorAll('th').forEach((th, i) => {
        if (sort && sort.i === i) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending'); else th.removeAttribute('aria-sort');
      });
      const vis = visibleRows();
      if (!vis.length) { tbody.replaceChildren(el('tr', null, el('td', { colspan: String(columns.length), class: 'muted empty', text: t(emptyKey) }))); return; }
      if (!vis.some((r) => r.id === selectedId)) selectedId = vis[0].id;
      tbody.replaceChildren(...vis.map((r) => {
        const tr = el('tr', {
          tabindex: r.id === selectedId ? '0' : '-1', 'data-id': String(r.id), 'aria-selected': String(r.id === selectedId),
          class: [r.isActive === false ? 'inactive' : '', r.match ? 'match' : ''].join(' ').trim() || null,
          ...(tree ? { 'aria-level': String(r.level), 'aria-expanded': r.hasChildren ? String(!collapsed.has(r.id)) : null } : {}),
        }, columns.map((c, i) => {
          const td = el('td', { class: c.cls }, c.render(r));
          if (tree && i === 0) {
            td.classList.add('tree-cell');
            td.style.setProperty('--lvl', String(r.level - 1));
            const tg = el('button', { type: 'button', class: 'tree-toggle', tabindex: '-1', 'aria-label': t(collapsed.has(r.id) ? 'grid.expand' : 'grid.collapse'),
              text: r.hasChildren ? (collapsed.has(r.id) ? '▸' : '▾') : '', disabled: !r.hasChildren });
            tg.addEventListener('click', (e) => { e.stopPropagation(); toggle(r.id); });
            td.prepend(tg);
          }
          return td;
        }));
        tr.addEventListener('click', () => select(r.id));
        tr.addEventListener('dblclick', () => onOpen && onOpen(r));
        return tr;
      }));
      if (focus) { const f = tbody.querySelector('tr[tabindex="0"]'); if (f) f.focus(); }
    }
    function select(id, focus = true) { selectedId = id; draw(focus); }
    function toggle(id, force) {
      const want = force ?? !collapsed.has(id);
      if (want) collapsed.add(id); else collapsed.delete(id);
      draw(true);
    }

    tbody.addEventListener('keydown', (e) => {
      const vis = visibleRows();
      const i = vis.findIndex((r) => r.id === selectedId);
      if (i < 0) return;
      const r = vis[i];
      const rtl = document.documentElement.dir === 'rtl';
      const go = (j) => { e.preventDefault(); select(vis[Math.max(0, Math.min(vis.length - 1, j))].id); };
      switch (e.key) {
        case 'ArrowDown': go(i + 1); break;
        case 'ArrowUp': go(i - 1); break;
        case 'Home': go(0); break;
        case 'End': go(vis.length - 1); break;
        case 'PageDown': go(i + 10); break;
        case 'PageUp': go(i - 10); break;
        case 'ArrowRight': case 'ArrowLeft': {
          if (!tree) return;
          const open = (e.key === 'ArrowLeft') === rtl;            // في RTL السهم الأيسر يفتح
          e.preventDefault();
          if (open && r.hasChildren && collapsed.has(r.id)) toggle(r.id, false);
          else if (!open && r.hasChildren && !collapsed.has(r.id)) toggle(r.id, true);
          else if (!open && r.parentId != null && vis.some((x) => x.id === r.parentId)) select(r.parentId);
          break;
        }
        case 'Enter': e.preventDefault(); if (onOpen) onOpen(r); break;
        case 'F2': e.preventDefault(); if (canEdit && onEdit) onEdit(r); break;
        default:
      }
    });

    if (caption) table.append(el('caption', { class: 'sr-only', text: caption }));
    draw();
    return {
      node: wrap,
      selected: () => rows.find((r) => r.id === selectedId) || null,
      focus: () => { const f = tbody.querySelector('tr[tabindex="0"]'); if (f) f.focus(); },
      select: (id) => select(id, true),
    };
  }

  return { create };
})();

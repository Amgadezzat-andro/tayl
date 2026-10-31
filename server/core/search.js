'use strict';

/**
 * بحث موحد بالكود والاسم العربي والإنجليزي، جزئي، ومتسامح مع اختلافات الكتابة العربية:
 * أ/إ/آ/ٱ → ا، ى → ي، ة → ه، ؤ → و، ئ → ي، حذف التشكيل والتطويل، الأرقام العربية-الهندية → لاتينية،
 * وحروف لاتينية صغيرة. نفس الدالة تُسجَّل في SQLite (tayl_norm) فيطابق البحث في القاعدة البحث في الكود.
 */
function normalize(s) {
  return String(s ?? '').normalize('NFKC').toLowerCase()
    .replace(/[ً-ٰٟـ]/g, '')
    .replace(/[أإآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ة/g, 'ه').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[٠-٩]/g, (d) => String(d.charCodeAt(0) - 0x660))
    .replace(/[۰-۹]/g, (d) => String(d.charCodeAt(0) - 0x6f0))
    .replace(/\s+/g, ' ').trim();
}

function registerSearchSql(db) {
  db.function('tayl_norm', { deterministic: true }, (s) => (s == null ? null : normalize(s)));
}

/**
 * شرط SQL للبحث الجزئي في أعمدة. الأعمدة أسماء ثابتة من الكود (لا من المستخدم).
 * يعيد { sql, params, rank } — rank يقدّم المطابقة التامة للكود ثم بداية الكود.
 */
function searchWhere(cols, q, codeCol = 'code') {
  const n = normalize(q);
  // NULL وليس 0: «ORDER BY 0» في SQLite تعني رقم عمود
  if (!n) return { sql: '1 = 1', params: [], rank: { sql: 'NULL', params: [] } };
  const like = '%' + n.replace(/[\\%_]/g, '\\$&') + '%';
  const prefix = n.replace(/[\\%_]/g, '\\$&') + '%';
  return {
    sql: '(' + cols.map((c) => `tayl_norm(${c}) LIKE ? ESCAPE '\\'`).join(' OR ') + ')',
    params: cols.map(() => like),
    rank: { sql: `CASE WHEN tayl_norm(${codeCol}) = ? THEN 0 WHEN tayl_norm(${codeCol}) LIKE ? ESCAPE '\\' THEN 1 ELSE 2 END`, params: [n, prefix] },
  };
}

module.exports = { normalize, registerSearchSql, searchWhere };

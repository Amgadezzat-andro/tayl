'use strict';
const fs = require('node:fs');
const path = require('node:path');

/** ترجمات الخادم من نفس ملفات الواجهة (لعناوين ملفات Excel والطباعة) — مصدر واحد للنصوص. */
function loadLocales(publicDir) {
  const data = {};
  for (const l of ['ar', 'en']) {
    try { data[l] = JSON.parse(fs.readFileSync(path.join(publicDir, 'locales', l + '.json'), 'utf8')); } catch { data[l] = {}; }
  }
  const lang = (l) => (l === 'en' ? 'en' : 'ar');
  return { lang, t: (l, k) => data[lang(l)][k] || data.ar[k] || k };
}

module.exports = { loadLocales };

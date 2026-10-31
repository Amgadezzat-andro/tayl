'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const roadmap = require('../server/modules/system/roadmap');

const L = (n) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'public/locales', n + '.json'), 'utf8'));
const ar = L('ar'); const en = L('en');

test('i18n: مفاتيح العربية والإنجليزية متطابقة تمامًا وبلا قيم فارغة', () => {
  assert.deepEqual(Object.keys(ar).sort(), Object.keys(en).sort());
  for (const [k, v] of [...Object.entries(ar), ...Object.entries(en)]) assert.ok(v && v.trim(), `قيمة فارغة: ${k}`);
});
test('i18n: كل مجموعة في خريطة الوحدات لها ترجمة، وكل وحدة باللغتين', () => {
  for (const r of roadmap) {
    assert.ok(ar['group.' + r.group] && en['group.' + r.group], `مجموعة بلا ترجمة: ${r.group}`);
    assert.ok(r.ar && r.en, r.id);
  }
  assert.equal(new Set(roadmap.map((r) => r.id)).size, roadmap.length);
});
test('ui: كل data-i18n في index.html له مفتاح، ولا style مضمّن (متوافق مع CSP)', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'public/index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n="([^"]+)"/g)) assert.ok(ar[m[1]] && en[m[1]], `مفتاح ناقص: ${m[1]}`);
  assert.ok(!/\sstyle=/.test(html));
  assert.ok(!/<script(?![^>]*src=)[^>]*>/.test(html), 'سكربت مضمّن يخالف CSP');
  assert.ok(html.includes('tayl-logo-official.jfif'));
  assert.ok(html.includes('01123401333'));
});

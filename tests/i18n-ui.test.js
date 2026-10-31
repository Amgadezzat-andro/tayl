'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { KINDS, ROUNDING } = require('../server/core/decimal');
const { DEFS } = require('../server/modules/company-setup/settings');
const { ACTIONS } = require('../server/core/permissions');
const { startApp } = require('./helpers');

const ROOT = path.join(__dirname, '..');
const L = (n) => JSON.parse(fs.readFileSync(path.join(ROOT, 'public/locales', n + '.json'), 'utf8'));
const ar = L('ar'); const en = L('en');
const both = (k) => assert.ok(ar[k] && en[k], `مفتاح ترجمة ناقص: ${k}`);

function files(dir, ext) {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? files(path.join(dir, d.name), ext) : d.name.endsWith(ext) ? [path.join(dir, d.name)] : []));
}
const jsFiles = files(path.join(ROOT, 'public/js'), '.js');
const serverFiles = files(path.join(ROOT, 'server'), '.js');
const serverSrc = serverFiles.map((f) => fs.readFileSync(f, 'utf8')).join('\n');

test('i18n-ui: كل مفتاح ترجمة حرفي مستخدم في الواجهة موجود باللغتين', () => {
  const NS = /^(app|support|lang|greeting|status|group|common|setup|auth|session|nav|dash|company|branch|user|role|perm|settings|precision|kind|rounding|audit|account|err|val|currency|accClass|nature|cc|treasury|fiscal|period|pt|pm|unit|combo|grid|keys|import|master)\./;
  let n = 0;
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8');
    for (const m of src.matchAll(/'([a-z]+\.[A-Za-z0-9_.]+)'/g)) {
      const key = m[1];
      if (!NS.test(key) || key.endsWith('.')) continue;
      // صلاحيات تُمرَّر لـ app.can وليست مفاتيح ترجمة
      if (/^(company|branches|users|roles|settings|precision|audit|accounts|treasury|currencies|units)\.(view|create|update|delete|disable|print|export|import|manage_rates|view_sensitive)$/.test(key) && !ar[key]) continue;
      both(key); n++;
    }
  }
  assert.ok(n > 150, `عدد المفاتيح المفحوصة قليل: ${n}`);
});

test('i18n-ui: لكل رمز خطأ من الخادم ترجمة، ولكل رمز خطأ حقل ترجمة', () => {
  for (const m of serverSrc.matchAll(/HttpError\(\d+, '([A-Z_]+)'/g)) if (m[1] !== 'DECIMAL_') both('err.' + m[1]);
  for (const m of serverSrc.matchAll(/DecimalError\('([A-Z_]+)'/g)) both('err.DECIMAL_' + m[1]);
  const fieldCodes = new Set();
  for (const m of serverSrc.matchAll(/fail\(k, '([A-Z_]+)'\)|fields: \{ [\w.]+: '([A-Z_]+)' \}|\{ \[field\]: p \}|return '([A-Z_]+)';|errs\.push\('([A-Z_]+)'\)/g)) {
    const c = m[1] || m[2] || m[3] || m[4]; if (c) fieldCodes.add(c);
  }
  assert.ok(fieldCodes.size >= 15);
  for (const c of fieldCodes) both('val.' + c);
  both('err.NETWORK'); both('err.INTERNAL'); both('err.generic'); both('val.PASSWORD_MISMATCH');
});

test('i18n-ui: لكل عملية تدقيق، وصلاحية، ونوع قيمة، وقاعدة تقريب، وإعداد — ترجمة', async (t) => {
  for (const m of serverSrc.matchAll(/action: (?:active \? |accessChanged \? )?'([a-z_.]+)'(?: : '([a-z_.]+)')?/g)) { both('audit.action.' + m[1]); if (m[2]) both('audit.action.' + m[2]); }
  for (const a of ACTIONS) both('perm.act.' + a);
  for (const k of Object.keys(KINDS)) both('kind.' + k);
  for (const r of Object.keys(ROUNDING)) both('rounding.' + r);
  for (const s of Object.keys(DEFS)) both('settings.' + s);
  const s = await startApp(); t.after(s.stop);
  for (const r of s.app.services.permissions.list()) {
    both('perm.res.' + r.resource); both('perm.group.' + r.group);
    for (const a of r.special) both(`perm.special.${r.resource}.${a}`);
  }
  // [م2] أحداث التدقيق المولّدة من خدمة البيانات الرئيسية والاستيراد/التصدير
  for (const e of ['account', 'account_type', 'cost_center', 'cost_center_type', 'currency', 'treasury', 'payment_term', 'payment_method', 'unit']) {
    for (const o of ['created', 'updated', 'activated', 'deactivated', 'deleted']) both(`audit.action.${e}.${o}`);
  }
  for (const r of ['accounts', 'cost_centers', 'treasury', 'currencies', 'payment_terms', 'payment_methods', 'units', 'fiscal_years']) both(`audit.action.${r}.exported`);
  const cur = /TAYL\.CURRENCIES = \[([^\]]+)\]/.exec(fs.readFileSync(path.join(ROOT, 'public/js/views/auth.js'), 'utf8'))[1].match(/[A-Z]{3}/g);
  for (const c of cur) both('currency.' + c);
});

test('i18n-ui: لا نصوص عربية ثابتة في JavaScript، ولا innerHTML ولا eval', () => {
  for (const f of jsFiles) {
    const src = fs.readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');   // التعليقات مسموحة
    assert.ok(!/[؀-ۿ]/.test(src), `نص عربي ثابت في ${path.relative(ROOT, f)}`);
    assert.ok(!/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function/.test(src), `استخدام غير آمن في ${path.relative(ROOT, f)}`);
    assert.ok(!/localStorage\.setItem\((?!KEY)/.test(src), `تخزين محلي غير مسموح في ${path.relative(ROOT, f)}`);
  }
});

test('i18n-ui: index.html يحمّل كل ملفات الواجهة، ولا يوجد ملف JS غير مستخدم', () => {
  const html = fs.readFileSync(path.join(ROOT, 'public/index.html'), 'utf8');
  for (const f of jsFiles) assert.ok(html.includes('/' + path.relative(path.join(ROOT, 'public'), f).split(path.sep).join('/')), `غير مُحمَّل: ${f}`);
  assert.equal((html.match(/tayl-logo-official\.jfif/g) || []).length, 2);   // شاشة الدخول + الشريط الجانبي
});

test('i18n-ui: كل الملفات الثابتة تُخدم بنوعها الصحيح وتحت CSP', async (t) => {
  const s = await startApp(); t.after(s.stop);
  for (const f of [...jsFiles, path.join(ROOT, 'public/css/app.css'), path.join(ROOT, 'public/locales/ar.json')]) {
    const rel = '/' + path.relative(path.join(ROOT, 'public'), f).split(path.sep).join('/');
    const r = await fetch(s.base + rel);
    assert.equal(r.status, 200, rel);
    assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  }
});

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');
const { readSheet, writeSheet } = require('../server/core/xlsx');
const { readZip, writeZip } = require('../server/core/xlsx/zip');

test('xlsx: كتابة ثم قراءة تحفظ النصوص العربية والرموز والقيم العشرية كما هي', () => {
  const rows = [['1101', 'الصندوق & <نقدية> "رئيسي"', '0.30000000000000004'], ['=1+1', '', '12345678901234567890.12345678'], ['A-01', 'سطر\tمع tab', '-0.00000001']];
  const buf = writeSheet({ sheetName: 'دليل', header: ['code', 'name', 'amount'], rows, rtl: true });
  const back = readSheet(buf);
  assert.deepEqual(back[0], ['code', 'name', 'amount']);
  assert.deepEqual(back.slice(1), rows.map((r) => r.map((c) => c.trim())));
  assert.equal(back[2][0], '=1+1');                                  // نص وليس معادلة
});

test('xlsx: قراءة ملف أنشأه برنامج آخر (openpyxl): نصوص مشتركة، نص منسق، أرقام، منطقي، صفوف فارغة', () => {
  const rows = readSheet(fs.readFileSync(path.join(__dirname, 'fixtures/openpyxl-accounts.xlsx')));
  assert.deepEqual(rows[0], ['كود الحساب', 'الاسم العربي', 'الاسم الإنجليزي', 'كود الأب', 'التصنيف', 'تجميعي']);
  assert.deepEqual(rows[1], ['1', 'الأصول', 'Assets', '', 'الأصول', 'نعم']);   // الرقم 1 يُقرأ نصًا "1"
  assert.deepEqual(rows[2].slice(0, 6), ['11', 'الأصول المتداولة', 'Current assets', '1', '', 'TRUE']);
  assert.equal(rows[4][1], 'البنك الأهلي');                                  // نص منسق من جزأين
  assert.deepEqual(rows[5], []);
  assert.equal(rows[6][4], 'liability');
});

test('xlsx: قراءة نص مشترك مع كيانات XML وخلايا بلا مرجع عمود وبادئات مساحة أسماء', () => {
  const sheet = '<?xml version="1.0"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><x:sheetData>'
    + '<x:row r="1"><x:c t="s"><x:v>0</x:v></x:c><x:c t="s"><x:v>1</x:v></x:c></x:row>'
    + '<x:row r="3"><x:c r="C3" t="inlineStr"><x:is><x:t>&#x627;&amp;b</x:t></x:is></x:c></x:row></x:sheetData></x:worksheet>';
  const sst = '<sst><si><t xml:space="preserve"> a&lt;b </t></si><si><r><t>كو</t></r><r><t>د</t></r><rPh><t>ignored</t></rPh></si></sst>';
  const buf = writeZip([{ name: 'xl/worksheets/sheet1.xml', data: sheet }, { name: 'xl/sharedStrings.xml', data: sst }]);
  assert.deepEqual(readSheet(buf), [['a<b', 'كود'], [], ['', '', 'ا&b']]);
});

test('xlsx: يرفض الملفات غير الصالحة والمشفرة والضخمة بعد فك الضغط (zip bomb)', () => {
  assert.throws(() => readSheet(Buffer.from('not a zip at all, just text')), (e) => e.code === 'BAD_XLSX');
  assert.throws(() => readSheet(writeZip([{ name: 'other.txt', data: 'x' }])), (e) => e.code === 'BAD_XLSX');
  // ملف داخلي يعلن حجمًا صغيرًا لكنه يتمدد لأكثر من الحد
  const big = Buffer.alloc(40 * 1024 * 1024, 0x41);
  const comp = zlib.deflateRawSync(big);
  const z = writeZip([{ name: 'xl/worksheets/sheet1.xml', data: 'x' }]);
  const zip = Buffer.from(z);
  assert.ok(readZip(zip).read('xl/worksheets/sheet1.xml'));
  // نبني ZIP يدويًا بحجم معلن كبير
  const forged = writeZip([{ name: 'xl/worksheets/sheet1.xml', data: big.subarray(0, 10) }]);
  const cdAt = forged.lastIndexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  forged.writeUInt32LE(40 * 1024 * 1024, cdAt + 24);
  assert.throws(() => readZip(forged), (e) => e.code === 'BAD_XLSX');
  assert.ok(comp.length < big.length);
});

test('xlsx: الملف الناتج حتمي وصالح الهيكل (أنواع المحتوى، الورقة، الأنماط، اتجاه RTL)', () => {
  const a = writeSheet({ header: ['h'], rows: [['1']], rtl: true });
  const b = writeSheet({ header: ['h'], rows: [['1']], rtl: true });
  assert.ok(a.equals(b));
  const z = readZip(a);
  assert.deepEqual(z.names().sort(), ['[Content_Types].xml', '_rels/.rels', 'xl/_rels/workbook.xml.rels', 'xl/styles.xml', 'xl/workbook.xml', 'xl/worksheets/sheet1.xml']);
  assert.match(z.read('xl/worksheets/sheet1.xml').toString(), /rightToLeft="1"/);
});

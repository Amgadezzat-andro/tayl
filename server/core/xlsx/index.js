'use strict';
const { readZip, writeZip, ZipError } = require('./zip');

/**
 * قراءة وكتابة Excel (.xlsx) للبيانات الرئيسية — بلا مكتبة خارجية.
 * سبب عدم استخدام مكتبة: حزمة xlsx على npm (0.18.5) متوقفة وعليها ثغرات معلنة، و exceljs تجلب تبعيات كثيرة،
 * بينما المطلوب ورقة واحدة نصوص/أرقام. الملف الناتج يُختبر بقراءته عبر openpyxl.
 *
 * القيم تُقرأ وتُكتب **نصوصًا كما هي** (لا تحويل إلى Number): الكود 1101 يبقى "1101"،
 * والقيم العشرية تُصدَّر نصًا فلا تفقد دقتها في Excel.
 */
const MAX_ROWS = 20000;
const MAX_COLS = 60;

const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
function decodeXml(s) {
  return s.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos);/g, (m, e) => {
    if (e[0] === '#') {
      const cp = e[1] === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    }
    return ENT[e];
  });
}
// eslint-disable-next-line no-control-regex
const INVALID_XML = /[\u0000-\u0008\u000B\u000C\u000E-\u001F￾￿]/g;
const encodeXml = (s) => String(s).replace(INVALID_XML, '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const attrs = (s) => { const o = {}; for (const m of s.matchAll(/([\w:]+)\s*=\s*"([^"]*)"/g)) o[m[1].replace(/^\w+:/, '')] = decodeXml(m[2]); return o; };
/** نصوص كل عناصر <t> داخل جزء XML (يدعم النص المنسق r/t، ويتجاهل rPh الصوتي). */
function texts(xml) {
  const clean = xml.replace(/<(?:\w+:)?rPh\b[\s\S]*?<\/(?:\w+:)?rPh>/g, '');
  let out = '';
  for (const m of clean.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>|<(?:\w+:)?t(?:\s[^>]*)?\/>/g)) out += m[1] ? decodeXml(m[1]) : '';
  return out;
}
function colIndex(ref) {
  const m = /^([A-Z]{1,3})/.exec(ref || '');
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
const colName = (i) => { let s = ''; i += 1; while (i > 0) { const r = (i - 1) % 26; s = String.fromCharCode(65 + r) + s; i = Math.floor((i - 1) / 26); } return s; };

/**
 * يقرأ أول ورقة ويعيد صفوفًا من نصوص: [['code','name'], ['1101','الصندوق'], ...].
 * الخلايا الفارغة = ''. الأرقام تُعاد كنصها المخزن في الملف كما هو.
 */
function readSheet(buffer) {
  const zip = readZip(buffer);
  const read = (n) => { const b = zip.read(n); return b ? b.toString('utf8') : null; };

  // الورقة الأولى عبر workbook.xml و rels، مع بديل افتراضي
  let sheetPath = 'xl/worksheets/sheet1.xml';
  const wb = read('xl/workbook.xml');
  const rels = read('xl/_rels/workbook.xml.rels');
  if (wb && rels) {
    const first = /<(?:\w+:)?sheet\b([^>]*)\/?>/.exec(wb);
    const rid = first && (attrs(first[1]).id);
    if (rid) {
      for (const m of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]*)\/?>/g)) {
        const a = attrs(m[1]);
        if (a.Id === rid && a.Target) { sheetPath = a.Target.startsWith('/') ? a.Target.slice(1) : 'xl/' + a.Target.replace(/^\.\//, ''); break; }
      }
    }
  }
  const sheet = read(sheetPath);
  if (sheet == null) throw new ZipError('لا توجد ورقة عمل في الملف');

  const shared = [];
  const sst = read('xl/sharedStrings.xml');
  if (sst) for (const m of sst.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>|<(?:\w+:)?si\b[^>]*\/>/g)) shared.push(m[1] ? texts(m[1]) : '');

  const rows = [];
  let rowNo = 0;
  for (const rm of sheet.matchAll(/<(?:\w+:)?row\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?row>)/g)) {
    const ra = attrs(rm[1]);
    rowNo = ra.r ? parseInt(ra.r, 10) : rowNo + 1;
    if (rowNo > MAX_ROWS + 1) throw new ZipError(`الملف يتجاوز ${MAX_ROWS} صفًا`);
    const cells = [];
    let colNo = -1;
    for (const cm of (rm[2] || '').matchAll(/<(?:\w+:)?c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/(?:\w+:)?c>)/g)) {
      const ca = attrs(cm[1]);
      colNo = ca.r ? colIndex(ca.r) : colNo + 1;
      if (colNo < 0 || colNo >= MAX_COLS) continue;
      const inner = cm[2] || '';
      const v = /<(?:\w+:)?v>([\s\S]*?)<\/(?:\w+:)?v>/.exec(inner);
      let val = '';
      if (ca.t === 's') val = v ? (shared[parseInt(v[1], 10)] ?? '') : '';
      else if (ca.t === 'inlineStr') val = texts(inner);
      else if (ca.t === 'b') val = v ? (v[1] === '1' ? 'TRUE' : 'FALSE') : '';
      else val = v ? decodeXml(v[1]) : '';                       // n / str / e: النص كما هو
      cells[colNo] = val;
    }
    const arr = Array.from({ length: cells.length }, (_, i) => (cells[i] ?? '').trim());
    rows[rowNo - 1] = arr;
  }
  return Array.from({ length: rows.length }, (_, i) => rows[i] || []);
}

/**
 * يكتب ورقة واحدة: header (عناوين) + rows (مصفوفات قيم). كل القيم نصوص (inlineStr) للحفاظ على الدقة.
 * rtl: اتجاه الورقة من اليمين لليسار (للعربية).
 */
function writeSheet({ sheetName = 'Sheet1', header, rows, rtl = false, widths }) {
  if (rows.length > MAX_ROWS) throw new Error('عدد الصفوف أكبر من الحد');
  const cols = header.length;
  const cell = (r, c, v, style) => {
    if (v === null || v === undefined || v === '') return '';
    return `<c r="${colName(c)}${r}" t="inlineStr"${style ? ` s="${style}"` : ''}><is><t xml:space="preserve">${encodeXml(v)}</t></is></c>`;
  };
  const sheetRows = [
    `<row r="1">${header.map((h, c) => cell(1, c, h, 1)).join('')}</row>`,
    ...rows.map((r, i) => `<row r="${i + 2}">${r.slice(0, cols).map((v, c) => cell(i + 2, c, v)).join('')}</row>`),
  ];
  const w = widths || header.map((h, c) => Math.min(60, Math.max(8, String(h).length + 2, ...rows.slice(0, 500).map((r) => String(r[c] ?? '').length + 2))));
  const safeName = String(sheetName).replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Sheet1';
  const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
  const rel = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
  const files = [
    { name: '[Content_Types].xml', data: '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/></Types>' },
    { name: '_rels/.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/officeDocument" Target="xl/workbook.xml"/></Relationships>` },
    { name: 'xl/workbook.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="${ns}" xmlns:r="${rel}"><sheets><sheet name="${encodeXml(safeName)}" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: 'xl/_rels/workbook.xml.rels', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${rel}/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="${rel}/styles" Target="styles.xml"/></Relationships>` },
    { name: 'xl/styles.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="${ns}"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>` },
    { name: 'xl/worksheets/sheet1.xml', data: `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="${ns}"><sheetViews><sheetView workbookViewId="0"${rtl ? ' rightToLeft="1"' : ''}><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><cols>${w.map((x, i) => `<col min="${i + 1}" max="${i + 1}" width="${x}" customWidth="1"/>`).join('')}</cols><sheetData>${sheetRows.join('')}</sheetData></worksheet>` },
  ];
  return writeZip(files);
}

/** إرسال ملف xlsx كتنزيل. */
function sendXlsx(res, filename, buffer) {
  res.writeHead(200, {
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Length': buffer.length,
    'Content-Disposition': `attachment; filename="${filename.replace(/[^\w.-]/g, '_')}"`,
    'Cache-Control': 'no-store',
  });
  res.end(buffer);
}

module.exports = { readSheet, writeSheet, sendXlsx, ZipError, MAX_ROWS };

'use strict';
const zlib = require('node:zlib');

/**
 * قارئ/كاتب ZIP مصغّر لملفات XLSX فقط (بدون تبعيات خارجية).
 * يدعم: التخزين (0) والضغط Deflate (8). يرفض: التشفير، ZIP64، والملفات الأكبر من الحدود (حماية من zip bomb).
 */
const LIMITS = Object.freeze({ maxEntries: 200, maxEntryBytes: 30 * 1024 * 1024, maxTotalBytes: 60 * 1024 * 1024 });

class ZipError extends Error {
  constructor(message) { super(message); this.name = 'ZipError'; this.code = 'BAD_XLSX'; }
}

function readZip(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 22) throw new ZipError('ملف غير صالح');
  // سجل نهاية الدليل المركزي (EOCD) في آخر 64KB
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) throw new ZipError('ليس ملف ZIP/XLSX');
  const count = buf.readUInt16LE(eocd + 10);
  const cdOffset = buf.readUInt32LE(eocd + 16);
  if (count > LIMITS.maxEntries) throw new ZipError('عدد ملفات داخلية كبير');
  if (cdOffset === 0xffffffff || count === 0xffff) throw new ZipError('ZIP64 غير مدعوم');

  const entries = new Map();
  let total = 0;
  let p = cdOffset;
  for (let n = 0; n < count; n++) {
    if (p + 46 > buf.length || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError('دليل ZIP تالف');
    const flags = buf.readUInt16LE(p + 8);
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extraLen = buf.readUInt16LE(p + 30);
    const commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (flags & 1) throw new ZipError('ملف مشفر غير مدعوم');
    if (usize > LIMITS.maxEntryBytes) throw new ZipError('ملف داخلي كبير جدًا');
    total += usize;
    if (total > LIMITS.maxTotalBytes) throw new ZipError('حجم الملف بعد فك الضغط كبير جدًا');
    entries.set(name, { method, csize, usize, local });
  }

  return {
    names: () => [...entries.keys()],
    has: (name) => entries.has(name),
    read(name) {
      const e = entries.get(name);
      if (!e) return null;
      if (e.local + 30 > buf.length || buf.readUInt32LE(e.local) !== 0x04034b50) throw new ZipError('ترويسة ملف داخلي تالفة');
      const start = e.local + 30 + buf.readUInt16LE(e.local + 26) + buf.readUInt16LE(e.local + 28);
      const data = buf.subarray(start, start + e.csize);
      if (e.method === 0) return data;
      if (e.method === 8) {
        try { return zlib.inflateRawSync(data, { maxOutputLength: LIMITS.maxEntryBytes }); } catch { throw new ZipError('تعذر فك ضغط ملف داخلي'); }
      }
      throw new ZipError('طريقة ضغط غير مدعومة');
    },
  };
}

/** يكتب ZIP من قائمة { name, data } (Deflate). */
function writeZip(files) {
  const locals = [];
  const central = [];
  let offset = 0;
  // تاريخ/وقت DOS ثابت (1980-01-01) — الملف الناتج حتمي لنفس المحتوى
  const dosTime = 0; const dosDate = (0 << 9) | (1 << 5) | 1;
  for (const f of files) {
    const name = Buffer.from(f.name, 'utf8');
    const raw = Buffer.isBuffer(f.data) ? f.data : Buffer.from(f.data, 'utf8');
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14);
    lh.writeUInt32LE(comp.length, 18); lh.writeUInt32LE(raw.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    locals.push(lh, name, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(comp.length, 20); ch.writeUInt32LE(raw.length, 24); ch.writeUInt16LE(name.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, name);
    offset += 30 + name.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}

module.exports = { readZip, writeZip, ZipError, LIMITS };

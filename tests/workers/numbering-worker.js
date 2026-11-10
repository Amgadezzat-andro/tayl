'use strict';
/* عامل تزامن: عملية مستقلة باتصالها الخاص؛ تصدر أرقامًا داخل معاملات BEGIN IMMEDIATE، و10% منها فشل متعمد بعد الإصدار. */
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const { openDatabase, inTransaction } = require(path.join(ROOT, 'server/core/db'));
const { createNumbering } = require(path.join(ROOT, 'server/modules/numbering/numbering'));
const { withRetrySync } = require('./retry');
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

const [dbFile, workerId, n, seriesId, branchId, fiscalYearId] = process.argv.slice(2).map((x, i) => (i ? Number(x) : x));
class Intentional extends Error {}

// الاتصال يُفتح قبل إشارة البدء حتى تبدأ العمليات كلها معًا فعلًا
const db = openDatabase(dbFile);                       // WAL + busy_timeout = 5000
const numbering = createNumbering(db);
process.once('message', () => {
  const out = { workerId, numbers: [], intentional: 0, busyRetries: 0, exhausted: 0, maxWaitMs: 0, unexpected: [] };
  for (let i = 0; i < n; i++) {
    try {
      const r = withRetrySync(() => inTransaction(db, () => {
        const x = numbering.issue({ seriesId, docType: 'journal', branchId, fiscalYearId, sourceId: workerId * 100000 + i, userId: 1 });
        sleepSync(1);                                    // عمل داخل المعاملة (مثل التحقق والأستاذ) والقفل ممسوك
        if (i % 10 === workerId % 10) throw new Intentional('rollback after issue');
        return x;
      }), out);
      sleepSync(i % 3);                                  // فاصل بين المعاملات كما بين طلبات المستخدمين
      out.numbers.push(r.number);
    } catch (e) {
      if (e instanceof Intentional) out.intentional++;
      else out.unexpected.push(`${e.code || ''} ${e.message}`);
    }
  }
  db.close();
  process.send(out, () => process.exit(0));
});
process.send({ ready: true });

'use strict';
/* عامل تزامن: نسخة برنامج كاملة مستقلة (عملية منفصلة) على نفس ملف القاعدة؛ تنشئ وترحّل قيودًا عبر HTTP بجلسة مستخدمها. */
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const { loadConfig } = require(path.join(ROOT, 'server/core/config'));
const { createApp } = require(path.join(ROOT, 'server/app'));
const { createLogger } = require(path.join(ROOT, 'server/core/logger'));
const { withRetry } = require('./retry');

const [dataDir, workerId, n, branchId, cashId, salesId, cookie, csrf] = process.argv.slice(2);
const busy = (r) => r.status === 503 && r.body && r.body.error && r.body.error.code === 'DB_BUSY';

process.once('message', async () => {
  const app = await createApp({ config: loadConfig({ dataDir, port: 0 }), logger: createLogger({}) });
  const { port } = await app.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const out = { workerId: Number(workerId), numbers: [], busyRetries: 0, exhausted: 0, maxWaitMs: 0, unexpected: [] };
  for (let i = 0; i < Number(n); i++) {
    const amount = `${Number(workerId) * 1000 + i + 1}.25`;
    const lines = [{ accountId: Number(cashId), debit: amount }, { accountId: Number(salesId), credit: amount }];
    const d = await withRetry(() => call('POST', '/api/journal', { branchId: Number(branchId), entryDate: '2026-03-15', description: `w${workerId}-${i}`, lines }), out, busy);
    if (d.status !== 200) { out.unexpected.push(`draft ${d.status} ${JSON.stringify(d.body)}`); continue; }
    const p = await withRetry(() => call('POST', `/api/journal/${d.body.id}/post`, {}), out, busy);
    if (p.status !== 200) { out.unexpected.push(`post ${p.status} ${JSON.stringify(p.body)}`); continue; }
    out.numbers.push(p.body.number);
  }
  await app.close();
  process.send(out, () => process.exit(0));
});
process.send({ ready: true });

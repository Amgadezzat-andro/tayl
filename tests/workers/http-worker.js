'use strict';
/*
 * عامل تزامن عام: نسخة برنامج كاملة مستقلة (عملية منفصلة) على نفس ملف القاعدة، تنفذ قائمة طلبات HTTP بجلسة معطاة.
 * mode = 'lock': يقفل الفترات المعطاة بالترتيب، ويعيد المحاولة على PERIOD_LOCK_SEQUENCE حتى تُقفل سابقتها (بحد أقصى).
 * mode = 'reverse': يعكس القيد المعطى مرة واحدة.
 * سياسة SQLITE_BUSY (503 DB_BUSY) كما في retry.js.
 */
const path = require('node:path');
const ROOT = path.join(__dirname, '..', '..');
const { loadConfig } = require(path.join(ROOT, 'server/core/config'));
const { createApp } = require(path.join(ROOT, 'server/app'));
const { createLogger } = require(path.join(ROOT, 'server/core/logger'));
const { withRetry } = require('./retry');

const [dataDir, mode, payload, cookie, csrf] = process.argv.slice(2);
const busy = (r) => r.status === 503 && r.body && r.body.error && r.body.error.code === 'DB_BUSY';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const app = await createApp({ config: loadConfig({ dataDir, port: 0 }), logger: createLogger({}) });
  const { port } = await app.listen();
  const call = async (method, p, body) => {
    const r = await fetch(`http://127.0.0.1:${port}${p}`, { method, headers: { cookie, 'x-csrf-token': csrf, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: r.status, body: await r.json() };
  };
  const out = { results: [], busyRetries: 0, exhausted: 0, maxWaitMs: 0, unexpected: [], sequenceRejections: 0 };
  process.send({ ready: true });
  await new Promise((r) => process.once('message', r));
  if (mode === 'lock') {
    for (const id of JSON.parse(payload)) {
      for (let attempt = 0; ; attempt++) {
        const r = await withRetry(() => call('POST', `/api/fiscal-periods/${id}/lock`, { reason: 'قفل متزامن' }), out, busy);
        if (r.status === 200) { out.results.push(id); break; }
        if (r.body.error && r.body.error.code === 'PERIOD_LOCK_SEQUENCE' && attempt < 2000) { out.sequenceRejections++; await sleep(2); continue; }
        out.unexpected.push(`${id}: ${r.status} ${JSON.stringify(r.body)}`); break;
      }
    }
  } else if (mode === 'reverse') {
    const r = await withRetry(() => call('POST', `/api/journal/${payload}/reverse`, { reason: 'عكس متزامن' }), out, busy);
    out.results.push({ status: r.status, code: r.body.error ? r.body.error.code : null, number: r.body.number || null });
  }
  await app.close();
  process.send(out, () => process.exit(0));
})().catch((e) => { process.send({ fatal: String(e && e.stack || e) }, () => process.exit(1)); });

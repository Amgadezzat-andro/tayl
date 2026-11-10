'use strict';
/**
 * سياسة SQLITE_BUSY في اختبارات التزامن (المقترح، القسم 8.2):
 * busy_timeout = 5000 داخل SQLite أولًا؛ إن انتهى وظهر SQLITE_BUSY: حتى 5 إعادات بانتظار 50، 100، 200، 400، 800 ملّي ثانية (+ عشوائي ≤ 25).
 * استنفاد الإعادات يُعاد كخطأ صريح (لا يُتجاهل)، وأي خطأ آخر يُعاد كما هو.
 */
const BACKOFF = [50, 100, 200, 400, 800];
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const jitter = () => Math.floor(Math.random() * 26);

function withRetrySync(fn, stats, isBusy = (e) => e && e.code === 'SQLITE_BUSY') {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    try { return fn(); } catch (e) {
      stats.maxWaitMs = Math.max(stats.maxWaitMs, Date.now() - t0);
      if (!isBusy(e)) throw e;
      if (attempt >= BACKOFF.length) { stats.exhausted++; throw e; }
      stats.busyRetries++;
      sleepSync(BACKOFF[attempt] + jitter());
    }
  }
}
async function withRetry(fn, stats, isBusy) {
  for (let attempt = 0; ; attempt++) {
    const t0 = Date.now();
    const r = await fn();
    stats.maxWaitMs = Math.max(stats.maxWaitMs, Date.now() - t0);
    if (!isBusy(r)) return r;
    if (attempt >= BACKOFF.length) { stats.exhausted++; return r; }
    stats.busyRetries++;
    await sleep(BACKOFF[attempt] + jitter());
  }
}
module.exports = { withRetrySync, withRetry, BACKOFF };

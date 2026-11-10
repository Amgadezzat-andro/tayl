'use strict';
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { HttpError, DecimalError } = require('./errors');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.jfif': 'image/jpeg', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
};

const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data:; style-src 'self'; script-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

function sendJson(res, status, body, extra = {}) {
  const buf = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': buf.length, 'Cache-Control': 'no-store', ...extra });
  res.end(buf);
}

const UNSAFE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

/**
 * طلب يغيّر الحالة يجب أن يأتي من نفس الأصل: يُرفض أي Origin مختلف عن Host، وأي طلب يعلن المتصفح أنه cross-site.
 * (طبقة دفاع إضافية فوق SameSite=Strict ورمز CSRF الخاص بالجلسة.)
 */
function assertSameOrigin(req) {
  const site = req.headers['sec-fetch-site'];
  if (site && site !== 'same-origin' && site !== 'none') throw new HttpError(403, 'CROSS_ORIGIN', 'طلب من أصل مختلف مرفوض');
  const origin = req.headers.origin;
  if (origin === undefined) return;
  let host = null;
  try { host = new URL(origin).host.toLowerCase(); } catch { /* Origin: null أو تالف */ }
  if (!host || host !== String(req.headers.host || '').toLowerCase()) throw new HttpError(403, 'CROSS_ORIGIN', 'طلب من أصل مختلف مرفوض');
}

function readJsonBody(req, max) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0; let dead = false;
    req.on('data', (c) => {
      if (dead) return;
      size += c.length;
      if (size > max) { dead = true; reject(new HttpError(413, 'BODY_TOO_LARGE', 'حجم الطلب أكبر من المسموح')); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (dead) return;
      if (!size) return resolve(undefined);
      // نماذج HTML لا تستطيع إرسال application/json، فاشتراطه يغلق باب CSRF عبر النماذج أيضًا.
      if (!/^application\/json(;|$)/i.test(String(req.headers['content-type'] || ''))) { reject(new HttpError(415, 'UNSUPPORTED_MEDIA_TYPE', 'نوع المحتوى يجب أن يكون application/json')); return; }
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(new HttpError(400, 'BAD_JSON', 'محتوى الطلب ليس JSON صالحًا')); }
    });
    req.on('error', reject);
  });
}

function serveStatic(req, res, publicDir, pathname) {
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'الطريقة غير مسموحة');
  let rel;
  try { rel = decodeURIComponent(pathname); } catch { throw new HttpError(400, 'BAD_PATH', 'مسار غير صالح'); }
  if (rel.includes('\0')) throw new HttpError(400, 'BAD_PATH', 'مسار غير صالح');
  if (rel === '/' || rel === '') rel = '/index.html';
  const root = path.resolve(publicDir);
  const file = path.resolve(root, '.' + rel);
  if (file !== root && !file.startsWith(root + path.sep)) throw new HttpError(403, 'FORBIDDEN', 'مسار ممنوع');   // منع Path Traversal
  let st;
  try { st = fs.statSync(file); } catch { throw new HttpError(404, 'NOT_FOUND', 'غير موجود'); }
  if (!st.isFile()) throw new HttpError(404, 'NOT_FOUND', 'غير موجود');
  const type = MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
  res.writeHead(200, { 'Content-Type': type, 'Content-Length': st.size, 'Cache-Control': 'no-cache' });
  if (req.method === 'HEAD') return res.end();
  fs.createReadStream(file).pipe(res);
}

function createHttpServer({ router, config, logger, services }) {
  const port0 = () => (server.address() && server.address().port) || config.port;
  const allowedHosts = () => {
    if (config.allowedHosts) return config.allowedHosts;
    if (config.host === '127.0.0.1' || config.host === 'localhost') {
      const p = port0();
      return [`127.0.0.1:${p}`, `localhost:${p}`, `[::1]:${p}`];
    }
    return null;   // مربوط بالشبكة: التحقق من الهوست يُفعَّل بإعداد allowedHosts
  };

  const server = http.createServer(async (req, res) => {
    const requestId = crypto.randomBytes(6).toString('hex');
    const started = Date.now();
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    res.setHeader('X-Request-Id', requestId);
    try {
      // حماية DNS-rebinding عند الربط على الجهاز المحلي
      const hosts = allowedHosts();
      if (hosts && !hosts.includes(String(req.headers.host || '').toLowerCase())) throw new HttpError(403, 'BAD_HOST', 'Host غير مسموح');

      const url = new URL(req.url, 'http://x');
      if (!url.pathname.startsWith('/api/')) return serveStatic(req, res, config.publicDir, url.pathname);

      const m = router.match(req.method, url.pathname);
      if (!m) throw new HttpError(404, 'NOT_FOUND', 'المسار غير موجود');
      const { route, params } = m;

      if (UNSAFE.has(req.method)) assertSameOrigin(req);

      const ctx = {
        req, res, requestId, params, query: Object.fromEntries(url.searchParams), services, user: null,
        ip: req.socket.remoteAddress || '',
        body: () => readJsonBody(req, route.bodyLimit || config.maxBodyBytes),
      };
      // الصلاحيات تُفرض هنا على الخادم (fail-closed):
      //  - مسار لا يعلن public/auth/permission => مرفوض دائمًا.
      //  - مسار محمي بلا مُصرِّح مسجَّل => مرفوض.
      if (!route.public) {
        if (!route.auth) throw new HttpError(403, 'ROUTE_NOT_DECLARED', 'المسار لا يعلن متطلبات الوصول؛ مرفوض');
        if (!services.authorizer) throw new HttpError(403, 'AUTHZ_NOT_CONFIGURED', 'نظام الصلاحيات غير مفعّل بعد؛ العملية مرفوضة');
        await services.authorizer(ctx, route.permission);
      }
      const result = await route.handler(ctx);
      if (!res.writableEnded && !res.headersSent) sendJson(res, 200, result === undefined ? { ok: true } : result);
    } catch (err) {
      // قيمة عشرية غير صالحة من المستخدم = خطأ إدخال (400) وليس خطأ خادم.
      // [م3] انتهاء انتظار قفل SQLite (busy_timeout) = 503 قابل لإعادة المحاولة، لا خطأ داخلي مبهم؛ المعاملة أُلغيت كاملة.
      const e = err instanceof DecimalError ? new HttpError(400, 'DECIMAL_' + err.code, err.message)
        : err && err.code === 'SQLITE_BUSY' ? new HttpError(503, 'DB_BUSY', 'قاعدة البيانات مشغولة مؤقتًا؛ أعد المحاولة')
          : err;
      const known = e instanceof HttpError;
      if (!known) logger.error('unhandled', { requestId, err: String(e && e.stack || e) });
      if (res.headersSent) return res.end();
      sendJson(res, known ? e.status : 500, {
        error: { code: known ? e.code : 'INTERNAL', message: known ? e.message : 'خطأ داخلي في الخادم', requestId, ...(known && e.details ? { details: e.details } : {}) },
      });
    } finally {
      logger.debug('req', { requestId, method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - started });
    }
  });
  return server;
}

module.exports = { createHttpServer, sendJson, assertSameOrigin };

'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { startApp } = require('./helpers');
const system = require('../server/modules/system');

const probe = {
  name: 'probe', dependsOn: ['system'],
  register(router) {
    router.get('/api/probe/open', { public: true }, () => ({ hi: 1 }));
    router.get('/api/probe/secure', { permission: 'probe.read' }, () => ({ secret: 1 }));
    // المرحلة 1: كل مسار يجب أن يعلن متطلبات الوصول صراحةً (fail-closed)، لذا أُضيف { public: true }.
    router.post('/api/probe/echo', { public: true }, async (ctx) => ({ got: await ctx.body() }));
    router.get('/api/probe/boom', { public: true }, () => { throw new Error('secret internal detail'); });
    router.get('/api/probe/item/:id', { public: true }, (ctx) => ({ id: ctx.params.id }));
  },
};

test('http: health و info و modules', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const h = await (await fetch(s.base + '/api/system/health')).json();
  assert.deepEqual(h, { status: 'ok', db: 'ok' });
  const info = await (await fetch(s.base + '/api/system/info')).json();
  assert.equal(info.name, 'TAYL');
  assert.equal(info.support, '01123401333');
  assert.equal(info.tagline, 'STRATEGIC ACCOUNTING | FINANCE | COST SOLUTIONS');
  assert.equal(info.migrations.length, 11);   // م1: 3 + م2: 7 + 0.3.1: 1
  const mods = await (await fetch(s.base + '/api/system/modules')).json();
  assert.equal(mods.roadmap.length, 25);       // م2 أضافت: العملات، شروط السداد، وحدات القياس
  assert.deepEqual(mods.roadmap.filter((r) => r.status === 'active').map((r) => r.id).sort(),
    ['chart-accounts', 'company-setup', 'cost-centers', 'currencies', 'fiscal-years', 'payment-terms', 'security', 'treasury', 'units']);
  assert.deepEqual(mods.loaded.map((m) => m.name), ['system', 'company-setup', 'security', 'fiscal-years', 'chart-accounts', 'cost-centers', 'currencies', 'treasury', 'payment-terms', 'units']);
});

test('http: ترويسات الأمان موجودة', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const r = await fetch(s.base + '/api/system/health');
  assert.match(r.headers.get('content-security-policy'), /default-src 'self'/);
  assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
  assert.equal(r.headers.get('cache-control'), 'no-store');
  assert.ok(r.headers.get('x-request-id'));
});

test('http: 404 و405 بصيغة خطأ موحدة', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const a = await fetch(s.base + '/api/nope'); assert.equal(a.status, 404);
  assert.equal((await a.json()).error.code, 'NOT_FOUND');
  const b = await fetch(s.base + '/api/system/health', { method: 'POST' }); assert.equal(b.status, 405);
  assert.deepEqual((await b.json()).error.details.allowed, ['GET']);
});

test('http: مسار يطلب صلاحية بلا مُصرِّح => 403 (يفشل مغلقًا)', async (t) => {
  const s = await startApp({ modules: [system, probe] }); t.after(s.stop);
  const r = await fetch(s.base + '/api/probe/secure');
  assert.equal(r.status, 403);
  assert.equal((await r.json()).error.code, 'AUTHZ_NOT_CONFIGURED');
});

test('http: مُصرِّح مسجّل يسمح/يمنع فعليًا على الخادم', async (t) => {
  const s = await startApp({ modules: [system, probe] }); t.after(s.stop);
  s.app.services.authorizer = async (ctx) => { if (ctx.req.headers['x-test-user'] !== 'admin') { const { HttpError } = require('../server/core/errors'); throw new HttpError(403, 'FORBIDDEN', 'ممنوع'); } };
  assert.equal((await fetch(s.base + '/api/probe/secure')).status, 403);
  const ok = await fetch(s.base + '/api/probe/secure', { headers: { 'x-test-user': 'admin' } });
  assert.equal(ok.status, 200);
});

test('http: خطأ داخلي لا يسرّب تفاصيل', async (t) => {
  const s = await startApp({ modules: [system, probe] }); t.after(s.stop);
  const r = await fetch(s.base + '/api/probe/boom');
  assert.equal(r.status, 500);
  const txt = await r.text();
  assert.ok(!txt.includes('secret internal detail'));
  assert.equal(JSON.parse(txt).error.code, 'INTERNAL');
});

test('http: JSON سليم/تالف، وحد حجم الطلب', async (t) => {
  const s = await startApp({ modules: [system, probe], config: { maxBodyBytes: 100 } }); t.after(s.stop);
  const post = (body) => fetch(s.base + '/api/probe/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body });
  assert.deepEqual(await (await post('{"a":1}')).json(), { got: { a: 1 } });
  const bad = await post('{oops'); assert.equal(bad.status, 400); assert.equal((await bad.json()).error.code, 'BAD_JSON');
  const big = await post(JSON.stringify({ x: 'y'.repeat(500) })); assert.equal(big.status, 413);
});

test('http: معاملات المسار تُفكّ ترميزها', async (t) => {
  const s = await startApp({ modules: [system, probe] }); t.after(s.stop);
  assert.deepEqual(await (await fetch(s.base + '/api/probe/item/%D8%B9%D9%85%D9%8A%D9%84')).json(), { id: 'عميل' });
});

test('static: الصفحة الرئيسية واللوجو كما هو (بايت ببايت) بنوع image/jpeg', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const idx = await fetch(s.base + '/');
  assert.equal(idx.status, 200); assert.match(idx.headers.get('content-type'), /text\/html/);
  const logo = await fetch(s.base + '/assets/logo/tayl-logo-official.jfif');
  assert.equal(logo.status, 200); assert.equal(logo.headers.get('content-type'), 'image/jpeg');
  const served = Buffer.from(await logo.arrayBuffer());
  const onDisk = fs.readFileSync(path.join(__dirname, '..', 'public/assets/logo/tayl-logo-official.jfif'));
  assert.ok(served.equals(onDisk));
});

test('static: منع Path Traversal (مشفّر وغير مشفّر) وملفات غير موجودة', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const raw = (p) => new Promise((resolve) => {
    const c = net.connect(s.app.server.address().port, '127.0.0.1');
    let d = ''; c.on('data', (x) => { d += x; }); c.on('end', () => resolve(d));
    c.write(`GET ${p} HTTP/1.1\r\nHost: 127.0.0.1:${s.app.server.address().port}\r\nConnection: close\r\n\r\n`);
  });
  for (const p of ['/../package.json', '/%2e%2e/package.json', '/..%2f..%2fpackage.json', '/css/../../package.json']) {
    const r = await raw(p);
    assert.ok(!r.includes('tayl-erp'), `تسريب عبر ${p}`);
  }
  assert.equal((await fetch(s.base + '/nope.txt')).status, 404);
  assert.equal((await fetch(s.base + '/css')).status, 404);       // مجلد وليس ملف
});

test('http: Host غريب يُرفض (حماية DNS rebinding)', async (t) => {
  const s = await startApp(); t.after(s.stop);
  const port = s.app.server.address().port;
  const r = await new Promise((resolve) => {
    const c = net.connect(port, '127.0.0.1'); let d = '';
    c.on('data', (x) => { d += x; }); c.on('end', () => resolve(d));
    c.write('GET /api/system/health HTTP/1.1\r\nHost: evil.example.com\r\nConnection: close\r\n\r\n');
  });
  assert.match(r, /403/); assert.match(r, /BAD_HOST/);
});

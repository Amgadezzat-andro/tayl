'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadConfig } = require('../server/core/config');
const { createLogger } = require('../server/core/logger');
const { createApp } = require('../server/app');

const tmpDir = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tayl-test-'));
const silent = createLogger({});

async function startApp(extra = {}) {
  const dir = tmpDir();
  const config = loadConfig({ dataDir: dir, port: 0, ...extra.config });
  const app = await createApp({ config, logger: silent, modules: extra.modules });
  const addr = await app.listen();
  const base = `http://127.0.0.1:${addr.port}`;
  return { app, dir, base, config, stop: async () => { await app.close(); fs.rmSync(dir, { recursive: true, force: true }); } };
}
module.exports = { tmpDir, silent, startApp };

// ── المرحلة 1: عميل HTTP يحتفظ بكوكي الجلسة ورمز CSRF (كما يفعل المتصفح) ──
function client(base) {
  const st = { cookie: null, csrf: null };
  async function req(method, p, body, { headers = {}, csrf = true } = {}) {
    const h = { ...headers };
    if (st.cookie) h.cookie = st.cookie;
    if (csrf && st.csrf && method !== 'GET') h['x-csrf-token'] = st.csrf;
    if (body !== undefined) h['content-type'] = 'application/json';
    const r = await fetch(base + p, { method, headers: h, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) { const m = /tayl_sid=([^;]*)/.exec(sc); st.cookie = m && m[1] && !/Max-Age=0/.test(sc) ? `tayl_sid=${m[1]}` : null; }
    const text = await r.text();
    let json = null; try { json = JSON.parse(text); } catch { /* ليست JSON */ }
    if (json && json.csrfToken) st.csrf = json.csrfToken;
    return { status: r.status, body: json, headers: r.headers, text };
  }
  return {
    state: st,
    get: (p, o) => req('GET', p, undefined, o),
    post: (p, b, o) => req('POST', p, b, o),
    put: (p, b, o) => req('PUT', p, b, o),
    del: (p, o) => req('DELETE', p, undefined, o),
    login: (username, password) => req('POST', '/api/auth/login', { username, password }),
  };
}

// بيانات تأسيس اختبارية (ليست بيانات حقيقية).
const ADMIN = { username: 'admin', displayName: 'Test Admin', password: 'Adm1n-Test-Pass' };
function setupPayload(over = {}) {
  return {
    company: { nameAr: 'شركة اختبار', nameEn: 'Test Company', baseCurrency: 'EGP', defaultLanguage: 'ar', ...over.company },
    branch: { code: 'HQ', nameAr: 'الفرع الرئيسي', nameEn: 'Head Office', ...over.branch },
    admin: { ...ADMIN, ...over.admin },
    ...(over.logo ? { logo: over.logo } : {}),
  };
}

/** يشغّل التطبيق، يؤسس النظام، ويسجل دخول المدير العام. */
async function startReady(extra = {}) {
  const s = await startApp(extra);
  const admin = client(s.base);
  const r = await admin.post('/api/setup', setupPayload());
  if (r.status !== 200) throw new Error('setup failed: ' + r.text);
  const l = await admin.login(ADMIN.username, ADMIN.password);
  if (l.status !== 200) throw new Error('login failed: ' + l.text);
  return { ...s, admin, client: () => client(s.base) };
}

/** ينشئ مستخدمًا بدور يحمل الصلاحيات المعطاة، ويعيد عميلًا مسجّل الدخول به (بعد تغيير كلمة المرور الإجباري). */
async function makeUser(s, { username, permissions = [], branchIds = [], allBranches = false, roleName } = {}) {
  let roleIds = [];
  if (permissions.length) {
    const role = await s.admin.post('/api/roles', { nameAr: roleName || 'دور ' + username, nameEn: roleName || 'Role ' + username, permissions });
    if (role.status !== 200) throw new Error('role failed: ' + role.text);
    roleIds = [role.body.id];
  }
  const tmp = 'Temp-Pass-123';
  const u = await s.admin.post('/api/users', { username, displayName: username, password: tmp, roleIds, branchIds, allBranches });
  if (u.status !== 200) throw new Error('user failed: ' + u.text);
  const c = client(s.base);
  await c.login(username, tmp);
  const pw = await c.post('/api/auth/password', { currentPassword: tmp, newPassword: 'Real-Pass-456' });
  if (pw.status !== 200) throw new Error('pw failed: ' + pw.text);
  return { id: u.body.id, roleIds, client: c, password: 'Real-Pass-456' };
}
module.exports.client = client;
module.exports.ADMIN = ADMIN;
module.exports.setupPayload = setupPayload;
module.exports.startReady = startReady;
module.exports.makeUser = makeUser;

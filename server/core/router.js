'use strict';
const { HttpError } = require('./errors');

/**
 * موجّه بسيط: /api/x/:id ، مع دعم 405 ، وتصريح صلاحية يُفرض على الخادم (يفشل مغلقًا).
 * كل مسار يعلن صراحة واحدًا من: { public: true } أو { auth: true } (أي مستخدم مسجّل) أو { permission: 'x.y' }.
 * مسار لا يعلن شيئًا يُرفض وقت الطلب (http.js).
 */
class Router {
  constructor() { this.routes = []; }

  add(method, pattern, opts, handler) {
    if (typeof opts === 'function') { handler = opts; opts = {}; }
    const keys = [];
    const re = new RegExp('^' + pattern.split('/').map((seg) => {
      if (seg.startsWith(':')) { keys.push(seg.slice(1)); return '([^/]+)'; }
      return seg.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    }).join('/') + '/?$');
    if (opts.permission != null && (typeof opts.permission !== 'string' || !opts.permission)) throw new Error(`صلاحية غير صالحة للمسار ${pattern}`);
    this.routes.push({ method, pattern, re, keys, handler, permission: opts.permission || null, public: !!opts.public, auth: !!opts.auth || !!opts.permission });
    return this;
  }
  get(p, o, h) { return this.add('GET', p, o, h); }
  post(p, o, h) { return this.add('POST', p, o, h); }
  put(p, o, h) { return this.add('PUT', p, o, h); }
  delete(p, o, h) { return this.add('DELETE', p, o, h); }

  match(method, pathname) {
    const allowed = new Set();
    for (const r of this.routes) {
      const m = r.re.exec(pathname);
      if (!m) continue;
      if (r.method !== method) { allowed.add(r.method); continue; }
      const params = {};
      try { r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); }); }
      catch { throw new HttpError(400, 'BAD_PATH', 'مسار غير صالح'); }
      return { route: r, params };
    }
    if (allowed.size) throw new HttpError(405, 'METHOD_NOT_ALLOWED', 'الطريقة غير مسموحة لهذا المسار', { allowed: [...allowed] });
    return null;
  }
}
module.exports = { Router };

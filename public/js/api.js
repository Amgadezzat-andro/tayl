'use strict';
/*
 * عميل الـ API. رمز CSRF يُحفظ في الذاكرة فقط (لا LocalStorage)، والجلسة نفسها في كوكي HttpOnly لا يراه JavaScript.
 * أي 401 أثناء العمل يطلق الحدث tayl:unauthenticated لتعرض الواجهة شاشة الدخول.
 */
window.TAYL = window.TAYL || {};
TAYL.api = (() => {
  let csrf = null;
  let lastActivity = Date.now();

  class ApiError extends Error {
    constructor(status, error) {
      super(error && error.code ? error.code : 'NETWORK');
      this.status = status;
      this.code = error && error.code ? error.code : 'NETWORK';
      this.fields = (error && error.details && error.details.fields) || {};
      this.details = (error && error.details) || {};
      this.requestId = error && error.requestId;
    }
  }

  async function request(method, url, body, { quiet401 = false } = {}) {
    const headers = { Accept: 'application/json' };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (method !== 'GET' && csrf) headers['X-CSRF-Token'] = csrf;
    let r;
    try {
      r = await fetch(url, { method, headers, credentials: 'same-origin', body: body === undefined ? undefined : JSON.stringify(body) });
    } catch {
      throw new ApiError(0, { code: 'NETWORK' });
    }
    let data = null;
    const text = await r.text();
    try { data = text ? JSON.parse(text) : null; } catch { data = null; }
    if (!r.ok) {
      const err = new ApiError(r.status, data && data.error);
      if (r.status === 401 && !quiet401) window.dispatchEvent(new CustomEvent('tayl:unauthenticated'));
      throw err;
    }
    lastActivity = Date.now();
    if (data && data.csrfToken) csrf = data.csrfToken;
    return data;
  }

  return {
    ApiError,
    get: (u, o) => request('GET', u, undefined, o),
    post: (u, b, o) => request('POST', u, b === undefined ? {} : b, o),
    put: (u, b, o) => request('PUT', u, b, o),
    del: (u, o) => request('DELETE', u, undefined, o),
    clear() { csrf = null; },
    get lastActivity() { return lastActivity; },
  };
})();

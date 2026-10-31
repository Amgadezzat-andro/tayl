'use strict';
const { validator } = require('../../core/validate');
const { inTransaction } = require('../../core/db');

/** إعدادات النظام القابلة للتعديل. القيمة الافتراضية تُستخدم ما لم تُحفظ قيمة في القاعدة. */
const DEFS = Object.freeze({
  sessionIdleMinutes:   { def: 30, min: 5, max: 1440 },   // انتهاء الجلسة بعد خمول
  sessionAbsoluteHours: { def: 12, min: 1, max: 168 },    // أقصى عمر للجلسة مهما كان النشاط
  loginMaxFailures:     { def: 5,  min: 3, max: 20 },     // محاولات فاشلة قبل القفل المؤقت
  loginLockMinutes:     { def: 15, min: 1, max: 1440 },   // مدة القفل المؤقت
  passwordMinLength:    { def: 8,  min: 8, max: 64 },
});

function createSettingsService({ db, audit }) {
  function get() {
    const out = {};
    for (const [k, d] of Object.entries(DEFS)) out[k] = d.def;
    for (const r of db.prepare('SELECT key, value FROM settings').all()) {
      if (Object.prototype.hasOwnProperty.call(DEFS, r.key)) out[r.key] = JSON.parse(r.value);
    }
    return out;
  }

  function update(ctx, body) {
    const v = validator(body, { partial: true });
    for (const [k, d] of Object.entries(DEFS)) v.int(k, { required: true, min: d.min, max: d.max });
    const data = v.done();
    return inTransaction(db, () => {
      const before = get();
      const up = db.prepare(`INSERT INTO settings (key, value, updated_by) VALUES (?, ?, ?)
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_by = excluded.updated_by, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`);
      const diff = {};
      for (const [k, val] of Object.entries(data)) {
        up.run(k, JSON.stringify(val), ctx.user ? ctx.user.id : null);
        if (before[k] !== val) diff[k] = { from: before[k], to: val };
      }
      if (Object.keys(diff).length) audit.fromCtx(ctx, { action: 'settings.updated', source: 'company-setup', entityType: 'settings', details: { changes: diff } });
      return get();
    });
  }

  return { get, update, DEFS };
}

function registerSettingsRoutes(router, services) {
  router.get('/api/settings', { permission: 'settings.view' }, () => ({
    values: services.settings.get(),
    limits: Object.fromEntries(Object.entries(DEFS).map(([k, d]) => [k, { min: d.min, max: d.max, default: d.def }])),
  }));
  router.put('/api/settings', { permission: 'settings.update' }, async (ctx) => ({ values: services.settings.update(ctx, await ctx.body()) }));
}

module.exports = { createSettingsService, registerSettingsRoutes, DEFS };

'use strict';
const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

/**
 * فتح قاعدة البيانات بإعدادات السلامة المطلوبة للبيانات المالية:
 *  - foreign_keys=ON  : تفعيل المفاتيح الخارجية (معطلة افتراضيًا في SQLite)
 *  - WAL              : قراءة متزامنة مع كتابة، ومناسب لتعدد المستخدمين لاحقًا
 *  - synchronous=FULL : لا نفقد حركة مالية مؤكدة عند انقطاع الكهرباء
 *  - busy_timeout     : انتظار بدل الفشل الفوري عند تزامن الكتابة
 */
function openDatabase(file, { readonly = false } = {}) {
  if (file !== ':memory:' && !readonly) fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file, { readonly });
  db.pragma('foreign_keys = ON');
  db.pragma('busy_timeout = 5000');
  if (!readonly) {
    db.pragma('journal_mode = WAL');
    db.pragma('synchronous = FULL');
  }
  cacheStatements(db);
  return db;
}

/**
 * [م3] كل db.prepare(sql) يعيد العبارة المحضّرة نفسها للنص نفسه. بدون ذلك ينشئ كل استدعاء عبارة جديدة تحجز ذاكرة
 * أصلية لا يراها جامع القمامة، فتتضخم الذاكرة مع كل ترحيل (قِيس: 12 GB لعشرين ألف قيد). لا يغيّر أي وحدة وضع العبارة
 * (pluck/raw/expand)، فإعادة استخدامها آمنة. الحد الأعلى يمنع نمو الذاكرة من نصوص SQL المتغيرة (قوائم IN في التقارير).
 */
const STATEMENT_CACHE_MAX = 1000;
function cacheStatements(db) {
  const prepare = db.prepare.bind(db);
  const cache = new Map();
  db.prepare = (sql) => {
    let s = cache.get(sql);
    if (!s) {
      s = prepare(sql);
      if (cache.size >= STATEMENT_CACHE_MAX) cache.clear();
      cache.set(sql, s);
    }
    return s;
  };
}

/**
 * تنفيذ عملية في معاملة واحدة (كل شيء أو لا شيء).
 * IMMEDIATE: تحجز قفل الكتابة من البداية فلا يحدث تعارض عند الترقية لاحقًا.
 * المعاملات المتداخلة تتحول تلقائيًا إلى SAVEPOINT.
 */
function inTransaction(db, fn) {
  return db.transaction(fn).immediate();
}

module.exports = { openDatabase, inTransaction };

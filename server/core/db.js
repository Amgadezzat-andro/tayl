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
  return db;
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

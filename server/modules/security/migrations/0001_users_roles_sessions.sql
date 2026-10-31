-- TAYL Phase 1 — المستخدمون والأدوار والصلاحيات ونطاق الفروع والجلسات.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

-- المستخدمون: لا يُحذفون (سجل التدقيق يشير إليهم)، بل يُعطَّلون.
-- password_hash بصيغة: scrypt$N$r$p$salt(base64)$hash(base64) — لا تُخزَّن كلمة المرور أبدًا.
CREATE TABLE users (
  id                   INTEGER PRIMARY KEY,
  username             TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(username) BETWEEN 3 AND 64),
  display_name         TEXT NOT NULL CHECK (length(display_name) BETWEEN 1 AND 120),
  password_hash        TEXT NOT NULL CHECK (password_hash LIKE 'scrypt$%'),
  is_active            INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  is_super_admin       INTEGER NOT NULL DEFAULT 0 CHECK (is_super_admin IN (0, 1)),
  all_branches         INTEGER NOT NULL DEFAULT 0 CHECK (all_branches IN (0, 1)),
  default_branch_id    INTEGER REFERENCES branches (id),
  must_change_password INTEGER NOT NULL DEFAULT 0 CHECK (must_change_password IN (0, 1)),
  password_changed_at  TEXT,
  last_login_at        TEXT,
  created_by           INTEGER REFERENCES users (id),
  created_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at           TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (is_super_admin = 0 OR all_branches = 1)       -- المدير العام يرى كل الفروع دائمًا
) STRICT;

CREATE TRIGGER users_no_delete BEFORE DELETE ON users
BEGIN SELECT RAISE(ABORT, 'users cannot be deleted; deactivate instead'); END;

CREATE TABLE roles (
  id          INTEGER PRIMARY KEY,
  name_ar     TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name_ar) BETWEEN 1 AND 100),
  name_en     TEXT NOT NULL UNIQUE COLLATE NOCASE CHECK (length(name_en) BETWEEN 1 AND 100),
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

-- مفاتيح الصلاحيات تعرّفها الوحدات في الكود (كتالوج مركزي)، ويُتحقق منها في الخادم عند الحفظ.
CREATE TABLE role_permissions (
  role_id    INTEGER NOT NULL REFERENCES roles (id) ON DELETE CASCADE,
  permission TEXT NOT NULL CHECK (permission GLOB '[a-z]*.[a-z]*'),
  PRIMARY KEY (role_id, permission)
) STRICT, WITHOUT ROWID;

-- للمستخدم أكثر من دور؛ الصلاحيات الفعلية = اتحاد صلاحيات أدواره.
-- حذف دور مُسنَد لمستخدمين ممنوع (RESTRICT) حتى لا تتغير صلاحيات أحد بصمت.
CREATE TABLE user_roles (
  user_id INTEGER NOT NULL REFERENCES users (id),
  role_id INTEGER NOT NULL REFERENCES roles (id) ON DELETE RESTRICT,
  PRIMARY KEY (user_id, role_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX user_roles_role ON user_roles (role_id);

-- نطاق الفروع: إن كان all_branches = 1 يُتجاهل هذا الجدول.
CREATE TABLE user_branches (
  user_id   INTEGER NOT NULL REFERENCES users (id),
  branch_id INTEGER NOT NULL REFERENCES branches (id),
  PRIMARY KEY (user_id, branch_id)
) STRICT, WITHOUT ROWID;
CREATE INDEX user_branches_branch ON user_branches (branch_id);

-- الجلسات: يُخزَّن SHA-256 لرمز الجلسة فقط؛ تسريب القاعدة لا يعطي جلسات صالحة.
-- الأوقات بالمللي ثانية (epoch) لسهولة حساب الانتهاء.
CREATE TABLE sessions (
  token_hash   TEXT PRIMARY KEY CHECK (length(token_hash) = 64),
  user_id      INTEGER NOT NULL REFERENCES users (id),
  csrf_token   TEXT NOT NULL CHECK (length(csrf_token) >= 32),
  branch_id    INTEGER REFERENCES branches (id),
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,                     -- الحد المطلق لعمر الجلسة
  ip           TEXT,
  user_agent   TEXT
) STRICT, WITHOUT ROWID;
CREATE INDEX sessions_user ON sessions (user_id);

-- حماية محاولات الدخول المتكررة. المفتاح 'u:<اسم المستخدم>' أو 'ip:<العنوان>'.
-- يُطبَّق على أي اسم مستخدم حتى غير الموجود، فلا يكشف السلوك وجود الحساب.
CREATE TABLE login_throttle (
  key          TEXT PRIMARY KEY,
  failures     INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  locked_until INTEGER
) STRICT, WITHOUT ROWID;

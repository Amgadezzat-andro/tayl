-- TAYL core schema (Phase 0). لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE app_meta (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO app_meta (key, value) VALUES ('app_id', 'TAYL');

-- actor_user_id بلا مفتاح خارجي عمدًا: جدول المستخدمين يُنشأ في المرحلة 1.
-- سيُربط منطقيًا هناك دون تغيير هيكل هذا السجل (سجل التدقيق لا يُعدَّل).
CREATE TABLE audit_log (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  occurred_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  actor_user_id INTEGER,
  actor         TEXT NOT NULL DEFAULT 'system',
  action        TEXT NOT NULL CHECK (length(action) > 0),
  entity_type   TEXT,
  entity_id     TEXT,
  source        TEXT NOT NULL CHECK (length(source) > 0),
  details       TEXT CHECK (details IS NULL OR json_valid(details)),
  request_id    TEXT
) STRICT;

CREATE INDEX idx_audit_entity ON audit_log (entity_type, entity_id);
CREATE INDEX idx_audit_time   ON audit_log (occurred_at);

CREATE TRIGGER audit_log_no_update BEFORE UPDATE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

CREATE TRIGGER audit_log_no_delete BEFORE DELETE ON audit_log
BEGIN SELECT RAISE(ABORT, 'audit_log is append-only'); END;

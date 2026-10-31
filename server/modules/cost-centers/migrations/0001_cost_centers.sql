-- TAYL Phase 2 — مراكز التكلفة (شجرة). محرك توزيع المصروفات المشتركة ليس ضمن هذه المرحلة.
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE cost_center_types (
  id         INTEGER PRIMARY KEY,
  code       TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar    TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 120),
  name_en    TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 120),
  is_active  INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;

INSERT INTO cost_center_types (code, name_ar, name_en) VALUES
  ('PRODUCTION',  'إنتاج',  'Production'),
  ('ADMIN',       'إدارة',  'Administration'),
  ('SALES',       'مبيعات', 'Sales'),
  ('MAINTENANCE', 'صيانة',  'Maintenance'),
  ('SERVICES',    'خدمات',  'Services');

CREATE TABLE cost_centers (
  id          INTEGER PRIMARY KEY,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30 AND code = upper(code)),
  name_ar     TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 200),
  name_en     TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 200),
  parent_id   INTEGER REFERENCES cost_centers (id),
  path        TEXT NOT NULL,
  level       INTEGER NOT NULL CHECK (level BETWEEN 1 AND 15),
  type_id     INTEGER REFERENCES cost_center_types (id),
  branch_id   INTEGER REFERENCES branches (id),          -- NULL = مركز عام لكل الفروع
  is_group    INTEGER NOT NULL DEFAULT 0 CHECK (is_group IN (0, 1)),
  is_active   INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  description TEXT,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  CHECK (parent_id IS NULL OR parent_id <> id)
) STRICT;
CREATE INDEX cost_centers_parent ON cost_centers (parent_id, sort_order);
CREATE INDEX cost_centers_path ON cost_centers (path);
CREATE INDEX cost_centers_branch ON cost_centers (branch_id);

CREATE TRIGGER cost_centers_parent_group_ins BEFORE INSERT ON cost_centers WHEN NEW.parent_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'parent cost center must be a group') WHERE (SELECT is_group FROM cost_centers WHERE id = NEW.parent_id) IS NOT 1; END;
CREATE TRIGGER cost_centers_parent_group_upd BEFORE UPDATE OF parent_id ON cost_centers WHEN NEW.parent_id IS NOT NULL
BEGIN SELECT RAISE(ABORT, 'parent cost center must be a group') WHERE (SELECT is_group FROM cost_centers WHERE id = NEW.parent_id) IS NOT 1; END;

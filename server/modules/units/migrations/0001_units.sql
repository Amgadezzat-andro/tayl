-- TAYL Phase 2 — قاموس وحدات القياس العامة.
-- عمدًا بلا معاملات تحويل: معامل التحويل خاص بكل صنف (وحدة الأصناف والمخزون في مرحلة لاحقة).
-- لا تُعدَّل بعد التطبيق؛ أي تغيير = ترحيل جديد.

CREATE TABLE units (
  id           INTEGER PRIMARY KEY,
  code         TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 20 AND code = upper(code)),
  name_ar      TEXT NOT NULL CHECK (length(name_ar) BETWEEN 1 AND 60),
  name_en      TEXT NOT NULL CHECK (length(name_en) BETWEEN 1 AND 60),
  name_ar_norm TEXT NOT NULL UNIQUE,      -- الاسم بعد التطبيع (علبة = علبه = عُلبة) لمنع التكرار
  name_en_norm TEXT NOT NULL UNIQUE,
  symbol       TEXT CHECK (symbol IS NULL OR length(symbol) BETWEEN 1 AND 12),
  category     TEXT NOT NULL CHECK (category IN ('count', 'weight', 'length', 'volume', 'area', 'time', 'other')),
  description  TEXT,
  is_active    INTEGER NOT NULL DEFAULT 1 CHECK (is_active IN (0, 1)),
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
) STRICT;
-- الرمز فريد داخل التصنيف (kg مرة واحدة في الأوزان)
CREATE UNIQUE INDEX units_symbol_per_category ON units (category, lower(symbol)) WHERE symbol IS NOT NULL;

-- وحدات أساسية شائعة (قابلة للتعديل والتعطيل). الأعمدة *_norm مطبّعة يدويًا بنفس قواعد core/search.js.
INSERT INTO units (code, name_ar, name_en, name_ar_norm, name_en_norm, symbol, category) VALUES
  ('PCS', 'قطعة',       'Piece',        'قطعه',       'piece',        'pcs', 'count'),
  ('BOX', 'علبة',       'Box',          'علبه',       'box',          'box', 'count'),
  ('CTN', 'كرتونة',     'Carton',       'كرتونه',     'carton',       'ctn', 'count'),
  ('PKT', 'عبوة',       'Pack',         'عبوه',       'pack',         'pkt', 'count'),
  ('DZN', 'دستة',       'Dozen',        'دسته',       'dozen',        'dz',  'count'),
  ('KG',  'كيلوجرام',   'Kilogram',     'كيلوجرام',   'kilogram',     'kg',  'weight'),
  ('G',   'جرام',       'Gram',         'جرام',       'gram',         'g',   'weight'),
  ('TON', 'طن',         'Tonne',        'طن',         'tonne',        't',   'weight'),
  ('M',   'متر',        'Metre',        'متر',        'metre',        'm',   'length'),
  ('CM',  'سنتيمتر',    'Centimetre',   'سنتيمتر',    'centimetre',   'cm',  'length'),
  ('L',   'لتر',        'Litre',        'لتر',        'litre',        'l',   'volume'),
  ('ML',  'مليلتر',     'Millilitre',   'مليلتر',     'millilitre',   'ml',  'volume'),
  ('M2',  'متر مربع',   'Square metre', 'متر مربع',   'square metre', 'm²',  'area'),
  ('HR',  'ساعة',       'Hour',         'ساعه',       'hour',         'h',   'time');

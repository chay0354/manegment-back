-- Central materials reference table (~200 raw materials).
-- Used by analysis to understand material role/family/domain.
-- Run in MANAGEMENT system Supabase.

CREATE TABLE IF NOT EXISTS materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  material_id TEXT UNIQUE NOT NULL,
  material_name TEXT NOT NULL,
  aliases JSONB DEFAULT '[]',
  material_family TEXT,
  material_role TEXT,
  technology_domain TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS materials_material_id_idx ON materials(material_id);
CREATE INDEX IF NOT EXISTS materials_technology_domain_idx ON materials(technology_domain);
CREATE INDEX IF NOT EXISTS materials_material_family_idx ON materials(material_family);

COMMENT ON TABLE materials IS 'Central raw materials library for analysis (formulation intelligence, similarity)';

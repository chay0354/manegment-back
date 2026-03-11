-- Research Intelligence scope: analysis cache, experiment_materials with role, parent_experiment_id, indexes, optional experiment_relations.
-- Run in MANAGEMENT system Supabase (same DB as projects, lab_experiments, analysis_log).

-- 1. analysis_log: input_hash for caching (avoid duplicate analysis)
ALTER TABLE analysis_log ADD COLUMN IF NOT EXISTS input_hash TEXT;
CREATE INDEX IF NOT EXISTS analysis_log_input_hash_idx ON analysis_log(input_hash) WHERE input_hash IS NOT NULL;
COMMENT ON COLUMN analysis_log.input_hash IS 'Hash of analysis input; used to return cached result for identical requests';

-- 2. experiment_materials: relation experiment <-> material with role (for pattern detection & similarity)
CREATE TABLE IF NOT EXISTS experiment_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  experiment_id UUID NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
  material_id TEXT NOT NULL,
  role TEXT CHECK (role IS NULL OR role IN ('main', 'secondary', 'additive', 'catalyst', 'solvent')),
  percentage NUMERIC,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(experiment_id, material_id)
);
CREATE INDEX IF NOT EXISTS experiment_materials_experiment_id_idx ON experiment_materials(experiment_id);
CREATE INDEX IF NOT EXISTS experiment_materials_material_id_idx ON experiment_materials(material_id);
COMMENT ON TABLE experiment_materials IS 'Materials per experiment with role; supports pattern detection and similarity';

-- 3. lab_experiments: parent_experiment_id for experiment lineage (ניסוי שמבוסס על ניסוי קודם)
ALTER TABLE lab_experiments ADD COLUMN IF NOT EXISTS parent_experiment_id UUID REFERENCES lab_experiments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS lab_experiments_parent_experiment_id_idx ON lab_experiments(parent_experiment_id) WHERE parent_experiment_id IS NOT NULL;
COMMENT ON COLUMN lab_experiments.parent_experiment_id IS 'Parent experiment (this experiment is derived from that one)';

-- 4. experiment_relations: optional relationship_type for future knowledge map (derived_from / similar_to / inspired_by)
CREATE TABLE IF NOT EXISTS experiment_relations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_experiment_id UUID NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
  target_experiment_id UUID NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
  relationship_type TEXT NOT NULL CHECK (relationship_type IN ('derived_from', 'similar_to', 'inspired_by')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(source_experiment_id, target_experiment_id, relationship_type)
);
CREATE INDEX IF NOT EXISTS experiment_relations_source_idx ON experiment_relations(source_experiment_id);
CREATE INDEX IF NOT EXISTS experiment_relations_target_idx ON experiment_relations(target_experiment_id);
COMMENT ON TABLE experiment_relations IS 'Optional: relationship between experiments for future knowledge map';

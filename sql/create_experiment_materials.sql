-- Normalized materials per lab experiment (optional but recommended for reporting / joins).
-- Run in Supabase SQL editor for the management project database.

CREATE TABLE IF NOT EXISTS experiment_materials (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  lab_experiment_id UUID NOT NULL REFERENCES lab_experiments(id) ON DELETE CASCADE,
  material_name TEXT NOT NULL,
  weight_percent NUMERIC(12, 4),
  sort_order INT NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_experiment_materials_lab ON experiment_materials(lab_experiment_id);
CREATE INDEX IF NOT EXISTS idx_experiment_materials_project ON experiment_materials(project_id);

COMMENT ON TABLE experiment_materials IS 'One row per material line for a lab_experiments row; synced from formulation save / imports.';

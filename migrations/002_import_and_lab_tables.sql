-- Run this in the MANAGEMENT system Supabase (the DB that has "projects" table).
-- If you get "column project_id does not exist", old tables may exist with wrong schema.
-- This migration drops and recreates the import/lab tables cleanly.

-- Drop in reverse dependency order (lab_experiments refs research_sessions)
DROP TABLE IF EXISTS lab_experiments CASCADE;
DROP TABLE IF EXISTS material_library CASCADE;
DROP TABLE IF EXISTS import_log CASCADE;
DROP TABLE IF EXISTS research_sessions CASCADE;

-- 1. Import Log
CREATE TABLE import_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  source_file_reference TEXT NOT NULL,
  source_type TEXT DEFAULT 'sharepoint_file',
  created_count INTEGER DEFAULT 0,
  updated_count INTEGER DEFAULT 0,
  error_count INTEGER DEFAULT 0,
  details JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX import_log_project_id_idx ON import_log(project_id);
CREATE INDEX import_log_created_at_idx ON import_log(created_at DESC);

-- 2. Research Sessions
CREATE TABLE research_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX research_sessions_project_id_idx ON research_sessions(project_id);

-- 3. Lab Experiments
CREATE TABLE lab_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL DEFAULT 1,
  technology_domain TEXT NOT NULL,
  formula TEXT,
  materials JSONB,
  percentages JSONB,
  results TEXT,
  experiment_outcome TEXT NOT NULL DEFAULT 'success',
  is_production_formula BOOLEAN NOT NULL DEFAULT false,
  source_file_reference TEXT,
  research_session_id UUID REFERENCES research_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, experiment_id)
);
ALTER TABLE lab_experiments ADD CONSTRAINT lab_experiments_outcome_check CHECK (experiment_outcome IN ('success', 'failure', 'partial', 'production_formula'));
CREATE INDEX lab_experiments_project_id_idx ON lab_experiments(project_id);
CREATE INDEX lab_experiments_source_idx ON lab_experiments(source_file_reference);
CREATE INDEX lab_experiments_session_idx ON lab_experiments(research_session_id);

-- 4. Material Library
CREATE TABLE material_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role_or_function TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, name)
);
CREATE INDEX material_library_project_id_idx ON material_library(project_id);

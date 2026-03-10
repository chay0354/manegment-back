-- Run in the MANAGEMENT system Supabase (same DB as projects, lab_experiments).
-- Stores results of analysis endpoints: formulation-intelligence, similar-experiments.

CREATE TABLE IF NOT EXISTS analysis_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  analysis_type TEXT NOT NULL,
  input_ref TEXT,
  result JSONB NOT NULL,
  request_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS analysis_log_project_id_idx ON analysis_log(project_id);
CREATE INDEX IF NOT EXISTS analysis_log_analysis_type_idx ON analysis_log(analysis_type);
CREATE INDEX IF NOT EXISTS analysis_log_created_at_idx ON analysis_log(created_at DESC);

COMMENT ON TABLE analysis_log IS 'Log of analysis API results: formulation-intelligence, similar-experiments';

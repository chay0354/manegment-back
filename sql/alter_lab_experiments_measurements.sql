-- Phase B: structured measurements per lab experiment (RAG + comparisons).
ALTER TABLE lab_experiments ADD COLUMN IF NOT EXISTS measurements JSONB DEFAULT NULL;

COMMENT ON COLUMN lab_experiments.measurements IS
  'Array of {type,value,unit,rpm,temp} — viscosity normalized to cps @ ref RPM in app layer.';

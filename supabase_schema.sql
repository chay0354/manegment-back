-- Project Manager – Supabase schema (run in SQL Editor)
-- Database: zqhdznwquejnkdpxsuui

-- Projects
CREATE TABLE IF NOT EXISTS projects (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  description TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Tasks (per project)
CREATE TABLE IF NOT EXISTS tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'todo' CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled')),
  priority TEXT NOT NULL DEFAULT 'medium' CHECK (priority IN ('low', 'medium', 'high')),
  due_date DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS tasks_project_id_idx ON tasks(project_id);

-- Milestones (per project)
CREATE TABLE IF NOT EXISTS milestones (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT,
  due_date DATE,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS milestones_project_id_idx ON milestones(project_id);

-- Documents (per project)
CREATE TABLE IF NOT EXISTS documents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS documents_project_id_idx ON documents(project_id);

-- Notes (per project)
CREATE TABLE IF NOT EXISTS notes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title TEXT,
  body TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS notes_project_id_idx ON notes(project_id);

-- Project files (uploaded to Matriya for RAG; metadata stored here)
CREATE TABLE IF NOT EXISTS project_files (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  original_name TEXT NOT NULL,
  storage_path TEXT,
  ingest_error TEXT,
  folder_display_name TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS storage_path TEXT;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS ingest_error TEXT;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS folder_display_name TEXT;

CREATE INDEX IF NOT EXISTS project_files_project_id_idx ON project_files(project_id);

-- Display names for bucket paths (Hebrew/English names for "folder 1", "file 1.pdf" etc.)
CREATE TABLE IF NOT EXISTS sharepoint_display_names (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  path TEXT NOT NULL,
  display_name TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, path)
);
CREATE INDEX IF NOT EXISTS sharepoint_display_names_project_id_idx ON sharepoint_display_names(project_id);
CREATE INDEX IF NOT EXISTS sharepoint_display_names_path_idx ON sharepoint_display_names(project_id, path);

-- SharePoint pull idempotency: one row per request_id (ON CONFLICT DO NOTHING)
CREATE TABLE IF NOT EXISTS sharepoint_pull_requests (
  request_id TEXT PRIMARY KEY,
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ DEFAULT now()
);

-- User cache (Matriya user_id -> username for "add member" lookup)
CREATE TABLE IF NOT EXISTS user_cache (
  user_id INTEGER PRIMARY KEY,
  username TEXT NOT NULL,
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Project members (who can access a project; creator is owner)
CREATE TABLE IF NOT EXISTS project_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_project_id_idx ON project_members(project_id);
CREATE INDEX IF NOT EXISTS project_members_user_id_idx ON project_members(user_id);

-- Join requests (user asked to be added to project)
CREATE TABLE IF NOT EXISTS project_join_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected')),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_join_requests_project_id_idx ON project_join_requests(project_id);
CREATE INDEX IF NOT EXISTS project_join_requests_status_idx ON project_join_requests(project_id, status);

-- Project chat (any project member can read/write)
CREATE TABLE IF NOT EXISTS project_chat_messages (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL,
  username TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS project_chat_messages_project_id_idx ON project_chat_messages(project_id);

-- Audit log (actor, entity, action, before/after, request_id)
CREATE TABLE IF NOT EXISTS audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE SET NULL,
  user_id INTEGER,
  username TEXT,
  action TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  entity_id TEXT,
  details JSONB,
  request_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS audit_log_project_id_idx ON audit_log(project_id);
CREATE INDEX IF NOT EXISTS audit_log_created_at_idx ON audit_log(created_at);
CREATE INDEX IF NOT EXISTS audit_log_request_id_idx ON audit_log(request_id);

-- Runs (per project): feature tagging + FSM trace
CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'running', 'completed', 'failed')),
  features_core TEXT[] DEFAULT '{}',
  features_extended TEXT[] DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS runs_project_id_idx ON runs(project_id);
CREATE INDEX IF NOT EXISTS runs_status_idx ON runs(project_id, status);
CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs(project_id, created_at DESC);

-- FSM transition trace per run (from → to, timestamp, ruleId optional)
CREATE TABLE IF NOT EXISTS run_fsm_trace (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id UUID NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
  from_state TEXT,
  to_state TEXT NOT NULL,
  rule_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS run_fsm_trace_run_id_idx ON run_fsm_trace(run_id);

-- If audit_log already exists without request_id, run:
-- ALTER TABLE audit_log ADD COLUMN IF NOT EXISTS request_id TEXT;
-- CREATE INDEX IF NOT EXISTS audit_log_request_id_idx ON audit_log(request_id);
-- If runs table exists, add index for pagination:
-- CREATE INDEX IF NOT EXISTS runs_created_at_idx ON runs(project_id, created_at DESC);

-- Optional: enable RLS and add policies in Supabase Dashboard if you use anon key from frontend.
--
-- ---------- Import & lab data (management system only) ----------

-- 1. Import Log – track which file produced which data
CREATE TABLE IF NOT EXISTS import_log (
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
CREATE INDEX IF NOT EXISTS import_log_project_id_idx ON import_log(project_id);
CREATE INDEX IF NOT EXISTS import_log_created_at_idx ON import_log(created_at DESC);

-- 2. Research Sessions – group experiments into a research run/session
CREATE TABLE IF NOT EXISTS research_sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT,
  started_at TIMESTAMPTZ DEFAULT now(),
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS research_sessions_project_id_idx ON research_sessions(project_id);

-- 3. Experiments – lab experiments (with source reference and version)
CREATE TABLE IF NOT EXISTS lab_experiments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  experiment_id TEXT NOT NULL,
  experiment_version INTEGER NOT NULL DEFAULT 1,
  technology_domain TEXT NOT NULL,
  formula TEXT,
  materials JSONB,
  percentages JSONB,
  results TEXT,
  experiment_outcome TEXT NOT NULL DEFAULT 'success' CHECK (experiment_outcome IN ('success', 'failure', 'partial', 'production_formula')),
  is_production_formula BOOLEAN NOT NULL DEFAULT false,
  source_file_reference TEXT,
  research_session_id UUID REFERENCES research_sessions(id) ON DELETE SET NULL,
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, experiment_id)
);
CREATE INDEX IF NOT EXISTS lab_experiments_project_id_idx ON lab_experiments(project_id);
CREATE INDEX IF NOT EXISTS lab_experiments_source_idx ON lab_experiments(source_file_reference);
CREATE INDEX IF NOT EXISTS lab_experiments_session_idx ON lab_experiments(research_session_id);
ALTER TABLE lab_experiments ADD COLUMN IF NOT EXISTS parent_experiment_id UUID REFERENCES lab_experiments(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS lab_experiments_parent_experiment_id_idx ON lab_experiments(parent_experiment_id) WHERE parent_experiment_id IS NOT NULL;

-- 3b. Experiment materials (relation + role for pattern/similarity)
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

-- 3c. Experiment relations (optional: for future knowledge map)
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

-- 4. Material Library – central raw materials for analysis
CREATE TABLE IF NOT EXISTS material_library (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  role_or_function TEXT,
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(project_id, name)
);
CREATE INDEX IF NOT EXISTS material_library_project_id_idx ON material_library(project_id);

-- Saved experiment contexts (Lab tab: name + content for AI analysis, per project)
CREATE TABLE IF NOT EXISTS lab_saved_experiment_contexts (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMPTZ DEFAULT now()
);
CREATE INDEX IF NOT EXISTS lab_saved_experiment_contexts_project_id_idx ON lab_saved_experiment_contexts(project_id);

-- If tasks table already existed with old status constraint, run to add 'in_review':
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
-- ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled'));

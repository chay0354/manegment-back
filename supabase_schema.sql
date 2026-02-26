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
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS project_files_project_id_idx ON project_files(project_id);

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
-- If tasks table already existed with old status constraint, run to add 'in_review':
-- ALTER TABLE tasks DROP CONSTRAINT IF EXISTS tasks_status_check;
-- ALTER TABLE tasks ADD CONSTRAINT tasks_status_check CHECK (status IN ('todo', 'in_progress', 'in_review', 'done', 'cancelled'));

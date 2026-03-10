-- Run in the MANAGEMENT system Supabase (same DB as projects).
-- Stores display names (e.g. Hebrew) for bucket paths. Bucket uses "folder 1", "folder 2", "file 1.pdf" etc.;
-- this table maps them to the name shown in the UI.

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

COMMENT ON TABLE sharepoint_display_names IS 'Display names (e.g. Hebrew) for SharePoint bucket paths; bucket uses folder 1, folder 2, file 1.pdf etc.';

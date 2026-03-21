-- Optional: timestamps on project file rows (sync/UI). GPT RAG sync no longer requires this column.
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT now();

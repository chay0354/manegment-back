-- Add storage_path to project_files (for SharePoint bucket file download).
-- Run this in Supabase Dashboard → SQL Editor if you see:
--   "Could not find the 'storage_path' column of 'project_files' in the schema cache"
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS storage_path TEXT;

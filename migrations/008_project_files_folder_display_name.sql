-- Folder display name for grouping project files when uploaded from SharePoint folder
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS folder_display_name TEXT;

-- Store indexing/ingest error per file so UI can show "קובץ זה לא ניתן לסריקה" below filename
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS ingest_error TEXT;

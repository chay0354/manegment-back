-- Track which OpenAI File id is attached to the project vector store (incremental GPT RAG sync)
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS openai_file_id TEXT;
ALTER TABLE project_files ADD COLUMN IF NOT EXISTS openai_synced_at TIMESTAMPTZ;

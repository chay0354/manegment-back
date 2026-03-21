-- GPT RAG: OpenAI vector_store id per project
ALTER TABLE projects ADD COLUMN IF NOT EXISTS openai_vector_store_id TEXT;


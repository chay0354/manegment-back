-- RAG vector store (management-vector) in management DB
-- Run in Supabase SQL Editor. Requires pgvector (Supabase has it by default).
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE IF NOT EXISTS management_vector (
  id TEXT PRIMARY KEY,
  embedding vector(1536),
  document TEXT NOT NULL,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX IF NOT EXISTS management_vector_embedding_idx
  ON management_vector
  USING ivfflat (embedding vector_cosine_ops)
  WITH (lists = 100);

CREATE INDEX IF NOT EXISTS management_vector_metadata_filename_idx
  ON management_vector
  USING BTREE ((metadata->>'filename'));

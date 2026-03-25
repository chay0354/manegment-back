/**
 * Vector store for management RAG – pgvector in management DB, OpenAI embeddings only.
 * Table: management_vector (embedding dimension 1536).
 */
import pg from 'pg';
import crypto from 'crypto';
import path from 'path';
import axios from 'axios';

const { Pool } = pg;

const EMBEDDING_DIM = 1536;
const OPENAI_EMBEDDING_MODEL = 'text-embedding-ada-002';

function sanitize(s) {
  if (s == null) return '';
  return String(s).replace(/\0/g, '');
}

const MAX_EMBED_CHARS = 8000; // OpenAI embedding input limit ~8191 tokens
function prepareForEmbedding(text) {
  let t = sanitize(text);
  t = t.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, ' '); // strip control chars
  t = t.replace(/\uFFFD/g, ' '); // replace replacement char (invalid UTF-8 decode)
  if (!t.trim()) return ' ';
  return t.length > MAX_EMBED_CHARS ? t.slice(0, MAX_EMBED_CHARS) : t;
}

export default class ManagementVectorStore {
  constructor(dbUrl, tableName = 'management_vector') {
    if (!dbUrl) throw new Error('POSTGRES_URL (or DATABASE_URL) is required for RAG');
    this.tableName = tableName;
    // Supabase/cloud Postgres often use certs Node treats as self-signed; force no-verify so connection succeeds
    let url = typeof dbUrl === 'string' ? dbUrl : String(dbUrl);
    if (url.includes('sslmode=')) {
      url = url.replace(/sslmode=[^&]+/, 'sslmode=no-verify');
    } else {
      url = `${url}${url.includes('?') ? '&' : '?'}sslmode=no-verify`;
    }
    this.pool = new Pool({
      connectionString: url,
      max: 10,
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 10000,
      ssl: { rejectUnauthorized: false },
    });
    this._initTable().catch(e => console.warn('[RAG] vector init:', e.message));
  }

  async _initTable() {
    const client = await this.pool.connect();
    try {
      await client.query('CREATE EXTENSION IF NOT EXISTS vector');
      await client.query(`
        CREATE TABLE IF NOT EXISTS ${this.tableName} (
          id TEXT PRIMARY KEY,
          embedding vector(${EMBEDDING_DIM}),
          document TEXT NOT NULL,
          metadata JSONB,
          created_at TIMESTAMPTZ DEFAULT now()
        )
      `);
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${this.tableName}_embedding_idx
          ON ${this.tableName} USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100)
        `);
      } catch (_) {}
      try {
        await client.query(`
          CREATE INDEX IF NOT EXISTS ${this.tableName}_metadata_filename_idx
          ON ${this.tableName} USING BTREE ((metadata->>'filename'))
        `);
      } catch (_) {}
    } finally {
      client.release();
    }
  }

  async _embed(texts) {
    const key = process.env.OPENAI_API_KEY;
    if (!key) throw new Error('OPENAI_API_KEY required for RAG embeddings');
    const prepared = texts.map(t => prepareForEmbedding(t));
    const filtered = prepared.map(p => (p.trim() ? p : ' '));
    if (!filtered.length) throw new Error('No text to embed');
    const res = await axios.post(
      'https://api.openai.com/v1/embeddings',
      { input: filtered, model: OPENAI_EMBEDDING_MODEL },
      { headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, timeout: 60000 }
    ).catch(e => {
      const msg = e.response?.data?.error?.message || e.response?.data?.error || e.message;
      const code = e.response?.status;
      throw new Error(code === 400 ? `OpenAI embedding 400 (invalid/empty text): ${msg}` : `OpenAI embedding failed: ${msg}`);
    });
    if (!res.data?.data) throw new Error('OpenAI embeddings unexpected response');
    return res.data.data.map(d => d.embedding);
  }

  _id(text, meta) {
    return crypto.createHash('md5').update(`${text}_${meta.filename || ''}_${meta.chunk_index || ''}`).digest('hex');
  }

  async addDocuments(texts, metadatas, ids = null) {
    if (!texts?.length) return [];
    const clean = texts.map(t => sanitize(t).trim() || ' ');
    const embeddings = await this._embed(clean);
    ids = ids || clean.map((t, i) => this._id(t, metadatas[i]));

    const client = await this.pool.connect();
    const BATCH = 50;
    try {
      for (let start = 0; start < texts.length; start += BATCH) {
        const end = Math.min(start + BATCH, texts.length);
        const placeholders = [];
        const params = [];
        let p = 1;
        for (let i = start; i < end; i++) {
          placeholders.push(`($${p}, $${p + 1}::vector, $${p + 2}, $${p + 3}::jsonb)`);
          params.push(ids[i], `[${embeddings[i].join(',')}]`, sanitize(clean[i]), sanitize(JSON.stringify(metadatas[i])));
          p += 4;
        }
        await client.query(
          `INSERT INTO ${this.tableName} (id, embedding, document, metadata)
           VALUES ${placeholders.join(', ')}
           ON CONFLICT (id) DO UPDATE SET embedding = EXCLUDED.embedding, document = EXCLUDED.document, metadata = EXCLUDED.metadata`,
          params
        );
      }
      return ids;
    } finally {
      client.release();
    }
  }

  async search(query, nResults = 5, filterMetadata = null) {
    const [queryEmb] = await this._embed([query]);
    const client = await this.pool.connect();
    try {
      let whereClause = '';
      const params = [];
      let idx = 1;

      if (filterMetadata) {
        const conds = [];
        for (const [k, v] of Object.entries(filterMetadata)) {
          if (k === 'filenames' && Array.isArray(v) && v.length > 0) {
            conds.push(`metadata->>'filename' = ANY($${idx}::text[])`);
            params.push(v);
            idx++;
          } else if (k === 'filename' && typeof v === 'string' && v) {
            const base = path.basename(v);
            conds.push(`(metadata->>'filename' = $${idx} OR metadata->>'filename' = $${idx + 1} OR metadata->>'filename' LIKE $${idx + 2})`);
            params.push(v, base, '%' + base.replace(/%/g, '\\%').replace(/_/g, '\\_'));
            idx += 3;
          } else if (v != null) {
            conds.push(`metadata->>'${k}' = $${idx}`);
            params.push(v);
            idx++;
          }
        }
        if (conds.length) whereClause = 'WHERE ' + conds.join(' AND ');
      }

      params.push(`[${queryEmb.join(',')}]`, `[${queryEmb.join(',')}]`, nResults);
      const embParam = idx;
      const limitParam = idx + 2;

      const sql = `
        SELECT id, document, metadata, 1 - (embedding <=> $${embParam}::vector) AS distance
        FROM ${this.tableName}
        ${whereClause}
        ORDER BY embedding <=> $${embParam + 1}::vector
        LIMIT $${limitParam}
      `;
      const result = await client.query(sql, params);
      return result.rows.map(row => ({
        id: row.id,
        document: row.document,
        metadata: typeof row.metadata === 'string' ? (() => { try { return JSON.parse(row.metadata); } catch { return {}; } })() : (row.metadata || {}),
        distance: row.distance != null ? parseFloat(row.distance) : null,
      }));
    } finally {
      client.release();
    }
  }

  async getAllFilenames() {
    const client = await this.pool.connect();
    try {
      const r = await client.query(
        `SELECT DISTINCT metadata->>'filename' AS filename FROM ${this.tableName} WHERE metadata->>'filename' IS NOT NULL ORDER BY filename`
      );
      return r.rows.map(row => row.filename).filter(Boolean);
    } finally {
      client.release();
    }
  }

  /** Concatenate all chunks for one logical filename (order by chunk_index). */
  async getFullTextForFile(filename) {
    if (!filename || !String(filename).trim()) return null;
    const client = await this.pool.connect();
    try {
      const result = await client.query(
        `SELECT document, (metadata->>'chunk_index')::int AS chunk_index
         FROM ${this.tableName}
         WHERE metadata->>'filename' = $1
         ORDER BY (metadata->>'chunk_index')::int ASC NULLS LAST`,
        [filename]
      );
      if (result.rows.length === 0) return null;
      return result.rows.map((r) => r.document).join('\n\n');
    } catch (e) {
      console.warn('[RAG] getFullTextForFile:', e.message);
      return null;
    } finally {
      client.release();
    }
  }

  async getCollectionInfo() {
    const client = await this.pool.connect();
    try {
      const r = await client.query(`SELECT COUNT(*) FROM ${this.tableName}`);
      return { collection_name: this.tableName, document_count: parseInt(r.rows[0].count, 10), db_path: 'Management PostgreSQL' };
    } catch (e) {
      return { collection_name: this.tableName, document_count: 0, db_path: 'Management PostgreSQL' };
    } finally {
      client.release();
    }
  }

  async deleteDocuments(ids = null, filterMetadata = null) {
    const client = await this.pool.connect();
    try {
      if (ids?.length) {
        const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
        const r = await client.query(`DELETE FROM ${this.tableName} WHERE id IN (${placeholders})`, ids);
        return { deleted_count: r.rowCount };
      }
      if (filterMetadata) {
        const conds = [];
        const params = [];
        let i = 1;
        for (const [k, v] of Object.entries(filterMetadata)) {
          if (k === 'filenames' && Array.isArray(v) && v.length > 0) {
            conds.push(`metadata->>'filename' = ANY($${i}::text[])`);
            params.push(v);
            i++;
          } else if (k === 'filename' && typeof v === 'string' && v) {
            const base = path.basename(v);
            conds.push(
              `(metadata->>'filename' = $${i} OR metadata->>'filename' = $${i + 1} OR metadata->>'filename' LIKE $${i + 2})`
            );
            const escaped = v.replace(/%/g, '\\%').replace(/_/g, '\\_');
            const escapedBase = base.replace(/%/g, '\\%').replace(/_/g, '\\_');
            params.push(v, base, '%' + escapedBase);
            i += 3;
          } else if (v != null) {
            conds.push(`metadata->>'${k}' = $${i}`);
            params.push(v);
            i++;
          }
        }
        if (!conds.length) return { deleted_count: 0 };
        const r = await client.query(`DELETE FROM ${this.tableName} WHERE ${conds.join(' AND ')}`, params);
        return { deleted_count: r.rowCount };
      }
      return { deleted_count: 0, error: 'ids or filterMetadata required' };
    } finally {
      client.release();
    }
  }
}

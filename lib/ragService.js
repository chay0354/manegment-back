/**
 * RAG service for management system – ingest, search, answer using management_vector and OpenAI.
 */
import ManagementVectorStore from './vectorStore.js';
import DocumentProcessor from './documentProcessor.js';
import TextChunker from './chunker.js';
import axios from 'axios';
import path from 'path';
import fs from 'fs';
import {
  filterRetrievalRowsByQueryDomain,
  evaluateConclusionBeforeGeneration
} from './domainAndGenerationGate.js';

const TABLE_NAME = 'management_vector';
const CHUNK_SIZE = 1000;
const CHUNK_OVERLAP = 200;

export const RAG_INSUFFICIENT_SUPPORT_MESSAGE_HE = 'אין במערכת מידע תומך לשאלה זו.';
const MIN_DOC_CHARS = 12;

function getDbUrl() {
  return process.env.POSTGRES_URL || process.env.DATABASE_URL;
}

let _ragService = null;

export function getRagService() {
  if (!_ragService) {
    const url = getDbUrl();
    if (!url) throw new Error('POSTGRES_URL or DATABASE_URL required for RAG. Set it in .env (use Supabase Project Settings → Database → Connection string).');
    const store = new ManagementVectorStore(url, TABLE_NAME);
    _ragService = new RAGService(store);
  }
  return _ragService;
}

export class RAGService {
  constructor(vectorStore) {
    this.vectorStore = vectorStore;
    this.documentProcessor = new DocumentProcessor();
    this.chunker = new TextChunker(CHUNK_SIZE, CHUNK_OVERLAP);
  }

  async ingestFile(filePath, originalFilename = null) {
    const result = await this.documentProcessor.processFile(filePath);
    if (!result.success) return { success: false, error: result.error, file_path: filePath };

    let metadata = result.metadata;
    if (originalFilename) metadata = { ...metadata, filename: originalFilename };

    const text = (result.text || '').trim();
    if (!text) return { success: false, error: 'No text extracted', file_path: filePath };

    const chunks = this.chunker.chunkText(text, metadata);
    if (!chunks.length) return { success: false, error: 'No chunks', file_path: filePath };

    const filenameForStore = metadata.filename;
    if (filenameForStore) {
      const del = await this.vectorStore.deleteDocuments(null, { filename: filenameForStore });
      if (del.deleted_count > 0) console.log('[RAG] Re-ingest: removed', del.deleted_count, 'chunks for', filenameForStore);
    }

    const texts = chunks.map(c => c.text);
    const metadatas = chunks.map(c => c.metadata);
    await this.vectorStore.addDocuments(texts, metadatas);
    return { success: true, file_path: filePath, filename: metadata.filename, chunks_count: chunks.length };
  }

  async ingestBuffer(buffer, originalFilename) {
    const tmpDir = process.env.TMPDIR || process.env.TEMP || '/tmp';
    const safeName = (originalFilename || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 80);
    const tmpPath = path.join(tmpDir, `rag-${Date.now()}-${safeName}`);
    try {
      fs.writeFileSync(tmpPath, buffer);
      const result = await this.ingestFile(tmpPath, originalFilename);
      return result;
    } finally {
      try { fs.unlinkSync(tmpPath); } catch (_) {}
    }
  }

  async search(query, nResults = 5, filterMetadata = null) {
    return this.vectorStore.search(query, nResults, filterMetadata);
  }

  async generateAnswer(query, nResults = 10, filterMetadata = null, useLlm = true) {
    const rawResults = await this.search(query, nResults, filterMetadata);
    let results = (rawResults || []).filter((r) => String(r.document || '').trim().length >= MIN_DOC_CHARS);

    if (results.length === 0) {
      return {
        query,
        results: [],
        results_count: 0,
        answer: null,
        context: ''
      };
    }

    results = filterRetrievalRowsByQueryDomain(query, results);
    if (results.length === 0) {
      return {
        query,
        results: [],
        results_count: 0,
        answer: null,
        context: '',
        error: 'DOMAIN_MISMATCH'
      };
    }

    const genOk = evaluateConclusionBeforeGeneration(query, results);
    if (!genOk.ok) {
      return {
        query,
        results: [],
        results_count: 0,
        answer: null,
        context: '',
        error: genOk.code || 'INSUFFICIENT_EVIDENCE',
        generation_blocked: true
      };
    }

    const context = results
      .slice(0, nResults)
      .map((r, i) => `[${i + 1}] ${(r.metadata?.filename || '')}:\n${r.document || ''}`)
      .join('\n\n');

    let answer = null;
    if (useLlm && context && process.env.OPENAI_API_KEY) {
      try {
        const res = await axios.post(
          'https://api.openai.com/v1/chat/completions',
          {
            model: 'gpt-4o-mini',
            messages: [
              {
                role: 'system',
                content:
                  'Answer the question based only on the context. Respond in Hebrew (עברית). ' +
                  'If the context does not support an answer, reply with this single sentence only — no lists, no recommendations, no next steps: אין במערכת מידע תומך לשאלה זו.'
              },
              { role: 'user', content: `Context:\n${context.slice(0, 12000)}\n\nQuestion: ${query}` },
            ],
            max_tokens: 800,
            temperature: 0.3,
          },
          { headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' }, timeout: 60000 }
        );
        answer = res.data?.choices?.[0]?.message?.content?.trim() || null;
      } catch (e) {
        console.warn('[RAG] OpenAI answer failed:', e.message);
      }
    }

    return {
      query,
      results,
      results_count: results.length,
      answer,
      context: context.slice(0, 6000),
    };
  }

  async getAllFilenames() {
    return this.vectorStore.getAllFilenames();
  }

  async getFullTextForFile(filename) {
    if (!filename || !String(filename).trim()) return null;
    let text = await this.vectorStore.getFullTextForFile(filename);
    if (text) return text;
    const base = path.basename(String(filename));
    if (base !== filename) return this.vectorStore.getFullTextForFile(base);
    return null;
  }

  async getCollectionInfo() {
    return this.vectorStore.getCollectionInfo();
  }
}

#!/usr/bin/env node
/**
 * Debug: why "לא נמצא תוכן במערכת עבור הקובץ שנבחר" when selecting a file?
 * Compares project_files.original_name (dropdown) vs management_vector metadata->>'filename',
 * runs a simulated search with file filter, and reports mismatches.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getRagService } from '../lib/ragService.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

function inspect(str) {
  if (str == null) return 'null';
  const s = String(str);
  const codes = [...s.slice(0, 80)].map(c => c.charCodeAt(0).toString(16)).join(' ');
  return { length: s.length, first80: s.slice(0, 80), charCodes: codes };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase env. Run from maneger-back.');
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    console.error('Missing POSTGRES_URL.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const rag = getRagService();

  console.log('=== 1) Filenames in project_files (what dropdown sends) ===');
  const { data: rows, error: e1 } = await supabase
    .from('project_files')
    .select('id, project_id, original_name, storage_path')
    .not('storage_path', 'is', null)
    .order('original_name');
  if (e1) {
    console.error('Supabase error:', e1.message);
    process.exit(1);
  }
  const projectNames = [...new Set((rows || []).map(r => r.original_name).filter(Boolean))];
  console.log('Count (unique original_name with storage_path):', projectNames.length);
  projectNames.slice(0, 15).forEach((n, i) => console.log(' ', i + 1, JSON.stringify(n)));

  console.log('\n=== 2) Filenames in management_vector (what RAG has) ===');
  const vectorNames = await rag.getAllFilenames();
  console.log('Count:', vectorNames.length);
  vectorNames.slice(0, 15).forEach((n, i) => console.log(' ', i + 1, JSON.stringify(n)));

  console.log('\n=== 3) Match: project_files name IN vector? ===');
  const inVector = new Set(vectorNames);
  const missing = projectNames.filter(p => !inVector.has(p));
  const matched = projectNames.filter(p => inVector.has(p));
  console.log('Matched (in both):', matched.length);
  console.log('Missing in vector (in dropdown but no RAG):', missing.length);
  if (missing.length) {
    missing.slice(0, 20).forEach(m => console.log('  MISSING:', JSON.stringify(m)));
  }

  console.log('\n=== 4) Exact string comparison (first missing vs first vector) ===');
  if (missing.length && vectorNames.length) {
    const a = missing[0];
    const b = vectorNames[0];
    console.log('project name === vector name?', a === b);
    console.log('project inspect:', inspect(a));
    console.log('vector inspect:', inspect(b));
  }

  console.log('\n=== 5) Simulate research/run with first project filename ===');
  const testName = projectNames[0] || vectorNames[0];
  if (!testName) {
    console.log('No filenames to test.');
    return;
  }
  const path = await import('path');
  const basename = path.basename(testName);
  const filenamesArray = basename !== testName ? [testName, basename] : [testName];
  const filterMetadata = { filenames: filenamesArray };
  console.log('Filter used:', JSON.stringify(filterMetadata, null, 2));
  const out = await rag.generateAnswer('מה התוכן?', 20, filterMetadata, false);
  console.log('Search results count:', out.results_count);
  if (out.results_count === 0) {
    console.log('-> This is why user sees "לא נמצא תוכן". Filter matches 0 rows.');
  } else {
    console.log('-> Search OK. First result filename:', out.results?.[0]?.metadata?.filename);
  }

  console.log('\n=== 6) Raw count in DB for this filename ===');
  const store = rag.vectorStore;
  const client = await store.pool.connect();
  try {
    const r = await client.query(
      `SELECT COUNT(*) AS c FROM ${store.tableName} WHERE metadata->>'filename' = $1`,
      [testName]
    );
    console.log('WHERE metadata->>\'filename\' =', JSON.stringify(testName), '=> count', r.rows[0].c);
    const r2 = await client.query(
      `SELECT DISTINCT metadata->>'filename' AS fn FROM ${store.tableName} WHERE metadata->>'filename' LIKE $1 LIMIT 5`,
      ['%' + basename]
    );
    console.log('WHERE filename LIKE %' + basename.slice(-30), '=>', r2.rows.map(x => x.fn));
  } finally {
    client.release();
  }

  console.log('\n=== 7) All vector filenames that contain part of first missing ===');
  if (missing.length) {
    const first = missing[0];
    const part = first.slice(0, 20);
    const r3 = await store.pool.connect().then(c => {
      return c.query(
        `SELECT DISTINCT metadata->>'filename' AS fn FROM ${store.tableName} WHERE metadata->>'filename' LIKE $1`,
        ['%' + part + '%']
      ).then(res => { c.release(); return res; });
    });
    console.log('Vector names containing', JSON.stringify(part), ':', r3.rows.length);
    r3.rows.forEach(x => console.log(' ', x.fn));
  }

  console.log('\n=== CONCLUSION ===');
  if (missing.length === 0) {
    console.log('All project files are in the vector store. If user still sees "לא נמצא תוכן", check that the frontend sends the exact same string as original_name.');
  } else {
    console.log('Files in dropdown but NOT indexed (user will get "no content" if they select these):', missing.length);
    console.log('Fix: run index script with supported extensions, or add support for their format (e.g. .pptx).');
    console.log('Current fix: dropdown now shows only indexed files (GET /api/rag/files).');
  }
  console.log('\nDone.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

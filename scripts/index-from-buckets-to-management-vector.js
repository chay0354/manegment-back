#!/usr/bin/env node
/**
 * Index all files from storage buckets into management_vector (RAG).
 * Does NOT use project_files – lists bucket objects directly.
 *
 * Buckets: manually-uploaded-sharepoint-files, manualy-uploded-sharepoint-files, sharepoint-files
 *
 * Usage: node scripts/index-from-buckets-to-management-vector.js
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, POSTGRES_URL, OPENAI_API_KEY
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getRagService } from '../lib/ragService.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

const BUCKETS = [
  'manually-uploaded-sharepoint-files',
  'manualy-uploded-sharepoint-files', // typo bucket name if it exists
  'sharepoint-files',
];

const RAG_EXTENSIONS = ['.pdf', '.docx', '.txt', '.doc', '.xlsx', '.xls'];

function hasRagExtension(name) {
  if (!name) return false;
  return RAG_EXTENSIONS.some(e => name.toLowerCase().endsWith(e));
}

function basename(path) {
  const s = String(path || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s || 'file';
}

async function listBucketRecursive(supabase, bucket, prefix = '') {
  const { data, error } = await supabase.storage.from(bucket).list(prefix, { limit: 500 });
  if (error) throw error;
  const files = [];
  const subdirs = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id) files.push({ path, name: item.name });
    else subdirs.push(path);
  }
  for (const sub of subdirs) {
    const nested = await listBucketRecursive(supabase, bucket, sub);
    files.push(...nested);
  }
  return files;
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing Supabase env.');
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    console.error('Missing POSTGRES_URL.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  let rag;
  try {
    rag = getRagService();
  } catch (e) {
    console.error('RAG init failed:', e.message);
    process.exit(1);
  }

  // Resolve encoded bucket paths to display names (Hebrew etc.). Try path, manual/+path, and path without manual/ prefix.
  let displayNamesMap = {};
  try {
    const { data } = await supabase.from('sharepoint_display_names').select('path, display_name');
    if (data) {
      for (const row of data) {
        if (!row.path || !row.display_name) continue;
        displayNamesMap[row.path] = row.display_name;
        if (row.path.startsWith('manual/')) displayNamesMap[row.path.slice(7)] = row.display_name;
        else displayNamesMap['manual/' + row.path] = row.display_name;
      }
    }
  } catch (_) {}

  console.log('=== Index from buckets → management_vector ===');
  console.log('Buckets:', BUCKETS.join(', '));
  console.log('');

  let totalOk = 0;
  let totalFail = 0;

  for (const bucket of BUCKETS) {
    let list;
    try {
      list = await listBucketRecursive(supabase, bucket, '');
    } catch (e) {
      console.warn(`Bucket "${bucket}" list error:`, e.message);
      continue;
    }
    const toIngest = list.filter(f => f.name !== '_mapping.json' && hasRagExtension(f.name));
    if (toIngest.length === 0) continue;
    console.log(`Bucket "${bucket}": ${toIngest.length} indexable files`);

    const isManualBucket = bucket.includes('manual');
    for (const { path, name } of toIngest) {
      const keyWithManual = 'manual/' + path;
      const displayName = displayNamesMap[path] || displayNamesMap[keyWithManual] || displayNamesMap['manual2/' + path] || name || basename(path) || 'file';
      try {
        const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(path);
        if (dlErr || !blob) {
          console.error('  Download failed:', path, dlErr?.message);
          totalFail++;
          continue;
        }
        const buffer = Buffer.from(await blob.arrayBuffer());
        const result = await rag.ingestBuffer(buffer, displayName);
        if (result?.success) {
          console.log('  OK:', displayName, '(' + (result.chunks_count || 0) + ' chunks)');
          totalOk++;
        } else {
          console.error('  Ingest failed:', displayName, result?.error);
          totalFail++;
        }
      } catch (e) {
        console.error('  Error:', path, e.message);
        totalFail++;
      }
    }
  }

  console.log('');
  console.log('Done. Indexed:', totalOk, 'Failed:', totalFail);
  if (totalOk > 0) {
    const info = await rag.getCollectionInfo();
    console.log('management_vector total documents:', info?.document_count ?? '?');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

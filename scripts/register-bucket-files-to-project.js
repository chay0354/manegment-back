#!/usr/bin/env node
/**
 * Register all files from storage buckets into project_files for a project, then index to management_vector.
 * So "הקבצים בפרויקט" and the RAG dropdown show all bucket files (with display names when in sharepoint_display_names).
 *
 * Buckets: manually-uploaded-sharepoint-files (path as manual/...), sharepoint-files (path as-is).
 * Encoded paths in buckets are resolved to display names via sharepoint_display_names.
 *
 * Usage: node scripts/register-bucket-files-to-project.js <projectId>
 *        node scripts/register-bucket-files-to-project.js --list   (list projects)
 *
 * Env: SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, POSTGRES_URL, OPENAI_API_KEY
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getRagService } from '../lib/ragService.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const MANUAL_TYPO_BUCKET = 'manualy-uploded-sharepoint-files';
const SHAREPOINT_BUCKET = 'sharepoint-files';
const MANUAL_PREFIX = 'manual';

const BUCKETS = [
  { name: MANUAL_BUCKET, prefix: MANUAL_PREFIX + '/' },
  { name: MANUAL_TYPO_BUCKET, prefix: 'manual2/' },
  { name: SHAREPOINT_BUCKET, prefix: '' },
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

  const projectId = process.argv[2];
  if (projectId === '--list' || projectId === '-l') {
    const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
    const { data: projects, error } = await supabase.from('projects').select('id, name').order('updated_at', { ascending: false }).limit(30);
    if (error) {
      console.error('Failed to list projects:', error.message);
      process.exit(1);
    }
    console.log('Projects (use id as argument):');
    (projects || []).forEach(p => console.log('  ', p.id, ' ', p.name || '(no name)'));
    return;
  }
  if (!projectId) {
    console.error('Usage: node scripts/register-bucket-files-to-project.js <projectId>');
    console.error('       node scripts/register-bucket-files-to-project.js --list');
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

  const displayNamesMap = {};
  try {
    const { data } = await supabase.from('sharepoint_display_names').select('path, display_name').eq('project_id', projectId);
    if (data) {
      for (const row of data) {
        if (!row.path || !row.display_name) continue;
        displayNamesMap[row.path] = row.display_name;
        if (row.path.startsWith('manual/')) displayNamesMap[row.path.slice(7)] = row.display_name;
        else displayNamesMap['manual/' + row.path] = row.display_name;
      }
    }
  } catch (_) {}
  console.log('Display names for project:', Object.keys(displayNamesMap).length);

  console.log('=== Register bucket files → project_files + management_vector ===');
  console.log('Project:', projectId);
  console.log('');

  let registered = 0;
  let indexed = 0;
  let skipped = 0;
  let errors = 0;

  for (const { name: bucket, prefix } of BUCKETS) {
    let list;
    try {
      list = await listBucketRecursive(supabase, bucket, '');
    } catch (e) {
      console.warn(`Bucket "${bucket}" list error:`, e.message);
      continue;
    }
    const toProcess = list.filter(f => f.name !== '_mapping.json' && hasRagExtension(f.name));
    if (toProcess.length === 0) continue;
    console.log(`Bucket "${bucket}": ${toProcess.length} files`);

    for (const { path, name } of toProcess) {
      const fullStoragePath = prefix ? prefix + path : path;
      const displayName = displayNamesMap[fullStoragePath] || displayNamesMap[path] || displayNamesMap['manual/' + path] || name || basename(path) || 'file';

      try {
        const { data: existing } = await supabase.from('project_files').select('id').eq('project_id', projectId).eq('storage_path', fullStoragePath).limit(1).maybeSingle();
        if (existing) {
          skipped++;
          continue;
        }

        const { data: blob, error: dlErr } = await supabase.storage.from(bucket).download(path);
        if (dlErr || !blob) {
          console.error('  Download failed:', path, dlErr?.message);
          errors++;
          continue;
        }

        const { data: row, error: insertErr } = await supabase.from('project_files').insert({
          project_id: projectId,
          original_name: displayName,
          storage_path: fullStoragePath,
          folder_display_name: null,
        }).select('id').single();

        if (insertErr) {
          console.error('  Insert failed:', displayName, insertErr.message);
          errors++;
          continue;
        }
        registered++;

        const buffer = Buffer.from(await blob.arrayBuffer());
        const result = await rag.ingestBuffer(buffer, displayName);
        if (result?.success) {
          indexed++;
          console.log('  OK:', displayName);
        } else {
          console.error('  Ingest failed:', displayName, result?.error);
        }
      } catch (e) {
        console.error('  Error:', path, e.message);
        errors++;
      }
    }
  }

  console.log('');
  console.log('Done. Registered:', registered, 'Indexed:', indexed, 'Skipped (already in project):', skipped, 'Errors:', errors);
  if (indexed > 0) {
    const info = await rag.getCollectionInfo();
    console.log('management_vector total documents:', info?.document_count ?? '?');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

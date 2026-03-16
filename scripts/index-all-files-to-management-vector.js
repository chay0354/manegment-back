#!/usr/bin/env node
/**
 * Index all files from "הקבצים בפרויקט" (project files in Supabase storage) into management_vector.
 * Processes every project and every project_file that has storage_path and a supported extension
 * (.pdf, .docx, .doc, .txt, .xlsx, .xls). No project or file is skipped.
 *
 * Usage:
 *   node scripts/index-all-files-to-management-vector.js           # all projects
 *   node scripts/index-all-files-to-management-vector.js <projectId>  # one project
 *   node scripts/index-all-files-to-management-vector.js --list    # list projects
 *
 * Env: .env in maneger-back
 *   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY (list files + download from buckets)
 *   - POSTGRES_URL (management DB for management_vector)
 *   - OPENAI_API_KEY (embeddings)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { getRagService } from '../lib/ragService.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const SHAREPOINT_BUCKET = 'sharepoint-files';
const MANUAL_PREFIX = 'manual';

const RAG_EXTENSIONS = ['.pdf', '.docx', '.txt', '.doc', '.xlsx', '.xls'];

function resolveBucketAndPath(path) {
  if (!path) return null;
  if (path.startsWith(MANUAL_PREFIX + '/')) {
    return { bucket: MANUAL_BUCKET, storagePath: path.slice(MANUAL_PREFIX.length + 1) };
  }
  return { bucket: SHAREPOINT_BUCKET, storagePath: path };
}

function hasRagExtension(name) {
  if (!name) return false;
  return RAG_EXTENSIONS.some(e => name.toLowerCase().endsWith(e));
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
    process.exit(1);
  }
  if (!process.env.POSTGRES_URL && !process.env.DATABASE_URL) {
    console.error('Missing POSTGRES_URL (or DATABASE_URL). Required for management_vector.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const projectId = process.argv[2];

  if (projectId === '--list' || projectId === '-l') {
    const { data: projects, error } = await supabase
      .from('projects')
      .select('id, name')
      .order('updated_at', { ascending: false })
      .limit(50);
    if (error) {
      console.error('Failed to list projects:', error.message);
      process.exit(1);
    }
    console.log('Projects (use id as argument to index one):');
    (projects || []).forEach(p => console.log('  ', p.id, ' ', p.name || '(no name)'));
    return;
  }

  console.log('=== Index project files → management_vector (management DB) ===');
  console.log('Source: Supabase storage (maneger)', (SUPABASE_URL || '').replace(/^https:\/\/([^.]+).*/, '$1'));
  console.log('Target: management_vector table');
  if (projectId) console.log('Project filter:', projectId);
  else console.log('Scope: all projects');
  console.log('');

  let rag;
  try {
    rag = getRagService();
  } catch (e) {
    console.error('RAG init failed:', e.message);
    process.exit(1);
  }

  const projectsToScan = projectId
    ? [{ id: projectId, name: projectId }]
    : await (async () => {
        const { data, error } = await supabase
          .from('projects')
          .select('id, name')
          .order('updated_at', { ascending: false });
        if (error) throw error;
        return data || [];
      })();

  if (projectId && projectsToScan.length === 0) {
    console.error('Project not found:', projectId);
    process.exit(1);
  }

  let totalOk = 0;
  let totalErr = 0;

  for (const project of projectsToScan) {
    const { data: files, error: listError } = await supabase
      .from('project_files')
      .select('id, original_name, storage_path')
      .eq('project_id', project.id);

    if (listError) {
      console.error('  Project', project.name || project.id, 'list error:', listError.message);
      continue;
    }

    const toIngest = (files || []).filter(
      f => f.storage_path && hasRagExtension(f.original_name)
    );
    if (toIngest.length === 0) continue;

    console.log('Project:', project.name || project.id, '–', toIngest.length, 'file(s)');

    for (const file of toIngest) {
      try {
        const resolved = resolveBucketAndPath(file.storage_path);
        if (!resolved) {
          console.error('  Skip (no path):', file.original_name);
          totalErr++;
          continue;
        }
        const { data: blob, error: dlError } = await supabase.storage
          .from(resolved.bucket)
          .download(resolved.storagePath);

        if (dlError || !blob) {
          console.error('  Download failed:', file.original_name, dlError?.message || 'No blob');
          totalErr++;
          continue;
        }

        const buffer = Buffer.from(await blob.arrayBuffer());
        const result = await rag.ingestBuffer(buffer, file.original_name);

        if (result?.success) {
          console.log('  OK:', file.original_name, '(' + (result.chunks_count || 0) + ' chunks)');
          totalOk++;
        } else {
          const errMsg = result?.error || 'Unknown';
          console.error('  Ingest failed:', file.original_name, errMsg);
          if (errMsg.includes('400') || errMsg.includes('OpenAI')) {
            console.error('    (Tip: file may have empty or unsupported content for embeddings; it was skipped.)');
          }
          totalErr++;
        }
      } catch (e) {
        console.error('  Error:', file.original_name, e.message);
        totalErr++;
      }
    }
  }

  console.log('');
  console.log('Done. Indexed:', totalOk, 'Failed:', totalErr);
  if (totalOk > 0) {
    const info = await rag.getCollectionInfo();
    console.log('management_vector total documents:', info?.document_count ?? '?');
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

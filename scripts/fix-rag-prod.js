#!/usr/bin/env node
/**
 * Fix production RAG: index all project files from maneger Supabase into production Matriya
 * so rag_documents is populated and "Ask Matriya" returns real answers.
 *
 * Usage:
 *   node scripts/fix-rag-prod.js https://matriya-back.vercel.app
 *   MATRIYA_PROD_URL=https://matriya-back.vercel.app node scripts/fix-rag-prod.js
 *
 * Env: .env in maneger-back (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY).
 *       Optional: MATRIYA_PROD_URL or pass as first arg.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';
import { spawn } from 'child_process';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MATRIYA_TARGET = (process.env.MATRIYA_PROD_URL || process.argv[2] || process.env.MATRIYA_BACK_URL || '').replace(/\/$/, '');

const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const SHAREPOINT_BUCKET = 'sharepoint-files';
const MANUAL_PREFIX = 'manual';
const MATRIYA_EXTENSIONS = ['.pdf', '.docx', '.txt', '.doc', '.xlsx', '.xls'];

function resolveBucketAndPath(path) {
  if (!path) return null;
  if (path.startsWith(MANUAL_PREFIX + '/')) {
    return { bucket: MANUAL_BUCKET, storagePath: path.slice(MANUAL_PREFIX.length + 1) };
  }
  return { bucket: SHAREPOINT_BUCKET, storagePath: path };
}

function hasMatriyaExtension(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return MATRIYA_EXTENSIONS.some(e => lower.endsWith(e));
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
    process.exit(1);
  }
  if (!MATRIYA_TARGET) {
    console.error('Missing Matriya URL. Pass as first arg or set MATRIYA_PROD_URL.');
    console.error('  Example: node scripts/fix-rag-prod.js https://matriya-back.vercel.app');
    process.exit(1);
  }

  console.log('=== Fix RAG production ===');
  console.log('Supabase:', (SUPABASE_URL || '').replace(/^https:\/\/([^.]+).*/, '$1'));
  console.log('Matriya (target):', MATRIYA_TARGET);
  console.log('');

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const { data: projects, error: projErr } = await supabase
    .from('projects')
    .select('id, name')
    .order('updated_at', { ascending: false });
  if (projErr) {
    console.error('Failed to list projects:', projErr.message);
    process.exit(1);
  }
  if (!projects?.length) {
    console.log('No projects found.');
    process.exit(0);
  }

  let totalOk = 0;
  let totalErr = 0;

  for (const project of projects) {
    const { data: files, error: listError } = await supabase
      .from('project_files')
      .select('id, original_name, storage_path')
      .eq('project_id', project.id);
    if (listError) {
      console.error('  Project', project.name || project.id, 'list error:', listError.message);
      continue;
    }
    const toIngest = (files || []).filter(
      f => f.storage_path && hasMatriyaExtension(f.original_name)
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
        const form = new FormData();
        form.append('file', buffer, { filename: file.original_name });
        const res = await axios.post(`${MATRIYA_TARGET}/ingest/file`, form, {
          timeout: 180000,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          headers: form.getHeaders()
        });
        if (res.data && res.data.success) {
          console.log('  OK:', file.original_name);
          totalOk++;
        } else {
          console.error('  Ingest failed:', file.original_name, res.data?.error || res.statusText);
          totalErr++;
        }
      } catch (e) {
        console.error('  Error:', file.original_name, e.response?.data?.error || e.message);
        totalErr++;
      }
    }
  }

  console.log('');
  console.log('=== Ingest done ===');
  console.log('Indexed:', totalOk, 'Failed:', totalErr);

  if (totalOk > 0) {
    console.log('');
    console.log('Waiting 5s for indexing to settle, then running prod check...');
    await new Promise(r => setTimeout(r, 5000));
    const managerUrl = process.env.MANAGER_URL || process.env.MANAGER_PROD_URL || 'https://manegment-back.vercel.app';
    const child = spawn('node', [join(__dirname, 'check-rag-prod.js'), managerUrl], {
      cwd: join(__dirname, '..'),
      stdio: 'inherit',
      env: { ...process.env, MANAGER_URL: managerUrl }
    });
    child.on('close', code => {
      if (code !== 0) {
        console.log('');
        console.log('If check still fails: in Vercel (matriya-back) set POSTGRES_URL to the same Supabase DB where rag_documents exists, and COLLECTION_NAME=rag_documents.');
      }
      process.exit(code || 0);
    });
  } else {
    console.log('No files were indexed. Add project files with storage_path (upload via app) then run again.');
    process.exit(totalErr > 0 ? 1 : 0);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

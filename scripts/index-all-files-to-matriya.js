#!/usr/bin/env node
/**
 * Index ALL project files (all projects) into Matriya's Supabase DB (rag_documents).
 * Files are read from maneger Supabase storage and sent to Matriya ingest; Matriya
 * writes to its POSTGRES_URL (Supabase). So the DB that gets populated is the one
 * configured in the Matriya you target.
 *
 * Local only:  node scripts/index-all-files-to-matriya.js
 * Prod only:   node scripts/index-all-files-to-matriya.js https://matriya-back.vercel.app
 * Both:        node scripts/index-all-files-to-matriya.js both
 *
 * Env: .env in maneger-back (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MATRIYA_BACK_URL).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const ARG = (process.argv[2] || '').toLowerCase();
const RUN_BOTH = ARG === 'both';
const MATRIYA_LOCAL = (process.env.MATRIYA_BACK_URL || 'http://localhost:8000').replace(/\/$/, '');
const MATRIYA_PROD = 'https://matriya-back.vercel.app';
const MATRIYA_TARGETS = RUN_BOTH ? [MATRIYA_LOCAL, MATRIYA_PROD] : [(process.argv[2] || process.env.MATRIYA_BACK_URL || MATRIYA_LOCAL).replace(/\/$/, '')];

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
  return MATRIYA_EXTENSIONS.some(e => name.toLowerCase().endsWith(e));
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
    process.exit(1);
  }
  if (!MATRIYA_TARGETS.length || !MATRIYA_TARGETS[0]) {
    console.error('Missing Matriya URL. Set MATRIYA_BACK_URL in .env or pass URL or "both".');
    process.exit(1);
  }

  console.log('=== Index all files to Matriya (Supabase rag_documents) ===');
  console.log('Source (maneger):', (SUPABASE_URL || '').replace(/^https:\/\/([^.]+).*/, '$1'));
  console.log('Target(s):', MATRIYA_TARGETS.join(', '));
  if (RUN_BOTH) console.log('(local + prod – both DBs will be populated)');
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
        let ok = true;
        for (const target of MATRIYA_TARGETS) {
          const form = new FormData();
          form.append('file', buffer, { filename: file.original_name });
          // Keep Matriya logical filename unique/stable across projects to avoid same-name overwrite loops.
          // server.js maps this to displayFilename via req.body.relative_path.
          form.append('relative_path', `${project.id}/${resolved.storagePath}`);
          try {
            const res = await axios.post(`${target}/ingest/file`, form, {
              timeout: 180000,
              maxContentLength: Infinity,
              maxBodyLength: Infinity,
              headers: form.getHeaders()
            });
            if (!res.data || !res.data.success) {
              console.error('  Ingest failed', target, file.original_name, res.data?.error || res.statusText);
              ok = false;
            }
          } catch (e) {
            console.error('  Error', target, file.original_name, e.response?.data?.error || e.message);
            ok = false;
          }
        }
        if (ok) {
          console.log('  OK:', file.original_name);
          totalOk++;
        } else {
          totalErr++;
        }
      } catch (e) {
        console.error('  Error:', file.original_name, e.response?.data?.error || e.message);
        totalErr++;
      }
    }
  }

  console.log('');
  console.log('=== Done ===');
  console.log('Indexed:', totalOk, 'Failed:', totalErr);
  if (totalOk > 0) {
    console.log('Ask Matriya should now return answers (local and/or prod). Refresh and try again.');
    if (!RUN_BOTH && MATRIYA_TARGETS[0] === MATRIYA_LOCAL) {
      console.log('To also populate production DB, run: node scripts/index-all-files-to-matriya.js https://matriya-back.vercel.app');
      console.log('Or run both in one go: node scripts/index-all-files-to-matriya.js both');
    }
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

/**
 * Copy ALL files from management Supabase storage buckets to Matriya (RAG ingest).
 * READ-ONLY on buckets: downloads each file and POSTs to Matriya /ingest/file. Does NOT delete anything.
 *
 * Requires: maneger-back .env with SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MATRIYA_BACK_URL
 * Run from maneger-back: node scripts/copy-management-buckets-to-matriya.js
 *
 * Uses 2 buckets: sharepoint-files, manually-uploaded-sharepoint-files
 * If you have a 3rd bucket, set BUCKET_3_NAME in .env (e.g. BUCKET_3_NAME=my-third-bucket)
 */

import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import FormData from 'form-data';
import axios from 'axios';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;
const MATRIYA_BACK_URL = (process.env.MATRIYA_BACK_URL || 'http://localhost:8000').replace(/\/$/, '');
const BUCKET_3_NAME = process.env.BUCKET_3_NAME || '';

const SHAREPOINT_BUCKET = 'sharepoint-files';
const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const MAPPING_KEY = '_mapping.json';
const INGEST_TIMEOUT_MS = 180000;

/** Load path -> display_name from sharepoint_display_names for nicer filenames in Matriya */
async function loadDisplayNamesMap(supabase) {
  const { data, error } = await supabase.from('sharepoint_display_names').select('path, display_name');
  if (error || !data) return {};
  const map = {};
  for (const row of data) {
    if (row.path && row.display_name) map[row.path] = row.display_name;
  }
  return map;
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

function basename(path) {
  const s = String(path || '');
  const i = s.lastIndexOf('/');
  return i >= 0 ? s.slice(i + 1) : s || 'file';
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in .env');
    process.exit(1);
  }
  if (!MATRIYA_BACK_URL) {
    console.error('Missing MATRIYA_BACK_URL in .env');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  const bucketNames = [SHAREPOINT_BUCKET, MANUAL_BUCKET];
  if (BUCKET_3_NAME) bucketNames.push(BUCKET_3_NAME);

  console.log('Buckets to copy from:', bucketNames.join(', '));
  console.log('Matriya ingest URL:', MATRIYA_BACK_URL + '/ingest/file');
  console.log('COPY ONLY – nothing will be deleted from buckets.\n');

  let displayNamesMap = {};
  try {
    displayNamesMap = await loadDisplayNamesMap(supabase);
    console.log('Display names loaded:', Object.keys(displayNamesMap).length, 'entries\n');
  } catch (e) {
    console.warn('Could not load display names (using path basename):', e.message);
  }

  let totalOk = 0;
  let totalFail = 0;
  const failed = [];

  for (const bucket of bucketNames) {
    let list;
    try {
      list = await listBucketRecursive(supabase, bucket, '');
    } catch (e) {
      console.error(`Bucket ${bucket} list error:`, e.message);
      continue;
    }
    const files = list.filter((f) => f.path !== MAPPING_KEY && f.name !== MAPPING_KEY);
    console.log(`Bucket "${bucket}": ${files.length} files`);

    for (const { path, name } of files) {
      const displayName = displayNamesMap[path] || name || basename(path) || 'file';
      try {
        const { data: blob, error: downloadError } = await supabase.storage.from(bucket).download(path);
        if (downloadError || !blob) {
          failed.push({ bucket, path, error: downloadError?.message || 'No data' });
          totalFail++;
          continue;
        }
        const buffer = Buffer.from(await blob.arrayBuffer());
        const form = new FormData();
        form.append('file', buffer, { filename: displayName });

        const res = await axios.post(`${MATRIYA_BACK_URL}/ingest/file`, form, {
          timeout: INGEST_TIMEOUT_MS,
          maxContentLength: Infinity,
          maxBodyLength: Infinity,
          headers: form.getHeaders(),
          validateStatus: () => true
        });

        if (res.status === 200 && res.data?.success) {
          totalOk++;
          console.log(`  OK: ${path} -> Matriya`);
        } else {
          const errMsg = res.data?.error || res.statusText || res.status;
          failed.push({ bucket, path, error: errMsg });
          totalFail++;
          console.log(`  FAIL: ${path} - ${errMsg}`);
        }
      } catch (e) {
        failed.push({ bucket, path, error: e.message });
        totalFail++;
        console.log(`  FAIL: ${path} - ${e.message}`);
      }
    }
  }

  console.log('\nDone.');
  console.log(`Copied to Matriya: ${totalOk}`);
  console.log(`Failed: ${totalFail}`);
  if (failed.length) {
    console.log('Failed items:', JSON.stringify(failed, null, 2));
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

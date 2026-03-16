/**
 * Index all project files for a given project into Matriya (re-ingest).
 * Usage: node scripts/index-project-files-to-matriya.js <projectId>
 *        node scripts/index-project-files-to-matriya.js --list   (list projects)
 * Env: .env in maneger-back (SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, MATRIYA_BACK_URL)
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import FormData from 'form-data';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MATRIYA_BACK_URL = (process.env.MATRIYA_BACK_URL || '').replace(/\/$/, '');

const SHAREPOINT_BUCKET = 'sharepoint-files';
const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const MANUAL_PREFIX = 'manual';

const MATRIYA_EXTENSIONS = ['.pdf', '.docx', '.txt', '.doc', '.xlsx', '.xls'];

function resolveBucketAndPath(path) {
  if (path.startsWith(MANUAL_PREFIX + '/')) {
    return { bucket: MANUAL_BUCKET, storagePath: path.slice(MANUAL_PREFIX.length + 1) };
  }
  return { bucket: SHAREPOINT_BUCKET, storagePath: path };
}

function hasMatriyaExtension(name) {
  const ext = (name || '').toLowerCase().replace(/^.*\./, '');
  return MATRIYA_EXTENSIONS.some(e => e.slice(1) === ext) || (name && MATRIYA_EXTENSIONS.some(e => name.toLowerCase().endsWith(e)));
}

async function main() {
  const projectId = process.argv[2];
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
    process.exit(1);
  }
  if (!MATRIYA_BACK_URL) {
    console.error('Missing MATRIYA_BACK_URL in .env.');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

  if (projectId === '--list' || projectId === '-l') {
    const { data: projects, error } = await supabase.from('projects').select('id, name').order('updated_at', { ascending: false }).limit(20);
    if (error) {
      console.error('Failed to list projects:', error.message);
      process.exit(1);
    }
    console.log('Projects (use id as first argument):');
    (projects || []).forEach(p => console.log(' ', p.id, ' ', p.name || '(no name)'));
    return;
  }

  if (!projectId) {
    console.error('Usage: node scripts/index-project-files-to-matriya.js <projectId>');
    console.error('       node scripts/index-project-files-to-matriya.js --list');
    process.exit(1);
  }

  const { data: files, error: listError } = await supabase
    .from('project_files')
    .select('id, original_name, storage_path')
    .eq('project_id', projectId);

  if (listError) {
    console.error('Failed to list project files:', listError.message);
    process.exit(1);
  }

  const withStorage = (files || []).filter(f => f.storage_path);
  const withoutStorage = (files || []).filter(f => !f.storage_path);
  if (withoutStorage.length) {
    console.log('Skipping', withoutStorage.length, 'file(s) without storage_path:', withoutStorage.map(f => f.original_name).join(', '));
  }

  const toIngest = withStorage.filter(f => hasMatriyaExtension(f.original_name));
  const skipExt = withStorage.filter(f => !hasMatriyaExtension(f.original_name));
  if (skipExt.length) {
    console.log('Skipping', skipExt.length, 'file(s) (type not supported by Matriya):', skipExt.map(f => f.original_name).join(', '));
  }

  if (toIngest.length === 0) {
    console.log('No files to index (PDF, DOCX, TXT, DOC, XLSX, XLS with storage_path).');
    return;
  }

  console.log('Indexing', toIngest.length, 'file(s) to Matriya...');
  let ok = 0;
  let err = 0;
  for (const file of toIngest) {
    try {
      const { bucket, storagePath } = resolveBucketAndPath(file.storage_path);
      const { data: blob, error: dlError } = await supabase.storage.from(bucket).download(storagePath);
      if (dlError || !blob) {
        console.error('  Download failed:', file.original_name, dlError?.message || 'No blob');
        err++;
        continue;
      }
      const buffer = Buffer.from(await blob.arrayBuffer());
      const form = new FormData();
      form.append('file', buffer, { filename: file.original_name });
      const res = await axios.post(`${MATRIYA_BACK_URL}/ingest/file`, form, {
        timeout: 180000,
        maxContentLength: Infinity,
        maxBodyLength: Infinity,
        headers: form.getHeaders()
      });
      if (res.data && res.data.success) {
        console.log('  OK:', file.original_name);
        ok++;
      } else {
        console.error('  Ingest failed:', file.original_name, res.data?.error || res.statusText);
        err++;
      }
    } catch (e) {
      console.error('  Error:', file.original_name, e.response?.data?.error || e.message);
      err++;
    }
  }
  console.log('Done. Indexed:', ok, 'Failed:', err);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

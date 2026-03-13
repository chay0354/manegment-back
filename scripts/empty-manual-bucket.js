/**
 * Remove ALL files and folders from bucket manually-uploaded-sharepoint-files.
 * Run from maneger-back: node scripts/empty-manual-bucket.js
 * Uses .env SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (or NEXT_PUBLIC_*).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const BUCKET = 'manually-uploaded-sharepoint-files';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function listAllFilePaths(prefix = '', depth = 0, maxDepth = 20) {
  if (depth > maxDepth) return [];
  const { data, error } = await supabase.storage.from(BUCKET).list(prefix, { limit: 1000 });
  if (error) {
    console.warn('List error at', prefix || '(root)', error.message);
    return [];
  }
  const paths = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id != null) {
      paths.push(path);
    } else {
      const nested = await listAllFilePaths(path, depth + 1, maxDepth);
      paths.push(...nested);
    }
  }
  return paths;
}

async function main() {
  console.log('Bucket:', BUCKET);
  console.log('Listing all files...');
  const paths = await listAllFilePaths('');
  console.log('Total files to remove:', paths.length);
  if (paths.length === 0) {
    console.log('Bucket is already empty.');
    process.exit(0);
  }
  const batchSize = 100;
  let removed = 0;
  for (let i = 0; i < paths.length; i += batchSize) {
    const chunk = paths.slice(i, i + batchSize);
    const { error } = await supabase.storage.from(BUCKET).remove(chunk);
    if (error) {
      console.error('Remove error:', error.message);
      process.exit(1);
    }
    removed += chunk.length;
    console.log('Removed', removed, '/', paths.length);
  }
  console.log('Done. Removed', paths.length, 'files from', BUCKET);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

/**
 * Remove all files from sharepoint-files bucket that were created in the last 24 hours.
 * Run from maneger-back: node scripts/remove-recent-bucket-files.js
 * Uses server time; optionally set CUTOFF_ISO env to a specific time (e.g. 2026-03-10T09:53:00.000Z).
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SHAREPOINT_BUCKET = 'sharepoint-files';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function listAllFilesWithMeta(prefix = '', depth = 0, maxDepth = 10) {
  if (depth > maxDepth) return [];
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).list(prefix, { limit: 1000 });
  if (error) {
    console.warn('List error at', prefix, error.message);
    return [];
  }
  const out = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id != null) {
      const created = item.created_at ? new Date(item.created_at).getTime() : 0;
      out.push({ path, created_at: item.created_at, createdMs: created });
    } else {
      const nested = await listAllFilesWithMeta(path, depth + 1, maxDepth);
      out.push(...nested);
    }
  }
  return out;
}

async function main() {
  const cutoffISO = process.env.CUTOFF_ISO;
  const cutoffMs = cutoffISO
    ? new Date(cutoffISO).getTime() - 24 * 60 * 60 * 1000
    : Date.now() - 24 * 60 * 60 * 1000;
  const cutoffDate = new Date(cutoffMs);

  console.log('Bucket:', SHAREPOINT_BUCKET);
  console.log('Removing files created after (last 24h cutoff):', cutoffDate.toISOString());
  console.log('Israel time (approx):', cutoffDate.toLocaleString('en-IL', { timeZone: 'Asia/Jerusalem' }));
  console.log('');

  const all = await listAllFilesWithMeta('');
  const toRemove = all.filter(f => f.createdMs >= cutoffMs && f.createdMs > 0);
  const noDate = all.filter(f => f.createdMs <= 0);

  if (noDate.length > 0) console.log('(Files without created_at:', noDate.length, '- skipped)');
  console.log('Total files in bucket:', all.length);
  console.log('Files created in last 24h (to remove):', toRemove.length);

  if (toRemove.length === 0) {
    console.log('Nothing to remove.');
    process.exit(0);
  }

  toRemove.forEach(f => console.log('  -', f.path));

  const paths = toRemove.map(f => f.path);
  const batch = 100;
  for (let i = 0; i < paths.length; i += batch) {
    const chunk = paths.slice(i, i + batch);
    const { error } = await supabase.storage.from(SHAREPOINT_BUCKET).remove(chunk);
    if (error) {
      console.error('Remove error:', error.message);
      process.exit(1);
    }
    console.log('Removed', chunk.length, 'files.');
  }
  console.log('Done. Removed', paths.length, 'files.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

/**
 * Check sharepoint-files bucket and _mapping.json; fix only corrupted/empty display names (never overwrites valid names, e.g. Hebrew).
 * Run from maneger-back: node scripts/check-and-fix-bucket-display-names.js
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SHAREPOINT_BUCKET = 'sharepoint-files';
const MAPPING_KEY = '_mapping.json';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function getBucketNameMapping() {
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).download(MAPPING_KEY);
  if (error || !data) return {};
  try {
    const text = await data.text();
    return JSON.parse(text) || {};
  } catch (e) {
    console.warn('Could not parse _mapping.json:', e.message);
    return {};
  }
}

async function listBucketRecursive(prefix = '') {
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).list(prefix, { limit: 500 });
  if (error) {
    console.error('list error for prefix', prefix, error.message);
    throw error;
  }
  const files = [];
  const subdirs = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    if (item.id != null) files.push({ path, name: item.name });
    else subdirs.push(path);
  }
  if (subdirs.length) {
    const nested = await Promise.all(subdirs.map(p => listBucketRecursive(p)));
    nested.forEach(arr => files.push(...arr));
  }
  return files;
}

async function saveBucketNameMapping(mapping) {
  const json = JSON.stringify(mapping || {}, null, 0);
  const { error } = await supabase.storage.from(SHAREPOINT_BUCKET).upload(MAPPING_KEY, Buffer.from(json, 'utf8'), { contentType: 'application/json', upsert: true });
  if (error) throw error;
}

async function main() {
  console.log('Bucket:', SHAREPOINT_BUCKET);
  console.log('Listing all files...');
  const files = await listBucketRecursive('');
  console.log('Total files in bucket:', files.length);
  if (files.length === 0) {
    console.log('Bucket is empty. Nothing to fix.');
    return;
  }

  files.forEach(f => console.log('  -', f.path));

  console.log('\nLoading _mapping.json...');
  const mapping = await getBucketNameMapping();
  const beforeCount = Object.keys(mapping).length;
  console.log('Current mapping entries:', beforeCount);

  const filePathSet = new Set(files.map(f => f.path));
  const merged = { ...mapping };
  let added = 0;
  let fixed = 0;

  function isCorruptedOrEmpty(displayName) {
    if (displayName == null || typeof displayName !== 'string') return true;
    const s = displayName.trim();
    if (s === '' || s === '_') return true;
    if (/[\uFFFD\u00A4¢]/.test(s)) return true;
    if (/[\x00-\x08\x0B\x0C\x0E-\x1F]/.test(s)) return true;
    return false;
  }

  function friendlyFileLabel(path) {
    const ext = path.includes('.') ? path.slice(path.lastIndexOf('.')) : '';
    return ext ? `קובץ${ext}` : 'קובץ';
  }

  for (const [path, displayName] of Object.entries(merged)) {
    if (isCorruptedOrEmpty(displayName)) {
      merged[path] = filePathSet.has(path) ? friendlyFileLabel(path) : 'תיקייה';
      fixed++;
    }
  }

  for (const f of files) {
    const pParts = f.path.split('/').filter(Boolean);
    for (let i = 0; i < pParts.length; i++) {
      const prefix = pParts.slice(0, i + 1).join('/');
      const isFile = i === pParts.length - 1 && prefix === f.path;
      if (prefix && (merged[prefix] == null || merged[prefix] === '' || isCorruptedOrEmpty(merged[prefix]))) {
        merged[prefix] = isFile ? friendlyFileLabel(prefix) : 'תיקייה';
        added++;
      }
    }
    if (merged[f.path] == null || merged[f.path] === '' || isCorruptedOrEmpty(merged[f.path])) {
      merged[f.path] = friendlyFileLabel(f.path);
      added++;
    }
  }

  if (added === 0 && fixed === 0) {
    console.log('All paths have valid display names. No change.');
    return;
  }

  if (fixed > 0) console.log('Fixed', fixed, 'corrupted or empty display name(s) (replaced with Hebrew labels).');
  if (added > 0) console.log('Added', added, 'missing path(s) to mapping.');
  await saveBucketNameMapping(merged);
  console.log('Saved _mapping.json. Total entries:', Object.keys(merged).length);
  console.log('Done. Refresh the SharePoint bucket list in the app.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

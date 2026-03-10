/**
 * Check bucket: list folder_1, folder_2, ... under a project and show files inside each.
 * Run from maneger-back: node scripts/check-bucket-path.js [project-path]
 * Example: node scripts/check-bucket-path.js "project_e07c2377-9d92-4a94-8ff6-3ef6f1a24d26"
 * Or a single folder: node scripts/check-bucket-path.js "project_xxx/folder_1"
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

async function listAtPrefix(prefix) {
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).list(prefix, { limit: 500 });
  if (error) return { error: error.message, items: [] };
  return { items: data || [] };
}

async function listAllUnderPrefix(prefix, depth = 0, maxDepth = 5) {
  if (depth > maxDepth) return [];
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).list(prefix, { limit: 500 });
  if (error) return [];
  const out = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    out.push({ path, file: item.id != null });
    if (item.id == null && depth < maxDepth) {
      const nested = await listAllUnderPrefix(path, depth + 1, maxDepth);
      out.push(...nested);
    }
  }
  return out;
}

async function main() {
  const pathArg = process.argv[2] || 'project_e07c2377-9d92-4a94-8ff6-3ef6f1a24d26';
  const prefix = pathArg.replace(/^\/+/, '').replace(/\/+$/, '');

  console.log('Bucket:', SHAREPOINT_BUCKET);
  console.log('Supabase project:', (SUPABASE_URL || '').replace(/^https:\/\/([^.]+).*/, '$1'));
  console.log('Checking path:', prefix || '(root)');
  console.log('');

  const { items, error } = await listAtPrefix(prefix || '');
  if (error) {
    console.log('Result: NOT FOUND or error');
    console.log('Error:', error);
    process.exit(1);
  }

  if (items.length === 0) {
    console.log('Result: FOLDER NOT FOUND or empty');
    console.log('The path may not exist in the bucket.');
    process.exit(1);
  }

  const filesHere = items.filter(i => i.id != null);
  const subfolders = items.filter(i => i.id == null).sort((a, b) => String(a.name).localeCompare(String(b.name)));

  if (subfolders.length > 0) {
    console.log('Result: Project folder found. Numbered folders: folder_1, folder_2, ...');
    console.log('');
    for (const sf of subfolders) {
      const folderPath = prefix ? `${prefix}/${sf.name}` : sf.name;
      const { items: inside } = await listAtPrefix(folderPath);
      const fileList = (inside || []).filter(i => i.id != null);
      console.log(sf.name + '/');
      console.log('  Files inside:', fileList.length);
      fileList.forEach(f => console.log('    -', f.name));
      console.log('');
    }
    if (filesHere.length > 0) {
      console.log('Files at project root:', filesHere.length);
      filesHere.forEach(f => console.log('  -', f.name));
    }
  } else {
    console.log('Result: FOLDER FOUND (single folder)');
    console.log('Path (folder):', prefix);
    console.log('Files inside:', filesHere.length);
    filesHere.forEach(f => console.log('  -', f.name));
  }
  console.log('Done.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

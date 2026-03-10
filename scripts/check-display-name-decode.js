/**
 * Check why a storage path (e.g. 77a36d3c.txt) doesn't "decode" to the Hebrew/English display name in the UI.
 * Run from maneger-back: node scripts/check-display-name-decode.js [path]
 * Example: node scripts/check-display-name-decode.js 77a36d3c.txt
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const MANUAL_BUCKET = 'manually-uploaded-sharepoint-files';
const MANUAL_PREFIX = 'manual';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

// Same as server: path is manual bucket ASCII path
function isManualAsciiPath(path) {
  const s = typeof path === 'string' ? path.trim() : '';
  return s.length > 0 && /^[a-zA-Z0-9]+(\.[a-zA-Z0-9]+)?(\/[a-zA-Z0-9._-]+)?$/.test(s);
}

async function main() {
  const storagePath = process.argv[2] || '77a36d3c.txt';
  console.log('=== Check display name decode for:', storagePath, '===\n');

  // 1) Is this path considered a valid manual path by the backend?
  const pathValid = isManualAsciiPath(storagePath);
  console.log('1) isManualAsciiPath("' + storagePath + '"):', pathValid);
  if (!pathValid) {
    console.log('   -> Backend would NOT save/use display name for this path (regex mismatch).\n');
  } else {
    console.log('   -> Backend would accept this path for display name save/lookup.\n');
  }

  // 2) Query sharepoint_display_names for this path (exact) and similar
  console.log('2) sharepoint_display_names table:');
  const { data: rowsExact, error: errExact } = await supabase
    .from('sharepoint_display_names')
    .select('project_id, path, display_name, updated_at')
    .eq('path', storagePath);
  if (errExact) {
    console.log('   Error (exact path):', errExact.message);
  } else {
    console.log('   Rows where path = "' + storagePath + '":', (rowsExact || []).length);
    if ((rowsExact || []).length > 0) {
      rowsExact.forEach((r, i) => console.log('   ', i + 1, 'project_id:', r.project_id, '| display_name:', JSON.stringify(r.display_name), '| updated_at:', r.updated_at));
    } else {
      console.log('   No row found. Display name was never saved for this path.');
    }
  }

  // Also list all rows that contain the path segment (in case path is stored with folder)
  const pathSegment = storagePath.split('/').pop();
  const { data: rowsAll } = await supabase
    .from('sharepoint_display_names')
    .select('project_id, path, display_name')
    .ilike('path', '%' + pathSegment + '%');
  if ((rowsAll || []).length > 0 && (rowsExact || []).length === 0) {
    console.log('   Other rows containing "' + pathSegment + '":');
    rowsAll.forEach((r) => console.log('     path:', r.path, '| display_name:', JSON.stringify(r.display_name)));
  }
  console.log('');

  // 3) Key the list API uses: manual/ + path
  const listApiKey = MANUAL_PREFIX + '/' + storagePath;
  console.log('3) List API displayNamesMap key for this file:', JSON.stringify(listApiKey));
  console.log('   (Backend sets displayNamesMap["' + listApiKey + '"] = display_name from DB path "' + storagePath + '")\n');

  // 4) Does the file exist in the manual bucket?
  console.log('4) Manual bucket "' + MANUAL_BUCKET + '":');
  const hasSlash = storagePath.includes('/');
  const prefix = hasSlash ? storagePath.slice(0, storagePath.lastIndexOf('/')) : '';
  const listPrefix = prefix || '';
  const { data: listData, error: listErr } = await supabase.storage.from(MANUAL_BUCKET).list(listPrefix, { limit: 100 });
  if (listErr) {
    console.log('   Error listing:', listErr.message);
  } else {
    const names = (listData || []).map((i) => i.name);
    const hasFile = hasSlash
      ? names.some((n) => n === storagePath.split('/').pop())
      : names.some((n) => n === storagePath);
    console.log('   File present at path:', hasFile ? 'YES' : 'NO');
    if (!hasFile && names.length > 0) console.log('   Sample names in bucket:', names.slice(0, 10).join(', '));
  }
  console.log('');

  // 5) Summary
  console.log('5) Summary:');
  const hasRow = (rowsExact || []).length > 0;
  if (!pathValid) {
    console.log('   - Path format was invalid (fixed in server isManualAsciiPath). New uploads will save.');
  }
  if (!hasRow) {
    console.log('   - No display_name row for path "' + storagePath + '". UI will show "קובץ.txt" or the ASCII path.');
    console.log('   - Fix: re-upload the file so a row is saved, or insert a row manually for this path.');
  } else {
    console.log('   - Display name in DB:', JSON.stringify(rowsExact[0].display_name));
    console.log('   - For project_id', rowsExact[0].project_id, 'the list API should show this name in the UI.');
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

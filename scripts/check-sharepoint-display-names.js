/**
 * Diagnostic: check sharepoint_display_names table and bucket paths.
 * Run from maneger-back: node scripts/check-sharepoint-display-names.js
 * Use: after uploading files with a folder name, run this to see if table exists, is writable, and what paths exist in the bucket.
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const SHAREPOINT_BUCKET = 'sharepoint-files';
const PROJECT_PREFIX = 'project_';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY. Run from maneger-back with .env.');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

async function listBucketAtPrefix(prefix) {
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).list(prefix, { limit: 100 });
  if (error) return { error: error.message, items: [] };
  return { items: data || [] };
}

async function listBucketRecursive(prefix = '', maxDepth = 3, depth = 0) {
  if (depth > maxDepth) return [];
  const { data, error } = await supabase.storage.from(SHAREPOINT_BUCKET).list(prefix, { limit: 500 });
  if (error) return [];
  const out = [];
  for (const item of data || []) {
    const path = prefix ? `${prefix}/${item.name}` : item.name;
    out.push(path);
    if (item.id == null && depth < maxDepth) {
      const nested = await listBucketRecursive(path, maxDepth, depth + 1);
      out.push(...nested);
    }
  }
  return out;
}

async function main() {
  console.log('=== SharePoint display names diagnostic ===\n');

  // 1) Table exists and is readable?
  console.log('1) Table sharepoint_display_names:');
  const { data: rows, error: selectErr } = await supabase.from('sharepoint_display_names').select('id, project_id, path, display_name').limit(5);
  if (selectErr) {
    console.log('   FAIL:', selectErr.message);
    console.log('   Hint: Run the migration 005_sharepoint_display_names.sql in Supabase SQL Editor if the table is missing.\n');
  } else {
    console.log('   OK (readable). Row count (first 5):', (rows || []).length);
    if ((rows || []).length > 0) console.log('   Sample:', rows);
    console.log('');
  }

  // 2) Get a project_id and test write
  const { data: projects } = await supabase.from('projects').select('id').limit(1);
  const projectId = projects?.[0]?.id;
  if (!projectId) {
    console.log('2) No project found in DB. Create a project first.\n');
  } else {
    console.log('2) Using project_id:', projectId);
    const testPath = 'folder 999_test';
    const testDisplay = 'TestFolder';
    const { error: upsertErr } = await supabase.from('sharepoint_display_names').upsert(
      { project_id: projectId, path: testPath, display_name: testDisplay, updated_at: new Date().toISOString() },
      { onConflict: 'project_id,path' }
    );
    if (upsertErr) {
      console.log('   Upsert test FAIL:', upsertErr.message);
    } else {
      console.log('   Upsert test OK (wrote path "' + testPath + '" -> "' + testDisplay + '")');
      await supabase.from('sharepoint_display_names').delete().eq('project_id', projectId).eq('path', testPath);
    }
    console.log('');
  }

  // 3) Bucket: any paths under project_* ?
  console.log('3) Bucket paths under "project_*":');
  const { data: topLevel } = await supabase.storage.from(SHAREPOINT_BUCKET).list('', { limit: 500 });
  const projectPrefixes = (topLevel || []).filter(i => i.name && i.name.startsWith(PROJECT_PREFIX)).map(i => i.name);
  if (projectPrefixes.length === 0) {
    console.log('   No project_* folders found in bucket.');
    console.log('   So either no upload used "folder name" yet, or uploads go to a different path.');
  } else {
    console.log('   Found', projectPrefixes.length, 'project prefix(es):', projectPrefixes.slice(0, 10).join(', '));
    for (const pre of projectPrefixes.slice(0, 3)) {
      const { items } = await listBucketAtPrefix(pre);
      console.log('   Under', pre + '/:', items.length, 'items');
    }
  }
  console.log('');

  // 4) What the backend expects
  console.log('4) Backend expectation:');
  console.log('   - When user enters a folder name and uploads, signed-urls returns paths like:');
  console.log('     "' + PROJECT_PREFIX + '<projectId>/folder_1/file_1.pdf"');
  console.log('   - Frontend then calls update-display-names with body:');
  console.log('     { mappings: { "<that path>": "<folder name>/<file name>" } }');
  console.log('   - Backend prefix for this project would be: "' + PROJECT_PREFIX + (projectId || '?') + '/"');
  console.log('   - If mappings keys do not start with that prefix, no row is written.');
  console.log('');

  // 5) Current table content
  const { data: allRows } = await supabase.from('sharepoint_display_names').select('project_id, path, display_name').order('path');
  console.log('5) All rows in sharepoint_display_names:', (allRows || []).length);
  if ((allRows || []).length > 0) {
    allRows.forEach(r => console.log('   ', r.project_id, '|', r.path, '|', r.display_name));
  }
  console.log('\n6) If you upload with a folder name:');
  console.log('   - Direct upload (Supabase env set): frontend calls signed-urls then update-display-names -> DB rows.');
  console.log('   - Multipart upload (fallback): backend now uses project_*/folder N/file M and writes to this table.');
  console.log('\nDone.');
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

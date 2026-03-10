/**
 * Test: upload a file to the manual bucket and ensure it "decodes" (display name saved and readable).
 * Run from maneger-back: node scripts/test-upload-and-decode.js
 */
import 'dotenv/config';
import crypto from 'crypto';
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

function randomAsciiId(len = 8) {
  return crypto.randomBytes(Math.ceil(len / 2)).toString('hex').slice(0, len);
}

async function main() {
  console.log('=== Test: upload file and verify decode ===\n');

  // 1) Get a project_id
  const { data: projects, error: projErr } = await supabase.from('projects').select('id').limit(1);
  if (projErr || !projects?.length) {
    console.error('Need at least one project in DB. Error:', projErr?.message || 'no projects');
    process.exit(1);
  }
  const projectId = projects[0].id;
  console.log('1) Using project_id:', projectId);

  // 2) Generate ASCII storage path and Hebrew display name (like backend)
  const storagePath = randomAsciiId(8) + '.txt';
  const displayName = 'מסמך בדיקה.txt'; // "Test document.txt" in Hebrew
  console.log('2) Storage path (ASCII):', storagePath);
  console.log('   Display name (Hebrew):', displayName);

  // 3) Upload file to bucket
  const testContent = 'Test upload for decode – ' + new Date().toISOString();
  const { error: uploadErr } = await supabase.storage
    .from(MANUAL_BUCKET)
    .upload(storagePath, Buffer.from(testContent, 'utf8'), { contentType: 'text/plain; charset=utf-8', upsert: true });
  if (uploadErr) {
    console.error('3) Upload FAIL:', uploadErr.message);
    process.exit(1);
  }
  console.log('3) Upload OK:', storagePath);

  // 4) Save display name (same as backend multipart / update-display-names)
  const { error: upsertErr } = await supabase.from('sharepoint_display_names').upsert(
    { project_id: projectId, path: storagePath, display_name: displayName, updated_at: new Date().toISOString() },
    { onConflict: 'project_id,path' }
  );
  if (upsertErr) {
    console.error('4) Display name upsert FAIL:', upsertErr.message);
    process.exit(1);
  }
  console.log('4) Display name saved OK');

  // 5) Verify decode: query DB and simulate list API key
  const { data: rows, error: selectErr } = await supabase
    .from('sharepoint_display_names')
    .select('path, display_name')
    .eq('project_id', projectId)
    .eq('path', storagePath);
  if (selectErr || !rows?.length) {
    console.error('5) Verify FAIL: row not found or error', selectErr?.message);
    process.exit(1);
  }
  const decoded = rows[0].display_name;
  const listApiKey = MANUAL_PREFIX + '/' + storagePath;
  console.log('5) Verify DB: path =', rows[0].path, '| display_name =', JSON.stringify(decoded));

  // 6) Simulate what the list API returns for displayNamesMap
  const displayNamesMap = {};
  displayNamesMap[listApiKey] = decoded;
  const uiWouldShow = displayNamesMap[listApiKey];
  const decodeOk = uiWouldShow === displayName;

  console.log('\n6) List API would set displayNamesMap["' + listApiKey + '"] =', JSON.stringify(uiWouldShow));
  console.log('   UI would show:', uiWouldShow);
  console.log('\n=== Result:', decodeOk ? 'PASS – file decodes to Hebrew name' : 'FAIL – decode mismatch');
  if (!decodeOk) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

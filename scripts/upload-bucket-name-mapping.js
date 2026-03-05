#!/usr/bin/env node
/**
 * Generate and upload _mapping.json to the sharepoint-files bucket.
 * Mapping: storage path -> original file name (Hebrew etc.) for display in maneger.
 * Run from the SAME local folder you used for upload-folder-to-bucket.js.
 *
 * Usage: node scripts/upload-bucket-name-mapping.js <path-to-folder> [bucket-name]
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { readdirSync } from 'fs';
import { join, relative } from 'path';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const folderPath = process.argv[2];
const bucketName = process.argv[3] || 'sharepoint-files';

if (!SUPABASE_URL || !SUPABASE_KEY || !folderPath) {
  console.error('Usage: node scripts/upload-bucket-name-mapping.js <path-to-folder> [bucket-name]');
  process.exit(1);
}

const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

function* walkFiles(dir, baseDir = dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) yield* walkFiles(full, baseDir);
    else yield { relativePath: relative(baseDir, full) };
  }
}

function safeStorageKey(relativePath) {
  const parts = relativePath.replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.map(p => p.replace(/[^\x00-\x7E.a-zA-Z0-9_-]/g, '_').replace(/\s+/g, '_').replace(/[()[\]]/g, '_') || 'file').join('/');
}

async function main() {
  const mapping = {};
  for (const { relativePath } of walkFiles(folderPath)) {
    const normalized = relativePath.replace(/\\/g, '/');
    const safePath = safeStorageKey(relativePath);
    const originalParts = normalized.split('/').filter(Boolean);
    const safeParts = safePath.split('/').filter(Boolean);
    const originalName = originalParts[originalParts.length - 1] || relativePath;
    mapping[safePath] = originalName;
    for (let i = 0; i < safeParts.length - 1; i++) {
      const safePrefix = safeParts.slice(0, i + 1).join('/');
      const originalFolderName = originalParts[i] || safePrefix;
      if (!mapping[safePrefix]) mapping[safePrefix] = originalFolderName;
    }
  }
  const json = JSON.stringify(mapping, null, 0);
  const { error } = await supabase.storage.from(bucketName).upload('_mapping.json', Buffer.from(json, 'utf8'), { contentType: 'application/json', upsert: true });
  if (error) {
    console.error('Upload failed:', error.message);
    process.exit(1);
  }
  console.log('Uploaded _mapping.json with', Object.keys(mapping).length, 'entries.');
}

main();

#!/usr/bin/env node
/**
 * GPT RAG: sync every project’s stored files to OpenAI (same logic as POST /api/projects/:id/gpt-rag/sync).
 *
 * With the API running, new uploads and successful local RAG ingests schedule a debounced rebuild (GPT_RAG_AUTO_SYNC_DEBOUNCE_MS in server.js).
 * Use this script for a full pass over all projects (CI/cron/migration) or when the server was offline during uploads.
 *
 * Uses Supabase service role + OPENAI_API_KEY from .env (same as maneger-back). No JWT needed.
 *
 * Usage (from maneger-back/):
 *   node scripts/sync-all-gpt-rag.js
 *   node scripts/sync-all-gpt-rag.js --dry-run
 *   node scripts/sync-all-gpt-rag.js --project=<uuid>
 *
 * npm: npm run sync:gpt-rag-all
 */
import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import { syncProjectGptRagToOpenAI, GPT_RAG_MAX_FILES, isProjectFileGptRagEligible } from '../lib/gptRagSync.js';

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL;
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
const OPENAI_API_KEY = (process.env.OPENAI_API_KEY || '').trim();
const OPENAI_API_BASE = (process.env.OPENAI_API_BASE || 'https://api.openai.com/v1').replace(/\/$/, '');

function argProjectId() {
  const a = process.argv.find((x) => x.startsWith('--project='));
  return a ? a.slice('--project='.length).trim() : null;
}
const dryRun = process.argv.includes('--dry-run');

async function countSyncableFiles(supabase, projectId) {
  const { data: files, error } = await supabase
    .from('project_files')
    .select('original_name, storage_path')
    .eq('project_id', projectId);
  if (error) return { n: 0, error: error.message };
  const n = (files || []).filter(isProjectFileGptRagEligible).length;
  return { n: Math.min(n, GPT_RAG_MAX_FILES), error: null };
}

async function main() {
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
    console.error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY');
    process.exit(1);
  }
  if (!OPENAI_API_KEY) {
    console.error('Missing OPENAI_API_KEY');
    process.exit(1);
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);
  const singleId = argProjectId();

  let query = supabase.from('projects').select('id, name').order('name');
  if (singleId) query = query.eq('id', singleId);
  const { data: projects, error: pErr } = await query;
  if (pErr) {
    console.error('Failed to list projects:', pErr.message);
    process.exit(1);
  }
  if (!projects?.length) {
    console.log(singleId ? `No project with id ${singleId}` : 'No projects.');
    process.exit(0);
  }

  console.log(`Projects to process: ${projects.length}${dryRun ? ' (dry-run)' : ''}\n`);

  const summary = { ok: 0, skip: 0, fail: 0 };

  for (const p of projects) {
    const label = `${p.name || '(no name)'} [${p.id}]`;
    const { n, error: cErr } = await countSyncableFiles(supabase, p.id);
    if (cErr) {
      console.log(`[FAIL] ${label} — count error: ${cErr}`);
      summary.fail++;
      continue;
    }
    if (n === 0) {
      console.log(`[SKIP] ${label} — no syncable files (need storage + supported extension)`);
      summary.skip++;
      continue;
    }
    if (dryRun) {
      console.log(`[DRY ] ${label} — would sync up to ${n} file(s)`);
      summary.ok++;
      continue;
    }

    console.log(`[SYNC] ${label} — syncing up to ${n} file(s)…`);
    const result = await syncProjectGptRagToOpenAI(supabase, p.id, {
      openaiApiKey: OPENAI_API_KEY,
      openaiBase: OPENAI_API_BASE,
      onLog: (msg) => console.log(`       ${msg}`)
    });
    if (!result.ok) {
      console.log(`[FAIL] ${label} — ${result.error}`);
      summary.fail++;
      continue;
    }
    console.log(`[ OK ] ${label} — uploaded ${result.uploaded}, vector_store_id=${result.vector_store_id}`);
    if (result.skipped?.length) console.log(`       skipped: ${result.skipped.length} item(s)`);
    summary.ok++;
  }

  console.log(
    `\nDone${dryRun ? ' (dry-run — no OpenAI calls)' : ''}. ${dryRun ? 'would sync' : 'synced'}: ${summary.ok}, skipped: ${summary.skip}, failed: ${summary.fail}`
  );
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

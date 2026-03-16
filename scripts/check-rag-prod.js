#!/usr/bin/env node
/**
 * Check that the "Ask Matriya" RAG flow (RagTab: question section, כל הקבצים, etc.) will work on production.
 *
 * Usage:
 *   node scripts/check-rag-prod.js
 *   MANAGER_URL=https://manegment-back.vercel.app node scripts/check-rag-prod.js
 *   node scripts/check-rag-prod.js https://manegment-back.vercel.app
 *
 * Uses MANAGER_URL (default from .env API base or first arg) to hit maneger-back; maneger-back proxies to MATRIYA_BACK_URL.
 * Writes results to scripts/check-rag-prod-result.txt (and logs to stdout).
 */

import 'dotenv/config';
import axios from 'axios';
import { writeFileSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

const MANAGER_URL = process.env.MANAGER_URL || process.argv[2] || 'http://localhost:8001';
const TIMEOUT = 15000;

const out = [];
function log(msg) {
  const line = typeof msg === 'string' ? msg : JSON.stringify(msg, null, 2);
  out.push(line);
  console.log(line);
}

async function main() {
  log('=== RAG production check ===');
  log(`Manager URL: ${MANAGER_URL}`);
  log('');

  const results = { health: null, session: null, run: null, summary: [] };

  // 1) RAG health (Matriya reachable from maneger)
  try {
    const r = await axios.get(`${MANAGER_URL}/api/rag/health`, { timeout: 5000 });
    results.health = r.data;
    if (r.data?.ok) {
      log('[OK] RAG health: Matriya is reachable from manager');
      results.summary.push('RAG health: OK');
    } else {
      log('[FAIL] RAG health: ' + (r.data?.error || 'ok=false'));
      results.summary.push('RAG health: FAIL - ' + (r.data?.error || 'ok=false'));
    }
  } catch (e) {
    results.health = { error: e.message, code: e.code };
    log('[FAIL] RAG health request failed: ' + (e.response?.data?.error || e.message));
    results.summary.push('RAG health: FAIL - ' + (e.message || e.code));
  }
  log('');

  // 2) Create research session (no auth; Matriya may allow it for server-side)
  try {
    const r = await axios.post(`${MANAGER_URL}/api/rag/research/session`, {}, { timeout: 10000 });
    const sessionId = r.data?.session_id || r.data?.id;
    results.session = sessionId ? { session_id: sessionId } : r.data;
    if (sessionId) {
      log('[OK] Research session created: ' + sessionId);
      results.summary.push('Research session: OK');

      // 3) Run a short research query (no filename = "כל הקבצים")
      try {
        const runRes = await axios.post(
          `${MANAGER_URL}/api/rag/research/run`,
          { session_id: sessionId, query: 'מה יש במערכת?', use_4_agents: true },
          { timeout: 60000 }
        );
        const data = runRes.data;
        const synthesis = (data?.outputs?.synthesis || '').trim();
        const hasAnswer = synthesis.length > 10;
        const isNoContentMessage =
          /לא נמצא תוכן במערכת|אינדוקס|טרם עובדו/.test(synthesis) ||
          /No document content was found|no content in the RAG/.test(synthesis);
        if (runRes.status === 200 && (data?.outputs || data?.run_id != null)) {
          log('[OK] Research run returned 200');
          if (isNoContentMessage) {
            log('[FAIL] Answer is the "no content" message – RAG has no documents in this environment');
            log('       Snippet: ' + synthesis.slice(0, 120) + '...');
            results.summary.push('Research run: FAIL – RAG empty (ingest files in prod or check POSTGRES_URL/rag_documents)');
          } else if (hasAnswer) {
            log('[OK] Got real synthesis text (' + synthesis.length + ' chars)');
            results.summary.push('Research run: OK (answer length ' + synthesis.length + ')');
          } else {
            log('[INFO] Synthesis empty or short (rag_documents may be empty – upload files to ingest)');
            results.summary.push('Research run: OK but no content (ingest files for answers)');
          }
          results.run = { run_id: data?.run_id, synthesis_length: synthesis.length, is_no_content: isNoContentMessage };
        } else {
          log('[FAIL] Research run unexpected response: ' + JSON.stringify(data).slice(0, 200));
          results.summary.push('Research run: unexpected response');
        }
      } catch (e) {
        const msg = e.response?.data?.error || e.message;
        log('[FAIL] Research run failed: ' + msg);
        results.summary.push('Research run: FAIL - ' + msg);
        results.run = { error: msg };
      }
    } else {
      log('[FAIL] No session_id in response: ' + JSON.stringify(r.data));
      results.summary.push('Research session: no session_id');
    }
  } catch (e) {
    if (e.response?.status === 401) {
      log('[INFO] Research session returned 401 – auth required (normal in prod; flow works from logged-in browser)');
      results.summary.push('Research session: 401 (use browser with login to test full flow)');
    } else {
      log('[FAIL] Research session failed: ' + (e.response?.data?.error || e.message));
      results.summary.push('Research session: FAIL - ' + (e.response?.data?.error || e.message));
    }
    results.session = { error: e.response?.data?.error || e.message };
  }

  log('');
  log('--- Summary ---');
  results.summary.forEach(s => log(s));

  const resultPath = join(__dirname, 'check-rag-prod-result.txt');
  writeFileSync(resultPath, out.join('\n'), 'utf8');
  log('');
  log('Written: ' + resultPath);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

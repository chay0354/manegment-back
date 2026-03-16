#!/usr/bin/env node
/**
 * Check that local and prod Matriya use the same DB (same db_fingerprint).
 * Usage: node scripts/check-same-db.js
 * Env: MATRIYA_LOCAL_URL (default http://localhost:8000), MATRIYA_PROD_URL (default https://matriya-back.vercel.app)
 */
import 'dotenv/config';
import axios from 'axios';

const LOCAL = process.env.MATRIYA_LOCAL_URL || 'http://localhost:8000';
const PROD = process.env.MATRIYA_PROD_URL || 'https://matriya-back.vercel.app';

async function main() {
  console.log('Local Matriya:', LOCAL);
  console.log('Prod Matriya:', PROD);
  console.log('');

  let localFingerprint = null;
  let prodFingerprint = null;
  let localCollection = null;
  let prodCollection = null;
  let localCount = null;
  let prodCount = null;

  try {
    const rLocal = await axios.get(`${LOCAL}/health`, { timeout: 5000 });
    localFingerprint = rLocal.data?.db_fingerprint ?? rLocal.data?.vector_db?.db_path;
    localCollection = rLocal.data?.collection_name ?? rLocal.data?.vector_db?.collection_name;
    localCount = rLocal.data?.vector_db?.document_count;
  } catch (e) {
    console.log('Local health failed:', e.message || e.code);
  }

  try {
    const rProd = await axios.get(`${PROD}/health`, { timeout: 10000 });
    prodFingerprint = rProd.data?.db_fingerprint ?? rProd.data?.vector_db?.db_path;
    prodCollection = rProd.data?.collection_name ?? rProd.data?.vector_db?.collection_name;
    prodCount = rProd.data?.vector_db?.document_count;
  } catch (e) {
    console.log('Prod health failed:', e.message || e.code);
  }

  console.log('Local  db_fingerprint:', localFingerprint ?? '(none)');
  console.log('Prod   db_fingerprint:', prodFingerprint ?? '(none)');
  console.log('Local  collection_name:', localCollection ?? '(none)');
  console.log('Prod   collection_name:', prodCollection ?? '(none)');
  console.log('Local  document_count:', localCount ?? '(none)');
  console.log('Prod   document_count:', prodCount ?? '(none)');
  console.log('');

  if (localFingerprint && prodFingerprint) {
    if (localFingerprint === prodFingerprint && (localCollection || '') === (prodCollection || '')) {
      console.log('OK: Same DB and collection – local and prod will see the same RAG data.');
    } else {
      console.log('MISMATCH: Different DB or collection. Set in Vercel (matriya-back) the same POSTGRES_URL and COLLECTION_NAME as in local .env. See matriya-back/SHARED-DB-SETUP.md');
      process.exit(1);
    }
  } else {
    console.log('Could not get both fingerprints (start local Matriya or check prod URL).');
    process.exit(1);
  }
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});

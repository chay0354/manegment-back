/**
 * David's final scope checklist — automated evidence (maneger-back).
 * Run: npm run verify:david-checklist
 */
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as XLSX from 'xlsx';
import { parseExperimentBufferToText } from '../lib/labExperimentParse.js';
import {
  assessLabEmailAttachmentImport,
  isLabEmailStrictValidationEnabled
} from '../lib/labEmailImportValidation.js';
import { deleteManagementVectorByFilename } from '../lib/managementRagDelete.js';
import { sendLabImportIncompleteEmail } from '../lib/sendLabImportIncompleteEmail.js';
import { extractProjectIdFromInboundPayload } from '../lib/inboundProjectRouting.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

console.log('David checklist (maneger-back) — automated checks\n');

// §1 Full email→Lab path (parse + validation gate passes → would allow DB+RAG in API)
const wb = XLSX.utils.book_new();
const ws = XLSX.utils.aoa_to_sheet([
  ['experiment_id', 'material', '%'],
  ['EXP-FULL', 'water', '50'],
  ['EXP-FULL', 'clay', '50']
]);
XLSX.utils.book_append_sheet(wb, ws, 'Data');
const xlsxBuf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
const parsedFull = await parseExperimentBufferToText(xlsxBuf, 'full.xlsx');
const fullAss = assessLabEmailAttachmentImport({
  text: parsedFull.text,
  excelSheets: parsedFull.excelSheets,
  filename: 'full.xlsx'
});
assert.equal(fullAss.ok, true, '§1 full formulation should pass lab completeness gate');

// §2 Partial data → pending (no file/RAG in API when strict)
assert.equal(isLabEmailStrictValidationEnabled(), true, 'strict lab import should be on by default');
const partialAss = assessLabEmailAttachmentImport({
  text: 'short note without table',
  excelSheets: [],
  filename: 'nope.txt'
});
assert.equal(partialAss.ok, false);
assert.equal(partialAss.status, 'pending');

// §2 completion email (mock Resend)
const prevFetch = globalThis.fetch;
try {
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ id: 're_1' }) });
  const send = await sendLabImportIncompleteEmail({
    apiKey: 're_key',
    fromEmail: 'from@x.com',
    toEmail: 'to@x.com',
    replyTo: null,
    missing: partialAss.missing,
    filename: 'nope.txt'
  });
  assert.equal(send.sent, true);
} finally {
  globalThis.fetch = prevFetch;
}

// Inbound project resolution (email → system)
const uuid = 'a1b2c3d4-e5f6-4178-a9b0-123456789abc';
assert.equal(extractProjectIdFromInboundPayload({ to: [`${uuid}@x.com`] }, {}), uuid);

// §5 Delete → vector cleanup helper
let delCalls = 0;
await deleteManagementVectorByFilename(
  {
    vectorStore: {
      deleteDocuments: async (_id, m) => {
        delCalls++;
        assert.equal(m.filename, 'gone.pdf');
      }
    }
  },
  'gone.pdf'
);
assert.equal(delCalls, 1);

// Chain existing unit scripts (parsing, corrupt xlsx, etc.)
for (const script of [
  'verify-lab-and-inbound.mjs',
  'verify-management-rag-delete.mjs',
  'verify-send-lab-incomplete-email.mjs'
]) {
  const r = spawnSync(process.execPath, ['scripts/' + script], { cwd: root, encoding: 'utf8' });
  assert.equal(r.status, 0, `${script} failed:\n${r.stderr || r.stdout}`);
}

console.log('\nverify:david-checklist (maneger-back) — OK\n');
